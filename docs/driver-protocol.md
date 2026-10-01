# Driver protocol

The wire contract between the host plugin of `TurtlePlugin-DSH_ComputerUSE` (`DSH操纵电脑（TurtlePlugin）`)
and `TurtleComputerUse.exe`. It is deliberately flat: one request performs one action and returns one
result, so the host can approve, log and rate-limit each thing the agent does.

The TypeScript types live in `src/driver/protocol.ts`; the implementation is `native/src/Program.cs`
(the loop), `Policy.cs` (the policy block and the refusals), `Actions.cs`, `Windows.cs`, `Uia.cs`,
`Input.cs`, `Clipboard.cs` and `Cursor.cs`. Nothing in the protocol imports a DeepSeek Harness
package, so the same contract can be reused outside the host.

---

## 1. Transport and framing

* The driver is a child process. **Requests arrive on stdin, responses leave on stdout**, both UTF-8
  without a BOM.
* **Framing is NDJSON**: exactly one JSON object per line, terminated by `\n`. A line is parsed in
  full; there is no length prefix, no continuation and no batching.
* **One request, one response.** Requests may in principle be pipelined, and the host tracks them by
  `id`, but every method performs one action and returns one result.
* **stdout is reserved for protocol frames.** Diagnostics go to `stderr` (the host logs them at
  debug level) and, when enabled, to the driver log file.
* Each frame is flushed immediately, so a reader never waits for a buffer to fill.
* An empty line is ignored. A line that is not valid JSON produces an error frame with
  `"id": null` and is otherwise skipped — the loop keeps running.
* Closing stdin (EOF) ends the loop, stops the cursor overlay and exits with code 0.
* Every response echoes the request `id`. A response for an unknown id is ignored by the host.

---

## 2. Handshake

Immediately after startup, before reading any request, the driver writes one event frame:

```json
{"event":"ready","version":"0.1.0-rc1","pid":12345,"elevated":false}
```

| Field | Type | Meaning |
|---|---|---|
| `event` | string | always `"ready"` |
| `version` | string | driver version; must match the plugin version (`0.1.0-rc1`) |
| `pid` | number | the driver process id |
| `elevated` | boolean | whether the driver process is running elevated |

The host records this frame and exposes it to `computer_use_status`. There is no negotiation: the
first request may be sent as soon as the process is spawned, and the host does not wait for the
handshake before writing.

### Command-line flags

| Flag | Effect |
|---|---|
| `--version` | print `{"version":"0.1.0-rc1"}` and exit 0 |
| `--verbose`, `-v` | enable the driver log for this run |

### Environment variables

| Variable | Effect |
|---|---|
| `TURTLE_CU_VERBOSE=1` | enable the driver log (same as `--verbose`) |
| `TURTLE_CU_LOG_DIR=<dir>` | relocate the log; default `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse` |
| `TURTLE_CU_IDLE_SHUTDOWN_MS=<n>` | exit after `n` ms without a request (checked between requests); the host sets `0` and reclaims the process itself |

The log file is `driver.log` in that directory, rotated by deletion once it exceeds about 2 MB. With
verbose logging off — the default, and what the host uses — no log file is written at all.

---

## 3. Request envelope

