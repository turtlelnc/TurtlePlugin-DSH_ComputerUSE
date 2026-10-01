// TurtlePlugin-DSH_ComputerUSE — native driver
// Accessibility: UI Automation (primary) with an MSAA fallback for legacy
// toolkits (VCL/SAL/Delphi) whose UIA bridge hangs or loses role information.
using System;
using System.Collections.Generic;
using System.Windows.Automation;

namespace TurtleComputerUse
{
    /// <summary>One node of a captured accessibility snapshot.</summary>
    internal sealed class AxNode
    {
        public int Index;
        public int Depth;
        public string Role = "";
        public string Name = "";
        public string Value;
        public string AutomationId = "";
        public string ClassName = "";
        public int X, Y, Width, Height;
        public bool Enabled = true;
        public bool Focused;
        public bool Offscreen;
        public bool KeyboardFocusable;
        public List<string> Actions = new List<string>();
        public AutomationElement Element;
        public string Backend = "uia";

        public Dictionary<string, object> ToJson()
        {
            var o = Json.NewObject();
            o["index"] = Index;
            o["depth"] = Depth;
            o["role"] = Role;
            if (Name.Length > 0) o["name"] = Name;
            if (!string.IsNullOrEmpty(Value)) o["value"] = Value;
            if (AutomationId.Length > 0) o["automationId"] = AutomationId;
            if (ClassName.Length > 0) o["className"] = ClassName;
            var b = Json.NewObject();
            b["x"] = X; b["y"] = Y; b["width"] = Width; b["height"] = Height;
            o["bounds"] = b;
            o["centerX"] = X + Width / 2;
            o["centerY"] = Y + Height / 2;
            if (!Enabled) o["enabled"] = false;
            if (Focused) o["focused"] = true;
            if (Offscreen) o["offscreen"] = true;
            if (KeyboardFocusable) o["focusable"] = true;
            if (Actions.Count > 0) o["actions"] = new List<object>(Actions.ToArray());
            return o;
        }
    }

    /// <summary>An indexed accessibility snapshot plus the element handles it addresses.</summary>
    internal sealed class AxSnapshot
    {
        public readonly List<AxNode> Nodes = new List<AxNode>();
        public readonly Dictionary<int, AxNode> ByIndex = new Dictionary<int, AxNode>();
        public int WindowHandle;
        public string Backend = "uia";
        public bool Truncated;
        public int TotalVisited;

        public void Add(AxNode node)
        {
            node.Index = Nodes.Count;
            Nodes.Add(node);
            ByIndex[node.Index] = node;
        }

        public AxNode Resolve(int index)
        {
            AxNode node;
            if (!ByIndex.TryGetValue(index, out node))
                throw new ProtocolException("stale_element",
                    "Element index " + index + " is not part of the current snapshot. Call computer_use_state again before acting.");
            return node;
        }

        public Dictionary<string, object> ToJson()
        {
            var list = new List<object>();
            foreach (var n in Nodes) list.Add(n.ToJson());
            var o = Json.NewObject();
            o["backend"] = Backend;
            o["nodeCount"] = Nodes.Count;
            o["truncated"] = Truncated;
            o["nodes"] = list;
            return o;
        }
    }

    internal static class Ax
    {
        private static AxSnapshot _last;

        /// <summary>The most recent snapshot; element indices refer to it.</summary>
        public static AxSnapshot Last
        {
            get { return _last; }
        }

        private static readonly Condition ActionableCondition = new OrCondition(
            new PropertyCondition(AutomationElement.IsInvokePatternAvailableProperty, true),
            new PropertyCondition(AutomationElement.IsTogglePatternAvailableProperty, true),
            new PropertyCondition(AutomationElement.IsValuePatternAvailableProperty, true),
            new PropertyCondition(AutomationElement.IsRangeValuePatternAvailableProperty, true),
            new PropertyCondition(AutomationElement.IsExpandCollapsePatternAvailableProperty, true),
            new PropertyCondition(AutomationElement.IsSelectionItemPatternAvailableProperty, true));

