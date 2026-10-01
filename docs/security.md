# Security model

`TurtlePlugin-DSH_ComputerUSE` gives a language model a mouse and a keyboard on a real Windows
desktop. That is a privileged capability, and this document states — precisely — what the sandbox
and approval layers guarantee, what they merely discourage, and what they do not protect against at
all.

Read this together with [architecture.md](architecture.md), which describes where each mechanism
actually runs, and [driver-protocol.md](driver-protocol.md), which lists the exact refusal codes.

---

## 1. Scope and threat model

### What is being protected

| Asset | Why it matters |
|---|---|
| The user's desktop session | An agent that can click anywhere can reach data and operations the user never intended to expose |
| Credentials and the elevation boundary | The UAC prompt, the credential UI and the secure desktop are the only things standing between a user-level process and full control of the machine |
| Unattended execution | A click injected into a terminal is arbitrary code execution with the agent as the author |
| The user's own input and attention | Foreground injection moves the physical pointer and steals focus |
| Screen content | Screenshots enter the model's context and, from there, a transcript |

### Adversaries considered in scope

1. **A mistaken or over-eager model.** It confuses a window, addresses a stale element, types into
   the wrong control, loops, or clicks a destructive button. This is the primary threat: computer
   use fails far more often from confident wrongness than from malice.
2. **A prompt-injected model.** Content the model reads (a window title, a document, a web page,
   the accessibility tree of a hostile application) tells it to do something the user did not ask
   for. The sandbox must make the worst available action survivable.
3. **A user who does not know what they are approving.** The UI must say what will happen before it
   happens, and refusals must be legible.

### Adversaries explicitly out of scope

4. **A compromised harness process.** See §6.
5. **A hostile process already running as the user.** It can forge input, read the clipboard and
   screenshot the screen without this plugin's help. The sandbox is not a defence against an
   already-compromised account.
6. **An attacker with administrator rights.** No user-mode control in this plugin, and no
   configuration of it, constrains an administrator.

The security posture is therefore: *constrain a confused or manipulated agent, and never silently
do something the user did not sanction* — not *contain a determined attacker*.

---

## 2. Trust boundaries

```text
   model output (untrusted)
        │
        ▼
   ┌───────────────────────────────────────────────────────────┐
   │ harness process (trusted for policy, same user)            │
   │   · layer 1 sandbox  · layer 2 approval  · consent record  │
   └──────────────────────┬────────────────────────────────────┘
                          │ anonymous pipe, same user, same integrity
                          ▼
   ┌───────────────────────────────────────────────────────────┐
   │ TurtleComputerUse.exe (same user; asInvoker, no UIAccess)  │
   │   · hard-coded refusals · per-request policy re-check ·    │
   │     rate budget · injection                               │
   └──────────────────────┬────────────────────────────────────┘
                          │ Win32: UIA, PostMessage, SendInput
                          ▼
   ┌───────────────────────────────────────────────────────────┐
   │ the desktop: other processes, their UIA providers, the     │
   │ input queue, the secure desktop                            │
   └───────────────────────────────────────────────────────────┘
```

Three consequences of this shape:

* **The driver is not a sandbox.** It runs as the same user, at the same integrity level, with the
  same access to the user's files. It is a policy enforcement point, not a containment boundary.
* **The pipe is not authenticated.** Any process running as the same user can spawn its own copy of
  `TurtleComputerUse.exe` and talk to it directly. What stops that from being a bypass is that the
  driver's *hard-coded* refusals are compiled in and cannot be configured away — but the
  configurable parts (allow-list, deny-list, `readOnly`, rate limit, elevation) are only as strong
  as the process that sends them.
* **The target application's UIA provider is untrusted input.** A hostile application can lie about
  its tree: report a different name, a different role, a different bounding rectangle. The model
  can therefore be *shown* something false. Nothing in this plugin validates a provider's claims;
  the mitigation is that a click still has to land inside the approved window (§3), and that the
  refusal lists are matched against the real executable, not against anything the application says.

---

## 3. Layer 1 — the sandbox: what is guaranteed

Each guarantee is enforced twice: once on the host (`src/policy.ts`, so a refusal can be explained
without spawning the driver) and once inside the driver (`native/src/Policy.cs`, in the process that
actually injects). The driver's copy is the one that constitutes the guarantee.

