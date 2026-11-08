// Boxshelf's Wii remote reader (Windows). A remote paired to a Mayflash DolphinBar in its Dolphin mode (mode 4) shows up as
// HID devices 057E:0306, one per player slot, and speaks the remote's own protocol, so the bar never has to change mode:
// Boxshelf reads the remote on the shelf and lets go of it (PAUSE) before Dolphin starts a game.
//   - finds the slot with a remote (status request 0x15 → 0x20), lights player 1, turns the IR camera on and asks for
//     buttons + accelerometer + IR (report 0x33, continuous)
//   - pointer: the bar's two IR lights, their midpoint rotated back by the pair's angle (a tilted remote still points
//     straight), as 0..1 of the camera's view (x flipped); one light seen: the other is guessed from the last pair
//   - prints "S <buttons> <x> <y> <seen>" (at most ~120 a second, only on change), "C 1" / "C 0" (remote connected /
//     gone), "P 1" / "P 0" (paused / reading); reads PAUSE, RESUME, RUMBLE <ms> and QUIT on stdin
// Compiled once by Windows PowerShell's Add-Type (C# 5) and cached as a DLL beside Boxshelf's data.
using System; using System.IO; using System.Threading; using System.Collections.Generic; using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class WMH {
  [StructLayout(LayoutKind.Sequential)] struct SPDID { public int cbSize; public Guid g; public int f; public IntPtr r; }
  [StructLayout(LayoutKind.Sequential)] struct CAPS { public ushort Usage, UsagePage, InLen, OutLen, FeatLen; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] r; public ushort a, b, c, d, e, f, g, h, i, j; }
  [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
  [DllImport("hid.dll")] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr p);
  [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr p);
  [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr p, out CAPS c);
  [DllImport("hid.dll")] static extern bool HidD_SetOutputReport(SafeFileHandle h, byte[] b, int n);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr w, int f);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr d, ref Guid g, int i, ref SPDID o);
  [DllImport("setupapi.dll", CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref SPDID d, IntPtr o, int n, out int req, IntPtr di);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);

  class Dev { public SafeFileHandle h; public FileStream fs; public int inLen, outLen; public bool useSet; public IAsyncResult pending; public byte[] buf; public string path; }
  static string livePath = null; // the slot the remote was last on (watched during Dolphin's games)

  static readonly object outLock = new object();
  static void Say(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
  static volatile bool paused = false, quit = false, watching = false; static volatile int rumbleMs = 0;

  // the DolphinBar's slots (a remote paired straight over Bluetooth shows the same ids: 0306, or 0330 for the RVL-CNT-01-TR)
  static List<string> Paths() {
    Guid g; HidD_GetHidGuid(out g); var list = new List<string>();
    IntPtr s = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12);
    for (int i = 0; ; i++) {
      SPDID d = new SPDID(); d.cbSize = Marshal.SizeOf(d); if (!SetupDiEnumDeviceInterfaces(s, IntPtr.Zero, ref g, i, ref d)) break;
      int req; SetupDiGetDeviceInterfaceDetail(s, ref d, IntPtr.Zero, 0, out req, IntPtr.Zero);
      IntPtr buf = Marshal.AllocHGlobal(req); Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
      if (SetupDiGetDeviceInterfaceDetail(s, ref d, buf, req, out req, IntPtr.Zero)) {
        string p = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4)), l = p.ToLower();
        if (l.Contains("vid_057e&pid_0306") || l.Contains("vid_057e&pid_0330")) list.Add(p);
      }
      Marshal.FreeHGlobal(buf);
    }
    SetupDiDestroyDeviceInfoList(s); return list;
  }
  static Dev Open(string p) {
    var h = CreateFile(p, 0xC0000000, 3, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero); if (h.IsInvalid) return null;
    IntPtr pp; if (!HidD_GetPreparsedData(h, out pp)) { h.Dispose(); return null; }
    CAPS c; HidP_GetCaps(pp, out c); HidD_FreePreparsedData(pp);
    if (c.InLen < 22 || c.OutLen < 2) { h.Dispose(); return null; }
    var d = new Dev(); d.h = h; d.inLen = c.InLen; d.outLen = c.OutLen; d.path = p;
    try { d.fs = new FileStream(h, FileAccess.ReadWrite, Math.Max((int)c.InLen, 1), true); } catch { h.Dispose(); return null; }
    return d;
  }
  // read-only, sharing everything: listening alongside Dolphin, which owns the remote then (nothing is ever sent on it)
  static Dev OpenWatch(string p) {
    var h = CreateFile(p, 0x80000000, 3, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero); if (h.IsInvalid) return null;
    IntPtr pp; if (!HidD_GetPreparsedData(h, out pp)) { h.Dispose(); return null; }
    CAPS c; HidP_GetCaps(pp, out c); HidD_FreePreparsedData(pp);
    var d = new Dev(); d.h = h; d.inLen = c.InLen; d.outLen = 0; d.path = p;
    try { d.fs = new FileStream(h, FileAccess.Read, Math.Max((int)c.InLen, 1), true); } catch { h.Dispose(); return null; }
    return d;
  }
  static void Close(Dev d) { if (d == null) return; try { d.fs.Dispose(); } catch { } try { d.h.Dispose(); } catch { } }
  static bool rumbleOn = false;
  static bool Send(Dev d, params byte[] data) {
    byte[] b = new byte[Math.Max(d.outLen, data.Length)]; Array.Copy(data, b, data.Length);
    if (rumbleOn && b.Length > 1) b[1] |= 0x01; // (every output report carries the rumble bit)
    if (!d.useSet) { try { d.fs.Write(b, 0, b.Length); return true; } catch { d.useSet = true; } }
    try { return HidD_SetOutputReport(d.h, b, b.Length); } catch { return false; }
  }
  // one read kept pending per device; null = nothing within ms (a timed-out read stays outstanding for next time)
  static byte[] Read(Dev d, int ms) {
    try {
      if (d.pending == null) { d.buf = new byte[d.inLen]; d.pending = d.fs.BeginRead(d.buf, 0, d.buf.Length, null, null); }
      if (!d.pending.AsyncWaitHandle.WaitOne(ms)) return null;
      int n = d.fs.EndRead(d.pending); d.pending = null; return n > 0 ? d.buf : null;
    } catch { d.pending = null; throw; }
  }
  static void WriteReg(Dev d, int addr, params byte[] data) {
    byte[] r = new byte[22]; r[0] = 0x16; r[1] = 0x04; r[2] = (byte)(addr >> 16); r[3] = (byte)(addr >> 8); r[4] = (byte)addr; r[5] = (byte)data.Length; Array.Copy(data, 0, r, 6, data.Length);
    Send(d, r); var t = DateTime.Now; while ((DateTime.Now - t).TotalMilliseconds < 250) { var a = Read(d, 60); if (a != null && a[0] == 0x22 && a[3] == 0x16) break; }
  }
  static void Setup(Dev d) {
    Send(d, 0x11, 0x10); // player 1 light
    Send(d, 0x13, 0x04); Thread.Sleep(30); Send(d, 0x1a, 0x04); Thread.Sleep(30); // IR camera clock and logic on
    WriteReg(d, 0xb00030, 0x08);
    WriteReg(d, 0xb00000, 0x02, 0x00, 0x00, 0x71, 0x01, 0x00, 0xaa, 0x00, 0x64); // sensitivity (the Wii's level 3)
    WriteReg(d, 0xb0001a, 0x63, 0x03);
    WriteReg(d, 0xb00033, 0x03); // extended mode: 3 bytes a light
    WriteReg(d, 0xb00030, 0x08);
    Send(d, 0x12, 0x04, 0x33); // continuous: buttons + accelerometer + IR
  }
  // put the remote back as a game would find a freshly connected one: plain buttons, camera off, light off
  static void Release(Dev d) { if (d == null) return; try { rumbleOn = false; Send(d, 0x12, 0x00, 0x30); Send(d, 0x13, 0x00); Send(d, 0x1a, 0x00); Send(d, 0x11, 0x00); } catch { } }

  static Dev Find() {
    var devs = new List<Dev>(); foreach (var p in Paths()) { var d = Open(p); if (d != null) devs.Add(d); }
    Dev live = null;
    try {
      foreach (var d in devs) try { Send(d, 0x15, 0x00); } catch { }
      var until = DateTime.Now.AddMilliseconds(500);
      while (live == null && DateTime.Now < until && !paused && !quit)
        foreach (var d in devs) { byte[] r = null; try { r = Read(d, 30); } catch { } if (r != null && (r[0] == 0x20 || r[0] == 0x30 || r[0] == 0x33)) { live = d; break; } }
    } finally { foreach (var d in devs) if (d != live) Close(d); }
    if (live != null) livePath = live.path;
    return live;
  }

  // pointer state: the last pair of lights (to guess a missing one) and the last midpoint
  static double lastSepX = 0, lastSepY = 0, lastMx = 512, lastMy = 384; static bool havePair = false;
  static bool Pointer(byte[] r, out double nx, out double ny) {
    nx = ny = 0; var xs = new List<int>(); var ys = new List<int>();
    for (int i = 0; i < 4; i++) { int o = 6 + i * 3; if (r[o] == 0xff && r[o + 1] == 0xff && r[o + 2] == 0xff) continue; xs.Add(r[o] | ((r[o + 2] & 0x30) << 4)); ys.Add(r[o + 1] | ((r[o + 2] & 0xc0) << 2)); }
    double mx, my, ang;
    if (xs.Count >= 2) {
      // the pair furthest apart (the bar's two ends; a reflection makes a third dot now and then)
      int a = 0, b = 1; double best = -1;
      for (int i = 0; i < xs.Count; i++) for (int j = i + 1; j < xs.Count; j++) { double dd = Math.Pow(xs[i] - xs[j], 2) + Math.Pow(ys[i] - ys[j], 2); if (dd > best) { best = dd; a = i; b = j; } }
      if (xs[a] > xs[b]) { int t = a; a = b; b = t; }
      lastSepX = xs[b] - xs[a]; lastSepY = ys[b] - ys[a]; havePair = true;
      mx = (xs[a] + xs[b]) / 2.0; my = (ys[a] + ys[b]) / 2.0;
    } else if (xs.Count == 1 && havePair) {
      // one light: the other is where it was last time, on whichever side keeps the midpoint closest to the last one
      double m1x = xs[0] + lastSepX / 2, m1y = ys[0] + lastSepY / 2, m2x = xs[0] - lastSepX / 2, m2y = ys[0] - lastSepY / 2;
      bool first = Math.Pow(m1x - lastMx, 2) + Math.Pow(m1y - lastMy, 2) <= Math.Pow(m2x - lastMx, 2) + Math.Pow(m2y - lastMy, 2);
      mx = first ? m1x : m2x; my = first ? m1y : m2y;
    } else return false;
    lastMx = mx; lastMy = my;
    ang = havePair ? Math.Atan2(lastSepY, lastSepX) : 0;
    // turn the midpoint back by the remote's roll, about the camera's centre
    double cx = mx - 512, cy = my - 384, ca = Math.Cos(-ang), sa = Math.Sin(-ang);
    double rx = cx * ca - cy * sa, ry = cx * sa + cy * ca;
    nx = 1 - (rx + 512) / 1024.0; ny = (ry + 384) / 768.0; // the camera sees the bar move the opposite way the remote turns
    return true;
  }

  public static void Run() {
    var stdin = new Thread(() => {
      try {
        string line; while (!quit && (line = Console.In.ReadLine()) != null) {
          line = line.Trim(); if (line == "PAUSE") paused = true; else if (line == "RESUME") { paused = false; watching = false; } else if (line == "QUIT") quit = true; else if (line == "WATCH") watching = true;
          else if (line.StartsWith("RUMBLE ")) { int ms; if (int.TryParse(line.Substring(7), out ms)) rumbleMs = Math.Max(0, Math.Min(500, ms)); }
        }
      } catch { }
      quit = true; // Boxshelf gone: stop
    }); stdin.IsBackground = true; stdin.Start();
    Say("READY");
    Dev live = null; bool wasPaused = false; var nextFind = DateTime.MinValue;
    int lastBtn = -1; double lastX = -1, lastY = -1; bool lastSeen = false; DateTime lastSay = DateTime.MinValue, lastReport = DateTime.Now, askedStatus = DateTime.MinValue;
    DateTime rumbleUntil = DateTime.MinValue, watchRetry = DateTime.MinValue; Dev watchDev = null; int watchBtn = -1;
    while (!quit) {
      if (paused) {
        if (!wasPaused) { Release(live); Close(live); live = null; wasPaused = true; lastBtn = -1; Say("C 0"); Say("P 1"); }
        // WATCH (a Dolphin game): the buttons from the game's own reports (every report but 0x3d carries them in bytes 1-2)
        if (watching && livePath != null) {
          if (watchDev == null) { if (DateTime.Now >= watchRetry) { watchDev = OpenWatch(livePath); watchBtn = -1; if (watchDev == null) watchRetry = DateTime.Now.AddSeconds(3); } else { Thread.Sleep(100); continue; } }
          if (watchDev != null) {
            try { var w = Read(watchDev, 100); if (w != null && w[0] >= 0x20 && w[0] != 0x3d) { int b = ((w[1] << 8) | w[2]) & 0x1F9F; if (b != watchBtn) { watchBtn = b; Say("H " + b); } } }
            catch { Close(watchDev); watchDev = null; watchRetry = DateTime.Now.AddSeconds(3); }
            continue;
          }
        } else if (watchDev != null) { Close(watchDev); watchDev = null; }
        Thread.Sleep(100); continue;
      }
      if (watchDev != null) { Close(watchDev); watchDev = null; }
      if (wasPaused) { wasPaused = false; Say("P 0"); nextFind = DateTime.MinValue; }
      if (live == null) {
        if (DateTime.Now < nextFind) { Thread.Sleep(50); continue; }
        try { live = Find(); } catch { live = null; }
        if (live == null) { nextFind = DateTime.Now.AddSeconds(2); continue; }
        try { Setup(live); } catch { Close(live); live = null; continue; }
        havePair = false; lastBtn = -1; lastReport = DateTime.Now; Say("C 1"); continue;
      }
      try {
        if (rumbleMs > 0) { int ms = rumbleMs; rumbleMs = 0; rumbleOn = true; Send(live, 0x10, 0x01); rumbleUntil = DateTime.Now.AddMilliseconds(ms); }
        if (rumbleOn && DateTime.Now >= rumbleUntil) { rumbleOn = false; Send(live, 0x10, 0x00); }
        var r = Read(live, 40);
        if (r == null) {
          // quiet: a remote that's switched off stops reporting; ask once, then give it up and look again
          if ((DateTime.Now - lastReport).TotalMilliseconds > 1500 && (DateTime.Now - askedStatus).TotalMilliseconds > 1500) { askedStatus = DateTime.Now; Send(live, 0x15, 0x00); }
          if ((DateTime.Now - lastReport).TotalMilliseconds > 4000) { Close(live); live = null; Say("C 0"); nextFind = DateTime.Now.AddSeconds(1); }
          continue;
        }
        lastReport = DateTime.Now;
        if (r[0] == 0x20) { Setup(live); continue; } // status (a reconnect, or an extension plugged in): the mode is reset, set it again
        if (r[0] != 0x33) continue;
        int btn = (r[1] << 8) | r[2]; btn &= 0x1F9F;
        double x, y; bool seen = Pointer(r, out x, out y);
        bool moved = seen && (Math.Abs(x - lastX) > 0.0008 || Math.Abs(y - lastY) > 0.0008);
        if (btn != lastBtn || seen != lastSeen || (moved && (DateTime.Now - lastSay).TotalMilliseconds >= 8)) {
          lastBtn = btn; lastSeen = seen; if (seen) { lastX = x; lastY = y; } lastSay = DateTime.Now;
          Say("S " + btn + " " + (seen ? x : lastX).ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture) + " " + (seen ? y : lastY).ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture) + " " + (seen ? 1 : 0));
        }
      } catch { Close(live); live = null; Say("C 0"); nextFind = DateTime.Now.AddSeconds(1); }
    }
    Release(live); Close(live);
  }
}
