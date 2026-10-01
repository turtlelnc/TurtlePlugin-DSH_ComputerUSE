// TurtlePlugin-DSH_ComputerUSE — native driver
// The sandbox layer's teeth. The host decides *policy*; the driver refuses to
// touch anything the policy did not clear, and re-verifies the target window
// immediately before every action so a recycled handle cannot be driven.
using System;
using System.Collections.Generic;

namespace TurtleComputerUse
{
    /// <summary>Per-request authorisation context handed down by the host plugin.</summary>
    internal sealed class PolicyContext
    {
        public bool ReadOnly;
        public List<string> ApprovedApps = new List<string>();
        public List<string> DeniedApps = new List<string>();
        public bool AllowElevatedTargets;
        public bool AllowForegroundEscalation = true;
        public int MaxActionsPerMinute = 240;
        public bool SyntheticCursor = true;
        public int CursorIdleHideMs = 2500;

        public bool IsApproved(string appId)
        {
            var id = Windows.NormalizeAppId(appId);
            foreach (var a in ApprovedApps) if (Windows.NormalizeAppId(a) == id) return true;
            return false;
        }

        public static PolicyContext FromJson(Dictionary<string, object> request)
        {
            var ctx = new PolicyContext();
            var policy = Json.GetObject(request, "policy");
            if (policy == null) return ctx;
            ctx.ReadOnly = Json.GetBool(policy, "readOnly");
            ctx.AllowElevatedTargets = Json.GetBool(policy, "allowElevatedTargets");
            ctx.AllowForegroundEscalation = Json.GetBool(policy, "allowForegroundEscalation", true);
            ctx.MaxActionsPerMinute = Json.GetInt(policy, "maxActionsPerMinute", 240);
            ctx.SyntheticCursor = Json.GetBool(policy, "syntheticCursor", true);
            ctx.CursorIdleHideMs = Json.GetInt(policy, "cursorIdleHideMs", 2500);
            var approved = Json.GetStringList(policy, "approvedApps");
            if (approved.Count > 0) ctx.ApprovedApps = approved;
            var denied = Json.GetStringList(policy, "deniedApps");
            if (denied.Count > 0) ctx.DeniedApps = denied;
            return ctx;
        }
    }

