package io.github.boxshelf;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.io.Reader;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The LaunchBox Games Database on the device (0.3.3; the Windows build's main/covers.js + lbindex.js, cut down to box art).
 * Metadata.zip (~110 MB) comes down natively, over four ranged connections when the server allows them, and a broken
 * download picks up where it stopped (Metadata.zip.parts says how far each range got). Its Metadata.xml (~500 MB) is
 * streamed straight out of the zip, never unpacked to disk, and only the consoles asked for are kept: one small file per
 * console in the app's own storage, lb-<platform>.json = { v, plat, games: [[id, name, year]], images: [[id, type,
 * region, file]] } (the page groups the pictures by game), plus lb-meta.json = { v, at, plats, counts }. The zip is
 * deleted when the index is written. Run on a background-priority thread; progress through the Progress callback.
 */
final class LaunchBoxIndex {
    interface Progress { void on(String phase, int pct, long got, long total); }

    static final int VERSION = 1;
    static final String ZIP_URL = "https://gamesdb.launchbox-app.com/Metadata.zip";
    private static final int PARTS = 4;
    // the picture types the Art Studio and the box art fetch use (the Windows index keeps screenshots too; not needed here)
    private static final Pattern TYPES = Pattern.compile("^(Box - (Front|Back)( - Reconstructed)?|Box - (Spine|Full)|Disc|Cart - Front|Fanart - (Box - (Front|Back)|Cart - Front|Disc)|Steam Poster)$");

    private volatile boolean cancel;
    private long lastNote = 0;

