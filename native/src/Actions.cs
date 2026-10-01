// TurtlePlugin-DSH_ComputerUSE — native driver
// Action layer. One request performs exactly one action, so the host can
// approve, log and rate-limit each thing the agent does.
//
// Dispatch contract
// -----------------
//   background : UIA patterns, then targeted window messages. Never touches the
//                system input queue. If the target cannot be driven that way the
//                driver raises background_unavailable instead of silently
//                stealing the user's foreground.
//   foreground : activates the window and injects through SendInput. The real
//                pointer moves; the user's session is taken over for the action.
//   auto       : background first, escalating to foreground only when the host
//                set policy.allowForegroundEscalation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;

namespace TurtleComputerUse
{
    /// <summary>Where an action should land and how it should be delivered.</summary>
    internal sealed class ActionTarget
    {
        public WindowInfo Window;
        public AxNode Node;
        public int ScreenX;
        public int ScreenY;
        public bool HasPoint;
        public IntPtr FocusHandle = IntPtr.Zero;

        public IntPtr MessageHandle
        {
            get { return FocusHandle != IntPtr.Zero ? FocusHandle : Window.Handle; }
        }
    }

    internal static class Actions
    {
        // ------------------------------------------------------------------ dispatch

        public static string ResolveDispatch(string requested, ActionTarget target, string capability)
        {
            var mode = string.IsNullOrWhiteSpace(requested) ? "auto" : requested.Trim().ToLowerInvariant();
            switch (mode)
            {
                case "background":
                case "foreground":
                case "auto":
                    return mode;
                default:
                    throw new ProtocolException("bad_request", "dispatch must be \"background\", \"foreground\" or \"auto\" (got \"" + requested + "\").");
            }
        }

        /// <summary>Build the honest refusal that keeps a background run from silently becoming a takeover.</summary>
        public static ProtocolException BackgroundUnavailable(WindowInfo window, string why)
        {
            var detail = Json.NewObject();
            detail["appId"] = window == null ? "" : window.AppId;
            detail["className"] = window == null ? "" : window.ClassName;
            detail["reason"] = why;
            return new ProtocolException("background_unavailable",
                "This target cannot be driven without taking the foreground: " + why + " " +
                "Re-issue the same action with dispatch=\"foreground\" to accept the takeover, or ask the user to do it, " +
                "or set computerUse.dispatch=\"foreground\" if this app is the whole point of the session.",
                detail);
        }

        // ------------------------------------------------------------------ targeting