| Guarantee | Refusal code | Notes |
|---|---|---|
| Terminals and shells are never driven | `app_denied` | 26 hard-coded executable ids (cmd, powershell, pwsh, Windows Terminal, WSL, cscript, wscript, mshta, rundll32, reg, net, netsh, schtasks, sc, curl, ssh, putty, mintty, ConEmu, Alacritty, WezTerm, …). A non-empty `deniedApps` cannot un-deny them; an allow-list entry cannot whitelist them. |
| The UAC consent prompt is never driven | `app_denied` | `consent` |
| The credential UI is never driven | `app_denied` | `credentialuibroker` |
| The logon / lock surface is never driven | `app_denied` | `logonui`, `winlogon` |
| Registry Editor is never driven | `app_denied` | `regedit` — it can disable every other control on the machine |
| The UAC settings page and LSASS are never driven | `app_denied` | `useraccountcontrolsettings`, `lsass` |
| Configured applications are never driven | `app_denied` | `deniedApps`, normalised case/path/`.exe`, matched against the live window's executable |
| Nothing is injected in observe-only mode | `read_only` | `readOnly: true` — enumeration, trees and screenshots keep working |
| Only cleared applications are driven | `app_not_approved` | The driver refuses a mutating action for any application not present in the request's `approvedApps`. The host fills that list from the approval ledger; a host that sent an empty list would simply get refusals, not injections. This covers `act`; `apps.launch` is gated by the host instead (see the note below). |
| A coordinate cannot escape the approved window | `point_outside_target` | When the caller named a window, a point outside its bounds is refused before any injection. This closes the "approve A, click over B" hole. |
| An action must name an application | `no_target` | A coordinate-only action is refused by the host and again by the driver |
| Elevation is not crossed silently | `target_elevated` | With `allowElevatedTargets: false`, an elevated target is refused before injection |
| There is no interactive desktop | `session_0` | A process outside the console session is refused rather than made to look broken |
| The desktop is not locked | `desktop_locked` | Locked ⇒ foreground activation, the clipboard and `SendInput` all fail; the driver reports the single root cause instead of a pile of unrelated errors. The check runs before every window-scoped read or write, so `state`/`screenshot`/`act`/`wait` are all refused while locked; a `screenshot` with `mode: "screen"` needs no window and is the one capture that still works. |
| Runaway input is bounded | `rate_limited` | Rolling one-minute budget (`maxActionsPerMinute`, default 240) spent one unit per action *and* per launch |

Supporting facts:

* **The always-denied lists are compiled in, not read from configuration.** They are
  `static readonly` dictionaries in `Policy.cs`. `policy.explain` reports them so a user can see
  what is refused, but editing anything in Settings cannot change them.
* **Normalisation happens before comparison.** `NormalizeAppId` strips a `process:` prefix, any
  directory path and the `.exe` suffix, then lowercases; comparisons run against the live window's
  real executable path from `QueryFullProcessImageNameW`, not against a window title.
* **The rate limit is a runaway guard, not a security boundary.** It bounds how fast an agent can
  act; it does not bound what it can act on.
* **The elevation boundary is Windows', not ours.** `allowElevatedTargets` only decides whether the
  driver *tries*. UIPI decides whether the input arrives; the driver's manifest is `asInvoker` with
  `uiAccess="false"`, so it cannot force its way across.

### What layer 1 deliberately does not do

* It does not judge *intent*. Clicking "Delete" in a legitimate, approved application is allowed.
* It does not sandbox the target application. An approved application can do anything the
  application can do — including things the user did not intend.
* It does not restrict which *windows* of an approved application are touched, only which process.
  `point_outside_target` is bound to the window the caller named, not to a policy about windows.
* It does not prevent an approved application from being a launchpad: approving a browser with
  `allowedBrowsers: true`, or approving a file manager or an IDE with a terminal pane inside it,
  gives the agent reach the shell refusal list was meant to deny. **The refusal list matches
  executables, not capabilities.**
* **`apps.launch` is gated by the host, not by the driver.** The driver enforces `readOnly` and the
  rate budget for a launch, but it does not re-check the launched executable against the shell and
  always-denied lists — those checks, and the approval prompt, happen in the host tool before the
  call. Through the plugin a shell can therefore never be launched; through the raw wire protocol
  the driver would start one.

---

## 4. Layer 2 — approval: what is guaranteed

The approval layer asks DeepSeek Harness's approval service
(`ctx.get('approval').request({ agent, toolName, reason, displayReason })`). The vocabulary is
closed and one-shot: `allowed-once` | `rejected` | `cancelled` | `unavailable`. There is no
`allow-always`, no remembered rule and no grant store in the service.

