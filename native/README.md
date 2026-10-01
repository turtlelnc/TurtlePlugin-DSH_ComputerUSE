# The native driver

`TurtleComputerUse.exe` is the part of `TurtlePlugin-DSH_ComputerUSE` that actually touches Windows:
window enumeration, DPI handling, screen capture, the UI Automation walk, input injection, the
clipboard and the synthetic cursor. The host plugin (`src/`) owns the tools, the approval prompts
and the sandbox policy; this process owns the desktop and refuses anything a request's policy did
not clear.

It is deliberately small, dependency-free and buildable on any Windows machine with no toolchain
install: C# 5, the in-box .NET Framework compiler, no NuGet, no SDK, no network.

* Wire protocol: [../docs/driver-protocol.md](../docs/driver-protocol.md)
* Where it sits in the whole system: [../docs/architecture.md](../docs/architecture.md)
* What it guarantees and what it does not: [../docs/security.md](../docs/security.md)

---

## 1. Layout

```text
native/
├── app.manifest        win32 manifest embedded into the executable
├── build.ps1           the build: locate csc.exe, resolve references, compile, stamp
└── src/
    ├── Program.cs      RPC loop, method dispatch, status/capabilities/policy.explain,
    │                   state/screenshot/wait/cursor handlers, error envelopes
    ├── Policy.cs       PolicyContext (per request), AlwaysDenied, ShellApps,
    │                   RequireApp, RequireBudget (rolling rate limit), Detail() helpers
    ├── Windows.cs      WindowInfo, enumeration, app grouping, DPI, PrintWindow/BitBlt
    │                   capture, ProcessGuard (elevation, session, lock state)
    ├── Uia.cs          AxNode/AxSnapshot, the UIA walk, MSAA fallback,
    │                   element resolution, focus and hit-test helpers
    ├── Actions.cs      action dispatch (background/foreground), targeting, activation,
    │                   clicks/typing/keys/scroll/drag/patterns, launch
    ├── Input.cs        SendInput backend, PostMessage backend, virtual-key table,
    │                   KnownPostMessageBlocker classification
    ├── Cursor.cs       the synthetic cursor overlay (own STA thread, layered window)
    ├── Clipboard.cs    CF_UNICODETEXT write with retry
    ├── Native.cs       P/Invoke declarations and structs (Win32, GDI, DWM)
    └── Json.cs         JavaScriptSerializer wrapper, typed getters, ProtocolException
```

Each file is self-contained by design: `Json.cs` and `Native.cs` have no project-specific
dependencies, and `Uia.cs`/`Input.cs` never decide *whether* something may happen — that is
`Policy.cs`'s job, and the split is what keeps the refusals auditable in one place.

### The shape of the program

1. `Main` sets UTF-8 output, parses `--verbose` / `--version`, enables per-monitor-v2 DPI awareness,
   reads `TURTLE_CU_IDLE_SHUTDOWN_MS`, and writes the `{"event":"ready",…}` handshake.
2. It then loops: read a line from stdin, parse it, read `id`/`method`/`params`/`policy`, and
   dispatch. `shutdown` replies and breaks; every other method runs and replies.
3. A `ProtocolException` becomes `{"id":…,"ok":false,"error":{"code","message","detail"}}`; anything
   else becomes `driver_error`. The loop never dies on a bad request.
4. On exit it stops the cursor overlay thread and flushes stdout.

---

## 2. Why C# 5

