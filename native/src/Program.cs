// TurtlePlugin-DSH_ComputerUSE — native driver
// NDJSON JSON-RPC loop on stdin/stdout. One request, one action, one response.
// The host plugin owns the tools, the approval prompts and the sandbox policy;
// this process owns the desktop and refuses anything the policy did not clear.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace TurtleComputerUse
{
    internal static class App
    {
        private static readonly object LogGate = new object();
        private static string _logPath;

        public static string LogPath
        {
            get
            {
                if (_logPath != null) return _logPath;
                var baseDir = Environment.GetEnvironmentVariable("TURTLE_CU_LOG_DIR");
                if (string.IsNullOrEmpty(baseDir))
                {
                    baseDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "TurtlePlugin-DSH_ComputerUSE");
                }
                try { Directory.CreateDirectory(baseDir); } catch { }
                _logPath = Path.Combine(baseDir, "driver.log");
                return _logPath;
            }
        }

        public static bool Verbose = Environment.GetEnvironmentVariable("TURTLE_CU_VERBOSE") == "1";

        public static void Log(string message)
        {
            if (!Verbose) return;
            try
            {
                lock (LogGate)
                {
                    if (File.Exists(LogPath) && new FileInfo(LogPath).Length > 2000000)
                        File.Delete(LogPath);
                    File.AppendAllText(LogPath,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + "  " +
                        message + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { /* logging must never take the driver down */ }
        }
    }

    internal static class Program
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        private static TextWriter _out;
        private static readonly Stopwatch Uptime = Stopwatch.StartNew();

        [STAThread]
        private static int Main(string[] args)
        {
            Console.OutputEncoding = Utf8;
            var stdout = Console.OpenStandardOutput();
            _out = new StreamWriter(stdout, Utf8) { AutoFlush = false };

            foreach (var arg in args)
            {
                if (arg == "--verbose" || arg == "-v") App.Verbose = true;
                if (arg == "--version") { Emit(Json.Obj("version", Version())); return 0; }
            }

            EnableDpiAwareness();

            var idleShutdownMs = 0;
            var envIdle = Environment.GetEnvironmentVariable("TURTLE_CU_IDLE_SHUTDOWN_MS");
            if (!string.IsNullOrEmpty(envIdle))
            {
                int parsed;
                if (int.TryParse(envIdle, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) idleShutdownMs = parsed;
            }

            var handshake = Json.NewObject();
            handshake["event"] = "ready";
            handshake["version"] = Version();
            handshake["pid"] = (int)Win32.GetCurrentProcessId();
            handshake["elevated"] = ProcessGuard.SelfElevated;
            Emit(handshake);

            var reader = new StreamReader(Console.OpenStandardInput(), Utf8);
            var lastActivity = DateTime.UtcNow;
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                lastActivity = DateTime.UtcNow;
                Dictionary<string, object> request;
                try { request = Json.ParseObject(line); }
                catch (Exception ex)
                {
                    EmitError(null, "parse_error", "Could not parse the request as JSON: " + ex.Message, null);
                    continue;
                }

                var id = Json.Get(request, "id");
                var method = Json.GetString(request, "method", "");
                var parameters = Json.GetObject(request, "params") ?? Json.NewObject();
                var policy = PolicyContext.FromJson(request);
                // The host owns the overlay settings; apply them before the first
                // action so a disabled synthetic cursor never flashes on screen.
                CursorOverlay.Configure(policy.SyntheticCursor, policy.CursorIdleHideMs);

                if (method == "shutdown")
                {
                    EmitOk(id, Json.Obj("stopping", true));
                    Flush();
                    break;
                }

                try
                {
                    var result = Dispatch(method, parameters, policy);
                    EmitOk(id, result);
                }
                catch (ProtocolException ex)
                {
                    App.Log("rpc: " + method + " refused: " + ex.Code + " — " + ex.Message);
                    EmitError(id, ex.Code, ex.Message, ex.Detail);
                }
                catch (Exception ex)
                {
                    App.Log("rpc: " + method + " failed: " + ex);
                    EmitError(id, "driver_error", ex.GetType().Name + ": " + ex.Message, null);
                }

                if (idleShutdownMs > 0 && (DateTime.UtcNow - lastActivity).TotalMilliseconds > idleShutdownMs)
                {
                    CursorOverlay.Stop();
                    break;
                }
            }

            CursorOverlay.Stop();
            Flush();
            return 0;
        }

        private static string Version()
        {
            return "0.1.0-rc1";
        }

        private static void EnableDpiAwareness()
        {
            // Physical pixels everywhere: the coordinates the model sees in a
            // screenshot are the coordinates the driver clicks.
            try { if (Win32.SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }
            catch { }
            try { if (Win32.SetProcessDpiAwareness(2) == 0) return; } // PROCESS_PER_MONITOR_DPI_AWARE
            catch { }
            App.Log("dpi: per-monitor awareness unavailable; coordinates will be virtualised.");
        }

        private static Dictionary<string, object> Dispatch(string method, Dictionary<string, object> p, PolicyContext policy)
        {
            switch (method)
            {
                case "ping": return Ping();
                case "status": return Status();
                case "capabilities": return Capabilities();
                case "apps.list": return AppsList(p, policy);
                case "windows.list": return WindowsList(p, policy);
                case "apps.launch": return Launch(p, policy);
                case "state": return State(p, policy);
                case "screenshot": return Screenshot(p, policy);
                case "act": return Act(p, policy);
                case "wait": return Wait(p, policy);
                case "cursor": return Cursor(p);
                case "policy.explain": return PolicyExplain();
                default:
                    throw new ProtocolException("unknown_method", "Unknown method \"" + method + "\".");
            }
        }

        // ------------------------------------------------------------------ read-only

        private static Dictionary<string, object> Ping()
        {
            return Json.Obj("pong", true, "uptimeMs", (int)Uptime.ElapsedMilliseconds);
        }

        private static Dictionary<string, object> Status()
        {
            var o = Json.NewObject();
            o["version"] = Version();
            o["pid"] = (int)Win32.GetCurrentProcessId();
            o["elevated"] = ProcessGuard.SelfElevated;
            o["desktopLocked"] = ProcessGuard.DesktopLocked();
            o["desktopName"] = ProcessGuard.InputDesktopName() ?? "";
            o["interactiveSession"] = ProcessGuard.InInteractiveSession();
            o["sessionId"] = (int)(Win32.ProcessSession(Win32.GetCurrentProcessId()));
            o["uptimeMs"] = (int)Uptime.ElapsedMilliseconds;
            o["os"] = Environment.OSVersion.VersionString;
            o["dpi"] = (int)Win32.GetDpiForSystem();
            var vs = Json.NewObject();
            vs["x"] = Win32.GetSystemMetrics(Win32.SM_XVIRTUALSCREEN);
            vs["y"] = Win32.GetSystemMetrics(Win32.SM_YVIRTUALSCREEN);
            vs["width"] = Win32.GetSystemMetrics(Win32.SM_CXVIRTUALSCREEN);
            vs["height"] = Win32.GetSystemMetrics(Win32.SM_CYVIRTUALSCREEN);
            o["virtualScreen"] = vs;
            o["cursorOverlay"] = File.Exists(App.LogPath) || true;
            o["logPath"] = App.LogPath;
            return o;
        }

        private static Dictionary<string, object> Capabilities()
        {
            var o = Json.NewObject();
            var actions = new List<object>
            {
                "click", "double_click", "right_click", "middle_click", "move", "hover", "drag", "scroll",
                "type", "key", "set_value", "invoke", "toggle", "expand", "collapse", "select", "focus",
                "activate", "paste_text",
            };
            o["actions"] = actions;
            o["dispatchModes"] = new List<object> { "background", "foreground", "auto" };
            o["backends"] = new List<object> { "uia", "msaa", "printwindow", "bitblt", "wgc-unavailable", "window-message", "sendinput" };
            o["syntheticCursor"] = true;
            o["captureModes"] = new List<object> { "window", "screen", "ax", "none" };
            o["refuses"] = new List<object> { "terminals", "shells", "uac-consent", "credential-ui", "secure-desktop", "logon-ui" };
            o["rateLimit"] = "per-minute action budget enforced by the driver";
            return o;
        }

        private static Dictionary<string, object> PolicyExplain()
        {
            var o = Json.NewObject();
            o["shellApps"] = Policy.ShellAppIds();
            o["alwaysDeniedApps"] = Policy.AlwaysDeniedAppIds();
            o["note"] = "The driver refuses these regardless of configuration. The host plugin adds the per-session allow-list and the approval gate on top.";
            return o;
        }

        private static Dictionary<string, object> AppsList(Dictionary<string, object> p, PolicyContext policy)
        {
            var apps = Windows.ListApps();
            var visible = new List<object>();
            foreach (var app in apps)
            {
                var id = (string)app["appId"];
                app["shell"] = Policy.IsShell(id);
                app["alwaysDenied"] = Policy.IsAlwaysDenied(id);
                app["approved"] = policy.IsApproved(id);
                app["drivable"] = !Policy.IsShell(id) && !Policy.IsAlwaysDenied(id)
                                  && !(bool)app["elevated"] || policy.AllowElevatedTargets;
                visible.Add(app);
            }
            var o = Json.NewObject();
            o["apps"] = visible;
            o["count"] = visible.Count;
            return o;
        }

        private static Dictionary<string, object> WindowsList(Dictionary<string, object> p, PolicyContext policy)
        {
            var windows = Windows.ListWindows(true);
            var list = new List<object>();
            foreach (var w in windows) list.Add(w.ToJson());
            var o = Json.NewObject();
            o["windows"] = list;
            o["count"] = list.Count;
            return o;
        }

        // ------------------------------------------------------------------ state

        private static WindowInfo ResolveWindow(Dictionary<string, object> p, bool required = true)
        {
            var hwnd = Json.GetHandle(p, "hwnd");
            if (hwnd != IntPtr.Zero)
            {
                var byHandle = Windows.Describe(hwnd);
                if (byHandle == null && required)
                    throw new ProtocolException("no_target", "Window handle " + hwnd + " no longer exists.");
                return byHandle;
            }
            var appId = Json.GetString(p, "appId", Json.GetString(p, "app", ""));
            if (appId.Length > 0)
            {
                var byApp = Windows.FindForApp(appId);
                if (byApp == null && required)
                    throw new ProtocolException("no_target", "No open window belongs to \"" + appId + "\".",
                        Policy.Detail("appId", Windows.NormalizeAppId(appId)));
                return byApp;
            }
            if (required) throw new ProtocolException("no_target", "Pass appId or hwnd to identify the window.");
            return null;
        }

        private static Dictionary<string, object> State(Dictionary<string, object> p, PolicyContext policy)
        {
            var window = ResolveWindow(p);
            Policy.RequireApp(window, policy, false);

            var captureMode = Json.GetString(p, "captureMode", "none").ToLowerInvariant();
            var includeTree = Json.GetBool(p, "includeTree", captureMode != "screen");
            var onlyActionable = Json.GetBool(p, "onlyActionable");
            var maxNodes = Math.Max(20, Math.Min(4000, Json.GetInt(p, "maxNodes", 400)));
            var scale = Json.GetDouble(p, "scale", 1.0);
            if (scale <= 0) scale = 1.0;

            var o = Json.NewObject();
            o["window"] = window.ToJson();
            o["foreground"] = Win32.GetForegroundWindow() == window.Handle;
            o["desktopLocked"] = ProcessGuard.DesktopLocked();

            if (includeTree && captureMode != "screen")
            {
                var snapshot = Ax.Capture(window, onlyActionable, maxNodes, Json.GetString(p, "treeBackend", "uia"));
                o["tree"] = snapshot.ToJson();
            }
            else
            {
                o["tree"] = Json.Obj("skipped", true);
            }

            if (captureMode == "window")
            {
                using (var capture = Windows.CaptureWindow(window, scale))
                    o["screenshot"] = capture.ToJson(scale);
            }
            else if (captureMode == "screen")
            {
                using (CursorOverlay.SuspendForCapture())
                using (var capture = Windows.CaptureScreen(scale))
                    o["screenshot"] = capture.ToJson(scale);
            }
            return o;
        }

        private static Dictionary<string, object> Screenshot(Dictionary<string, object> p, PolicyContext policy)
        {
            var mode = Json.GetString(p, "mode", "window").ToLowerInvariant();
            var scale = Json.GetDouble(p, "scale", 1.0);
            if (scale <= 0) scale = 1.0;
            if (mode == "screen")
            {
                using (CursorOverlay.SuspendForCapture())
                using (var capture = Windows.CaptureScreen(scale))
                    return capture.ToJson(scale);
            }
            var window = ResolveWindow(p);
            Policy.RequireApp(window, policy, false);
            using (var capture = Windows.CaptureWindow(window, scale))
                return capture.ToJson(scale);
        }

        // ------------------------------------------------------------------ actions

        private static Dictionary<string, object> Act(Dictionary<string, object> p, PolicyContext policy)
        {
            var action = Json.GetString(p, "action", "");
            if (action.Length == 0) throw new ProtocolException("bad_request", "act needs an `action`.");
            var window = ResolveWindow(p, false);
            Policy.RequireApp(window, policy, true);
            var result = Actions.Execute(action, p, policy, window);
            result["action"] = action;
            return result;
        }

        private static Dictionary<string, object> Cursor(Dictionary<string, object> p)
        {
            var op = Json.GetString(p, "op", "show").ToLowerInvariant();
            switch (op)
            {
                case "show": CursorOverlay.Show(); break;
                case "hide": CursorOverlay.Hide(); break;
                case "move": CursorOverlay.Move(Json.GetInt(p, "x"), Json.GetInt(p, "y"), Json.GetString(p, "label", null)); break;
                case "click": CursorOverlay.Click(Json.GetInt(p, "x"), Json.GetInt(p, "y"), Json.GetString(p, "label", null)); break;
                default: throw new ProtocolException("bad_request", "cursor op must be show, hide, move or click.");
            }
            return Json.Obj("op", op);
        }

        private static Dictionary<string, object> Launch(Dictionary<string, object> p, PolicyContext policy)
        {
            if (policy.ReadOnly)
                throw new ProtocolException("read_only", "The sandbox is in read-only mode, so no application may be launched.");
            return Actions.Launch(p, policy, Json.GetInt(p, "timeoutMs", 20000));
        }

        // ------------------------------------------------------------------ wait

        private static Dictionary<string, object> Wait(Dictionary<string, object> p, PolicyContext policy)
        {
            var timeoutMs = Math.Max(100, Math.Min(120000, Json.GetInt(p, "timeoutMs", 15000)));
            var kind = Json.GetString(p, "kind", "text").ToLowerInvariant();
            var window = ResolveWindow(p, false);
            if (window != null) Policy.RequireApp(window, policy, false);
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            var pollMs = Math.Max(80, Json.GetInt(p, "pollMs", 250));

            switch (kind)
            {
                case "sleep":
                {
                    var ms = Math.Max(0, Math.Min(timeoutMs, Json.GetInt(p, "ms", 500)));
                    Thread.Sleep(ms);
                    return Json.Obj("kind", kind, "elapsedMs", ms);
                }
                case "window":
                {
                    var appId = Json.GetString(p, "appId", Json.GetString(p, "app", ""));
                    if (appId.Length == 0) throw new ProtocolException("bad_request", "kind=\"window\" needs appId.");
                    var wantClosed = Json.GetBool(p, "closed");
                    var started = DateTime.UtcNow;
                    while (DateTime.UtcNow < deadline)
                    {
                        var found = Windows.FindForApp(appId);
                        if (wantClosed ? found == null : found != null)
                            return Json.Obj(
                                "kind", kind,
                                "satisfied", true,
                                "appId", Windows.NormalizeAppId(appId),
                                "elapsedMs", (int)(DateTime.UtcNow - started).TotalMilliseconds,
                                "window", found == null ? null : found.ToJson());
                        Thread.Sleep(pollMs);
                    }
                    return Json.Obj(
                        "kind", kind,
                        "satisfied", false,
                        "appId", Windows.NormalizeAppId(appId),
                        "elapsedMs", timeoutMs,
                        "note", wantClosed ? "The window is still open." : "No window for that app appeared before the timeout.");
                }
                case "text":
                case "text-gone":
                {
                    var needle = Json.GetString(p, "text", "");
                    if (needle.Length == 0) throw new ProtocolException("bad_request", "kind=\"text\" needs `text`.");
                    if (window == null) throw new ProtocolException("bad_request", "kind=\"text\" needs appId or hwnd.");
                    var wantGone = kind == "text-gone" || Json.GetBool(p, "gone");
                    var started = DateTime.UtcNow;
                    while (DateTime.UtcNow < deadline)
                    {
                        bool present = TreeContains(window, needle);
                        if (wantGone ? !present : present)
                            return Json.Obj(
                                "kind", kind,
                                "satisfied", true,
                                "text", needle,
                                "elapsedMs", (int)(DateTime.UtcNow - started).TotalMilliseconds);
                        Thread.Sleep(pollMs);
                    }
                    return Json.Obj(
                        "kind", kind,
                        "satisfied", false,
                        "text", needle,
                        "elapsedMs", timeoutMs,
                        "note", wantGone ? "The text is still present." : "The text never appeared.");
                }
                case "idle":
                {
                    Thread.Sleep(Math.Min(timeoutMs, Json.GetInt(p, "ms", 400)));
                    return Json.Obj("kind", kind, "satisfied", true);
                }
                default:
                    throw new ProtocolException("bad_request", "Unknown wait kind \"" + kind + "\". Use text, text-gone, window or sleep.");
            }
        }

        /// <summary>
        /// Whether a window's accessible text contains a needle.
        ///
        /// Deliberately broader than an exact accessible-name lookup: a document's
        /// body text is usually exposed as a value or through TextPattern, not as
        /// the element's Name, so matching Name alone misses the very text a caller
        /// is waiting for. Walks the control view with a cache request and a node
        /// cap, and matches case-insensitively on a substring.
        /// </summary>
        private static bool TreeContains(WindowInfo window, string needle)
        {
            try
            {
                var root = System.Windows.Automation.AutomationElement.FromHandle(window.Handle);
                if (root == null) return false;

                var walker = System.Windows.Automation.TreeWalker.ControlViewWalker;
                var cache = new System.Windows.Automation.CacheRequest();
                cache.Add(System.Windows.Automation.AutomationElement.NameProperty);
                cache.Add(System.Windows.Automation.ValuePattern.ValueProperty);
                cache.Add(System.Windows.Automation.AutomationElement.IsValuePatternAvailableProperty);
                cache.Add(System.Windows.Automation.AutomationElement.IsTextPatternAvailableProperty);

                using (cache.Activate())
                {
                    var visited = 0;
                    return WalkForText(walker, root, needle, ref visited, 2000);
                }
            }
            catch (Exception ex)
            {
                App.Log("wait: tree probe failed: " + ex.Message);
                return false;
            }
        }

        private static bool WalkForText(System.Windows.Automation.TreeWalker walker,
            System.Windows.Automation.AutomationElement element, string needle, ref int visited, int maxNodes)
        {
            if (element == null || visited >= maxNodes) return false;
            visited++;

            try
            {
                var name = element.Current.Name;
                if (!string.IsNullOrEmpty(name) && name.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;

                if ((bool)element.GetCurrentPropertyValue(System.Windows.Automation.AutomationElement.IsValuePatternAvailableProperty))
                {
                    var value = ((System.Windows.Automation.ValuePattern)element.GetCurrentPattern(
                        System.Windows.Automation.ValuePattern.Pattern)).Current.Value;
                    if (!string.IsNullOrEmpty(value) && value.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }

                if ((bool)element.GetCurrentPropertyValue(System.Windows.Automation.AutomationElement.IsTextPatternAvailableProperty))
                {
                    var pattern = (System.Windows.Automation.TextPattern)element.GetCurrentPattern(
                        System.Windows.Automation.TextPattern.Pattern);
                    var text = pattern.DocumentRange.GetText(-1);
                    if (!string.IsNullOrEmpty(text) && text.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
            }
            catch (Exception)
            {
                // A provider that refuses one property still contributes its children.
            }

            System.Windows.Automation.AutomationElement child;
            try { child = walker.GetFirstChild(element); }
            catch (Exception) { return false; }

            while (child != null)
            {
                if (WalkForText(walker, child, needle, ref visited, maxNodes)) return true;
                try { child = walker.GetNextSibling(child); }
                catch (Exception) { return false; }
            }
            return false;
        }

        // ------------------------------------------------------------------ wire

        private static void EmitOk(object id, Dictionary<string, object> result)
        {
            var envelope = Json.NewObject();
            envelope["id"] = id;
            envelope["ok"] = true;
            envelope["result"] = result;
            Emit(envelope);
        }

        private static void EmitError(object id, string code, string message, Dictionary<string, object> detail)
        {
            var error = Json.NewObject();
            error["code"] = code;
            error["message"] = message;
            if (detail != null) error["detail"] = detail;
            var envelope = Json.NewObject();
            envelope["id"] = id;
            envelope["ok"] = false;
            envelope["error"] = error;
            Emit(envelope);
        }

        private static void Emit(Dictionary<string, object> payload)
        {
            _out.Write(Json.Write(payload));
            _out.Write('\n');
            _out.Flush();
        }

        private static void Flush()
        {
            try { _out.Flush(); } catch { }
        }
    }
}