| Situation | Outcome |
|---|---|
| `allowed-once` | The application is recorded in the session ledger and the action proceeds |
| `rejected` | Refused (`approval_rejected`); nothing is injected |
| `cancelled` | Refused (`approval_cancelled`); nothing is injected |
| `unavailable` | Refused (`approval_unavailable`); nothing is injected |
| Session approval policy is `never` | Every ask resolves `unavailable` → refused, with no prompt shown |
| No approval service composed in the profile | Refused (`approval_unavailable`), with a message naming the package to mount |
| The call carries no agent | Refused (`approval_unavailable`) |
| The question throws | Refused (`approval_failed`) |
| Any unknown outcome value | Refused (`approval_unavailable`) |

**Fail-closed is the whole design.** There is no code path in which a missing answerer, a broken
channel or an unrecognised outcome is treated as consent. The ledger only ever records a grant that
came from a literal `allowed-once`, or from an allow-list match (which is a static, user-authored
configuration entry, not an inference).

**Approvals are per application and per session.** The ledger lives in memory in the plugin
process; it dies with the process, and `computer_use_status` with `action: "reset"` clears it
explicitly. What survives a restart is the user's own `allowedApps` configuration — which is why
the allow-list is the honest way to express "always allow", and the ledger is not.

**The system-level consent is a record, not a gate.** `consent.json` records that the user accepted
the one-time explanation, and `computer_use_status` reports whether it exists. It is *not* consulted
before each action; layer 1 and layer 2 are the gates. Treat the consent prompt as the informed
disclosure step, not as a per-action authorization.

**Audit.** Each ask produces the harness's own durable log-only event pair
(`approval/asked { id, toolName, callId?, reason }` then `approval/decided { id, outcome }`), and
the `reason` and `displayReason` carry the application, the action and the dispatch mode.

---

## 5. What the user is told, and when

* **The consent prompt** names the plugin, says it is a one-time system-level consent, lists what
  becomes possible (read trees, take screenshots, click/type/scroll/drag/launch) *in the configured
  dispatch mode*, states explicitly whether the mouse and keyboard are taken over (`foreground`) or
  stay the user's (`background`), states that terminals, shells, the UAC prompt, the credential UI
  and the lock screen are refused and cannot be enabled, and shows the current allow-list and the
  driver version.
* **The per-application prompt** names the application, the window title, the first action and the
  dispatch mode, and says that allowing clears the application for the rest of the session.
