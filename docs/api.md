# Tool and parameter reference

Every parameter of all six tools registered by `TurtlePlugin-DSH_ComputerUSE` (`computer-use`
v`0.1.0-rc1`), with its type, whether it is required, its default, and what the driver actually
does with it.

The tables are generated from the tool schemas in `src/tools.ts` and the handlers in
`native/src/Actions.cs` and `native/src/Program.cs`. Where a parameter is accepted by the schema but
the driver derives the value from somewhere else, that is stated in the row — the schema is not
permission to assume behaviour.

Common conventions:

* Definitions in the **Default** column that name a setting (`computerUse.…`) mean the tool falls
  back to that setting's value at call time, so editing it in **Settings → Plugins** changes the
  default for subsequent calls.
* Every tool returns canonical JSON plus a text-first rendering (`output.render` emits the payload's
  `text` first, then any image attachments). A tool result is therefore always readable, even when
  the structured fields are ignored.
* Images are returned as durable attachment references, never as inline base64.
* A refusal never throws; it returns a payload with a `refused` field carrying a stable code, and
  nothing is clicked, typed or launched.
* Arguments that are absent, `null` or the empty string are treated as absent.

---

## 1. `computer_use_status`

Self-check for the plugin: the native driver, the desktop session, the two control layers, the
effective dispatch mode, and which applications are already cleared. Read-only — it never injects
input and never needs approval.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | string, one of `report` \| `reset` \| `consent` | no | `report` | `report` describes the current state; `reset` clears the per-session application approvals; `consent` raises the one-time system-level permission prompt. |

### Returns

| Field | Type | Present when |
|---|---|---|
| `text` | string | always |
| `version` | string | always (`0.1.0-rc1`) |
| `consent` | object \| null | `report` — the parsed `consent.json`, or `null` |
| `enabled` | boolean | `report` |
| `sandbox` | object | `report` — `allowedApps`, `deniedApps`, `readOnly`, `allowElevatedTargets`, `allowForegroundEscalation`, `maxActionsPerMinute`, `requireApproval`, `allowedBrowsers`, `alwaysDeniedByDriver` |
| `approvedApps` | array | `report` — ledger entries `{ appId, kind, at }` |
| `driver` | object | `report`, when the driver answers — version, pid, elevated, desktopLocked, desktopName, interactiveSession, sessionId, uptimeMs, os, dpi, virtualScreen, logPath |
| `driverError` | string | `report`, when the driver cannot be reached |
| `cleared` | boolean | `reset` |
| `consentGranted` | boolean | `consent` |

### Example

```json
{ "action": "report" }
```

`status` is also the place to look when something behaves oddly: it warns explicitly when the
desktop is locked, when the process is not in the interactive session, and when
`allowElevatedTargets` is on while the harness is not elevated.

---

## 2. `computer_use_apps`

Lists the applications and windows Computer Use can currently see, with the normalised `appId`,
executable, window title, size, elevation, and whether the sandbox would allow driving them.
Read-only, never requires approval. **Start here** to find the `appId` the other tools take.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `includeWindows` | boolean | no | `false` | Return every top-level window (one row per window) instead of one row per application. |
| `onlyDrivable` | boolean | no | `false` | Hide applications the sandbox would refuse anyway (terminals, shells, the always-denied list, and — in the application form — anything outside the allow-list; the window form is evaluated as a read, so an allow-list does not filter it). |

### Returns

`text`, plus exactly one of:

* `apps` — array of `{ appId, exe, exePath, pid, elevated, title, hwnd, windowCount, foreground, titles[], shell, alwaysDenied, approved, drivable, sandboxAllowed, sandboxWhitelisted, sandboxReason, needsApproval, browser }`;
* `windows` — array of `{ hwnd, pid, exe, exePath, appId, title, className, minimized, maximized, enabled, elevated, offscreen, bounds{x,y,width,height}, clientBounds{…}, sandboxAllowed }`.

