// TurtlePlugin-DSH_ComputerUSE — native driver
// Window enumeration, DPI handling, screen capture and desktop-session probing.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace TurtleComputerUse
{
    /// <summary>Everything the driver knows about one top-level window.</summary>
    internal sealed class WindowInfo
    {
        public IntPtr Handle;
        public uint Pid;
        public string ExePath = "";
        public string ExeName = "";
        public string AppId = "";
        public string Title = "";
        public string ClassName = "";
        public Win32.RECT Bounds;
        public Win32.RECT ClientBounds;
        public bool Visible;
        public bool Minimized;
        public bool Maximized;
        public bool Enabled;
        public bool Elevated;
        public uint Session;
        public bool OffScreen;

        public int Width { get { return Math.Max(0, Bounds.Right - Bounds.Left); } }
        public int Height { get { return Math.Max(0, Bounds.Bottom - Bounds.Top); } }

        public Dictionary<string, object> ToJson(bool withGeometry = true)
        {
            var o = Json.NewObject();
            o["hwnd"] = Handle.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
            o["pid"] = (int)Pid;
            o["exe"] = ExeName;
            o["exePath"] = ExePath;
            o["appId"] = AppId;
            o["title"] = Title;
            o["className"] = ClassName;
            o["minimized"] = Minimized;
            o["maximized"] = Maximized;
            o["enabled"] = Enabled;
            o["elevated"] = Elevated;
            o["offscreen"] = OffScreen;
            if (withGeometry)
            {
                o["bounds"] = Rect(Bounds);
                o["clientBounds"] = Rect(ClientBounds);
            }
            return o;
        }

        public static Dictionary<string, object> Rect(Win32.RECT r)
        {
            var o = Json.NewObject();
            o["x"] = r.Left; o["y"] = r.Top;
            o["width"] = Math.Max(0, r.Right - r.Left);
            o["height"] = Math.Max(0, r.Bottom - r.Top);
            return o;
        }
    }

    /// <summary>Window/app discovery plus capture. Stateless; safe to call from the RPC thread.</summary>
    internal static class Windows
    {
        /// <summary>Normalise an executable leaf name into a stable, comparable application id.</summary>
        public static string NormalizeAppId(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            var s = value.Trim();
            if (s.StartsWith("process:", StringComparison.OrdinalIgnoreCase)) s = s.Substring(8);
            var slash = Math.Max(s.LastIndexOf('\\'), s.LastIndexOf('/'));
            if (slash >= 0) s = s.Substring(slash + 1);
            if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) s = s.Substring(0, s.Length - 4);
            return s.ToLowerInvariant();
        }

        public static string ExeNameOf(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            var slash = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
            return slash >= 0 ? path.Substring(slash + 1) : path;
        }

        /// <summary>Enumerate every visible, titled, non-tool top-level window.</summary>
        public static List<WindowInfo> ListWindows(bool includeUntitled = false)
        {
            var results = new List<WindowInfo>();
            var self = Win32.GetCurrentProcessId();
            Win32.EnumWindows((hwnd, _) =>
            {
                if (!Win32.IsWindowVisible(hwnd)) return true;
                var exStyle = Win32.GetWindowLongPtrW(hwnd, Win32.GWL_EXSTYLE).ToInt64();
                if ((exStyle & Win32.WS_EX_TOOLWINDOW) != 0) return true;

                var len = Win32.GetWindowTextLengthW(hwnd);
                string title = "";
                if (len > 0)
                {
                    var sb = new StringBuilder(len + 2);
                    Win32.GetWindowTextW(hwnd, sb, sb.Capacity);
                    title = sb.ToString();
                }
                if (title.Length == 0 && !includeUntitled) return true;

                uint pid;
                Win32.GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0 || pid == self) return true;

                var info = Describe(hwnd, pid);
                if (info == null) return true;
                info.Title = title;
                results.Add(info);
                return true;
            }, IntPtr.Zero);
            return results;
        }

        /// <summary>Describe one window by handle, or null when it is gone.</summary>
        public static WindowInfo Describe(IntPtr hwnd, uint pid = 0)
        {
            if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return null;
            if (pid == 0) Win32.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) return null;

            var exePath = Win32.ProcessImagePath(pid) ?? "";
            var info = new WindowInfo
            {
                Handle = hwnd,
                Pid = pid,
                ExePath = exePath,
                ExeName = ExeNameOf(exePath),
                AppId = NormalizeAppId(ExeNameOf(exePath)),
                Visible = Win32.IsWindowVisible(hwnd),
                Minimized = Win32.IsIconic(hwnd),
                Maximized = Win32.IsZoomed(hwnd),
                Enabled = Win32.IsWindowEnabled(hwnd),
                Session = Win32.ProcessSession(pid),
                Elevated = ProcessGuard.IsProcessElevated(pid),
            };

            var sbClass = new StringBuilder(256);
            Win32.GetClassNameW(hwnd, sbClass, sbClass.Capacity);
            info.ClassName = sbClass.ToString();

            Win32.RECT rect;
            info.Bounds = Win32.GetWindowRect(hwnd, out rect) ? rect : new Win32.RECT();
            Win32.RECT ext;
            if (Win32.DwmGetWindowAttribute(hwnd, Win32.DWMWA_EXTENDED_FRAME_BOUNDS, out ext, Marshal.SizeOf(typeof(Win32.RECT))) == 0)
                info.Bounds = ext;

            Win32.RECT client;
            if (Win32.GetClientRect(hwnd, out client))
            {
                var tl = new Win32.POINT { X = 0, Y = 0 };
                Win32.ClientToScreen(hwnd, ref tl);
                info.ClientBounds = new Win32.RECT
                {
                    Left = tl.X,
                    Top = tl.Y,
                    Right = tl.X + (client.Right - client.Left),
                    Bottom = tl.Y + (client.Bottom - client.Top),
                };
            }
            else
            {
                info.ClientBounds = info.Bounds;
            }

            var vsLeft = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
            var vsTop = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
            var vsRight = vsLeft + Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
            var vsBottom = vsTop + Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
            info.OffScreen = info.Bounds.Right <= vsLeft || info.Bounds.Left >= vsRight
                             || info.Bounds.Bottom <= vsTop || info.Bounds.Top >= vsBottom;
            return info;
        }

        /// <summary>The topmost window for an app id, preferring the foreground and then the largest.</summary>
        public static WindowInfo FindForApp(string appId, List<WindowInfo> pool = null)
        {
            var target = NormalizeAppId(appId);
            if (target.Length == 0) return null;
            var windows = pool ?? ListWindows(true);
            var fg = Win32.GetForegroundWindow();
            WindowInfo best = null;
            foreach (var w in windows)
            {
                if (w.AppId != target) continue;
                if (w.Handle == fg) return w;
                if (best == null || w.Width * w.Height > best.Width * best.Height) best = w;
            }
            return best;
        }

        /// <summary>Group windows by application id, largest window first.</summary>
        public static List<Dictionary<string, object>> ListApps()
        {
            var byApp = new Dictionary<string, List<WindowInfo>>(StringComparer.Ordinal);
            foreach (var w in ListWindows())
            {
                if (w.AppId.Length == 0) continue;
                List<WindowInfo> bucket;
                if (!byApp.TryGetValue(w.AppId, out bucket)) { bucket = new List<WindowInfo>(); byApp[w.AppId] = bucket; }
                bucket.Add(w);
            }
            var fg = Win32.GetForegroundWindow();
            var apps = new List<Dictionary<string, object>>();
            foreach (var pair in byApp)
            {
                var windows = pair.Value;
                windows.Sort((a, b) =>
                {
                    if (a.Handle == fg) return -1;
                    if (b.Handle == fg) return 1;
                    return (b.Width * b.Height).CompareTo(a.Width * a.Height);
                });
                var primary = windows[0];
                var o = Json.NewObject();
                o["appId"] = pair.Key;
                o["exe"] = primary.ExeName;
                o["exePath"] = primary.ExePath;
                o["pid"] = (int)primary.Pid;
                o["elevated"] = primary.Elevated;
                o["title"] = primary.Title;
                o["hwnd"] = primary.Handle.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                o["windowCount"] = windows.Count;
                o["foreground"] = primary.Handle == fg;
                var titles = new List<object>();
                foreach (var w in windows)
                {
                    if (titles.Count >= 8) break;
                    titles.Add(w.Title);
                }
                o["titles"] = titles;
                apps.Add(o);
            }
            apps.Sort((a, b) => string.CompareOrdinal((string)a["appId"], (string)b["appId"]));
            return apps;
        }

        /// <summary>Capture a window with PrintWindow, falling back to a covered-region BitBlt.</summary>
        public static CaptureResult CaptureWindow(WindowInfo window, double scale)
        {
            if (window.Minimized)
                throw new ProtocolException("window_minimized",
                    "The target window is minimized, so it has no pixels to capture. Restore it first, or request captureMode=\"ax\" and drive it through the accessibility tree.");

            int w = window.Width, h = window.Height;
            if (w <= 0 || h <= 0)
                throw new ProtocolException("window_empty", "The target window has an empty rectangle.");

            // PrintWindow first: it renders the window itself, so it is exact and
            // it cannot be confused by another window sitting on top.
            var hdcWindow = Win32.GetWindowDC(window.Handle);
            if (hdcWindow != IntPtr.Zero)
            {
                try
                {
                    using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                    {
                        using (var g = Graphics.FromImage(bmp))
                        {
                            var hdcMem = g.GetHdc();
                            var printed = false;
                            try { printed = Win32.PrintWindow(window.Handle, hdcMem, Win32.PW_RENDERFULLCONTENT); }
                            finally { g.ReleaseHdc(hdcMem); }
                            if (printed && !IsBlank(bmp))
                            {
                                return new CaptureResult
                                {
                                    Bitmap = Scale(bmp, scale),
                                    Backend = "printwindow",
                                    Covered = false,
                                    Window = window,
                                };
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    App.Log("capture: PrintWindow failed: " + ex.Message);
                }
                finally { Win32.ReleaseDC(window.Handle, hdcWindow); }
            }

            var screen = CaptureRegion(window.Bounds.Left, window.Bounds.Top, w, h, scale, window);
            screen.Covered = true;
            screen.Note = "PrintWindow returned a blank frame (this window draws through DirectComposition, WinUI 3 or a GPU surface). " +
                          "This is a screen-region copy instead, so it may show whatever window is on top — and it cannot tell you which.";
            return screen;
        }

        /// <summary>
        /// BitBlt a rectangle off the screen into a top-down 32-bit DIB.
        ///
        /// Done with GDI rather than Graphics.CopyFromScreen because the managed
        /// overload rejects `SourceCopy | CaptureBlt` as an undefined enum value.
        /// </summary>
        public static CaptureResult CaptureRegion(int x, int y, int width, int height, double scale, WindowInfo window = null)
        {
            int w = Math.Max(1, width), h = Math.Max(1, height);
            var bmi = new Win32.BITMAPINFO
            {
                bmiHeader = new Win32.BITMAPINFOHEADER
                {
                    biSize = Marshal.SizeOf(typeof(Win32.BITMAPINFOHEADER)),
                    biWidth = w,
                    biHeight = -h,
                    biPlanes = 1,
                    biBitCount = 32,
                    biCompression = 0,
                },
                bmiColors = new uint[256],
            };

            IntPtr screenDc = Win32.GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero)
                throw new ProtocolException("capture_failed", "Could not obtain a screen device context.");
            IntPtr memDc = IntPtr.Zero, dib = IntPtr.Zero, old = IntPtr.Zero, bits = IntPtr.Zero;
            try
            {
                memDc = Win32.CreateCompatibleDC(screenDc);
                dib = Win32.CreateDIBSection(memDc, ref bmi, Win32.DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
                if (dib == IntPtr.Zero || bits == IntPtr.Zero)
                    throw new ProtocolException("capture_failed", "Could not allocate a " + w + "x" + h + " capture surface (Win32 error " + Marshal.GetLastWin32Error() + ").");
                old = Win32.SelectObject(memDc, dib);
                if (!Win32.BitBlt(memDc, 0, 0, w, h, screenDc, x, y, Win32.SRCCOPY | Win32.CAPTUREBLT))
                    throw new ProtocolException("capture_failed", "BitBlt failed (Win32 error " + Marshal.GetLastWin32Error() + ").");

                Bitmap copy;
                using (var raw = new Bitmap(w, h, w * 4, PixelFormat.Format32bppRgb, bits))
                {
                    copy = new Bitmap(raw);
                }
                var blank = IsBlank(copy);
                return new CaptureResult
                {
                    Bitmap = Scale(copy, scale),
                    Backend = "bitblt",
                    Covered = blank,
                    Note = blank ? "The captured region is almost entirely black; the desktop may be locked, or the window uses hardware-composited rendering that BitBlt cannot read." : null,
                    Window = window,
                };
            }
            finally
            {
                if (old != IntPtr.Zero) Win32.SelectObject(memDc, old);
                if (dib != IntPtr.Zero) Win32.DeleteObject(dib);
                if (memDc != IntPtr.Zero) Win32.DeleteDC(memDc);
                Win32.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        /// <summary>Capture the whole virtual screen.</summary>
        public static CaptureResult CaptureScreen(double scale)
        {
            int x = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
            int y = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
            int w = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
            int h = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
            var result = CaptureRegion(x, y, w, h, scale);
            result.ScreenOriginX = x;
            result.ScreenOriginY = y;
            return result;
        }

        /// <summary>
        /// Return an independent bitmap at the requested scale and release the source.
        ///
        /// Always a copy, even at scale 1: callers hold the source inside a `using`
        /// block, so returning it unchanged would hand back a disposed image and
        /// the PNG encoder would fail with an opaque "invalid parameter".
        /// </summary>
        private static Bitmap Scale(Bitmap source, double scale)
        {
            int w = Math.Max(1, (int)Math.Round(source.Width * (scale <= 0 ? 1 : scale)));
            int h = Math.Max(1, (int)Math.Round(source.Height * (scale <= 0 ? 1 : scale)));
            var target = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            try
            {
                using (var g = Graphics.FromImage(target))
                {
                    if (Math.Abs((scale <= 0 ? 1 : scale) - 1.0) < 0.001)
                    {
                        g.DrawImageUnscaled(source, 0, 0);
                    }
                    else
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                        g.DrawImage(source, 0, 0, w, h);
                    }
                }
            }
            finally
            {
                source.Dispose();
            }
            return target;
        }

        /// <summary>Whether a capture is almost entirely black, which usually means the surface was not really rendered.</summary>
        private static bool IsBlank(Bitmap bmp)
        {
            int dark = 0, total = 0;
            int stepX = Math.Max(1, bmp.Width / 32);
            int stepY = Math.Max(1, bmp.Height / 32);
            for (int y = 0; y < bmp.Height; y += stepY)
            {
                for (int x = 0; x < bmp.Width; x += stepX)
                {
                    var c = bmp.GetPixel(x, y);
                    total++;
                    if (c.R < 12 && c.G < 12 && c.B < 12) dark++;
                }
            }
            return total > 0 && dark >= total * 0.985;
        }

        /// <summary>Encode a bitmap as PNG bytes.</summary>
        public static byte[] ToPng(Bitmap bmp)
        {
            using (var ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }
    }

    internal sealed class CaptureResult : IDisposable
    {
        public Bitmap Bitmap;
        public string Backend;
        public bool Covered;
        public string Note;
        public WindowInfo Window;
        public int ScreenOriginX;
        public int ScreenOriginY;

        public Dictionary<string, object> ToJson(double scale)
        {
            var bytes = Windows.ToPng(Bitmap);
            var o = Json.NewObject();
            o["mime"] = "image/png";
            o["base64"] = Convert.ToBase64String(bytes);
            o["width"] = Bitmap.Width;
            o["height"] = Bitmap.Height;
            o["scale"] = scale;
            o["backend"] = Backend;
            o["covered"] = Covered;
            if (Note != null) o["note"] = Note;
            if (Window != null)
            {
                o["originX"] = Window.Bounds.Left;
                o["originY"] = Window.Bounds.Top;
                o["hwnd"] = Window.Handle.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
                o["appId"] = Window.AppId;
                o["title"] = Window.Title;
            }
            else
            {
                o["originX"] = ScreenOriginX;
                o["originY"] = ScreenOriginY;
            }
            o["byteLength"] = bytes.Length;
            return o;
        }

        public void Dispose()
        {
            if (Bitmap != null) { Bitmap.Dispose(); Bitmap = null; }
        }
    }

    /// <summary>Elevation, desktop-session and lock-state probes shared by policy and actions.</summary>
    internal static class ProcessGuard
    {
        private static readonly Dictionary<uint, bool> ElevatedCache = new Dictionary<uint, bool>();

        public static bool IsProcessElevated(uint pid)
        {
            bool cached;
            if (ElevatedCache.TryGetValue(pid, out cached)) return cached;
            var value = Probe(pid);
            if (ElevatedCache.Count > 512) ElevatedCache.Clear();
            ElevatedCache[pid] = value;
            return value;
        }

        private static bool Probe(uint pid)
        {
            IntPtr h = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return false;
            try
            {
                IntPtr token;
                if (!OpenProcessToken(h, 0x0008 /* TOKEN_QUERY */, out token)) return false;
                try
                {
                    int size;
                    GetTokenInformation(token, 20 /* TokenElevation */, IntPtr.Zero, 0, out size);
                    if (size <= 0) return false;
                    var buffer = Marshal.AllocHGlobal(size);
                    try
                    {
                        if (!GetTokenInformation(token, 20, buffer, size, out size)) return false;
                        return Marshal.ReadInt32(buffer) != 0;
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
                finally { Win32.CloseHandle(token); }
            }
            catch { return false; }
            finally { Win32.CloseHandle(h); }
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass,
            IntPtr tokenInformation, int tokenInformationLength, out int returnLength);

        /// <summary>Whether this driver process runs elevated (and can therefore drive elevated windows).</summary>
        public static bool SelfElevated
        {
            get
            {
                try
                {
                    var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
                    var principal = new System.Security.Principal.WindowsPrincipal(identity);
                    return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
                }
                catch { return false; }
            }
        }

        /// <summary>Name of the desktop that currently receives input, or null when it cannot be read.</summary>
        public static string InputDesktopName()
        {
            IntPtr desktop = Win32.OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */ | 0x0100 /* DESKTOP_SWITCHDESKTOP */);
            if (desktop == IntPtr.Zero) return null;
            try
            {
                uint needed;
                var buffer = new byte[512];
                if (!Win32.GetUserObjectInformationW(desktop, 2 /* UOI_NAME */, buffer, (uint)buffer.Length, out needed))
                    return null;
                var length = 0;
                while (length + 1 < buffer.Length && !(buffer[length] == 0 && buffer[length + 1] == 0)) length += 2;
                if (length == 0) return "";
                return Encoding.Unicode.GetString(buffer, 0, length);
            }
            finally { Win32.CloseDesktop(desktop); }
        }

        /// <summary>
        /// Whether the interactive desktop is locked or switched away.
        /// Deliberately conservative: a false positive would block every Computer
        /// Use action, so only a positively different input desktop counts.
        /// </summary>
        public static bool DesktopLocked()
        {
            var name = InputDesktopName();
            if (name == null) return true;               // OpenInputDesktop itself failed: the session is not attached
            if (name.Length == 0) return false;          // unreadable name: do not block on a guess
            if (name.Equals("Default", StringComparison.OrdinalIgnoreCase)) return false;
            // "Winlogon" is the lock screen; anything else non-default is a
            // separate desktop (screensaver, secure desktop, another session).
            return name.Equals("Winlogon", StringComparison.OrdinalIgnoreCase)
                   || name.IndexOf("Logon", StringComparison.OrdinalIgnoreCase) >= 0
                   || name.IndexOf("Screen-saver", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>Whether the current process shares the interactive session with the shell.</summary>
        public static bool InInteractiveSession()
        {
            uint self;
            if (!Win32.ProcessIdToSessionId(Win32.GetCurrentProcessId(), out self)) return true;
            var console = Win32.WTSGetActiveConsoleSessionId();
            if (console == 0xFFFFFFFF) return true;
            return self == console;
        }
    }
}
