# Architecture

How `TurtlePlugin-DSH_ComputerUSE` (`computer-use`) is put together: the host plugin, the native
driver, and the two control layers that sit between the model and the desktop.

This document describes the implementation as it exists in `src/` and `native/`. Where a mechanism
lives in the driver rather than the host, it says so explicitly, because that determines what a
compromised or confused host can still do.

---

## 1. The shape of the system

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ DeepSeek Harness (Node)                                                      │
│                                                                              │
│  ┌───────────────────────────── src/index.ts ─────────────────────────────┐  │
│  │  apply(ctx, config)                                                    │  │
│  │    · builds one Runtime { ctx, config, driver, ledger, log }           │  │
│  │    · registers six tools through ctx.tools.register()                  │  │
│  │    · ctx.effect(() => () => driver.dispose())                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│           │                                             ▲                    │
│           ▼                                             │                    │
│  ┌────── src/tools.ts ──────┐                 ┌── src/render.ts ──┐          │
│  │ status apps state act    │                 │ tree → indexed    │          │
│  │ wait  launch             │                 │ text;           │          │
│  │ (defineTool + schemas)   │                 │ PNG → attachment  │          │
│  └──────────┬───────────────┘                 │ verdictOf()       │          │
│             │                                 └───────────────────┘          │
│             ▼                                                                │
│  ┌──── src/policy.ts ─────────────────────────────────────────────────────┐  │
│  │ LAYER 1  checkSandbox()      allow-list · deny-list · readOnly ·       │  │
│  │                              shell/UAC/credential/regedit refusals     │  │
│  │ LAYER 2  askApproval()       ctx.get('approval').request({…})           │  │
│  │          ApprovalLedger      per-session memory of grants              │  │
│  │          consent.json        one-time system-level consent             │  │
│  └──────────┬─────────────────────────────────────────────────────────────┘  │
│             ▼                                                                │
│  ┌──── src/driver/client.ts ──────────────────────────────────────────────┐  │
│  │ DriverClient: locate()/compile() · NDJSON framing · request map ·      │  │
│  │ per-request timeout → kill + respawn · idle shutdown · dispose()       │  │
│  └──────────┬─────────────────────────────────────────────────────────────┘  │
└─────────────┼────────────────────────────────────────────────────────────────┘
              │  stdin/stdout: one JSON object per line
              │  {"id":1,"method":"act","params":{…},"policy":{…}}  →
              │  ← {"id":1,"ok":true,"result":{…}}  |  {"id":1,"ok":false,"error":{…}}