    // the connections open right now: Stop closes them, so a download blocked in a read ends at once (not after its timeout)
    private final Set<HttpURLConnection> conns = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());

    void cancel() { cancel = true; for (HttpURLConnection c : conns) try { c.disconnect(); } catch (Exception ignored) {} }
    boolean cancelled() { return cancel; }

    private void check() throws IOException { if (cancel) throw new IOException("cancelled"); }

    /** Downloads (or resumes) Metadata.zip, then writes the per-console files → { ok, at, plats, counts, bytes }. */
    JSObject run(File filesDir, File workDir, Set<String> plats, String ua, Progress p) throws Exception {
        if (!workDir.isDirectory() && !workDir.mkdirs()) throw new IOException("No room for the LaunchBox download");
        File zip = new File(workDir, "Metadata.zip"), state = new File(workDir, "Metadata.zip.parts");
        download(zip, ua, p);
        check();
        // the download is kept (its .parts file says it's complete) until the index is written: a sort stopped half way, or
        // the app closed meanwhile, never means the 110 MB again. A zip that turns out broken is never used again
        JSObject r;
        try { r = index(zip, filesDir, plats, p); }
        catch (java.util.zip.ZipException | java.io.EOFException bad) { zip.delete(); state.delete(); throw bad; }
        if (!zip.delete()) zip.deleteOnExit();
        if (!state.delete()) state.deleteOnExit();
        return r;
    }

    // ---------- the download ----------
    private HttpURLConnection open(String url, String ua, String range) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(45000);
        c.setRequestProperty("User-Agent", ua);
        if (range != null) c.setRequestProperty("Range", range);
        conns.add(c);
        return c; // (redirects to the same scheme are followed by HttpURLConnection itself)
    }
    private void close(HttpURLConnection c) { if (c == null) return; conns.remove(c); c.disconnect(); }

    private void note(Progress p, String phase, int pct, long got, long total, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastNote < 250) return;
        lastNote = now;
        try { p.on(phase, pct, got, total); } catch (Throwable ignored) {}
    }

    private void download(File zip, String ua, Progress p) throws Exception {
        File state = new File(zip.getPath() + ".parts");
        long total = -1; boolean ranges = false;
        HttpURLConnection h = open(ZIP_URL, ua, "bytes=0-0"); // a one-byte range: says the size and whether ranges work
        try {
            int code = h.getResponseCode();
            if (code == 206) {
                ranges = true;
                String cr = h.getHeaderField("Content-Range"); // "bytes 0-0/115343360"
                int slash = cr == null ? -1 : cr.lastIndexOf('/');
                if (slash >= 0) try { total = Long.parseLong(cr.substring(slash + 1).trim()); } catch (NumberFormatException ignored) {}
            } else if (code == 200) total = h.getContentLengthLong();
            else throw new IOException("LaunchBox answered " + code);
        } finally { close(h); }
        if (!ranges || total <= 0) { single(zip, ua, total, p); return; }

        long[] start = new long[PARTS], end = new long[PARTS], done = new long[PARTS];
        boolean resumed = false;
        // a download cut short (or finished but not sorted yet): its ranges and how far each got. Older than a week: LaunchBox
        // may have put out a new file of the same size meanwhile, so it starts over
        if (state.isFile() && zip.isFile() && zip.length() == total && System.currentTimeMillis() - state.lastModified() < 7L * 86400000L) {
            try {
                String[] lines = readSmall(state).split("\n");
                if (lines.length == PARTS + 1 && Long.parseLong(lines[0].trim()) == total) {
                    for (int i = 0; i < PARTS; i++) { String[] f = lines[i + 1].trim().split(" "); start[i] = Long.parseLong(f[0]); end[i] = Long.parseLong(f[1]); done[i] = Long.parseLong(f[2]); }
                    resumed = true;
                }
            } catch (Exception ignored) { resumed = false; }
        }
        if (!resumed) {
            long step = total / PARTS;
            for (int i = 0; i < PARTS; i++) { start[i] = i * step; end[i] = i == PARTS - 1 ? total - 1 : (i + 1) * step - 1; done[i] = 0; }
            try (RandomAccessFile raf = new RandomAccessFile(zip, "rw")) { raf.setLength(total); }
            saveState(state, total, start, end, done);
        }
        final long tot = total;
        final AtomicLong got = new AtomicLong(0);
        for (int i = 0; i < PARTS; i++) got.addAndGet(done[i]);
        final Throwable[] err = new Throwable[1];
        final Object lock = new Object();
        Thread[] th = new Thread[PARTS];
        for (int i = 0; i < PARTS; i++) {
            final int k = i;
            th[i] = new Thread(() -> {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
                for (int attempt = 0; attempt < 4 && start[k] + done[k] <= end[k] && !cancel; attempt++) {
                    final long before = done[k]; // (only this thread writes its part)
                    HttpURLConnection c = null;
                    try (RandomAccessFile raf = new RandomAccessFile(zip, "rw")) {
                        c = open(ZIP_URL, ua, "bytes=" + (start[k] + done[k]) + "-" + end[k]);
                        if (c.getResponseCode() != 206) throw new IOException("no range answer (" + c.getResponseCode() + ")");
                        String cr = c.getHeaderField("Content-Range"); // the server must start where it was asked to, or the file is corrupted
                        if (cr == null || !cr.trim().startsWith("bytes " + (start[k] + done[k]) + "-")) throw new IOException("unexpected range answer");
                        raf.seek(start[k] + done[k]);
                        byte[] buf = new byte[1 << 16]; long sinceSave = 0; int n;
                        try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16)) {
                            while (!cancel && (n = in.read(buf)) > 0) {
                                long room = end[k] - (start[k] + done[k]) + 1; if (n > room) n = (int) room;
                                raf.write(buf, 0, n);
                                synchronized (lock) { done[k] += n; }
                                long all = got.addAndGet(n); sinceSave += n;
                                if (sinceSave > (2 << 20)) { sinceSave = 0; synchronized (lock) { saveState(state, tot, start, end, done); } }
                                note(p, "download", (int) (all * 100 / tot), all, tot, false);
                                if (start[k] + done[k] > end[k]) break;
                            }
                        }
                        synchronized (lock) { saveState(state, tot, start, end, done); }
                    } catch (Throwable t) {
                        synchronized (lock) { try { saveState(state, tot, start, end, done); } catch (Throwable ignored) {} }
                        if (attempt == 3) synchronized (lock) { if (err[0] == null) err[0] = t; }
                        if (!cancel) try { Thread.sleep(1500L * (attempt + 1)); } catch (InterruptedException ignored) {}
                    } finally { close(c); }
                    if (done[k] > before) attempt = -1; // it got somewhere before the drop: a weak connection never runs out of tries while it's making progress
                }
            }, "boxshelf-lb-" + i);
            th[i].start();
        }
        for (Thread t : th) t.join();
        check();
        for (int i = 0; i < PARTS; i++) if (start[i] + done[i] <= end[i]) throw new IOException("The download stopped" + (err[0] != null ? ": " + err[0].getMessage() : "") + ". It picks up from there next time.");
        note(p, "download", 100, tot, tot, true);
        synchronized (lock) { saveState(state, tot, start, end, done); } // (complete: kept until the index is written, see run)
    }

    // a server that won't do ranges: one stream, from the start
    private void single(File zip, String ua, long total, Progress p) throws Exception {
        HttpURLConnection c = open(ZIP_URL, ua, null);
        try {
            if (c.getResponseCode() != 200) throw new IOException("LaunchBox answered " + c.getResponseCode());
            long len = total > 0 ? total : c.getContentLengthLong(), got = 0;
            byte[] buf = new byte[1 << 16]; int n;
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16); FileOutputStream out = new FileOutputStream(zip)) {
                while ((n = in.read(buf)) > 0) { check(); out.write(buf, 0, n); got += n; note(p, "download", len > 0 ? (int) (got * 100 / len) : 0, got, len, false); }
            }
        } finally { close(c); }
    }

    private static void saveState(File f, long total, long[] s, long[] e, long[] d) throws IOException {
        StringBuilder b = new StringBuilder().append(total).append('\n');
        for (int i = 0; i < s.length; i++) b.append(s[i]).append(' ').append(e[i]).append(' ').append(d[i]).append('\n');
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(b.toString().getBytes(StandardCharsets.UTF_8)); }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("state"); }
    }

    private static String readSmall(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) { byte[] b = new byte[(int) Math.min(f.length(), 4096)]; int n = in.read(b); return new String(b, 0, Math.max(0, n), StandardCharsets.UTF_8); }
    }

    // ---------- the index ----------
    private static final class Counting extends FilterInputStream {
        long n = 0;
        Counting(InputStream in) { super(in); }
        @Override public int read() throws IOException { int b = super.read(); if (b >= 0) n++; return b; }
        @Override public int read(byte[] b, int off, int len) throws IOException { int r = super.read(b, off, len); if (r > 0) n += r; return r; }
        @Override public long skip(long k) throws IOException { long r = super.skip(k); if (r > 0) n += r; return r; }
    }

    private static String tag(String block, String name) {
        String open = "<" + name + ">", close = "</" + name + ">";
        int a = block.indexOf(open); if (a < 0) return "";
        int b = block.indexOf(close, a + open.length()); if (b < 0) return "";
        String v = block.substring(a + open.length(), b);
        if (v.indexOf('&') >= 0) v = v.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
        return v.trim();
    }

    static String safe(String plat) { return plat.replaceAll("[^A-Za-z0-9]+", "_"); }

    // does sb hold s at i? (StringBuilder has no startsWith)
    private static boolean at(StringBuilder sb, int i, String s) {
        if (i + s.length() > sb.length()) return false;
        for (int k = 0; k < s.length(); k++) if (sb.charAt(i + k) != s.charAt(k)) return false;
        return true;
    }

    // one console's games and pictures, written to two scratch files as they're found (the index never sits in memory:
    // a big library's pictures run to tens of MB), joined into its lb-<platform>.json at the end
    private static final class Out {
        final File gf, imf; final Writer g, im; boolean g1 = true, i1 = true; int count = 0;
        Out(File dir, String pl) throws IOException {
            gf = new File(dir, "lb-" + safe(pl) + ".games.tmp"); imf = new File(dir, "lb-" + safe(pl) + ".images.tmp");
            g = new java.io.BufferedWriter(new OutputStreamWriter(new FileOutputStream(gf), StandardCharsets.UTF_8), 1 << 16);
            im = new java.io.BufferedWriter(new OutputStreamWriter(new FileOutputStream(imf), StandardCharsets.UTF_8), 1 << 16);
        }
        void close() { try { g.close(); } catch (IOException ignored) {} try { im.close(); } catch (IOException ignored) {} }
        void drop() { close(); gf.delete(); imf.delete(); }
    }

    private static void copy(File from, Writer to) throws IOException {
        try (Reader r = new InputStreamReader(new FileInputStream(from), StandardCharsets.UTF_8)) { char[] b = new char[1 << 16]; int n; while ((n = r.read(b)) > 0) to.write(b, 0, n); }
    }

    private JSObject index(File zip, File out, Set<String> plats, Progress p) throws Exception {
        final long zipLen = Math.max(1, zip.length());
        File work = zip.getParentFile();
        Map<String, Out> outs = new LinkedHashMap<>();
        Map<String, String> platOf = new HashMap<>(); // a kept game's id → its console
        try {
            for (String pl : plats) outs.put(pl, new Out(work, pl));
            return index0(zip, zipLen, out, outs, platOf, p);
        } finally { for (Out o : outs.values()) o.drop(); }
    }

    private JSObject index0(File zip, long zipLen, File out, Map<String, Out> outs, Map<String, String> platOf, Progress p) throws Exception {
        Counting cnt = new Counting(new BufferedInputStream(new FileInputStream(zip), 1 << 16));
        try (ZipInputStream z = new ZipInputStream(cnt)) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null && !"Metadata.xml".equalsIgnoreCase(new File(e.getName()).getName())) check();
            if (e == null) throw new IOException("No Metadata.xml in the LaunchBox download");
            Reader r = new InputStreamReader(z, StandardCharsets.UTF_8);
            char[] buf = new char[1 << 20];
            StringBuilder sb = new StringBuilder(1 << 21);
            int n;
            while ((n = r.read(buf)) > 0) {
                check();
                sb.append(buf, 0, n);
                int pos = 0;
                for (;;) {
                    int i = sb.indexOf("<Game", pos);
                    if (i < 0) { pos = Math.max(pos, sb.length() - 16); break; }
                    if (sb.length() - i < 12) { pos = i; break; }
                    String close;
                    if (at(sb, i, "<Game>")) close = "</Game>";
                    else if (at(sb, i, "<GameImage>")) close = "</GameImage>";
                    else { pos = i + 5; continue; }
                    int end = sb.indexOf(close, i);
                    if (end < 0) { pos = i; break; }
                    String block = sb.substring(i, end);
                    pos = end + close.length();
                    if (close.length() == 7) { // </Game>
                        String pl = tag(block, "Platform");
                        Out o = outs.get(pl); if (o == null) continue;
                        String id = tag(block, "DatabaseID"), name = tag(block, "Name");
                        if (id.isEmpty() || name.isEmpty()) continue;
                        platOf.put(id, pl);
                        if (!o.g1) o.g.write(','); o.g1 = false;
                        o.g.write("[" + JSONObject.quote(id) + "," + JSONObject.quote(name) + "," + JSONObject.quote(tag(block, "ReleaseYear")) + "]");
                        o.count++;
                    } else {
                        String id = tag(block, "DatabaseID"), pl = platOf.get(id);
                        if (pl == null) continue;
                        String type = tag(block, "Type");
                        if (!TYPES.matcher(type).matches()) continue;
                        String file = tag(block, "FileName"); if (file.isEmpty()) continue;
                        Out o = outs.get(pl);
                        if (!o.i1) o.im.write(','); o.i1 = false;
                        o.im.write("[" + JSONObject.quote(id) + "," + JSONObject.quote(type) + "," + JSONObject.quote(tag(block, "Region")) + "," + JSONObject.quote(file) + "]");
                    }
                }
                sb.delete(0, pos);
                note(p, "read", (int) Math.min(99, cnt.n * 100 / zipLen), cnt.n, zipLen, false);
            }
        }
        check();
        note(p, "split", 100, zipLen, zipLen, true);
        long stamp = System.currentTimeMillis(), bytes = 0;
        JSArray done = new JSArray(); JSObject cn = new JSObject();
        for (Map.Entry<String, Out> en : outs.entrySet()) {
            String pl = en.getKey(); Out o = en.getValue(); o.close();
            File f = new File(out, "lb-" + safe(pl) + ".json"), tmp = new File(f.getPath() + ".tmp");
            try (Writer w = new java.io.BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 1 << 16)) {
                w.write("{\"v\":" + VERSION + ",\"plat\":" + JSONObject.quote(pl) + ",\"games\":[");
                copy(o.gf, w);
                w.write("],\"images\":[");
                copy(o.imf, w);
                w.write("]}");
            }
            if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("Couldn't save " + f.getName()); }
            bytes += f.length(); done.put(pl); cn.put(pl, o.count);
        }
        JSObject meta = new JSObject(); meta.put("v", VERSION); meta.put("at", stamp); meta.put("plats", done); meta.put("counts", cn); meta.put("bytes", bytes);
        File mf = new File(out, "lb-meta.json"), mt = new File(mf.getPath() + ".tmp");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(mt), StandardCharsets.UTF_8)) { w.write(meta.toString()); }
        if (!mt.renameTo(mf)) { mf.delete(); if (!mt.renameTo(mf)) throw new IOException("Couldn't save lb-meta.json"); }
        JSObject r = new JSObject(); r.put("ok", true); r.put("at", stamp); r.put("plats", done); r.put("counts", cn); r.put("bytes", bytes);
        return r;
    }
}
