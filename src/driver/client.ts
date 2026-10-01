/**
 * Transport for the native driver.
 *
 * Owns exactly three hard problems: finding (or building) the executable,
 * talking to it over newline-delimited JSON without leaking a hung process, and
 * surviving a driver that dies mid-conversation.
 *
 * A driver that stops answering is killed and respawned on the next request
 * rather than being waited on: UI Automation calls into third-party providers
 * that are allowed to hang, and a harness that blocks forever on a broken
 * accessibility provider is worse than one that restarts.
 * @module turtle-plugin-dsh-computer-use/driver/client
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DATA_DIR_NAME, DRIVER_EXE, VERSION } from '../constants.js'
import {
  DriverError,
  type DriverFrame,
  type DriverPolicy,
  type DriverStatus,
} from './protocol.js'

/** Directory the plugin writes runtime state into. */
export function dataDir(): string {
  const local = process.env['LOCALAPPDATA'] ?? process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
  return join(local, DATA_DIR_NAME)
}

/** Where a driver compiled at runtime is cached. */
export function builtDriverPath(): string {
  return join(dataDir(), 'bin', DRIVER_EXE)
}

/** The driver shipped inside the installed package. */
export function shippedDriverPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // lib/driver/client.js -> lib/native/TurtleComputerUse.exe
  return resolve(here, '..', 'native', DRIVER_EXE)
}

/** The `native/` directory of the installed package, used to rebuild on demand. */
export function nativeSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', 'native')
}

interface Pending {
  resolve(frame: Extract<DriverFrame, { ok: true }>): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/** A live NDJSON conversation with one driver process. */
export class DriverClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private buffer = ''
  private nextId = 1
  private spawnFailure: Error | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private ready: { version: string; pid: number; elevated: boolean } | null = null

  constructor(
    private readonly options: {
      /** Explicit driver path from configuration, or empty for auto-detection. */
      driverPath: string
      /** Whether a missing executable may be compiled from native/ on the spot. */
      autoBuild: boolean
      /** Reclaim the process after this many idle milliseconds; 0 keeps it resident. */
      idleShutdownMs: number
      /** Sink for driver diagnostics and lifecycle notes. */
      log(level: 'debug' | 'info' | 'warn', message: string): void
    },
  ) {}

  /** Version handshake reported by the running driver, when it is up. */
  get handshake(): { version: string; pid: number; elevated: boolean } | null {
    return this.ready
  }