The text form is tab-separated and tagged: `FOREGROUND`, `ELEVATED`, `whitelisted` / `needs
approval` / `approved` / `REFUSED`, `N windows`, `browser`.

One asymmetry is worth knowing: in the **application** form `sandboxAllowed` and
`sandboxWhitelisted` come from the *mutating* sandbox evaluation, so a restrictive `allowedApps`
list marks everything else `REFUSED`; in the **window** form each row is evaluated as a *read*, so a
restrictive allow-list does not remove windows from that list.

### Example

```json
{ "onlyDrivable": true }
```

---

## 3. `computer_use_state`

Observes one window: its indexed accessibility tree, a screenshot, or both. **The only source of
element indexes** — and those indexes are valid only for the snapshot this call returns. Read-only:
it does not require approval, but the sandbox still decides which windows it will describe.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `appId` | string | one of `appId` / `hwnd` | — | Application id from `computer_use_apps`, e.g. `"mspaint"` or `"excel.exe"`. |
| `hwnd` | string | one of `appId` / `hwnd` | — | Window handle, when one specific window of an application is wanted. |
| `captureMode` | string, one of `tree` \| `screenshot` \| `both` \| `none` | no | `tree` | `tree` is cheapest; `both` is what canvases and charts need. `screenshot` still returns window metadata but no tree; `none` returns metadata only. |
| `onlyActionable` | boolean | no | `false` | Keep only elements that can actually be acted on. Useful in dense windows. |
| `maxNodes` | integer | no | `computerUse.maxTreeNodes` (`400`) | Cap on accessibility-tree nodes. Clamped to 20–4000 by both the tool and the driver. |
| `scale` | number | no | `computerUse.captureScale` (`1`) | Screenshot scale, clamped to 0.1–1. Use `0.5` on a 4K display to halve the image cost. |

Passing neither `appId` nor `hwnd` returns a refusal telling the caller to run `computer_use_apps`.
Passing an `appId` the sandbox refuses returns the sandbox reason. Passing a browser `appId` while
`allowedBrowsers` is `false` returns an explanation rather than a tree.

### Returns

| Field | Type | Notes |
|---|---|---|
| `text` | string | window line, a lock warning when relevant, then the rendered tree (or a note that it was not requested) |
| `tree` | object | `{ backend, nodeCount, truncated, nodes[] }`; `nodes[]` entries carry `index`, `depth`, `role`, `name?`, `value?`, `automationId?`, `className?`, `bounds`, `centerX`, `centerY`, `enabled?`, `focused?`, `offscreen?`, `focusable?`, `actions?[]` |
| `screenshotMeta` | object | `{ width, height, scale, backend, covered, originX, originY, note }` — present when a screenshot was requested and allowed |
| `images` | array | attachment references, present when the screenshot could be stored |

Rendered tree lines look like:

```text
# accessibility tree via uia: 87 nodes
[0] Window "Untitled - Notepad" @732,486
  [1] TitleBar "Untitled - Notepad" @732,470
  [12] Document "Text Editor" value="hello" (focused) @720,300 actions=set_value
```

A `truncated` footer says how many of how many nodes were shown and suggests re-observing a
narrower window or raising `computerUse.maxTreeChars`.

### Example

```json
{ "appId": "mspaint", "captureMode": "both", "scale": 0.5, "maxNodes": 250 }
```

---

## 4. `computer_use_act`

