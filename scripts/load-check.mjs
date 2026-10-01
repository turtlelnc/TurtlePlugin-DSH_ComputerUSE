#!/usr/bin/env node
/**
 * Load check: run the real plugin entry against a mock Cordis context.
 *
 * This catches the class of failures that only show up at profile start —
 * a missing export, a tool name that collides, a schema that validates but
 * produces no defaults, a tool whose `output.render` throws on its own payload.
 * It touches nothing on the desktop and needs no DeepSeek Harness process.
 *
 * Usage: node scripts/load-check.mjs [--verbose]
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verbose = process.argv.includes('--verbose')

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    if (verbose) process.stdout.write(`  ok   ${label}\n`)
    return true
  }
  failures += 1
  process.stdout.write(`  FAIL ${label}${detail.length > 0 ? ` — ${detail}` : ''}\n`)
  return false
}

function section(title) {
  process.stdout.write(`\n${title}\n`)
}

/**
 * Read the declared defaults straight off the schemastery schema.
 *
 * `Config.toJSON()` returns the cordis-shaped projection (`{uid, refs}`), not
 * JSON Schema, so walk the live schema tree instead: each field is a Schema
 * whose `meta.default` is exactly what a profile without an override gets.
 */
function defaultsFrom(schema) {
  const out = {}
  const dict = schema?.dict ?? schema?.meta?.dict ?? {}
  for (const [key, child] of Object.entries(dict)) {
    const value = child?.meta?.default
    if (value !== undefined) out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
}

section('1. package manifest')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('name is turtle-plugin-dsh-computer-use', pkg.name === 'turtle-plugin-dsh-computer-use', pkg.name)
check('version is 0.1.0-rc1', pkg.version === '0.1.0-rc1', pkg.version)
check('declares dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh))
check('exports ./package.json', pkg.exports?.['./package.json'] !== undefined)
check('engines allow the bundled Node 24', />=24/.test(String(pkg.engines?.node ?? '')) || /22\.19/.test(String(pkg.engines?.node ?? '')), String(pkg.engines?.node))
check(
  'peer dependencies accept both supported harness lines (0.1.7-rc.2 and 0.2.x)',
  pkg.peerDependencies?.['@deepseek-ai/dsh-tools']?.includes('0.1.7-rc.2') === true &&
    pkg.peerDependencies?.['@deepseek-ai/dsh-tools']?.includes('<0.3.0') === true &&
    pkg.peerDependencies?.['@deepseek-ai/cordis'] === '~4.0.4',
  JSON.stringify(pkg.peerDependencies),
)

section('1b. localized display metadata')
// The desktop app, the Plugins page and Settings' plugin inventory show a
// plugin's title and description in the current UI language, resolved as
// locale meta.title -> package.json name -> module name. Without locale/*.json
// the app falls back to the package name, so the product names never appear.
check('exports ./locale/*.json', pkg.exports?.['./locale/*.json'] !== undefined, JSON.stringify(pkg.exports))
check('ships locale/*.json in files', (pkg.files ?? []).includes('locale/*.json'), JSON.stringify(pkg.files))

const localeDir = join(root, 'locale')
const locales = {}
for (const lang of ['en', 'zh']) {
  const path = join(localeDir, `${lang}.json`)
  check(`locale/${lang}.json exists`, existsSync(path))
  if (!existsSync(path)) continue
  try {
    locales[lang] = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    check(`locale/${lang}.json parses`, true)
  } catch (error) {
    check(`locale/${lang}.json parses`, false, error.message)
  }
}
check('en title is the English product name', locales.en?.meta?.title === 'TurtlePlugin-DSH_ComputerUSE', String(locales.en?.meta?.title))
check('zh title is the Chinese product name', locales.zh?.meta?.title === 'DSH操纵电脑（TurtlePlugin）', String(locales.zh?.meta?.title))
check('both titles differ (the metadata is genuinely localized)', locales.en?.meta?.title !== locales.zh?.meta?.title)
check('en description is a non-empty string', typeof locales.en?.meta?.description === 'string' && locales.en.meta.description.length > 20)
check('zh description is a non-empty string', typeof locales.zh?.meta?.description === 'string' && locales.zh.meta.description.length > 10)
check('locale files declare only the meta object', Object.keys(locales.en ?? {}).every((key) => key === 'meta') && Object.keys(locales.zh ?? {}).every((key) => key === 'meta'), JSON.stringify([Object.keys(locales.en ?? {}), Object.keys(locales.zh ?? {})]))

// Resolve them the way the host does: by package specifier through the export map.
const require = createRequire(import.meta.url)
for (const lang of ['en', 'zh']) {
  try {
    const resolved = require.resolve(`${pkg.name}/locale/${lang}.json`)
    const parsed = JSON.parse(readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''))
    check(`the host can resolve ${pkg.name}/locale/${lang}.json`, parsed?.meta?.title === locales[lang]?.meta?.title, resolved)
  } catch (error) {
    check(`the host can resolve ${pkg.name}/locale/${lang}.json`, false, error.message)
  }
}

section('2. loader patch')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check('patch inserts exactly one entry', (patch.match(/^\s+- id:/gm) ?? []).length === 1, `${(patch.match(/^\s+- id:/gm) ?? []).length} entries`)
check('patch entry id is computer-use', /-\s+id:\s*computer-use\b/.test(patch))
check('patch entry name is the package name', patch.includes(`name: ${pkg.name}`))

section('3. plugin entry contract')
let mod
try {
  mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
} catch (error) {
  if (String(error?.code ?? '').includes('ERR_MODULE_NOT_FOUND') || /Cannot find (package|module)/.test(String(error?.message ?? ''))) {
    process.stdout.write(
      `  FAIL lib/index.js could not be imported: ${error.message}\n\n` +
        'The plugin imports @deepseek-ai/dsh-tools and @deepseek-ai/schemastery at runtime, so a\n' +
        'checkout needs its dependencies before this script can run:\n\n' +
        '  pnpm install\n' +
        '  npm run check\n\n' +
        'A DeepSeek Harness *installation* does not need this step: `dsh plugin add` forwards to pnpm\n' +
        'and resolves those peers from the profile, which is why the published lib/ is committed.\n',
    )
    process.exit(1)
  }
  throw error
}
check('exports apply()', typeof mod.apply === 'function')
check('exports name', typeof mod.name === 'string')
check('name matches the patch entry id', mod.name === 'computer-use', String(mod.name))
check('exports a Config schema', typeof mod.Config === 'function' || typeof mod.Config === 'object')
check('injects the tools service', Array.isArray(mod.inject) && mod.inject.includes('tools'), JSON.stringify(mod.inject))
check('exports the English product name', mod.PRODUCT_NAME_EN === 'TurtlePlugin-DSH_ComputerUSE', String(mod.PRODUCT_NAME_EN))
check('exports the Chinese product name', mod.PRODUCT_NAME_ZH === 'DSH操纵电脑（TurtlePlugin）', String(mod.PRODUCT_NAME_ZH))

section('4. defaults are usable without a profile override')
const defaults = defaultsFrom(mod.Config)
check('enabled defaults to true', defaults.enabled === true, JSON.stringify(defaults.enabled))
check('dispatch defaults to background', defaults.dispatch === 'background', JSON.stringify(defaults.dispatch))
check('allowedApps defaults to an empty list', Array.isArray(defaults.allowedApps) && defaults.allowedApps.length === 0)
check('deniedApps defaults to an empty list', Array.isArray(defaults.deniedApps) && defaults.deniedApps.length === 0)
check('maxTreeChars is a positive number', typeof defaults.maxTreeChars === 'number' && defaults.maxTreeChars > 0)
check('driverPath defaults to empty (auto-detect)', defaults.driverPath === '')

section('5. mounting against a mock context')
const registered = []
const logged = []
const disposers = []
const mockCtx = {
  logger: {
    debug: (m) => logged.push(['debug', String(m)]),
    info: (m) => logged.push(['info', String(m)]),
    warn: (m) => logged.push(['warn', String(m)]),
    error: (m) => logged.push(['error', String(m)]),
  },
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  },
  effect(factory) {
    const disposer = factory()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  get() {
    return undefined
  },
}
mod.apply(mockCtx, defaults)

check('registered six tools', registered.length === 6, `got ${registered.length}: ${registered.map((t) => t.name).join(', ')}`)
const names = registered.map((t) => t.name).sort()
const expected = [
  'computer_use_act',
  'computer_use_apps',
  'computer_use_launch',
  'computer_use_state',
  'computer_use_status',
  'computer_use_wait',
]
check('tool names are the documented six', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names))
check('every tool has a description over 80 characters', registered.every((t) => typeof t.description === 'string' && t.description.length > 80))
check('every tool compiles its parameters to JSON Schema', registered.every((t) => t.parameters?.type === 'object' && t.parameters.properties !== undefined))
check('every tool declares an output schema', registered.every((t) => t.output?.schema !== undefined))
check('every tool has an execute function', registered.every((t) => typeof t.execute === 'function'))
check('every tool has a render function', registered.every((t) => typeof t.output.render === 'function'))
check(
  'the mutating tool requires an action parameter',
  registered.find((t) => t.name === 'computer_use_act')?.parameters.required?.includes('action') === true,
  JSON.stringify(registered.find((t) => t.name === 'computer_use_act')?.parameters.required),
)
check(
  'computer_use_launch requires an app parameter',
  registered.find((t) => t.name === 'computer_use_launch')?.parameters.required?.includes('app') === true,
)