        public static ActionTarget ResolveTarget(Dictionary<string, object> p, PolicyContext policy, WindowInfo pinned)
        {
            var target = new ActionTarget();
            var hasElement = Json.Get(p, "element") != null;
            var hasX = Json.Get(p, "x") != null;
            var hasY = Json.Get(p, "y") != null;

            if (hasElement)
            {
                var snapshot = Ax.Last;
                if (snapshot == null)
                    throw new ProtocolException("no_snapshot", "No accessibility snapshot exists yet. Call computer_use_state before acting on an element index.");
                var index = Json.GetInt(p, "element", -1);
                target.Node = snapshot.Resolve(index);
                if (target.Node.Width > 0 && target.Node.Height > 0)
                {
                    target.ScreenX = target.Node.X + target.Node.Width / 2;
                    target.ScreenY = target.Node.Y + target.Node.Height / 2;
                    target.HasPoint = true;
                }
                else
                {
                    var rect = default(System.Windows.Rect);
                    var measured = false;
                    if (target.Node.Element != null)
                    {
                        try { rect = target.Node.Element.Current.BoundingRectangle; measured = !rect.IsEmpty; }
                        catch { measured = false; }
                    }
                    if (measured)
                    {
                        target.ScreenX = (int)Math.Round(rect.X + rect.Width / 2);
                        target.ScreenY = (int)Math.Round(rect.Y + rect.Height / 2);
                        target.HasPoint = true;
                    }
                }
                if (target.Node.Element != null)
                {
                    var handle = target.Node.Element.Current.NativeWindowHandle;
                    if (handle != 0) target.Window = Windows.Describe(new IntPtr(handle)) ?? pinned;
                }
            }

            if (hasX && hasY)
            {
                target.ScreenX = Json.GetInt(p, "x");
                target.ScreenY = Json.GetInt(p, "y");
                target.HasPoint = true;
                if (target.Window == null)
                {
                    var hit = Win32.WindowFromPoint(new Win32.POINT { X = target.ScreenX, Y = target.ScreenY });
                    if (hit != IntPtr.Zero) hit = Win32.GetAncestor(hit, Win32.GA_ROOT);
                    target.Window = Windows.Describe(hit) ?? pinned;
                }
            }

            if (target.Window == null) target.Window = pinned;
            if (target.Window == null && target.HasPoint)
            {
                var hit = Win32.WindowFromPoint(new Win32.POINT { X = target.ScreenX, Y = target.ScreenY });
                if (hit != IntPtr.Zero) hit = Win32.GetAncestor(hit, Win32.GA_ROOT);
                target.Window = Windows.Describe(hit);
            }
            if (target.Window == null)
                throw new ProtocolException("no_target",
                    "Could not resolve a target window. Pass an app id, a window handle, an element index from the last state, or an x/y screen point.");

            // Safety: when the caller named a window, the action must land in THAT
            // window. Without this, a coordinate click is a hole in the sandbox —
            // the host approves application A, the hit test finds application B,
            // and the click goes wherever the pixel happens to be.
            if (pinned != null)
            {
                if (target.HasPoint)
                {
                    var b = pinned.Bounds;
                    if (target.ScreenX < b.Left || target.ScreenX >= b.Right || target.ScreenY < b.Top || target.ScreenY >= b.Bottom)
                        throw new ProtocolException("point_outside_target",
                            "The point " + target.ScreenX + "," + target.ScreenY + " lies outside the approved window \"" + pinned.Title +
                            "\" (" + b.Left + "," + b.Top + " " + (b.Right - b.Left) + "x" + (b.Bottom - b.Top) + "). " +
                            "Nothing was injected. Re-observe the window with computer_use_state and address an element, or send a point inside it.",
                            Policy.Detail("expectedAppId", pinned.AppId, "expectedHwnd", pinned.Handle.ToInt64().ToString(), "x", target.ScreenX, "y", target.ScreenY));
                }
                target.Window = pinned;
            }

            target.FocusHandle = FocusedChild(target.Window.Handle);
            return target;
        }

        /// <summary>The control inside a window that currently owns keyboard focus, if any.</summary>
        public static IntPtr FocusedChild(IntPtr topLevel)
        {
            try
            {
                var tid = Win32.GetWindowThreadProcessId(topLevel, IntPtr.Zero);
                if (tid == 0) return IntPtr.Zero;
                var info = new Win32.GUITHREADINFO { cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(Win32.GUITHREADINFO)) };
                if (!Win32.GetGUIThreadInfo(tid, ref info)) return IntPtr.Zero;
                if (info.hwndFocus != IntPtr.Zero && Win32.IsWindow(info.hwndFocus)) return info.hwndFocus;
            }
            catch { }
            return IntPtr.Zero;
        }

        public static void ToClient(IntPtr hwnd, int screenX, int screenY, out int clientX, out int clientY)
        {
            var pt = new Win32.POINT { X = screenX, Y = screenY };
            Win32.ScreenToClient(hwnd, ref pt);
            clientX = pt.X;
            clientY = pt.Y;
        }

        // ------------------------------------------------------------------ activation

        /// <summary>Bring a window to the foreground, working around the foreground-lock heuristic.</summary>
        public static void Activate(WindowInfo window)
        {
            if (window == null) return;
            if (window.Minimized) Win32.ShowWindow(window.Handle, Win32.SW_RESTORE);
            if (Win32.GetForegroundWindow() == window.Handle) return;

            var self = Win32.GetCurrentThreadId();
            var target = Win32.GetWindowThreadProcessId(window.Handle, IntPtr.Zero);
            var foreground = Win32.GetForegroundWindow();
            var foregroundThread = foreground == IntPtr.Zero ? 0 : Win32.GetWindowThreadProcessId(foreground, IntPtr.Zero);

            bool attachedTarget = false, attachedForeground = false;
            try
            {
                if (target != 0 && target != self) attachedTarget = Win32.AttachThreadInput(self, target, true);
                if (foregroundThread != 0 && foregroundThread != self) attachedForeground = Win32.AttachThreadInput(self, foregroundThread, true);
                Win32.SetForegroundWindow(window.Handle);
                Win32.ShowWindow(window.Handle, Win32.SW_SHOW);
            }
            finally
            {
                if (attachedTarget) Win32.AttachThreadInput(self, target, false);
                if (attachedForeground) Win32.AttachThreadInput(self, foregroundThread, false);
            }

            for (int i = 0; i < 20; i++)
            {
                if (Win32.GetForegroundWindow() == window.Handle) return;
                Thread.Sleep(50);
            }
            if (Win32.GetForegroundWindow() != window.Handle)
                throw new ProtocolException("activation_failed",
                    "Could not bring \"" + window.Title + "\" to the foreground. The desktop may be locked, or another process is holding the foreground.",
                    Policy.Detail("appId", window.AppId, "hwnd", window.Handle.ToInt64().ToString()));
        }

