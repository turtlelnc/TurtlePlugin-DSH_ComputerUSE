// TurtlePlugin-DSH_ComputerUSE — native driver
// The synthetic cursor: the visible cursor an agent gets in background mode.
//
// It is painted by this driver into a transparent, click-through, never-activated
// layered window that spans the virtual screen. It is kept separate from the
// user's physical pointer, so a background run does not move the real mouse.
// The action underneath may be a UIA pattern, a window message, or SendInput;
// the cursor is the trace, not the mechanism.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

namespace TurtleComputerUse
{
    internal enum CursorState { Hidden, Idle, Moving, Clicking }

    /// <summary>Commands handed from the RPC thread to the overlay's UI thread.</summary>
    internal sealed class CursorCommand
    {
        public string Kind;
        public int X, Y;
        public string Label;
        public bool Horizontal;
    }

    internal static class CursorOverlay
    {
        private const int WM_APP_TICK = 0x8000 + 1;
        private const int TimerIdle = 1;

        private static Thread _thread;
        private static IntPtr _hwnd = IntPtr.Zero;
        private static Win32.WndProcDelegate _wndProc;
        private static readonly ConcurrentQueue<CursorCommand> Queue = new ConcurrentQueue<CursorCommand>();
        private static readonly ManualResetEventSlim Ready = new ManualResetEventSlim(false);

        private static volatile bool _running;
        private static bool _visible;
        private static int _x, _y;
        private static int _targetX, _targetY;
        private static int _anchorX, _anchorY;
        private static DateTime _lastCommand = DateTime.UtcNow;
        private static DateTime _rippleStart = DateTime.MinValue;
        private static int _idleHideMs = 0;
        private static double _opacity = 1.0;
        private static string _label;

        private static int _screenX, _screenY, _screenW, _screenH;
        private static volatile bool _enabled = true;

        /// <summary>Apply the host's cursor settings. Disabling hides the overlay and stops drawing.</summary>
        public static void Configure(bool enabled, int idleHideMs)
        {
            _idleHideMs = Math.Max(0, idleHideMs);
            if (_enabled == enabled) return;
            _enabled = enabled;
            if (!enabled) Hide();
        }

        /// <summary>Start the overlay thread. Safe to call repeatedly.</summary>
        public static void Start(int idleHideMs)
        {
            _idleHideMs = idleHideMs;
            if (_running) return;
            _running = true;
            _thread = new Thread(Loop) { IsBackground = true, Name = "turtle-cursor" };
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
            Ready.Wait(4000);
        }

        public static void Stop()
        {
            if (!_running) return;
            _running = false;
            var hwnd = _hwnd;
            if (hwnd != IntPtr.Zero) Win32.PostMessageW(hwnd, WM_APP_TICK, IntPtr.Zero, IntPtr.Zero);
        }

        public static void Show()
        {
            if (!_enabled) return;
            Ensure();
            Queue.Enqueue(new CursorCommand { Kind = "show" });
            Wake();
        }

        public static void Hide()
        {
            Queue.Enqueue(new CursorCommand { Kind = "hide" });
            Wake();
        }

        public static void Move(int x, int y, string label)
        {
            if (!_enabled) return;
            Ensure();
            Queue.Enqueue(new CursorCommand { Kind = "move", X = x, Y = y, Label = label });
            Wake();
        }

        public static void Click(int x, int y, string label)
        {
            if (!_enabled) return;
            Ensure();
            Queue.Enqueue(new CursorCommand { Kind = "click", X = x, Y = y, Label = label });
            Wake();
        }

        public static void Scroll(int x, int y, bool horizontal)
        {
            if (!_enabled) return;
            Ensure();
            Queue.Enqueue(new CursorCommand { Kind = "scroll", X = x, Y = y, Horizontal = horizontal });
            Wake();
        }

        /// <summary>Hide the overlay while a screen-region capture runs, then restore it.</summary>
        public static IDisposable SuspendForCapture()
        {
            if (!_running || !_visible) return new NoopScope();
            var wasVisible = _visible;
            Hide();
            Thread.Sleep(30);
            return new RestoreScope(wasVisible);
        }

        private static void Ensure()
        {
            if (!_running) Start(_idleHideMs);
        }