        /// <summary>Capture the accessibility tree of a window.</summary>
        public static AxSnapshot Capture(WindowInfo window, bool onlyActionable, int maxNodes, string backend)
        {
            var snapshot = new AxSnapshot { WindowHandle = window.Handle.ToInt64().GetHashCode() };
            var root = AutomationElement.FromHandle(window.Handle);
            if (root == null)
                throw new ProtocolException("no_accessibility_tree",
                    "UI Automation returned no element for this window; it may have closed.");

            var walker = TreeWalker.ControlViewWalker;
            var cache = new CacheRequest();
            cache.Add(AutomationElement.NameProperty);
            cache.Add(AutomationElement.ControlTypeProperty);
            cache.Add(AutomationElement.BoundingRectangleProperty);
            cache.Add(AutomationElement.IsEnabledProperty);
            cache.Add(AutomationElement.IsOffscreenProperty);
            cache.Add(AutomationElement.AutomationIdProperty);
            cache.Add(AutomationElement.ClassNameProperty);
            cache.Add(AutomationElement.HasKeyboardFocusProperty);
            cache.Add(AutomationElement.IsKeyboardFocusableProperty);
            cache.Add(AutomationElement.IsInvokePatternAvailableProperty);
            cache.Add(AutomationElement.IsTogglePatternAvailableProperty);
            cache.Add(AutomationElement.IsValuePatternAvailableProperty);
            cache.Add(AutomationElement.IsRangeValuePatternAvailableProperty);
            cache.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
            cache.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
            cache.Add(ValuePattern.ValueProperty);

            snapshot.Backend = backend ?? "uia";
            using (cache.Activate())
            {
                Walk(walker, root, snapshot, 0, onlyActionable, maxNodes);
            }
            if (snapshot.Nodes.Count == 0 || snapshot.TotalVisited <= 2)
            {
                var msaa = Msaa.Capture(window, onlyActionable, maxNodes);
                if (msaa != null && msaa.Nodes.Count > snapshot.Nodes.Count)
                {
                    msaa.Backend = "msaa";
                    _last = msaa;
                    return msaa;
                }
            }
            _last = snapshot;
            return snapshot;
        }

        private static void Walk(TreeWalker walker, AutomationElement element, AxSnapshot snapshot,
            int depth, bool onlyActionable, int maxNodes)
        {
            if (snapshot.Nodes.Count >= maxNodes)
            {
                snapshot.Truncated = true;
                return;
            }
            snapshot.TotalVisited++;

            var node = Describe(element);
            bool keep = !onlyActionable || node.Actions.Count > 0
                        || node.Role == "Window" || node.Role == "Document" || node.Role == "Pane"
                        || node.Role == "MenuBar" || node.Role == "Menu" || node.Role == "List"
                        || node.Role == "Tree" || node.Role == "Table" || node.Role == "Tab";
            if (keep)
            {
                node.Depth = depth;
                snapshot.Add(node);
            }

            AutomationElement child = null;
            try { child = walker.GetFirstChild(element); }
            catch (ElementNotAvailableException) { return; }
            catch (InvalidOperationException) { return; }

            while (child != null)
            {
                if (snapshot.Nodes.Count >= maxNodes) { snapshot.Truncated = true; return; }
                Walk(walker, child, snapshot, keep ? depth + 1 : depth, onlyActionable, maxNodes);
                try { child = walker.GetNextSibling(child); }
                catch (ElementNotAvailableException) { return; }
                catch (InvalidOperationException) { return; }
            }
        }

        /// <summary>Project one live element into a serialisable node.</summary>
        public static AxNode Describe(AutomationElement element)
        {
            var node = new AxNode { Element = element };
            try
            {
                node.Name = element.Current.Name ?? "";
                var ct = element.Current.ControlType;
                node.Role = ct == null ? "Unknown" : ct.ProgrammaticName.Replace("ControlType.", "");
                var rect = element.Current.BoundingRectangle;
                if (!rect.IsEmpty && !double.IsInfinity(rect.X) && !double.IsInfinity(rect.Y))
                {
                    node.X = (int)Math.Round(rect.X);
                    node.Y = (int)Math.Round(rect.Y);
                    node.Width = (int)Math.Round(rect.Width);
                    node.Height = (int)Math.Round(rect.Height);
                }
                node.Enabled = element.Current.IsEnabled;
                node.Offscreen = element.Current.IsOffscreen;
                node.Focused = element.Current.HasKeyboardFocus;
                node.KeyboardFocusable = element.Current.IsKeyboardFocusable;
                node.AutomationId = element.Current.AutomationId ?? "";
                node.ClassName = element.Current.ClassName ?? "";
                try
                {
                    if ((bool)element.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty))
                    {
                        var vp = (ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern);
                        if (vp != null && !vp.Current.IsReadOnly) node.Value = vp.Current.Value;
                    }
                }
                catch { /* provider refused the read; the tree is still useful */ }
                node.Actions = ActionsOf(element);
            }
            catch (ElementNotAvailableException) { node.Role = "Gone"; }
            catch (InvalidOperationException) { node.Role = "Gone"; }
            return node;
        }