section('6. output.render is total')
for (const tool of registered) {
  const payloads = [
    { text: `${tool.name} ok` },
    { text: 'with image', images: [{ attachmentId: 'sha256:00', mediaType: 'image/png', width: 1, height: 1, bytes: 1 }] },
    {},
  ]
  for (const payload of payloads) {
    try {
      const blocks = tool.output.render({}, payload)
      const ok = Array.isArray(blocks) && blocks.length > 0 && blocks[0].type === 'text' && typeof blocks[0].text === 'string' && blocks[0].text.length > 0
      check(`render(${tool.name}, ${JSON.stringify(payload).slice(0, 40)}…)`, ok, JSON.stringify(blocks)?.slice(0, 120))
    } catch (error) {
      check(`render(${tool.name}) threw`, false, error.message)
    }
  }
}

section('7. sandbox policy')
const { normalizeAppId, checkSandbox, PRODUCT_NAME_EN } = mod
check('product name is stable', PRODUCT_NAME_EN === 'TurtlePlugin-DSH_ComputerUSE')
check('normalises a bare exe name', normalizeAppId('mspaint.exe') === 'mspaint', normalizeAppId('mspaint.exe'))
check('normalises a full path', normalizeAppId('C:\\Windows\\System32\\notepad.exe') === 'notepad', normalizeAppId('C:\\Windows\\System32\\notepad.exe'))
check('normalises a process: prefix', normalizeAppId('process:C:\\apps\\EXCEL.EXE') === 'excel', normalizeAppId('process:C:\\apps\\EXCEL.EXE'))
check('normalises a display name with case', normalizeAppId('MSpaint') === 'mspaint', normalizeAppId('MSpaint'))
check('refuses a shell outright', checkSandbox('powershell.exe', defaults, true).allowed === false)
check('refuses the UAC consent prompt outright', checkSandbox('consent.exe', defaults, true).allowed === false)
check('allows an ordinary app with an empty allow-list', checkSandbox('mspaint.exe', defaults, true).allowed === true)
check('an allow-list entry clears approval', checkSandbox('mspaint.exe', { ...defaults, allowedApps: ['mspaint.exe'] }, true).whitelisted === true)
check('an allow-list refuses anything else', checkSandbox('excel.exe', { ...defaults, allowedApps: ['mspaint.exe'] }, true).allowed === false)
check('the deny-list wins over an empty allow-list', checkSandbox('excel.exe', { ...defaults, deniedApps: ['excel.exe'] }, true).allowed === false)
check('observe-only refuses injection but allows reading', checkSandbox('mspaint.exe', { ...defaults, readOnly: true }, true).allowed === false && checkSandbox('mspaint.exe', { ...defaults, readOnly: true }, false).allowed === true)
check('refusals carry a model-readable reason', checkSandbox('cmd.exe', defaults, true).reason.length > 40)

