# TurtlePlugin-DSH_ComputerUSE

**V0.1.0-rc1** · English | [中文](README.zh.md)

Computer Use for DeepSeek Harness on Windows: the agent sees a window through UI Automation and
acts on it through a native driver. It is the same shape of capability that `codex-computer-use.exe`
and Qwen Code expose — perception from the accessibility tree, action from synthetic input — with
two independent control layers in front of it and an honest account of what it cannot do.

| | |
|---|---|
| English product name | `TurtlePlugin-DSH_ComputerUSE` |
| Chinese product name | `DSH操纵电脑（TurtlePlugin）` |
| Version | `0.1.0-rc1` (displayed as `V0.1.0-rc1`) |
| npm package | `turtle-plugin-dsh-computer-use` |
| Cordis plugin id | `computer-use` |
| Native driver | `TurtleComputerUse.exe` |
| Repository | <https://github.com/turtlelnc/TurtlePlugin-DSH_ComputerUSE> |
| Platform | Windows 10 / 11 (`os: ["win32"]`) |
| License | Apache-2.0 |

---

## 1. What it does

The plugin registers six tools with DeepSeek Harness. Together they let the model:

* enumerate the applications and windows that are open;
* read a window's accessibility tree as indexed text (UI Automation, with an MSAA fallback for
  legacy toolkits) and/or take a PNG screenshot of it;
* perform exactly one input action — click, type, key, scroll, drag, set a value, invoke a control —
  through UIA patterns, targeted window messages, or the real system input queue;
* wait for a condition instead of polling;
* launch an application and wait for its first window.

Windows-specific realities are handled by a separate process, `TurtleComputerUse.exe`, which owns
DPI awareness (per-monitor v2, so screenshot pixels are physical pixels), window enumeration,
capture, the accessibility walk and every injected event. The harness side never touches the
desktop directly; it talks to the driver over newline-delimited JSON on stdin/stdout.

---

## 2. The two dispatch modes

`dispatch` decides *how* input reaches the target. It is the setting most users will touch, and the
one with the clearest consequences.

| Mode | What happens | Your mouse and keyboard |
|---|---|---|
| `background` (default) | The plugin paints its own cursor on a transparent, click-through, never-activated layered window that spans the virtual screen, and drives the target with UIA patterns first, then targeted window messages (`PostMessage`). The system input queue is never touched, so the target window does not have to be foreground. | untouched |
| `foreground` | The window is activated (`SetForegroundWindow`, with the usual thread-input workaround) and input goes through `SendInput` — the real pointer moves, exactly like `codex-computer-use.exe`. | taken over for the duration of the action |
| `auto` | Background first. When the target provably cannot be driven in the background **and** `allowForegroundEscalation` is on, that one action falls through to foreground. | untouched unless an escalation happens |

Three properties of this design matter:

1. **Background mode refuses instead of stealing the foreground.** When a target cannot be driven
   in the background, the driver raises a structured `background_unavailable` error carrying the
   reason (window class, `appId`, class name). It does not silently escalate. The tool result then
   suggests the fix explicitly:

   ```text
   background_unavailable: This target cannot be driven without taking the foreground: Chromium
   content ignores synthetic window messages for coordinate input; it needs the system input queue.
   Re-issue the same action with dispatch="foreground" to accept the takeover, ...
   ```

2. **The caller opts in per action.** `computer_use_act` takes a `dispatch` parameter
   (`background` | `foreground` | `auto`) that overrides the configured mode for that single call:

   ```json
   { "action": "click", "appId": "notepad", "element": 12, "dispatch": "foreground" }
   ```

   Setting `computerUse.dispatch` to `foreground` in **Settings → Plugins** makes the takeover the
   default for the whole session instead.

3. **`auto` is not a licence to escalate.** In `auto` mode an escalation happens only when the
   driver has a positive reason (a known message-blocking window class) *and*
   `allowForegroundEscalation` is `true`. With `allowForegroundEscalation: false`, even `auto`
   returns `background_unavailable` and waits for a human decision.

Per-action detail, because "background" is not one mechanism but three:

| Action | Background route | Background refusal |
|---|---|---|
| `click`, `double_click`, `right_click`, `middle_click` | UIA `InvokePattern`/`TogglePattern` when an element index was given, otherwise `WM_*BUTTON*` window messages at the element's client coordinates | blocking window class |
| `type` | UIA `ValuePattern.SetValue` when an element with a writable value is addressed, otherwise `WM_CHAR` messages | blocking window class |
| `key` | `WM_KEYDOWN`/`WM_KEYUP` messages to the window (or the focused child) | blocking window class |
| `scroll` | UIA `ScrollPattern`, otherwise `WM_MOUSEWHEEL` | blocking window class |
| `hover` | `WM_MOUSEMOVE` message | never refused (nothing is clicked) |
| `drag` | not available — a drag needs a continuous press-move-release on the system queue | always `background_unavailable` |
| `set_value`, `invoke`, `toggle`, `expand`, `collapse`, `select` | the matching UIA pattern; these are background-only by nature | `no_uia_element` / `pattern_unavailable` |
| `paste_text` | clipboard write + `WM_KEYDOWN ctrl` / `v` messages, when the class is not blocking | blocking window class, or `allowForegroundEscalation: false` |
| `focus`, `activate` | not available — both are foreground operations by definition | — |