Performs exactly **one** action on a window, then (by default) returns the new state and a verdict
saying whether the interface actually reacted. Requires approval the first time an application is
controlled unless it is on the sandbox allow-list.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | string, one of the 19 actions below | **yes** | — | The single action to perform. |
| `appId` | string | one of `appId` / `hwnd` / `element` | — | Target application id. Defaults to the application of the element being addressed. |
| `hwnd` | string | see above | — | Target window handle. |
| `element` | integer | see above | — | Element index from the most recent `computer_use_state` of this window. |
| `screenshotX` | number | no | — | X **in the screenshot image** that was shown; converted to physical pixels by the host. |
| `screenshotY` | number | no | — | Y in that image. |
| `x` | number | no | — | Physical screen X. Prefer `element` or `screenshotX`/`screenshotY`. |
| `y` | number | no | — | Physical screen Y. |
| `text` | string | for `type`, `paste_text` | — | Text to type or paste. Empty text is refused (`bad_request`). |
| `keys` | string[] | for `key` | — | Keys, e.g. `["ctrl","s"]` or `["enter"]`. A single `"ctrl+s"` string is also accepted by the driver. |
| `value` | string | for `set_value` | `text` if given | Replacement text for `set_value`. |
| `button` | string, `left` \| `right` \| `middle` | no | see notes | Read by **`drag`** only (`right` selects the right button; anything else is the left). For clicks, the button comes from the action name. |
| `count` | integer | no | see notes | Accepted and forwarded, but the driver takes the click count from the action name: `double_click` clicks twice, every other click action once. Use the action name. |
| `clear` | boolean | no | `false` | For `type`: select all and replace instead of inserting at the caret. |
| `submit` | boolean | no | `false` | For `type`: press Enter afterwards. |
| `clicks` | integer | no | `3` | Wheel clicks for `scroll`; negative scrolls up. |
| `axis` | string, `vertical` \| `horizontal` | no | `vertical` | Scroll axis. |
| `toScreenshotX` | number | no | — | Drag drop point, X in screenshot pixels. |
| `toScreenshotY` | number | no | — | Drag drop point, Y in screenshot pixels. |
| `toX` | number | for `drag` | — | Drag drop point, physical screen X. |
| `toY` | number | for `drag` | — | Drag drop point, physical screen Y. |
| `durationMs` | integer | no | `420` | Drag duration, clamped to 120–4000 ms. |
| `dispatch` | string, `background` \| `foreground` \| `auto` | no | `computerUse.dispatch` (`background`) | Override the configured dispatch mode for this one action. Use `foreground` only after the driver reported `background_unavailable`. |
| `refresh` | boolean | no | `computerUse.autoRefreshAfterAction` (`true`) | Return the post-action state and verdict. Explicit `false` suppresses the refresh; explicit `true` forces it even when the setting is off. |

### The 19 actions

| Action | Uses | Backend |
|---|---|---|
| `click` | `element` or a point | UIA Invoke/Toggle → window messages → `SendInput` |
| `double_click` | `element` or a point | as `click`, twice |
| `right_click` | `element` or a point | right button, as `click` |
| `middle_click` | `element` or a point | middle button, as `click` |
| `hover` | `element` or a point | `WM_MOUSEMOVE`, or a real pointer move in foreground |
| `drag` | point + `toX`/`toY` (+ `durationMs`, `button`) | foreground only; background returns `background_unavailable` |
| `scroll` | `element` or a point (`clicks`, `axis`) | UIA ScrollPattern → `WM_MOUSEWHEEL` → wheel `SendInput` |
| `type` | `text` (+ `clear`, `submit`) | UIA ValuePattern → `WM_CHAR` → Unicode `SendInput` |
| `key` | `keys` | `WM_KEY*` → virtual-key `SendInput` |
| `set_value` | `element` + `value` | UIA ValuePattern (background only) |
| `invoke` | `element` | UIA Invoke → SelectionItem.Select → ExpandCollapse.Expand |
| `toggle` | `element` | UIA Toggle → SelectionItem → ExpandCollapse |
| `expand` | `element` | UIA ExpandCollapse |
| `collapse` | `element` | UIA ExpandCollapse |
| `select` | `element` | UIA SelectionItem |
| `focus` | `element` | UIA `SetFocus` + activate |
| `activate` | `appId`/`hwnd` | `SetForegroundWindow` |
| `paste_text` | `text` | clipboard + Ctrl+V (background messages, else `SendInput`) |
| *(driver alias)* `click_element` | `element` | identical to `click`; the tool's enum does not offer it |

