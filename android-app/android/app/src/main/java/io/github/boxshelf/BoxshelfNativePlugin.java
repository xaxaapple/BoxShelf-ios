package io.github.boxshelf;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Boxshelf's Android side: the few things the shared UI can't do from a web page.
 * pickFolder (Storage Access Framework, permission kept across restarts), listFiles (fast recursive listing of a picked
 * folder), apps / activities (which emulators are installed), launch (start an emulator with a game), readText /
 * writeText (settings in the app's private storage), and a "resume" event when the player comes back from a game.
 */
@CapacitorPlugin(name = "BoxshelfNative")
public class BoxshelfNativePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    // box art downloads get their own threads, so a slow server never holds up a folder scan (io) or the page. Six: the
    // page asks for up to four pictures at once (each source has its own limit there) plus a lookup or a name list, and
    // most of a download is waiting on the network. Background priority: they never compete with the shelf's frames
    private final ExecutorService net = Executors.newFixedThreadPool(6, r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-net");
        t.setDaemon(true);
        return t;
    });
    // ...but at most two pictures are decoded and scaled at once (the CPU- and memory-heavy part: a big full wrap can
    // take tens of MB while it is cut), whatever number are downloading
    private final Semaphore decodeGate = new Semaphore(2);
    private static final Set<String> SKIP_DIRS = new HashSet<>(java.util.Arrays.asList("dlc", "update", "updates", "patches", "mods", "sce_sys", "sce_module", "boxshelf art"));

    // ---------- folders ----------
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, i, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) { JSObject r = new JSObject(); r.put("canceled", true); call.resolve(r); return; }
        Uri tree = data.getData();
        // read + write, so the same pick works for an art & manuals folder Boxshelf saves into (read only if write isn't offered)
        ContentResolver cr = getContext().getContentResolver();
        // (beta.10) whether Android kept the permission is said back (persisted): without it the folder reads today but not
        // after a restart, and the page tells the player so instead of the pick quietly "working"
        boolean kept = false; String why = "";
        try { cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); kept = true; }
        catch (SecurityException e) { try { cr.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); kept = true; } catch (SecurityException e2) { why = String.valueOf(e2.getMessage()); } }
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("persisted", kept); if (!kept) r.put("persistError", why);
        // (beta.8) a picker that hands back a plain document link instead of a folder tree (some makers' pickers) threw
        // here and left the folder step waiting forever: it's answered as a cancel instead
        try { r.put("docId", DocumentsContract.getTreeDocumentId(tree)); }
        catch (IllegalArgumentException e) { JSObject c = new JSObject(); c.put("canceled", true); c.put("error", "not a folder"); call.resolve(c); return; }
        call.resolve(r);
    }

    @PluginMethod
    public void folderAccess(PluginCall call) { // the folders Boxshelf can still read (permissions survive reboots, not uninstalls)
        JSArray a = new JSArray();
        for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) if (p.isReadPermission()) a.put(p.getUri().toString());
        JSObject r = new JSObject(); r.put("uris", a); call.resolve(r);
    }

    @PluginMethod
    public void releaseFolder(PluginCall call) { // (beta.10) a folder removed in Settings: its lasting permission given back { uri } → { released }
        String s = call.getString("uri", "");
        boolean done = false;
        if (s != null && !s.isEmpty()) {
            ContentResolver cr = getContext().getContentResolver();
            for (android.content.UriPermission p : cr.getPersistedUriPermissions()) { // (only a grant that's really there: anything else would throw)
                if (!s.equals(p.getUri().toString())) continue;
                int flags = (p.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0) | (p.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
                if (flags == 0) continue;
                try { cr.releasePersistableUriPermission(p.getUri(), flags); done = true; } catch (SecurityException ignored) {}
            }
        }
        JSObject r = new JSObject(); r.put("released", done); call.resolve(r);
    }

    @PluginMethod
    public void openUrl(PluginCall call) { // (beta.10) Settings' "Open site" links: an https address in the device's browser (nothing else is opened)
        String s = call.getString("url", "");
        Uri u = Uri.parse(s == null ? "" : s.trim());
        if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) { call.reject("Only https links can be opened"); return; }
        try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("No browser is installed to open that link"); }
        catch (RuntimeException e) { call.reject("That link couldn't be opened"); }
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        final String treeStr = call.getString("uri");
        final int maxDepth = call.getInt("depth", 4);
        final JSArray extArr = call.getArray("exts", new JSArray());
        if (treeStr == null) { call.reject("No folder given"); return; }
        io.execute(() -> {
            try {
                Set<String> exts = new HashSet<>();
                for (int k = 0; k < extArr.length(); k++) exts.add(extArr.getString(k).toLowerCase(Locale.ROOT));
                Uri tree = Uri.parse(treeStr);
                ContentResolver cr = getContext().getContentResolver();
                String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
                JSArray out = new JSArray();
                ArrayDeque<String[]> todo = new ArrayDeque<>(); // { docId, relative dir, depth }
                todo.add(new String[] { startId(tree), "", "0" }); // the picked folder, or one of its sub folders (…/tree/X/document/Y)
                int dirs = 0;
                while (!todo.isEmpty() && dirs < 5000) {
                    String[] d = todo.poll(); dirs++;
                    int depth = Integer.parseInt(d[2]);
                    Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, d[0]);
                    try (Cursor c = cr.query(kids, cols, null, null, null)) {
                        if (c == null) continue;
                        while (c.moveToNext()) {
                            String id = c.getString(0), name = c.getString(1), mime = c.getString(2);
                            if (name == null || name.startsWith(".")) continue;
                            if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                                if (depth < maxDepth && !SKIP_DIRS.contains(name.toLowerCase(Locale.ROOT)))
                                    todo.add(new String[] { id, d[1].isEmpty() ? name : d[1] + "/" + name, String.valueOf(depth + 1) });
                                continue;
                            }
                            int dot = name.lastIndexOf('.');
                            String ext = dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
                            if (!exts.isEmpty() && !exts.contains(ext)) continue;
                            JSObject f = new JSObject();
                            f.put("name", name); f.put("docId", id); f.put("dir", d[1]); f.put("ext", ext);
                            f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                            f.put("size", c.isNull(3) ? 0 : c.getLong(3)); f.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                            out.put(f);
                        }
                    }
                }
                JSObject r = new JSObject(); r.put("files", out); r.put("dirs", dirs); call.resolve(r);
            } catch (Exception e) { call.reject("Couldn't read that folder: " + e.getMessage()); }
        });
    }

    // A folder inside a picked one is addressed as ".../tree/<picked>/document/<sub folder>": Android's permission for the
    // picked folder covers everything under it, so one pick of the main ROMs folder is enough for every console in it.
    // → the folder to start from: that sub folder's id, or the picked folder itself
    private static String startId(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() >= 4 && "tree".equals(seg.get(0)) && "document".equals(seg.get(2))) return seg.get(3);
        return DocumentsContract.getTreeDocumentId(u);
    }

    @PluginMethod
    public void listDirs(PluginCall call) { // the folders directly inside a picked folder (or a sub folder of it) → { dirs: [{ name, docId, uri }] }
        final String treeStr = call.getString("uri");
        if (treeStr == null) { call.reject("No folder given"); return; }
        io.execute(() -> {
            try {
                Uri tree = Uri.parse(treeStr);
                ContentResolver cr = getContext().getContentResolver();
                String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
                JSArray out = new JSArray();
                try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, startId(tree)), cols, null, null, null)) {
                    while (c != null && c.moveToNext()) {
                        String id = c.getString(0), name = c.getString(1);
                        if (name == null || name.startsWith(".") || !DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) continue;
                        JSObject d = new JSObject(); d.put("name", name); d.put("docId", id);
                        d.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                        out.put(d);
                    }
                }
                JSObject r = new JSObject(); r.put("dirs", out); call.resolve(r);
            } catch (Exception e) { call.reject("Couldn't read that folder: " + e.getMessage()); }
        });
    }

    // ---------- installed apps ----------
    @PluginMethod
    public void apps(PluginCall call) { // every app with a launcher icon: { pkg, label }
        PackageManager pm = getContext().getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> list = pm.queryIntentActivities(main, 0);
        Set<String> seen = new HashSet<>(); JSArray a = new JSArray();
        for (ResolveInfo ri : list) {
            String pkg = ri.activityInfo.packageName;
            if (!seen.add(pkg)) continue;
            JSObject o = new JSObject(); o.put("pkg", pkg); o.put("label", String.valueOf(ri.loadLabel(pm))); a.put(o);
        }
        JSObject r = new JSObject(); r.put("apps", a); call.resolve(r);
    }

    @PluginMethod
    public void activities(PluginCall call) { // an app's activities (exported only), to find its game-start screen
        String pkg = call.getString("pkg");
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(pkg, PackageManager.GET_ACTIVITIES);
            JSArray a = new JSArray();
            if (pi.activities != null) for (ActivityInfo ai : pi.activities) if (ai.exported) a.put(ai.name);
            JSObject r = new JSObject(); r.put("activities", a); r.put("version", pi.versionName); call.resolve(r);
        } catch (PackageManager.NameNotFoundException e) { call.reject("Not installed: " + pkg); }
    }

    @PluginMethod
    public void chooseApp(PluginCall call) { // a plain Android list (d-pad and touch friendly): items [{ pkg, label }] → { pkg } or { canceled }
        JSArray items = call.getArray("items", new JSArray());
        final String[] labels = new String[items.length()], pkgs = new String[items.length()];
        for (int n = 0; n < items.length(); n++) { JSONObject o = items.optJSONObject(n); labels[n] = o == null ? "?" : o.optString("label", o.optString("pkg")); pkgs[n] = o == null ? "" : o.optString("pkg"); }
        getActivity().runOnUiThread(() -> new android.app.AlertDialog.Builder(getActivity())
            .setTitle(call.getString("title", "Choose an app"))
            .setItems(labels, (dlg, which) -> { JSObject r = new JSObject(); r.put("pkg", pkgs[which]); r.put("label", labels[which]); call.resolve(r); })
            .setOnCancelListener(dlg -> { JSObject r = new JSObject(); r.put("canceled", true); call.resolve(r); })
            .show());
    }

    // ---------- launching ----------
    @PluginMethod
    public void launch(PluginCall call) {
        String pkg = call.getString("pkg"), activity = call.getString("activity"), action = call.getString("action"), category = call.getString("category"), data = call.getString("data");
        if (pkg == null) { call.reject("No emulator set"); return; }
        Intent i;
        if (activity != null && !activity.isEmpty()) { i = new Intent(); i.setClassName(pkg, activity); }
        else { i = getContext().getPackageManager().getLaunchIntentForPackage(pkg); if (i == null) { call.reject("That app can't be opened"); return; } }
        if (action != null && !action.isEmpty()) i.setAction(action);
        if (category != null && !category.isEmpty()) i.addCategory(category);
        if (data != null && !data.isEmpty()) i.setData(Uri.parse(data));
        JSObject extras = call.getObject("extras", new JSObject());
        try {
            for (Iterator<String> it = extras.keys(); it.hasNext(); ) {
                String k = it.next(); Object v = extras.get(k);
                if (v instanceof Boolean) i.putExtra(k, (Boolean) v);
                else if (v instanceof Integer) i.putExtra(k, (Integer) v);
                else if (v instanceof JSONArray) { JSONArray ja = (JSONArray) v; String[] s = new String[ja.length()]; for (int n = 0; n < s.length; n++) s[n] = ja.getString(n); i.putExtra(k, s); }
                else i.putExtra(k, String.valueOf(v));
            }
        } catch (JSONException e) { call.reject("Bad launch settings: " + e.getMessage()); return; }
        // read access for every content:// the emulator is handed (data or extras), through ClipData so the intent's own
        // data stays exactly what the emulator expects
        JSArray grants = call.getArray("grant", new JSArray());
        try {
            ClipData clip = null;
            for (int n = 0; n < grants.length(); n++) {
                Uri u = Uri.parse(grants.getString(n));
                if (clip == null) clip = ClipData.newRawUri("game", u); else clip.addItem(new ClipData.Item(u));
            }
            if (clip != null) { i.setClipData(clip); i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        } catch (JSONException ignored) {}
        JSArray flags = call.getArray("flags", new JSArray());
        for (int n = 0; n < flags.length(); n++) {
            String f = flags.optString(n);
            if ("clearTask".equals(f)) i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
            if ("clearTop".equals(f)) i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) { call.reject("The emulator didn't accept the game (" + (activity != null ? activity : pkg) + ")");
        } catch (SecurityException e) { call.reject("Android blocked opening the emulator: " + e.getMessage()); }
    }

    // ---------- the Home screen (Boxshelf as the Thor's launcher, and the way back out) ----------
    private Intent homeIntent() { return new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME); }

    @PluginMethod
    public void homeStatus(PluginCall call) { // { isDefault, current: { pkg, label }, launchers: [{ pkg, label }] }
        PackageManager pm = getContext().getPackageManager();
        String me = getContext().getPackageName();
        JSObject r = new JSObject();
        ResolveInfo def = pm.resolveActivity(homeIntent(), PackageManager.MATCH_DEFAULT_ONLY);
        // with no default chosen Android answers with its own "choose an app" screen (package "android"): no current launcher
        String cur = def != null && def.activityInfo != null && !"android".equals(def.activityInfo.packageName) ? def.activityInfo.packageName : null;
        r.put("isDefault", me.equals(cur));
        if (cur != null) { JSObject c = new JSObject(); c.put("pkg", cur); c.put("label", String.valueOf(def.loadLabel(pm))); r.put("current", c); }
        JSArray list = new JSArray(); Set<String> seen = new HashSet<>();
        for (ResolveInfo ri : pm.queryIntentActivities(homeIntent(), 0)) {
            String p = ri.activityInfo.packageName;
            if (p.equals(me) || !seen.add(p)) continue;
            JSObject o = new JSObject(); o.put("pkg", p); o.put("label", String.valueOf(ri.loadLabel(pm))); list.put(o);
        }
        r.put("launchers", list);
        call.resolve(r);
    }

    @PluginMethod
    public void openHomeSettings(PluginCall call) { // Android's own "Home app" chooser (apps may not make themselves the default)
        String[] actions = { android.provider.Settings.ACTION_HOME_SETTINGS, android.provider.Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, android.provider.Settings.ACTION_SETTINGS };
        for (String a : actions) {
            try { getActivity().startActivity(new Intent(a).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); return; }
            catch (ActivityNotFoundException ignored) {}
        }
        call.reject("This device has no Home app setting");
    }

    @PluginMethod
    public void openAndroidSettings(PluginCall call) {
        try { getActivity().startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("Settings couldn't be opened"); }
    }

    @PluginMethod
    public void launchHome(PluginCall call) { // open another launcher (Cocoon, the stock one…) by package
        String pkg = call.getString("pkg");
        Intent i = homeIntent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        if (pkg != null) i.setPackage(pkg);
        try { getActivity().startActivity(i); call.resolve(); }
        catch (ActivityNotFoundException e) { call.reject("That launcher isn't installed any more"); }
    }

    @PluginMethod
    public void closeApp(PluginCall call) { call.resolve(); getActivity().runOnUiThread(() -> getActivity().finishAndRemoveTask()); }

    // the Home key while Boxshelf is the Home app (or a launcher shortcut) arrives here as a new intent
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && intent.hasCategory(Intent.CATEGORY_HOME)) notifyListeners("home", new JSObject());
    }

    // ---------- magazines & guides (0.3.2): the Internet Archive store's downloads and the reading corner (ReadingStore) ----------
    // (beta.10) made in load() (the plugin's own thread, before any call): no lock needed, so a reading call never waits
    // behind anything else that locks the plugin
    private volatile ReadingStore readingStore;

    private ReadingStore reading() {
        ReadingStore s = readingStore;
        if (s == null) { synchronized (readingLock) { if (readingStore == null) readingStore = new ReadingStore(getContext(), userAgent(), (e, o) -> notifyListeners(e, o)); s = readingStore; } }
        return s;
    }
    private final Object readingLock = new Object(); // (only if load() couldn't make it: a short lock of its own)

    @PluginMethod
    public void readingDownload(PluginCall call) { reading().download(call); } // progress: "readingProgress" events { id, bytes, total, conns }

    @PluginMethod
    public void readingCancel(PluginCall call) { reading().cancel(call); }

    @PluginMethod
    public void readingLocal(PluginCall call) { reading().local(call); }

    @PluginMethod
    public void readingCover(PluginCall call) { reading().cover(call); }

    @PluginMethod
    public void readingZip(PluginCall call) { reading().zip(call); }

    // ---------- box art (downloaded here, never by the page: no CORS, never on the UI thread) ----------
    // The original picture is saved in a "Boxshelf Art" folder inside the games folder the player picked (so it stays with
    // the games, like the covers folder on Windows); if Android only gave read access there, in the app's own storage.
    // A display-size copy (about 512 px tall) always goes to the app's own storage: that's what the shelf shows, so a
    // 3000 px scan never has to be decoded while the cases slide.
    private static final String ART_DIR = "Boxshelf Art";
    // game manuals (0.3.0): page pictures in a "Boxshelf Manuals" folder beside the games (read: also the PC's "covers" and
    // "manuals" folders copied over with the games)
    private static final String MANUAL_DIR = "Boxshelf Manuals";
    private static String folderFor(String f) { return "covers".equals(f) ? "covers" : "manuals".equals(f) ? MANUAL_DIR : "pcmanuals".equals(f) ? "manuals" : ART_DIR; }
    private static final Pattern PNG_HREF = Pattern.compile("href=\"([^\"]+?\\.png)\"", Pattern.CASE_INSENSITIVE);
    private final Object artDirLock = new Object(); // two downloads must not both create "Boxshelf Art" (Android would make "Boxshelf Art (1)")
    private final java.util.Map<String, String> artDirs = new java.util.HashMap<>(); // tree|sub → folder id (only touched under artDirLock)
    private String ua = null;

    private String userAgent() { // one descriptive User-Agent, as the Windows build sends (GameTDB and the others like to know who's calling)
        if (ua != null) return ua;
        String v = "0";
        try { v = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName; } catch (Exception ignored) {}
        ua = "Boxshelf/" + v + " (Android)";
        return ua;
    }

    private static final class Got { int status; byte[] body; String type; }

    // GET with timeouts, following redirects by hand (HttpURLConnection won't follow http <-> https on its own)
    private Got httpGet(String url, JSObject headers, int maxBytes) throws IOException {
        String u = url;
        final String host0 = new URL(url).getHost();
        for (int hop = 0; hop < 6; hop++) {
            // (beta.10) the caller's headers (a SteamGridDB key, say) go only to the host they were meant for, and an
            // https request never follows a redirect down to plain http
            if (hop > 0) { URL nu = new URL(u); if (!nu.getHost().equalsIgnoreCase(host0)) headers = null; if ("http".equals(nu.getProtocol()) && url.startsWith("https:")) throw new IOException("Refused a redirect from https to http"); }
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            boolean reuse = false; // answered and read to the end: the connection stays open for the next request (keep-alive)
            try {
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", userAgent());
                if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); }
                int code = c.getResponseCode();
                if (code >= 300 && code < 400 && code != 304) {
                    String loc = c.getHeaderField("Location");
                    reuse = drain(c);
                    if (loc == null) { Got g = new Got(); g.status = code; return g; }
                    u = new URL(new URL(u), loc).toString();
                    continue;
                }
                Got g = new Got(); g.status = code; g.type = c.getContentType();
                if (code >= 200 && code < 300) {
                    if (c.getContentLengthLong() > maxBytes) throw new TooBig(); // (beta.10) said up front: not downloaded at all (API 24)
                    try (InputStream in = new BufferedInputStream(c.getInputStream())) { g.body = readAll(in, maxBytes); }
                    reuse = true;
                } else reuse = drain(c); // a 404 (GameTDB's region guesses, mostly) is read out too, so it doesn't cost a new connection
                return g;
            } finally { if (!reuse) c.disconnect(); } // (a failed or half-read answer: its connection is closed, never reused)
        }
        throw new IOException("Too many redirects");
    }

    // the rest of a small answer (an error page, a redirect) read and closed → true when it was read to the end, so its
    // connection goes back to the pool and the next request to that server skips a new TLS handshake. A big one is dropped
    private static boolean drain(HttpURLConnection c) {
        InputStream in;
        try { in = c.getErrorStream(); if (in == null) in = c.getInputStream(); } catch (Exception e) { return false; }
        if (in == null) return true; // no body at all
        try {
            byte[] buf = new byte[8192]; int total = 0, n;
            while ((n = in.read(buf)) > 0) { total += n; if (total > 256 * 1024) return false; }
            return true;
        } catch (IOException e) { return false; }
        finally { try { in.close(); } catch (IOException ignored) {} }
    }

    // (beta.10) a file over the size limit: not "busy" (tried again every start, the whole 80 MB each time) but there and
    // too big, which the callers answer as missing (toobig)
    static final class TooBig extends IOException { TooBig() { super("File too large"); } }

    private static byte[] readAll(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384]; int n;
        while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > maxBytes) throw new TooBig(); }
        return bo.toByteArray();
    }

    private static String safeName(String s) {
        String t = String.valueOf(s).replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (t.length() > 150) t = t.substring(0, 150);
        return t.isEmpty() ? "_" : t;
    }

    @PluginMethod
    public void artIndex(PluginCall call) { // a libretro thumbnails folder page → { status, names: [file names without .png] }
        final String url = call.getString("url");
        if (url == null) { call.reject("No address"); return; }
        net.execute(() -> {
            try {
                Got g = httpGet(url, null, 32 * 1024 * 1024);
                JSArray names = new JSArray();
                if (g.body != null) {
                    Matcher m = PNG_HREF.matcher(new String(g.body, StandardCharsets.UTF_8));
                    while (m.find()) {
                        try { String h = m.group(1).replace("&amp;", "&").replace("&#39;", "'").replace("&#039;", "'").replace("&apos;", "'").replace("&quot;", "\"");
                            String n = URLDecoder.decode(h.replace("+", "%2B"), "UTF-8"); names.put(n.substring(0, n.length() - 4)); }
                        catch (Exception ignored) {} // one odd link: skip it
                    }
                }
                JSObject r = new JSObject(); r.put("status", g.status); r.put("names", names); call.resolve(r);
            } catch (Exception e) { call.reject("Offline or blocked: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void httpText(PluginCall call) { // a small text / JSON answer (SteamGridDB's search, ScreenScraper's lookups with ss) → { status, text }
        final String url = call.getString("url");
        final JSObject headers = call.getObject("headers", new JSObject());
        final boolean ss = call.getBoolean("ss", false), igdb = call.getBoolean("igdb", false), ra = call.getBoolean("ra", false);
        final String body = call.getString("body", null); // (0.3.1) a POST (IGDB's queries)
        if (url == null) { call.reject("No address"); return; }
        net.execute(() -> {
            try {
                Got g;
                if (ra) { // (0.3.5) RetroAchievements: the username + web API key are added here, from the saved settings
                    String signed = raSign(url);
                    if (signed == null) { JSObject r = new JSObject(); r.put("status", 401); r.put("text", ""); call.resolve(r); return; }
                    g = httpGet(signed, headers, 8 * 1024 * 1024);
                } else if (igdb) { // IGDB: the Twitch sign-in is added here, from the saved settings (the page never sees the secret)
                    String[] k = igdbKeys();
                    if (k == null) { JSObject r = new JSObject(); r.put("status", 401); r.put("text", ""); call.resolve(r); return; }
                    g = null;
                    for (int attempt = 0; attempt < 2; attempt++) {
                        String tok = igdbToken(k, attempt > 0);
                        if (tok == null) { JSObject r = new JSObject(); r.put("status", 401); r.put("text", ""); call.resolve(r); return; }
                        JSObject h = new JSObject(); h.put("Client-ID", k[0]); h.put("Authorization", "Bearer " + tok); h.put("Accept", "application/json");
                        g = httpPost(url, h, body == null ? "" : body, "text/plain", 4 * 1024 * 1024);
                        if (g.status != 401) break; // a refused token (revoked, expired early): a fresh one, once
                    }
                } else if (body != null) g = httpPost(url, headers, body, "text/plain", 4 * 1024 * 1024);
                else g = httpGet(ss ? ssSign(url) : url, headers, 4 * 1024 * 1024);
                JSObject r = new JSObject(); r.put("status", g.status); r.put("text", g.body == null ? "" : new String(g.body, StandardCharsets.UTF_8)); call.resolve(r);
            } catch (Exception e) { call.reject(ss || igdb || ra ? "Offline or blocked" : "Offline or blocked: " + e.getMessage()); } // (an error can echo the address)
        });
    }

    // (0.3.5) a RetroAchievements Web API address with the saved account added (z = username, y = web API key), or null
    // when it isn't set up (the page honours "Show achievements" itself, so Test still works with it off). Only ever for
    // retroachievements.org's API: the key goes nowhere else, and the page never builds, logs or keeps an address with it
    private String raSign(String url) {
        if (url == null || !url.startsWith("https://retroachievements.org/API/")) return null;
        try {
            File f = fileFor("config.json");
            if (!f.isFile()) return null;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject ra = new JSONObject(text).optJSONObject("ra");
            if (ra == null) return null;
            String user = ra.optString("user", "").trim(), key = ra.optString("key", "").trim();
            if (user.isEmpty() || key.isEmpty()) return null;
            return url + (url.indexOf('?') >= 0 ? "&" : "?") + "z=" + java.net.URLEncoder.encode(user, "UTF-8") + "&y=" + java.net.URLEncoder.encode(key, "UTF-8");
        } catch (Exception e) { return null; }
    }

    // (0.3.5) RetroAchievements' own hash of a few games (RaHash.java: cartridge consoles, arcade names), read on a
    // low-priority thread of its own so a folder scan or a download never waits on it, and the file never crosses the
    // bridge. { items: [{ uri, kind, name, exts }] } → { hashes: [32 hex characters, or "" when it couldn't be made] }
    private final ExecutorService hashPool = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-rahash");
        t.setDaemon(true);
        return t;
    });

    @PluginMethod
    public void raHash(PluginCall call) {
        final JSArray items = call.getArray("items", new JSArray());
        hashPool.execute(() -> {
            JSArray out = new JSArray();
            try {
                ContentResolver cr = getContext().getContentResolver();
                int count = items == null ? 0 : items.length();
                for (int i = 0; i < count; i++) {
                    String h = null;
                    try {
                        JSONObject it = items.getJSONObject(i);
                        h = RaHash.of(cr, it.optString("uri", ""), it.optString("kind", ""), it.optString("name", ""), it.optJSONArray("exts"));
                    } catch (Exception | OutOfMemoryError e) { h = null; } // unreadable, gone, not that kind of file: no hash (titles still match)
                    out.put(h == null ? "" : h);
                }
            } catch (Throwable t) { /* answer with what was made */ }
            JSObject r = new JSObject(); r.put("hashes", out); call.resolve(r);
        });
    }

    // a POST with a small body (no redirects: the APIs that take one answer directly)
    private Got httpPost(String url, JSObject headers, String body, String type, int maxBytes) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        try {
            c.setConnectTimeout(15000); c.setReadTimeout(30000);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("User-Agent", userAgent()); c.setRequestProperty("Content-Type", type);
            if (headers != null) for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); c.setRequestProperty(k, headers.optString(k)); }
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(b.length);
            try (OutputStream out = c.getOutputStream()) { out.write(b); }
            Got g = new Got(); g.status = c.getResponseCode(); g.type = c.getContentType();
            if (g.status >= 200 && g.status < 300) { try (InputStream in = new BufferedInputStream(c.getInputStream())) { g.body = readAll(in, maxBytes); } }
            else drain(c);
            return g;
        } finally { c.disconnect(); }
    }

    // IGDB (0.3.1): { client id, secret } from the saved settings (Settings → Accounts & services), or null when not set up
    private String[] igdbKeys() {
        try {
            File f = fileFor("config.json");
            if (!f.isFile()) return null;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject keys = new JSONObject(text).optJSONObject("keys");
            if (keys == null) return null;
            String id = keys.optString("igdbId", "").trim(), secret = keys.optString("igdbSecret", "").trim();
            return id.isEmpty() || secret.isEmpty() ? null : new String[] { id, secret };
        } catch (Exception e) { return null; }
    }

    private String igdbTok = null, igdbTokFor = null; private long igdbTokUntil = 0;
    // (beta.10) the token's own lock: it's held across the sign-in request, which must never block the plugin's thread
    // (reading(), lbIndex and the rest lock the plugin itself; a slow Twitch answer used to hold them all up)
    private final Object tokenLock = new Object();
    // a Twitch app token for IGDB (client credentials; it lasts about two months), kept in memory for this run
    private String igdbToken(String[] k, boolean fresh) {
        synchronized (tokenLock) {
            if (!fresh && igdbTok != null && k[0].equals(igdbTokFor) && System.currentTimeMillis() < igdbTokUntil) return igdbTok;
            try {
                String form = "client_id=" + java.net.URLEncoder.encode(k[0], "UTF-8") + "&client_secret=" + java.net.URLEncoder.encode(k[1], "UTF-8") + "&grant_type=client_credentials";
                Got g = httpPost("https://id.twitch.tv/oauth2/token", null, form, "application/x-www-form-urlencoded", 64 * 1024);
                if (g.status != 200 || g.body == null) { igdbTok = null; return null; }
                JSONObject j = new JSONObject(new String(g.body, StandardCharsets.UTF_8));
                igdbTok = j.optString("access_token", null); igdbTokFor = k[0];
                igdbTokUntil = System.currentTimeMillis() + Math.max(60, j.optLong("expires_in", 3600) - 300) * 1000L;
                return igdbTok;
            } catch (Exception e) { return null; }
        }
    }

    // ScreenScraper's sign-in, added to one of its addresses at the moment of the request, from the saved settings: the page
    // never builds, logs or keeps an address with the password in it (or passes one through the bridge, which logs calls in
    // debug builds). Not a ScreenScraper https address: left as it is
    // (beta.10) Boxshelf's own ScreenScraper developer login, when this build has one: assets/ss-dev.json { "devId", "devPass" }
    // (outside the web page's folder, so the page can't read it; never in git, the .gitignore lists it). Read once; null: none
    private String[] ssOwn = null; private boolean ssOwnRead = false;
    private synchronized String[] readSsOwnDev() {
        if (ssOwnRead) return ssOwn; ssOwnRead = true;
        try (InputStream in = getContext().getAssets().open("ss-dev.json")) {
            JSONObject j = new JSONObject(new String(readAll(in, 64 * 1024), StandardCharsets.UTF_8));
            String id = j.optString("devId", "").trim(), pw = j.optString("devPass", "");
            if (!id.isEmpty() && !pw.isEmpty()) ssOwn = new String[] { id, pw };
        } catch (Exception e) { ssOwn = null; }
        return ssOwn;
    }
    // whether this build has its own developer login (yes / no only, never the values), for Settings' wording
    @PluginMethod
    public void ssOwnDev(PluginCall call) { JSObject r = new JSObject(); r.put("has", readSsOwnDev() != null); call.resolve(r); }

    private String ssSign(String url) {
        try {
            URL u = new URL(url);
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.ROOT);
            if (!"https".equals(u.getProtocol()) || !(host.equals("screenscraper.fr") || host.endsWith(".screenscraper.fr"))) return url;
            File f = fileFor("config.json");
            if (!f.isFile()) return url;
            String text;
            try (InputStream in = new FileInputStream(f)) { text = new String(readAll(in, 4 * 1024 * 1024), StandardCharsets.UTF_8); }
            JSONObject keys = new JSONObject(text).optJSONObject("keys");
            if (keys == null) return url;
            String user = keys.optString("ssUser", "").trim(), pass = keys.optString("ssPass", ""), devId = keys.optString("ssDevId", "").trim(), devPass = keys.optString("ssDevPass", "");
            if (devId.isEmpty()) { String[] own = readSsOwnDev(); if (own != null) { devId = own[0]; devPass = own[1]; } } // (beta.10) Boxshelf's own, when this build has one
            StringBuilder b = new StringBuilder(url);
            char sep = url.indexOf('?') >= 0 ? '&' : '?';
            String[][] add = { { "softname", "Boxshelf" }, { "ssid", user }, { "sspassword", pass }, { "devid", devId }, { "devpassword", devId.isEmpty() ? "" : devPass } };
            for (String[] kv : add) {
                if (kv[1].isEmpty()) continue;
                b.append(sep).append(kv[0]).append('=').append(java.net.URLEncoder.encode(kv[1], "UTF-8"));
                sep = '&';
            }
            return b.toString();
        } catch (Exception e) { return url; }
    }

    @PluginMethod
    public void discId(PluginCall call) { // GameCube / Wii disc id from the image header (GameTDB names its art by it) → { id } or {}
        final String uri = call.getString("uri");
        if (uri == null) { call.reject("No file"); return; }
        net.execute(() -> {
            JSObject r = new JSObject();
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                byte[] h = new byte[0x8010]; int off = 0, n;
                while (in != null && off < h.length && (n = in.read(h, off, h.length - off)) > 0) off += n;
                String magic = latin1(h, off, 0, 4);
                // plain images keep the id at 0; RVZ / WIA keep a copy of the header at 0x58, CISO the disc from 0x8000, WBFS from 0x200
                int at = ("RVZ\u0001".equals(magic) || "WIA\u0001".equals(magic)) ? 0x58 : "CISO".equals(magic) ? 0x8000 : "WBFS".equals(magic) ? 0x200 : 0;
                String id = latin1(h, off, at, 6);
                if (id.matches("[A-Z][A-Z0-9]{5}")) r.put("id", id);
            } catch (Exception ignored) {} // unreadable or compressed (GCZ): no id, the other sources still try
            call.resolve(r);
        });
    }

    private static String latin1(byte[] b, int len, int at, int n) { return at + n <= len ? new String(b, at, n, StandardCharsets.ISO_8859_1) : ""; }

    // the child of parentId called name (a folder when dir), or null
    private String findChild(ContentResolver cr, Uri tree, String parentId, String name, boolean dir) {
        String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
        try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId), cols, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                String n = c.getString(1);
                if (n != null && n.equalsIgnoreCase(name) && dir == DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) return c.getString(0);
            }
        } catch (Exception ignored) {}
        return null;
    }

    // "Boxshelf Art" (and its sub folder, when one is asked for) in the picked games folder; created when make is true
    private String artDirId(ContentResolver cr, Uri tree, String sub, boolean make) throws IOException { return artDirId(cr, tree, ART_DIR, sub, make); }

    // folder: "Boxshelf Art", or (read only) the Windows build's "covers" folder beside the games
    private String artDirId(ContentResolver cr, Uri tree, String folder, String sub, boolean make) throws IOException {
        synchronized (artDirLock) {
            String cacheKey = tree + "|" + (sub == null ? "" : sub) + (ART_DIR.equals(folder) ? "" : "|" + folder), known = artDirs.get(cacheKey);
            if (known != null) return known;
            String id = startId(tree); // "Boxshelf Art" goes inside the console's own folder, also when that's a sub folder of the pick
            String[] path = (sub == null || sub.isEmpty()) ? new String[] { folder } : new String[] { folder, safeName(sub) };
            for (String part : path) {
                String kid = findChild(cr, tree, id, part, true);
                if (kid == null) {
                    if (!make) return null;
                    Uri made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, id), DocumentsContract.Document.MIME_TYPE_DIR, part);
                    if (made == null) throw new IOException("Couldn't make the " + part + " folder");
                    kid = DocumentsContract.getDocumentId(made);
                }
                id = kid;
            }
            artDirs.put(cacheKey, id);
            return id;
        }
    }
    private void forgetArtDir(Uri tree, String sub) { forgetArtDir(tree, ART_DIR, sub); }
    private void forgetArtDir(Uri tree, String folder, String sub) { synchronized (artDirLock) { artDirs.remove(tree + "|" + (sub == null ? "" : sub) + (ART_DIR.equals(folder) ? "" : "|" + folder)); } }

    @PluginMethod
    public void artList(PluginCall call) { // the pictures already in a games folder's "Boxshelf Art" → { exists, files: [{ name, uri }] }
        // (folder: "covers" lists the Windows build's art folder instead, so art scraped on the PC and copied over is used)
        final String treeStr = call.getString("tree"), sub = call.getString("sub", ""), folder = folderFor(call.getString("folder", ""));
        if (treeStr == null || treeStr.isEmpty()) { call.reject("No folder given"); return; }
        io.execute(() -> {
            JSObject r = new JSObject(); JSArray files = new JSArray();
            try {
                Uri tree = Uri.parse(treeStr); ContentResolver cr = getContext().getContentResolver();
                String dir = artDirId(cr, tree, folder, sub, false);
                r.put("exists", dir != null);
                if (dir != null) {
                    String[] cols = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
                    try (Cursor c = cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, dir), cols, null, null, null)) {
                        while (c != null && c.moveToNext()) {
                            String n = c.getString(1);
                            if (n == null || DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2))) continue;
                            JSObject f = new JSObject(); f.put("name", n); f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)).toString()); files.put(f);
                        }
                    }
                }
            } catch (Exception e) { r.put("exists", false); r.put("error", String.valueOf(e.getMessage())); }
            r.put("files", files); call.resolve(r);
        });
    }

    // a picture's bytes decoded at a fraction of their size (inSampleSize): about maxH tall (and minW wide), or a bit more
    private static Bitmap decodeAbout(byte[] body, int maxH, int minW) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(body, 0, body.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) throw new IOException("Not a picture");
        int sample = 1; while (o.outHeight / (sample * 2) >= maxH && o.outWidth / (sample * 2) >= minW) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options(); d.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(body, 0, body.length, d);
        if (bmp == null) throw new IOException("Not a picture");
        return bmp;
    }

    // the same, but no side over maxSide (a huge scan or a camera photo is halved until it fits: memory stays small)
    private static Bitmap decodeAtMost(byte[] body, int maxSide) throws IOException {
        BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(body, 0, body.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) throw new IOException("Not a picture");
        int sample = 1; while (o.outHeight / sample > maxSide || o.outWidth / sample > maxSide) sample *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options(); d.inSampleSize = sample;
        Bitmap bmp = BitmapFactory.decodeByteArray(body, 0, body.length, d);
        if (bmp == null) throw new IOException("Not a picture");
        return bmp;
    }

    // the display copy: about maxH tall, JPEG (PNG when it has see-through parts, like a disc) in files/art/<key>/ → its
    // absolute path
    private String writeDisplay(byte[] body, String key, String name, int maxH) throws IOException {
        decodeGate.acquireUninterruptibly();
        try { return writeBitmap(decodeAbout(body, maxH, 64), new File(getContext().getFilesDir(), "art/" + safeName(key)), name, maxH); }
        finally { decodeGate.release(); }
    }

    // bmp scaled to maxH tall and saved in dir as <name>.jpg / .png → its absolute path. bmp is always recycled
    private static String writeBitmap(Bitmap bmp, File dir, String name, int maxH) throws IOException {
        try {
            if (bmp.getHeight() > maxH) {
                int w = Math.max(1, Math.round(bmp.getWidth() * (float) maxH / bmp.getHeight()));
                Bitmap scaled = Bitmap.createScaledBitmap(bmp, w, maxH, true);
                if (scaled != bmp) { bmp.recycle(); bmp = scaled; }
            }
            boolean alpha = bmp.hasAlpha() && seeThrough(bmp);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Couldn't make " + dir);
            File out = new File(dir, safeName(name) + (alpha ? ".png" : ".jpg")), tmp = new File(out.getPath() + ".tmp");
            try (FileOutputStream fo = new FileOutputStream(tmp)) {
                if (!bmp.compress(alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 85, fo)) throw new IOException("Couldn't encode the picture");
            }
            // the other format from an earlier fetch of the same picture would just be left over
            File other = new File(dir, safeName(name) + (alpha ? ".jpg" : ".png")); if (other.exists()) other.delete();
            if (!tmp.renameTo(out)) { out.delete(); if (!tmp.renameTo(out)) throw new IOException("Couldn't save " + out.getName()); }
            return out.getAbsolutePath();
        } finally { bmp.recycle(); }
    }

    // ---------- full box wraps (back | spine | front, as GameTDB's "coverfull" and ScreenScraper's "box-texture") ----------
    // Where the faces are: the front is as wide as the case's shape says (height × ratio, the console's STYLE.ratio) and the
    // spine is what's left between the two faces. A scan with margins or bleed can make that guess silly; then the console's
    // case depth decides (STYLE.depth: spine width ÷ face width). → { faceWidth, spineWidth }, or null: not a wrap at all
    static int[] wrapCuts(int w, int h, double ratio, double depth) {
        if (w <= 0 || h <= 0) return null;
        double r = ratio > 0.3 && ratio < 2 ? ratio : 0.71;
        if (w < h * Math.min(r, 0.95) * 1.7) return null; // narrower than two faces side by side: a single picture, not a wrap
        int face = (int) Math.round(h * r), spine = w - 2 * face;
        if (spine < Math.max(2, face * 0.03) || spine > face * 0.4) {
            double d = depth > 0.01 && depth < 0.5 ? depth : 0.1;
            face = (int) Math.round(w / (2 + d)); spine = w - 2 * face;
        }
        if (spine < 1 || face < 8) return null;
        return new int[] { face, spine };
    }

    // one face of a wrap ("back" | "spine" | "front") as a new bitmap; src is left as it is
    static Bitmap cutFace(Bitmap src, String part, double ratio, double depth) throws IOException {
        int W = src.getWidth(), H = src.getHeight();
        int[] c = wrapCuts(W, H, ratio, depth);
        if (c == null) throw new IOException("Not a full box wrap");
        int x = "back".equals(part) ? 0 : "spine".equals(part) ? c[0] : c[0] + c[1];
        int w = "spine".equals(part) ? c[1] : Math.min(c[0], W - x);
        if (x < 0 || w < 1 || x + w > W) throw new IOException("Not a full box wrap");
        Bitmap face = Bitmap.createBitmap(src, x, 0, w, H);
        if (face == null || face == src) throw new IOException("Couldn't cut the wrap"); // (never the whole picture: x / w say so)
        return face;
    }

    // a wrap → display copies of the faces asked for (want: front / back / spine; none given = all three), named dname,
    // dname-back and dname-spine → { front, back, spine } (absolute paths)
    private JSObject writeParts(byte[] body, String key, String dname, int maxH, double ratio, double depth, JSArray want) throws IOException {
        decodeGate.acquireUninterruptibly();
        try { return cutParts(body, key, dname, maxH, ratio, depth, want); }
        finally { decodeGate.release(); }
    }
    private JSObject cutParts(byte[] body, String key, String dname, int maxH, double ratio, double depth, JSArray want) throws IOException {
        Bitmap src = decodeAbout(body, maxH, 64);
        try {
            if (wrapCuts(src.getWidth(), src.getHeight(), ratio, depth) == null) throw new IOException("Not a full box wrap");
            File dir = new File(getContext().getFilesDir(), "art/" + safeName(key));
            JSObject out = new JSObject();
            for (String p : new String[] { "front", "back", "spine" }) {
                if (!wanted(want, p)) continue;
                out.put(p, writeBitmap(cutFace(src, p, ratio, depth), dir, "front".equals(p) ? dname : dname + "-" + p, maxH));
            }
            return out;
        } finally { src.recycle(); }
    }

    private static boolean wanted(JSArray want, String p) {
        if (want == null || want.length() == 0) return true;
        for (int i = 0; i < want.length(); i++) if (p.equals(want.optString(i, ""))) return true;
        return false;
    }

    // see-through anywhere along the edges or corners (a disc, a cut-out box)? Many scans carry an alpha channel they never use
    private static boolean seeThrough(Bitmap b) {
        int w = b.getWidth(), h = b.getHeight();
        int[][] at = { {0, 0}, {w - 1, 0}, {0, h - 1}, {w - 1, h - 1}, {w / 2, 0}, {w / 2, h - 1}, {0, h / 2}, {w - 1, h / 2}, {w / 8, h / 8}, {w - 1 - w / 8, h - 1 - h / 8} };
        for (int[] p : at) if (((b.getPixel(p[0], p[1]) >>> 24) & 0xff) < 250) return true;
        return false;
    }

    private static String extFor(String type, String url) {
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if (t.contains("png")) return "png";
        if (t.contains("jpeg") || t.contains("jpg")) return "jpg";
        if (t.contains("webp")) return "webp";
        String u = url.toLowerCase(Locale.ROOT).replaceAll("[?#].*$", "");
        if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "jpg";
        if (u.endsWith(".webp")) return "webp";
        return "png";
    }

    // the original into "Boxshelf Art" in the games folder → its content:// address, or null when that folder can't be
    // written (read-only permission, a removed SD card…)
    private String saveToTree(String treeStr, String sub, String file, String ext, byte[] body) { return saveToTree(treeStr, ART_DIR, sub, file, ext, body); }

    // the same into another of Boxshelf's folders beside the games ("Boxshelf Manuals")
    private String saveToTree(String treeStr, String folder, String sub, String file, String ext, byte[] body) {
        if (treeStr == null || treeStr.isEmpty()) return null;
        Uri doc = null; ContentResolver cr = getContext().getContentResolver();
        boolean made = false; Uri tree = null;
        try {
            tree = Uri.parse(treeStr);
            String mime = "jpg".equals(ext) ? "image/jpeg" : "image/" + ext;
            for (int attempt = 0; attempt < 2 && doc == null; attempt++) {
                String dir = artDirId(cr, tree, folder, sub, true);
                String have = findChild(cr, tree, dir, file, false);
                if (have != null) { doc = DocumentsContract.buildDocumentUriUsingTree(tree, have); break; }
                try { doc = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, dir), mime, file); }
                catch (Exception e) { doc = null; }
                if (doc == null) forgetArtDir(tree, folder, sub); // the folder may have been deleted since it was found: look again
                else made = true;
            }
            if (doc == null) return null;
            try (OutputStream out = cr.openOutputStream(doc, "wt")) { // "wt": an old, longer picture must not leave its tail behind
                if (out == null) throw new IOException("No output");
                out.write(body);
            }
            return doc.toString();
        } catch (Exception e) {
            if (doc != null && made) try { DocumentsContract.deleteDocument(cr, doc); } catch (Exception ignored) {} // no half-written picture left behind
            if (tree != null) forgetArtDir(tree, folder, sub);
            return null;
        }
    }

    @PluginMethod
    public void fetchFile(PluginCall call) {
        // a manual page saved as it comes (no display copy): { tree, sub, folder: "manuals", name (no extension), url, key }
        // → { ok, name, file } / { ok: false, missing } (not there) / { ok: false, busy } (offline, or the server said slow down).
        // No tree (art kept inside Boxshelf), or a folder Android only lets us read: the app's own storage instead.
        final String treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), url = call.getString("url", ""), name = safeName(call.getString("name", "file")), key = call.getString("key", "file");
        final String folder = "manuals".equals(call.getString("folder", "")) ? MANUAL_DIR : ART_DIR;
        // pdf (0.3.1): a whole PDF manual, kept in the app's cache only (the page turns it into pictures, saved with saveBytes)
        final boolean pdf = call.getBoolean("pdf", false);
        if (url.isEmpty()) { call.reject("No address given"); return; }
        net.execute(() -> {
            JSObject r = new JSObject();
            Got g;
            try { g = httpGet(url, null, (pdf ? 80 : 40) * 1024 * 1024); }
            catch (TooBig e) { r.put("ok", false); r.put("missing", true); r.put("toobig", true); call.resolve(r); return; } // (beta.10) never fetched again for nothing
            catch (Throwable e) { r.put("ok", false); r.put("busy", true); call.resolve(r); return; }
            try {
                if (g.status == 404 || g.status == 410) { r.put("ok", false); r.put("missing", true); call.resolve(r); return; }
                if (g.body == null) { r.put("ok", false); r.put("busy", true); r.put("status", g.status); call.resolve(r); return; } // 5xx / 429 / 403: try later
                if (g.body.length < 2048) { r.put("ok", false); r.put("missing", true); call.resolve(r); return; } // an error page, not a page of the manual
                if (pdf) {
                    if (g.body[0] != '%' || g.body[1] != 'P' || g.body[2] != 'D' || g.body[3] != 'F') { r.put("ok", false); r.put("missing", true); call.resolve(r); return; } // not a PDF after all
                    File dir = new File(getContext().getCacheDir(), "manpdf");
                    if (!dir.isDirectory()) dir.mkdirs();
                    // (beta.10) the page drops each PDF once its pages are saved (dropPdf); any left over from a run cut short go here
                    File[] old = dir.listFiles(); long stale = System.currentTimeMillis() - 3600_000L;
                    if (old != null) for (File x : old) if (x.isFile() && x.lastModified() < stale) x.delete();
                    File f = new File(dir, safeName(key) + "-" + name + ".pdf");
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(g.body); }
                    r.put("ok", true); r.put("name", f.getName()); r.put("file", f.getAbsolutePath()); call.resolve(r); return;
                }
                String ext = extFor(g.type, url), file = name + "." + ext;
                String saved = saveToTree(treeStr, folder, sub, file, ext, g.body);
                if (saved == null) {
                    File dir = new File(getContext().getFilesDir(), "manuals/" + safeName(key));
                    if (!dir.isDirectory()) dir.mkdirs();
                    File f = new File(dir, file);
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(g.body); }
                    saved = f.getAbsolutePath();
                }
                r.put("ok", true); r.put("name", file); r.put("file", saved); call.resolve(r);
            } catch (Throwable e) { JSObject x = new JSObject(); x.put("ok", false); x.put("busy", true); call.resolve(x); }
        });
    }

    @PluginMethod
    public void dropPdf(PluginCall call) { // (beta.10) a PDF manual's download once its pages are saved { path } → { removed }. Only the cache's manpdf folder
        String p = call.getString("path", "");
        boolean ok = false;
        try {
            File dir = new File(getContext().getCacheDir(), "manpdf"), f = new File(p == null ? "" : p);
            if (f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator) && f.isFile()) ok = f.delete();
        } catch (Exception ignored) {}
        JSObject r = new JSObject(); r.put("removed", ok); call.resolve(r);
    }

    // (beta.9) a game's video preview, found beside the games (a "videos" folder): copied once into the app's cache so the
    // page can play it (the page can't open the games folder's documents itself). { uri, name, size } → { ok, path }.
    // Kept under 300 MB, the oldest dropped first; a copy that's already there (same size) is used as it is.
    private static final long PREVIEW_CAP = 300L << 20;
    // (beta.10) previews copy on a thread of their own (a 300 MB video used to hold up folder scans, art lists and manual
    // pages on io), and only the newest ask counts: one for another video (you moved on) stops an older copy part way
    private final ExecutorService previewIo = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-preview");
        t.setDaemon(true);
        return t;
    });
    private volatile String previewWant = "";
    @PluginMethod
    public void copyPreview(PluginCall call) {
        final String uriStr = call.getString("uri", ""), name = safeName(call.getString("name", "preview"));
        final long size = call.getLong("size", 0L);
        if (uriStr.isEmpty()) { call.reject("No video"); return; }
        previewWant = name;
        previewIo.execute(() -> {
            File part = null;
            try {
                if (!name.equals(previewWant)) { JSObject x = new JSObject(); x.put("ok", false); x.put("superseded", true); call.resolve(x); return; } // a newer one was asked for
                File dir = new File(getContext().getCacheDir(), "previews");
                if (!dir.isDirectory()) dir.mkdirs();
                File f = new File(dir, name);
                if (f.isFile() && (size <= 0 || f.length() == size)) { f.setLastModified(System.currentTimeMillis()); JSObject r = new JSObject(); r.put("ok", true); r.put("path", f.getAbsolutePath()); call.resolve(r); return; }
                part = new File(dir, name + ".part");
                try (java.io.InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriStr)); FileOutputStream out = new FileOutputStream(part)) {
                    if (in == null) throw new java.io.IOException("can't open the video");
                    byte[] b = new byte[256 * 1024]; int n; long total = 0;
                    while ((n = in.read(b)) > 0) { out.write(b, 0, n); total += n; if (total > PREVIEW_CAP) throw new java.io.IOException("video too big");
                        if (!name.equals(previewWant)) throw new java.io.InterruptedIOException("superseded"); }
                }
                if (!part.renameTo(f)) { part.delete(); throw new java.io.IOException("couldn't keep the video"); }
                // the cache stays under its cap: the videos not shown for longest go first
                File[] all = dir.listFiles(); long used = 0;
                if (all != null) {
                    java.util.Arrays.sort(all, (a, c) -> Long.compare(c.lastModified(), a.lastModified()));
                    for (File x : all) { used += x.length(); if (used > PREVIEW_CAP && !x.equals(f)) x.delete(); }
                }
                JSObject r = new JSObject(); r.put("ok", true); r.put("path", f.getAbsolutePath()); call.resolve(r);
            } catch (Throwable e) {
                if (part != null && part.isFile()) part.delete(); // (a copy stopped part way leaves nothing behind)
                JSObject x = new JSObject(); x.put("ok", false); x.put("error", String.valueOf(e.getMessage())); if (e instanceof java.io.InterruptedIOException) x.put("superseded", true); call.resolve(x);
            }
        });
    }

    @PluginMethod
    public void saveBytes(PluginCall call) {
        // a picture made in the page (a PDF manual's page): { tree, sub, folder: "manuals", name (no extension), ext, b64, key }
        // → { ok, name, file } into "Boxshelf Manuals" beside the games, or the app's own storage when that can't be written
        final String treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), name = safeName(call.getString("name", "file")), key = call.getString("key", "file");
        final String ext = "png".equals(call.getString("ext", "jpg")) ? "png" : "jpg", b64 = call.getString("b64", "");
        final String folder = "manuals".equals(call.getString("folder", "")) ? MANUAL_DIR : ART_DIR;
        if (b64.isEmpty()) { call.reject("Nothing to save"); return; }
        io.execute(() -> {
            try {
                byte[] body = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String file = name + "." + ext, saved = saveToTree(treeStr, folder, sub, file, ext, body);
                if (saved == null) {
                    File dir = new File(getContext().getFilesDir(), "manuals/" + safeName(key));
                    if (!dir.isDirectory()) dir.mkdirs();
                    File f = new File(dir, file);
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(body); }
                    saved = f.getAbsolutePath();
                }
                JSObject r = new JSObject(); r.put("ok", true); r.put("name", file); r.put("file", saved); call.resolve(r);
            } catch (Throwable e) { JSObject x = new JSObject(); x.put("ok", false); call.resolve(x); }
        });
    }

    @PluginMethod
    public void fetchArt(PluginCall call) {
        // { tree, sub, name, urls: [tried in order], key, maxH } → { ok, from, saved: 'folder' | 'app', file, display }
        // or { ok: false, missing } (no source has it) / { ok: false, busy } (offline, or a server having a bad day: try later).
        // With split (a full box wrap: name is "<game>-full"): the wrap is kept whole and display copies of its faces are made
        // (want: which ones; dname their name; ratio / depth the console's case shape) → also parts: { front, back, spine }
        final String treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), name = safeName(call.getString("name", "art")), key = call.getString("key", "art");
        final int maxH = Math.max(64, Math.min(2048, call.getInt("maxH", 512)));
        final JSArray urls = call.getArray("urls", new JSArray());
        final boolean split = call.getBoolean("split", false);
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        final JSArray want = call.getArray("want", new JSArray());
        final String dname = safeName(call.getString("dname", name));
        final boolean ss = call.getBoolean("ss", false); // ScreenScraper addresses: signed here (ssSign)
        net.execute(() -> {
            boolean busy = false;
            for (int k = 0; k < urls.length(); k++) {
                String url = urls.optString(k, "");
                if (url.isEmpty()) continue;
                Got g;
                try { g = httpGet(ss ? ssSign(url) : url, null, 25 * 1024 * 1024); }
                catch (TooBig e) { continue; } // (beta.10) over the limit: as good as not there (never "busy": it would be fetched again every start)
                catch (Throwable e) { busy = true; continue; } // Throwable: even out of memory, the call must still be answered
                if (g.status == 404 || g.status == 410) continue;
                if (g.body == null) { busy = true; continue; } // 5xx / 429 / 403: not remembered as "not there"
                if (g.body.length < 1024) continue; // an error page (or ScreenScraper's "NOMEDIA"), not a picture
                try {
                    String ext = extFor(g.type, url), file = name + "." + ext;
                    JSObject r = new JSObject(); r.put("ok", true); r.put("from", url.replaceAll("[?#].*$", "")); r.put("name", file); // (never the query: a ScreenScraper address carries the sign-in)
                    if (split) { // also proves it's a picture, and a wrap, before anything is saved
                        JSObject parts = writeParts(g.body, key, dname, maxH, ratio, depth, want);
                        r.put("parts", parts);
                        r.put("display", parts.optString("front", parts.optString("back", parts.optString("spine", ""))));
                    } else r.put("display", writeDisplay(g.body, key, name, maxH));
                    String saved = saveToTree(treeStr, sub, file, ext, g.body);
                    if (saved != null) { r.put("saved", "folder"); r.put("file", saved); }
                    else {
                        File dir = new File(getContext().getFilesDir(), "art-full/" + safeName(key));
                        if (!dir.isDirectory()) dir.mkdirs();
                        File f = new File(dir, file);
                        try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(g.body); }
                        r.put("saved", "app"); r.put("file", f.getAbsolutePath());
                    }
                    call.resolve(r); return;
                } catch (Throwable e) { continue; } // not a picture we can read (or too big to decode, or no wrap): the next source
            }
            JSObject r = new JSObject(); r.put("ok", false); r.put("missing", !busy); r.put("busy", busy); call.resolve(r);
        });
    }

    @PluginMethod
    public void artThumb(PluginCall call) { // a display copy of a picture already there (Boxshelf Art, or the app's own) → { display }
        // (split, want, dname, ratio, depth: a full wrap, as fetchArt → also parts: { front, back, spine })
        final String src = call.getString("src"), key = call.getString("key", "art"), name = safeName(call.getString("name", "art"));
        final int maxH = Math.max(64, Math.min(2048, call.getInt("maxH", 512)));
        final boolean split = call.getBoolean("split", false);
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        final JSArray want = call.getArray("want", new JSArray());
        final String dname = safeName(call.getString("dname", name));
        if (src == null) { call.reject("No picture given"); return; }
        net.execute(() -> {
            try {
                byte[] body = readSrc(src);
                JSObject r = new JSObject();
                if (split) { JSObject parts = writeParts(body, key, dname, maxH, ratio, depth, want); r.put("parts", parts); r.put("display", parts.optString("front", parts.optString("back", parts.optString("spine", "")))); }
                else r.put("display", writeDisplay(body, key, name, maxH));
                call.resolve(r);
            } catch (Throwable e) { call.reject("Couldn't read that picture: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void artExists(PluginCall call) { // which display copies (absolute paths in the app's storage) are gone → { missing: [paths] }
        final JSArray paths = call.getArray("paths", new JSArray());
        io.execute(() -> {
            JSArray missing = new JSArray();
            for (int k = 0; k < paths.length(); k++) { String p = paths.optString(k, ""); if (!p.isEmpty() && !new File(p).isFile()) missing.put(p); }
            JSObject r = new JSObject(); r.put("missing", missing); call.resolve(r);
        });
    }

    @PluginMethod
    public void artForget(PluginCall call) { // display copies no longer used (0.3.2: made again sharper) → { removed }. Only files under files/art/
        final JSArray paths = call.getArray("paths", new JSArray());
        io.execute(() -> {
            int n = 0;
            try {
                String root = new File(getContext().getFilesDir(), "art").getCanonicalPath() + File.separator;
                for (int k = 0; k < paths.length(); k++) {
                    String p = paths.optString(k, "");
                    if (p.isEmpty()) continue;
                    try { File f = new File(p); if (f.getCanonicalPath().startsWith(root) && f.isFile() && f.delete()) n++; } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {}
            JSObject r = new JSObject(); r.put("removed", n); call.resolve(r);
        });
    }

    // a picture Boxshelf may read: a content:// document (a picked folder, a picked picture) or a file of its own
    private byte[] readSrc(String src) throws IOException {
        if (src.startsWith("content:")) {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(src))) {
                if (in == null) throw new IOException("Unreadable");
                return readAll(in, 40 * 1024 * 1024);
            }
        }
        File f = new File(src);
        String path = f.getCanonicalPath(), files = getContext().getFilesDir().getCanonicalPath(), cache = getContext().getCacheDir().getCanonicalPath();
        if (!path.startsWith(files + File.separator) && !path.startsWith(cache + File.separator)) throw new IOException("Not one of Boxshelf's files");
        try (InputStream in = new FileInputStream(f)) { return readAll(in, 40 * 1024 * 1024); }
    }

    private static String sniffExt(byte[] b) {
        if (b.length > 12 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') return "png";
        if (b.length > 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) return "jpg";
        if (b.length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') return "webp";
        return null; // something else Android can still read (HEIC, GIF, BMP…): saved as a JPEG copy
    }

    private static byte[] jpegOf(Bitmap bmp, int q) throws IOException {
        try {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            if (!bmp.compress(Bitmap.CompressFormat.JPEG, q, bo)) throw new IOException("Couldn't encode the picture");
            return bo.toByteArray();
        } finally { bmp.recycle(); }
    }

    // ---------- Art Studio: every version of a part, downloaded once into the app's cache and shown as small cards ----------
    @PluginMethod
    public void artCache(PluginCall call) {
        // { url, id, cut?: 'front' | 'back' | 'spine' (a face of a full wrap), ratio, depth, maxH } → { file, thumb, w, h }
        // (w × h: the picture, or the cut face, at full size) or { missing } / { busy }. id names the cache file: the page
        // passes a fingerprint of the address without any sign-in in it, so one version is never downloaded twice
        final String url = call.getString("url"), id = safeName(call.getString("id", "x")), cut = call.getString("cut", "");
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        final int maxH = Math.max(64, Math.min(1024, call.getInt("maxH", 360)));
        final boolean ss = call.getBoolean("ss", false);
        if (url == null || url.isEmpty()) { call.reject("No address"); return; }
        net.execute(() -> {
            JSObject r = new JSObject();
            try {
                File dir = new File(getContext().getCacheDir(), "artc");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No cache folder");
                File f = new File(dir, id + ".bin");
                byte[] body;
                boolean fresh = false;
                if (f.isFile() && f.length() > 0) { try (InputStream in = new FileInputStream(f)) { body = readAll(in, 40 * 1024 * 1024); } }
                else {
                    Got g;
                    try { g = httpGet(ss ? ssSign(url) : url, null, 25 * 1024 * 1024); }
                    catch (TooBig e) { r.put("missing", true); r.put("toobig", true); call.resolve(r); return; } // (beta.10) not offered, never fetched again for nothing
                    catch (Throwable e) { r.put("busy", true); call.resolve(r); return; }
                    if (g.status == 404 || g.status == 410 || (g.body != null && g.body.length < 1024)) { r.put("missing", true); call.resolve(r); return; }
                    if (g.body == null) { r.put("busy", true); call.resolve(r); return; }
                    body = g.body; fresh = true;
                }
                BitmapFactory.Options o = new BitmapFactory.Options(); o.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(body, 0, body.length, o);
                int w = o.outWidth, h = o.outHeight;
                if (w <= 0 || h <= 0) { r.put("missing", true); call.resolve(r); return; }
                Bitmap bmp = decodeAbout(body, maxH, 16);
                if (!cut.isEmpty()) {
                    int[] c = wrapCuts(w, h, ratio, depth);
                    if (c == null) { bmp.recycle(); r.put("missing", true); call.resolve(r); return; } // not a wrap after all
                    Bitmap face;
                    try { face = cutFace(bmp, cut, ratio, depth); } finally { bmp.recycle(); }
                    bmp = face; w = "spine".equals(cut) ? c[1] : c[0];
                }
                String thumb = writeBitmap(bmp, new File(dir, "t"), id + (cut.isEmpty() ? "" : "-" + cut), maxH);
                if (fresh) {
                    File tmp = new File(dir, id + ".tmp");
                    try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(body); }
                    if (!tmp.renameTo(f)) tmp.delete();
                    trimCache(dir);
                }
                r.put("file", f.getAbsolutePath()); r.put("thumb", thumb); r.put("w", w); r.put("h", h);
                call.resolve(r);
            } catch (Throwable e) { r.put("missing", true); call.resolve(r); } // unreadable as a picture (or too big): not offered
        });
    }

    // the studio's cache stays small: past 300 downloads the oldest go (their small cards with them)
    private static void trimCache(File dir) {
        File[] all = dir.listFiles();
        if (all == null || all.length <= 320) return;
        java.util.Arrays.sort(all, (x, y) -> Long.compare(x.lastModified(), y.lastModified()));
        for (int i = 0; i < all.length - 300; i++) {
            if (!all[i].isFile()) continue;
            String n = all[i].getName();
            all[i].delete();
            if (n.endsWith(".bin")) {
                String id = n.substring(0, n.length() - 4);
                File[] t = new File(dir, "t").listFiles();
                if (t != null) for (File x : t) if (x.getName().startsWith(id + ".") || x.getName().startsWith(id + "-")) x.delete();
            }
        }
    }

    @PluginMethod
    public void pickImage(PluginCall call) { // Android's own picture picker (Storage Access Framework) → { uri } or { canceled }
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, i, "imagePicked");
    }

    @ActivityCallback
    private void imagePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject r = new JSObject();
        if (data == null || data.getData() == null) { r.put("canceled", true); call.resolve(r); return; }
        r.put("uri", data.getData().toString());
        call.resolve(r);
    }

    @PluginMethod
    public void saveArt(PluginCall call) {
        // { src (a studio download, a picked picture or a kept older one), tree, sub, name, key, dname, maxH, cut?, ratio, depth }
        // → { ok, display, file, saved: 'folder' | 'app', name, old? }. The picture goes into "Boxshelf Art" as <name>.<ext>
        // (a face cut from a wrap: as a JPEG). Whatever was there under that name, in any picture type, is first copied to the
        // app's own storage (old: for Undo) and then removed, so the folder never holds two pictures for one part.
        // dname: the display copy's own name (new each time, so the shelf never shows a cached older picture)
        final String src = call.getString("src"), treeStr = call.getString("tree", ""), sub = call.getString("sub", ""), name = safeName(call.getString("name", "art")),
            key = call.getString("key", "art"), cut = call.getString("cut", "");
        final String dname = safeName(call.getString("dname", name));
        final int maxH = Math.max(64, Math.min(2048, call.getInt("maxH", 512)));
        final JSObject data = call.getData();
        final double ratio = data == null ? 0.71 : data.optDouble("ratio", 0.71), depth = data == null ? 0.1 : data.optDouble("depth", 0.1);
        if (src == null || src.isEmpty()) { call.reject("No picture given"); return; }
        net.execute(() -> {
            try {
                byte[] body = readSrc(src);
                String ext;
                if (!cut.isEmpty()) {
                    Bitmap full = decodeAtMost(body, 4096), face;
                    try { face = cutFace(full, cut, ratio, depth); } finally { full.recycle(); }
                    body = jpegOf(face, 92); ext = "jpg";
                } else {
                    ext = sniffExt(body);
                    if (ext == null) { body = jpegOf(decodeAtMost(body, 4096), 92); ext = "jpg"; }
                }
                String display = writeDisplay(body, key, dname, maxH); // (proves it's a picture before anything is touched)
                String file = name + "." + ext, old = null, saved = null;
                if (!treeStr.isEmpty()) { old = clearOld(treeStr, sub, name, key); saved = saveToTree(treeStr, sub, file, ext, body); }
                JSObject r = new JSObject(); r.put("ok", true); r.put("display", display); r.put("name", file);
                if (saved != null) { r.put("saved", "folder"); r.put("file", saved); }
                else {
                    File dir = new File(getContext().getFilesDir(), "art-full/" + safeName(key));
                    if (!dir.isDirectory()) dir.mkdirs();
                    for (String e : PIC_EXTS) {
                        File was = new File(dir, name + "." + e);
                        if (!was.isFile()) continue;
                        if (old == null) old = keepOld(new FileInputStream(was), key, name, e);
                        if (old != null) was.delete();
                    }
                    File f = new File(dir, file);
                    try (FileOutputStream fo = new FileOutputStream(f)) { fo.write(body); }
                    r.put("saved", "app"); r.put("file", f.getAbsolutePath());
                }
                if (old != null) r.put("old", old);
                call.resolve(r);
            } catch (Throwable e) { call.reject("Couldn't use that picture: " + e.getMessage()); }
        });
    }

    private static final String[] PIC_EXTS = { "png", "jpg", "jpeg", "webp" };

    // every "<name>.<png|jpg|jpeg|webp>" in the games folder's Boxshelf Art: the first is kept in the app's own storage
    // (→ its path, for Undo) and all are removed. One that can't be kept is left where it is (never lost)
    private String clearOld(String treeStr, String sub, String name, String key) {
        String old = null;
        try {
            Uri tree = Uri.parse(treeStr); ContentResolver cr = getContext().getContentResolver();
            String dir = artDirId(cr, tree, sub, false);
            if (dir == null) return null;
            for (String e : PIC_EXTS) {
                String id = findChild(cr, tree, dir, name + "." + e, false);
                if (id == null) continue;
                Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, id);
                if (old == null) { InputStream in = cr.openInputStream(doc); if (in != null) old = keepOld(in, key, name, e); }
                if (old != null) { try { DocumentsContract.deleteDocument(cr, doc); } catch (Exception ignored) {} }
            }
        } catch (Exception ignored) {}
        return old;
    }

    // a picture about to be replaced → files/art-old/<key>/<name>-<time>.<ext> (closes in) → its path, or null
    private String keepOld(InputStream in, String key, String name, String ext) {
        try (InputStream i = in) {
            File dir = new File(getContext().getFilesDir(), "art-old/" + safeName(key));
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            File f = new File(dir, safeName(name) + "-" + System.currentTimeMillis() + "." + ext);
            try (FileOutputStream fo = new FileOutputStream(f)) { byte[] buf = new byte[16384]; int n; while ((n = i.read(buf)) > 0) fo.write(buf, 0, n); }
            // only the newest 60 per console are kept (Undo goes back 10 picks per part): the folder never grows for ever
            File[] all = dir.listFiles();
            if (all != null && all.length > 60) {
                java.util.Arrays.sort(all, (x, y) -> Long.compare(y.lastModified(), x.lastModified()));
                for (int k = 60; k < all.length; k++) if (all[k].isFile()) all[k].delete();
            }
            return f.getAbsolutePath();
        } catch (Exception e) { return null; }
    }

    // ---------- settings files (app-private storage) ----------
    private File fileFor(String name) { return new File(getContext().getFilesDir(), name.replaceAll("[^A-Za-z0-9._-]", "_")); }

    @PluginMethod
    public void readText(PluginCall call) {
        File f = fileFor(call.getString("name", "x"));
        JSObject r = new JSObject();
        if (!f.exists()) { r.put("text", null); call.resolve(r); return; }
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()]; int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            r.put("text", new String(b, 0, off, StandardCharsets.UTF_8)); call.resolve(r);
        } catch (Exception e) { call.reject("Couldn't read " + f.getName()); }
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        File f = fileFor(call.getString("name", "x")), tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8)); out.getFD().sync();
        } catch (Exception e) { call.reject("Couldn't save " + f.getName()); return; }
        // write-then-rename: a crash mid-save never leaves half a file. (beta.8) If the rename over the old file fails, the
        // old one is moved aside first and only removed once the new one is in place; it's put back if that fails too, and
        // the save says so (it used to delete the old file first: two failed renames lost the settings)
        if (!tmp.renameTo(f)) {
            File old = new File(f.getPath() + ".old"); old.delete();
            boolean aside = !f.exists() || f.renameTo(old);
            if (aside && tmp.renameTo(f)) old.delete();
            else { if (aside && !f.exists() && old.exists()) old.renameTo(f); tmp.delete(); call.reject("Couldn't save " + f.getName()); return; }
        }
        call.resolve();
    }

    // ---------- the bottom screen (AYN Thor's second display: BottomScreen.java, page bottom.html) ----------
    private BottomScreen bottom;

    @Override
    public void load() {
        try { readingStore = new ReadingStore(getContext(), userAgent(), (e, o) -> notifyListeners(e, o)); } catch (RuntimeException e) { readingStore = null; } // (beta.10: reading() makes it later if this failed)
        try {
            bottom = new BottomScreen(getActivity(), new BottomScreen.Listener() {
                @Override
                public void onMessage(String json) { JSObject r = new JSObject(); r.put("msg", json); notifyListeners("bottom", r); }

                @Override
                public void onChange() { notifyListeners("bottomChange", new JSObject()); }
            });
        } catch (RuntimeException e) { bottom = null; } // no display service: simply no bottom screen
    }

    @PluginMethod
    public void bottomStatus(PluginCall call) { // { available, enabled, shown, width, height, density, name }
        if (bottom == null) { JSObject r = new JSObject(); r.put("available", false); r.put("enabled", false); r.put("shown", false); call.resolve(r); return; }
        call.resolve(bottom.status());
    }

    @PluginMethod
    public void bottomShow(PluginCall call) { if (bottom != null) bottom.setEnabled(true, call.getBoolean("remember", false)); call.resolve(); }

    @PluginMethod
    public void bottomHide(PluginCall call) { if (bottom != null) bottom.setEnabled(false, call.getBoolean("remember", false)); call.resolve(); }

    // ---------- the LaunchBox Games Database (0.3.3): LaunchBoxIndex does the work on its own thread ----------
    private volatile LaunchBoxIndex lbJob = null;

    @PluginMethod
    public void lbIndex(PluginCall call) { // { plats: [LaunchBox platform names] } → { ok, at, plats, counts, bytes }; "lbIndex" events { phase, pct, got, total }
        final JSArray arr = call.getArray("plats", new JSArray());
        final Set<String> plats = new HashSet<>();
        for (int k = 0; k < arr.length(); k++) { String p = arr.optString(k, ""); if (!p.isEmpty()) plats.add(p); }
        if (plats.isEmpty()) { call.reject("No consoles given"); return; }
        synchronized (this) { if (lbJob != null) { call.reject("busy"); return; } lbJob = new LaunchBoxIndex(); }
        final LaunchBoxIndex job = lbJob;
        final String ua = userAgent();
        Thread t = new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
            try {
                JSObject r = job.run(getContext().getFilesDir(), new File(getContext().getFilesDir(), "lb-work"), plats, ua, (phase, pct, got, total) -> {
                    JSObject e = new JSObject(); e.put("phase", phase); e.put("pct", pct); e.put("got", got); e.put("total", total);
                    notifyListeners("lbIndex", e);
                });
                call.resolve(r);
            } catch (Throwable e) {
                call.reject(job.cancelled() ? "cancelled" : ("LaunchBox: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage())));
            } finally { synchronized (this) { if (lbJob == job) lbJob = null; } }
        }, "boxshelf-lb");
        t.setDaemon(true);
        t.start();
    }

    @PluginMethod
    public void lbCancel(PluginCall call) { LaunchBoxIndex j = lbJob; if (j != null) j.cancel(); JSObject r = new JSObject(); r.put("ok", j != null); call.resolve(r); }

    @PluginMethod
    public void bottomPost(PluginCall call) { // { msg: {...} } → the bottom page's bsBottom.recv
        JSObject m = call.getObject("msg");
        if (m == null) { call.reject("No message"); return; }
        if (bottom != null) bottom.post(m.toString());
        call.resolve();
    }

    // ---------- coming back from a game ----------
    @Override
    protected void handleOnResume() {
        notifyListeners("resume", new JSObject());
        if (bottom != null) bottom.onResume();
    }

    @Override
    protected void handleOnPause() {
        notifyListeners("pause", new JSObject());
        if (bottom != null) bottom.onPause(); // the game (DS / 3DS emulators, bottom-screen mods) gets the bottom screen
    }

    @Override
    protected void handleOnDestroy() { if (bottom != null) bottom.release(); }
}