```json
{"id":1,"method":"act","params":{"action":"click","appId":"mspaint","element":12},"policy":{"readOnly":false,"approvedApps":["mspaint"],"deniedApps":[],"allowElevatedTargets":false,"allowForegroundEscalation":true,"maxActionsPerMinute":240}}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | number | yes | Request identifier, echoed in the response. The host allocates it (`nextId++`). |
| `method` | string | yes | One of the methods in §5. |
| `params` | object | no | Method parameters; absent is treated as `{}`. |
| `policy` | object | no | Sandbox decisions for this request. Absent means "the defaults below", which are permissive for everything except the hard-coded refusals. |

### The `policy` block

| Field | Type | Default when absent | Meaning |
|---|---|---|---|
| `readOnly` | boolean | `false` | Refuse every mutating action (`read_only`) |
| `approvedApps` | string[] | `[]` | Applications cleared for mutating actions; anything else is refused (`app_not_approved`) |
| `deniedApps` | string[] | `[]` | Applications refused for this request (`app_denied`) |
| `allowElevatedTargets` | boolean | `false` | Whether an elevated target window may be driven |
| `allowForegroundEscalation` | boolean | `true` | Whether `dispatch: "auto"` may escalate to the foreground when the target cannot be driven in the background |
| `maxActionsPerMinute` | number | `240` | Rolling one-minute action budget; `0` disables the limit |
| `syntheticCursor` | boolean | `true` | Whether the driver may paint its synthetic cursor overlay; `false` suppresses every overlay command |
| `cursorIdleHideMs` | number | `2500` | Fade the synthetic cursor out after this much idle time; `0` keeps it visible |

App ids in `approvedApps` and `deniedApps` are normalised (`NormalizeAppId`: strip a `process:`
prefix, strip any path, strip the `.exe` suffix, lowercase) before comparison, so any spelling works.

The host builds this block from the plugin settings (`driverPolicy()` in `src/policy.ts`) and sends
it with every call; the cursor fields are applied on arrival, before the request is dispatched, so a
disabled overlay never flashes on screen. **The policy block is the only thing the driver knows
about the session's approvals**: the driver has no memory of previous requests except the rolling
rate-limit window and the newest accessibility snapshot.

---

## 4. Response envelopes

Success:

```json
{"id":1,"ok":true,"result":{"action":"click","dispatch":"background","backend":"window-message","delivered":"PostMessage to mspaint.exe","hwnd":"1234567","appId":"mspaint","point":{"x":420,"y":310}}}
```

Failure:

```json
{"id":1,"ok":false,"error":{"code":"background_unavailable","message":"This target cannot be driven without taking the foreground: …","detail":{"appId":"chrome","className":"Chrome_WidgetWin_1","reason":"Chromium content ignores synthetic window messages for coordinate input; it needs the system input queue."}}}
```

| Field | Type | Notes |
|---|---|---|
| `id` | number \| null | Echo of the request id; `null` for a frame that could not be parsed |
| `ok` | boolean | `true` for a result, `false` for an error |
| `result` | object | present when `ok` is `true`; every method returns an object |
| `error.code` | string | stable, machine-readable; see §6 |
| `error.message` | string | written to be read by a model: it says what to do next, not only what failed |
| `error.detail` | object | present on most structured refusals; carries the context (`appId`, `kind`, `elevated`, coordinates, …) |

An unexpected internal exception is reported as `driver_error` with the exception type and message
in the text and no detail, and a stack trace in the driver log.

---

## 5. Methods

Thirteen methods. `params` is `{}` where no parameter is listed.

### `ping`

Liveness. Takes no parameters and consults no policy.

Result: `{ "pong": true, "uptimeMs": <number> }`

### `status`

Takes no parameters and consults no policy. Used by `computer_use_status`.

| Result field | Type | Meaning |
|---|---|---|
| `version` | string | driver version |
| `pid` | number | driver process id |
| `elevated` | boolean | driver runs elevated |
| `desktopLocked` | boolean | the interactive desktop is locked or switched away |
| `desktopName` | string | name of the desktop that currently receives input (`""` when it cannot be read) |
| `interactiveSession` | boolean | this process shares the console session |
| `sessionId` | number | Windows session id of the driver process |
| `uptimeMs` | number | milliseconds since start |
| `os` | string | `Environment.OSVersion.VersionString` |
| `dpi` | number | system DPI (`GetDpiForSystem`) |
| `virtualScreen` | object | `{x, y, width, height}` of the virtual screen |
| `cursorOverlay` | boolean | always `true` in this build (`File.Exists(logPath) || true`) — treat it as "the overlay is available", not as a live state probe |
| `logPath` | string | path of the driver log (whether or not it is being written) |

### `capabilities`

Takes no parameters and consults no policy.

```json
{
  "actions": ["click","double_click","right_click","middle_click","move","hover","drag","scroll","type","key","set_value","invoke","toggle","expand","collapse","select","focus","activate","paste_text"],
  "dispatchModes": ["background","foreground","auto"],
  "backends": ["uia","msaa","printwindow","bitblt","wgc-unavailable","window-message","sendinput"],
  "syntheticCursor": true,
  "captureModes": ["window","screen","ax","none"],
  "refuses": ["terminals","shells","uac-consent","credential-ui","secure-desktop","logon-ui"],
  "rateLimit": "per-minute action budget enforced by the driver"
}
```

`wgc-unavailable` is reported deliberately: Windows Graphics Capture is not implemented, so a
hardware-composited window falls back to the screen-region copy described under `state`.

### `apps.list`

Takes no parameters. The policy block is read for `approvedApps` and `allowElevatedTargets`.

Result: `{ "apps": [AppSummary], "count": <number> }`

| AppSummary field | Type | Meaning |
|---|---|---|
| `appId` | string | normalised executable leaf name |
| `exe`, `exePath` | string | executable leaf name and full path |
| `pid` | number | process id of the primary window |
| `elevated` | boolean | the process is elevated |
| `title` | string | title of the primary window |
| `hwnd` | string | handle of the primary window, as a **decimal string** |
| `windowCount` | number | how many top-level windows the application owns |
| `foreground` | boolean | the primary window is the foreground window |
| `titles` | string[] | up to 8 window titles |
| `shell` | boolean | the id is on the hard-coded shell/terminal list |
| `alwaysDenied` | boolean | the id is on the hard-coded always-denied list |
| `approved` | boolean | the id is in the request's `approvedApps` |
| `drivable` | boolean | `(not shell and not always-denied and not elevated) or allowElevatedTargets` |

Applications are grouped by `appId`, ordered ordinally by `appId`, with the foreground window (then
the largest) as the primary window of each group. Only visible, titled, non-tool windows are
enumerated, and the driver's own windows are excluded.

### `windows.list`

Takes no parameters; the policy block is ignored. Enumerates every visible top-level window,
including untitled ones.

Result: `{ "windows": [WindowSummary], "count": <number> }`

| WindowSummary field | Type | Meaning |
|---|---|---|
| `hwnd` | string | decimal string handle |
| `pid` | number | owning process |
| `exe`, `exePath`, `appId` | string | executable leaf name, full path, normalised id |
| `title` | string | window text |
| `className` | string | window class |
| `minimized`, `maximized`, `enabled`, `elevated`, `offscreen` | boolean | window state; `offscreen` means the rectangle does not intersect the virtual screen |
| `bounds` | object | `{x, y, width, height}` — the extended frame bounds when DWM reports them |
| `clientBounds` | object | `{x, y, width, height}` in screen coordinates |

### `apps.launch`

Starts a process and waits for its first window.

| Param | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `path` | string | one of `path` / `app` | — | Executable name or absolute path |
| `app` | string | one of `path` / `app` | — | Alias for `path` |
| `timeoutMs` | number | no | `20000` | How long to wait for a new window (floored at 1000 ms) |

Result: `{ "pid": <number>, "path": <string>, "appId"?, "exe"?, "hwnd"?, "title"?, "windowReady": <boolean>, "note"? }`

A window is attributed to the launched process by matching `pid` first and executable name second,
against the window set captured before the launch. When nothing appears, `windowReady` is `false`
and `note` explains that the process may still be loading.

Policy: `readOnly` is refused (`read_only`) and the rate budget is charged (`RequireBudget`). **The
allow-list, the deny-list and the per-application approval are not re-checked by the driver for this
method** — the host gates a launch before it calls (see §7).

### `state`

Observes one window: metadata, optionally the accessibility tree, optionally a screenshot.

| Param | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `hwnd` | string or number | one of `hwnd` / `appId` | — | Window handle (decimal string or number) |
| `appId` | string | one of `hwnd` / `appId` | — | Application id; the foreground window, else the largest, is chosen |
| `app` | string | — | — | Alias for `appId` |
| `includeTree` | boolean | no | `true` unless `captureMode` is `screen` | Whether to walk the accessibility tree; a `screen` capture always skips it, because the tree belongs to a window |
| `captureMode` | string | no | `none` | `window` (PrintWindow, falling back to a covered region), `screen` (whole virtual screen), `ax` or `none` (no pixels) |
| `onlyActionable` | boolean | no | `false` | Keep only elements with an action, plus structural roles |
| `maxNodes` | number | no | `400` | Clamped to 20–4000 |
| `scale` | number | no | `1` | Screenshot scale; `<= 0` is treated as `1` |
| `treeBackend` | string | no | `uia` | Backend label recorded on the snapshot |

Result:

```json
{
  "window": { …WindowSummary… },
  "foreground": true,
  "desktopLocked": false,
  "tree": { "backend": "uia", "nodeCount": 87, "truncated": false, "nodes": [ …AxNode… ] },
  "screenshot": { "mime": "image/png", "base64": "…", "width": 800, "height": 600, "scale": 1, "backend": "printwindow", "covered": false, "originX": 100, "originY": 100, "byteLength": 42113, "hwnd": "…", "appId": "…", "title": "…" }
}
```

`tree` is `{"skipped": true}` when the tree was not requested. `screenshot` is absent when no
capture was requested.

AxNode: `{ index, depth, role, name?, value?, automationId?, className?, bounds{x,y,width,height},
centerX, centerY, enabled?, focused?, offscreen?, focusable?, actions?[] }`. Omitted booleans mean
`false`/default; `actions` values are `invoke`, `toggle`, `set_value`, `set_range`, `expand`,
`select`, `scroll`.

**The snapshot returned here becomes the driver's current snapshot**, which is what `act` resolves
element indexes against.

Errors: `no_target`, `unknown_app`, `app_denied`, `target_elevated`, `session_0`, `desktop_locked`,
`window_minimized`, `window_empty`, `capture_failed`, `no_accessibility_tree`.

### `screenshot`

Captures pixels without walking a tree.

| Param | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `mode` | string | no | `window` | `window` (needs `hwnd`/`appId`) or `screen` (the whole virtual screen) |
| `hwnd` / `appId` / `app` | as in `state` | for `mode: "window"` | — | Target window |
| `scale` | number | no | `1` | Screenshot scale |

Result: the screenshot object itself (same shape as `state.screenshot`, not wrapped). For `mode:
"screen"` the cursor overlay is hidden for the duration of the capture and `originX`/`originY` are
the virtual-screen origin.

Errors: `no_target`, `unknown_app`, `app_denied`, `target_elevated`, `session_0`, `desktop_locked`,
`window_minimized`, `window_empty`, `capture_failed`.

### `act`

Performs exactly one action.

| Param | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `action` | string | **yes** | — | See the table below |
| `element` | number | target | — | Index from the current snapshot; resolved through `Ax.Last` |
| `x`, `y` | number | target | — | Physical screen point |
| `hwnd` | string or number | target | — | Pins the action to one window |
| `appId` / `app` | string | target | — | Target application |
| `dispatch` | string | no | `auto` | `background` \| `foreground` \| `auto` |
| `text` | string | for `type`, `paste_text` | — | Text to type or paste |
| `keys` | string[] or string | for `key` | — | Key names, or a single `"ctrl+s"` string |
| `combo` | string | for `key` | — | Alias for a single key combination string |
| `value` | string | for `set_value` | `text` | Replacement value |
| `clear` | boolean | no | `false` | `type`: select all first |
| `submit` | boolean | no | `false` | `type`: press Enter afterwards |
| `pressEnter` | boolean | no | `false` | Alias for `submit` |
| `clicks` | number | no | `3` | `scroll`: wheel clicks; negative scrolls up |
| `amount` | number | no | `clicks` | Alias for `clicks` |
| `axis` | string | no | `vertical` | `scroll`: anything starting with `h` means horizontal |
| `deltaX`, `deltaY` | number | no | — | `scroll`: converted to clicks as `delta / 120` |
| `button` | string | no | `left` | `drag`: `right` selects the right button, anything else the left |
| `durationMs` | number | no | `420` | `drag`, clamped to 120–4000 ms |
| `toX`, `toY` | number | for `drag` | — | Drop point |
| `x2`, `y2` | number | for `drag` | — | Drop point aliases |
| `fromX`, `fromY` | number | no | `x`, `y` | Drag start |

Actions: `click`, `double_click`, `right_click`, `middle_click`, `hover`, `move`, `drag`, `scroll`,
`type`, `key`, `set_value`, `invoke`, `toggle`, `expand`, `collapse`, `select`, `focus`, `activate`,
`paste_text`, plus the alias `click_element` for `click`. An unknown action is `bad_request`.

Two details that surprise people:

* the click **count** comes from the action name (`double_click` clicks twice, everything else
  once) and the click **button** from the action name (`right_click`, `middle_click`); the `button`
  parameter is read by `drag` only;
* a target must be resolvable — an element index, a point, or an `hwnd`/`appId`. With `appId`/`hwnd`
  the point must lie inside that window's bounds, or the driver raises `point_outside_target`.

Result: `{ "action", "dispatch": "background"|"foreground", "backend", "delivered"?, "hwnd"?,
"appId"?, "title"?, "exe"?, "point"?{x,y}, "element"?, "keys"?, "clicks"?, "written"?, "pasted"?,
"from"?{x,y}, "to"?{x,y} }`.

`backend` names the mechanism that produced the effect: `uia-invokepattern`, `uia-togglepattern`,
`uia-valuepattern`, `uia-scrollpattern`, `uia-invoke`, `uia-toggle`, `uia-expand`, `uia-collapse`,
`uia-select`, `uia-setfocus`, `window-message`, `clipboard+window-message`, `sendinput`,
`clipboard+SendInput`, `setforegroundwindow`, `hover`.

Errors: `bad_request`, `no_target`, `no_snapshot`, `stale_element`, `app_denied`,
`app_not_approved`, `read_only`, `target_elevated`, `session_0`, `desktop_locked`, `rate_limited`,
`background_unavailable`, `point_outside_target`, `no_uia_element`, `pattern_unavailable`,
`pattern_failed`, `read_only_element`, `activation_failed`, `input_rejected`, `clipboard_failed`.

### `wait`

Waits for a condition.

| Param | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `kind` | string | no | `text` | `text`, `text-gone`, `window`, `sleep`, `idle` |
| `appId` / `app` | string | for `window`, `text`, `text-gone` | — | Application to watch |
| `hwnd` | string or number | for `text`, `text-gone` | — | Window to watch |
| `text` | string | for `text`, `text-gone` | — | Exact accessible name to look for |
| `closed` | boolean | no | `false` | `window`: wait for the window to disappear |
| `gone` | boolean | no | `false` | `text`: alternative to `kind: "text-gone"` |
| `timeoutMs` | number | no | `15000` | Clamped to 100–120000 ms |
| `pollMs` | number | no | `250` | Polling interval, floored at 80 ms |
| `ms` | number | no | `500` | Pause duration for `sleep`/`idle`, clamped to 0–`timeoutMs` |

Results by kind:

* `text` / `text-gone`: `{ "kind", "satisfied", "text" (the needle), "elapsedMs", "note"? }` — the
  `note` says "The text never appeared." or "The text is still present." on timeout.
* `window`: `{ "kind", "satisfied", "appId", "elapsedMs", "window"? }` — `window` is the current
  window description when one was found, `null` when waiting for it to close.
* `sleep`: `{ "kind": "sleep", "elapsedMs" }` (no `satisfied` field).
* `idle`: `{ "kind": "idle", "satisfied": true }`.

Text matching is an exact `Name` property condition over the window's UIA descendants, not a
substring search.

Errors: `bad_request`, `no_target`, `app_denied`, `target_elevated`, `session_0`, `desktop_locked`.

### `cursor`

Controls the synthetic cursor overlay directly. Used by the driver internally and available for
diagnostics; the host plugin does not call it in this build.

| Param | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `op` | string | no | `show` | `show`, `hide`, `move`, `click` |
| `x`, `y` | number | for `move` / `click` | `0` | Physical screen point |
| `label` | string | no | — | Short caption drawn next to the cursor |

Result: `{ "op": <string> }`. Errors: `bad_request` for an unknown op.

The overlay is a separate topmost, layered, click-through, never-activated window painted on its own
STA thread; it never moves the physical pointer.

### `policy.explain`

Takes no parameters and consults no policy. Reports the hard-coded refusal lists so a UI can
display them without hard-coding a second copy.

Result:

```json
{
  "shellApps": ["alacritty","bash","cmd","conemu64","conhost","cscript","curl","mintty","mshta","net","netsh","openconsole","powershell","putty","pwsh","reg","rundll32","sc","schtasks","ssh","wezterm-gui","windowsterminal","wscript","wsl","wslhost","wt"],
  "alwaysDeniedApps": ["consent","credentialuibroker","logonui","lsass","regedit","useraccountcontrolsettings","winlogon"],
  "note": "The driver refuses these regardless of configuration. The host plugin adds the per-session allow-list and the approval gate on top."
}
```

### `shutdown`

Takes no parameters. Replies `{ "stopping": true }`, flushes, stops the cursor overlay and returns
from the loop with exit code 0. The host sends it before killing the process when the plugin unloads
or when the driver has been idle for `idleShutdownMs`.

---

## 6. Error codes

Every code below is raised by the driver unless the row says otherwise. The `detail` column lists
the keys the refusal usually carries.

| Code | Raised when | Typical `detail` |
|---|---|---|
| `bad_request` | A parameter is missing or unusable (unknown action, unknown key name, empty text, missing drop point, bad `dispatch` value, unknown `cursor` op, unknown wait kind) | — |
| `unknown_method` | The method is not in the dispatch table | — |
| `parse_error` | The line was not valid JSON, or was not a JSON object; reported with `"id": null` | — |
| `invalid_request` | Declared for a request that is not an object; in practice the loop reports it as `parse_error` | — |
| `no_target` | No window could be resolved (missing/unresolvable handle, no window for that app, nothing to hit at the point) | `appId` |
| `unknown_app` | The resolved window belongs to no resolvable executable | — |
| `app_denied` | Hard-coded always-denied id, hard-coded shell id, or a `deniedApps` entry | `appId`, `kind` |
| `app_not_approved` | A mutating action for an application not in `approvedApps` | `appId`, `kind` |
| `read_only` | `readOnly` is set and the request would mutate | `appId`, `kind` |
| `target_elevated` | The target runs elevated and `allowElevatedTargets` is false | `appId`, `elevated`, `driverElevated` |
| `desktop_locked` | The input desktop is not `Default` (locked, logon or screensaver desktop) | — |
| `session_0` | The driver is not on the console session, so it sees no real windows | — |
| `rate_limited` | The rolling per-minute budget is spent | `limit` |
| `background_unavailable` | The target cannot be driven without the foreground, and the caller did not ask for it | `appId`, `className`, `reason` |
| `point_outside_target` | The point lies outside the window the caller pinned | `expectedAppId`, `expectedHwnd`, `x`, `y` |
| `no_snapshot` | An element index was used before any snapshot existed | — |
| `stale_element` | The element index is not part of the current snapshot | — |
| `no_uia_element` | The addressed element has no UI Automation handle | — |
| `pattern_unavailable` | The element does not support the required UIA pattern | — |
| `pattern_failed` | The UIA pattern threw | — |
| `read_only_element` | `set_value` on a read-only element | — |
| `window_minimized` | A capture was requested for a minimized window | — |
| `window_empty` | The window rectangle is empty | — |
| `activation_failed` | The window could not be brought to the foreground | `appId`, `hwnd` |
| `input_rejected` | `SendInput` delivered fewer events than requested | — |
| `clipboard_failed` | The clipboard could not be written after 12 attempts | — |
| `launch_failed` | The process could not be started | — |
| `no_accessibility_tree` | UI Automation returned no element for the window | — |
| `capture_failed` | The device context, capture surface or `BitBlt` failed | — |
| `driver_error` | Any other exception; carries the exception type and message in the text | — |
| `driver_missing` | *(host)* No executable could be located or built | — |
| `driver_timeout` | *(host)* The driver did not answer within `requestTimeoutMs`; the process was killed | — |
| `driver_exited` | *(host)* The process exited with requests in flight | — |
| `driver_stopped` | *(host)* The client stopped the driver while a request was pending | — |

`point_outside_target` and `capture_failed` are produced by the driver but are not members of
`DRIVER_ERROR_CODES` in the host's TypeScript — the host treats an unknown code as an opaque string
throughout, so a mismatch never changes behaviour.

---

## 7. Reciprocity: who enforces what

| Rule | Host (`src/policy.ts`) | Driver (`native/src/Policy.cs`) |
|---|---|---|
| Terminals and shells | yes (static refusal) | yes, for `state`, `act`, `screenshot`, `wait` |
| UAC / credential UI / logon / LSASS / regedit / UAC settings | yes (static refusal) | yes, for the same methods |
| `deniedApps` | yes | yes, for the same methods |
| `readOnly` | yes | yes, including `apps.launch` |
| Allow-list (`allowedApps`) | yes (`app_not_allowlisted`) | via `approvedApps`: the host sends the cleared list |
| Per-application approval | yes (layer 2, harness prompt) | via `approvedApps` (`app_not_approved`) |
| Rate limit | `maxActionsPerMinute` in settings | yes, rolling window, charged by `act` and `apps.launch` |
| Elevated target | `allowElevatedTargets` | yes (`target_elevated`) |
| Point inside the named window | — | yes (`point_outside_target`) |
| **`apps.launch` target against the refuse lists** | **yes** — the tool resolves the sandbox verdict and the approval before calling | **no** — only `readOnly` and the rate budget are enforced in the driver |

That last row is the one asymmetry in the design, and it is why the host is part of the trust
model: see [security.md](security.md#6-what-this-does-not-protect-against).

---

## 8. Minimal transcript

```text
← {"event":"ready","version":"0.1.0-rc1","pid":24680,"elevated":false}
→ {"id":1,"method":"ping","params":{}}
← {"id":1,"ok":true,"result":{"pong":true,"uptimeMs":3}}
→ {"id":2,"method":"apps.list","params":{},"policy":{"readOnly":true,"approvedApps":[],"deniedApps":[],"allowElevatedTargets":false,"allowForegroundEscalation":false,"maxActionsPerMinute":0}}
← {"id":2,"ok":true,"result":{"apps":[{"appId":"notepad","exe":"notepad.exe","exePath":"C:\\Windows\\System32\\notepad.exe","pid":9012,"elevated":false,"title":"Untitled - Notepad","hwnd":"197654","windowCount":1,"foreground":true,"titles":["Untitled - Notepad"],"shell":false,"alwaysDenied":false,"approved":false,"drivable":true}],"count":1}}
→ {"id":3,"method":"state","params":{"appId":"notepad","includeTree":true,"captureMode":"none","maxNodes":400,"scale":1}}
← {"id":3,"ok":true,"result":{"window":{ … },"foreground":true,"desktopLocked":false,"tree":{"backend":"uia","nodeCount":42,"truncated":false,"nodes":[ … ]}}}
→ {"id":4,"method":"act","params":{"action":"type","appId":"notepad","dispatch":"auto","text":"hello"},"policy":{"readOnly":false,"approvedApps":["notepad"],"deniedApps":[],"allowElevatedTargets":false,"allowForegroundEscalation":true,"maxActionsPerMinute":240}}
← {"id":4,"ok":true,"result":{"action":"type","dispatch":"background","backend":"uia-valuepattern","delivered":"accessibility pattern","hwnd":"197654","appId":"notepad","title":"Untitled - Notepad","exe":"notepad.exe","written":5,"mode":"append"}}
→ {"id":5,"method":"shutdown","params":{}}
← {"id":5,"ok":true,"result":{"stopping":true}}
```