        private static List<string> ActionsOf(AutomationElement element)
        {
            var actions = new List<string>();
            Try(element, AutomationElement.IsInvokePatternAvailableProperty, "invoke", actions);
            Try(element, AutomationElement.IsTogglePatternAvailableProperty, "toggle", actions);
            Try(element, AutomationElement.IsValuePatternAvailableProperty, "set_value", actions);
            Try(element, AutomationElement.IsRangeValuePatternAvailableProperty, "set_range", actions);
            Try(element, AutomationElement.IsExpandCollapsePatternAvailableProperty, "expand", actions);
            Try(element, AutomationElement.IsSelectionItemPatternAvailableProperty, "select", actions);
            Try(element, AutomationElement.IsScrollPatternAvailableProperty, "scroll", actions);
            return actions;
        }

        private static void Try(AutomationElement element, AutomationProperty property, string name, List<string> into)
        {
            try { if ((bool)element.GetCurrentPropertyValue(property)) into.Add(name); }
            catch { /* property unsupported by this provider */ }
        }

        /// <summary>The window that currently owns the keyboard focus, resolved to a top-level handle.</summary>
        public static IntPtr FocusedTopLevelWindow()
        {
            var focused = AutomationElement.FocusedElement;
            if (focused == null) return IntPtr.Zero;
            try
            {
                var pid = focused.Current.ProcessId;
                var handle = focused.Current.NativeWindowHandle;
                if (handle != 0) return new IntPtr(handle);
                var root = TreeWalker.ControlViewWalker.GetParent(focused);
                while (root != null)
                {
                    var parent = TreeWalker.ControlViewWalker.GetParent(root);
                    if (parent == null) break;
                    root = parent;
                }
                if (root != null)
                {
                    var h = root.Current.NativeWindowHandle;
                    if (h != 0) return new IntPtr(h);
                }
                GC.KeepAlive(pid);
            }
            catch { /* fall through */ }
            return IntPtr.Zero;
        }

