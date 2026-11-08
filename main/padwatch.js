// The controller helper while a game or app runs (and for Home on the shelf). Boxshelf's own window is in the background
// then, and Chromium only delivers gamepad input to a focused page, so a small PowerShell helper reads the pads directly:
// XInput (Xbox pads, and anything presenting as XInput such as DS4Windows / Steam Input) plus Nintendo and PlayStation
// pads over HID.
// It prints QUIT when the quit combo (L3 + R3 by default) is held, HOME for Guide / a held View, the buttons while the
// Home menu is open, and over a media app turns the pad into a mouse pointer and keys. It also brings the game to the
// front, presses an app's fullscreen key, tells when the game went fullscreen, and sends the Home menu's hotkeys.
const { spawn } = require('child_process');

const SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
$xiSrc = @"
using System; using System.Runtime.InteropServices;
public class XI {
  [StructLayout(LayoutKind.Sequential)] public struct GP { public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; public uint reserved; }
  [StructLayout(LayoutKind.Sequential)] public struct ST { public uint dwPacketNumber; public GP Gamepad; }
  [DllImport("xinput1_4.dll", EntryPoint="XInputGetState")] public static extern uint Get14(uint i, ref ST s);
  [DllImport("xinput1_4.dll", EntryPoint="#100")] public static extern uint GetEx(uint i, ref ST s);
  [DllImport("xinput9_1_0.dll", EntryPoint="XInputGetState")] public static extern uint Get91(uint i, ref ST s);
  // the undocumented ordinal 100 also reports the Guide button (0x0400); fall back to the public call without it
  static bool noEx = false;
  public static uint Get(uint i, ref ST s) { if (i == 4) return Hid(ref s, false); if (i == 5) return Hid(ref s, true); if (!noEx) { try { return GetEx(i, ref s); } catch { noEx = true; } } try { return Get14(i, ref s); } catch { return Get91(i, ref s); } }
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static void Move(int dx, int dy) { mouse_event(0x0001, dx, dy, 0, UIntPtr.Zero); }
  public static void Click(bool down) { mouse_event(down ? 0x0002u : 0x0004u, 0, 0, 0, UIntPtr.Zero); }
  public static void Wheel(int d) { mouse_event(0x0800, 0, 0, d, UIntPtr.Zero); }
  public static void Key(byte vk, bool down) { keybd_event(vk, 0, down ? 0u : 2u, UIntPtr.Zero); }
  public static void Tap(byte vk) { Key(vk, true); Key(vk, false); }
  public static void Combo(byte mod, byte vk) { Key(mod, true); Key(vk, true); Key(vk, false); Key(mod, false); }
  // Wait ms while reading every pad every 4 ms; returns the buttons seen pressed at any moment in that time (-1: no pad).
  // The script's own loop is far slower than that, so a quick tap of Guide or A would otherwise fall between two reads.
  // Empty slots are expensive to query (XInput re-scans for a device each time), so a slot with no pad is only retried
  // every ~1.5 s (slots 4 and 5, the Nintendo and PlayStation pads below, are only a list lookup: every 250 ms).
  static long[] retryAt = new long[6]; static System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
  public static int[] Sample(int ms) { var acc = new int[] { -1, -1, -1, -1, -1, -1 }; var sw = System.Diagnostics.Stopwatch.StartNew();
    do { for (uint i = 0; i < 6; i++) { if (clock.ElapsedMilliseconds < retryAt[i]) continue; ST s = new ST();
        if (Get(i, ref s) == 0) acc[i] = (acc[i] < 0 ? 0 : acc[i]) | s.Gamepad.wButtons; else retryAt[i] = clock.ElapsedMilliseconds + (i >= 4 ? 250 : 1500); }
      System.Threading.Thread.Sleep(4); } while (sw.ElapsedMilliseconds < ms);
    return acc; }
  // Slot 4: Nintendo pads (Switch Pro, Joy-Con) read straight from HID. They don't speak XInput, so without this the
  // quit combo and Home only worked on Xbox-style pads. Every handle Windows opens on a HID device gets its own copy of
  // each input report, so this reads alongside the emulator (or Steam) without taking the pad away from it. Buttons map
  // by position like an Xbox pad (Nintendo B, the bottom one = 0x1000…), both stick clicks = L3/R3, Home = Guide,
  // + / − = Start / Back. All Nintendo pads are merged into the one slot, so L3 on a left Joy-Con + R3 on a right one counts.
  // Slot 5: PlayStation pads (DualSense, DualSense Edge, DualShock 4), the same way, over USB or Bluetooth: Cross = A,
  // Circle = B, Square = X, Triangle = Y, PS = Guide (the Home menu), Create / Share = Back, Options = Start.
  [StructLayout(LayoutKind.Sequential)] struct HIDA { public int Size; public ushort Vid; public ushort Pid; public ushort Ver; }
  [StructLayout(LayoutKind.Sequential)] struct DIDATA { public int cbSize; public Guid g; public int flags; public IntPtr reserved; }
  [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid g);
  [DllImport("hid.dll")] static extern bool HidD_GetAttributes(IntPtr h, ref HIDA a);
  [DllImport("setupapi.dll", EntryPoint="SetupDiGetClassDevsW", CharSet=CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr p, int f);
  [DllImport("setupapi.dll")] static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr d, ref Guid g, int i, ref DIDATA dd);
  [DllImport("setupapi.dll", EntryPoint="SetupDiGetDeviceInterfaceDetailW", CharSet=CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref DIDATA dd, IntPtr buf, int size, out int req, IntPtr di);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string n, uint acc, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] buf, int n, out int got, IntPtr ov);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  class NPad { public string path; public IntPtr h; public int pid; public bool ps, bt, seen, full; public int at; public int btn; public byte lt, rt; public short lx, ly, rx, ry; }
  static readonly object nLock = new object(); static System.Collections.Generic.List<NPad> nPads = new System.Collections.Generic.List<NPad>();
  static System.Threading.Thread nScan; static uint nPacket;
  // only while a game or app runs: on the shelf Chromium reads these pads itself (Home included), so the helper keeps out
  public static bool NinOn = false;
  static uint Hid(ref ST s, bool ps) { if (!NinOn) return 1167; // ps: slot 5's PlayStation pads, else slot 4's Nintendo ones
    if (nScan == null) { nScan = new System.Threading.Thread(NScanLoop); nScan.IsBackground = true; nScan.Start(); }
    lock (nLock) { bool any = false; int m = 0; byte lt = 0, rt = 0; short lx = 0, ly = 0, rx = 0, ry = 0;
      int now = Environment.TickCount;
      // full reports stream ~60+ times a second: none for 300 ms = signal lost (low battery, out of range), so nothing
      // stays held down. Simple reports only come on a change, so their last state stands, but not for ever: a pad that
      // went out of range with a button down kept it "held" until Windows dropped the link (a stray Home or Quit).
      foreach (NPad p in nPads) { if (p.ps != ps || !p.seen || (p.full && now - p.at > 300)) continue; any = true; if (!p.full && now - p.at > 3000) continue; m |= p.btn; if (p.lt > lt) lt = p.lt; if (p.rt > rt) rt = p.rt;
        if (lx == 0 && ly == 0) { lx = p.lx; ly = p.ly; } if (rx == 0 && ry == 0) { rx = p.rx; ry = p.ry; } }
      if (!any) return 1167; // ERROR_DEVICE_NOT_CONNECTED, as XInput says it
      s.dwPacketNumber = ++nPacket; s.Gamepad.wButtons = (ushort)m; s.Gamepad.bLeftTrigger = lt; s.Gamepad.bRightTrigger = rt;
      s.Gamepad.sThumbLX = lx; s.Gamepad.sThumbLY = ly; s.Gamepad.sThumbRX = rx; s.Gamepad.sThumbRY = ry; return 0; } }
  // looks for newly plugged / paired pads every 2 s (a few ms of work); each one found gets its own reading thread
  static void NScanLoop() { while (true) { try { NScan(); } catch { } System.Threading.Thread.Sleep(2000); } }
  static void NScan() {
    Guid g; HidD_GetHidGuid(out g); IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12); // PRESENT | DEVICEINTERFACE
    if (set == IntPtr.Zero || set == new IntPtr(-1)) return;
    try { for (int i = 0; i < 256; i++) { DIDATA dd = new DIDATA(); dd.cbSize = Marshal.SizeOf(typeof(DIDATA));
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref dd)) break;
        int req; SetupDiGetDeviceInterfaceDetail(set, ref dd, IntPtr.Zero, 0, out req, IntPtr.Zero); if (req <= 0) continue;
        IntPtr buf = Marshal.AllocHGlobal(req); string path = null;
        try { Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6); if (SetupDiGetDeviceInterfaceDetail(set, ref dd, buf, req, out req, IntPtr.Zero)) path = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4)); } finally { Marshal.FreeHGlobal(buf); }
        // Nintendo and Sony only (a Bluetooth pad's path spells the maker "vid&0002057e", a USB one's "vid_057e": both)
        if (path == null) continue; string lp = path.ToLowerInvariant(); bool sony = lp.IndexOf("vid_054c") >= 0 || lp.IndexOf("vid&0002054c") >= 0; if (lp.IndexOf("vid_057e") < 0 && lp.IndexOf("vid&0002057e") < 0 && !sony) continue;
        bool have = false; lock (nLock) { foreach (NPad q in nPads) if (q.path == lp) have = true; } if (have) continue;
        IntPtr h = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_READ, shared read+write, OPEN_EXISTING
        if (h == IntPtr.Zero || h == new IntPtr(-1)) continue;
        HIDA a = new HIDA(); a.Size = Marshal.SizeOf(typeof(HIDA));
        // Joy-Con L / R (2006 / 2007), Pro Controller (2009), the charging grip (200E); DualShock 4 (05C4 / 09CC), DualSense
        // (0CE6), DualSense Edge (0DF2)
        bool ok = HidD_GetAttributes(h, ref a) && (sony ? (a.Pid == 0x05C4 || a.Pid == 0x09CC || a.Pid == 0x0CE6 || a.Pid == 0x0DF2) : (a.Pid == 0x2006 || a.Pid == 0x2007 || a.Pid == 0x2009 || a.Pid == 0x200E));
        if (!ok) { CloseHandle(h); continue; }
        NPad np = new NPad(); np.path = lp; np.h = h; np.pid = a.Pid; np.ps = sony; np.bt = lp.IndexOf("00001124-0000-1000-8000-00805f9b34fb") >= 0; lock (nLock) nPads.Add(np); // bt: paired over Bluetooth (its HID service)
        System.Threading.Thread t = new System.Threading.Thread(NRead); t.IsBackground = true; t.Start(np); } }
    finally { SetupDiDestroyDeviceInfoList(set); } }
  static void NRead(object o) { NPad p = (NPad)o; byte[] r = new byte[1024]; int got;
    try { while (ReadFile(p.h, r, r.Length, out got, IntPtr.Zero)) { if (got > 0) { if (p.ps) PParse(p, r, got); else NParse(p, r, got); } } } catch { }
    lock (nLock) nPads.Remove(p); CloseHandle(p.h); } // unplugged / out of range: the scan picks it up again when it's back
  static short NAxis(int v, int mid, int dead, int mul) { int d = v - mid; if (d > -dead && d < dead) return 0; d *= mul; return (short)(d > 32767 ? 32767 : (d < -32767 ? -32767 : d)); }
  static void NParse(NPad p, byte[] r, int n) {
    int m = 0; byte lt = 0, rt = 0; short lx, ly, rx, ry; bool full = false;
    if (n >= 12 && (r[0] == 0x30 || r[0] == 0x21 || r[0] == 0x31)) { // full reports: what emulators / Steam / SDL switch the pad to
      full = true; int b3 = r[3], b4 = r[4], b5 = r[5];
      if ((b3 & 0x01) != 0) m |= 0x4000; if ((b3 & 0x02) != 0) m |= 0x8000; if ((b3 & 0x04) != 0) m |= 0x1000; if ((b3 & 0x08) != 0) m |= 0x2000;
      if ((b3 & 0x40) != 0) m |= 0x0200; if ((b3 & 0x80) != 0) rt = 255;
      if ((b4 & 0x01) != 0) m |= 0x0020; if ((b4 & 0x02) != 0) m |= 0x0010; if ((b4 & 0x04) != 0) m |= 0x0080; if ((b4 & 0x08) != 0) m |= 0x0040; if ((b4 & 0x10) != 0) m |= 0x0400;
      if ((b5 & 0x01) != 0) m |= 0x0002; if ((b5 & 0x02) != 0) m |= 0x0001; if ((b5 & 0x04) != 0) m |= 0x0008; if ((b5 & 0x08) != 0) m |= 0x0004;
      if ((b5 & 0x40) != 0) m |= 0x0100; if ((b5 & 0x80) != 0) lt = 255;
      lx = NAxis(r[6] | ((r[7] & 0x0F) << 8), 2048, 400, 22); ly = NAxis((r[7] >> 4) | (r[8] << 4), 2048, 400, 22);
      rx = NAxis(r[9] | ((r[10] & 0x0F) << 8), 2048, 400, 22); ry = NAxis((r[10] >> 4) | (r[11] << 4), 2048, 400, 22);
    } else if (n >= 4 && r[0] == 0x3F) { // simple report: the pad's own mode over Bluetooth before anything set it up
      int b1 = r[1], b2 = r[2], hat = r[3];
      if ((b1 & 0x01) != 0) m |= 0x1000; if ((b1 & 0x02) != 0) m |= 0x2000; if ((b1 & 0x04) != 0) m |= 0x4000; if ((b1 & 0x08) != 0) m |= 0x8000;
      if ((b1 & 0x10) != 0) m |= 0x0100; if ((b1 & 0x20) != 0) m |= 0x0200; if ((b1 & 0x40) != 0) lt = 255; if ((b1 & 0x80) != 0) rt = 255;
      if ((b2 & 0x01) != 0) m |= 0x0020; if ((b2 & 0x02) != 0) m |= 0x0010; if ((b2 & 0x04) != 0) m |= 0x0040; if ((b2 & 0x08) != 0) m |= 0x0080; if ((b2 & 0x10) != 0) m |= 0x0400;
      if (hat == 7 || hat == 0 || hat == 1) m |= 0x0001; if (hat >= 1 && hat <= 3) m |= 0x0008; if (hat >= 3 && hat <= 5) m |= 0x0002; if (hat >= 5 && hat <= 7) m |= 0x0004;
      if (n >= 12) { lx = NAxis(r[4] | (r[5] << 8), 32768, 3500, 1); ly = NAxis(32768, r[6] | (r[7] << 8), 3500, 1); rx = NAxis(r[8] | (r[9] << 8), 32768, 3500, 1); ry = NAxis(32768, r[10] | (r[11] << 8), 3500, 1); }
      else { lx = ly = rx = ry = 0; }
    } else return; // other reports (replies to the emulator's own commands): not input
    // a lone Joy-Con fills the other half's stick bytes with zeros, which read as a stick pushed hard into the corner:
    // the pointer drifted / the wheel scrolled on its own, and the Home menu jumped down a row as it opened
    if (p.pid == 0x2006) { rx = ry = 0; } else if (p.pid == 0x2007) { lx = ly = 0; }
    lock (nLock) { p.btn = m; p.lt = lt; p.rt = rt; p.lx = lx; p.ly = ly; p.rx = rx; p.ry = ry; p.seen = true; p.full = full; p.at = Environment.TickCount; } }
  // PlayStation pads' input reports: o = where the sticks start, b0 / b1 / b2 = the button bytes, then the triggers.
  //   USB 0x01: DualSense sticks 1-4, triggers 5-6, buttons 8-10; DualShock 4 sticks 1-4, buttons 5-7, triggers 8-9
  //   Bluetooth 0x01 (the pad's own mode before anything set it up): sticks 1-4, buttons 5-7, triggers 8-9 (both pads)
  //   Bluetooth 0x31 (DualSense, set up by the emulator / Steam / SDL): sticks 2-5, triggers 6-7, buttons 9-11
  //   Bluetooth 0x11 (DualShock 4, set up): sticks 3-6, buttons 7-9, triggers 10-11
  static void PParse(NPad p, byte[] r, int n) {
    bool ds = p.pid == 0x0CE6 || p.pid == 0x0DF2, full = true; int o, b0, b1, b2; byte lt, rt;
    if (r[0] == 0x01 && !p.bt && n >= 11) { o = 1; if (ds) { lt = r[5]; rt = r[6]; b0 = r[8]; b1 = r[9]; b2 = r[10]; } else { b0 = r[5]; b1 = r[6]; b2 = r[7]; lt = r[8]; rt = r[9]; } }
    else if (r[0] == 0x01 && p.bt && n >= 10) { o = 1; b0 = r[5]; b1 = r[6]; b2 = r[7]; lt = r[8]; rt = r[9]; full = false; }
    else if (r[0] == 0x31 && ds && n >= 12) { o = 2; lt = r[6]; rt = r[7]; b0 = r[9]; b1 = r[10]; b2 = r[11]; }
    else if (r[0] == 0x11 && !ds && n >= 12) { o = 3; b0 = r[7]; b1 = r[8]; b2 = r[9]; lt = r[10]; rt = r[11]; }
    else return; // other reports (replies to the emulator's own commands): not input
    int m = 0, hat = b0 & 0x0F;
    if (hat == 7 || hat == 0 || hat == 1) m |= 0x0001; if (hat >= 1 && hat <= 3) m |= 0x0008; if (hat >= 3 && hat <= 5) m |= 0x0002; if (hat >= 5 && hat <= 7) m |= 0x0004;
    if ((b0 & 0x10) != 0) m |= 0x4000; if ((b0 & 0x20) != 0) m |= 0x1000; if ((b0 & 0x40) != 0) m |= 0x2000; if ((b0 & 0x80) != 0) m |= 0x8000;
    if ((b1 & 0x01) != 0) m |= 0x0100; if ((b1 & 0x02) != 0) m |= 0x0200; if ((b1 & 0x10) != 0) m |= 0x0020; if ((b1 & 0x20) != 0) m |= 0x0010;
    if ((b1 & 0x40) != 0) m |= 0x0040; if ((b1 & 0x80) != 0) m |= 0x0080; if ((b2 & 0x01) != 0) m |= 0x0400;
    short lx = NAxis(r[o], 128, 14, 256), ly = NAxis(128, r[o + 1], 14, 256), rx = NAxis(r[o + 2], 128, 14, 256), ry = NAxis(128, r[o + 3], 14, 256);
    lock (nLock) { p.btn = m; p.lt = lt; p.rt = rt; p.lx = lx; p.ly = ly; p.rx = rx; p.ry = ry; p.seen = true; p.full = full; p.at = Environment.TickCount; } }
  public static uint FgPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  // Is one of these processes showing a visible window that covers its whole monitor? (the game is up, fullscreen)
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct FSRECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct FSMON { public int cbSize; public FSRECT rcMonitor; public FSRECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out FSRECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref FSMON mi);
  // The window to send keys to: the process's fullscreen window, else its largest visible one (an emulator's game
  // window, not its game list; Dolphin ignores hotkeys unless the game window itself has focus)
  public static IntPtr GameWindow(int[] pids) {
    IntPtr best = IntPtr.Zero; long bestArea = 0; bool bestFull = false;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid); if (Array.IndexOf(pids, (int)pid) < 0) return true;
      FSRECT r; if (!GetWindowRect(h, out r)) return true; long area = (long)(r.R - r.L) * (r.B - r.T); if (area < 64 * 64) return true;
      bool full = false; FSMON mi = new FSMON(); mi.cbSize = Marshal.SizeOf(typeof(FSMON));
      if (GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) full = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
      if ((full && !bestFull) || (full == bestFull && area > bestArea)) { best = h; bestArea = area; bestFull = full; }
      return true; }, IntPtr.Zero);
    return best; }
  public static bool FullscreenOf(int[] pids) {
    bool found = false; // (a plain array: Windows PowerShell 5.1 compiles without System.Core)
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h) || IsZoomed(h)) return true; // a maximized window isn't the game going fullscreen
      if ((GetWindowLong(h, -16) & 0x00C00000) == 0x00C00000) return true; // nor is one with a title bar (WS_CAPTION)
      uint pid; GetWindowThreadProcessId(h, out pid); if (Array.IndexOf(pids, (int)pid) < 0) return true;
      FSRECT r; if (!GetWindowRect(h, out r)) return true; FSMON mi = new FSMON(); mi.cbSize = Marshal.SizeOf(typeof(FSMON));
      if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return true;
      if (r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B) { found = true; return false; }
      return true; }, IntPtr.Zero);
    return found; }
  // The taskbar only stays behind a fullscreen game while Windows counts it as the fullscreen app in front, and after
  // Boxshelf's loading screen stepped aside it often didn't: the taskbar stayed over the game. ITaskbarList2's
  // MarkFullscreenWindow is Windows' own way of telling the taskbar so (only for a window that really covers its screen).
  [ComImport, Guid("602D4995-B13A-429b-A66E-1935E44F4317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ITaskbarList2 { void HrInit(); void AddTab(IntPtr h); void DeleteTab(IntPtr h); void ActivateTab(IntPtr h); void SetActiveAlt(IntPtr h); void MarkFullscreenWindow(IntPtr h, [MarshalAs(UnmanagedType.Bool)] bool full); }
  [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090")] public class TaskbarList { }
  static ITaskbarList2 taskbar; static IntPtr marked = IntPtr.Zero;
  static bool CoversScreen(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindowVisible(h) || IsIconic(h) || IsZoomed(h)) return false;
    FSRECT r; if (!GetWindowRect(h, out r)) return false; FSMON mi = new FSMON(); mi.cbSize = Marshal.SizeOf(typeof(FSMON));
    return GetMonitorInfo(MonitorFromWindow(h, 2), ref mi) && r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B; }
  public static bool MarkFull(IntPtr h) {
    if (!CoversScreen(h)) return false;
    try { if (taskbar == null) { taskbar = (ITaskbarList2)new TaskbarList(); taskbar.HrInit(); } taskbar.MarkFullscreenWindow(h, true); marked = h; return true; } catch { return false; } }
  // the taskbar or the desktop is the active window (nobody picked another app: the game lost the focus on its way up)
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public static bool FgIsShell() {
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return true;
    System.Text.StringBuilder s = new System.Text.StringBuilder(64); GetClassName(h, s, 64); string c = s.ToString();
    return c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW"; }
  // the game's window in front and fullscreen, not told yet (it went fullscreen after it came to the front, or changed window)
  public static bool MarkFrontIfFull(int[] pids) {
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero || h == marked) return false;
    uint pid; GetWindowThreadProcessId(h, out pid); if (Array.IndexOf(pids, (int)pid) < 0) return false;
    return MarkFull(h); }
  // While a game runs, Boxshelf's own window stays on screen fully transparent (see stepAside in main.js). When its
  // loading cover lifted it dropped out of "always on top" straight into the slot just above the game, so Windows saw a
  // screen-sized window over the game, decided the game wasn't the fullscreen app in front, and raised the taskbar over
  // it until a click put the game back on top (every emulator, every launch). Sink puts Boxshelf's window at the bottom
  // of the z-order, without activating it; Boxshelf raises itself again when the game ends.
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  static bool Above(IntPtr a, IntPtr b) { int n = 0; for (IntPtr w = GetWindow(a, 2); w != IntPtr.Zero && n < 5000; w = GetWindow(w, 2), n++) if (w == b) return true; return false; }
  // Only while Boxshelf is stepped aside: not on top and fully see-through. Its loading screen and its quit cover are on top
  // and opaque, and must stay over the game.
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  static bool Aside(IntPtr self) {
    if (self == IntPtr.Zero || !IsWindowVisible(self)) return false;
    int ex = GetWindowLong(self, -20); if ((ex & 0x8) != 0 || (ex & 0x80000) == 0) return false; // WS_EX_TOPMOST, WS_EX_LAYERED
    uint key, flags; byte alpha; return GetLayeredWindowAttributes(self, out key, out alpha, out flags) && (flags & 2) != 0 && alpha == 0; } // LWA_ALPHA
  public static bool Sink(IntPtr self) {
    if (!Aside(self)) return false;
    return SetWindowPos(self, (IntPtr)1, 0, 0, 0, 0, 0x0213); } // HWND_BOTTOM; NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER
  // the taskbar on the game's monitor showing over the game (an auto-hidden taskbar, tucked away off the screen, doesn't count)
  static bool TrayOver(IntPtr game) {
    IntPtr mon = MonitorFromWindow(game, 2);
    if (TrayOn(FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Shell_TrayWnd", null), mon, game)) return true;
    IntPtr t = IntPtr.Zero; // the taskbars on other monitors
    for (int n = 0; n < 16; n++) { t = FindWindowEx(IntPtr.Zero, t, "Shell_SecondaryTrayWnd", null); if (t == IntPtr.Zero) break; if (TrayOn(t, mon, game)) return true; }
    return false; }
  static bool TrayOn(IntPtr t, IntPtr mon, IntPtr game) {
    if (t == IntPtr.Zero || !IsWindowVisible(t) || MonitorFromWindow(t, 2) != mon) return false;
    FSRECT r; FSMON mi = new FSMON(); mi.cbSize = Marshal.SizeOf(typeof(FSMON));
    if (!GetWindowRect(t, out r) || !GetMonitorInfo(mon, ref mi)) return false;
    int visH = Math.Min(r.B, mi.rcMonitor.B) - Math.Max(r.T, mi.rcMonitor.T), visW = Math.Min(r.R, mi.rcMonitor.R) - Math.Max(r.L, mi.rcMonitor.L);
    return visH > 6 && visW > 6 && Above(t, game); }
  // tell the taskbar again that the game's window is fullscreen: off then on, so it looks again (marking a window that's
  // already marked changes nothing, and the taskbar stays where it is)
  static bool Remark(IntPtr h) {
    if (!CoversScreen(h)) return false;
    try { if (taskbar == null) { taskbar = (ITaskbarList2)new TaskbarList(); taskbar.HrInit(); } taskbar.MarkFullscreenWindow(h, false); taskbar.MarkFullscreenWindow(h, true); marked = h; return true; } catch { return false; } }
  // the game in front and fullscreen: Boxshelf's window kept below it, and the taskbar behind it. 1 = fixed something.
  public static int KeepFront(IntPtr self, int[] pids) {
    IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero || h == self) return 0;
    uint pid; GetWindowThreadProcessId(h, out pid); if (Array.IndexOf(pids, (int)pid) < 0) return 0;
    if (!CoversScreen(h)) return 0;
    bool sank = Aside(self) && Above(self, h) && Sink(self);
    if (h != marked) return MarkFull(h) || sank ? 1 : 0;
    // (the taskbar still over it after a re-mark, e.g. some other always-on-top window: at most every 3 s, no flicker)
    if (sank || (unchecked(Environment.TickCount - remarkAt) > 3000 && TrayOver(h))) { remarkAt = Environment.TickCount; return Remark(h) ? 1 : 0; }
    return 0; }
  static int remarkAt = Environment.TickCount - 10000;
  // (beta.6) Hide the taskbar (every monitor's) while a game starts, runs and closes: an emulator's window that isn't
  // fullscreen yet (starting) or any more (closing) made Windows raise the taskbar over Boxshelf's black cover for a
  // moment. Shown again (without taking the focus) once the shelf is back. Returns how many taskbars it found.
  // (ShowWindowAsync: Explorer is often busy just as a game opens or closes, and a plain ShowWindow waits for it, which
  // stalled this helper's loop, the cover's upkeep included)
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
  // Windows 11 shows it again by itself on some focus changes (a game's window closing), so while it should stay hidden
  // this is called again and again: only a taskbar that's showing is touched (0 = nothing to do).
  public static int Taskbar(bool show) {
    int n = 0; IntPtr t = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Shell_TrayWnd", null);
    if (t != IntPtr.Zero && IsWindowVisible(t) != show) { ShowWindowAsync(t, show ? 8 : 0); n++; } // SW_SHOWNA / SW_HIDE
    IntPtr s = IntPtr.Zero;
    for (int i = 0; i < 16; i++) { s = FindWindowEx(IntPtr.Zero, s, "Shell_SecondaryTrayWnd", null); if (s == IntPtr.Zero) break; if (IsWindowVisible(s) != show) { ShowWindowAsync(s, show ? 8 : 0); n++; } }
    return n; }
  // the game still has a window (a minimized one counts: the player switched away, the game didn't end)
  public static bool HasWindow(int[] pids) {
    bool found = false;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid); if (Array.IndexOf(pids, (int)pid) < 0) return true;
      if (!IsIconic(h)) { FSRECT r; if (!GetWindowRect(h, out r) || (long)(r.R - r.L) * (r.B - r.T) < 64 * 64) return true; }
      found = true; return false; }, IntPtr.Zero);
    return found; }
  // While Boxshelf's black cover is up (a game starting or closing) it must be always-on-top and above the game's windows
  // and the taskbars. Measured: after a Quit the cover was opaque but had lost always-on-top (Electron skips setting it
  // again when it thinks it's set), so the emulator's closing window showed over it for a quarter second. Checked every
  // pass of the helper (~40 ms); fixed from here, straight on the window. 1 = moved.
  // Also its size: measured, while the game had the focus Boxshelf's fullscreen window was one pixel short (2560x1439 on a
  // 1440p screen; Chromium shrinks an inactive fullscreen window), and the game showed through that last row as a sliver
  // at the bottom while starting and quitting. It's stretched back over the whole monitor.
  public static int CoverOnTop(IntPtr self, int[] pids) {
    if (self == IntPtr.Zero || !IsWindowVisible(self)) return 0;
    FSRECT sr; FSMON mi = new FSMON(); mi.cbSize = Marshal.SizeOf(typeof(FSMON));
    if (GetWindowRect(self, out sr) && GetMonitorInfo(MonitorFromWindow(self, 2), ref mi)) {
      FSRECT m = mi.rcMonitor;
      if (sr.L != m.L || sr.T != m.T || sr.R != m.R || sr.B != m.B) // HWND_TOPMOST, the monitor's rect; NOACTIVATE | NOOWNERZORDER
        return SetWindowPos(self, (IntPtr)(-1), m.L, m.T, m.R - m.L, m.B - m.T, 0x0210) ? 1 : 0; }
    bool top = (GetWindowLong(self, -20) & 0x8) != 0; // WS_EX_TOPMOST
    if (top) {
      bool hit = false; int n = 0;
      for (IntPtr w = GetWindow(self, 3); w != IntPtr.Zero && n < 400 && !hit; w = GetWindow(w, 3), n++) { // GW_HWNDPREV: the windows above the cover
        if (!IsWindowVisible(w)) continue;
        uint pid; GetWindowThreadProcessId(w, out pid);
        System.Text.StringBuilder s = new System.Text.StringBuilder(64); GetClassName(w, s, 64); string c = s.ToString();
        hit = Array.IndexOf(pids, (int)pid) >= 0 || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd"; }
      if (!hit) return 0; }
    return SetWindowPos(self, (IntPtr)(-1), 0, 0, 0, 0, 0x0213) ? 1 : 0; } // HWND_TOPMOST; NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER
  // The cover lifted (Boxshelf see-through, the game in front): Boxshelf must not stay always-on-top over the game (a
  // pass of CoverOnTop can land between the lift and this helper hearing of it). 1 = fixed.
  public static int Unpin(IntPtr self) {
    if (self == IntPtr.Zero || !IsWindowVisible(self)) return 0;
    int ex = GetWindowLong(self, -20); if ((ex & 0x8) == 0 || (ex & 0x80000) == 0) return 0; // topmost, layered
    uint key, flags; byte alpha; if (!GetLayeredWindowAttributes(self, out key, out alpha, out flags) || (flags & 2) == 0 || alpha != 0) return 0;
    return SetWindowPos(self, (IntPtr)(-2), 0, 0, 0, 0, 0x0213) ? 1 : 0; } // HWND_NOTOPMOST
}
"@
# The C# above is compiled once and kept as a DLL in Boxshelf's data folder (named after a hash of the code, so a
# change always recompiles): loading it takes milliseconds, compiling it took 1-2 s on every launch.
$dll = '__DLL__'; $xiOk = $false
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll; $xiOk = [bool]('XI' -as [type]) } catch {} }
if (-not $xiOk -and $dll) {
  $own = $dll -replace '[.]dll$', ".$PID.dll"
  try { Add-Type -TypeDefinition $xiSrc -OutputAssembly $own -OutputType Library; if (-not ('XI' -as [type])) { Add-Type -Path $own }; $xiOk = [bool]('XI' -as [type])
    if ($xiOk) { Copy-Item -LiteralPath $own -Destination $dll -Force -ErrorAction SilentlyContinue } } catch {} }