  /** Whether a driver process is currently alive. */
  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  /** How the last driver process ended, when it has. */
  get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.lastExit
  }

  /**
   * Resolve the executable, compiling it from `native/` when necessary.
   * @returns The absolute path to a driver that exists, or null when none can be produced.
   */
  locate(): string | null {
    if (this.options.driverPath.trim().length > 0) {
      const explicit = resolve(this.options.driverPath.trim())
      return existsSync(explicit) ? explicit : null
    }
    const shipped = shippedDriverPath()
    if (existsSync(shipped)) return shipped
    const built = builtDriverPath()
    if (existsSync(built)) return built
    if (!this.options.autoBuild) return null
    return this.compile()
  }

  /**
   * Compile the driver with the in-box .NET Framework compiler.
   * @returns The path to the freshly built executable, or null when the build failed.
   */
  compile(): string | null {
    const source = nativeSourceDir()
    const script = join(source, 'build.ps1')
    if (!existsSync(script)) {
      this.options.log('warn', `driver not found and no build script at ${script}`)
      return null
    }
    const output = join(builtDriverPath(), '..')
    try {
      mkdirSync(output, { recursive: true })
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputDir', output, '-Quiet'],
        { encoding: 'utf8', timeout: 180_000, windowsHide: true },
      )
      const built = builtDriverPath()
      if (existsSync(built)) {
        this.options.log('info', `compiled the native driver into ${built}`)
        return built
      }
      this.options.log('warn', `driver build produced nothing: ${result.stdout ?? ''}${result.stderr ?? ''}`)
      return null
    } catch (error) {
      this.options.log('warn', `driver build failed: ${(error as Error).message}`)
      return null
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.running) return this.child as ChildProcessWithoutNullStreams
    if (this.spawnFailure) {
      const failure = this.spawnFailure
      this.spawnFailure = null
      throw failure
    }

    const exe = this.locate()
    if (exe === null) {
      throw new DriverError(
        'driver_missing',
        'The Computer Use driver (TurtleComputerUse.exe) is not available. ' +
          'Reinstall the plugin, or set computerUse.driverPath to a built TurtleComputerUse.exe, ' +
          'or set computerUse.autoBuildDriver=true so the plugin can compile native/ with the in-box .NET Framework compiler.',
      )
    }

    const child = spawn(exe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, TURTLE_CU_IDLE_SHUTDOWN_MS: '0' },
    }) as ChildProcessWithoutNullStreams

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text.length > 0) this.options.log('debug', `driver stderr: ${text}`)
    })
    child.on('error', (error) => {
      this.options.log('warn', `driver process error: ${error.message}`)
      this.spawnFailure = new DriverError('driver_missing', `Could not start the Computer Use driver: ${error.message}`)
      this.failAll(this.spawnFailure)
    })
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal }
      this.child = null
      this.ready = null
      if (this.pending.size > 0) {
        this.failAll(
          new DriverError(
            'driver_exited',
            `The Computer Use driver exited (code ${String(code)}, signal ${String(signal)}) while requests were in flight. ` +
              'It will be started again on the next call; if this repeats, read the driver log named by computer_use_status.',
          ),
        )
      }
    })

    this.child = child
    this.options.log('debug', `driver started from ${exe} (plugin ${VERSION})`)
    return child
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue
      let frame: DriverFrame
      try {
        frame = JSON.parse(line) as DriverFrame
      } catch {
        this.options.log('debug', `driver emitted a non-JSON line: ${line.slice(0, 300)}`)
        continue
      }
      if ('event' in frame && frame.event === 'ready') {
        this.ready = { version: frame.version, pid: frame.pid, elevated: frame.elevated }
        this.options.log('debug', `driver ready: v${frame.version} pid ${frame.pid} elevated=${String(frame.elevated)}`)
        continue
      }
      if (!('id' in frame)) continue
      const entry = this.pending.get(frame.id)
      if (entry === undefined) continue
      this.pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame)
      else entry.reject(new DriverError(frame.error.code, frame.error.message, frame.error.detail ?? {}))
    }
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /**
   * Send one request and await its result.
   * @param method - driver method name.
   * @param params - method parameters.
   * @param policy - sandbox decisions to attach.
   * @param timeoutMs - how long to wait before the driver is considered hung.
   * @returns The driver's result object.
   * @throws {DriverError} on a structured refusal, a timeout, or a dead process.
   */
  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    policy?: DriverPolicy,
    timeoutMs = 20_000,
  ): Promise<T> {
    const child = this.ensureChild()
    this.clearIdleTimer()

    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (policy !== undefined) payload['policy'] = policy

    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A hung provider is not recoverable in place: this process has to go.
        this.kill('request timed out')
        rejectPromise(
          new DriverError(
            'driver_timeout',
            `The Computer Use driver did not answer "${method}" within ${timeoutMs} ms. ` +
              'It was stopped and will be restarted on the next call. This usually means an accessibility provider in the target application stopped responding.',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (frame) => resolvePromise(frame.result as T),
        reject: rejectPromise,
        timer,
      })
    })

    child.stdin.write(`${JSON.stringify(payload)}\n`)
    return promise
  }

  /** Stop the driver if it is running, and settle every in-flight request. */
  kill(reason: string): void {
    const child = this.child
    if (child !== null) {
      this.options.log('debug', `stopping the driver: ${reason}`)
      try {
        child.stdin.write(`${JSON.stringify({ id: this.nextId++, method: 'shutdown', params: {} })}\n`)
      } catch {
        // the pipe may already be gone; the kill below covers it
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill()
      }, 1500)
      timer.unref?.()
      child.once('exit', () => clearTimeout(timer))
    }
    this.failAll(new DriverError('driver_stopped', `The Computer Use driver was stopped: ${reason}`))
    this.child = null
    this.ready = null
    this.buffer = ''
  }

  /** Release the driver after an idle period instead of leaving it resident. */
  touchIdle(): void {
    this.clearIdleTimer()
    const idle = this.options.idleShutdownMs
    if (idle <= 0) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0 && this.running) this.kill(`idle for ${idle} ms`)
    }, idle)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** Ask the driver for its own status, used by the status tool. */
  async status(timeoutMs = 8000): Promise<DriverStatus> {
    const result = await this.call<Record<string, unknown>>(
      'status',
      {},
      { readOnly: true, approvedApps: [], deniedApps: [], allowElevatedTargets: false, allowForegroundEscalation: false, maxActionsPerMinute: 0 },
      timeoutMs,
    )
    this.touchIdle()
    return result as unknown as DriverStatus
  }

  /** Shut the driver down; called when the plugin unloads. */
  dispose(): void {
    this.clearIdleTimer()
    if (this.running) this.kill('plugin unloading')
  }
}
