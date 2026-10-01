#!/usr/bin/env node
/**
 * Build TurtlePlugin-DSH_ComputerUSE.
 *
 * Two independent artefacts:
 *   1. lib/**.js + lib/**.d.ts   — the Cordis plugin, compiled from src/ by tsc.
 *   2. lib/native/TurtleComputerUse.exe — the native driver, compiled from
 *      native/ by the in-box .NET Framework compiler.
 *
 * The native step is skipped with a warning when no C# compiler is present: the
 * plugin still installs, and compiles the driver on first use instead.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function run(label, command, args, options = {}) {
  process.stdout.write(`\n[build] ${label}\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options })
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${String(result.status)}`)
}

// ------------------------------------------------------------------ 1. TypeScript
if (!existsSync(tsc)) {
  throw new Error('typescript is not installed. Run `pnpm install` (with .npmrc kept intact) before building.')
}
mkdirSync(join(root, 'lib'), { recursive: true })
run('compiling the plugin with tsc', process.execPath, [tsc, '-p', 'tsconfig.json'])

// ------------------------------------------------------------------ 2. native driver
const isWindows = process.platform === 'win32'
if (!isWindows) {
  process.stdout.write('\n[build] not on Windows: skipping the native driver (the plugin targets win32).\n')
  process.exit(0)
}

const buildScript = join(root, 'native', 'build.ps1')
if (!existsSync(buildScript)) {
  throw new Error(`native/build.ps1 is missing; cannot build the driver`)
}

const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', buildScript, '-OutputDir', join(root, 'lib', 'native')],
  { cwd: root, stdio: 'inherit' },
)
if (ps.error) throw new Error(`the native driver build could not start: ${ps.error.message}`)
if (ps.status !== 0) {
  process.stdout.write(
    '\n[build] WARNING: the native driver did not build. The plugin will still install and will try to compile\n' +
      '        native/ again on first use (computerUse.autoBuildDriver), or you can point computerUse.driverPath\n' +
      '        at a TurtleComputerUse.exe you built elsewhere.\n',
  )
  process.exit(0)
}

const exe = join(root, 'lib', 'native', 'TurtleComputerUse.exe')
if (!existsSync(exe)) throw new Error(`the native build reported success but ${exe} is missing`)
process.stdout.write(`\n[build] ok: lib/index.js and lib/native/TurtleComputerUse.exe\n`)