if (-not $xiOk) { Add-Type -TypeDefinition $xiSrc }
$mask = __MASK__; [XI]::NinOn = __NIN__; $need = __NEED__; $mouse = __MOUSE__; $fsPid = __FSPID__; $fsKey = __FSKEY__; $appPid = __APPPID__; $homeOn = __HOME__; $backHome = __BACKHOME__; $cmd = '__CMD__'; $waitFs = __WAITFS__; $wfAt = Get-Date; $parentPid = __PARENT__; $self = [IntPtr][long]__SELF__
# (beta.6) $tbHid: this helper has the taskbar hidden (it's shown again if Boxshelf goes away); $coverOn: Boxshelf's black
# cover is up (kept over the game's windows); $everFs / $goneAt / $goneSent: the game's window was up fullscreen, and
# since when it has had none (the game closed from its own menu: Boxshelf covers the screen until the emulator exits)
$tbHid = __TBHIDE__; $coverOn = $false; $everFs = $false; $goneAt = 0; $goneSent = $false
if ($tbHid) { [XI]::Taskbar($false) | Out-Null }
function TbBack() { if ($script:tbHid) { [XI]::Taskbar($true) | Out-Null; $script:tbHid = $false } }
$menu = $false; $fresh = $false; $backHeld = @(0,0,0,0,0,0); $homeCool = Get-Date
# HID pads (slots 4-5) are read during a game; on the shelf only while the Home menu is open (the shelf reads them itself
# otherwise, but the menu's buttons come from here: a DualSense or Switch pad couldn't move or close it). $hidLive / $hidMask:
# a pad just seen keeps the buttons it already held out until they're let go (the PS press that opened the menu)
$ninStart = [XI]::NinOn; $hidLive = @($false, $false); $hidMask = @(0, 0)
$VKN = @{ 'esc'=0x1B; 'enter'=0x0D; 'space'=0x20; 'tab'=0x09; 'shift'=0x10; 'ctrl'=0x11; 'alt'=0x12 }
1..12 | ForEach-Object { $VKN["f$_"] = 0x6F + $_ }
65..90 | ForEach-Object { $VKN[[string][char]($_ + 32)] = $_ }; 48..57 | ForEach-Object { $VKN[[string][char]$_] = $_ }
# "shift+f1" -> hold the modifiers, tap the key, release
function SendSpec($spec) { $parts = $spec.ToLower().Split('+'); $mods = @(); foreach ($p in $parts[0..($parts.Length - 2)]) { if ($parts.Length -gt 1 -and $VKN[$p]) { $mods += $VKN[$p] } }
  $k = $VKN[$parts[-1]]; if (-not $k) { return }; foreach ($m in $mods) { [XI]::Key([byte]$m, $true) }; [XI]::Tap([byte]$k); Start-Sleep -Milliseconds 30; foreach ($m in $mods) { [XI]::Key([byte]$m, $false) } }