┌─────────────▼────────────────────────────────────────────────────────────────┐
│ TurtleComputerUse.exe (C#, .NET Framework 4.x, asInvoker, uiAccess=false)    │
│                                                                              │
│  Program.cs    RPC loop · dispatch table · status/capabilities/policy         │
│  Policy.cs     PolicyContext (per-request) · AlwaysDenied · ShellApps ·       │
│                rolling rate limit                                            │
│  Windows.cs    window enumeration · DPI · PrintWindow/BitBlt capture ·        │
│                elevation, session and lock probes                             │
│  Uia.cs        UI Automation walk + MSAA fallback · indexed snapshot ·        │
│                element resolution                                             │
│  Actions.cs    one action per request · background/foreground dispatch ·      │
│                activation · UIA patterns · launch                             │
│  Input.cs      SendInput (system queue) · PostMessage (window messages) ·     │
│                virtual-key table · PostMessage-blocker classification         │
│  Cursor.cs     synthetic cursor on a layered click-through overlay window     │
│  Clipboard.cs  CF_UNICODETEXT write with retry                                │
│  Json.cs       JavaScriptSerializer wrapper · ProtocolException               │
└──────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
        the real desktop: windows, accessibility providers, the input queue
```

Two properties of this split are deliberate:

* **The driver is the only process that touches the desktop.** The host cannot inject anything by
  itself; it can only ask, and each ask carries a `policy` block that the driver re-checks.
* **The wire protocol imports nothing from the harness.** `src/driver/protocol.ts` is plain
  TypeScript types, so a client-side panel can be built against the same contract without pulling
  the host runtime into a browser bundle.

---

## 2. Component responsibilities

| Component | Owns | Never does |
|---|---|---|
| `src/index.ts` | Plugin identity (`name = 'computer-use'`, `inject = ['tools']`), the `Runtime` object, tool registration, driver disposal on unload | Any policy decision |
| `src/config.ts` | The schemastery schema — which is also the Settings form. Volatile fields parse to `Volatile<T>`; `live()`, `bool()`, `num()`, `str()`, `list()`, `dispatchOf()` unwrap them | Reading the desktop |
| `src/constants.ts` | Product names, version, `DATA_DIR_NAME`, `DRIVER_EXE`, the host's copy of the shell and always-denied lists, the always-needs-reapproval key combos | Enforcing anything (the host's copy exists so a refusal can be explained without spawning the driver) |
| `src/policy.ts` | Layer 1 and layer 2: `normalizeAppId`, `checkSandbox`, `staticRefusal`, `driverPolicy`, `askApproval`, `ApprovalLedger`, the consent record and both prompt texts | Injecting input |
| `src/tools.ts` | The six tools, their schemas, argument validation, the observe/act/refresh workflow, verdict reporting, screenshot memory | Direct Win32 access |
| `src/render.ts` | Accessibility tree → indexed text, screenshot → durable attachment, `fromScreenshotSpace`, `verdictOf`, `fingerprint` | Policy |
| `src/driver/client.ts` | Finding, compiling, spawning, framing, timing out and reaping the driver process | Deciding what an action means |
| `native/src/Program.cs` | The RPC loop, the method table, `ping`/`status`/`capabilities`/`policy.explain` | Any approval decision |
| `native/src/Policy.cs` | `PolicyContext` from the request, the hard-coded refusals, the rolling action budget, the pre-injection re-check of the target window | Knowing about applications that the host approved but never named |
| `native/src/Windows.cs`, `Uia.cs` | Perception: enumeration, geometry, capture, accessibility snapshots, element resolution | Injection |
| `native/src/Actions.cs`, `Input.cs`, `Clipboard.cs`, `Cursor.cs` | Injection and its visible trace | Deciding *whether* to inject |

---

## 3. The lifecycle of one tool call

Using `computer_use_act` with `{ action: "click", appId: "mspaint", element: 12 }` as the example:

1. **Master switch.** `requireEnabled()` refuses immediately if `enabled` is `false`.
2. **Target resolution on the host.** The tool needs an application id, a window handle or an
   element index. With only coordinates it refuses (`no_target`) — the sandbox has to know which
   application is about to be touched. With only an element index or an `hwnd`, the tool calls
   `apps.list` through the driver to resolve the owning application first.
3. **Layer 1 — sandbox.** `checkSandbox(appId, config, true)` runs on the host, in this order:
   hard-coded refusals → `deniedApps` → `readOnly` → `allowAllApps` / the allow-list. A non-empty
   `allowedApps` list that does not contain the application is a refusal (`app_not_allowlisted`); an
   empty list is not. `allowAllApps: true` short-circuits the allow-list step and pre-approves
   everything that survived the two checks before it — which is why the ordering matters: shells,
   the UAC prompt, the credential UI, the logon surface and Registry Editor are refused before
   `allowAllApps` is ever consulted. A whitelisted application is written into the ledger as
   `allow-list` and skips layer 2.
4. **Layer 2 — approval.** If `requireApproval` is on and the application is not already in the
   ledger, `askApproval()` calls `ctx.get('approval').request({ agent, toolName, reason,
   displayReason: { en, zh } })`. Exactly one outcome proceeds (`allowed-once`); `rejected`,
   `cancelled`, `unavailable`, a missing service, a missing agent or a thrown error are all
   refusals, and the refusal text is returned to the model unchanged.
5. **Consent.** The one-time system-level consent (`firstRunConsent`, `consent.json`) is raised by
   `gateFirstUse` at the top of every entry point that actually touches the desktop —
   `computer_use_state`, `computer_use_act` and `computer_use_launch`. `computer_use_status` with
   `action: "consent"` re-raises it deliberately, and `computer_use_apps` stays ungated so window
   discovery never prompts. Once granted, the record is read by every subsequent `status` report.
6. **Dispatch selection.** `dispatch` comes from the action argument when present, otherwise from
   the configured value. It is passed to the driver verbatim.
7. **Baseline.** When refresh is on, the host takes a tree fingerprint of the window *before* the
   action (`state` with `includeTree: true, captureMode: "none"`). This is what makes the verdict
   possible.
8. **Coordinate mapping.** If the model measured against a screenshot, the host remembers that
   screenshot's `originX/originY/scale` and converts `screenshotX/screenshotY` to physical screen
   pixels before the request is sent. The driver only ever sees physical pixels.
9. **The request.** `driver.call('act', params, driverPolicy(config, approvedIds), timeoutOf(config))`.
   The `policy` block carries `readOnly`, `approvedApps`, `deniedApps`, `allowElevatedTargets`,
   `allowForegroundEscalation` and `maxActionsPerMinute`.
10. **Inside the driver.** `Actions.Execute` resolves the target, then `Policy.RequireApp(window,
    policy, mutating)` re-checks everything against the *live* window: hard-coded refusals, the
    configured deny-list, `readOnly`, the approved list, elevation, session and lock state. Then
    `Policy.RequireBudget(policy)` spends one unit of the rolling per-minute budget. Only then does
    the selected backend run.
11. **A point must be inside the approved window.** If the caller named a window and the point
    falls outside its bounds, the driver raises `point_outside_target` and injects nothing.
12. **The action.** Exactly one backend produces exactly one effect: a UIA pattern, one or more
    window messages, or `SendInput` through the system queue.
13. **Refresh and verdict.** The host re-reads the tree, fingerprints it, and reports
    `confirmed` / `suspected_noop` / `unverifiable` with a one-line justification, plus the fresh
    window state and (if screenshots are on) a fresh screenshot.
14. **Idle accounting.** `driver.touchIdle()` restarts the idle-shutdown timer, so the driver is
    reclaimed after `idleShutdownMs` of quiet instead of staying resident forever.

---

## 4. Dispatch: one decision, three backends

`Actions.ResolveDispatch` normalises the mode. `Actions.Execute` then routes each action to a
handler that has its own background/foreground logic, because "can this be done without the
foreground?" is a per-action question:

| Action family | Background mechanism (in order of preference) | Foreground mechanism |
|---|---|---|
| Click family | UIA `InvokePattern` / `TogglePattern` on the addressed element, else `WM_MOUSEMOVE` + `WM_*BUTTON*` to the window (or to the focused child, when one exists) | activate, `SetCursorPos` equivalent via `SendInput` absolute move, then button down/up |
| `type` | UIA `ValuePattern.SetValue` on the addressed element (append or replace), else `WM_CHAR` per character | activate/focus, then `KEYEVENTF_UNICODE` keystrokes |
| `key` | `WM_KEYDOWN`/`WM_KEYUP` (+ `WM_SYSKEY*` for extended keys), with modifier bookkeeping | activate, then virtual-key `SendInput` |
| `scroll` | UIA `ScrollPattern`, else `WM_MOUSEWHEEL`/`WM_MOUSEHWHEEL` | activate, move, then wheel `SendInput` per click |
| `drag` | — | activate, press, interpolated moves (~16 ms steps, 120–4000 ms), release |
| `paste_text` | clipboard write + `WM_KEYDOWN ctrl` / `v` | clipboard write + `SendInput` Ctrl+V |
| Pattern actions (`invoke`, `toggle`, `expand`, `collapse`, `select`) | the UIA pattern, always | — |
| `set_value` | UIA `ValuePattern.SetValue`, always | — |
| `focus`, `activate` | — | UIA `SetFocus` / `SetForegroundWindow` |

**Why background sometimes refuses.** `Input.KnownPostMessageBlocker(window)` classifies window
classes that are known to drop or partially drop synthetic window messages: Chromium
(`Chrome_WidgetWin*`, `Chrome_RenderWidgetHostHWND`), UWP (`Windows.UI.Core.CoreWindow`,
`ApplicationFrameWindow`), GTK/WebKit (`SoPY_Avatar`). WPF (`HwndWrapper`) is explicitly *not* a
blocker for clicks — it accepts `PostMessage` for clicks but not for drags, which is handled by the
per-action logic rather than by a blanket refusal. When a blocker is present:

* `dispatch: "background"` → `background_unavailable` (always), with `detail.reason`;
* `dispatch: "auto"` → escalation to foreground **only if** `policy.allowForegroundEscalation`;
* `dispatch: "foreground"` → foreground, no questions asked.

**Activation without UIAccess.** `Actions.Activate` restores a minimized window, and if it is not
already foreground it attaches the current thread's input to both the target thread and the
current foreground thread, calls `SetForegroundWindow`, and polls for up to about one second.
Windows' foreground-lock rules can still refuse; the driver then raises `activation_failed` rather
than clicking into whatever happens to be on top.

---

## 5. Perception

**Accessibility tree.** `Ax.Capture` walks the UIA control view with a `CacheRequest` (name,
control type, bounding rectangle, enabled, offscreen, automation id, class name, focus,
focusable, pattern availability, value), assigns each kept node an index in visit order, and stops
at `maxNodes` with `truncated: true`. If UIA yields nothing usable (no node kept, or at most two
elements visited), it falls back to an MSAA walk and keeps whichever produced more nodes, recording
the winner in `tree.backend` (`uia` or `msaa`). Nodes carry `bounds`, `centerX/centerY`, `actions[]`
(`invoke`, `toggle`, `set_value`, `set_range`, `expand`, `select`, `scroll`), plus `enabled`,
`focused`, `offscreen` and `focusable` flags.

**Indexes are snapshot-scoped.** `Ax.Last` holds the newest snapshot. `set_value`, pattern actions
and element-addressed clicks resolve through it; an index that is not in it raises `stale_element`,
and an element-addressed action with no snapshot at all raises `no_snapshot`. This is the mechanism
behind the "observe → act → re-observe" discipline documented in the README.

**Rendering.** `renderTree` prints one line per node — `[index] Role "name" value=… (flags)
@centerX,centerY actions=…` — and stops when the character budget (`maxTreeChars`, floor 500) is
exhausted, adding a footer that says how many of how many nodes were shown. Tree text is never
dumped raw JSON: the model addresses elements by the printed index.

**Pixels.** `Windows.CaptureWindow` tries `PrintWindow(PW_RENDERFULLCONTENT)` first, because it
renders the window itself and cannot be confused by an overlapping window. It validates the result
with a cheap blankness test (a 32×32 sample grid; ≥ 98.5 % near-black counts as blank). If
`PrintWindow` fails or returns a blank frame — DirectComposition, WinUI 3 and other GPU surfaces—
it falls back to a screen-region `BitBlt` with `SRCCOPY | CAPTUREBLT`, marked `covered: true` and
carrying a note that the image may show whatever is on top and cannot say which. Minimized windows
are refused (`window_minimized`) before any of this, because they have no pixels.

**Coordinate spaces.** A capture records `originX/originY` (the window's top-left, or the virtual
screen's for a screen capture) and `scale`. `fromScreenshotSpace` maps image pixels to physical
screen pixels; `computer_use_act` applies it to `screenshotX/screenshotY` and
`toScreenshotX/toScreenshotY`, and the host remembers the last screenshot per window (a 32-entry
map keyed by `hwnd:` or `app:`) so the conversion is possible after the fact.

**Attachments.** A screenshot returns as PNG bytes; `publishScreenshot` hands them to the
`attachments` service (resolved lazily through `ctx.get('attachments')`) and the transcript carries
the durable reference. If no attachment service is composed, the tool still returns the text
summary and says the image was not attached — it never inlines base64 into the transcript.

**The synthetic cursor.** `CursorOverlay` runs its own STA thread with a message loop and creates a
`WS_POPUP` window with `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE |
WS_EX_TOPMOST`, painted through `UpdateLayeredWindow(ULW_ALPHA)`. `WS_EX_TRANSPARENT` is what makes
it click-through and `WS_EX_NOACTIVATE` is what keeps it from ever taking focus; the physical
pointer is never moved. It is hidden around a screen-region capture so it cannot appear in the
image. It is a trace of intent, not the injection mechanism: the action underneath may be a UIA
pattern, a window message or `SendInput`.

---

## 6. The two control layers as a system

```text
                      ┌─────────────────────────────┐
   tool call ────────►│ LAYER 1 · sandbox (host)    │
                      │ static, synchronous, pure   │
                      └──────────────┬──────────────┘
                          refused ───┤ allowed
                                     ▼
                      ┌─────────────────────────────┐
                      │ LAYER 2 · approval (harness)│
                      │ live, asynchronous, once    │
                      │ per application per session │
                      └──────────────┬──────────────┘
                          refused ───┤ allowed-once
                                     ▼
                      ┌─────────────────────────────┐
                      │ driver re-check (in-proc)   │
                      │ live window, policy block,  │
                      │ rate budget, lock/elevation │
                      └──────────────┬──────────────┘
                                     ▼
                                injection
```

The layering is not cosmetic:

* **Layer 1 is pure and cheap.** It answers without spawning a driver or touching a window, which is
  why `computer_use_apps` can run the same predicate to annotate every visible application with
  `sandboxAllowed` / `whitelisted` / `needsApproval` and never surprise the user.
* **Layer 2 is the only place a human is asked.** It runs at most once per application per session,
  because the harness vocabulary has no "allow always" — the ledger supplies the memory the
  vocabulary lacks, and it dies with the process.
* **The driver re-checks.** The host's list of approved applications travels with each request, and
  `Policy.RequireApp` verifies the *live* window again: an `hwnd` can be recycled between approval
  and action, and the driver is the only component in a position to notice.

---

## 7. Process and lifecycle management

| Concern | Mechanism |
|---|---|
| Locating the driver | `driverPath` if set and present, else the shipped `lib/native/TurtleComputerUse.exe`, else a previously compiled `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\bin\TurtleComputerUse.exe` |
| Compiling on demand | `autoBuildDriver` runs `powershell.exe -NoProfile -ExecutionPolicy Bypass -File native/build.ps1 -OutputDir <cache> -Quiet` with a 180 s timeout; a failure is logged and surfaces later as `driver_missing` |
| Handshake | The driver writes `{"event":"ready","version":…,"pid":…,"elevated":…}` on stdout at startup; the client records it and uses it for `computer_use_status` |
| Framing | One JSON object per line, in both directions. Unknown or unparsable lines are logged and skipped, never fatal |
| Concurrency | A request id map; one in-flight entry per id, each with its own timer |
| Timeout | On expiry the client kills the process, rejects with `driver_timeout` naming the method, and respawns on the next call |
| Unexpected exit | Every in-flight request is rejected with `driver_exited` (code and signal included); the next call respawns |
| Idle reclamation | `idleShutdownMs` after the last `touchIdle()` the client sends `shutdown` and then kills if the process has not exited within 1.5 s |
| Unload | `ctx.effect(() => () => driver.dispose())` — a plugin reload never leaves an orphan driver |
| Environment | The client spawns with `TURTLE_CU_IDLE_SHUTDOWN_MS=0` so the driver does not shut itself down behind the host's back; `TURTLE_CU_VERBOSE=1` (set by the user) turns on the driver's own log at `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\driver.log` |

A hung accessibility provider is a Windows fact of life — third-party UIA providers are allowed to
block. The design answer is a bounded wait and a hard restart, not a cancellation protocol: a
harness that blocks forever on a broken provider is worse than one that reaps a process and starts
a fresh one.

---

## 8. Data persisted on disk

| Path | Written by | Contents |
|---|---|---|
| `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\consent.json` | host, when the consent prompt is accepted | `{ version, plugin, grantedAt, mode, note }`. Nothing about the screen |
| `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\bin\TurtleComputerUse.exe` | host, when `autoBuildDriver` compiles the driver | the compiled driver |
| `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\driver.log` | driver, only when `TURTLE_CU_VERBOSE=1` or `--verbose` | timestamped diagnostics, rotated by deletion above ~2 MB |
| `lib/native/TurtleComputerUse.build.json` | `native/build.ps1` | name, version, build time, SHA-256, size, compiler path, source list — `npm run check` verifies the size against the artefact |

`TURTLE_CU_LOG_DIR` relocates the driver log directory. The host never writes the driver log, and
the driver never writes the consent record.

---

## 9. Why it is built this way

* **A separate driver process, not a Node addon.** Input injection, DPI awareness and UIA work
  belong in a process that can be killed. Restarting a child is a safe recovery; restarting the
  harness is not.
* **No native modules, no SDK.** The driver compiles with the C# compiler that already ships with
  .NET Framework, so an install needs no toolchain, no package restore and no network.
* **Policy in two places on purpose.** The host's copy explains refusals early and cheaply; the
  driver's copy is the one that actually guarantees them, because it runs in the process that
  injects.
* **Honest refusals over best effort.** `background_unavailable`, `point_outside_target` and the
  verdict vocabulary exist because a computer-use agent that silently clicks the wrong place, or
  silently reports success after a dropped click, is worse than one that stops and says so.
* **`allowed-once` is respected.** The plugin does not fabricate an "always allow" the harness does
  not have; it keeps a session ledger and tells the user to edit `allowedApps` if they want
  persistence.