        /// <summary>Resolve the deepest element at a physical screen point, plus its top-level window.</summary>
        public static AutomationElement ElementFromPoint(int x, int y, out IntPtr topLevel)
        {
            topLevel = Win32.WindowFromPoint(new Win32.POINT { X = x, Y = y });
            if (topLevel != IntPtr.Zero) topLevel = Win32.GetAncestor(topLevel, Win32.GA_ROOT);
            return AutomationElement.FromPoint(new System.Windows.Point(x, y));
        }
    }

    /// <summary>Best-effort MSAA walk used when UIA exposes almost nothing for a window.</summary>
    internal static class Msaa
    {
        private const uint OBJID_CLIENT = 0xFFFFFFFC;
        private static readonly Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");

        public static AxSnapshot Capture(WindowInfo window, bool onlyActionable, int maxNodes)
        {
            object accessible = null;
            try
            {
                var iid = IID_IAccessible;
                if (Win32.AccessibleObjectFromWindow(window.Handle, OBJID_CLIENT, ref iid, ref accessible) != 0)
                    return null;
                var root = accessible as Accessibility.IAccessible;
                if (root == null) return null;
                var snapshot = new AxSnapshot { WindowHandle = window.Handle.ToInt64().GetHashCode(), Backend = "msaa" };
                Walk(root, 0, snapshot, onlyActionable, maxNodes, window);
                return snapshot;
            }
            catch (Exception ex)
            {
                App.Log("msaa: fallback failed: " + ex.Message);
                return null;
            }
        }

        private static void Walk(Accessibility.IAccessible node, int depth, AxSnapshot snapshot,
            bool onlyActionable, int maxNodes, WindowInfo window)
        {
            if (node == null || snapshot.Nodes.Count >= maxNodes) { if (node != null) snapshot.Truncated = true; return; }
            int count;
            try { count = node.accChildCount; }
            catch { return; }

            var entry = new AxNode { Depth = depth, Backend = "msaa" };
            try
            {
                entry.Name = node.get_accName(0) ?? "";
                entry.Role = RoleName(node.get_accRole(0));
                object state = node.get_accState(0);
                int flags = state == null ? 0 : Convert.ToInt32(state);
                entry.Enabled = (flags & 0x1) == 0;          // STATE_SYSTEM_UNAVAILABLE
                entry.Offscreen = (flags & 0x8000) != 0;      // STATE_SYSTEM_OFFSCREEN
                entry.Focused = (flags & 0x4) != 0;           // STATE_SYSTEM_FOCUSED
                entry.KeyboardFocusable = (flags & 0x100000) != 0; // STATE_SYSTEM_FOCUSABLE
                if (entry.Name.Length == 0) { try { entry.Name = node.get_accValue(0) ?? ""; } catch { } }
            }
            catch { }

            bool keep = !onlyActionable || IsActionableRole(entry.Role);
            if (keep && entry.Name.Length > 0)
            {
                if (TryBounds(node, window, entry)) snapshot.Add(entry);
            }

            for (int i = 1; i <= count && snapshot.Nodes.Count < maxNodes; i++)
            {
                object child = null;
                try { child = node.get_accChild(i); }
                catch { continue; }
                if (child is Accessibility.IAccessible)
                    Walk((Accessibility.IAccessible)child, depth + 1, snapshot, onlyActionable, maxNodes, window);
                else if (keep)
                {
                    var leaf = new AxNode { Depth = depth + 1, Backend = "msaa" };
                    try
                    {
                        leaf.Name = node.get_accName(i) ?? "";
                        leaf.Role = RoleName(node.get_accRole(i));
                        if (leaf.Name.Length > 0 && TryBounds(node, window, leaf, i)) snapshot.Add(leaf);
                    }
                    catch { }
                }
            }
        }

        private static bool TryBounds(Accessibility.IAccessible node, WindowInfo window, AxNode entry, int child = 0)
        {
            try
            {
                int x, y, w, h;
                node.accLocation(out x, out y, out w, out h, child);
                if (w <= 0 || h <= 0) return false;
                entry.X = x; entry.Y = y; entry.Width = w; entry.Height = h;
                return true;
            }
            catch { return false; }
        }

        private static bool IsActionableRole(string role)
        {
            switch (role)
            {
                case "PushButton":
                case "CheckButton":
                case "RadioButton":
                case "ComboBox":
                case "DropList":
                case "Text":
                case "StaticText":
                case "ListItem":
                case "MenuItem":
                case "PageTab":
                case "Link":
                case "Slider":
                case "SpinButton":
                case "ButtonDropDown":
                case "ButtonMenu":
                case "SplitButton":
                case "Window":
                case "Client":
                case "Document":
                case "Menu":
                case "MenuBar":
                case "MenuPopup":
                case "List":
                case "Table":
                case "Outline":
                    return true;
                default:
                    return false;
            }
        }

        // MSAA role ids; see oleacc.h ROLE_SYSTEM_*.
        private static readonly Dictionary<int, string> Roles = new Dictionary<int, string>
        {
            { 0x01, "TitleBar" }, { 0x02, "MenuBar" }, { 0x03, "ScrollBar" }, { 0x04, "Grip" },
            { 0x05, "Sound" }, { 0x06, "Cursor" }, { 0x07, "Caret" }, { 0x08, "Alert" },
            { 0x09, "Window" }, { 0x0A, "Client" }, { 0x0B, "MenuPopup" }, { 0x0C, "MenuItem" },
            { 0x0D, "ToolTip" }, { 0x0E, "Application" }, { 0x0F, "Document" }, { 0x10, "Pane" },
            { 0x11, "Chart" }, { 0x12, "Dialog" }, { 0x13, "Border" }, { 0x14, "Grouping" },
            { 0x15, "Separator" }, { 0x16, "ToolBar" }, { 0x17, "StatusBar" }, { 0x18, "Table" },
            { 0x19, "ColumnHeader" }, { 0x1A, "RowHeader" }, { 0x1B, "Column" }, { 0x1C, "Row" },
            { 0x1D, "Cell" }, { 0x1E, "Link" }, { 0x1F, "HelpBalloon" }, { 0x20, "Character" },
            { 0x21, "List" }, { 0x22, "ListItem" }, { 0x23, "Outline" }, { 0x24, "OutlineItem" },
            { 0x25, "PageTab" }, { 0x26, "PropertyPage" }, { 0x27, "Indicator" }, { 0x28, "Graphic" },
            { 0x29, "StaticText" }, { 0x2A, "Text" }, { 0x2B, "PushButton" }, { 0x2C, "CheckButton" },
            { 0x2D, "RadioButton" }, { 0x2E, "ComboBox" }, { 0x2F, "DropList" }, { 0x30, "ProgressBar" },
            { 0x31, "Dial" }, { 0x32, "HotkeyField" }, { 0x33, "Slider" }, { 0x34, "SpinButton" },
            { 0x35, "Diagram" }, { 0x36, "Animation" }, { 0x37, "Equation" }, { 0x38, "ButtonDropDown" },
            { 0x39, "ButtonMenu" }, { 0x3A, "ButtonDropDownGrid" }, { 0x3B, "WhiteSpace" },
            { 0x3C, "PageTabList" }, { 0x3D, "Clock" }, { 0x3E, "SplitButton" }, { 0x3F, "IPAddress" },
            { 0x40, "OutlineButton" },
        };

        private static string RoleName(object role)
        {
            if (role == null) return "Unknown";
            int value;
            try { value = Convert.ToInt32(role); }
            catch { return role.ToString(); }
            string name;
            return Roles.TryGetValue(value & 0xFFFF, out name) ? name : "Role" + value.ToString("X");
        }
    }
}