# Put the game's own window in front before sending it keys (the menu overlay never takes focus, but be sure); $true only when it really is (keys sent otherwise land somewhere else)
function FrontGame() { if ($appPid -le 0) { return $true }
  $h = [XI]::GameWindow([int[]]$script:fam)
  if ($h -eq [IntPtr]::Zero) { $script:fam = Family $appPid; $h = [XI]::GameWindow([int[]]$script:fam) }
  if ($h -eq [IntPtr]::Zero) { return ($script:fam -contains [int][XI]::FgPid()) }
  [XI]::Sink($self) | Out-Null
  if ([XI]::GetForegroundWindow() -eq $h) { [XI]::KeepFront($self, [int[]]$script:fam) | Out-Null; return $true }
  for ($k = 0; $k -lt 3; $k++) { [XI]::Tap([byte]0x87); [XI]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 80; if ([XI]::GetForegroundWindow() -eq $h) { [XI]::KeepFront($self, [int[]]$script:fam) | Out-Null; return $true } }
  return $false }
# (Sink: Boxshelf's see-through window below the game; KeepFront: the taskbar told the game's window is fullscreen, so it
#  stays behind the game)
# (F24 above: an unused key; the last process to send input may move the foreground, so Windows doesn't refuse it)
$names = @{ 0x0001 = 'up'; 0x0002 = 'down'; 0x0004 = 'left'; 0x0008 = 'right'; 0x1000 = 'a'; 0x2000 = 'b'; 0x0010 = 'start'; 0x0400 = 'home' }
# $held / $backHeld: when (ms on $clk) the quit combo / a lone View started being held, 0 = not held (-1: View waits to be
# let go after it opened the menu). Timed, not counted in passes: the loop's real period drifts with PowerShell's overhead.
$clk = [System.Diagnostics.Stopwatch]::StartNew(); $ms = 1
# pointer mode: the left button Windows was told is down. It's let go whenever the pointer stops (menu open, the app not in
# front, the helper quitting): the release came only from A's own release otherwise, and a click that opened another
# window (or the menu) left the button held down, so the next stick move dragged / selected.
$clickDown = $false
function ReleaseClick() { if ($script:clickDown) { [XI]::Click($false); $script:clickDown = $false; Write-Output "CLICK 0" } }
# the quit combo's buttons ($cmask; none for "no combo") don't act as keys while held together with another of them
$cmask = $(if ($mask -eq 0xFFFF) { 0 } else { $mask }); $mst = @{}
$held = @(0,0,0,0,0,0); $prev = @(0,0,0,0,0,0); $mprev = 0; $mstick = 0; $acc = @(0,0,0,0,0,0); $passes = 0; $backAt = $null; $rep = @{}; $fsDone = ($fsPid -le 0); $fsSeen = 0; $fsTries = 0; $t0 = Get-Date; $probeAt = $t0
# the launched exe is often just a launcher: follow its children (Stremio, Electron apps…)
$fam = @($appPid); $famAt = $t0.AddSeconds(-10); $tbAt = $t0; $frontUntil = $t0; $refAt = $t0
function Family($root) { $set = @($root); try { $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId } catch { return $set }
  $grew = $true; while ($grew) { $grew = $false; foreach ($q in $all) { if (($set -contains [int]$q.ParentProcessId) -and -not ($set -contains [int]$q.ProcessId)) { $set += [int]$q.ProcessId; $grew = $true } } }
  return $set }