### Returns

| Field | Type | Notes |
|---|---|---|
| `text` | string | `"<action> via <dispatch> (<backend>) — <delivery>"`, target, point, counts, then the verdict and a fresh observation |
| `result` | object | `{ action, dispatch, backend, delivered?, hwnd?, appId?, title?, exe?, point?, element?, keys?, clicks?, written?, pasted?, from?, to? }` |
| `verdict` | string | `confirmed` \| `suspected_noop` \| `unverifiable` |
| `verdictWhy` | string | one-line justification |
| `state` | object | `{ window, foreground }` after the action, when refresh succeeded |
| `images` | array | post-action screenshot attachments, when capture is allowed |
| `refused` | string | refusal code, when the action was refused (e.g. `background_unavailable`, `point_outside_target`, `read_only`, `app_denied`, `rate_limited`) |
| `escalationHint` | string | `dispatch="foreground"`, on a `background_unavailable` refusal |

### Examples

Click a control by index:

```json
{ "action": "click", "appId": "mspaint", "element": 12 }
```

Click a point measured in the screenshot that was just shown:

```json
{ "action": "click", "appId": "mspaint", "screenshotX": 410, "screenshotY": 88 }
```

Type into a field and press Enter:

```json
{ "action": "type", "appId": "notepad", "text": "hello", "clear": true, "submit": true }
```

Accept a foreground takeover for one action on a Chromium window:

```json
{ "action": "click", "appId": "chrome", "element": 40, "dispatch": "foreground" }
```

---

## 5. `computer_use_wait`

Waits for the interface to become ready instead of polling: text appearing or disappearing in the
accessibility tree, an application window opening or closing, or a plain pause. Returns as soon as
the condition holds.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `kind` | string, one of `text` \| `text-gone` \| `window` \| `sleep` | **yes** | — | What to wait for. |
| `appId` | string | for `text`, `text-gone`, `window` | — | Application to watch. |
| `hwnd` | string | alternative to `appId` for the text kinds | — | Window to watch. |
| `text` | string | for `text`, `text-gone` | — | Exact accessible name to wait for. Empty is refused (`bad_request`). |
| `closed` | boolean | no | `false` | For `kind: "window"`: wait for the window to disappear instead of appear. |
| `timeoutMs` | integer | no | `15000` | Give up after this long. Clamped to 100–120000 ms by the driver. |
| `pollMs` | integer | no | `250` | Polling interval; the driver enforces a floor of 80 ms. |
| `ms` | integer | for `sleep` | `500` | Duration to sleep, clamped to 0–`timeoutMs`. |

### Returns

`text` (a human summary), plus `{ kind, satisfied, appId?, text, matchedText, elapsedMs, window?,
note? }`. The driver's own `text` field carries the needle that was waited for; the tool overwrites
the payload's `text` with the human summary and preserves the needle in `matchedText`, so the
model-facing result always reads as a sentence.

The tool's request timeout is the configured `requestTimeoutMs` plus this call's `timeoutMs`
(capped at 150000 ms), so a wait never trips the generic driver timeout.

### Examples

```json
{ "kind": "text", "appId": "notepad", "text": "TurtlePlugin", "timeoutMs": 8000 }
```

```json
{ "kind": "sleep", "ms": 750 }
```

---

## 6. `computer_use_launch`

Starts an application and waits for its first window. Both control layers apply — the allow-list and
deny-list, and the per-application approval — because launching is how an agent reaches a program
that is not running yet.

### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `app` | string | **yes** | — | Executable name or absolute path, e.g. `"mspaint.exe"` or `"C:\\Windows\\System32\\notepad.exe"`. |
| `args` | string | no | — | Command-line arguments, passed through as one string. |
| `timeoutMs` | integer | no | `computerUse.launchTimeoutMs` (`20000`) | How long to wait for the first window. Clamped to 1000–120000 ms. |

### Returns

`text` (either "Launched … window … is open as appId=…" or "Started … but no new window appeared"),
plus `{ pid, path, appId?, exe?, hwnd?, title?, windowReady, note? }`.

The driver snapshots the existing window set before starting the process and attributes the first
window whose `pid` matches the new process, falling back to an executable-name match.

### Example

```json
{ "app": "notepad.exe", "timeoutMs": 20000 }
```

---

## 7. Parameters the driver accepts but the tools do not expose

The driver's `act` handler reads a few additional parameter names. They are reachable over the wire
(see [driver-protocol.md](driver-protocol.md)) but no tool schema declares them, so a model cannot
send them through DeepSeek Harness in this build:

| Parameter | Method | Meaning |
|---|---|---|
| `fromX`, `fromY` | `act` | Drag start; defaults to `x`, `y` |
| `x2`, `y2` | `act` | Drag drop point; alternative to `toX`, `toY` |
| `deltaX`, `deltaY` | `act` (scroll) | Converted to wheel clicks (`delta/120`) |
| `amount` | `act` (scroll) | Alternative to `clicks` |
| `combo` | `act` (key) | `"ctrl+s"` as a single string, alternative to `keys` |
| `pressEnter` | `act` (type) | Alternative to `submit` |
| `gone` | `wait` | Alternative to `kind: "text-gone"` |
| `app` | any method taking `appId` | Alias for `appId` |
| `path` | `apps.launch` | Alias for the launched executable |
| `treeBackend` | `state` | Passed through to the accessibility walk (default `uia`) |
| `kind: "idle"` | `wait` | A second pause kind, alongside `sleep` |

---

## 8. Refusal codes a tool can return in `refused`

| Code | Raised by | Meaning |
|---|---|---|
| `no_target` | tool + driver | The action named no application, or the named window no longer exists |
| `app_denied` | host + driver | Hard-coded shell/security refusal, or a `deniedApps` entry |
| `app_not_allowlisted` | host | The allow-list is non-empty and does not contain the application |
| `app_not_approved` | driver | The request's `approvedApps` did not include the application |
| `read_only` | host + driver | `readOnly` is on and the action injects |
| `background_unavailable` | driver | The target needs the foreground; the caller must opt in with `dispatch: "foreground"` |
| `point_outside_target` | driver | The point lies outside the window the caller named |
| `target_elevated` | driver | Elevated target with `allowElevatedTargets` off |
| `desktop_locked` | driver | The interactive desktop is locked |
| `session_0` | driver | The process is not on the interactive desktop |
| `rate_limited` | driver | The per-minute action budget is spent |
| `window_minimized` | driver | A screenshot was requested for a minimized window |
| `stale_element` | driver | The element index is not part of the current snapshot |
| `no_snapshot` | driver | No accessibility snapshot exists yet |
| `no_uia_element` | driver | The addressed element has no UI Automation handle |
| `pattern_unavailable`, `pattern_failed`, `read_only_element` | driver | The UIA pattern is missing, failed, or the value is read-only |
| `activation_failed`, `input_rejected`, `clipboard_failed`, `launch_failed` | driver | The mechanism itself refused |
| `no_accessibility_tree`, `capture_failed`, `window_empty` | driver | Perception failed |
| `approval_rejected`, `approval_cancelled`, `approval_unavailable`, `approval_failed` | host | Layer 2 did not grant |
| `driver_missing`, `driver_timeout`, `driver_exited`, `driver_stopped` | host transport | The driver could not be started, answered too slowly, or died |

The full wire-level list, including the codes only the transport can produce, is in
[driver-protocol.md](driver-protocol.md#6-error-codes).
