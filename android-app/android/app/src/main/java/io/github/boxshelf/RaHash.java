package io.github.boxshelf;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import org.json.JSONArray;

import java.io.BufferedInputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * RetroAchievements' own game hash (rcheevos' rc_hash rules) for the cartridge consoles where it is cheap: the file is
 * read here, on a background thread, and only the 32-character answer goes back to the page (a game never crosses the
 * bridge). Disc consoles are matched by title instead (their hashes read parts of multi-GB images).
 *   plain  MD5 of the file (Game Boy / Color / Advance, Master System, Game Gear, Mega Drive)
 *   nes    a 16-byte iNES / FDS header ("NES\x1a" / "FDS\x1a") is left out
 *   snes   a 512-byte copier header (size % 8 KB == 512) is left out
 *   pce    a 512-byte header (size % 128 KB == 512) is left out (HuCards only)
 *   n64    byte-swapped (.v64) and little-endian (.n64) images are hashed as big-endian (.z64)
 *   nds    header (0x160 bytes) + ARM9 code + ARM7 code + icon (0xA00 bytes); a SuperCard header is skipped
 *   name   MD5 of the file name without its extension (arcade sets)
 * A .zip is opened as RetroArch does: the first file in it with one of the console's extensions is hashed. At most the
 * first 64 MB are hashed (rcheevos' own limit). Anything that can't be read answers null (the page falls back to titles).
 */
final class RaHash {
    private static final long MAX = 64L * 1024 * 1024;
    private RaHash() {}

    static String of(ContentResolver cr, String uri, String kind, String name, JSONArray extList) throws IOException {
        if ("name".equals(kind)) return ofName(name);
        if (uri == null || uri.isEmpty()) return null;
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".7z")) return null; // (not opened here)
        if (lower.endsWith(".zip")) {
            if ("nds".equals(kind)) return null; // (needs seeking: only a plain .nds file)
            Set<String> exts = new HashSet<>();
            if (extList != null) for (int i = 0; i < extList.length(); i++) exts.add(extList.optString(i, "").toLowerCase(Locale.ROOT));
            exts.remove("zip"); exts.remove("7z"); exts.remove("");
            InputStream raw = cr.openInputStream(Uri.parse(uri));
            if (raw == null) return null;
            try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(raw, 65536))) { // (closing it closes the file too)
                ZipEntry e;
                while ((e = zin.getNextEntry()) != null) {
                    if (e.isDirectory()) continue;
                    String en = e.getName().toLowerCase(Locale.ROOT); int dot = en.lastIndexOf('.');
                    if (!exts.isEmpty() && (dot < 0 || !exts.contains(en.substring(dot + 1)))) continue;
                    return ofStream(zin, kind);
                }
                return null;
            }
        }
        if ("nds".equals(kind)) return ofNds(cr, uri);
        try (InputStream in = cr.openInputStream(Uri.parse(uri))) {
            if (in == null) return null;
            return ofStream(new BufferedInputStream(in, 65536), kind);
        }
    }

    static String ofName(String name) {
        if (name == null) return null;
        String n = name; int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        int dot = n.lastIndexOf('.'); if (dot > 0) n = n.substring(0, dot);
        if (n.isEmpty()) return null;
        MessageDigest md = md5(); md.update(n.getBytes(StandardCharsets.UTF_8));
        return hex(md.digest());
    }

    // one pass over the stream: "whole" hashes everything after a magic-chosen header; "cut" everything after the first
    // 512 bytes (picked at the end, by size, for snes / pce)
    private static String ofStream(InputStream in, String kind) throws IOException {
        byte[] head = new byte[16]; int hn = 0, n;
        while (hn < head.length && (n = in.read(head, hn, head.length - hn)) > 0) hn += n;
        if (hn == 0) return null;
        int skip = 0, swap = 0;
        if ("nes".equals(kind) && hn >= 4 && head[3] == 0x1A && ((head[0] == 'N' && head[1] == 'E' && head[2] == 'S') || (head[0] == 'F' && head[1] == 'D' && head[2] == 'S'))) skip = 16;
        if ("n64".equals(kind)) {
            int b0 = head[0] & 0xFF;
            if (b0 == 0x37) swap = 2; else if (b0 == 0x40) swap = 4; else if (b0 != 0x80 && b0 != 0xE8 && b0 != 0x22) return null; // (not an N64 image)
        }
        final boolean twoWays = "snes".equals(kind) || "pce".equals(kind);
        MessageDigest whole = md5(), cut = twoWays ? md5() : null;
        Feeder f = new Feeder(whole, cut, skip, swap);
        long total = 0;
        int first = (int) Math.min(hn, MAX);
        f.feed(head, 0, first); total += first;
        byte[] buf = new byte[65536];
        while (total < MAX && (n = in.read(buf, 0, (int) Math.min(buf.length, MAX - total))) > 0) { f.feed(buf, 0, n); total += n; }
        f.finish();
        if (total <= skip) return null;
        if (twoWays) {
            long unit = "snes".equals(kind) ? 0x2000 : 0x20000;
            if (total % unit == 512 && total > 512) return hex(cut.digest());
        }
        return hex(whole.digest());
    }

    // feeds the digests, leaving out the header and byte-swapping (N64) on the way; swapping keeps up to 3 bytes over
    private static final class Feeder {
        final MessageDigest whole, cut; final int skip, swap; long pos = 0; final byte[] carry = new byte[4]; int cn = 0;
        Feeder(MessageDigest whole, MessageDigest cut, int skip, int swap) { this.whole = whole; this.cut = cut; this.skip = skip; this.swap = swap; }
        void feed(byte[] b, int off, int len) {
            if (cut != null) { // bytes from 512 on
                long from = Math.max(pos, 512); long end = pos + len;
                if (end > from) cut.update(b, off + (int) (from - pos), (int) (end - from));
            }
            int o = off, l = len;
            if (pos < skip) { int drop = (int) Math.min(l, skip - pos); o += drop; l -= drop; }
            pos += len;
            if (l <= 0) return;
            if (swap == 0) { whole.update(b, o, l); return; }
            byte[] t = new byte[cn + l]; System.arraycopy(carry, 0, t, 0, cn); System.arraycopy(b, o, t, cn, l);
            int usable = t.length - (t.length % swap);
            for (int i = 0; i < usable; i += swap) {
                if (swap == 2) { byte x = t[i]; t[i] = t[i + 1]; t[i + 1] = x; }
                else { byte x = t[i]; t[i] = t[i + 3]; t[i + 3] = x; x = t[i + 1]; t[i + 1] = t[i + 2]; t[i + 2] = x; }
            }
            whole.update(t, 0, usable);
            cn = t.length - usable; System.arraycopy(t, usable, carry, 0, cn);
        }
        void finish() { if (cn > 0) { whole.update(carry, 0, cn); cn = 0; } }
    }

    // Nintendo DS: the parts rcheevos hashes, read by seeking in the file (a few MB at most, never the whole game)
    private static String ofNds(ContentResolver cr, String uri) throws IOException {
        try (ParcelFileDescriptor pfd = cr.openFileDescriptor(Uri.parse(uri), "r")) {
            if (pfd == null) return null;
            try (FileInputStream fis = new FileInputStream(pfd.getFileDescriptor())) {
                FileChannel ch = fis.getChannel();
                long size = ch.size(), offset = 0;
                byte[] h = readAt(ch, 0, 512);
                if (h == null) return null;
                if ((h[0] & 0xFF) == 0x2E && h[1] == 0 && h[2] == 0 && (h[3] & 0xFF) == 0xEA && (h[0xB0] & 0xFF) == 0x44 && (h[0xB1] & 0xFF) == 0x46 && (h[0xB2] & 0xFF) == 0x96 && h[0xB3] == 0) {
                    offset = 512; h = readAt(ch, offset, 512); if (h == null) return null; // a SuperCard header
                }
                long arm9Addr = u32(h, 0x20), arm9Size = u32(h, 0x2C), arm7Addr = u32(h, 0x30), arm7Size = u32(h, 0x3C), iconAddr = u32(h, 0x68);
                if (arm9Size + arm7Size > 16L * 1024 * 1024) return null; // (not a DS game: rcheevos refuses it too)
                if (offset + arm9Addr + arm9Size > size || offset + arm7Addr + arm7Size > size) return null;
                MessageDigest md = md5();
                md.update(h, 0, 0x160);
                byte[] a9 = readAt(ch, offset + arm9Addr, (int) arm9Size); if (a9 == null) return null; md.update(a9);
                byte[] a7 = readAt(ch, offset + arm7Addr, (int) arm7Size); if (a7 == null) return null; md.update(a7);
                // the icon: 0xA00 bytes (zeros where the file ends early, as rcheevos' buffer is)
                byte[] icon = new byte[0xA00];
                byte[] got = readAtMost(ch, offset + iconAddr, 0xA00);
                System.arraycopy(got, 0, icon, 0, got.length);
                md.update(icon);
                return hex(md.digest());
            }
        }
    }

    private static long u32(byte[] b, int at) { return (b[at] & 0xFFL) | ((b[at + 1] & 0xFFL) << 8) | ((b[at + 2] & 0xFFL) << 16) | ((b[at + 3] & 0xFFL) << 24); }

    private static byte[] readAt(FileChannel ch, long at, int len) throws IOException {
        byte[] b = readAtMost(ch, at, len);
        return b.length == len ? b : null;
    }

    private static byte[] readAtMost(FileChannel ch, long at, int len) throws IOException {
        if (len <= 0) return new byte[0];
        ByteBuffer bb = ByteBuffer.allocate(len); long p = at;
        while (bb.hasRemaining()) { int n = ch.read(bb, p); if (n <= 0) break; p += n; }
        byte[] out = new byte[bb.position()]; bb.flip(); bb.get(out);
        return out;
    }

    private static MessageDigest md5() {
        try { return MessageDigest.getInstance("MD5"); } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    private static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte x : d) sb.append(String.format(Locale.ROOT, "%02x", x & 0xFF));
        return sb.toString();
    }
}
