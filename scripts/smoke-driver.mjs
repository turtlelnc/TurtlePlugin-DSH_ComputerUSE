#!/usr/bin/env node
/**
 * Driver smoke test — read-only, no clicks, no typing, no launches.
 *
 * Exercises the real native driver over its real wire protocol: handshake,
 * status, capabilities, the refusal lists, application and window enumeration,
 * one accessibility snapshot, and one window screenshot that is written to the
 * temp directory so you can look at it.
 *
 * Usage:
 *   node scripts/smoke-driver.mjs                 # auto-detect the driver
 *   node scripts/smoke-driver.mjs <path-to-exe>
 *   node scripts/smoke-driver.mjs --capture       # also capture the foreground window
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const wantCapture = args.includes('--capture')
const explicit = args.find((arg) => !arg.startsWith('--'))

const candidates = [
  explicit,
  join(root, 'lib', 'native', 'TurtleComputerUse.exe'),
  join(process.env['LOCALAPPDATA'] ?? '', 'TurtlePlugin-DSH_ComputerUSE', 'bin', 'TurtleComputerUse.exe'),
].filter((value) => typeof value === 'string' && value.length > 0)

const exe = candidates.find((candidate) => existsSync(candidate))
if (exe === undefined) {
  process.stderr.write(
    'No TurtleComputerUse.exe found. Build it first:\n' +
      '  powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1\n',
  )
  process.exit(2)
}

process.stdout.write(`driver: ${exe}\n\n`)

const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')

let buffer = ''
const frames = []
const waiters = new Map()

child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line.length === 0) continue
    const frame = JSON.parse(line)
    frames.push(frame)
    const waiter = waiters.get(frame.id)
    if (waiter !== undefined) {
      waiters.delete(frame.id)
      waiter(frame)
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(`[driver stderr] ${chunk}`))

let nextId = 1
function call(method, params = {}, policy) {
  const id = nextId++
  const payload = { id, method, params }
  if (policy !== undefined) payload.policy = policy
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${method} timed out`)), 30_000)
    waiters.set(id, (frame) => {
      clearTimeout(timer)
      if (frame.ok) resolvePromise(frame.result)
      else rejectPromise(Object.assign(new Error(`${frame.error.code}: ${frame.error.message}`), { code: frame.error.code }))
    })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  })
}

const readonly = { readOnly: true, approvedApps: [], deniedApps: [], allowElevatedTargets: false, allowForegroundEscalation: false, maxActionsPerMinute: 0 }

let failures = 0
function report(label, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail.length > 0 ? ` — ${detail}` : ''}\n`)
}

try {
  await new Promise((r) => setTimeout(r, 400))

  const ready = frames.find((frame) => frame.event === 'ready')
  report('handshake emits a ready frame', ready !== undefined, ready === undefined ? '' : `v${ready.version} pid ${ready.pid} elevated=${ready.elevated}`)

  const pong = await call('ping')
  report('ping answers', pong.pong === true)

  const status = await call('status')
  report('status reports a version', typeof status.version === 'string', status.version)
  report('status reports the desktop name', typeof status.desktopName === 'string', status.desktopName)
  report('status reports the virtual screen', typeof status.virtualScreen?.width === 'number', JSON.stringify(status.virtualScreen))
  report('the desktop is not locked', status.desktopLocked === false, `desktopLocked=${status.desktopLocked}`)
  report('the process is in the interactive session', status.interactiveSession === true)

  const caps = await call('capabilities')
  report('capabilities lists both dispatch modes', Array.isArray(caps.dispatchModes) && caps.dispatchModes.includes('background') && caps.dispatchModes.includes('foreground'))
  report('capabilities lists the synthetic cursor', caps.syntheticCursor === true)

  const policy = await call('policy.explain')
  report('the driver refuses terminals', Array.isArray(policy.shellApps) && policy.shellApps.includes('powershell'))
  report('the driver refuses the UAC prompt', Array.isArray(policy.alwaysDeniedApps) && policy.alwaysDeniedApps.includes('consent'))

  const apps = await call('apps.list', {}, readonly)
  report('apps.list returns an array', Array.isArray(apps.apps), `${apps.count} applications`)
  const foreground = apps.apps.find((app) => app.foreground) ?? apps.apps[0]
  if (foreground !== undefined) {
    process.stdout.write(`     foreground/第一个: ${foreground.appId} "${foreground.title}" ${foreground.elevated ? '(elevated)' : ''}\n`)
  }

  const windows = await call('windows.list', {}, readonly)
  report('windows.list returns an array', Array.isArray(windows.windows), `${windows.count} windows`)

  if (foreground !== undefined) {
    const state = await call('state', { appId: foreground.appId, includeTree: true, captureMode: wantCapture ? 'window' : 'none', maxNodes: 200 }, readonly)
    report('state returns a window', typeof state.window?.appId === 'string', state.window?.appId)
    report('state returns an accessibility tree', typeof state.tree?.nodeCount === 'number' && state.tree.nodeCount > 0, `${state.tree?.nodeCount} nodes via ${state.tree?.backend}`)
    if (wantCapture && state.screenshot !== undefined) {
      const outDir = join(process.env['TEMP'] ?? root, 'turtle-computer-use-smoke')
      mkdirSync(outDir, { recursive: true })
      const file = join(outDir, `${foreground.appId}-${Date.now()}.png`)
      writeFileSync(file, Buffer.from(state.screenshot.base64, 'base64'))
      report('a screenshot was captured and written', existsSync(file), `${file} (${state.screenshot.width}x${state.screenshot.height} via ${state.screenshot.backend})`)
    }
    if (!wantCapture) process.stdout.write('     (pass --capture to also take a screenshot)\n')
  }

  // Refusals must be structured, not crashes, and they must be decided before
  // anything is injected. These three exercise the driver's policy layer
  // against the window we just inspected — no new window is opened.
  if (foreground !== undefined) {
    try {
      await call('act', { action: 'click', appId: foreground.appId, x: 5, y: 5 }, { ...readonly, readOnly: false, deniedApps: [foreground.appId] })
      report('the driver enforces the sandbox deny-list', false, 'the call unexpectedly succeeded')
    } catch (error) {
      report('the driver enforces the sandbox deny-list', error.code === 'app_denied', `${error.code}: ${error.message.slice(0, 110)}`)
    }

    try {
      await call('act', { action: 'click', appId: foreground.appId, x: 5, y: 5 }, { ...readonly, readOnly: false, approvedApps: [] })
      report('the driver refuses an unapproved application', false, 'the call unexpectedly succeeded')
    } catch (error) {
      report('the driver refuses an unapproved application', error.code === 'app_not_approved', `${error.code}: ${error.message.slice(0, 110)}`)
    }

    try {
      await call('act', { action: 'click', appId: foreground.appId, x: 5, y: 5 }, { ...readonly, readOnly: true, approvedApps: [foreground.appId] })
      report('the driver refuses injection in observe-only mode', false, 'the call unexpectedly succeeded')
    } catch (error) {
      report('the driver refuses injection in observe-only mode', error.code === 'read_only', `${error.code}: ${error.message.slice(0, 110)}`)
    }
  }

  await call('shutdown')
  process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: driver smoke test finished with ${failures} failure(s)\n`)
} catch (error) {
  process.stderr.write(`\nsmoke test error: ${error.message}\n`)
  failures += 1
} finally {
  setTimeout(() => {
    child.kill()
    process.exit(failures === 0 ? 0 : 1)
  }, 300)
}