        /// <summary>Focus an element through UIA, then make sure its window is foreground.</summary>
        public static void FocusElement(AxNode node, WindowInfo window)
        {
            if (window != null) Activate(window);
            if (node == null || node.Element == null) return;
            try
            {
                node.Element.SetFocus();
                Thread.Sleep(60);
            }
            catch (Exception ex)
            {
                App.Log("action: SetFocus refused: " + ex.Message);
            }
        }

        // ------------------------------------------------------------------ actions

        public static Dictionary<string, object> Execute(string action, Dictionary<string, object> p, PolicyContext policy, WindowInfo pinned)
        {
            var requested = Json.GetString(p, "dispatch", "auto");
            var target = ResolveTarget(p, policy, pinned);
            var mode = ResolveDispatch(requested, target, action);
            Policy.RequireBudget(policy);

            switch (action)
            {
                case "click": return Click(p, target, policy, mode);
                case "double_click": return Click(p, target, policy, mode == "background" ? "background" : mode, 2);
                case "right_click": return Click(p, target, policy, mode, 1, Button.Right);
                case "middle_click": return Click(p, target, policy, mode, 1, Button.Middle);
                case "hover":
                case "move": return Hover(p, target, policy, mode);
                case "drag": return Drag(p, target, policy, mode);
                case "scroll": return Scroll(p, target, policy, mode);
                case "type": return Type(p, target, policy, mode);
                case "key": return Key(p, target, policy, mode);
                case "set_value": return SetValue(p, target, policy, mode);
                case "invoke": return Pattern(p, target, policy, "invoke");
                case "toggle": return Pattern(p, target, policy, "toggle");
                case "expand": return Pattern(p, target, policy, "expand");
                case "collapse": return Pattern(p, target, policy, "collapse");
                case "select": return Pattern(p, target, policy, "select");
                case "focus": return Focus(p, target, policy);
                case "activate": return ActivateAction(target, policy);
                case "paste_text": return PasteText(p, target, policy, mode);
                case "click_element": return Click(p, target, policy, mode);
                default:
                    throw new ProtocolException("bad_request", "Unknown action \"" + action + "\".");
            }
        }

