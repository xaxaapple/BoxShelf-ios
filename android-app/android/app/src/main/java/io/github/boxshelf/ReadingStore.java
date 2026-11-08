package io.github.boxshelf;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Magazines & guides (0.3.2): the Internet Archive store's downloads, and the reading corner's files.
 * - download: one archive.org file straight to a file (never through the page), up to four ranged connections at once
 *   when the server allows them, resumed after an interruption (the half file and where each connection got to are kept
 *   in the app's storage), progress events, cancel. When complete it goes into "Boxshelf Reading/Magazines|Guides/<series>"
 *   beside the ROMs (Storage Access Framework), or the app's own storage when there's no folder it may write.
 * - local: the magazines and guides kept in the app's own storage.
 * - cover: a cover picture (from archive.org, or drawn by the page) saved in the app's storage.
 * - zip: a comic archive's page pictures, unpacked into the app's cache for the reader (or just its first page, as a cover).
 * Everything runs on its own background-priority threads; every call is answered exactly once.
 */
final class ReadingStore {
    interface Events { void emit(String event, JSObject data); }

    private static final String READ_DIR = "Boxshelf Reading";
    private static final int CONNS = 4;                          // ranged connections per file
    private static final long MIN_SPLIT = 8L * 1024 * 1024;      // smaller files come down in one piece
    private static final long MAX_BYTES = 4L * 1024 * 1024 * 1024;
    private static final int MAX_PAGES = 1500;
    private static final long MAX_UNPACK = 1536L * 1024 * 1024;

    private final Context ctx;
    private final String ua;
    private final Events ev;
    private final Object dirLock = new Object();                 // two downloads finishing together must not both make a folder
    private final Object unpackLock = new Object();              // one comic unpacked into the page cache at a time
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(() -> { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); r.run(); }, "boxshelf-reading");
        t.setDaemon(true);
        return t;
    });

    ReadingStore(Context ctx, String ua, Events ev) { this.ctx = ctx.getApplicationContext(); this.ua = ua; this.ev = ev; }

    private static final class Job {
        final String id;
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        final AtomicBoolean halt = new AtomicBoolean(false);     // one connection failed for good: the others stop too
        final Set<HttpURLConnection> open = Collections.newSetFromMap(new ConcurrentHashMap<>());
        Job(String id) { this.id = id; }
        boolean stopped() { return cancelled.get() || halt.get(); }
        void drop() { for (HttpURLConnection c : open) { try { c.disconnect(); } catch (Exception ignored) {} } }
    }

    private static final class Seg {
        final long start, end;          // inclusive byte range (end = -1: unknown length, read to the end)
        volatile long pos;              // the next byte to fetch
        Seg(long start, long end, long pos) { this.start = start; this.end = end; this.pos = pos; }
        boolean done() { return end >= 0 && pos > end; }
    }

    private static final class HttpErr extends IOException {
        final int status; final int retryAfter;
        HttpErr(int status, int retryAfter) { super("HTTP " + status); this.status = status; this.retryAfter = retryAfter; }
    }

    private static final class NoRanges extends IOException { NoRanges() { super("The server stopped answering byte ranges"); } }

    // ---------- small helpers ----------
    static String safeName(String s) {
        String t = String.valueOf(s).replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        while (t.startsWith(".")) t = t.substring(1);
        if (t.length() > 120) t = t.substring(0, 120).trim();
        return t.isEmpty() ? "Untitled" : t;
    }

    private static boolean archiveHost(String u) {
        try {
            URL x = new URL(u);
            String h = x.getHost().toLowerCase(Locale.ROOT);
            return "https".equals(x.getProtocol()) && (h.equals("archive.org") || h.endsWith(".archive.org"));
        } catch (Exception e) { return false; }
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); } }
    // a wait that Cancel cuts short (a "slow down" answer can ask for a minute)
    private static void nap(Job j, long ms) { long until = System.currentTimeMillis() + ms; while (!j.stopped()) { long left = until - System.currentTimeMillis(); if (left <= 0) break; sleep(Math.min(250, left)); } }

    private static JSObject fail(String msg) { JSObject r = new JSObject(); r.put("ok", false); r.put("error", msg); return r; }

    private static int retryAfterOf(HttpURLConnection c) {
        try { String v = c.getHeaderField("Retry-After"); if (v != null && v.trim().matches("\\d{1,5}")) return Integer.parseInt(v.trim()); } catch (Exception ignored) {}
        return 0;
    }

    // a GET on archive.org (redirects followed by hand, only ever to archive.org), with an optional byte range
    private HttpURLConnection open(Job job, String url, String range) throws IOException {
        String u = url;
        for (int hop = 0; hop < 6; hop++) {
            if (!archiveHost(u)) throw new IOException("Not an Internet Archive address");
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            if (job != null) job.open.add(c);
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(45000);
            c.setRequestProperty("User-Agent", ua);
            c.setRequestProperty("Accept-Encoding", "identity"); // byte ranges are of the file itself
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && code != 304) {
                String loc = c.getHeaderField("Location");
                c.disconnect(); if (job != null) job.open.remove(c);
                if (loc == null) throw new HttpErr(code, 0);
                u = new URL(new URL(u), loc).toString();
                continue;
            }
            return c;
        }
        throw new IOException("Too many redirects");
    }

    private static void close(Job job, HttpURLConnection c) {
        if (c == null) return;
        if (job != null) job.open.remove(c);
        try { c.disconnect(); } catch (Exception ignored) {}
    }

    // ---------- download ----------
    // { id, url (https://archive.org/download/...), size, tree, kind: magazine | guide, series, name (no extension), ext }
    // → { ok, file, name, saved: folder | app, size, existed? } | { ok: false, error, cancelled?, missing?, busy?, status? }
    void download(PluginCall call) {
        final JSObject d = call.getData();
        final String id = call.getString("id", ""), url = call.getString("url", ""), tree = call.getString("tree", "");
        final String kind = "guide".equals(call.getString("kind", "")) ? "guide" : "magazine";
        final String series = call.getString("series", ""), name = call.getString("name", "Untitled");
        final String e0 = call.getString("ext", "pdf").toLowerCase(Locale.ROOT), ext = "cbz".equals(e0) || "zip".equals(e0) ? e0 : "pdf";
        final long size = d == null ? 0 : d.optLong("size", 0);
        if (!id.matches("[A-Za-z0-9._-]{1,140}")) { call.resolve(fail("Unknown item.")); return; }
        if (!url.startsWith("https://archive.org/download/")) { call.resolve(fail("Only Internet Archive downloads are allowed.")); return; }
        final Job job = new Job(id);
        if (jobs.putIfAbsent(id, job) != null) { call.resolve(fail("That one is downloading already.")); return; }
        pool.execute(() -> {
            JSObject r;
            try { r = run(job, url, size, tree, kind, series, name, ext); }
            catch (Throwable e) {
                r = fail(job.cancelled.get() ? "Cancelled." : "The download didn't finish (" + e.getMessage() + ").");
                if (job.cancelled.get()) r.put("cancelled", true);
            }
            finally { jobs.remove(id); }
            call.resolve(r);
        });
    }

    void cancel(PluginCall call) {
        Job j = jobs.get(call.getString("id", ""));
        if (j != null) { j.cancelled.set(true); j.drop(); }
        JSObject r = new JSObject(); r.put("ok", j != null); call.resolve(r);
    }

    private static final class Probe { String url; long total = -1; boolean ranges; }

    // where the file really is (after archive.org's redirect to its storage server), its length, and whether it answers
    // byte ranges: a request for its first byte
    private Probe probe(Job job, String url) throws IOException {
        HttpURLConnection c = null;
        try {
            c = open(job, url, "bytes=0-0");
            int code = c.getResponseCode();
            Probe p = new Probe(); p.url = c.getURL().toString();
            if (code == 206) {
                String cr = c.getHeaderField("Content-Range");
                if (cr != null) { int slash = cr.lastIndexOf('/'); if (slash > 0) { try { p.total = Long.parseLong(cr.substring(slash + 1).trim()); } catch (NumberFormatException ignored) {} } }
                p.ranges = p.total > 0;
                return p;
            }
            if (code >= 200 && code < 300) { p.total = c.getContentLengthLong(); p.ranges = false; return p; }
            throw new HttpErr(code, retryAfterOf(c));
        } finally { close(job, c); }
    }

    private JSObject run(Job job, String url, long size, String tree, String kind, String series, String name, String ext) throws Exception {
        File dir = new File(ctx.getFilesDir(), "reading-dl");
        if (!dir.isDirectory() && !dir.mkdirs()) return fail("The file couldn't be saved (is the storage full?).");
        File part = new File(dir, job.id + ".part"), state = new File(dir, job.id + ".json");
        Probe p = null;
        for (int t = 0; t < 4 && p == null; t++) {
            if (job.cancelled.get()) break;
            try { p = probe(job, url); }
            catch (HttpErr e) {
                if (e.status == 429 || e.status == 503) { if (t == 3) return busy(e.status); nap(job, Math.min(60, Math.max(4, e.retryAfter)) * 1000L); continue; }
                return refused(e.status);
            } catch (IOException e) { if (job.cancelled.get() || t == 3) throw e; nap(job, 1500L * (t + 1)); }
        }
        if (job.cancelled.get()) { cleanup(part, state); return cancelled(); }
        if (p == null) return busy(0);
        long total = p.total > 0 ? p.total : size;
        if (total > MAX_BYTES) return fail("That file is over 4 GB.");
        List<Seg> segs = p.ranges && total > 0 ? loadState(state, url, total) : null;
        if (segs == null || part.length() != total) {
            cleanup(part, state);
            segs = new ArrayList<>();
            if (p.ranges && total > 0) {
                int n = total >= MIN_SPLIT ? CONNS : 1; long each = total / n;
                for (int k = 0; k < n; k++) { long s = k * each, e = k == n - 1 ? total - 1 : (k + 1) * each - 1; segs.add(new Seg(s, e, s)); }
                try (RandomAccessFile raf = new RandomAccessFile(part, "rw")) { raf.setLength(total); }
            } else segs.add(new Seg(0, p.total > 0 ? p.total - 1 : -1, 0)); // (never the page's guess at the size: a wrong guess cut the file short, or never let it finish)
        }
        final boolean ranged = p.ranges && total > 0;
        final String from = p.url;
        final AtomicLong done = new AtomicLong(0);
        for (Seg s : segs) done.addAndGet(s.pos - s.start);
        final long tot = total;
        List<Future<?>> fs = new ArrayList<>();
        for (Seg s : segs) if (!s.done()) fs.add(pool.submit(() -> { fetchSeg(job, from, url, part, s, done, ranged); return null; }));
        // progress for the page (a few times a second) and where each connection got to (for a resume), until all are in
        long lastSave = 0;
        while (true) {
            boolean all = true; for (Future<?> f : fs) if (!f.isDone()) { all = false; break; }
            int active = 0; for (Seg s : segs) if (!s.done()) active++;
            JSObject o = new JSObject(); o.put("id", job.id); o.put("bytes", done.get()); o.put("total", tot); o.put("conns", Math.min(active, fs.size()));
            ev.emit("readingProgress", o);
            if (all) break;
            long now = System.currentTimeMillis();
            if (ranged && now - lastSave > 1500) { saveState(state, url, tot, segs); lastSave = now; }
            sleep(350);
        }
        Throwable err = null;
        for (Future<?> f : fs) {
            try { f.get(); }
            catch (ExecutionException e) { if (err == null || err instanceof NoRanges) err = e.getCause() != null ? e.getCause() : e; }
        }
        if (job.cancelled.get()) { cleanup(part, state); return cancelled(); }
        if (err instanceof NoRanges) { cleanup(part, state); return fail("The download was interrupted. Press it again to start over."); }
        if (err != null) {
            if (ranged) saveState(state, url, tot, segs); else cleanup(part, state);
            if (err instanceof HttpErr) { int st = ((HttpErr) err).status; return st == 429 || st == 503 ? busy(st) : refused(st); }
            JSObject r = fail("The download stopped. Press it again to carry on from where it got to."); r.put("resumable", ranged); return r;
        }
        if (!ranged) { try (RandomAccessFile raf = new RandomAccessFile(part, "rw")) { raf.setLength(segs.get(0).pos); } } // (a retry that started over leaves nothing of the first try behind)
        long got = part.length();
        if (got < 2048) { cleanup(part, state); return fail("That file is empty on the Internet Archive."); }
        if (ranged && got != tot) { cleanup(part, state); return fail("The download came out the wrong size. Try again."); }
        state.delete();
        return place(job, part, tree, kind, series, name, ext, got);
    }

    private static JSObject cancelled() { JSObject r = fail("Cancelled."); r.put("cancelled", true); return r; }
    private static JSObject busy(int status) { JSObject r = fail("archive.org is busy right now. Try again in a minute."); r.put("busy", true); r.put("status", status); return r; }
    private static JSObject refused(int status) {
        JSObject r = fail(status == 404 || status == 410 ? "That file is missing on the Internet Archive."
                : status == 401 || status == 403 || status == 451 ? "The Internet Archive won't let this file be downloaded (it may be restricted)." : "archive.org answered " + status + ".");
        r.put("status", status); if (status == 404 || status == 410) r.put("missing", true); return r;
    }
    private static void cleanup(File part, File state) { part.delete(); state.delete(); }

    // one connection's share of the file, retried (carrying on where it got to) after a dropped connection
    private void fetchSeg(Job job, String from, String orig, File part, Seg s, AtomicLong done, boolean ranged) throws IOException {
        int fails = 0; String u = from;
        while (!s.done() && !job.stopped()) {
            HttpURLConnection c = null;
            try {
                c = open(job, u, ranged ? "bytes=" + s.pos + "-" + s.end : null);
                int code = c.getResponseCode();
                if (code == 429 || code == 503) throw new HttpErr(code, retryAfterOf(c));
                if (code == 403 && !u.equals(orig) && fails < 2) { u = orig; throw new IOException("storage server refused: asking again"); } // (a moved file: archive.org points to its new place)
                if (code >= 400) throw new HttpErr(code, 0);
                if (ranged && code != 206) throw new NoRanges();
                if (ranged) { String cr = c.getHeaderField("Content-Range"); if (cr == null || !cr.trim().startsWith("bytes " + s.pos + "-")) throw new IOException("unexpected range answer"); } // (a different range would corrupt the file)
                if (!ranged && s.pos > 0) { done.addAndGet(-s.pos); s.pos = 0; } // a whole-file answer starts at the beginning again
                try (InputStream in = new BufferedInputStream(c.getInputStream(), 65536); RandomAccessFile raf = new RandomAccessFile(part, "rw")) {
                    raf.seek(s.pos);
                    byte[] buf = new byte[65536]; int n;
                    while ((n = in.read(buf)) > 0) {
                        if (job.stopped()) throw new IOException("stopped");
                        if (s.end >= 0) { long room = s.end - s.pos + 1; if (room <= 0) break; if (n > room) n = (int) room; }
                        raf.write(buf, 0, n); s.pos += n; done.addAndGet(n); if (ranged) fails = 0; // (a whole-file retry starts from nothing again: not progress)
                        if (s.done()) break;
                    }
                }
                if (s.end < 0) return; // unknown length: the end of the answer is the end of the file
                if (!s.done()) throw new IOException("connection closed early");
            } catch (NoRanges e) {
                job.halt.set(true); job.drop(); throw e;
            } catch (HttpErr e) {
                if (job.stopped()) return;
                if ((e.status == 429 || e.status == 503) && fails < 6) { fails++; nap(job, Math.min(60, Math.max(5, e.retryAfter)) * 1000L); continue; }
                job.halt.set(true); job.drop(); throw e;
            } catch (IOException e) {
                if (job.stopped()) return;
                if (++fails > 6) { job.halt.set(true); job.drop(); throw e; }
                nap(job, Math.min(15000L, 1000L << Math.min(4, fails - 1)));
            } finally { close(job, c); }
        }
    }

    private static List<Seg> loadState(File state, String url, long total) {
        try {
            if (!state.isFile()) return null;
            byte[] b = readAll(new FileInputStream(state), 1 << 20);
            JSONObject o = new JSONObject(new String(b, StandardCharsets.UTF_8));
            if (!url.equals(o.optString("url")) || o.optLong("total") != total) return null;
            JSONArray a = o.getJSONArray("seg"); List<Seg> out = new ArrayList<>();
            long expect = 0;
            for (int k = 0; k < a.length(); k++) {
                JSONArray x = a.getJSONArray(k); long s = x.getLong(0), e = x.getLong(1), p = x.getLong(2);
                if (s != expect || e < s || p < s || p > e + 1) return null;
                out.add(new Seg(s, e, p)); expect = e + 1;
            }
            return expect == total && !out.isEmpty() ? out : null;
        } catch (Exception e) { return null; }
    }

    private static void saveState(File state, String url, long total, List<Seg> segs) {
        try {
            JSONObject o = new JSONObject(); o.put("url", url); o.put("total", total);
            JSONArray a = new JSONArray();
            for (Seg s : segs) { JSONArray x = new JSONArray(); x.put(s.start); x.put(s.end); x.put(s.pos); a.put(x); }
            o.put("seg", a);
            File tmp = new File(state.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(o.toString().getBytes(StandardCharsets.UTF_8)); }
            if (!tmp.renameTo(state)) { state.delete(); tmp.renameTo(state); }
        } catch (Exception ignored) {}
    }

    private static byte[] readAll(InputStream in0, int max) throws IOException {
        try (InputStream in = in0) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream(); byte[] buf = new byte[16384]; int n;
            while ((n = in.read(buf)) > 0) { bo.write(buf, 0, n); if (bo.size() > max) throw new IOException("Too large"); }
            return bo.toByteArray();
        }
    }

    // ---------- where a finished download goes ----------
    private JSObject place(Job job, File part, String treeStr, String kind, String series, String name, String ext, long total) {
        String kindDir = "guide".equals(kind) ? "Guides" : "Magazines", base = safeName(name), file = base + "." + ext;
        String sub = series == null || series.trim().isEmpty() ? null : safeName(series);
        if (treeStr != null && !treeStr.isEmpty()) {
            ContentResolver cr = ctx.getContentResolver(); Uri doc = null; boolean made = false;
            try {
                Uri tree = Uri.parse(treeStr);
                String dirId = sub == null ? ensureDirs(cr, tree, READ_DIR, kindDir) : ensureDirs(cr, tree, READ_DIR, kindDir, sub);
                String have = findChild(cr, tree, dirId, file, false);
                if (have != null && sizeOf(cr, tree, have) == total) { part.delete(); return placed(DocumentsContract.buildDocumentUriUsingTree(tree, have).toString(), file, "folder", total, true); }
                if (have != null) { file = base + " (" + job.id + ")." + ext; have = findChild(cr, tree, dirId, file, false); }
                if (have != null) doc = DocumentsContract.buildDocumentUriUsingTree(tree, have);
                else { doc = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, dirId), "pdf".equals(ext) ? "application/pdf" : "application/octet-stream", file); made = doc != null; }
                if (doc == null) throw new IOException("Couldn't make the file");
                try (InputStream in = new FileInputStream(part); OutputStream out = cr.openOutputStream(doc, "wt")) {
                    if (out == null) throw new IOException("No output");
                    byte[] buf = new byte[262144]; int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                part.delete();
                String shown = displayName(cr, doc); if (shown == null) shown = file;
                return placed(doc.toString(), shown, "folder", total, false);
            } catch (Exception e) {
                if (doc != null && made) { try { DocumentsContract.deleteDocument(cr, doc); } catch (Exception ignored) {} }
                // (falls through: kept in the app's own storage instead)
            }
        }
        File dir = new File(new File(new File(ctx.getFilesDir(), "reading"), kindDir), sub == null ? "" : sub);
        if (!dir.isDirectory() && !dir.mkdirs()) { part.delete(); return fail("The file couldn't be saved (is the storage full?)."); }
        File f = new File(dir, file);
        if (f.isFile() && f.length() == total) { part.delete(); return placed(f.getAbsolutePath(), f.getName(), "app", total, true); }
        if (f.exists()) f = new File(dir, base + " (" + job.id + ")." + ext);
        if (!part.renameTo(f)) {
            try (InputStream in = new FileInputStream(part); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[262144]; int n; while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } catch (IOException e) { f.delete(); part.delete(); return fail("The file couldn't be saved (is the storage full?)."); }
            part.delete();
        }
        return placed(f.getAbsolutePath(), f.getName(), "app", total, false);
    }

    private static JSObject placed(String file, String name, String saved, long size, boolean existed) {
        JSObject r = new JSObject(); r.put("ok", true); r.put("file", file); r.put("name", name); r.put("saved", saved); r.put("size", size);
        if (existed) r.put("existed", true);
        return r;
    }

    // a folder inside the picked one ("…/tree/<picked>/document/<sub folder>"): that sub folder's id, else the picked folder
    private static String startId(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() >= 4 && "tree".equals(seg.get(0)) && "document".equals(seg.get(2))) return seg.get(3);
        return DocumentsContract.getTreeDocumentId(u);
    }

    private String ensureDirs(ContentResolver cr, Uri tree, String... names) throws IOException {
        synchronized (dirLock) {
            String id = startId(tree);
            for (String n : names) {
                String kid = findChild(cr, tree, id, n, true);
                if (kid == null) {
                    Uri made = DocumentsContract.createDocument(cr, DocumentsContract.buildDocumentUriUsingTree(tree, id), DocumentsContract.Document.MIME_TYPE_DIR, n);
                    if (made == null) throw new IOException("Couldn't make the " + n + " folder");
                    kid = DocumentsContract.getDocumentId(made);
                }
                id = kid;
            }
            return id;
        }
    }

    private static String findChild(ContentResolver cr, Uri tree, String parentId, String name, boolean dir) {
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

    private static long sizeOf(ContentResolver cr, Uri tree, String docId) {
        try (Cursor c = cr.query(DocumentsContract.buildDocumentUriUsingTree(tree, docId), new String[] { DocumentsContract.Document.COLUMN_SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {}
        return -1;
    }

    private static String displayName(ContentResolver cr, Uri doc) {
        try (Cursor c = cr.query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {}
        return null;
    }

    // ---------- what's kept in the app's own storage ----------
    // → { files: [{ kind, dir (inside Magazines / Guides), name, path, size, mtime }] }
    void local(PluginCall call) {
        pool.execute(() -> {
            JSArray out = new JSArray();
            try {
                File root = new File(ctx.getFilesDir(), "reading");
                for (String[] k : new String[][] { { "magazine", "Magazines" }, { "guide", "Guides" } }) walk(new File(root, k[1]), "", 0, k[0], out);
            } catch (Throwable ignored) {}
            JSObject r = new JSObject(); r.put("files", out); call.resolve(r);
        });
    }

    private static void walk(File dir, String rel, int depth, String kind, JSArray out) {
        File[] kids = dir.listFiles(); if (kids == null) return;
        for (File f : kids) {
            String n = f.getName(); if (n.startsWith(".") || out.length() > 4000) continue;
            if (f.isDirectory()) { if (depth < 3) walk(f, rel.isEmpty() ? n : rel + "/" + n, depth + 1, kind, out); continue; }
            if (!n.toLowerCase(Locale.ROOT).matches(".+\\.(pdf|cbz|zip|jpe?g|png|webp|gif)$")) continue;
            JSObject o = new JSObject(); o.put("kind", kind); o.put("dir", rel); o.put("name", n); o.put("path", f.getAbsolutePath()); o.put("size", f.length()); o.put("mtime", f.lastModified());
            out.put(o);
        }
    }

    // ---------- covers ----------
    // { name, urls: [archive.org pictures, tried in order] } or { name, b64 } (drawn by the page) → { ok, file }
    void cover(PluginCall call) {
        final String name = safeName(call.getString("name", "cover")), b64 = call.getString("b64", "");
        final JSArray urls = call.getArray("urls", new JSArray());
        pool.execute(() -> {
            JSObject r = new JSObject();
            try {
                File dir = new File(ctx.getFilesDir(), "reading-covers");
                if (!dir.isDirectory()) dir.mkdirs();
                File f = new File(dir, name + ".jpg");
                byte[] body = null;
                if (!b64.isEmpty()) body = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                else for (int k = 0; k < urls.length() && body == null; k++) {
                    String u = urls.optString(k, ""); if (!archiveHost(u)) continue;
                    HttpURLConnection c = null;
                    try {
                        c = open(null, u, null);
                        if (c.getResponseCode() == 200) { byte[] b = readAll(c.getInputStream(), 8 * 1024 * 1024); if (b.length > 1024) body = b; }
                    } catch (IOException ignored) {} finally { close(null, c); }
                }
                if (body == null) { r.put("ok", false); call.resolve(r); return; }
                File tmp = new File(dir, name + ".tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) { out.write(body); }
                if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
                r.put("ok", true); r.put("file", f.getAbsolutePath());
            } catch (Throwable e) { r = new JSObject(); r.put("ok", false); }
            call.resolve(r);
        });
    }

    // ---------- comic archives (.cbz / a .zip of page pictures) ----------
    // { src (content:// or a path), key, first } → { files: [page pictures in order] }. first: only the first page, kept
    // with the covers (persistent); else every page, unpacked once into the app's cache (the last few books are kept).
    void zip(PluginCall call) {
        final String src = call.getString("src", ""), key = safeName(call.getString("key", "book"));
        final boolean first = call.getBoolean("first", false);
        if (src.isEmpty()) { call.reject("No file given"); return; }
        pool.execute(() -> {
            try {
                JSArray files = new JSArray();
                if (first) {
                    File dir = new File(ctx.getFilesDir(), "reading-covers");
                    if (!dir.isDirectory()) dir.mkdirs();
                    for (String e : new String[] { "jpg", "png", "webp", "gif" }) { File f = new File(dir, key + "." + e); if (f.isFile()) { files.put(f.getAbsolutePath()); break; } }
                    if (files.length() == 0) {
                        try (ZipInputStream z = new ZipInputStream(new BufferedInputStream(openSrc(src), 65536))) {
                            ZipEntry en;
                            while ((en = z.getNextEntry()) != null) {
                                String ext = imgExt(en); if (ext == null) continue;
                                File f = new File(dir, key + "." + ext), tmp = new File(dir, key + ".part");
                                if (copyLimited(z, tmp, 64L * 1024 * 1024) && tmp.renameTo(f)) files.put(f.getAbsolutePath()); else tmp.delete();
                                break;
                            }
                        }
                    }
                } else synchronized (unpackLock) { // (one book unpacked at a time: two opens of the same one never unpack over each other, nor does a trim delete it mid-way)
                    File base = new File(ctx.getCacheDir(), "reading-pages"), dir = new File(base, key), mark = new File(dir, ".done");
                    if (mark.isFile()) {
                        boolean whole = true;
                        for (String n : new String(readAll(new FileInputStream(mark), 1 << 20), StandardCharsets.UTF_8).split("\n")) if (!n.isEmpty()) { File f = new File(dir, n); if (f.isFile()) files.put(f.getAbsolutePath()); else whole = false; }
                        if (!whole) files = new JSArray(); // Android cleared some of its pages: unpacked again
                    }
                    if (files.length() == 0) {
                        deleteTree(dir); dir.mkdirs();
                        List<String[]> got = new ArrayList<>(); long bytes = 0;
                        try (ZipInputStream z = new ZipInputStream(new BufferedInputStream(openSrc(src), 65536))) {
                            ZipEntry en;
                            while ((en = z.getNextEntry()) != null && got.size() < MAX_PAGES && bytes < MAX_UNPACK) {
                                String ext = imgExt(en); if (ext == null) continue;
                                String n = String.format(Locale.ROOT, "p%05d.%s", got.size(), ext);
                                File f = new File(dir, n);
                                if (copyLimited(z, f, 64L * 1024 * 1024)) { got.add(new String[] { en.getName(), n }); bytes += f.length(); } else f.delete();
                            }
                        }
                        Collections.sort(got, (a, b) -> natural(a[0], b[0]));
                        StringBuilder sb = new StringBuilder();
                        for (String[] g : got) { files.put(new File(dir, g[1]).getAbsolutePath()); sb.append(g[1]).append('\n'); }
                        if (got.isEmpty()) { deleteTree(dir); call.reject("No page pictures inside"); return; }
                        try (FileOutputStream out = new FileOutputStream(mark)) { out.write(sb.toString().getBytes(StandardCharsets.UTF_8)); }
                        trimPages(base, dir);
                    } else dir.setLastModified(System.currentTimeMillis());
                }
                JSObject r = new JSObject(); r.put("files", files); call.resolve(r);
            } catch (Throwable e) { call.reject("Couldn't open that archive: " + e.getMessage()); }
        });
    }

    private InputStream openSrc(String src) throws IOException {
        if (src.startsWith("content:")) {
            InputStream in = ctx.getContentResolver().openInputStream(Uri.parse(src));
            if (in == null) throw new IOException("Unreadable");
            return in;
        }
        File f = new File(src);
        String p = f.getCanonicalPath(), mine = ctx.getFilesDir().getCanonicalPath();
        if (!p.startsWith(mine + File.separator)) throw new IOException("Not Boxshelf's file"); // only the app's own files by path
        return new FileInputStream(f);
    }

    // a page picture inside an archive (never a folder, a hidden file or a Mac resource fork) → its extension
    private static String imgExt(ZipEntry en) {
        if (en.isDirectory()) return null;
        String n = en.getName().replace('\\', '/'), low = n.toLowerCase(Locale.ROOT);
        if (low.contains("__macosx/")) return null;
        String leaf = low.substring(low.lastIndexOf('/') + 1);
        if (leaf.startsWith(".")) return null;
        if (leaf.endsWith(".jpg") || leaf.endsWith(".jpeg")) return "jpg";
        if (leaf.endsWith(".png")) return "png";
        if (leaf.endsWith(".webp")) return "webp";
        if (leaf.endsWith(".gif")) return "gif";
        return null;
    }

    private static boolean copyLimited(InputStream in, File f, long max) throws IOException {
        long n = 0; byte[] buf = new byte[65536]; int k;
        try (OutputStream out = new FileOutputStream(f)) {
            while ((k = in.read(buf)) > 0) { n += k; if (n > max) return false; out.write(buf, 0, k); }
        }
        return n > 0;
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    private static void trimPages(File base, File keep) {
        File[] all = base.listFiles(); if (all == null || all.length <= 4) return;
        Arrays.sort(all, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
        for (int k = 4; k < all.length; k++) if (!all[k].equals(keep)) deleteTree(all[k]);
    }

    // "page 2" before "page 10"
    static int natural(String a, String b) {
        int i = 0, j = 0, na = a.length(), nb = b.length();
        while (i < na && j < nb) {
            char x = a.charAt(i), y = b.charAt(j);
            if (Character.isDigit(x) && Character.isDigit(y)) {
                int si = i, sj = j;
                while (i < na && Character.isDigit(a.charAt(i))) i++;
                while (j < nb && Character.isDigit(b.charAt(j))) j++;
                String da = a.substring(si, i).replaceFirst("^0+(?=.)", ""), db = b.substring(sj, j).replaceFirst("^0+(?=.)", "");
                if (da.length() != db.length()) return da.length() - db.length();
                int c = da.compareTo(db); if (c != 0) return c;
            } else {
                int c = Character.toLowerCase(x) - Character.toLowerCase(y); if (c != 0) return c;
                i++; j++;
            }
        }
        return (na - i) - (nb - j);
    }
}