# QUIT and HOME only count while the game is in front (or Boxshelf itself, e.g. its launch cover over a game that hangs
# on start): pressed in some other app the user switched to, they'd close or interrupt the game behind their back.
# A launcher's child the family list hasn't caught yet gets a fresh look, at most every 2 s.
function GameFront() { if ($appPid -le 0) { return $true }
  $fg = [int][XI]::FgPid(); if ($fg -eq $parentPid -or $script:fam -contains $fg) { return $true }
  if (((Get-Date) - $script:famAt).TotalSeconds -gt 2) { $script:fam = Family $appPid; $script:famAt = Get-Date; return ($script:fam -contains $fg) }
  return $false }
# Boxshelf gone (crashed, killed): nobody reads this output any more, so stop polling pads and sending input.
# The start time guards against Windows handing its pid to some other process later.
$parentStart = $null; $parentAt = $t0
if ($parentPid -gt 0) { $pp = Get-Process -Id $parentPid -ErrorAction SilentlyContinue; if (-not $pp) { TbBack; exit }; try { $parentStart = $pp.StartTime } catch {} }
Write-Output "READY"
# button -> key: dpad arrows, Start=Enter, Back=Alt+Left (browser back), B=Esc, X=Space, Y=F11, LB/RB=Left/Right
$keys = @{ 0x0001 = 0x26; 0x0002 = 0x28; 0x0004 = 0x25; 0x0008 = 0x27; 0x0010 = 0x0D; 0x2000 = 0x1B; 0x4000 = 0x20; 0x8000 = 0x7A; 0x0100 = 0x25; 0x0200 = 0x27 }
$repeatable = @(0x0001, 0x0002, 0x0004, 0x0008, 0x0100, 0x0200)
while ($true) {
  $now = Get-Date; $ms = $clk.ElapsedMilliseconds + 1
  if ($parentPid -gt 0 -and ($now - $parentAt).TotalSeconds -gt 2) { $parentAt = $now
    $pp = Get-Process -Id $parentPid -ErrorAction SilentlyContinue; if (-not $pp) { ReleaseClick; TbBack; exit }
    try { if ($parentStart -and $pp.StartTime -ne $parentStart) { ReleaseClick; TbBack; exit } } catch {} }
  # the taskbar should stay hidden: Windows shows it again by itself on some focus changes, so hide it again (each pass)
  if ($tbHid) { [XI]::Taskbar($false) | Out-Null }
  # the black cover up (starting / closing): the game's windows or a taskbar that got over it go back under it at once
  if ($coverOn -and $appPid -gt 0 -and -not $menu) { [XI]::CoverOnTop($self, [int[]]$fam) | Out-Null }
  elseif (-not $coverOn -and $appPid -gt 0) { [XI]::Unpin($self) | Out-Null }
  # the game's window gone while the emulator still runs (closed from its own menu, or Esc): tell Boxshelf at once (it
  # covers the screen), and again if a window comes back (the emulator only rebuilt it: Boxshelf steps aside again)
  if ($everFs -and -not $coverOn -and $appPid -gt 0) {
    if ([XI]::HasWindow([int[]]$fam)) { $goneAt = 0; if ($goneSent) { $goneSent = $false; Write-Output "GAMEBACK" } }
    elseif ($goneAt -eq 0) { $goneAt = $ms } elseif (-not $goneSent -and $ms - $goneAt -ge 30) { $goneSent = $true; Write-Output "GAMEGONE" } } # (two passes in a row without a window, ~40-80 ms)
  $needFam = ($mouse -or -not $fsDone -or $waitFs)
  # the game's window came to the front fullscreen on its own (or went fullscreen later): keep the taskbar behind it, and
  # Boxshelf's see-through window below it (every 250 ms for a few seconds after the hand-over, then every second)
  if ($appPid -gt 0 -and -not $menu -and ($now - $tbAt).TotalMilliseconds -gt $(if ($now -lt $frontUntil) { 250 } else { 1000 })) { $tbAt = $now; [XI]::KeepFront($self, [int[]]$fam) | Out-Null }
  # for a few seconds after Boxshelf handed over (FRONT): the taskbar / desktop ending up active means the game lost the
  # focus on its way up (the taskbar then shows over it until a click), so the game goes back to the front
  if ($appPid -gt 0 -and -not $menu -and $now -lt $frontUntil -and ($now - $refAt).TotalMilliseconds -gt 400) { $refAt = $now; if ([XI]::FgIsShell()) { FrontGame | Out-Null } }
  # the game's window is up and fullscreen: Boxshelf can lift its loading screen now (gives up after a minute)
  if ($waitFs -and $appPid -gt 0 -and ($now - $wfAt).TotalMilliseconds -gt 100) { $wfAt = $now
    if ([XI]::FullscreenOf([int[]]$fam)) { Write-Output "GAMEFS"; $waitFs = $false; $everFs = $true } elseif (($now - $t0).TotalSeconds -gt 60) { $waitFs = $false } }
  # (pointer mode only: skip the slow full process listing while the game's family is already in front; it hitched the pointer)
  if ($needFam -and $appPid -gt 0 -and ($now - $famAt).TotalSeconds -gt $(if ($fsDone) { 6 } else { 2 })) { $famAt = $now; if (-not ($fsDone -and -not $waitFs -and ($fam -contains [int][XI]::FgPid()))) { $fam = Family $appPid } }
  if (-not $fsDone -and $fsPid -gt 0 -and ($now - $probeAt).TotalMilliseconds -gt 300) {
    $probeAt = $now
    $p = $null; foreach ($id in $fam) { $q = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($q -and $q.MainWindowHandle -ne 0) { $p = $q; break } }
    if ($p) {
      if ($fsSeen -eq 0) { $fsSeen = $now }
      elseif (($now - $fsSeen).TotalMilliseconds -gt 2500) {
        # already fullscreen (the app remembered it): pressing the key would take it out of fullscreen again
        if ([XI]::FullscreenOf([int[]]$fam)) { $fsDone = $true; Write-Output "FULLSCREEN-ALREADY" }
        else {
        # (an F24 tap first: Windows only lets a process that just sent input move the focus, and the loading screen is in front)
        [XI]::Tap([byte]0x87); [XI]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -Milliseconds 200
        # only press the key if the app really is in front (Windows may refuse to raise it); try again a few times, then give up quietly
        if ($fam -contains [int][XI]::FgPid()) { [XI]::Tap([byte]$fsKey); $fsDone = $true; Write-Output "FULLSCREEN" }
        else { $fsTries += 1; if ($fsTries -ge 8) { $fsDone = $true; Write-Output "FULLSCREEN-SKIPPED" } } }
      }
    }
    elseif (($now - $t0).TotalSeconds -gt 40) { $fsDone = $true }
  }
  # commands from Boxshelf: MENU 1/0 (menu open: report buttons, don't act as a mouse), KEYS <spec> [<spec>…]
  if ($cmd -and (Test-Path -LiteralPath $cmd)) {
    # take the file over first (a rename is atomic), so a line Boxshelf appends meanwhile lands in a fresh file, never lost
    $work = $cmd + '.w'; Move-Item -LiteralPath $cmd -Destination $work -Force -ErrorAction SilentlyContinue
    $lines = @(Get-Content -LiteralPath $work -ErrorAction SilentlyContinue); Remove-Item -LiteralPath $work -ErrorAction SilentlyContinue
    foreach ($l in $lines) { $w = $l.Trim().Split(' ')
      # MENU 1: start from the buttons as they are now (no stale taps); FRONT: the game in front, the pointer parked in the corner
      if ($w[0] -eq 'MENU') { $menu = ($w[1] -eq '1'); if ($menu) { $fresh = $true; $acc = @(0,0,0,0,0,0) }; if (-not $ninStart) { [XI]::NinOn = $menu } }
      # (FRONT keep: the Home menu closing over a media app, where the pointer is the user's own and stays put)
      elseif ($w[0] -eq 'FRONT') { FrontGame | Out-Null; $frontUntil = (Get-Date).AddSeconds(8); if (-not ($mouse -and $w[1] -eq 'keep')) { [XI]::SetCursorPos(32000, 32000) | Out-Null } }
      # FOCUS <hwnd>: give Boxshelf's own window the keyboard focus (Windows refuses a background app asking for it itself;
      # this helper may, because it just sent input). Without focus Chromium delivers no controller input to the shelf.
      elseif ($w[0] -eq 'FOCUS') { $fh = [IntPtr][long]$w[1]; for ($k = 0; $k -lt 4; $k++) { [XI]::Tap([byte]0x87); [XI]::SetForegroundWindow($fh) | Out-Null; Start-Sleep -Milliseconds 60; if ([XI]::GetForegroundWindow() -eq $fh) { break } }
        Write-Output ("FOCUSED " + $(if ([XI]::GetForegroundWindow() -eq $fh) { 1 } else { 0 })) }
      # TASKBAR 0/1: hide / show the taskbar now (answered, so a launch can wait for it); COVER 1/0: Boxshelf's black cover is up / lifted
      elseif ($w[0] -eq 'TASKBAR') { if ($w[1] -eq '1') { [XI]::Taskbar($true) | Out-Null; $tbHid = $false } else { [XI]::Taskbar($false) | Out-Null; $tbHid = $true }; Write-Output ("TASKBAR-DONE " + $w[1]) }
      elseif ($w[0] -eq 'COVER') { $coverOn = ($w[1] -eq '1'); $goneAt = 0; if ($coverOn) { $goneSent = $false } }
      elseif ($w[0] -eq 'KEYS') { $tag = $w[1]
        if (-not (FrontGame)) { Write-Output "KEYS-FAIL $tag" }
        else { foreach ($sp in $w[2..($w.Length - 1)]) { if ($sp -match '^wait([0-9]+)$') { Start-Sleep -Milliseconds ([int]$matches[1]) } else { SendSpec $sp; Start-Sleep -Milliseconds 90 } }; Write-Output "KEYS-DONE $tag" } } } }
  $front = $true
  if ($mouse -and $appPid -gt 0) { $front = ($fam -contains [int][XI]::FgPid()) }
  # the menu and the pointer act on every pad merged into one: the same Switch pad seen twice (BetterJoy's virtual Xbox pad
  # and straight from HID in slot 4) moved the menu two rows per press and double-clicked in pointer mode
  $mb = 0; $mt = 0; $mlx = 0; $mly = 0; $mry = 0; $mlt = 0; $mrt = 0
  for ($i = 0; $i -lt 6; $i++) { # 0-3 XInput, 4 Nintendo pads, 5 PlayStation pads (HID)
    # no pad in this slot (during the last sample): a hold in progress starts over when it's back
    if ([int]$acc[$i] -lt 0 -and $passes -gt 0) { $held[$i] = 0; if ($backHeld[$i] -gt 0) { $backHeld[$i] = 0 }; if ($i -ge 4) { $hidLive[$i - 4] = $false }; continue }
    $s = New-Object -TypeName 'XI+ST'
    if ([XI]::Get($i, [ref]$s) -ne 0) { $held[$i] = 0; if ($backHeld[$i] -gt 0) { $backHeld[$i] = 0 }; if ($i -ge 4) { $hidLive[$i - 4] = $false }; continue }
    $g = $s.Gamepad; $b = [int]$g.wButtons
    if ($i -ge 4) { $k = $i - 4; if (-not $hidLive[$k]) { $hidLive[$k] = $true; $hidMask[$k] = $b }; $hidMask[$k] = $hidMask[$k] -band $b; $b = $b -band (-bnot $hidMask[$k]) }
    if (($b -band $mask) -eq $mask) { if ($held[$i] -le 0) { $held[$i] = $ms }; if ($ms - $held[$i] -ge $need -and (GameFront)) { ReleaseClick; Write-Output "QUIT"; exit } } else { $held[$i] = 0 }
    $pb0 = $prev[$i]; $tapped = [Math]::Max(0, [int]$acc[$i]) # pressed at some point since the last pass, even if already released
    if ($i -ge 4) { $tapped = $tapped -band (-bnot $hidMask[$i - 4]) }
    if ($homeOn -and -not $menu -and ($now - $homeCool).TotalMilliseconds -gt 700) {
      # Home: tap Guide, or hold View/Back on its own for about a second (HOME <slot>: 4 = a Nintendo pad, for its A/B layout)
      if ((($b -bor $tapped) -band 0x0400) -and -not ($pb0 -band 0x0400)) { if (GameFront) { Write-Output ("HOME " + $i) }; $homeCool = $now }
      # (every slot waits for its own release after: the same pad in two slots must not open it a second time)
      if ($backHome -and $b -eq 0x0020) { if ($backHeld[$i] -eq 0) { $backHeld[$i] = $ms } elseif ($backHeld[$i] -gt 0 -and $ms - $backHeld[$i] -ge 900) { if (GameFront) { Write-Output ("HOME " + $i) }; $homeCool = $now; $backHeld = @(-1,-1,-1,-1,-1,-1) } }
    }
    elseif ($backHeld[$i] -gt 0) { $backHeld[$i] = 0 } # menu open / just after a Home: a hold only counts from when it can open the menu
    # counted only while Back is held alone; reset when it's let go (not just when every button is up, or separate short
    # presses of Back made while holding something else added up to a Home)
    if (-not ($b -band 0x0020) -or ($b -ne 0x0020 -and $backHeld[$i] -gt 0)) { $backHeld[$i] = 0 }
    $prev[$i] = $b
    $mb = $mb -bor $b; $mt = $mt -bor $tapped; if ($g.bLeftTrigger -gt $mlt) { $mlt = [int]$g.bLeftTrigger }; if ($g.bRightTrigger -gt $mrt) { $mrt = [int]$g.bRightTrigger }
    if ([Math]::Abs([int]$g.sThumbLX) -gt [Math]::Abs($mlx)) { $mlx = [int]$g.sThumbLX }; if ([Math]::Abs([int]$g.sThumbLY) -gt [Math]::Abs($mly)) { $mly = [int]$g.sThumbLY }
    if ([Math]::Abs([int]$g.sThumbRY) -gt [Math]::Abs($mry)) { $mry = [int]$g.sThumbRY }
  }
  if ($clickDown -and ($menu -or -not $front)) { ReleaseClick }
  if ($menu) {
    # stick as d-pad for the menu
    $st = if ($mly -gt 16000) { 1 } elseif ($mly -lt -16000) { -1 } else { 0 }
    # MENU 1 just came: start from the buttons and stick as they are now (no stale taps, a stick already held doesn't move it)
    $pb0 = $mprev; if ($fresh) { $pb0 = $mb; $mt = 0; $mstick = $st }
    foreach ($bit in $names.Keys) { $down = ($mb -band $bit) -ne 0; $was = ($pb0 -band $bit) -ne 0
      if ($down -ne $was) { Write-Output ("BTN " + $names[$bit] + " " + $(if ($down) { 1 } else { 0 })) }
      elseif (-not $down -and -not $was -and ($mt -band $bit)) { Write-Output ("BTN " + $names[$bit] + " 1"); Write-Output ("BTN " + $names[$bit] + " 0") } }
    if ($st -ne $mstick) { if ($st -eq 1) { Write-Output "BTN up 1" } elseif ($st -eq -1) { Write-Output "BTN down 1" }; $mstick = $st }
  }
  elseif ($mouse -and $front) {
    # left stick = pointer, right stick / triggers = scroll, A = click (a pad that drops mid-press lets the button go too)
    $lx = $mlx; $ly = $mly
    if ([Math]::Abs($lx) -lt 7000) { $lx = 0 }; if ([Math]::Abs($ly) -lt 7000) { $ly = 0 }
    if ($lx -ne 0 -or $ly -ne 0) { $fx = $lx / 32767.0; $fy = $ly / 32767.0; [XI]::Move([int]($fx * [Math]::Abs($fx) * 22), [int](-$fy * [Math]::Abs($fy) * 22)) }
    if ([Math]::Abs($mry) -gt 9000) { [XI]::Wheel([int]($mry / 32767.0 * 40)) }
    if ($mrt -gt 60) { [XI]::Wheel(-30) }; if ($mlt -gt 60) { [XI]::Wheel(30) }
    $b = $mb; $pb = $mprev
    # (pressed only on A going down here: A still held from the menu or another window doesn't press it again)
    if (($b -band 0x1000) -and -not ($pb -band 0x1000) -and -not $clickDown) { [XI]::Click($true); $clickDown = $true; Write-Output "CLICK 1" }
    elseif (-not ($b -band 0x1000) -and $clickDown) { ReleaseClick }
    if (($b -band 0x0020) -and -not ($pb -band 0x0020)) { $backAt = $now }
    if (($b -band 0x0020) -and ($cmask -band 0x0020) -and ($b -band $cmask -band -bnot 0x0020)) { $backAt = $null } # part of the quit combo: no Back
    if (-not ($b -band 0x0020) -and ($pb -band 0x0020) -and $backAt -and ($now - $backAt).TotalMilliseconds -lt 600) { [XI]::Combo(0x12, 0x25) }
    foreach ($bit in $keys.Keys) {
      $down = ($b -band $bit) -ne 0; $was = ($pb -band $bit) -ne 0
      if ($cmask -band $bit) {
        # a quit-combo button (e.g. LB + RB + Start): its key waits for the release, or for the repeat delay if it's held
        # alone, and is dropped once another combo button joins it. Holding the combo seeked a video back and forth and
        # pressed Enter / Esc in the app before it closed.
        if ($down -and -not $was) { $mst[$bit] = 1; $rep[$bit] = $now.AddMilliseconds(420) }
        if ($down -and ($b -band $cmask -band -bnot $bit)) { $mst[$bit] = 3 }
        if ($down -and $mst[$bit] -eq 1 -and $now -gt $rep[$bit]) { [XI]::Tap([byte]$keys[$bit]); $mst[$bit] = 2; $rep[$bit] = $now.AddMilliseconds(110) }
        elseif ($down -and $mst[$bit] -eq 2 -and $repeatable -contains $bit -and $now -gt $rep[$bit]) { [XI]::Tap([byte]$keys[$bit]); $rep[$bit] = $now.AddMilliseconds(110) }
        elseif (-not $down -and $was -and $mst[$bit] -eq 1) { [XI]::Tap([byte]$keys[$bit]) }
        if (-not $down) { $mst[$bit] = 0 }
        continue }
      if ($down -and -not $was) { [XI]::Tap([byte]$keys[$bit]); $rep[$bit] = $now.AddMilliseconds(420) }
      elseif ($down -and $was -and $repeatable -contains $bit -and $rep[$bit] -and $now -gt $rep[$bit]) { [XI]::Tap([byte]$keys[$bit]); $rep[$bit] = $now.AddMilliseconds(110) }
    }
  }
  $mprev = $mb
  $fresh = $false
  $acc = [XI]::Sample($(if ($mouse) { 16 } else { 40 })); $passes += 1
}`;

// XInput button bits
const BTN = { up: 0x0001, down: 0x0002, left: 0x0004, right: 0x0008, start: 0x0010, back: 0x0020, l3: 0x0040, r3: 0x0080, lb: 0x0100, rb: 0x0200, guide: 0x0400, a: 0x1000, b: 0x2000, x: 0x4000, y: 0x8000 };
const COMBOS = {
  'start+back': BTN.start | BTN.back,
  'lb+rb+start': BTN.lb | BTN.rb | BTN.start,
  'l3+r3': BTN.l3 | BTN.r3,
  'back+b': BTN.back | BTN.b,
  none: 0xFFFF // can't be pressed: used when only the Home menu or the pointer is wanted
};

let proc = null, log = () => {}, runs = 0, cacheDir = null;
// dataDir: where the compiled helper DLL is kept (data\padwatch)
function init(logger, dataDir) { if (logger) log = logger; if (dataDir) { cacheDir = require('path').join(dataDir, 'padwatch'); cleanCache(); setTimeout(prewarm, 8000); } }
// build the DLL in the background a few seconds after Boxshelf starts, so even the first game launch loads it ready-made
function prewarm() {
  if (process.platform !== 'win32' || !cacheDir) return; const fs = require('fs'), path = require('path');
  if (fs.existsSync(dllPath())) return;
  const head = SCRIPT.slice(0, SCRIPT.indexOf('$mask = ')).replace('__DLL__', () => psq(dllPath()));
  const ps1 = path.join(require('os').tmpdir(), `boxshelf-padbuild-${process.pid}.ps1`);
  try { fs.writeFileSync(ps1, '\ufeff' + head, 'utf8'); } catch { return; }
  const t0 = Date.now();
  try { const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], { windowsHide: true, stdio: 'ignore' });
    p.on('exit', () => { try { fs.unlinkSync(ps1); } catch {} log('padwatch: helper prepared', fs.existsSync(dllPath()) ? 'in ' + (Date.now() - t0) + ' ms' : '(not cached, will compile per launch)'); });
    p.on('error', () => { try { fs.unlinkSync(ps1); } catch {} }); } catch {}
}
const CS_HASH = (() => { const a = SCRIPT.indexOf('@"'), b = SCRIPT.indexOf('"@', a); return require('crypto').createHash('sha1').update(SCRIPT.slice(a, b)).digest('hex').slice(0, 12); })();
const dllPath = () => cacheDir ? require('path').join(cacheDir, `xi-${CS_HASH}.dll`) : '';
// old builds of the helper, and per-process copies left by earlier runs (in use ones can't be deleted: skipped)
function cleanCache() {
  const fs = require('fs'), path = require('path');
  try { fs.mkdirSync(cacheDir, { recursive: true }); for (const f of fs.readdirSync(cacheDir)) if (f !== `xi-${CS_HASH}.dll`) { try { fs.unlinkSync(path.join(cacheDir, f)); } catch {} } } catch {}
}

// opts: { mouse: true (left stick drives the pointer, buttons become keys while the app is in front),
//         appPid, fullscreenKey: 'F11' (pressed once the app's window is up) }
const VK = { F11: 0x7A, F: 0x46, ENTER: 0x0D };
// opts also: home (true: report HOME / menu buttons), onHome(), onButton(name, down), cmdFile, nin (true: also read Nintendo pads; games and apps only)
function start(comboName, holdMs, onQuit, opts = {}) {
  stop();
  if (process.platform !== 'win32') return false;
  const mask = COMBOS[comboName] || COMBOS['l3+r3'];
  const hold = Math.max(200, Math.round(holdMs || 900)); // ms (the helper times the hold itself)
  const fsKey = opts.fullscreenKey ? (VK[String(opts.fullscreenKey).toUpperCase()] || 0) : 0;
  sweepTemp();
  // (replacement functions: a plain string would treat $& $' $$ in a path as patterns)
  const script = SCRIPT.replace('__MASK__', () => num(mask)).replace('__NEED__', () => num(hold)).replace('__MOUSE__', () => psb(opts.mouse))
    .replace('__FSPID__', () => num(fsKey && opts.appPid)).replace('__FSKEY__', () => num(fsKey)).replace('__APPPID__', () => num(opts.appPid)).replace('__WAITFS__', () => psb(opts.onFullscreen && opts.appPid))
    .replace('__HOME__', () => psb(opts.home)).replace('__NIN__', () => psb(opts.nin)).replace('__BACKHOME__', () => psb(opts.home && opts.backHome !== false)).replace('__PARENT__', () => num(process.pid)).replace('__SELF__', () => /^\d+$/.test(selfHwnd) ? selfHwnd : '0')
    .replace('__CMD__', () => psq(opts.cmdFile || '')).replace('__DLL__', () => psq(dllPath())).replace('__TBHIDE__', () => psb(opts.taskbarHidden));
  cmdFile = opts.cmdFile || null; if (cmdFile) { try { require('fs').unlinkSync(cmdFile); } catch {} }
  if (focusWant && !opts.appPid && Date.now() - focusWant.at < 8000) setTimeout(() => focusWant && command('FOCUS ' + focusWant.h), 0);
  // a helper that (re)starts while the Home menu is still open must report the menu's buttons again (it starts with MENU 0)
  if (opts.isMenuOpen) setTimeout(() => { try { if (opts.isMenuOpen()) command('MENU 1'); } catch {} }, 0); /* asked just before the game's helper went away (only the shelf's helper repeats it, never a game's) */
  // The script runs from a temp file: passed inline (-EncodedCommand) it outgrew Windows' 32,767-character command
  // line and the helper silently never started (no Guide, no quit combo). UTF-8 with a BOM for Windows PowerShell 5.1.
  const ps1 = require('path').join(require('os').tmpdir(), `boxshelf-pad-${process.pid}-${++runs}.ps1`);
  try { require('fs').writeFileSync(ps1, '\ufeff' + script, 'utf8'); } catch (e) { log('padwatch script', e.message); return false; }
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { log('padwatch spawn failed', e.message); proc = null; try { require('fs').unlinkSync(ps1); } catch {} return false; }
  curPs1 = ps1; const me = proc, t0 = Date.now(); let buf = '';
  me.stdout.on('data', d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line === 'CLICK 1' || line === 'CLICK 0') { me.clickHeld = line === 'CLICK 1'; continue; } // (tracked even once replaced: see stop())
      if (proc !== me) continue; // output from a helper that has since been replaced must not act on the new session
      if (line === 'READY') log('padwatch ready:', comboName, 'in', Date.now() - t0, 'ms');
      if (line === 'QUIT') { me.quit = true; log('padwatch: quit combo'); try { onQuit(); } catch (e) { log('padwatch onQuit', e.message); } }
      if (line === 'FULLSCREEN') log('padwatch: sent fullscreen key');
      if (line === 'GAMEFS' && opts.onFullscreen) { try { opts.onFullscreen(); } catch (e) { log('padwatch onFullscreen', e.message); } }
      if ((line === 'GAMEGONE' || line === 'GAMEBACK') && opts.onWindow) { try { opts.onWindow(line === 'GAMEBACK'); } catch (e) { log('padwatch onWindow', e.message); } }
      if (line.startsWith('TASKBAR-DONE')) { const f = tbWait; tbWait = null; if (f) f(true); }
      if ((line === 'HOME' || line.startsWith('HOME ')) && opts.onHome) { homeNin = line === 'HOME 4'; try { opts.onHome(line === 'HOME 5' ? 'ps' : line === 'HOME 4' ? 'nintendo' : ''); } catch (e) { log('padwatch onHome', e.message); } } // (the pad's prompts: slot 5 PlayStation, 4 Nintendo, XInput unknown)
      if (line.startsWith('BTN ') && opts.onButton) { const [, name, d] = line.split(' '); try { opts.onButton(name, d === '1'); } catch {} }
      if (line.startsWith('KEYS-DONE ') || line.startsWith('KEYS-FAIL ')) { const ok = line.startsWith('KEYS-DONE'), id = line.slice(10).trim(); const f = pendingKeys.get(id); if (f) { pendingKeys.delete(id); if (!ok) log('padwatch: the game window could not be brought to the front, keys not sent'); try { f(ok); } catch {} } }
      if (line.startsWith('FOCUSED ')) { if (line.endsWith('1')) focusWant = null; } if (line.startsWith('FOCUSED ')) log('padwatch: gave Boxshelf the focus', line.endsWith('1') ? 'ok' : '(Windows refused)');
      if (line === 'FULLSCREEN-SKIPPED') log('padwatch: app never came to the front, fullscreen key not sent');
    }
  });
  me.stderr.on('data', d => { const t = require('./paths').psError(d); if (t) log('padwatch:', t.slice(0, 300)); });
  me.on('exit', code => { if (me.clickHeld) { me.clickHeld = false; releaseClick(); } const mine = proc === me; if (proc === me) proc = null; if (code && code !== 1) log('padwatch exited', code); try { require('fs').unlinkSync(ps1); } catch {}
    // (beta.10) the helper ended by itself while the game still runs (not the quit combo, not stop()): started again after a
    // moment, at most twice per game (the Guide button and the quit combo were dead for the rest of it). Without the
    // fullscreen key: pressed again, it would take the app out of fullscreen.
    if (!mine || me.quit || typeof opts.keepUp !== 'function' || (opts.restarts || 0) >= 2) return;
    let up = false; try { up = !!opts.keepUp(); } catch {} if (!up) return;
    const n = (opts.restarts || 0) + 1, g = stops; log('padwatch: the helper stopped during the game (exit ' + code + '), starting it again (' + n + ' of 2)');
    setTimeout(() => { let still = false; try { still = !!opts.keepUp(); } catch {} if (stops === g && !proc && still) start(comboName, holdMs, onQuit, { ...opts, fullscreenKey: null, onFullscreen: undefined, restarts: n }); }, 1500); });
  me.on('error', e => { log('padwatch error', e.message); if (proc === me) proc = null; try { require('fs').unlinkSync(ps1); } catch {} }); // e.g. no powershell.exe: no 'exit' follows
  return true;
}
// (the script file goes now too: the 'exit' cleanup never runs if Boxshelf itself is quitting)
let stops = 0; // (beta.10) counts stop() calls: a restart planned before one is dropped
function stop() { stops++; if (tbWait) { const f = tbWait; tbWait = null; f(false); } if (proc) { const p = proc; proc = null; try { p.kill(); } catch {} if (p.clickHeld) { p.clickHeld = false; releaseClick(); } } if (curPs1) { try { require('fs').unlinkSync(curPs1); } catch {} curPs1 = null; } pendingKeys.clear(); }
// A helper killed (game over, Boxshelf quitting) while A held the pointer's left button down can't let it go itself: a
// one-line PowerShell does it, with the cached helper DLL when there is one (no compile). (Encoded: no quoting trouble.)
function releaseClick() {
  if (process.platform !== 'win32') return; const d = dllPath(), fs = require('fs');
  const ps = "$ErrorActionPreference = 'SilentlyContinue'; " + (d && fs.existsSync(d) ? `Add-Type -Path '${psq(d)}'; [XI]::Click($false)`
    : `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BxUp { [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, int d, UIntPtr e); }'; [BxUp]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)`);
  try { const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }); p.on('error', () => {}); log('padwatch: let go of the left mouse button'); } catch {}
}
// What goes into the script's code: plain integers, $true/$false, and text for a '…' string with every quote doubled,
// including the curly ones (‘ ’ ‚ ‛), which PowerShell also takes as single quotes
const num = v => String(Math.trunc(Number(v)) || 0), psb = v => v ? '$true' : '$false';
const psq = v => String(v).replace(/['\u2018-\u201B]/g, c => c + c);
// script files left by runs that never got to clean up (a crash, power loss): once per session, older than a day
let swept = false, curPs1 = null;
function sweepTemp() {
  if (swept) return; swept = true; const fs = require('fs'), path = require('path'), dir = require('os').tmpdir();
  try { for (const f of fs.readdirSync(dir)) { if (!/^boxshelf-pad(build)?-[\d-]+\.ps1$/i.test(f)) continue; const p = path.join(dir, f); try { if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.unlinkSync(p); } catch {} } } catch {}
}
// Commands to the running helper go through a small file it checks every loop (stdin isn't reliable from PowerShell).
let cmdFile = null, pendingKeys = new Map(), keySeq = 0; // each KEYS command carries an id, answered by KEYS-DONE <id>
function command(line) { if (!proc || !cmdFile) return false; try { require('fs').appendFileSync(cmdFile, line + '\r\n'); return true; } catch (e) { log('padwatch command', e.message); return false; } }
function setMenu(on) { return command('MENU ' + (on ? 1 : 0)); }
let focusWant = null;
// hwnd: a window handle as a decimal string. Also replayed once by the next helper that starts within a few seconds.
function focusOnce(hwnd) { return hwnd ? command('FOCUS ' + String(hwnd)) : false; } // just now (not repeated for the next helper, unlike focusWindow)
const focusPending = () => !!(focusWant && Date.now() - focusWant.at < 8000);
function focusWindow(hwnd) { if (!hwnd) return false; focusWant = { h: String(hwnd), at: Date.now() }; return command('FOCUS ' + focusWant.h); }
// bring the running game's window to the front (and park the mouse pointer) — after Boxshelf's launch cover lifts.
// keepPointer: the Home menu closing over a media app, where the pointer stays where the user left it
function front(keepPointer) { return command(keepPointer ? 'FRONT keep' : 'FRONT'); }
// keys: ['f10'], ['shift+f1'], 'wait300' between steps; resolves when the helper has sent them
function sendKeys(keys) {
  return new Promise(res => {
    const id = String(++keySeq);
    if (!keys || !keys.length || !command('KEYS ' + id + ' ' + keys.join(' '))) return res(false);
    const t = setTimeout(() => { pendingKeys.delete(id); res(false); }, 4000);
    pendingKeys.set(id, ok => { clearTimeout(t); res(ok !== false); });
  });
}

// (beta.6) Boxshelf's black cover is up (a game starting or closing) / lifted: while it's up the helper keeps it over the
// game's windows and the taskbar, and doesn't take the game's window closing as the game ending
function cover(on) { return command('COVER ' + (on ? 1 : 0)); }
// (beta.6) Hide / show the taskbar. The running helper does it within one pass (~40 ms, answered); with none running, a
// one-off PowerShell does (the cached helper DLL when there is one, a few lines compiled otherwise). Resolves when done
// (or after a short wait: a launch never waits long for it).
let tbWait = null;
function taskbar(show) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (proc && cmdFile && command('TASKBAR ' + (show ? 1 : 0))) {
    if (tbWait) tbWait(false);
    return new Promise(res => { const t = setTimeout(() => { if (tbWait === done) tbWait = null; res(false); }, 400); const done = ok => { clearTimeout(t); res(ok); }; tbWait = done; });
  }
  return new Promise(res => {
    let p; const t = setTimeout(() => res(false), 2500);
    try { p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(taskbarPs(show), 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }); }
    catch (e) { clearTimeout(t); log('taskbar', e.message); return res(false); }
    p.on('exit', () => { clearTimeout(t); res(true); }); p.on('error', () => { clearTimeout(t); res(false); });
  });
}
// the same, waiting for it (Boxshelf quitting: the taskbar must be back before the process ends)
function taskbarSync(show) {
  if (process.platform !== 'win32') return;
  try { require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(taskbarPs(show), 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', timeout: 4000 }); } catch (e) { log('taskbar', e.message); }
}
// A watchdog while the taskbar is hidden. It keeps it hidden (every ~100 ms: Windows 11 shows it again by itself on some
// focus changes, e.g. as a game's window closes, also in the moments no controller helper runs), and if Boxshelf crashes
// or is ended from Task Manager it shows it again (every process Boxshelf starts goes into Node's kill-on-close job, so
// the helpers die with it). It quits by itself as soon as the marker file is gone (the taskbar shown normally). Started
// through a short-lived PowerShell (Start-Process): a grandchild breaks out of the job by itself (the job allows silent
// breakaway), while a detached PowerShell never ran.
function taskbarGuard(parentPid, marker) {
  if (process.platform !== 'win32') return;
  const t = taskbarType();
  const guard = `$ErrorActionPreference = 'SilentlyContinue'; $m = '${psq(marker)}'; $p = Get-Process -Id ${num(parentPid)}; ${t.load}\n` +
    `while (Test-Path -LiteralPath $m) { if (-not $p -or $p.WaitForExit(100)) { ${t.call(true)}; Remove-Item -LiteralPath $m; break }; if (Test-Path -LiteralPath $m) { ${t.call(false)} } }`;
  const step = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${Buffer.from(guard, 'utf16le').toString('base64')}'`;
  try { const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(step, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }); p.on('error', () => {}); } catch (e) { log('taskbar guard', e.message); }
}
// the taskbar's hide / show in PowerShell: the cached helper DLL when there is one, else a few lines compiled on the spot
function taskbarType() {
  const d = dllPath(), fs = require('fs'), on = v => v ? '$true' : '$false';
  if (d && fs.existsSync(d)) return { load: `Add-Type -Path '${psq(d)}'`, call: v => `[void][XI]::Taskbar(${on(v)})` };
  return { load: `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BxTb { [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n); [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h); static void One(IntPtr h, bool show) { if (h != IntPtr.Zero && IsWindowVisible(h) != show) ShowWindowAsync(h, show ? 8 : 0); } public static void Set(bool show) { One(FindWindowEx(IntPtr.Zero, IntPtr.Zero, "Shell_TrayWnd", null), show); IntPtr s = IntPtr.Zero; for (int i = 0; i < 16; i++) { s = FindWindowEx(IntPtr.Zero, s, "Shell_SecondaryTrayWnd", null); if (s == IntPtr.Zero) break; One(s, show); } } }'`,
    call: v => `[BxTb]::Set(${on(v)})` };
}
function taskbarPs(show) { const t = taskbarType(); return `$ErrorActionPreference = 'SilentlyContinue'; ${t.load}; ${t.call(show)}`; }

const isRunning = () => !!proc;
// Boxshelf's own window handle (decimal string): kept below a running game (see Sink in the helper)
let selfHwnd = '0'; function setSelf(hwnd) { selfHwnd = String(hwnd || '0'); }
// the last Home came from a Nintendo pad (slot 4): the Home menu then follows its A/B layout under Confirm "Match my controller"
let homeNin = false; const homeFromNintendo = () => homeNin;
module.exports = { init, start, stop, isRunning, setMenu, sendKeys, COMBOS, front, focusWindow, focusOnce, focusPending, homeFromNintendo, setSelf, cover, taskbar, taskbarSync, taskbarGuard };