        private static Dictionary<string, object> Click(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode, int count = 1, Button button = Button.Left)
        {
            if (!t.HasPoint)
                throw new ProtocolException("bad_request", "click needs either an element index or an x/y screen point.");
            var buttonName = button.ToString().ToLowerInvariant();
            var label = "click " + buttonName + (count > 1 ? " x" + count : "");

            if (mode == "background" || mode == "auto")
            {
                // 1. An element with a real UIA action is the cleanest background route:
                //    it addresses the control, not the coordinate.
                if (t.Node != null && t.Node.Element != null && button == Button.Left && count >= 1)
                {
                    var pattern = TryPatternInvoke(t.Node, count);
                    if (pattern != null)
                    {
                        CursorOverlay.Click(t.ScreenX, t.ScreenY, label);
                        var viaPattern = Result(t, "background", "uia-" + pattern);
                        viaPattern["delivered"] = "accessibility pattern";
                        return viaPattern;
                    }
                }
                var blocker = Input.KnownPostMessageBlocker(t.Window);
                if (blocker != null)
                {
                    if (mode == "background" || !policy.AllowForegroundEscalation) throw BackgroundUnavailable(t.Window, blocker);
                }
                else
                {
                    int cx, cy;
                    ToClient(t.Window.Handle, t.ScreenX, t.ScreenY, out cx, out cy);
                    CursorOverlay.Click(t.ScreenX, t.ScreenY, label);
                    Input.PostClick(t.Window.Handle, cx, cy, button, count, null);
                    Thread.Sleep(120);
                    var result = Result(t, "background", "window-message");
                    result["delivered"] = "PostMessage to " + t.Window.ExeName;
                    return result;
                }
            }

            // foreground
            if (t.Node != null && t.Node.Element != null) FocusElement(t.Node, t.Window);
            else Activate(t.Window);
            CursorOverlay.Click(t.ScreenX, t.ScreenY, label);
            Input.SendMoveAbsolute(t.ScreenX, t.ScreenY);
            Thread.Sleep(count > 1 ? 20 : 60);
            if (count > 1)
            {
                for (int i = 0; i < count; i++)
                {
                    Input.SendButton(button, true);
                    Thread.Sleep(20);
                    Input.SendButton(button, false);
                    Thread.Sleep(70);
                }
            }
            else
            {
                Input.SendButton(button, true);
                Thread.Sleep(30);
                Input.SendButton(button, false);
            }
            Thread.Sleep(120);
            var fg = Result(t, "foreground", "SendInput");
            fg["delivered"] = "physical pointer on " + t.Window.ExeName;
            return fg;
        }

        private static Dictionary<string, object> Hover(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            if (!t.HasPoint) throw new ProtocolException("bad_request", "move needs an element index or an x/y screen point.");
            CursorOverlay.Move(t.ScreenX, t.ScreenY, "hover");
            if (mode == "foreground")
            {
                Activate(t.Window);
                Input.SendMoveAbsolute(t.ScreenX, t.ScreenY);
            }
            else
            {
                int cx, cy;
                ToClient(t.Window.Handle, t.ScreenX, t.ScreenY, out cx, out cy);
                if (Input.KnownPostMessageBlocker(t.Window) == null)
                    Win32.PostMessageW(t.Window.Handle, Win32.WM_MOUSEMOVE, IntPtr.Zero, new IntPtr((cy << 16) | (cx & 0xFFFF)));
            }
            Thread.Sleep(80);
            return Result(t, mode == "foreground" ? "foreground" : "background", "hover");
        }

        private static Dictionary<string, object> Drag(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            var fromX = Json.Get(p, "fromX") != null ? Json.GetInt(p, "fromX") : Json.GetInt(p, "x");
            var fromY = Json.Get(p, "fromY") != null ? Json.GetInt(p, "fromY") : Json.GetInt(p, "y");
            var toX = Json.GetInt(p, "toX", Json.GetInt(p, "x2", 0));
            var toY = Json.GetInt(p, "toY", Json.GetInt(p, "y2", 0));
            if (toX == 0 && toY == 0 && Json.Get(p, "toX") == null && Json.Get(p, "x2") == null)
                throw new ProtocolException("bad_request", "drag needs toX/toY (or x2/y2) as the drop point.");
            var durationMs = Math.Max(120, Math.Min(4000, Json.GetInt(p, "durationMs", 420)));
            var button = Json.GetString(p, "button", "left").ToLowerInvariant() == "right" ? Button.Right : Button.Left;

            if (mode == "background")
                throw BackgroundUnavailable(t.Window,
                    "drag needs a continuous press-move-release on the system input queue. Window messages drop the intermediate motion for most toolkits, so the drop would land nowhere.");

            Activate(t.Window);
            CursorOverlay.Move(fromX, fromY, "drag");
            Input.SendMoveAbsolute(fromX, fromY);
            Thread.Sleep(80);
            Input.SendButton(button, true);
            var steps = Math.Max(6, durationMs / 16);
            for (int i = 1; i <= steps; i++)
            {
                var x = fromX + (toX - fromX) * i / steps;
                var y = fromY + (toY - fromY) * i / steps;
                Input.SendMoveAbsolute(x, y);
                CursorOverlay.Move(x, y, null);
                Thread.Sleep(Math.Max(4, durationMs / steps));
            }
            Thread.Sleep(60);
            Input.SendButton(button, false);
            CursorOverlay.Click(toX, toY, "drop");
            Thread.Sleep(150);

            var result = Result(t, "foreground", "SendInput");
            result["from"] = Point(fromX, fromY);
            result["to"] = Point(toX, toY);
            return result;
        }