    /// <summary>Static, non-negotiable refusals plus the rolling action budget.</summary>
    internal static class Policy
    {
        /// <summary>
        /// Applications the driver will never drive, whatever the configuration
        /// says. These are the surfaces where a mis-typed click costs the user
        /// their machine or their credentials.
        /// </summary>
        public static readonly Dictionary<string, string> AlwaysDenied = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "consent", "This is the Windows UAC consent prompt. Driving it would defeat the elevation boundary, so the driver refuses." },
            { "credentialuibroker", "This is the Windows credential UI. The driver never types credentials on the user's behalf." },
            { "logonui", "This is the Windows logon/lock surface. The driver never drives the secure desktop." },
            { "winlogon", "This is the Windows logon process." },
            { "lsass", "This is the Local Security Authority process." },
            { "useraccountcontrolsettings", "This is the UAC settings page." },
            { "regedit", "Registry Editor can disable every other control on the machine, so the driver refuses it by default." },
        };

        /// <summary>Shells and terminals: a computer-use agent typing into a shell is remote code execution with extra steps.</summary>
        public static readonly Dictionary<string, string> ShellApps = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "cmd", "Command Prompt" },
            { "powershell", "Windows PowerShell" },
            { "pwsh", "PowerShell 7" },
            { "windowsterminal", "Windows Terminal" },
            { "wt", "Windows Terminal" },
            { "conhost", "Console Host" },
            { "openconsole", "Console Host" },
            { "bash", "Bash" },
            { "wsl", "Windows Subsystem for Linux" },
            { "wslhost", "Windows Subsystem for Linux" },
            { "cscript", "Windows Script Host" },
            { "wscript", "Windows Script Host" },
            { "mshta", "HTML Application Host" },
            { "rundll32", "Rundll32" },
            { "reg", "Registry console tool" },
            { "net", "Net tool" },
            { "netsh", "Network shell" },
            { "schtasks", "Task Scheduler CLI" },
            { "sc", "Service Control" },
            { "curl", "curl" },
            { "ssh", "OpenSSH client" },
            { "putty", "PuTTY" },
            { "mintty", "Mintty" },
            { "conemu64", "ConEmu" },
            { "alacritty", "Alacritty" },
            { "wezterm-gui", "WezTerm" },
        };

        private static readonly object Gate = new object();
        private static readonly Queue<DateTime> ActionLog = new Queue<DateTime>();

        /// <summary>Throws when the app may not be driven under the current policy.</summary>
        public static void RequireApp(WindowInfo window, PolicyContext policy, bool mutating)
        {
            if (window == null)
                throw new ProtocolException("no_target", "No target window was resolved.");

            var appId = window.AppId;
            if (appId.Length == 0)
                throw new ProtocolException("unknown_app", "The target window does not belong to a resolvable executable.");

            string reason;
            if (AlwaysDenied.TryGetValue(appId, out reason))
                throw new ProtocolException("app_denied", reason, Detail("appId", appId, "kind", "always-denied"));

            if (ShellApps.TryGetValue(appId, out reason))
                throw new ProtocolException("app_denied",
                    reason + " is a shell/terminal. A computer-use agent driving a shell is arbitrary code execution, so the sandbox denies it outright; use the shell tool instead.",
                    Detail("appId", appId, "kind", "shell"));

            foreach (var denied in policy.DeniedApps)
            {
                if (Windows.NormalizeAppId(denied) == appId)
                    throw new ProtocolException("app_denied", "The sandbox denies \"" + denied + "\" for this session.",
                        Detail("appId", appId, "kind", "configured-deny"));
            }

            if (mutating)
            {
                if (policy.ReadOnly)
                    throw new ProtocolException("read_only", "The sandbox is in read-only mode, so no input may be injected.",
                        Detail("appId", appId, "kind", "read-only"));

                if (!policy.IsApproved(appId))
                    throw new ProtocolException("app_not_approved",
                        "The host did not clear \"" + appId + "\" for this action. Computer Use requires a per-application approval; the plugin asks for one before calling the driver.",
                        Detail("appId", appId, "kind", "unapproved"));
            }

            if (window.Elevated && !policy.AllowElevatedTargets)
                throw new ProtocolException("target_elevated",
                    "\"" + window.ExeName + "\" runs elevated and this driver does not, so Windows User Interface Privilege Isolation will drop every synthetic input it sends. " +
                    "Set sandbox.allowElevatedTargets=true and run DeepSeek Harness elevated if you really need to drive it, or ask the user to perform this step.",
                    Detail("appId", appId, "elevated", true, "driverElevated", ProcessGuard.SelfElevated));

            if (window.Session != uint.MaxValue && !ProcessGuard.InInteractiveSession())
                throw new ProtocolException("session_0",
                    "This driver is not attached to the interactive desktop session, so it can see no real windows. " +
                    "Start DeepSeek Harness from the signed-in desktop session rather than from a service or an SSH logon.");

            // A locked desktop only breaks *injection* (foreground activation, the
            // clipboard, SendInput). Reads — window enumeration, the accessibility
            // tree, PrintWindow capture — keep working, so refusing them would take
            // away the one thing an agent can still usefully do while locked.
            if (mutating && ProcessGuard.DesktopLocked())
                throw new ProtocolException("desktop_locked",
                    "The interactive desktop is locked, so input injection cannot work: foreground activation, the clipboard and SendInput all fail while it is locked. " +
                    "Reads (computer_use_apps, computer_use_state, screenshots) still work. Unlock the desktop and retry.");
        }

        /// <summary>
        /// The same refusal list applied to a launch, where no window exists yet.
        ///
        /// The host tool already gates launches, but the driver must not rely on
        /// its caller: a launch is how an agent reaches a program the sandbox never
        /// saw, so this check is duplicated here deliberately.
        /// </summary>
        public static void RequireLaunch(string executable, PolicyContext policy)
        {
            var appId = Windows.NormalizeAppId(executable);
            if (appId.Length == 0)
                throw new ProtocolException("bad_request", "launch needs an executable name or path.");

            string reason;
            if (AlwaysDenied.TryGetValue(appId, out reason))
                throw new ProtocolException("app_denied", reason, Detail("appId", appId, "kind", "always-denied"));

            if (ShellApps.TryGetValue(appId, out reason))
                throw new ProtocolException("app_denied",
                    reason + " is a shell/terminal. A computer-use agent launching a shell is arbitrary code execution, so the sandbox denies it outright; use the shell tool instead.",
                    Detail("appId", appId, "kind", "shell"));

            foreach (var denied in policy.DeniedApps)
            {
                if (Windows.NormalizeAppId(denied) == appId)
                    throw new ProtocolException("app_denied", "The sandbox denies \"" + denied + "\" for this session.",
                        Detail("appId", appId, "kind", "configured-deny"));
            }

            if (policy.ReadOnly)
                throw new ProtocolException("read_only", "The sandbox is in read-only mode, so no application may be launched.",
                    Detail("appId", appId, "kind", "read-only"));

            if (!policy.IsApproved(appId))
                throw new ProtocolException("app_not_approved",
                    "The host did not clear \"" + appId + "\" for launching. Computer Use requires a per-application approval; the plugin asks for one before calling the driver.",
                    Detail("appId", appId, "kind", "unapproved"));
        }

        /// <summary>Rolling-window rate limit: a runaway agent should not become a machine gun.</summary>
        public static void RequireBudget(PolicyContext policy)
        {
            if (policy.MaxActionsPerMinute <= 0) return;
            lock (Gate)
            {
                var cutoff = DateTime.UtcNow.AddMinutes(-1);
                while (ActionLog.Count > 0 && ActionLog.Peek() < cutoff) ActionLog.Dequeue();
                if (ActionLog.Count >= policy.MaxActionsPerMinute)
                    throw new ProtocolException("rate_limited",
                        "The Computer Use sandbox allows at most " + policy.MaxActionsPerMinute + " input actions per minute, and that budget is spent. " +
                        "Wait for the window to roll over, or raise sandbox.maxActionsPerMinute deliberately.",
                        Detail("limit", policy.MaxActionsPerMinute));
                ActionLog.Enqueue(DateTime.UtcNow);
            }
        }

        public static Dictionary<string, object> Detail(string k1, object v1)
        {
            var d = Json.NewObject();
            d[k1] = v1;
            return d;
        }

        public static Dictionary<string, object> Detail(string k1, object v1, string k2, object v2)
        {
            var d = Detail(k1, v1);
            d[k2] = v2;
            return d;
        }

        public static Dictionary<string, object> Detail(string k1, object v1, string k2, object v2, string k3, object v3)
        {
            var d = Detail(k1, v1, k2, v2);
            d[k3] = v3;
            return d;
        }

        public static Dictionary<string, object> Detail(string k1, object v1, string k2, object v2, string k3, object v3, string k4, object v4)
        {
            var d = Detail(k1, v1, k2, v2, k3, v3);
            d[k4] = v4;
            return d;
        }

        public static Dictionary<string, object> Detail(string k1, object v1, string k2, object v2, string k3, object v3, string k4, object v4, string k5, object v5)
        {
            var d = Detail(k1, v1, k2, v2, k3, v3, k4, v4);
            d[k5] = v5;
            return d;
        }

        /// <summary>Whether the sandbox considers an app id a shell/terminal.</summary>
        public static bool IsShell(string appId)
        {
            return ShellApps.ContainsKey(Windows.NormalizeAppId(appId));
        }

        /// <summary>Whether the sandbox refuses an app id outright.</summary>
        public static bool IsAlwaysDenied(string appId)
        {
            return AlwaysDenied.ContainsKey(Windows.NormalizeAppId(appId));
        }

        /// <summary>Shell-app ids, for the host to surface in status and settings.</summary>
        public static List<object> ShellAppIds()
        {
            var list = new List<object>();
            foreach (var key in ShellApps.Keys) list.Add(key);
            list.Sort(CompareOrdinal);
            return list;
        }

        /// <summary>Always-denied app ids, for the host to surface in status.</summary>
        public static List<object> AlwaysDeniedAppIds()
        {
            var list = new List<object>();
            foreach (var key in AlwaysDenied.Keys) list.Add(key);
            list.Sort(CompareOrdinal);
            return list;
        }

        private static int CompareOrdinal(object a, object b)
        {
            return string.CompareOrdinal(Convert.ToString(a), Convert.ToString(b));
        }
    }
}
