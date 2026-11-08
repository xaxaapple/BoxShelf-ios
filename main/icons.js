// App icons for the shelf: the icon Windows shows for an .exe (Stremio, Nuvio, Dolphin, Eden…),
// pulled out at the largest size the program ships and saved as data\icons\<name>.png.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

let dir = null, log = () => {};
const pending = new Map(), failed = new Set(); // failed: not retried for the rest of the session (each try is a slow PowerShell)
function init(dataDir, logger) { dir = path.join(dataDir, 'icons'); if (logger) log = logger; }
function folder() { return dir; }

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Drawing;
public class IconX {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct SHFILEINFO { public IntPtr hIcon; public int iIcon; public uint dwAttributes; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szDisplayName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string szTypeName; }
  [DllImport("shell32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SHGetFileInfo(string pszPath, uint attr, ref SHFILEINFO psfi, uint cb, uint flags);
  [DllImport("shell32.dll", EntryPoint="#727")] public static extern int SHGetImageList(int iImageList, ref Guid riid, out IImageList ppv);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IImageList { int Add(IntPtr a, IntPtr b, ref int c); int ReplaceIcon(int a, IntPtr b, ref int c); int SetOverlayImage(int a, int b); int Replace(int a, IntPtr b, IntPtr c); int AddMasked(IntPtr a, int b, ref int c); int Draw(IntPtr a); int Remove(int a); int GetIcon(int i, int flags, ref IntPtr picon); }
  public static Bitmap Get(string path, int which) {
    SHFILEINFO sfi = new SHFILEINFO(); SHGetFileInfo(path, 0, ref sfi, (uint)Marshal.SizeOf(sfi), 0x4000);
    Guid g = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"); IImageList il; SHGetImageList(which, ref g, out il);
    IntPtr h = IntPtr.Zero; il.GetIcon(sfi.iIcon, 1, ref h);
    if (h == IntPtr.Zero) return null;
    Bitmap b = Icon.FromHandle(h).ToBitmap(); DestroyIcon(h); return b; }
}
"@
# paths come in through the environment: spliced into the code, a name with ' or ‘ ’ (quotes to PowerShell too) could run code
$src = $env:BS_ICON_SRC; $dst = $env:BS_ICON_DST
$b = [IconX]::Get($src, 4)   # SHIL_JUMBO (256)
# small icons come back drawn in the corner of a 256 canvas: crop to the painted area
function Crop($bmp) {
  $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bmp.Height; $y += 2) { for ($x = 0; $x -lt $bmp.Width; $x += 2) { if ($bmp.GetPixel($x, $y).A -gt 8) { if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }; if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y } } } }
  if ($maxX -lt 0) { return $bmp }
  $x0 = [Math]::Max(0, $minX - 1); $y0 = [Math]::Max(0, $minY - 1)
  $x1 = [Math]::Min($bmp.Width, $maxX + 3); $y1 = [Math]::Min($bmp.Height, $maxY + 3)
  if (($x1 - $x0) -ge ($bmp.Width - 2) -and ($y1 - $y0) -ge ($bmp.Height - 2)) { return $bmp }
  $r = New-Object System.Drawing.Rectangle $x0, $y0, ($x1 - $x0), ($y1 - $y0)
  return $bmp.Clone($r, $bmp.PixelFormat)
}
if ($b -eq $null) { $b = [IconX]::Get($src, 2) }   # SHIL_EXTRALARGE (48)
if ($b -eq $null) { $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($src); $b = $ico.ToBitmap() }
$c = Crop $b
if ($c.Width -lt 40) { $c = $b }
$c.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("OK " + $c.Width + "x" + $c.Height)
`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64'); // the same for every exe now

// Resolves to the PNG path (or null). Cached per exe path + size + mtime.
function iconFor(exe) {
  if (!exe || !dir || process.platform !== 'win32') return Promise.resolve(null);
  let st; try { st = fs.statSync(exe); } catch { return Promise.resolve(null); }
  const key = crypto.createHash('md5').update(exe.toLowerCase() + '|' + st.size + '|' + Math.floor(st.mtimeMs)).digest('hex').slice(0, 16);
  const out = path.join(dir, `${path.basename(exe, path.extname(exe)).replace(/[^\w.-]+/g, '_')}-${key}.png`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (pending.has(out)) return pending.get(out);
  if (failed.has(out)) return Promise.resolve(null);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`; // (beta.10) PowerShell saves here, renamed in only once it exited cleanly: a cut-off PNG was the icon from then on
  const p = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED], { windowsHide: true, timeout: 30000, env: { ...process.env, BS_ICON_SRC: exe, BS_ICON_DST: tmp } }, (err, stdout, stderr) => {
      let ok = !err && fs.existsSync(tmp); if (ok) { try { fs.renameSync(tmp, out); } catch (e) { ok = false; err = e; } }
      if (!ok) { try { fs.unlinkSync(tmp); } catch {} const msgs = [...String(stderr || '').matchAll(/<S S="Error">([^<]*)<\/S>/g)].map(m => m[1]).join(' ').replace(/_x000D__x000A_/g, ' ').slice(0, 400); log('icon failed for', exe, msgs || (err && err.message || '').slice(0, 200)); failed.add(out); resolve(null); }
      else { log('icon', path.basename(exe), String(stdout).trim()); resolve(out); }
    });
  }).finally(() => pending.delete(out));
  pending.set(out, p);
  return p;
}

module.exports = { init, iconFor, folder };
