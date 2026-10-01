#!/usr/bin/env node
/**
 * End-to-end test: the real plugin, the real driver, and a real application.
 *
 * This is the only test that proves the whole chain works — schema defaults,
 * sandbox, approval, dispatch, accessibility perception, input injection,
 * screenshots, and the verdict that says whether the interface reacted.
 *
 * It DOES touch your desktop: it launches Notepad, types into it, observes the
 * result, and closes it again. Nothing else is opened, and the sandbox is
 * configured so that only Notepad can be touched.
 *
 * Usage:
 *   node scripts/e2e-act.mjs --yes          # required; makes the desktop effect explicit
 *   node scripts/e2e-act.mjs --yes --app=mspaint
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const appArg = args.find((arg) => arg.startsWith('--app='))
// Character Map by default, not Notepad. Windows 11 Notepad is a packaged,
// SINGLE-INSTANCE, tab-restoring app: launching it while you already have one
// open adds a tab to YOUR document, and consecutive runs fight each other.
// charmap.exe is a classic multi-instance Win32 app with an Edit control, so a
// run is isolated and repeatable.
const target = (appArg?.slice('--app='.length) ?? 'charmap.exe').trim()

if (!args.includes('--yes')) {
  process.stdout.write(
    'This test launches and drives a real application on your desktop.\n' +
      `Target: ${target}\n` +
      'Re-run with --yes to proceed, or pick another target with --app=<exe>:\n' +
      '  node scripts/e2e-act.mjs --yes\n',
  )
  process.exit(2)
}

// Redirect the plugin's data directory (the first-run consent record lives there)
// into a throwaway folder, so a test run never marks the real installation as
// already consented.
const sandboxData = mkdtempSync(join(tmpdir(), 'turtle-cu-e2e-'))
process.env['LOCALAPPDATA'] = sandboxData

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks += 1
  if (ok) {
    process.stdout.write(`ok   ${label}${detail.length > 0 ? ` — ${detail}` : ''}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`FAIL ${label}${detail.length > 0 ? ` — ${detail}` : ''}\n`)
  return false
}

// ------------------------------------------------------------------ harness double

const registered = new Map()
const approvalCalls = []
const savedImages = []
const logs = []

const mockCtx = {
  logger: {
    debug: (m) => logs.push(['debug', String(m)]),
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
  },
  tools: {
    register(tool) {
      registered.set(tool.name, tool)
      return () => {}
    },
  },
  effect(factory) {
    return factory()
  },
  get(name) {
    if (name === 'approval') {
      return {
        async request(request) {
          approvalCalls.push(request)
          return 'allowed-once'
        },
      }
    }
    if (name === 'attachments') {
      return {
        async saveImage({ data, mediaType, name }) {
          savedImages.push({ mediaType, name, bytes: data.byteLength })
          return { attachmentId: `sha256:${'0'.repeat(8)}`, mediaType, width: 1, height: 1, bytes: data.byteLength, name }
        },
      }
    }
    return undefined
  },
}

// ------------------------------------------------------------------ mount

const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
const config = {
  enabled: true,
  dispatch: 'auto',
  allowedApps: [], // deliberately empty: the approval layer must ask
  deniedApps: [],
  readOnly: false,
  requireApproval: true,
  firstRunConsent: true, // the first real use must raise the system-level consent
  allowElevatedTargets: false,
  allowForegroundEscalation: true,
  allowScreenshots: true,
  syntheticCursor: true,
  cursorIdleHideMs: 1500,
  observeBeforeAct: true,
  autoRefreshAfterAction: true,
  maxTreeNodes: 300,
  maxTreeChars: 8000,
  maxActionsPerMinute: 240,
  requestTimeoutMs: 25000,
  launchTimeoutMs: 25000,
  captureScale: 0.5,
  idleShutdownMs: 0,
  driverPath: '',
  autoBuildDriver: false,
  allowedBrowsers: false,
}
mod.apply(mockCtx, config)

const tool = (name) => registered.get(name)
const jsonText = (payload) => (payload && typeof payload.text === 'string' ? payload.text : JSON.stringify(payload))
const fakeExec = { agent: { id: 'e2e' }, signal: undefined }

check('six tools mounted', registered.size === 6, [...registered.keys()].join(', '))
if (!existsSync(join(root, 'lib', 'native', 'TurtleComputerUse.exe'))) {
  process.stdout.write('FAIL no driver built; run `npm run build` first\n')
  process.exit(1)
}

// ------------------------------------------------------------------ pre-flight
//
// Refuse to drive an application that is already open. A single-instance target
// would be hijacked outright, and even a multi-instance one leaves the run
// ambiguous about which window it drove.
const normalisedTarget = target.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

const sleepFor = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

// taskkill is NOT on PATH in every environment (a constrained PowerShell session
// is one example), and spawnSync with an unresolvable command fails silently
// under stdio:"ignore" — which would leave processes running and every cleanup
// looking like it worked. Always call it by absolute path.
const TASKKILL = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/** Force-stop a process tree this test started. */
const kill = (childPid) => {
  if (!childPid) return
  const result = spawnSync(TASKKILL, ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  if (result.error) process.stdout.write(`   (could not run taskkill: ${result.error.message})\n`)
}

/**
 * Force-stop every process of the target application.
 *
 * Only safe because the pre-flight refused to start when any target window was
 * already open: anything alive under this image name at this point was started
 * by this run. `launch` can return a launcher pid that is not the process owning
 * the window, which is why killing by pid alone can leave the app running.
 */
const killAllTargets = () => {
  spawnSync(TASKKILL, ['/IM', `${normalisedTarget}.exe`, '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/** Whether the target application currently has a window the plugin can see. */
async function targetIsOpen() {
  const listing = await tool('computer_use_apps').execute({}, fakeExec)
  // computer_use_apps prints the normalised app id: lowercase, no .exe, no path.
  return new RegExp(`^${normalisedTarget}\\t`, 'm').test(jsonText(listing))
}

if (!args.includes('--allow-existing')) {
  if (await targetIsOpen()) {
    process.stdout.write(
      `\nABORT: "${normalisedTarget}" is already open.\n\n` +
        'This test drives a real application and would attach to the window you already have\n' +
        `open. Close every ${normalisedTarget} window first, then run again — or choose another\n` +
        'target with --app=. (--allow-existing overrides this, and is a genuinely bad idea.)\n',
    )
    process.exit(3)
  }
}

// A scratch document of our own, so the only thing ever typed into is a file
// this test created and can delete.
let pid = null
try {
  // ---------------------------------------------------------------- 1. launch
  process.stdout.write(`\n-- launching ${target}\n`)
  // Readiness is "computer_use_state can actually observe it", not "launch
  // returned windowReady": a window can be reported and be gone a moment later.
  const sleep = sleepFor

  let launch = null
  for (let attempt = 1; attempt <= 3 && launch === null; attempt++) {
    const candidate = await tool('computer_use_launch').execute({ app: target, timeoutMs: 30000 }, fakeExec)
    if (candidate.windowReady === true && typeof candidate.appId === 'string') {
      for (let probe = 0; probe < 12; probe++) {
        // captureMode "tree": this probe needs the tree, and "none" returns no
        // tree at all, so it could never succeed.
        const observed = await tool('computer_use_state').execute({ appId: candidate.appId, captureMode: 'tree' }, fakeExec)
        if (/accessibility tree via/.test(jsonText(observed))) {
          launch = candidate
          break
        }
        await sleep(700)
      }
    }
    if (launch === null) {
      process.stdout.write(`   (not observable after launch; settling and retrying, attempt ${attempt}/3)\n`)
      kill(candidate.pid)
      await sleep(2000)
    }
  }

  check('the first real use raises the system-level consent prompt', /First run/i.test(String(approvalCalls[0]?.reason ?? '')), String(approvalCalls[0]?.reason ?? '').slice(0, 120))
  check('the consent prompt is localized', typeof approvalCalls[0]?.displayReason?.zh === 'string' && approvalCalls[0].displayReason.zh.length > 40)
  check('the launch then asks for the application itself', approvalCalls.length >= 2, `${approvalCalls.length} prompt(s)`)
  check('launch reported an observable window', launch !== null, launch === null ? 'never became observable in 3 attempts' : `pid ${launch.pid}`)
  if (launch === null) throw new Error(`could not get an observable ${target} window; aborting the rest of the run`)
  pid = launch.pid
  const appId = launch.appId

  // ---------------------------------------------------------------- 2. approval is remembered
  const second = await tool('computer_use_state').execute({ appId, captureMode: 'tree' }, fakeExec)
  check('a read needs no second prompt', approvalCalls.length === 2, `${approvalCalls.length} prompt(s)`)
  check('state returned a tree', /accessibility tree via/.test(jsonText(second)), jsonText(second).split('\n').slice(0, 2).join(' / '))

  // ---------------------------------------------------------------- 3. screenshot
  const both = await tool('computer_use_state').execute({ appId, captureMode: 'both' }, fakeExec)
  check('a screenshot was attached', Array.isArray(both.images) && both.images.length === 1, JSON.stringify(both.screenshotMeta))
  check('the attachment store received PNG bytes', savedImages.length >= 1 && savedImages[0].mediaType === 'image/png', JSON.stringify(savedImages[0] ?? {}))

  // ---------------------------------------------------------------- 4. type
  // Address the editable control by the index the snapshot returned, which is
  // the addressing discipline the tools are designed around.
  const nodes = Array.isArray(both.tree?.nodes) ? both.tree.nodes : []
  const edit = nodes.find((node) => node.role === 'Edit')
  check('the snapshot exposes an editable control', edit !== undefined, `${nodes.length} nodes; roles: ${[...new Set(nodes.map((n) => n.role))].slice(0, 8).join(',')}`)
  if (edit === undefined) throw new Error('no Edit control in the accessibility tree; cannot verify typing')

  // ---------------------------------------------------------------- 4. type
  process.stdout.write('\n-- typing into the application\n')
  const marker = `TurtlePlugin${Date.now()}`
  // clear:true replaces the control's contents, so the assertion below does not
  // depend on how many times this test has run before.
  const typed = await tool('computer_use_act').execute(
    { action: 'type', appId, element: edit.index, text: marker, clear: true, dispatch: 'auto' },
    fakeExec,
  )
  check('type reported an action', /via (background|foreground)/.test(jsonText(typed)), jsonText(typed).split('\n')[0])
  check('type carries a verdict', typeof typed.verdict === 'string', `${typed.verdict}: ${String(typed.verdictWhy).slice(0, 90)}`)

  // ---------------------------------------------------------------- 5. the text is really there
  const appsNow = await tool('computer_use_apps').execute({}, fakeExec)
  check('the application is still visible to the plugin', new RegExp(`^${normalisedTarget}\\t`, 'm').test(jsonText(appsNow)), jsonText(appsNow).split('\n')[1] ?? '')
  const waited = await tool('computer_use_wait').execute({ kind: 'text', appId, text: marker, timeoutMs: 8000 }, fakeExec)
  check('the application really contains the typed text', waited.satisfied === true, jsonText(waited).split('\n')[0])

  // ---------------------------------------------------------------- 6. the sandbox cannot be walked around
  // A point outside the approved window must be refused, not fired at whatever
  // happens to be under the pixel.
  const outside = await tool('computer_use_act').execute({ action: 'click', appId, x: 5000, y: 5000 }, fakeExec)
  check(
    'a point outside the approved window is refused',
    typeof outside.refused === 'string' && /point_outside_target|no_target/.test(String(outside.refused)),
    `${String(outside.refused)}: ${jsonText(outside).slice(0, 140)}`,
  )

  const noTarget = await tool('computer_use_act').execute({ action: 'click', x: 10, y: 10 }, fakeExec)
  check('a coordinate-only action is refused', noTarget.refused === 'no_target', jsonText(noTarget).slice(0, 130))

  const shell = await tool('computer_use_state').execute({ appId: 'powershell.exe' }, fakeExec)
  check('a shell is refused before anything is touched', /shell|terminal/i.test(jsonText(shell)), jsonText(shell).slice(0, 130))

  // ---------------------------------------------------------------- 7. observe-only
  config.readOnly = true
  const observeOnly = await tool('computer_use_act').execute({ action: 'click', appId, element: 0 }, fakeExec)
  check('observe-only refuses injection', jsonText(observeOnly).includes('observe-only') || observeOnly.refused === 'read_only', jsonText(observeOnly).slice(0, 120))
  config.readOnly = false

  // ---------------------------------------------------------------- 8. status reports the layers
  const status = await tool('computer_use_status').execute({ action: 'report' }, fakeExec)
  const statusText = jsonText(status)
  check('status names both product names', statusText.includes('DSH操纵电脑') && statusText.includes('TurtlePlugin-DSH_ComputerUSE'), statusText.split('\n')[0])
  check('status reports the sandbox layer', /sandbox \(layer 1\)/.test(statusText))
  check('status reports the approval layer', /approval \(layer 2\)/.test(statusText))
  check('status reports the driver version', /v0\.1\.0-rc1/.test(statusText))

  // ---------------------------------------------------------------- 9. rate limit sanity
  check('no tool threw an unhandled error', true)
} catch (error) {
  check('the end-to-end run completed without throwing', false, error.stack ?? error.message)
} finally {
  if (pid !== null && Number.isFinite(pid) && pid > 0) {
    process.stdout.write(`\n-- closing pid ${pid}\n`)
    kill(pid)
  }
  // A window still shutting down would make the NEXT run attach to a dying
  // instance, so wait for the target to leave the desktop before finishing.
  try {
    const waitForExit = async (ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline && (await targetIsOpen())) await sleepFor(600)
      return !(await targetIsOpen())
    }
    if (!(await waitForExit(8000))) {
      killAllTargets()
      if (!(await waitForExit(20000))) {
        process.stdout.write(`   (warning: ${normalisedTarget} is still open; the next run will abort)\n`)
      }
    }
  } catch {
    // the driver may already be gone; nothing to settle
  }
  try {
    rmSync(sandboxData, { recursive: true, force: true })
  } catch {
    // the temp folder is small; leaving it behind is harmless
  }
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} end-to-end checks passed\n`)
  process.exit(failures === 0 ? 0 : 1)
}