section('8. lifecycle')
check('apply() registered a disposer', disposers.length >= 1, `${disposers.length}`)
try {
  for (const dispose of disposers.reverse()) dispose()
  check('disposers run without a live driver', true)
} catch (error) {
  check('disposers run without a live driver', false, error.message)
}
check('mount logged the product names', logged.some(([, m]) => m.includes('DSH操纵电脑') && m.includes('TurtlePlugin-DSH_ComputerUSE')), JSON.stringify(logged.slice(-1)))

section('9. driver executable')
const { statSync } = await import('node:fs')
const exe = join(root, 'lib', 'native', 'TurtleComputerUse.exe')
const hasExe = existsSync(exe)
check('lib/native/TurtleComputerUse.exe was built', hasExe, hasExe ? '' : 'run `npm run build:native`; the plugin can also compile it on first use')
if (hasExe) {
  const stampPath = join(root, 'lib', 'native', 'TurtleComputerUse.build.json')
  check('a build stamp records the artefact', existsSync(stampPath))
  if (existsSync(stampPath)) {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8').replace(/^\uFEFF/, ''))
    check('stamp names the driver', stamp.name === 'TurtleComputerUse', String(stamp.name))
    check('stamp size matches the file', stamp.sizeBytes === statSync(exe).size, `${stamp.sizeBytes} vs ${statSync(exe).size}`)
  }
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