        private static Dictionary<string, object> Scroll(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            var clicks = Json.GetInt(p, "clicks", Json.GetInt(p, "amount", 3));
            var horizontal = Json.GetString(p, "axis", "vertical").ToLowerInvariant().StartsWith("h");
            if (Json.Get(p, "deltaX") != null || Json.Get(p, "deltaY") != null)
            {
                var dx = Json.GetInt(p, "deltaX");
                var dy = Json.GetInt(p, "deltaY");
                clicks = horizontal ? dx / 120 : -dy / 120;
                if (clicks == 0) clicks = dy > 0 ? -1 : 1;
            }

            if (mode != "foreground")
            {
                if (t.Node != null && t.Node.Element != null)
                {
                    try
                    {
                        object pattern;
                        if (t.Node.Element.TryGetCurrentPattern(ScrollPattern.Pattern, out pattern))
                        {
                            var sp = (ScrollPattern)pattern;
                            if (sp.Current.VerticallyScrollable || sp.Current.HorizontallyScrollable)
                            {
                                var amount = clicks > 0 ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement;
                                if (horizontal && sp.Current.HorizontallyScrollable) sp.Scroll(ScrollAmount.NoAmount, amount);
                                else if (sp.Current.VerticallyScrollable) sp.Scroll(amount, ScrollAmount.NoAmount);
                                return Result(t, "background", "uia-scrollpattern");
                            }
                        }
                    }
                    catch { /* fall through to messages */ }
                }

                var blocker = Input.KnownPostMessageBlocker(t.Window);
                if (blocker != null && mode == "background") throw BackgroundUnavailable(t.Window, blocker);
                if (blocker == null)
                {
                    int cx, cy;
                    ToClient(t.Window.Handle, t.ScreenX, t.ScreenY, out cx, out cy);
                    CursorOverlay.Scroll(t.ScreenX, t.ScreenY, horizontal);
                    Input.PostWheel(t.Window.Handle, cx, cy, t.ScreenX, t.ScreenY, clicks, horizontal);
                    Thread.Sleep(120);
                    var r = Result(t, "background", "window-message");
                    r["clicks"] = clicks;
                    return r;
                }
            }

            Activate(t.Window);
            if (t.HasPoint) { Input.SendMoveAbsolute(t.ScreenX, t.ScreenY); CursorOverlay.Scroll(t.ScreenX, t.ScreenY, horizontal); }
            for (int i = 0; i < Math.Abs(clicks); i++)
            {
                Input.SendWheel(clicks > 0 ? 1 : -1, horizontal);
                Thread.Sleep(30);
            }
            Thread.Sleep(120);
            var result = Result(t, "foreground", "SendInput");
            result["clicks"] = clicks;
            return result;
        }