        private static void Wake()
        {
            var hwnd = _hwnd;
            if (hwnd != IntPtr.Zero) Win32.PostMessageW(hwnd, WM_APP_TICK, IntPtr.Zero, IntPtr.Zero);
        }

        private sealed class NoopScope : IDisposable { public void Dispose() { } }

        private sealed class RestoreScope : IDisposable
        {
            private readonly bool _restore;
            public RestoreScope(bool restore) { _restore = restore; }
            public void Dispose() { if (_restore) Show(); }
        }

        // ------------------------------------------------------------------ UI thread

        private static void Loop()
        {
            try
            {
                _wndProc = WndProc;
                var wc = new Win32.WNDCLASS
                {
                    lpfnWndProc = _wndProc,
                    hInstance = Win32.GetModuleHandleW(null),
                    lpszClassName = "TurtleComputerUseSyntheticCursor",
                };
                Win32.RegisterClassW(ref wc);

                _screenX = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
                _screenY = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
                _screenW = Math.Max(1, Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN));
                _screenH = Math.Max(1, Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN));

                _hwnd = Win32.CreateWindowExW(
                    Win32.WS_EX_LAYERED | Win32.WS_EX_TRANSPARENT | Win32.WS_EX_TOOLWINDOW | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TOPMOST,
                    wc.lpszClassName, "TurtlePlugin Computer Use cursor",
                    0x80000000 /* WS_POPUP */ | Win32.WS_VISIBLE,
                    _screenX, _screenY, _screenW, _screenH,
                    IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);

                if (_hwnd == IntPtr.Zero)
                {
                    App.Log("cursor: could not create the overlay window (Win32 error " + Marshal.GetLastWin32Error() + ")");
                    Ready.Set();
                    _running = false;
                    return;
                }

                // Start hidden: zero alpha everywhere.
                Paint(0.0);
                SetTimer(_hwnd, TimerIdle, 60, IntPtr.Zero);
                Ready.Set();