* **Refusals are explained to the model, not hidden from it.** Every refusal returns a stable code
  plus text that says what to do next; several of them explicitly tell the model *not* to work
  around the refusal ("This refusal is structural — do not try to work around it; report it and ask
  the user").
* **`computer_use_status` is the transparency surface**: driver path and version, elevation, desktop
  name, lock state, session, both control layers with their live values, the refused-id count, the
  applications cleared this session, and a warning for each dangerous combination
  (`allowElevatedTargets` on without elevation, locked desktop, non-interactive session).

---

## 6. What this does NOT protect against

Stated without hedging, because a security document that overstates its coverage is worse than none.

1. **A compromised harness process.** Layer 1 and layer 2 run inside the Node process. An attacker
   who can execute code there can call `TurtleComputerUse.exe` directly with a hand-written
   `policy` block: `readOnly: false`, `approvedApps: ["anything"]`, `maxActionsPerMinute: 0`. What
   remains is only what is compiled into the driver: the shell/terminal list and the
   UAC/credential/logon/regedit list for `act`/`state`/`screenshot`/`wait`, and the requirement that
   a point lie inside the named window. Even those two lists are not absolute — `apps.launch` is
   gated by the host, so a compromised harness can start a process the driver would refuse to drive.
   Any other plugin in the same profile runs in the same process with the same reach. **The sandbox
   is a guardrail against a confused agent, not a boundary against malicious code in the harness.**
2. **A user who approves a dangerous application.** The allow-list and the approval prompt express
   user intent; they do not evaluate it. Approving a browser (with `allowedBrowsers: true`),
   approving an application that embeds a terminal, a file manager, a mail client or an IDE, or
   approving an administrative console, hands the agent capabilities the refusal lists were written
   to deny — because those lists match executable leaf names, not what an application can do.
   Approving an application for the rest of the session means every subsequent action in it is
   unprompted.
3. **UIAccess-style input forgery.** The driver injects through `SendInput`, which produces events
   that are indistinguishable from real user input for the target application. Two consequences:
   (a) the target cannot tell an agent from a human, so any "user presence" or "user gesture"
   assumption made by an application is defeated by design; and (b) the plugin installs no
   `uiAccess` manifest, has no service, and does not try to defeat the foreground lock — so when
   Windows refuses a foreground swap, the action fails (`activation_failed`) instead of succeeding
   by trickery. Conversely, the plugin does **not** detect, attribute or prevent *other* processes
   forging input: that is the operating system's problem, not this plugin's.
4. **Screen content leaking through screenshots the user authorised.** With `allowScreenshots: true`
   (the default), whatever is visible inside a captured window enters the model's context and the
   session transcript — including notifications, other windows overlapping the region in the
   `covered: true` fallback, and content the user forgot was on screen. A window title, a filename
   or a rendered tree can leak secrets the same way. Turning `allowScreenshots` off removes the
   pixel path but not the text path.
5. **The clipboard.** `paste_text` **replaces** the clipboard contents, destroying whatever the user
   had copied, and the pasted text is then visible to every process that reads the clipboard. The
   plugin does not restore the previous contents.
6. **A confused or stale element index.** Indexes are valid only for the newest snapshot; the driver
   refuses unknown indexes (`stale_element`) rather than guessing. It cannot refuse an index that is
   still in the snapshot but now denotes something else, because the application changed its own UI.
7. **Nothing about the target's intent.** A click that lands on the right control is still a click:
   the plugin cannot know that the button deletes a file, sends a mail or spends money.
8. **Confidentiality of the driver's own diagnostics.** With `TURTLE_CU_VERBOSE=1` the driver logs
   window titles, application ids and refusals to
   `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\driver.log`, which is a plain file readable by the
   user's account. Verbose logging is off by default; the host does not enable it.
9. **Network, file system and process isolation.** Approving an application grants access to that
   application, and through it to whatever it can reach. This plugin is not a virtual machine and
   does not pretend to be one.

---

## 7. Residual risk and hardening

What to do if you want the risk to be smaller than the defaults:

| Goal | Action |
|---|---|
| Observe without touching | `readOnly: true`. Trees, window lists and screenshots keep working; every click, keystroke and launch is refused (`read_only`). |
| Never escalate to foreground | `dispatch: "background"`, `allowForegroundEscalation: false`. The answer becomes `background_unavailable` and a human decides. |
| Keep the physical mouse and keyboard | Leave `dispatch: "background"`. Nothing in background mode touches the system input queue. |
| Bound the blast radius per session | Keep `allowedApps` narrow (only the applications you are working in) and list everything sensitive in `deniedApps`. |
| Bound the pace | Lower `maxActionsPerMinute` (e.g. 30) and let the rate limit interrupt a looping agent. |
| No pixels in the transcript | `allowScreenshots: false`. The tree becomes the only perception channel; text can still leak content. |
| No prompts, ever | `requireApproval: false` — read this as "trust the model for every non-refused application", because that is what it means. |
| No silent launches | Leave `deniedApps` populated; launches go through both layers, so an approval prompt precedes a launch of an unlisted application. |
| Do not cross the elevation boundary | Leave `allowElevatedTargets: false` and do not run the harness elevated. If you must drive an elevated window, understand that the harness then holds administrator rights for everything it does. |
| Revoke mid-session | `computer_use_status` with `action: "reset"` clears every per-session approval. |
| Contain genuinely untrusted work | Use a virtual machine or a separate user account. No configuration of this plugin substitutes for that. |

---

## 8. How the guarantees are checked

* `npm run smoke` (read-only, no desktop effect) asserts that the driver refuses a deny-listed
  application (`app_denied`), refuses an unapproved application (`app_not_approved`), and refuses
  injection in observe-only mode (`read_only`) — three of the layer-1 guarantees, exercised against
  the real driver, using the window it just inspected.
* `npm run check` asserts the host-side policy table: shells and the UAC prompt are refused, an
  ordinary application with an empty allow-list is allowed, an allow-list entry clears approval, a
  non-empty allow-list refuses everything else, the deny-list wins, observe-only refuses injection
  but allows reading, and every refusal carries a model-readable reason.
* `node scripts/e2e-act.mjs --yes` asserts, on a real desktop, that a point outside the approved
  window is refused (`point_outside_target`), that a coordinate-only action is refused
  (`no_target`), that a shell is refused before anything is touched, and that observe-only mode
  refuses injection — and that the approval prompt fired exactly once and was remembered.

None of these tests can prove the absence of a bypass; they pin the behaviours that the design
depends on so that a regression is visible.
