// TurtlePlugin-DSH_ComputerUSE — native driver
// Input dispatch. Two backends with different contracts:
//   * background — UIA patterns, then targeted window messages (PostMessage).
//     Never touches the system input queue, so the user's mouse and keyboard
//     stay theirs. Reports `background_unavailable` instead of escalating.
//   * foreground — SendInput through the real system input queue after
//     activating the target window. This is the codex-computer-use behaviour:
//     the physical pointer really moves.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace TurtleComputerUse
{
    internal enum Button { Left, Right, Middle }

    internal static class Input
    {
        /// <summary>Whether the driver has a reason to believe foreground input is required.</summary>
        public static bool WindowIsChromiumLike(WindowInfo window)
        {
            if (window == null) return false;
            var cls = window.ClassName ?? "";
            if (cls.StartsWith("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase)) return true;
            if (cls.StartsWith("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase)) return true;
            var exe = window.AppId;
            switch (exe)
            {
                case "chrome":
                case "msedge":
                case "brave":
                case "opera":
                case "vivaldi":
                case "electron":
                case "code":
                case "discord":
                case "slack":
                case "teams":
                case "ms-teams":
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>Whether the window class is known to drop synthetic window messages.</summary>
        public static string KnownPostMessageBlocker(WindowInfo window)
        {
            if (window == null) return null;
            var cls = window.ClassName ?? "";
            if (cls.StartsWith("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase)
                || cls.StartsWith("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase))
                return "Chromium content ignores synthetic window messages for coordinate input; it needs the system input queue.";
            if (cls.Equals("Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase))
                return "This CoreWindow/UWP surface accepts some synthetic messages and drops others; background input is not reliable here.";
            if (cls.StartsWith("ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase))
                return "This is a UWP host frame; the interactive content is in a child CoreWindow that does not accept synthetic coordinate input.";
            if (cls.Equals("SoPY_Avatar", StringComparison.OrdinalIgnoreCase))
                return "GTK/WebKit surfaces drop synthetic coordinate input.";
            if (window.AppId == "wpf" || cls.StartsWith("HwndWrapper", StringComparison.OrdinalIgnoreCase))
                return null; // WPF accepts PostMessage for clicks but not for drags; handled per action.
            return null;
        }

        // ---------------------------------------------------------------- SendInput

        /// <summary>Move the physical pointer. The user's cursor really moves.</summary>
        public static void SendMoveAbsolute(int x, int y)
        {
            int vx = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
            int vy = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
            int vw = Math.Max(1, Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN));
            int vh = Math.Max(1, Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN));
            var input = new Win32.INPUT { type = Win32.INPUT_MOUSE };
            input.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / vw);
            input.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / vh);
            input.u.mi.dwFlags = Win32.MOUSEEVENTF_MOVE | Win32.MOUSEEVENTF_ABSOLUTE | Win32.MOUSEEVENTF_VIRTUALDESK;
            Send(new[] { input });
        }

        public static void SendButton(Button button, bool down)
        {
            var input = new Win32.INPUT { type = Win32.INPUT_MOUSE };
            switch (button)
            {
                case Button.Left: input.u.mi.dwFlags = down ? Win32.MOUSEEVENTF_LEFTDOWN : Win32.MOUSEEVENTF_LEFTUP; break;
                case Button.Right: input.u.mi.dwFlags = down ? Win32.MOUSEEVENTF_RIGHTDOWN : Win32.MOUSEEVENTF_RIGHTUP; break;
                default: input.u.mi.dwFlags = down ? Win32.MOUSEEVENTF_MIDDLEDOWN : Win32.MOUSEEVENTF_MIDDLEUP; break;
            }
            Send(new[] { input });
        }

        public static void SendWheel(int clicks, bool horizontal)
        {
            var input = new Win32.INPUT { type = Win32.INPUT_MOUSE };
            input.u.mi.mouseData = unchecked((uint)(clicks * 120));
            input.u.mi.dwFlags = horizontal ? Win32.MOUSEEVENTF_HWHEEL : Win32.MOUSEEVENTF_WHEEL;
            Send(new[] { input });
        }

        public static void SendVirtualKey(ushort vk, bool up, bool extended)
        {
            var input = new Win32.INPUT { type = Win32.INPUT_KEYBOARD };
            input.u.ki.wVk = vk;
            input.u.ki.dwFlags = (up ? Win32.KEYEVENTF_KEYUP : 0) | (extended ? Win32.KEYEVENTF_EXTENDEDKEY : 0);
            Send(new[] { input });
        }

        /// <summary>Type a string through the system input queue using Unicode scancodes.</summary>
        public static void SendUnicodeText(string text)
        {
            foreach (var ch in text)
            {
                var code = (ushort)ch;
                if (ch == '\n') { SendVirtualKey(0x0D, false, false); SendVirtualKey(0x0D, true, false); continue; }
                if (ch == '\t') { SendVirtualKey(0x09, false, false); SendVirtualKey(0x09, true, false); continue; }
                if (ch == '\r') continue;
                var down = new Win32.INPUT { type = Win32.INPUT_KEYBOARD };
                down.u.ki.wVk = 0;
                down.u.ki.wScan = code;
                down.u.ki.dwFlags = Win32.KEYEVENTF_UNICODE;
                var up = new Win32.INPUT { type = Win32.INPUT_KEYBOARD };
                up.u.ki.wVk = 0;
                up.u.ki.wScan = code;
                up.u.ki.dwFlags = Win32.KEYEVENTF_UNICODE | Win32.KEYEVENTF_KEYUP;
                Send(new[] { down, up });
            }
        }

        private static void Send(Win32.INPUT[] inputs)
        {
            if (inputs.Length == 0) return;
            int size = Marshal.SizeOf(typeof(Win32.INPUT));
            var sent = SendInput((uint)inputs.Length, inputs, size);
            if (sent != inputs.Length)
                throw new ProtocolException("input_rejected",
                    "SendInput delivered " + sent + " of " + inputs.Length + " events (Win32 error " + Marshal.GetLastWin32Error() + "). " +
                    "This usually means the desktop is locked or the target window sits on a higher-integrity desktop than the driver.");
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, Win32.INPUT[] pInputs, int cbSize);

        // ---------------------------------------------------------------- PostMessage

        private static IntPtr MakeLParam(int x, int y)
        {
            return new IntPtr((y << 16) | (x & 0xFFFF));
        }

        /// <summary>Post a coordinate click to a window, in client coordinates.</summary>
        public static void PostClick(IntPtr hwnd, int clientX, int clientY, Button button, int count, List<ushort> modifiers)
        {
            SendModifiers(hwnd, modifiers, true);
            for (int i = 0; i < Math.Max(1, count); i++)
            {
                Win32.PostMessageW(hwnd, Win32.WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(clientX, clientY));
                int down, up;
                IntPtr wparam = IntPtr.Zero;
                switch (button)
                {
                    case Button.Right: down = Win32.WM_RBUTTONDOWN; up = Win32.WM_RBUTTONUP; wparam = new IntPtr(Win32.MK_RBUTTON); break;
                    case Button.Middle: down = Win32.WM_MBUTTONDOWN; up = Win32.WM_MBUTTONUP; wparam = new IntPtr(Win32.MK_MBUTTON); break;
                    default: down = Win32.WM_LBUTTONDOWN; up = Win32.WM_LBUTTONUP; wparam = new IntPtr(Win32.MK_LBUTTON); break;
                }
                Win32.PostMessageW(hwnd, down, wparam, MakeLParam(clientX, clientY));
                Thread.Sleep(i == 0 ? 40 : 30);
                Win32.PostMessageW(hwnd, up, IntPtr.Zero, MakeLParam(clientX, clientY));
                if (i + 1 < count)
                {
                    Thread.Sleep(30);
                    Win32.PostMessageW(hwnd, Win32.WM_MOUSEMOVE, IntPtr.Zero, MakeLParam(clientX, clientY));
                }
            }
            SendModifiers(hwnd, modifiers, false);
        }

        /// <summary>Post a wheel event to a window; the coordinates are screen coordinates.</summary>
        public static void PostWheel(IntPtr hwnd, int clientX, int clientY, int screenX, int screenY, int clicks, bool horizontal)
        {
            var wparam = new IntPtr(unchecked((int)((uint)(clicks * 120) << 16)));
            var lparam = MakeLParam(screenX, screenY);
            Win32.PostMessageW(hwnd, horizontal ? Win32.WM_MOUSEHWHEEL : Win32.WM_MOUSEWHEEL, wparam, lparam);
            GC.KeepAlive(clientX);
            GC.KeepAlive(clientY);
        }

        /// <summary>Post a Unicode text run to a window as WM_CHAR messages.</summary>
        public static void PostText(IntPtr hwnd, string text)
        {
            foreach (var ch in text)
            {
                if (ch == '\n') { Win32.PostMessageW(hwnd, Win32.WM_CHAR, new IntPtr(0x0D), IntPtr.Zero); continue; }
                if (ch == '\r') continue;
                Win32.PostMessageW(hwnd, Win32.WM_CHAR, new IntPtr(ch), IntPtr.Zero);
            }
        }

        /// <summary>Post a key press to a window, including modifier bookkeeping.</summary>
        public static void PostKey(IntPtr hwnd, ushort vk, bool extended, bool up)
        {
            var msg = up ? Win32.WM_KEYUP : Win32.WM_KEYDOWN;
            if (extended && (vk == 0x12 || vk == 0x5B || vk == 0x5C || vk == 0x5D)) msg = up ? Win32.WM_SYSKEYUP : Win32.WM_SYSKEYDOWN;
            uint lp = 1u;
            lp |= ((uint)Win32.MapVirtualKeyW(vk, 0)) << 16;
            if (extended) lp |= 1u << 24;
            if (up) lp |= 0xC0000000u;
            Win32.PostMessageW(hwnd, msg, new IntPtr(vk), new IntPtr(unchecked((int)lp)));
        }

        private static void SendModifiers(IntPtr hwnd, List<ushort> modifiers, bool down)
        {
            if (modifiers == null || modifiers.Count == 0) return;
            foreach (var vk in modifiers) PostKey(hwnd, vk, false, !down);
        }

        /// <summary>Map a key name (as written by a model) to a virtual-key code.</summary>
        public static ushort VirtualKey(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return 0;
            var key = name.Trim().ToLowerInvariant();
            switch (key)
            {
                case "ctrl": case "control": return 0x11;
                case "shift": return 0x10;
                case "alt": return 0x12;
                case "win": case "windows": case "meta": case "super": case "cmd": return 0x5B;
                case "enter": case "return": return 0x0D;
                case "tab": return 0x09;
                case "escape": case "esc": return 0x1B;
                case "space": case "spacebar": return 0x20;
                case "backspace": return 0x08;
                case "delete": case "del": return 0x2E;
                case "insert": case "ins": return 0x2D;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": case "pgup": return 0x21;
                case "pagedown": case "pgdn": return 0x22;
                case "up": case "arrowup": return 0x26;
                case "down": case "arrowdown": return 0x28;
                case "left": case "arrowleft": return 0x25;
                case "right": case "arrowright": return 0x27;
                case "capslock": return 0x14;
                case "printscreen": case "prtsc": return 0x2C;
                case "pause": return 0x13;
                case "apps": case "menu": return 0x5D;
                case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
                case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
                case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
                case "f13": return 0x7C; case "f14": return 0x7D; case "f15": return 0x7E; case "f16": return 0x7F;
                case "f17": return 0x80; case "f18": return 0x81; case "f19": return 0x82; case "f20": return 0x83;
                case "f21": return 0x84; case "f22": return 0x85; case "f23": return 0x86; case "f24": return 0x87;
                case "numlock": return 0x90;
                case "scrolllock": return 0x91;
                case "volumeup": return 0xAF;
                case "volumedown": return 0xAE;
                case "volumemute": return 0xAD;
                case "medianext": return 0xB0;
                case "mediaprev": return 0xB1;
                case "mediastop": return 0xB2;
                case "mediaplay": return 0xB3;
            }
            if (key.Length == 1)
            {
                var ch = key[0];
                if (ch >= 'a' && ch <= 'z') return (ushort)(0x41 + (ch - 'a'));
                if (ch >= '0' && ch <= '9') return (ushort)(0x30 + (ch - '0'));
                if (ch == ';') return 0xBA; if (ch == '=') return 0xBB; if (ch == ',') return 0xBC;
                if (ch == '-') return 0xBD; if (ch == '.') return 0xBE; if (ch == '/') return 0xBF;
                if (ch == '`') return 0xC0; if (ch == '[') return 0xDB; if (ch == '\\') return 0xDC;
                if (ch == ']') return 0xDD; if (ch == '\'') return 0xDE;
            }
            return 0;
        }

        /// <summary>Virtual keys that always need the extended-key flag.</summary>
        public static bool IsExtended(ushort vk)
        {
            switch (vk)
            {
                case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
                case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0xA3: case 0xA5:
                    return true;
                default:
                    return false;
            }
        }

        /// <summary>Modifier virtual keys, in the order they should be pressed.</summary>
        public static readonly Dictionary<string, ushort> ModifierKeys = new Dictionary<string, ushort>
        {
            { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 },
            { "win", 0x5B }, { "windows", 0x5B }, { "meta", 0x5B },
        };
    }
}