        private static Dictionary<string, object> Type(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            var text = Json.GetString(p, "text", "");
            if (text.Length == 0) throw new ProtocolException("bad_request", "type needs non-empty text.");
            var clear = Json.GetBool(p, "clear");
            var submit = Json.GetBool(p, "submit") || Json.GetBool(p, "pressEnter");

            if (mode != "foreground")
            {
                if (t.Node != null && t.Node.Element != null)
                {
                    try
                    {
                        object pattern;
                        if (t.Node.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                        {
                            var vp = (ValuePattern)pattern;
                            if (!vp.Current.IsReadOnly)
                            {
                                var next = clear ? text : (vp.Current.Value ?? "") + text;
                                vp.SetValue(next);
                                if (submit) { FocusElement(t.Node, t.Window); KeyCombo(t.Window, new[] { "enter" }, "foreground"); }
                                var r = Result(t, "background", "uia-valuepattern");
                                r["written"] = text.Length;
                                r["mode"] = clear ? "replace" : "append";
                                return r;
                            }
                        }
                    }
                    catch { /* fall through */ }
                }

                var blocker = Input.KnownPostMessageBlocker(t.Window);
                if (blocker != null)
                {
                    if (mode == "background" || !policy.AllowForegroundEscalation) throw BackgroundUnavailable(t.Window, blocker);
                }
                else
                {
                    if (t.Node != null && t.Node.Element != null) FocusElement(t.Node, t.Window);
                    if (clear) KeyCombo(t.Window, new[] { "ctrl", "a" }, "background");
                    Input.PostText(t.MessageHandle, text);
                    if (submit) KeyCombo(t.Window, new[] { "enter" }, "background");
                    Thread.Sleep(120);
                    var r = Result(t, "background", "window-message");
                    r["written"] = text.Length;
                    return r;
                }
            }

            if (t.Node != null && t.Node.Element != null) FocusElement(t.Node, t.Window);
            else Activate(t.Window);
            if (clear) KeyCombo(t.Window, new[] { "ctrl", "a" }, "foreground");
            CursorOverlay.Move(t.HasPoint ? t.ScreenX : 0, t.HasPoint ? t.ScreenY : 0, "type " + text.Length + " chars");
            Input.SendUnicodeText(text);
            if (submit) { Thread.Sleep(60); KeyCombo(t.Window, new[] { "enter" }, "foreground"); }
            Thread.Sleep(140);
            var fg = Result(t, "foreground", "SendInput");
            fg["written"] = text.Length;
            return fg;
        }

        private static Dictionary<string, object> Key(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            var keys = Json.GetStringList(p, "keys");
            if (keys.Count == 0) keys = Json.GetStringList(p, "combo");
            if (keys.Count == 0) throw new ProtocolException("bad_request", "key needs `keys` (e.g. [\"ctrl\",\"s\"]) or `combo` (\"ctrl+s\").");

            if (mode != "foreground")
            {
                var blocker = Input.KnownPostMessageBlocker(t.Window);
                if (blocker != null && mode == "background") throw BackgroundUnavailable(t.Window, blocker);
                if (blocker == null)
                {
                    KeyCombo(t.Window, keys, "background");
                    Thread.Sleep(100);
                    var r = Result(t, "background", "window-message");
                    r["keys"] = Flatten(keys);
                    return r;
                }
            }
            Activate(t.Window);
            KeyCombo(t.Window, keys, "foreground");
            Thread.Sleep(140);
            var result = Result(t, "foreground", "SendInput");
            result["keys"] = Flatten(keys);
            return result;
        }

        /// <summary>Press a key combination with optional modifiers either through messages or SendInput.</summary>
        public static void KeyCombo(WindowInfo window, IList<string> keys, string mode)
        {
            var modifiers = new List<ushort>();
            var primary = new List<ushort>();
            foreach (var raw in keys)
            {
                var vk = Input.VirtualKey(raw);
                if (vk == 0) throw new ProtocolException("bad_request", "Unknown key name \"" + raw + "\".");
                ushort probe;
                if (Input.ModifierKeys.TryGetValue(raw.Trim().ToLowerInvariant(), out probe)) modifiers.Add(vk);
                else primary.Add(vk);
            }
            if (primary.Count == 0) primary.Add(0x11);

            if (mode == "foreground")
            {
                foreach (var m in modifiers) Input.SendVirtualKey(m, false, Input.IsExtended(m));
                foreach (var k in primary)
                {
                    Input.SendVirtualKey(k, false, Input.IsExtended(k));
                    Thread.Sleep(15);
                    Input.SendVirtualKey(k, true, Input.IsExtended(k));
                }
                for (int i = modifiers.Count - 1; i >= 0; i--) Input.SendVirtualKey(modifiers[i], true, Input.IsExtended(modifiers[i]));
                return;
            }

            var hwnd = window == null ? IntPtr.Zero : window.Handle;
            if (hwnd == IntPtr.Zero) return;
            foreach (var m in modifiers) Input.PostKey(hwnd, m, false, false);
            foreach (var k in primary)
            {
                Input.PostKey(hwnd, k, Input.IsExtended(k), false);
                Thread.Sleep(15);
                Input.PostKey(hwnd, k, Input.IsExtended(k), true);
            }
            for (int i = modifiers.Count - 1; i >= 0; i--) Input.PostKey(hwnd, modifiers[i], false, true);
        }

        private static Dictionary<string, object> SetValue(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            var value = Json.GetString(p, "value", Json.GetString(p, "text", ""));
            if (t.Node == null || t.Node.Element == null)
                throw new ProtocolException("no_uia_element",
                    "set_value needs an element index captured by UI Automation (the current snapshot's element had no UIA handle). Use type, or click the field first.");
            try
            {
                object pattern;
                if (!t.Node.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                    throw new ProtocolException("pattern_unavailable", "That element has no ValuePattern, so its text cannot be set directly. Use type instead.");
                var vp = (ValuePattern)pattern;
                if (vp.Current.IsReadOnly)
                    throw new ProtocolException("read_only_element", "That element is read-only.");
                vp.SetValue(value);
                Thread.Sleep(80);
                var r = Result(t, "background", "uia-valuepattern");
                r["written"] = value.Length;
                return r;
            }
            catch (ProtocolException) { throw; }
            catch (Exception ex)
            {
                throw new ProtocolException("pattern_failed", "ValuePattern.SetValue failed: " + ex.Message);
            }
        }

        private static Dictionary<string, object> Pattern(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string which)
        {
            if (t.Node == null || t.Node.Element == null)
                throw new ProtocolException("no_uia_element",
                    "The " + which + " action needs an element that UI Automation exposed. If the snapshot came from MSAA, use click with coordinates instead.");
            var element = t.Node.Element;
            try
            {
                switch (which)
                {
                    case "invoke":
                    {
                        object pat;
                        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); break; }
                        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); break; }
                        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat)) { ((ExpandCollapsePattern)pat).Expand(); break; }
                        throw new ProtocolException("pattern_unavailable", "That element has no Invoke, Select or Expand pattern.");
                    }
                    case "toggle":
                    {
                        object pat;
                        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); break; }
                        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat))
                        {
                            var sp = (SelectionItemPattern)pat;
                            if (sp.Current.IsSelected) { }
                            else sp.Select();
                            break;
                        }
                        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat))
                        {
                            var ep = (ExpandCollapsePattern)pat;
                            if (ep.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) ep.Expand(); else ep.Collapse();
                            break;
                        }
                        throw new ProtocolException("pattern_unavailable", "That element has no Toggle, Select or Expand pattern.");
                    }
                    case "expand":
                    {
                        object pat;
                        if (!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat))
                            throw new ProtocolException("pattern_unavailable", "That element has no ExpandCollapse pattern.");
                        ((ExpandCollapsePattern)pat).Expand();
                        break;
                    }
                    case "collapse":
                    {
                        object pat;
                        if (!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pat))
                            throw new ProtocolException("pattern_unavailable", "That element has no ExpandCollapse pattern.");
                        ((ExpandCollapsePattern)pat).Collapse();
                        break;
                    }
                    case "select":
                    {
                        object pat;
                        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); break; }
                        throw new ProtocolException("pattern_unavailable", "That element has no SelectionItem pattern.");
                    }
                }
                Thread.Sleep(90);
                CursorOverlay.Click(t.ScreenX, t.ScreenY, which);
                var r = Result(t, "background", "uia-" + which);
                return r;
            }
            catch (ProtocolException) { throw; }
            catch (Exception ex)
            {
                throw new ProtocolException("pattern_failed", "UIA " + which + " failed: " + ex.Message);
            }
        }

        private static Dictionary<string, object> Focus(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy)
        {
            FocusElement(t.Node, t.Window);
            return Result(t, "foreground", "uia-setfocus");
        }

        private static Dictionary<string, object> ActivateAction(ActionTarget t, PolicyContext policy)
        {
            Activate(t.Window);
            return Result(t, "foreground", "setforegroundwindow");
        }

        /// <summary>Paste long or non-ASCII text through the clipboard, then Ctrl+V.</summary>
        private static Dictionary<string, object> PasteText(Dictionary<string, object> p, ActionTarget t,
            PolicyContext policy, string mode)
        {
            var text = Json.GetString(p, "text", "");
            if (text.Length == 0) throw new ProtocolException("bad_request", "paste_text needs non-empty text.");
            Clipboard.SetText(text);

            if (mode == "background" && Input.KnownPostMessageBlocker(t.Window) == null)
            {
                KeyCombo(t.Window, new[] { "ctrl", "v" }, "background");
                Thread.Sleep(150);
                var r = Result(t, "background", "clipboard+window-message");
                r["pasted"] = text.Length;
                return r;
            }
            if (mode == "background" && !policy.AllowForegroundEscalation)
                throw BackgroundUnavailable(t.Window, "a clipboard paste has to reach the focused control through the system input queue.");

            if (t.Node != null && t.Node.Element != null) FocusElement(t.Node, t.Window);
            else Activate(t.Window);
            KeyCombo(t.Window, new[] { "ctrl", "v" }, "foreground");
            Thread.Sleep(160);
            var result = Result(t, "foreground", "clipboard+SendInput");
            result["pasted"] = text.Length;
            return result;
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>Invoke an element through its UIA pattern; returns the pattern name, or null when there is none.</summary>
        private static string TryPatternInvoke(AxNode node, int count)
        {
            if (count > 1) return null;
            try
            {
                object pat;
                if (node.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pat))
                {
                    ((InvokePattern)pat).Invoke();
                    Thread.Sleep(90);
                    return "invokepattern";
                }
                if (node.Actions.Contains("toggle") && node.Element.TryGetCurrentPattern(TogglePattern.Pattern, out pat))
                {
                    ((TogglePattern)pat).Toggle();
                    Thread.Sleep(90);
                    return "togglepattern";
                }
            }
            catch { }
            return null;
        }

        public static Dictionary<string, object> Result(ActionTarget t, string dispatch, string backend)
        {
            var o = Json.NewObject();
            o["dispatch"] = dispatch;
            o["backend"] = backend;
            if (t.Window != null)
            {
                o["hwnd"] = t.Window.Handle.ToInt64().ToString();
                o["appId"] = t.Window.AppId;
                o["title"] = t.Window.Title;
                o["exe"] = t.Window.ExeName;
            }
            if (t.HasPoint) o["point"] = Point(t.ScreenX, t.ScreenY);
            if (t.Node != null) o["element"] = t.Node.Index;
            return o;
        }

        public static Dictionary<string, object> Point(int x, int y)
        {
            var o = Json.NewObject();
            o["x"] = x; o["y"] = y;
            return o;
        }

        public static List<object> Flatten(IList<string> keys)
        {
            var list = new List<object>();
            foreach (var k in keys) list.Add(k);
            return list;
        }

        /// <summary>Launch an application, returning its process and the window it opened.</summary>
        public static Dictionary<string, object> Launch(Dictionary<string, object> p, PolicyContext policy, int timeoutMs)
        {
            var target = Json.GetString(p, "path", Json.GetString(p, "app", ""));
            var args = Json.GetString(p, "args", "");
            if (target.Length == 0) throw new ProtocolException("bad_request", "launch needs `path` or `app`.");
            Policy.RequireLaunch(target, policy);
            Policy.RequireBudget(policy);

            var before = new HashSet<IntPtr>();
            foreach (var w in Windows.ListWindows(true)) before.Add(w.Handle);

            ProcessStartInfo psi;
            if (target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && System.IO.File.Exists(target))
            {
                psi = new ProcessStartInfo(target) { UseShellExecute = false };
            }
            else
            {
                psi = new ProcessStartInfo(target) { UseShellExecute = true };
            }
            if (!string.IsNullOrEmpty(args)) psi.Arguments = args;

            Process proc;
            try { proc = Process.Start(psi); }
            catch (Exception ex)
            {
                throw new ProtocolException("launch_failed", "Could not start \"" + target + "\": " + ex.Message);
            }

            var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(1000, timeoutMs));
            WindowInfo found = null;
            while (DateTime.UtcNow < deadline)
            {
                foreach (var w in Windows.ListWindows(true))
                {
                    if (before.Contains(w.Handle)) continue;
                    if (proc != null && w.Pid == proc.Id) { found = w; break; }
                    if (found == null && Windows.NormalizeAppId(w.ExeName) == Windows.NormalizeAppId(target)) found = w;
                }
                if (found != null) break;
                Thread.Sleep(180);
            }

            var result = Json.NewObject();
            result["pid"] = proc == null ? 0 : proc.Id;
            result["path"] = target;
            if (found != null)
            {
                result["appId"] = found.AppId;
                result["exe"] = found.ExeName;
                result["hwnd"] = found.Handle.ToInt64().ToString();
                result["title"] = found.Title;
                result["windowReady"] = true;
            }
            else
            {
                result["windowReady"] = false;
                result["note"] = "The process started but no new top-level window appeared before the timeout. It may still be loading, or it may have opened a window that already existed.";
            }
            GC.KeepAlive(policy);
            return result;
        }
    }
}