                while (_running)
                {
                    Win32.MSG msg;
                    if (!Win32.GetMessageW(out msg, IntPtr.Zero, 0, 0)) break;
                    Win32.TranslateMessage(ref msg);
                    Win32.DispatchMessageW(ref msg);
                }
                if (_hwnd != IntPtr.Zero) { KillTimer(_hwnd, TimerIdle); Win32.DestroyWindow(_hwnd); _hwnd = IntPtr.Zero; }
            }
            catch (Exception ex)
            {
                App.Log("cursor: overlay thread failed: " + ex);
                Ready.Set();
            }
            finally { _running = false; }
        }

        private static IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
        {
            switch (msg)
            {
                case WM_APP_TICK:
                    Drain();
                    return IntPtr.Zero;
                case 0x0113: // WM_TIMER
                    Tick();
                    return IntPtr.Zero;
                case 0x0002: // WM_DESTROY
                    Win32.PostQuitMessage(0);
                    return IntPtr.Zero;
                case 0x0084: // WM_NCHITTEST — stay click-through even if the style is ever lost
                    return new IntPtr(-1);
            }
            return Win32.DefWindowProcW(hWnd, msg, wParam, lParam);
        }

        private static void Drain()
        {
            CursorCommand cmd;
            while (Queue.TryDequeue(out cmd))
            {
                _lastCommand = DateTime.UtcNow;
                switch (cmd.Kind)
                {
                    case "show":
                        _visible = true;
                        _opacity = 1.0;
                        break;
                    case "hide":
                        _visible = false;
                        break;
                    case "move":
                        _targetX = cmd.X; _targetY = cmd.Y; _label = cmd.Label;
                        if (!_visible) { _x = cmd.X; _y = cmd.Y; }
                        _visible = true;
                        _opacity = 1.0;
                        break;
                    case "click":
                        _targetX = cmd.X; _targetY = cmd.Y; _label = cmd.Label;
                        if (!_visible) { _x = cmd.X; _y = cmd.Y; }
                        _visible = true;
                        _opacity = 1.0;
                        _anchorX = cmd.X; _anchorY = cmd.Y;
                        _rippleStart = DateTime.UtcNow;
                        break;
                    case "scroll":
                        _targetX = cmd.X; _targetY = cmd.Y;
                        _visible = true;
                        _opacity = 1.0;
                        _anchorX = cmd.X; _anchorY = cmd.Y;
                        _rippleStart = DateTime.UtcNow;
                        break;
                }
            }
            Advance(animate: true);
        }

        private static void Tick()
        {
            Advance(animate: false);
        }

        private static void Advance(bool animate)
        {
            if (_hwnd == IntPtr.Zero) return;

            bool moving = _x != _targetX || _y != _targetY;
            if (moving)
            {
                var dx = _targetX - _x;
                var dy = _targetY - _y;
                var stepX = Math.Sign(dx) * Math.Max(1, (int)Math.Ceiling(Math.Abs(dx) / 4.0));
                var stepY = Math.Sign(dy) * Math.Max(1, (int)Math.Ceiling(Math.Abs(dy) / 4.0));
                if (Math.Abs(stepX) > Math.Abs(dx)) stepX = dx;
                if (Math.Abs(stepY) > Math.Abs(dy)) stepY = dy;
                _x += stepX;
                _y += stepY;
            }

            var rippleAge = (DateTime.UtcNow - _rippleStart).TotalMilliseconds;
            bool rippling = rippleAge < 420;

            if (_idleHideMs > 0 && _visible && !moving && !rippling)
            {
                var idle = (DateTime.UtcNow - _lastCommand).TotalMilliseconds;
                if (idle > _idleHideMs) { _visible = false; }
                else if (idle > _idleHideMs * 0.6) _opacity = Math.Max(0.15, 1.0 - (idle - _idleHideMs * 0.6) / (_idleHideMs * 0.4));
            }

            if (_visible && _opacity < 1.0) _opacity = Math.Min(1.0, _opacity + 0.12);

            if (!_visible)
            {
                Paint(0.0);
                return;
            }

            Paint(_opacity);
            if (moving || rippling || (!animate && _opacity < 1.0))
            {
                // keep the animation clock running
                if (moving || rippling) Win32.PostMessageW(_hwnd, WM_APP_TICK, IntPtr.Zero, IntPtr.Zero);
            }
        }

        // ------------------------------------------------------------------ painting

        private static double _dpiScale = 1.0;

        private static void Paint(double opacity)
        {
            if (_hwnd == IntPtr.Zero) return;

            if (_dpiScale <= 0) _dpiScale = 1.0;
            if (Math.Abs(_dpiScale - 1.0) < 0.0001)
            {
                try { _dpiScale = Math.Max(1.0, Win32.GetDpiForSystem() / 96.0); }
                catch { _dpiScale = 1.0; }
            }

            int w = _screenW, h = _screenH;
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
            if (screenDc == IntPtr.Zero) return;
            IntPtr memDc = Win32.CreateCompatibleDC(screenDc);
            IntPtr bits;
            IntPtr dib = Win32.CreateDIBSection(memDc, ref bmi, Win32.DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
            IntPtr old = Win32.SelectObject(memDc, dib);
            IntPtr oldScreen = IntPtr.Zero;
            try
            {
                if (opacity > 0.001 && bits != IntPtr.Zero)
                {
                    using (var bmp = new Bitmap(w, h, w * 4, PixelFormat.Format32bppPArgb, bits))
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.CompositingMode = CompositingMode.SourceOver;
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        DrawCursor(g, opacity);
                    }
                }
                else if (bits != IntPtr.Zero)
                {
                    // zero the surface so the layered window becomes fully transparent
                    var size = w * h * 4;
                    var zeros = new byte[Math.Min(size, 1 << 20)];
                    for (int offset = 0; offset < size; offset += zeros.Length)
                    {
                        Marshal.Copy(zeros, 0, new IntPtr(bits.ToInt64() + offset), Math.Min(zeros.Length, size - offset));
                    }
                }

                var dst = new Win32.POINT { X = _screenX, Y = _screenY };
                var src = new Win32.POINT { X = 0, Y = 0 };
                var size2 = new Win32.SIZE { cx = w, cy = h };
                var blend = new Win32.BLENDFUNCTION
                {
                    BlendOp = Win32.AC_SRC_OVER,
                    BlendFlags = 0,
                    SourceConstantAlpha = 255,
                    AlphaFormat = Win32.AC_SRC_ALPHA,
                };
                Win32.UpdateLayeredWindow(_hwnd, screenDc, ref dst, ref size2, memDc, ref src, 0, ref blend, Win32.ULW_ALPHA);
            }
            finally
            {
                if (old != IntPtr.Zero) Win32.SelectObject(memDc, old);
                if (dib != IntPtr.Zero) Win32.DeleteObject(dib);
                if (memDc != IntPtr.Zero) Win32.DeleteDC(memDc);
                Win32.ReleaseDC(IntPtr.Zero, screenDc);
                GC.KeepAlive(oldScreen);
            }
        }

        private static void DrawCursor(Graphics g, double opacity)
        {
            var scale = _dpiScale;
            float cx = _x - _screenX;
            float cy = _y - _screenY;

            var rippleAge = (DateTime.UtcNow - _rippleStart).TotalMilliseconds;
            if (rippleAge < 420)
            {
                var t = rippleAge / 420.0;
                var radius = (float)(10 + 34 * t) * (float)scale;
                var alpha = (int)(150 * (1 - t) * opacity);
                if (alpha > 0)
                {
                    using (var pen = new Pen(Color.FromArgb(alpha, 0x2F, 0x81, 0xF7), (float)(3.0 * scale)))
                    using (var brush = new SolidBrush(Color.FromArgb(alpha / 4, 0x2F, 0x81, 0xF7)))
                    {
                        g.DrawEllipse(pen, cx - radius, cy - radius, radius * 2, radius * 2);
                        g.FillEllipse(brush, cx - radius, cy - radius, radius * 2, radius * 2);
                    }
                }
            }

            var path = ArrowPath(cx, cy, (float)scale);
            using (var fill = new SolidBrush(Color.FromArgb((int)(255 * opacity), 255, 255, 255)))
            using (var outline = new Pen(Color.FromArgb((int)(235 * opacity), 16, 16, 20), Math.Max(1.1f, 1.4f * (float)scale)))
            {
                outline.LineJoin = LineJoin.Round;
                g.FillPath(fill, path);
                g.DrawPath(outline, path);
            }

            if (!string.IsNullOrEmpty(_label))
            {
                using (var font = new Font("Segoe UI", 8.5f * (float)scale, FontStyle.Regular, GraphicsUnit.Point))
                using (var textBrush = new SolidBrush(Color.FromArgb((int)(235 * opacity), 255, 255, 255)))
                using (var boxBrush = new SolidBrush(Color.FromArgb((int)(200 * opacity), 0x17, 0x1A, 0x21)))
                {
                    var size = g.MeasureString(_label, font);
                    var bx = cx + 14 * (float)scale;
                    var by = cy + 18 * (float)scale;
                    var rect = new RectangleF(bx, by, size.Width + 10, size.Height + 4);
                    using (var rounded = Rounded(rect, 4 * (float)scale))
                    {
                        g.FillPath(boxBrush, rounded);
                    }
                    g.DrawString(_label, font, textBrush, bx + 5, by + 2);
                }
            }
            path.Dispose();
        }

        private static GraphicsPath ArrowPath(float x, float y, float scale)
        {
            // A standard arrow pointer: tip at (0,0), tail down-right.
            var pts = new[]
            {
                new PointF(0f, 0f),
                new PointF(0f, 16.5f),
                new PointF(4.1f, 12.7f),
                new PointF(6.7f, 18.6f),
                new PointF(9.4f, 17.3f),
                new PointF(6.9f, 11.5f),
                new PointF(12.1f, 11.4f),
            };
            var path = new GraphicsPath();
            var scaled = new PointF[pts.Length];
            for (int i = 0; i < pts.Length; i++) scaled[i] = new PointF(x + pts[i].X * scale, y + pts[i].Y * scale);
            path.AddPolygon(scaled);
            path.CloseFigure();
            return path;
        }

        private static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            var d = radius * 2;
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr SetTimer(IntPtr hWnd, int nIDEvent, uint uElapse, IntPtr lpTimerFunc);

        [DllImport("user32.dll")]
        private static extern bool KillTimer(IntPtr hWnd, int nIDEvent);
    }
}