---

## 3. The two control layers

Permission for a Computer Use action is decided twice, by two mechanisms that do not trust each
other. Layer 1 is static configuration evaluated on the host and re-enforced inside the driver for
every action that touches a window. Layer 2 is a live question asked through the DeepSeek Harness
approval service. (One asymmetry: a *launch* is gated by the host, because the driver only enforces
`readOnly` and the rate budget for it — see
[docs/driver-protocol.md](docs/driver-protocol.md#7-reciprocity-who-enforces-what).)

### Layer 1 — the sandbox

| Control | Setting | Default | Effect |
|---|---|---|---|
| Allow-list | `allowedApps` | `[]` (empty) | Applications listed here are cleared without an approval prompt. **An empty list is not "allow nothing"**: it means "any application that is not denied needs one approval". A non-empty list is restrictive: anything not on it is refused with `app_not_allowlisted`. |
| Deny-list | `deniedApps` | `[]` | Always wins over the allow-list. Refused with `app_denied`. |
| Observe-only | `readOnly` | `false` | Window listing, accessibility trees and screenshots keep working; every click, keystroke and launch is refused with `read_only`. |
| Rate limit | `maxActionsPerMinute` | `240` | Rolling one-minute budget on injected actions, enforced in the driver (`rate_limited`). `0` disables it. |
| Elevated targets | `allowElevatedTargets` | `false` | When off, a window belonging to an elevated process is refused with `target_elevated` before anything is injected. |
| Browsers | `allowedBrowsers` | `false` | Browser windows are described but not enabled by default: their content is a web page, so a coordinate click cannot be checked against the accessibility tree. |

And a refusal list that **no configuration can lift**, enforced inside `TurtleComputerUse.exe`
independently of the host's copy (`policy.explain` reports both lists):

* **Shells and terminals** — `cmd`, `powershell`, `pwsh`, `windowsterminal`, `wt`, `conhost`,
  `openconsole`, `bash`, `wsl`, `wslhost`, `cscript`, `wscript`, `mshta`, `rundll32`, `reg`, `net`,
  `netsh`, `schtasks`, `sc`, `curl`, `ssh`, `putty`, `mintty`, `conemu64`, `alacritty`,
  `wezterm-gui`. A computer-use agent typing into a shell is arbitrary code execution wearing a
  mouse costume; the refusal message points the model at the shell tool instead.
* **Security surfaces** — the UAC consent prompt (`consent`), the credential UI
  (`credentialuibroker`), the logon/lock surface (`logonui`), `winlogon`, `lsass`, the UAC settings
  page (`useraccountcontrolsettings`), and Registry Editor (`regedit`).

Two further sandbox properties are worth knowing because they close real holes:

* **A point must land inside the approved window.** If the caller named a window and the coordinate
  falls outside its bounds, the driver raises `point_outside_target` and injects nothing. Without
  that check, approving application A and clicking at a pixel over application B would be a hole in
  the sandbox.
* **An action must name a target.** `computer_use_act` refuses a coordinate with no `appId`,
  `hwnd` or `element` outright (`no_target`), because the sandbox has to know which application it
  is about to touch before it can approve it.

### Layer 2 — approval

1. **One system-level consent, recorded once.** A single DeepSeek Harness approval question
   describes what the driver will be able to see and do in the configured dispatch mode.
   It is raised automatically the first time anything actually touches the desktop —
   `computer_use_state`, `computer_use_act` or `computer_use_launch` — and accepting it writes
   `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\consent.json` so it is not asked again;
   `computer_use_status` reports whether consent has been recorded yet and can re-raise it with
   `action: "consent"`, and `firstRunConsent: false` turns the prompt off entirely.
   `computer_use_apps` stays ungated, so the model can always discover what is open without
   prompting you.
2. **One prompt per application**, for an application that is not on the allow-list and has not
   been cleared yet in this session. The prompt names the application, the window title, the first
   action and the dispatch mode.
3. **Remembered for the session, not forever.** The harness approval vocabulary is closed and
   one-shot — `allowed-once` / `rejected` / `cancelled` / `unavailable`, with no `allow-always`,
   no remembered rule and no grant store. The plugin therefore records the grant in an in-memory
   ledger for the rest of the session rather than pretending the harness offered permanence.
   `computer_use_status` with `action: "reset"` clears the ledger; editing `allowedApps` in
   Settings is what makes a grant survive a restart.
4. **It fails closed.** With the session approval policy set to `never`, with no answerer composed
   in the profile, with no agent on the call, or if the question cannot be delivered, the request
   is **rejected** and nothing is clicked, typed or launched. There is no "assume yes" path.

---

## 4. Settings

Every field marked `.volatile()` in the schema is editable live in **Settings → Plugins** (namespace
`computer-use`); the same values can be seeded at load time from the profile's `cordis.patch.yml`.
Defaults below are the real schema defaults.

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. When off, every tool returns a refusal instead of touching the desktop. |
| `dispatch` | `background` \| `foreground` \| `auto` | `background` | See §2. |
| `allowedApps` | string[] | `[]` | Sandbox allow-list. Entries are exe leaf names (`excel.exe`, `mspaint.exe`, `notepad.exe`). Hit these and no approval prompt is raised. |
| `deniedApps` | string[] | `[]` | Sandbox deny-list. Always wins over the allow-list. |
| `readOnly` | boolean | `false` | Observe-only sandbox. |
| `requireApproval` | boolean | `true` | Layer 2. When off, an application the sandbox allowed is driven without a prompt. |
| `firstRunConsent` | boolean | `true` | Show the one-time system-level consent prompt on first use. |
| `allowForegroundEscalation` | boolean | `true` | Allow a single action to fall back to foreground injection when the target provably cannot be driven in the background. When off, `background_unavailable` is returned instead. |
| `allowElevatedTargets` | boolean | `false` | Allow driving windows owned by elevated processes (only works when DeepSeek Harness itself runs elevated — see §5). |
| `allowScreenshots` | boolean | `true` | Turning this off leaves the accessibility tree as the only way to perceive a window. |
| `syntheticCursor` | boolean | `true` | Paint the plugin's own cursor on a click-through overlay so you can see where the agent is about to act. It never moves your physical pointer. |
| `cursorIdleHideMs` | number | `2500` | Fade the synthetic cursor out after this much idle time. `0` keeps it visible. |
| `observeBeforeAct` | boolean | `true` | Require a fresh observation before each action, so element indexes always belong to the snapshot they were read from. |
| `autoRefreshAfterAction` | boolean | `true` | Return a fresh window state after every action, with a verdict saying whether the interface actually changed. |
| `maxTreeNodes` | number | `400` | Maximum accessibility-tree nodes returned per observation. |
| `maxTreeChars` | number | `12000` | Maximum characters of rendered tree text returned to the model. |
| `maxActionsPerMinute` | number | `240` | Sandbox rate limit on injected actions, per minute. `0` disables it. |
| `requestTimeoutMs` | number | `20000` | Per-request timeout for the driver. On timeout the driver is killed and restarted. |
| `launchTimeoutMs` | number | `20000` | How long `computer_use_launch` waits for a launched application to open its first window. |
| `captureScale` | number | `1` (0.1–1) | Screenshot scale. Clicks are always sent in physical pixels, so the plugin converts back for you; use `0.5` on a 4K display to halve the image cost. |
| `idleShutdownMs` | number | `300000` | Reclaim the driver process after this much idle time. `0` keeps it resident. |
| `driverPath` | string | `''` | Absolute path to `TurtleComputerUse.exe`. Empty means auto-detect: the copy shipped in the plugin, then a previously compiled copy under `%LOCALAPPDATA%`. |
| `autoBuildDriver` | boolean | `true` | Compile the driver from `native/` with the in-box .NET Framework compiler when no executable is found. No SDK, no NuGet, no network. |
| `allowedBrowsers` | boolean | `false` | Allow driving browser windows. |

**Application ids are normalised.** `allowedApps` and `deniedApps` entries, the `appId` a tool
takes, and everything the driver compares are reduced to a lowercase exe leaf name without the
`.exe` suffix: `mspaint.exe`, `MSPAINT`, `C:\Windows\System32\mspaint.exe` and
`process:C:\apps\EXCEL.EXE` all match. Write whichever form you have in front of you.

**Where each switch actually bites.** `readOnly`, `maxActionsPerMinute`, `allowElevatedTargets`,
`allowForegroundEscalation`, `deniedApps`, `syntheticCursor`, `cursorIdleHideMs` and the
cleared-application list are handed to the driver with every request in the request's `policy`
block, and the driver enforces them itself — including the hard-coded shell/UAC refusal list, which
the driver applies to a launch as well as to an action. The allow-list, the consent record and the
approval ledger live on the harness side.

`observeBeforeAct` is enforced in two places: the driver answers `no_snapshot` / `stale_element` for
an element index that is not part of the newest snapshot, and the host refuses a purely
coordinate-addressed action on a window this session has never observed (`not_observed`), because a
coordinate on an unseen window is a guess rather than a plan. `computer_use_state` is what clears
that gate.

---

## 5. The six tools

| Tool | Purpose |
|---|---|
| `computer_use_status` | Self-check: driver path and version, desktop session, lock state, both control layers, effective dispatch mode, and which applications are already cleared. Read-only. |
| `computer_use_apps` | List the applications and windows Computer Use can see, with each one's normalised `appId`, exe, title, size, elevation and whether the sandbox would allow it. Read-only, never needs approval. Start here. |
| `computer_use_state` | Observe one window: the indexed accessibility tree, a screenshot, or both. The only source of element indexes. |
| `computer_use_act` | Perform exactly **one** action, then return the new state and a verdict. |
| `computer_use_wait` | Wait for text to appear or disappear, for a window to open or close, or for a plain pause — one call instead of a polling loop. |
| `computer_use_launch` | Start an application and wait for its first window. Goes through both control layers. |

Full parameter reference, types, defaults and example calls: [docs/api.md](docs/api.md).

### The discipline the tools assume

**Observe → one action → re-observe.**

* **Element indexes are snapshots, not handles.** They come from the most recent
  `computer_use_state` of that window and are valid only for it. The driver keeps one snapshot, so
  an index from an older call fails with `stale_element` instead of landing somewhere plausible but
  wrong. Re-observe after every action.
* **One action per call.** `computer_use_act` deliberately has no batch mode: batching would
  hollow out the per-action rate limit, the approval audit trail and the verdict.
* **Every action carries a verdict.** A bare "ok" from an input-injection layer only means the
  events were queued — not that anything happened. When refresh is on (the default), the plugin
  fingerprints the accessibility tree before and after the action and reports one of:

  | Verdict | Meaning |
  |---|---|
  | `confirmed` | the accessibility tree changed after the action |
  | `suspected_noop` | the tree is byte-identical after the action. Many applications swallow synthetic input — check with a screenshot, or retry with `dispatch: "foreground"` |
  | `unverifiable` | no before/after observation pair was available |

* **Coordinates have a defined space.** `computer_use_state` returns an image and records its
  origin and scale; `screenshotX`/`screenshotY` (and `toScreenshotX`/`toScreenshotY` for a drag) are
  interpreted in that image and converted to physical pixels. `x`/`y` are physical screen pixels and
  are the last resort — prefer an element index.
* **Screenshots become attachments, not base64 in the transcript.** The bytes go through the
  harness attachment store so the transcript carries a durable reference.

---

## 6. Permissions and first use

**What the consent dialog says.** Raised automatically the first time Computer Use perceives a
window or injects input (`computer_use_state`, `computer_use_act`, `computer_use_launch`), and
re-raisable on demand with `computer_use_status action: "consent"`, it
names the plugin, states that this is a one-time system-level consent, and lists exactly what
becomes possible: reading accessibility trees and
taking screenshots of windows; clicking, typing, scrolling, dragging and launching applications in
the configured dispatch mode; whether your mouse and keyboard are taken over (`foreground`) or stay
yours (`background`); and that terminals, shells, the UAC prompt, the credential UI and the lock
screen are refused by the sandbox and cannot be enabled. It also shows the current allow-list and
the driver version. Nothing about your screen is recorded — the only thing written to disk is
`consent.json`, which records that you said yes.

**Driving an elevated window requires an elevated harness.** Windows User Interface Privilege
Isolation (UIPI) drops synthetic input sent from a lower-integrity process to a higher-integrity
window. `allowElevatedTargets: true` therefore does nothing on its own: DeepSeek Harness (and
hence the driver it spawns) must itself run elevated. `computer_use_status` warns about exactly
this combination — the flag on, the process not elevated — and the driver refuses per action with
`target_elevated` when the flag is off. The driver's manifest requests `asInvoker` with
`uiAccess="false"` on purpose: it never silently acquires elevation, so if elevation is needed
Windows shows its own UAC prompt because *you* started the harness that way.

**The driver is its own executable.** `TurtleComputerUse.exe` is not a shell-out to PowerShell and
not a Node addon; it is a small C# program with a Win32 message loop. It ships prebuilt inside the
package (`lib/native/TurtleComputerUse.exe`) and can be recompiled on the machine that installs the
plugin — on install via `npm run build`, or on first use when the executable is missing and
`autoBuildDriver` is on — using the C# compiler that ships with .NET Framework
(`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). No SDK, no NuGet restore, no network
access. A compiled copy is cached under `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\bin\`.
See [native/README.md](native/README.md).

---

## 7. Install

Two harness generations are current, and they install plugins in completely different ways. Read
§7.1 first.

### 7.1 Which harness are you on?

| Harness | Runtime version | Install surface that works | Status |
|---|---|---|---|
| **DeepSeek Harness desktop, v0.2.0** | `0.2.0-rc.2` | Web sidebar → **Plugins** → **Add plugin** | Supported |
| **`dsh` CLI, `0.1.7-rc.2`** (and `0.1.7-rc.1`, `0.1.6-*`, `0.1.5-rc.*`) | `0.1.7-rc.2` | `dsh plugin --profile <name> add …` | Supported, same build |
| Any other harness | — | — | Not tested |

The plugin declares its peers as `>=0.1.7-rc.2 <0.3.0`, so **one build serves both lines**. That is
not optimism: between `0.1.7-rc.2` and `0.2.0-rc.2` the three packages this plugin actually uses —
`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-user-approval` — are
**byte-for-byte identical**; only their `package.json` differs. `@deepseek-ai/cordis` is `~4.0.4`
and `@deepseek-ai/schemastery` is `~3.18.4` on both lines. Check yours with:

```powershell
dsh --version
```

**The package is not on npm yet.** The routes that work today are the tarball, a git address, and an
absolute local path. The npm-name route in §7.5 works only once the package has been published.

### 7.2 DeepSeek Harness desktop v0.2.0

The desktop app owns its own profile, so the CLI cannot install into it — the sidebar page is the
only supported route. Everything happens in the app.

1. **Open the Plugins page.** In the left sidebar, select **插件** (Chinese UI) / **Plugins**
   (English UI). It reads the profile's installed bundles through `api-remotes`; a host without a
   managed profile shows the page as unavailable.

2. **Choose a registry.** Click **Add plugin** (**添加插件**). Next to the field there is a
   **Registry** (**安装源**) selector:
   * the official npm registry,
   * **npmmirror** (the mainland-China mirror) — pick this if `registry.npmjs.org` is slow or
     blocked where you are,
   * a custom `http(s)` address for a private registry.

   On first use the app probes the official registry and npmmirror in parallel and preselects
   whichever answers a ping first; your choice is then remembered in this browser.

   > **The mirror proxies the npm registry, not GitHub.** If you install from a *git address* and
   > GitHub is unreachable, switching to npmmirror does not help — it will offer **Use mainland
   > China mirror** and return you to an empty field. Use the **tarball** or **npm name** spec
   > instead when GitHub is blocked.

3. **Paste the spec.** The field accepts exactly what follows `dsh plugin add` in a README, plus git
   addresses and paths. Today, use one of:

   ```text
   C:\Users\<you>\Downloads\turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz      ← tarball (recommended)
   C:\Users\<you>\Videos\Turtle.AI-DSH_Plugin\Turtle.AIplugin-DSH_ComputerUSE  ← absolute local path
   github:turtlelnc/TurtlePlugin-DSH_ComputerUse                               ← git (needs GitHub access)
   turtle-plugin-dsh-computer-use@0.1.0-rc1                                    ← npm, after publication
   ```

   You cannot get the tarball from GitHub Releases yet either — build it in one step with §7.7, or
   clone the repository and point the field at the folder.

4. **Read the trust box, then install.** The box stays visible above **Install** and says that
   installed plugins **do not update automatically**: upgrading means uninstalling and installing
   the new version. Installing runs `pnpm add` in the profile directory, so from this point on, code
   from that package executes inside the harness process. The dialog shows pnpm's command and output
   behind **Show install details**.

   The host inspects the spec before installing: a name no registry has, a path without a
   `package.json`, a package without a `dsh.bundle` patch, or a spec pnpm would refuse all come back
   as one sentence under the field.

5. **Enable it.** A finished install offers **立即启用 / Enable now**, which switches the bundle on,
   closes the dialog and scrolls the list to it. If you close instead, the bundle stays installed but
   **off** — open its card under **Installed** and switch it on there.

6. **Restart DeepSeek Harness.** The loader patch is read when the profile starts, so the six
   `computer_use_*` tools do not exist until the app is restarted.

7. **Configure the allow-list.** Either way works:
   * **Plugins → computer-use → Configure** — the plugin's own configuration page, rendered from its
     schema, with the allow-list, the deny-list, the dispatch mode and the rest;
   * **Settings → Built-in plugins** — the read-only inventory, for confirming that it mounted at all.

### 7.3 `dsh` CLI (0.1.7-rc.2 and the rest of the 0.1.x line)

`dsh plugin --profile <name> <pnpm args>` forwards its arguments to pnpm **inside the profile
directory**, so `add`, `remove`, `update` and `install` all work, plus the version-exemption
subcommands in §7.4.

> **The `desktop` profile cannot be managed from the CLI.** The `desktop` name is reserved for the
> Electron-owned profile, and the CLI rejects boot, config-dump and plugin-management requests for
> it. Use the desktop app's Plugins page (§7.2) for that profile, or work in `web` / another profile
> from the CLI.

```powershell
# 0. One-time: get a tarball to install from.
git clone https://github.com/turtlelnc/TurtlePlugin-DSH_ComputerUse.git
cd TurtlePlugin-DSH_ComputerUse
pnpm install
pnpm pack
#   → turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz

# 1. Install into a profile. `web` is the CLI's own Web profile and
#    auto-initialises on first use; use whatever profile name you run.
dsh plugin --profile web add .\turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz

# 2. Reconcile: the bundle must appear in dependencies AND in dsh.profile.bundles.
Get-Content $env:USERPROFILE\.dsh\profiles\web\package.json

# 3. Compose check: a "# == turtle-plugin-dsh-computer-use" layer must appear,
#    with no duplicate-id warning and no "declares no dsh.bundle" error.
dsh --profile web --dump-config | Select-String "turtle-plugin" -Context 2,12

# 4. Restart the harness with that profile.
dsh --profile web
```

`$DSH_HOME` moves the whole `profiles/` tree if you do not want it under `%USERPROFILE%\.dsh`.

After the restart, the equivalent of the desktop **Configure** page is the plugin's Settings form,
which appears because every configurable field is declared `.volatile()`; a write from the form is
saved into that profile's `cordis.patch.yml`.

The same three spec forms work here:

```powershell
dsh plugin --profile web add turtle-plugin-dsh-computer-use          # npm name (after publication)
dsh plugin --profile web add github:turtlelnc/TurtlePlugin-DSH_ComputerUse
dsh plugin --profile web add C:\abs\path\to\Turtle.AIplugin-DSH_ComputerUse
```

> **Prefer the tarball over a local directory.** With pnpm 10/11 on Windows, `add <absolute path>`
> can produce a broken symlink (and `dsh` then misreports *"declares no dsh.bundle"*), and a linked
> plugin that lives outside `$DSH_HOME/profiles/` cannot resolve its peers at runtime. A tarball
> behaves exactly like a registry install.

### 7.4 If the version check refuses the install

Both lines enforce **declared DSH peer ranges against the running runtime version**, before pnpm
runs. This plugin declares `>=0.1.7-rc.2 <0.3.0`, which both lines satisfy, so a refusal should not
happen. If a future release does refuse it, the harness prints the exact command to run — an
*exact-version exemption*, recorded in the profile's own `compatibility.json` beside `package.json`:

```powershell
dsh plugin --profile web version-exemptions                              # current runtime + saved grants
dsh plugin --profile web allow-version turtle-plugin-dsh-computer-use@0.1.0-rc1 `
    --dsh-version 0.1.7-rc.2 --accept-risk
dsh plugin --profile web revoke-version turtle-plugin-dsh-computer-use@0.1.0-rc1 `
    --dsh-version 0.1.7-rc.2
```

A grant covers **one exact package version on one exact runtime version** — it does not survive a
plugin upgrade or a harness upgrade, and it takes effect on the next composition. In the desktop app
the same thing is offered in the failure dialog. Read the risk warning before accepting: an
incompatible plugin runs in-process and can crash the harness.

### 7.5 Verify the install

From inside a session, either harness:

```text
computer_use_status     → driver path and version, desktop lock state, both control layers
computer_use_apps       → what is visible right now
```

`computer_use_status` is the fastest way to tell a broken install from a broken driver: it reports
`native driver: UNAVAILABLE` with the reason when the executable is missing, and the full sandbox and
approval state when it is not.

### 7.6 Upgrade and uninstall

**Desktop:** **Plugins → Installed → the bundle's card.** Uninstalling asks for confirmation. To
upgrade, uninstall and install the new version — installed plugins never update themselves.

**CLI:**

```powershell
dsh plugin --profile web remove turtle-plugin-dsh-computer-use
```

If the previous install came from a tarball that no longer exists on disk, `remove` first and then
`add` the new one: a stale `file:` spec makes pnpm fail with `ENOENT`.

### 7.7 Building from source

```powershell
git clone https://github.com/turtlelnc/TurtlePlugin-DSH_ComputerUse.git
cd TurtlePlugin-DSH_ComputerUse
pnpm install          # keep .npmrc: auto-install-peers=false is required
pnpm build            # tsc → lib/, then csc → lib/native/TurtleComputerUse.exe
pnpm pack             # → turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz
```

`lib/` and `lib/native/TurtleComputerUse.exe` are committed to the repository on purpose: a harness
installed from git loads `lib/index.js` directly and **does not run a build step**, so shipping the
built plugin is what makes a git install work on a machine with no toolchain. Refresh them with
`pnpm build` before every commit that touches `src/` or `native/`.

`pnpm build` on a non-Windows host compiles the TypeScript and skips the native step with a warning.

**Windows only.** The package declares `os: ["win32"]`. On any other platform the manifest check
fails rather than installing something that cannot work.

### 7.8 Requirements

| Requirement | Version / note |
|---|---|
| Windows | Windows 10 or Windows 11, on the interactive desktop (not Session 0, not an SSH logon — see §9) |
| .NET Framework | 4.x, in-box. Used only to compile the driver; the executable itself needs no runtime install beyond what Windows ships |
| Node.js | `^22.19.0 \|\| >=24.0.0` (the harness requirement; the plugin inherits it) |
| DeepSeek Harness | desktop **v0.2.0** (`0.2.0-rc.2`) or CLI **`0.1.7-rc.2`** and the rest of the 0.1.x line — see §7.1 |
| Cordis | `~4.0.4` (`@deepseek-ai/cordis`) — the same range on both lines |
| Schemastery | `~3.18.4` (`@deepseek-ai/schemastery`) — the same range on both lines |
| Approval channel | `@deepseek-ai/dsh-user-approval`. Optional, but without it the approval layer has no way to ask and fails closed, so nothing can be driven unless it is on the allow-list |

---

## 8. Verification

Five commands, each proving something different. None of them requires a running harness.

```powershell
npm run typecheck
```

Type-checks `src/` against the real `@deepseek-ai/*` type definitions. Proves the plugin still
compiles against the declared peer versions.

```powershell
npm run build
```

Runs `tsc` into `lib/`, then compiles `native/src/*.cs` into `lib/native/TurtleComputerUse.exe`
with the in-box .NET Framework compiler and writes `lib/native/TurtleComputerUse.build.json`
(name, version, build time, SHA-256, size, compiler path, source list). On a machine without a
C# compiler the native step is skipped with a warning; the plugin still installs and compiles the
driver on first use.

```powershell
npm run check
```

The load check: **69 checks**, run against a mock Cordis context. It reads the real defaults off
the schemastery schema, mounts the plugin, registers the six tools, verifies tool names and
parameter schemas, drives `output.render` over three payload shapes per tool, exercises the sandbox
policy table (`normalizeAppId`, shells, UAC, allow-list, deny-list, observe-only), runs the
lifecycle disposer, and checks the built driver against its build stamp. **It has no desktop
effect** — no window is enumerated, no input is injected.

```powershell
npm run smoke
```

Drives the **real** driver over its **real** wire protocol, read-only: handshake, `ping`, `status`,
`capabilities`, `policy.explain`, `apps.list`, `windows.list`, one accessibility snapshot, and
three structured refusals (`app_denied`, `app_not_approved`, `read_only`) against the window it
just inspected. Add `--capture` to also take one window screenshot and write it to
`%TEMP%\turtle-computer-use-smoke\`. Nothing is clicked, typed or launched.

```powershell
node scripts/e2e-act.mjs --yes
```

**This one does touch your desktop.** It mounts the real plugin against a harness double, launches
Notepad (`--app=mspaint` changes the target), types a marker string, waits for that text to appear
in the accessibility tree, checks that a screenshot was attached, that the approval prompt fired
exactly once and was remembered, that a point outside the approved window is refused
(`point_outside_target`) and that a coordinate-only click is refused (`no_target`), that a shell is
refused before anything is touched, and that observe-only mode refuses injection — **20 checks** —
then closes the process it started. The `--yes` flag is mandatory; without it the script prints
what it would do and exits.

---

## 9. Known limits

Stated plainly, because each one has bitten a computer-use implementation before:

* **A minimized window has no pixels.** `computer_use_state` with a screenshot mode fails with
  `window_minimized`. Restore the window, or observe the accessibility tree alone
  (`captureMode: "tree"`, or the driver's `ax` capture mode).
* **Hardware-composited surfaces return a black frame.** Windows that draw through
  DirectComposition, WinUI 3 or another GPU surface give `PrintWindow` a blank result. The driver
  detects this and falls back to a screen-region `BitBlt`, which it marks `covered: true` with a
  note saying the capture may show whatever window is on top — and cannot tell you which. A
  region that is almost entirely black is reported the same way.
* **Chromium, Electron and UWP content ignores synthetic window messages.** For those window
  classes the driver refuses background coordinate input with `background_unavailable` and names
  the reason; the action needs `dispatch: "foreground"` (or `auto`, if you accept escalation).
  Some UWP surfaces accept some synthetic messages and drop others, which is why the refusal is
  unconditional rather than best-effort.
* **The accessibility tree is sometimes empty or misleading.** Custom-rendered and GPU-only
  surfaces expose nothing useful. The rendered tree says so explicitly and suggests a screenshot or
  coordinates; `captureMode: "both"` is the right call for canvases and charts.
* **A hung accessibility provider does not block the harness.** Third-party UIA providers are
  allowed to hang. `requestTimeoutMs` (default 20 s) bounds every request; on timeout the driver is
  killed and restarted on the next call, and the caller gets `driver_timeout` naming the method
  that hung — not a frozen session.
* **There is no UIAccess.** The driver's manifest is `asInvoker` with `uiAccess="false"`, so it
  cannot bypass the foreground lock. Bringing a window forward can be refused
  (`activation_failed`); the action then fails rather than clicking into whatever is on top.
* **Session 0 and SSH logons have no desktop.** A harness started as a service, from a service,
  or through an SSH logon sees no real windows; the driver answers `session_0` and `status` sets
  `interactiveSession: false`. Start DeepSeek Harness from the signed-in desktop.
* **A locked desktop looks like a dozen unrelated bugs.** While the desktop is locked, foreground
  activation, the clipboard and `SendInput` all fail at once. Every window-scoped read and write is
  refused with `desktop_locked` — a whole-screen capture is the only thing that still works — so the
  driver reports the single root cause instead of a pile of unrelated errors. Unlock and retry.
* **Clipboard-based pasting is visible.** `paste_text` replaces the clipboard contents.
* **Screen content is captured when you allow it.** `allowScreenshots: false` removes the
  capability; while it is on, anything visible inside a captured window — including other windows
  that overlap it, in the `covered: true` fallback — ends up in the model's context. See
  [docs/security.md](docs/security.md).

---

## 10. Troubleshooting

Every refusal is structured: a stable `code`, a message written to be read by a model, and usually
a `detail` object. The codes you are most likely to meet:

| Code | What it means | What to do |
|---|---|---|
| `desktop_locked` | The interactive desktop is locked or switched away. Foreground activation, the clipboard and `SendInput` all fail while locked, and every window-scoped read or write is refused; only a whole-screen capture still works. | Unlock the desktop and retry. Do not retry input actions while locked. |
| `target_elevated` | The target window belongs to an elevated process and the driver does not. UIPI will drop the input. | Run DeepSeek Harness elevated, set `allowElevatedTargets: true`, or do the step yourself. |
| `app_denied` | The deny-list, the hard-coded shell list, or the hard-coded security-surface list refused the application. | If it is your `deniedApps`, remove the entry. If it is a shell or the UAC/credential/lock/regedit list, it cannot be lifted — use the shell tool or do it yourself. |
| `app_not_approved` | The host did not clear the application for a mutating action. | Approve the prompt, add the application to `allowedApps`, or run `computer_use_status` to see the ledger. |
| `read_only` | `readOnly` is on, so no click, keystroke or launch is allowed. | Turn `readOnly` off in **Settings → Plugins** when you really want control. |
| `background_unavailable` | The target cannot be driven without the foreground (Chromium/UWP content, a drag, or a non-escalating policy). | Re-issue the same action with `dispatch: "foreground"`, set `computerUse.dispatch = "foreground"`, or ask the user to do it. |
| `point_outside_target` | The coordinate lies outside the window the sandbox approved. | Re-observe with `computer_use_state` and address an element, or send a point inside the window. |
| `window_minimized` | A screenshot was requested for a minimized window, which has no pixels. | Restore the window, or use `captureMode: "tree"`. |
| `rate_limited` | The per-minute action budget (`maxActionsPerMinute`, default 240) is spent. | Wait for the window to roll over, or raise the limit deliberately. |
| `driver_missing` | `TurtleComputerUse.exe` was not found: no `driverPath`, no shipped copy, no cached build, and the compile failed or `autoBuildDriver` is off. | Run `npm run build:native`, set `driverPath`, or set `autoBuildDriver: true` and read `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\driver.log`. |
| `driver_timeout` | The driver did not answer within `requestTimeoutMs`; it was stopped and will restart on the next call. Usually a hung accessibility provider in the target application. | Retry once (a fresh driver process is started), then read the driver log; if it repeats for one application, avoid driving that application. |
| `activation_failed` | The window could not be brought to the foreground: locked desktop, or another process holding the foreground. | Unlock the desktop, try again, or use background dispatch instead. |
| `clipboard_failed` | The clipboard could not be written after several attempts — locked desktop, or another process holding it open. | Unlock the desktop, close the clipboard-holding application, or use `type` instead of `paste_text`. |
| `no_target` | An action addressed no application: no `appId`, `hwnd` or `element`, or the named window no longer exists. | Run `computer_use_apps`, then pass a valid `appId` (or an `element` from the newest `computer_use_state`). |

Other codes the driver or the host can return: `no_snapshot`, `stale_element`, `no_uia_element`,
`pattern_unavailable`, `pattern_failed`, `read_only_element`, `window_empty`, `input_rejected`,
`launch_failed`, `no_accessibility_tree`, `capture_failed`, `unknown_app`, `unknown_method`,
`bad_request`, `invalid_request`, `parse_error`, `session_0`, `driver_error` (the driver), and
`app_not_allowlisted`, `driver_exited`, `driver_stopped`, `approval_rejected`,
`approval_cancelled`, `approval_unavailable`, `approval_failed` (the host). The complete list, with
the request that produces each one, is in [docs/driver-protocol.md](docs/driver-protocol.md).

---

## 11. Repository layout

| Path | Contents |
|---|---|
| `src/` | The Cordis plugin: config schema, the six tools, the two control layers, rendering, the driver transport. |
| `src/driver/protocol.ts` | Wire types shared with the driver; imports no harness package so a browser bundle can reuse it. |
| `native/src/*.cs` | The driver: RPC loop, policy, window enumeration and capture, accessibility, input, clipboard, synthetic cursor. |
| `native/build.ps1` | The C# 5 build used by `npm run build`, by `plugin add`, and by `autoBuildDriver`. |
| `native/app.manifest` | `asInvoker`, `uiAccess="false"`, per-monitor-v2 DPI awareness, long-path aware. |
| `scripts/` | `build.mjs`, `load-check.mjs`, `smoke-driver.mjs`, `e2e-act.mjs`. |
| `cordis.patch.yml` | The loader patch: one entry, `id: computer-use`, `name: turtle-plugin-dsh-computer-use`. |
| `docs/` | Architecture, security, API reference, driver protocol. |

Deeper reading:

* [docs/architecture.md](docs/architecture.md) — how the host plugin, the driver and the two
  control layers fit together.
* [docs/security.md](docs/security.md) — the threat model, and the exact guarantees and limits.
* [docs/api.md](docs/api.md) — every parameter of every tool.
* [docs/driver-protocol.md](docs/driver-protocol.md) — the NDJSON JSON-RPC contract.
* [native/README.md](native/README.md) — the C# driver: structure, C# 5, and how to build it.

---

## 12. License

[Apache License 2.0](LICENSE).

Copyright the TurtlePlugin-DSH_ComputerUSE contributors. Licensed under the Apache License,
Version 2.0 (the "License"); you may not use this file except in compliance with the License.
You may obtain a copy of the License at

<http://www.apache.org/licenses/LICENSE-2.0>

Unless required by applicable law or agreed to in writing, software distributed under the License
is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied. See the License for the specific language governing permissions and limitations under the
License.

Contributors:

* `Owen_WWX <owen620293@outlook.com>`
* `turtlelnc <turtlelnc@outlook.com>`
* `Owen_WWX的Deepseek Harness <turtleqqmail@qq.com>`
* `turtlea001 <turtlea001@gmail.com>`