The driver is compiled by the C# compiler that ships with .NET Framework 4.x —
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` (or the 32-bit `Framework` path). That
compiler is **C# 5**. Roslyn (`csc.exe` with C# 6+) only ships with a developer image or Visual
Studio, and requiring one would break the promise that installing this plugin needs no SDK, no
NuGet restore and no network.

`build.ps1` therefore passes `/langversion:5` explicitly, so a modern compiler (if one is somehow
picked up) still fails on anything newer instead of quietly accepting code that will not build on a
clean machine.

Language features that are **not** available and must not appear in `src/*.cs`:

| Not allowed | Write instead |
|---|---|
| Expression-bodied members `int F() => 1;` | `int F() { return 1; }` |
| `out var` / inline declarations | declare the variable first, then `out variable` |
| String interpolation `$"a{b}"` | `"a" + b` or `string.Format` |
| Null-conditional / null-coalescing assignment `?.`, `??=` | explicit `if (x != null)` |
| `nameof`, `using static` | string literals |
| Auto-property initializers `public int X { get; set; } = 1;` | initialise in the constructor or a field |
| `static` using, tuples, pattern matching, `throw` expressions, local functions | plain C# 5 constructs |
| Collection initialisers on a *call* (`Obj(...)`) | `Json.Obj(...)` / `Json.NewObject()` helpers in `Json.cs` |

C# 5 *is* available and used: generics, LINQ, lambdas, closures, `async` (not needed here),
`readonly` fields, `Dictionary`/`List`, `using`, `try/finally`, and P/Invoke via `DllImport`.

Practical consequences already visible in the code: `Json.Obj(params object[] pairs)` exists because
a collection initialiser cannot be passed as an argument to a call; `Policy.CompareOrdinal` is a
named method because `List<object>.Sort` wants a `Comparison<object>` delegate; `Actions.Launch`
builds its `ProcessStartInfo` in two branches instead of using an object initialiser with a
conditional.

---

## 3. Building

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1
```

Output goes to `lib/native/TurtleComputerUse.exe` by default, which is exactly where the plugin
looks first (see §5). Useful switches:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1 -OutputDir C:\temp\cu -Force
powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1 -Quiet
```

| Switch | Meaning |
|---|---|
| `-OutputDir <dir>` | Where to write the executable; a relative path is resolved against the repository root. Default `lib\native`. |
| `-Force` | Rebuild even when the existing executable is newer than every source file. |
| `-Quiet` | Suppress the `[turtle-native] …` progress lines (used by the plugin's on-demand build). |

The npm-level wrappers:

```powershell
npm run build          # tsc into lib/ AND native/build.ps1 into lib/native/
npm run build:native   # the native step alone
```

`scripts/build.mjs` runs the native step only on Windows; on any other platform it prints
`not on Windows: skipping the native driver` and exits 0. If the native step fails, the build prints
a warning and still exits 0 — the plugin installs without the executable and compiles it on first
use instead.

### What the script does

1. **Locates the compiler.** `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, then the
   32-bit `Framework` path. If neither exists it stops with an error naming the alternative
   (`computerUse.driverPath` pointing at a prebuilt executable).
2. **Collects sources.** Every `*.cs` in `native/src`, sorted by name, plus `native/app.manifest`.
3. **Resolves references** in this order — `System.dll`, `System.Core.dll`, `System.Drawing.dll`,
   `System.Web.Extensions.dll`, `System.Xml.dll`, `WindowsBase.dll`, `Accessibility.dll`,
   `UIAutomationClient.dll`, `UIAutomationTypes.dll`. For each one the script tries the newest
   installed .NET Framework **reference assembly** pack first (highest version directory under
   `%ProgramFiles(x86)%\Reference Assemblies\Microsoft\Framework\.NETFramework`), then the
   framework directory next to `csc.exe`, then `%WINDIR%\Microsoft.NET\assembly\GAC_MSIL`. Reference
   assemblies are preferred because they carry the full WPF/UIA surface that the runtime directory
   only exposes through the GAC. A missing reference is reported as a warning, not a failure.
4. **Compiles** with:

   ```text
   /nologo /noconfig /target:exe /platform:anycpu /optimize+ /warn:4 /utf8output
   /langversion:5 /out:<OutputDir>\TurtleComputerUse.exe
   /win32manifest:native\app.manifest
   /r:<each resolved reference> <every native/src/*.cs>
   ```

   `/noconfig` matters: without it `csc.rsp` adds the framework directory's copies of
   `System.dll`/`System.Core.dll`, which then collide (CS1703) with the reference assemblies
   resolved in step 3.
5. **Writes a build stamp** next to the executable: `TurtleComputerUse.build.json` containing
   `name`, `version` (`0.1.0-rc1`), `builtAtUtc`, `sha256`, `sizeBytes`, `compiler` and the source
   file list. It is written without a BOM, because Node's `JSON.parse` rejects one. The verifier
   (`npm run check`) reads it back and compares `sizeBytes` against the actual file.
6. **Skips when up to date.** Unless `-Force` is given, an executable newer than every source file
   is left alone and the script exits 0.

---

## 4. The embedded manifest

`native/app.manifest` is passed as `/win32manifest:`, so its declarations apply to the executable
itself:

| Declaration | Why |
|---|---|
| `<requestedExecutionLevel level="asInvoker" uiAccess="false" />` | The driver must never silently acquire elevation. If elevated targets are needed, the user raises DeepSeek Harness themselves and Windows shows its own UAC prompt. `uiAccess="false"` means no UIAccess privileges: the driver cannot bypass the foreground lock, so a refused foreground swap surfaces as `activation_failed` instead of being forced. |
| `<dpiAwareness>PerMonitorV2</dpiAwareness>` and `<dpiAware>true/pm</dpiAware>` | Screenshot pixels are physical pixels, so a coordinate read from an image maps 1:1 onto the desktop. `Program.EnableDpiAwareness()` also tries `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` and then `SetProcessDpiAwareness(2)` at runtime, and logs when neither is available. |
| `<longPathAware>true</longPathAware>` | Long executable paths in window descriptions and launches. |
| `supportedOS` Windows 10/11 and 8.1 GUIDs | Correct version reporting for `Environment.OSVersion` in `status`. |

---

## 5. How the plugin finds and builds the driver

`src/driver/client.ts` resolves the executable in this order:

1. `computerUse.driverPath`, when it is set and the file exists;
2. the copy shipped inside the package — `lib/native/TurtleComputerUse.exe`;
3. a previously compiled copy — `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\bin\TurtleComputerUse.exe`;
4. when `computerUse.autoBuildDriver` is `true` (the default), compile `native/` on the spot:

   ```text
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <pkg>\native\build.ps1
                  -OutputDir %LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\bin -Quiet
   ```

   with a 180-second timeout. The result is cached at (3) for later starts.

If none of these produces a file, the first tool call fails with `driver_missing`, whose message
names all four remedies. Nothing is compiled unless the executable is actually needed: a profile
that never calls a Computer Use tool never spawns PowerShell.

The host spawns the driver with `TURTLE_CU_IDLE_SHUTDOWN_MS=0` and manages the process lifetime
itself (idle shutdown, per-request timeout, restart after a crash). See
[../docs/architecture.md](../docs/architecture.md#7-process-and-lifecycle-management).

---

## 6. Runtime contract and environment

| Variable / flag | Effect |
|---|---|
| `--version` | print `{"version":"0.1.0-rc1"}` and exit 0 |
| `--verbose`, `-v`, `TURTLE_CU_VERBOSE=1` | enable the driver log |
| `TURTLE_CU_LOG_DIR` | directory for `driver.log`; default `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse` |
| `TURTLE_CU_IDLE_SHUTDOWN_MS` | exit after that many idle milliseconds between requests; `0` (what the host sets) disables self-shutdown |

The log is off by default and holds no screenshots — it records lifecycle, refusals and, when
verbose, RPC-level diagnostics. It is rotated by deletion above roughly 2 MB.

Exit code is 0 on a clean loop end (EOF on stdin or a `shutdown` request). stdout carries protocol
frames only; anything written to stderr is diagnostic and is logged by the host at debug level.

---

## 7. Contributing to the driver

Before sending a change:

1. `npm run build:native` — the compile is the type check.
2. `npm run smoke` — drives this driver over the real protocol, read-only: handshake, `ping`,
   `status`, `capabilities`, `policy.explain`, `apps.list`, `windows.list`, one accessibility
   snapshot, and three structured refusals (`app_denied`, `app_not_approved`, `read_only`). It
   asserts that the desktop is unlocked and that the process is in the interactive session, so run
   it from a signed-in desktop.
3. `node scripts/e2e-act.mjs --yes` — the only test that proves the whole chain, including
   injection; it drives Character Map (a multi-instance classic Win32 app, so runs are isolated) and
   refuses to start while the target is already open.

Rules of thumb that the existing code follows:

* **One action per request.** Never add a batch entry point; the per-action rate limit, the approval
  audit and the host's verdict all assume one effect per call.
* **Policy before mechanism.** A new action must call `Policy.RequireApp(window, policy, mutating)`
  (or be reached through `act`) *before* it injects anything, and it must charge
  `Policy.RequireBudget` exactly once.
* **Refuse honestly.** When a target cannot be driven the way the caller asked, raise
  `ProtocolException` with the code that names the situation (`background_unavailable`,
  `point_outside_target`, …) and a message that tells the caller what to do next. Never fall back to
  a more invasive mechanism than the request authorised.
* **Physical pixels everywhere.** Coordinates crossing the wire are physical screen pixels; convert
  only with `Actions.ToClient` / `ScreenToClient`, never inside the injection helpers.
* **Keep it C# 5** (§2) and keep P/Invoke signatures grouped in `Native.cs` with the constant they
  belong to.
* **Do not log screen content.** `App.Log` is for lifecycle and refusals; screenshots and tree text
  stay out of the log.
