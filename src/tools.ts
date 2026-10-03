/**
 * The six model-facing tools.
 *
 * The shape follows the discipline that computer-use systems converge on:
 * look, then do exactly one thing, then look again. `state` is the only way to
 * obtain element indexes; `act` performs one action and can hand back a fresh
 * state plus a verdict saying whether the interface actually reacted.
 * @module turtle-plugin-dsh-computer-use/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import {
  ALWAYS_DENIED_APPS,
  DISPATCH_MODES,
  PRODUCT_NAME_EN,
  PRODUCT_NAME_ZH,
  SHELL_APPS,
  VERSION,
} from './constants.js'
import { bool, dispatchOf, list, num, str, type ComputerUseConfig } from './config.js'
import type { DriverClient } from './driver/client.js'
import { DriverError, type ActionResult, type AppSummary, type AxTree, type LaunchResult, type Screenshot, type WaitResult, type WindowState } from './driver/protocol.js'
import {
  appApprovalPrompt,
  ApprovalLedger,
  askApproval,
  checkSandbox,
  consentPrompt,
  driverPolicy,
  effectiveDispatch,
  normalizeAppId,
  readConsent,
  writeConsent,
} from './policy.js'
import { describeWindow, fingerprint, fromScreenshotSpace, publishScreenshot, renderTree, verdictOf } from './render.js'

/** The value every tool returns; `output.render` turns it into content blocks. */
interface ToolPayload {
  text: string
  images?: unknown[]
  [key: string]: unknown
}

/** Force a payload through JSON so a declared `json` output schema is truthful. */
function json(payload: ToolPayload): never {
  return JSON.parse(JSON.stringify(payload)) as never
}

/** Everything the tools need, assembled once by the plugin entry. */
export interface Runtime {
  ctx: Context
  config: ComputerUseConfig
  driver: DriverClient
  ledger: ApprovalLedger
  log(level: 'debug' | 'info' | 'warn', message: string): void
}

/** Content blocks for a payload: its text, then any stored images. */
function blocksOf(payload: unknown): ContentBlock[] {
  const value = (payload ?? {}) as ToolPayload
  const blocks: ContentBlock[] = [{ type: 'text', text: typeof value.text === 'string' ? value.text : JSON.stringify(value) }]
  if (Array.isArray(value.images)) {
    for (const ref of value.images) blocks.push({ type: 'image', attachment: ref as never })
  }
  return blocks
}

/** Shared output declaration: canonical JSON plus a text-first rendering. */
const OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown): ContentBlock[] => blocksOf(value),
}

/** A provider-neutral pending card. */
function callCard(title: string, kind: 'read' | 'execute' | 'other', rawInput?: unknown) {
  return { card: 'generic' as const, title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

/** Read-only policy for requests that never inject anything. */
function readPolicy(config: ComputerUseConfig): ReturnType<typeof driverPolicy> {
  return { ...driverPolicy(config, []), readOnly: true, allowForegroundEscalation: false, maxActionsPerMinute: 0 }
}

/** Timeout for a driver request, from configuration. */
function timeoutOf(config: ComputerUseConfig): number {
  return Math.max(2000, Math.trunc(num(config, 'requestTimeoutMs', 20_000)))
}

/** The attachment service, resolved lazily because it is optional. */
function attachmentsOf(ctx: Context): { saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>; imageHostPath?(ref: unknown): string | undefined } | undefined {
  return ctx.get('attachments') as never
}

/** The approval service, resolved lazily because it is optional. */
function approvalOf(ctx: Context): { request(request: { agent: unknown; toolName: string; reason?: string; displayReason?: { en: string; [locale: string]: string } }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> } | undefined {
  return ctx.get('approval') as never
}

// --------------------------------------------------------------------------- gates

/** Refuse everything when the master switch is off. */
function requireEnabled(config: ComputerUseConfig): string | null {
  if (!bool(config, 'enabled', true)) {
    return `${PRODUCT_NAME_ZH} is switched off (computerUse.enabled = false), so no Computer Use tool will run. Turn it back on in Settings.`
  }
  return null
}

/**
 * Run both control layers for one application.
 *
 * Layer 1 (sandbox) is pure and synchronous. Layer 2 (approval) only runs when
 * the sandbox allowed the application and did not already whitelist it, and it
 * runs at most once per application per session.
 */
async function requireControl(
  runtime: Runtime,
  exec: { agent?: unknown; signal?: AbortSignal },
  toolName: string,
  appId: string,
  title: string,
  action: string,
): Promise<{ ok: true; dispatch: string } | { ok: false; code: string; text: string }> {
  const { config, ctx, ledger } = runtime

  const sandbox = checkSandbox(appId, config, true)
  if (!sandbox.allowed) {
    return {
      ok: false,
      code: sandbox.code,
      text:
        `Refused by the Computer Use sandbox (layer 1): ${sandbox.reason}\n` +
        'Nothing was clicked, typed or launched. This refusal is structural — do not try to work around it; report it and ask the user.',
    }
  }

  const id = normalizeAppId(appId)
  if (sandbox.whitelisted) ledger.grant(id, 'allow-list')

  if (!bool(config, 'requireApproval', true) || ledger.get(id) !== undefined) {
    return { ok: true, dispatch: effectiveDispatch(config) }
  }

  const mode = effectiveDispatch(config)
  const display = effectiveDispatch(config)
  const prompt = appApprovalPrompt(id, title, action, display)
  const outcome = await askApproval(approvalOf(ctx), exec, toolName, prompt.reason, { en: prompt.en, zh: prompt.zh })
  if (!outcome.granted) {
    return {
      ok: false,
      code: outcome.code,
      text: `Refused by the Computer Use approval layer (layer 2): ${outcome.message}\nNothing was clicked, typed or launched.`,
    }
  }
  ledger.grant(id, 'approved')
  return { ok: true, dispatch: mode }
}

/**
 * The one-time system-level consent, raised before the first thing that actually
 * touches the desktop.
 *
 * This is deliberately the gate on every entry point that perceives a window or
 * injects input, so a user never discovers mid-task that an agent has been
 * driving their desktop. Application *listing* stays ungated so the model can
 * always discover what is open without prompting.
 */
async function gateFirstUse(
  runtime: Runtime,
  exec: { agent?: unknown; signal?: AbortSignal },
  toolName: string,
): Promise<{ ok: true } | { ok: false; code: string; text: string }> {
  return requireSystemConsent(runtime, exec, toolName)
}

/**
 * Run the one-time system-level consent the first time Computer Use is used.
 *
 * This is deliberately the first thing that happens, before any window is even
 * enumerated, so a user never discovers mid-task that an agent has been driving
 * their desktop.
 */
async function requireSystemConsent(
  runtime: Runtime,
  exec: { agent?: unknown; signal?: AbortSignal },
  toolName: string,
): Promise<{ ok: true } | { ok: false; code: string; text: string }> {
  const { config, ctx } = runtime
  if (!bool(config, 'firstRunConsent', true)) return { ok: true }
  if (readConsent() !== null) return { ok: true }

  const prompt = consentPrompt(config, runtime.driver)
  const outcome = await askApproval(approvalOf(ctx), exec, toolName, prompt.reason, { en: prompt.en, zh: prompt.zh })
  if (!outcome.granted) {
    return {
      ok: false,
      code: outcome.code,
      text:
        `${PRODUCT_NAME_EN} has not been granted system-level permission yet, so it did not touch your desktop.\n` +
        `${outcome.message}\n` +
        'The consent prompt appears once and records nothing about your screen; it only records that you said yes. ' +
        'Run computer_use_status with action="consent" to see it again.',
    }
  }
  const record = writeConsent(effectiveDispatch(config))
  runtime.log('info', `system-level Computer Use consent granted at ${record.grantedAt}`)
  return { ok: true }
}

// --------------------------------------------------------------------------- tools

function statusTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'computer_use_status',
    description:
      `Self-check for ${PRODUCT_NAME_ZH} / ${PRODUCT_NAME_EN} (${VERSION}). Reports the native driver, the desktop session, ` +
      'the two control layers (sandbox allow/deny lists and the approval gate), the effective dispatch mode, and which ' +
      'applications are currently approved. Use action="reset" to clear the session approval tickets, and action="consent" ' +
      'to re-open the one-time system-level permission prompt. Read-only: it never injects input.',
    parameters: {
      action: {
        type: 'string',
        enum: ['report', 'reset', 'consent'],
        description: 'report (default) describes the current state; reset clears the per-session application approvals; consent re-runs the first-run prompt.',
      },
    },
    output: OUTPUT,
    presentCall: (args) => callCard(`Computer Use status (${args.action ?? 'report'})`, 'read'),
    async execute(args, exec) {
      const { config, driver, ledger } = runtime
      const action = typeof args.action === 'string' ? args.action : 'report'

      if (action === 'reset') {
        ledger.reset()
        runtime.log('info', 'Computer Use session approvals cleared on request')
        return json({
          text:
            'Cleared every per-session Computer Use approval ticket. Each application will be asked about again on its next action.\n' +
            'The sandbox allow-list and the one-time system consent are unchanged; edit those in Settings.',
          cleared: true,
        })
      }

      if (action === 'consent') {
        const gate = await requireSystemConsent(runtime, exec, 'computer_use_status')
        return json({
          text: gate.ok
            ? 'System-level Computer Use consent is recorded. Nothing else changed.'
            : gate.text,
          consentGranted: gate.ok,
        })
      }

      const disabled = requireEnabled(config)
      const lines: string[] = [`${PRODUCT_NAME_ZH} / ${PRODUCT_NAME_EN} v${VERSION}`]
      const detail: Record<string, unknown> = { version: VERSION }
      const consent = readConsent()
      detail['consent'] = consent
      lines.push(`system consent: ${consent === null ? 'NOT granted yet (the first mutating action will ask)' : `granted ${consent.grantedAt}`}`)

      if (disabled !== null) {
        lines.push(`plugin: DISABLED — ${disabled}`)
        detail['enabled'] = false
        return json({ text: lines.join('\n'), ...detail })
      }
      detail['enabled'] = true

      const sandbox = {
        allowedApps: list(config, 'allowedApps'),
        allowAllApps: bool(config, 'allowAllApps'),
        deniedApps: list(config, 'deniedApps'),
        readOnly: bool(config, 'readOnly'),
        allowElevatedTargets: bool(config, 'allowElevatedTargets'),
        allowForegroundEscalation: bool(config, 'allowForegroundEscalation'),
        maxActionsPerMinute: num(config, 'maxActionsPerMinute', 240),
        requireApproval: bool(config, 'requireApproval', true),
        allowedBrowsers: bool(config, 'allowedBrowsers') || bool(config, 'allowAllApps'),
        alwaysDeniedByDriver: [...SHELL_APPS, ...Object.keys(ALWAYS_DENIED_APPS)].sort(),
      }
      detail['sandbox'] = sandbox
      lines.push('sandbox (layer 1):')
      lines.push(`  dispatch mode: ${effectiveDispatch(config)}`)
      lines.push(`  allow-all: ${sandbox.allowAllApps ? 'ON — every application except the hard refusals is allowed and pre-approved' : 'off'}`)
      lines.push(`  allow-list: ${sandbox.allowedApps.length > 0 ? sandbox.allowedApps.join(', ') : '(empty — every non-denied app needs approval)'}`)
      lines.push(`  deny-list: ${sandbox.deniedApps.length > 0 ? sandbox.deniedApps.join(', ') : '(empty)'}`)
      lines.push(`  observe-only: ${String(sandbox.readOnly)} · elevated targets: ${String(sandbox.allowElevatedTargets)} · browsers: ${String(sandbox.allowedBrowsers)} · rate limit: ${String(sandbox.maxActionsPerMinute)}/min`)
      lines.push(`  refused outright: terminals/shells, UAC prompt, credential UI, lock screen (${SHELL_APPS.length + Object.keys(ALWAYS_DENIED_APPS).length} app ids) — no setting lifts these`)

      const approved = ledger.entries()
      detail['approvedApps'] = approved
      lines.push(`approval (layer 2): requireApproval=${String(sandbox.requireApproval)}; cleared this session: ${approved.length > 0 ? approved.map((entry) => `${entry.appId}(${entry.kind})`).join(', ') : '(none yet)'}`)

      if (!sandbox.allowedBrowsers) {
        lines.push('  note: browser windows are not whitelisted by default; their content is a web page, so a coordinate click cannot be checked against the tree.')
      }

      try {
        const status = await driver.status()
        detail['driver'] = status
        lines.push('native driver:')
        lines.push(`  ${driver.locate() ?? '(path unknown)'}`)
        lines.push(`  v${status.version} pid ${status.pid} · elevated=${String(status.elevated)} · uptime ${Math.round(status.uptimeMs / 1000)}s`)
        lines.push(`  desktop: "${status.desktopName}" locked=${String(status.desktopLocked)} interactiveSession=${String(status.interactiveSession)} session=${String(status.sessionId)}`)
        lines.push(`  os: ${status.os} · system DPI ${status.dpi} · virtual screen ${status.virtualScreen.width}x${status.virtualScreen.height}`)
        lines.push(`  driver log: ${status.logPath}`)
        if (status.desktopLocked) {
          lines.push('  WARNING: the desktop is locked. Foreground activation, the clipboard and input injection all fail while it is locked, while screenshots keep working — that combination looks like a dozen unrelated bugs, so unlock first.')
        }
        if (!status.interactiveSession) {
          lines.push('  WARNING: this process is not attached to the interactive desktop session, so it can see no real windows. Start DeepSeek Harness from the signed-in desktop.')
        }
        if (!status.elevated && sandbox.allowElevatedTargets) {
          lines.push('  WARNING: allowElevatedTargets is on but the harness is not elevated, so Windows UIPI will drop input aimed at elevated windows.')
        }
      } catch (error) {
        const failure = error as Error
        detail['driverError'] = failure.message
        lines.push('native driver: UNAVAILABLE')
        lines.push(`  ${failure.message}`)
      }

      return json({ text: lines.join('\n'), ...detail })
    },
  })
}

function appsTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'computer_use_apps',
    description:
      'List the applications and windows that Computer Use can currently see, with their normalised application id, executable, ' +
      'window title, size, elevation and whether the sandbox would allow driving them. Read-only and never requires approval. ' +
      'Start here to find the appId the other tools take.',
    parameters: {
      includeWindows: { type: 'boolean', description: 'Include every top-level window, not just one row per application.' },
      onlyDrivable: { type: 'boolean', description: 'Hide applications the sandbox would refuse anyway (terminals, shells, credential UI).' },
    },
    output: OUTPUT,
    presentCall: () => callCard('Computer Use: list applications', 'read'),
    async execute(args) {
      const { config, driver } = runtime
      const disabled = requireEnabled(config)
      if (disabled !== null) return json({ text: disabled, apps: [] })

      const includeWindows = args.includeWindows === true
      const onlyDrivable = args.onlyDrivable === true

      if (includeWindows) {
        const result = await driver.call<{ windows: Array<Record<string, unknown>>; count: number }>(
          'windows.list',
          {},
          readPolicy(config),
          timeoutOf(config),
        )
        driver.touchIdle()
        const rows: Array<Record<string, unknown>> = result.windows.map((window) => {
          const appId = normalizeAppId(String(window['appId'] ?? ''))
          const refusal = checkSandbox(appId, config, false)
          return { ...window, appId, sandboxAllowed: refusal.allowed }
        })
        const kept = onlyDrivable ? rows.filter((row) => row.sandboxAllowed) : rows
        const text = kept
          .map((row) => {
            const bounds = row['bounds'] as { width: number; height: number; x: number; y: number }
            return `${row['appId']} hwnd=${String(row['hwnd'])} pid=${String(row['pid'])} "${String(row['title'])}" ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}${row['minimized'] === true ? ' minimized' : ''}${row['elevated'] === true ? ' ELEVATED' : ''}`
          })
          .join('\n')
        return json({
          text: `Computer Use sees ${kept.length} top-level window(s)${onlyDrivable ? ' that the sandbox allows' : ''}:\n${text}`,
          windows: kept,
        })
      }

      const result = await driver.call<{ apps: AppSummary[]; count: number }>('apps.list', {}, readPolicy(config), timeoutOf(config))
      driver.touchIdle()

      const annotated = result.apps.map((app) => {
        const verdict = checkSandbox(app.appId, config, true)
        const browser = isBrowserApp(app.appId)
        return {
          ...app,
          sandboxAllowed: verdict.allowed,
          sandboxWhitelisted: verdict.whitelisted,
          sandboxReason: verdict.allowed ? '' : verdict.reason,
          needsApproval: verdict.allowed && !verdict.whitelisted && runtime.ledger.get(app.appId) === undefined,
          browser,
        }
      })
      const kept = onlyDrivable ? annotated.filter((app) => app.sandboxAllowed) : annotated
      const text = kept
        .map((app) => {
          const tags = [
            app.foreground ? 'FOREGROUND' : '',
            app.elevated ? 'ELEVATED' : '',
            app.sandboxWhitelisted ? 'whitelisted' : app.sandboxAllowed ? (app.needsApproval ? 'needs approval' : 'approved') : 'REFUSED',
            app.windowCount > 1 ? `${app.windowCount} windows` : '',
            app.browser ? 'browser' : '',
          ].filter((tag) => tag.length > 0)
          return `${app.appId}\t"${app.title}"\t${app.exe}\t[${tags.join(', ')}]`
        })
        .join('\n')
      return json({
        text:
          `Computer Use sees ${kept.length} application(s)${onlyDrivable ? ' the sandbox allows' : ''}.\n` +
          'appId\twindow\texe\t[flags]\n' +
          `${text}\n\n` +
          'Pass appId to computer_use_state / computer_use_act / computer_use_launch. Applications marked needs approval will raise one prompt on their first action.',
        apps: kept,
      })
    },
  })
}

function isBrowserApp(appId: string): boolean {
  return ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'iexplore', 'arc'].includes(normalizeAppId(appId))
}

function stateTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'computer_use_state',
    description:
      'Observe one window: its accessibility tree (indexed, so computer_use_act can address elements), a screenshot, or both. ' +
      'Element indexes are only valid for the snapshot this call returns — re-observe after every action. ' +
      'Coordinates in the screenshot are image pixels; computer_use_act accepts the same image coordinates when you pass ' +
      `screenshotX/screenshotY. Read-only: it does not require approval, but the sandbox still governs which windows it will describe.`,
    parameters: {
      appId: { type: 'string', description: 'Application id from computer_use_apps, e.g. "mspaint" or "excel.exe".' },
      hwnd: { type: 'string', description: 'Window handle, when you want one specific window of an application.' },
      captureMode: {
        type: 'string',
        enum: ['tree', 'screenshot', 'both', 'none'],
        description: 'What to capture. "tree" (default) is cheapest; "both" is what you want for canvases and charts.',
      },
      onlyActionable: { type: 'boolean', description: 'Keep only elements that can actually be acted on. Useful in dense windows.' },
      maxNodes: { type: 'integer', description: 'Cap on accessibility-tree nodes.' },
      scale: { type: 'number', description: 'Screenshot scale, 0.1–1. Use 0.5 on a 4K display to halve the image cost.' },
    },
    output: OUTPUT,
    presentCall: (args) => callCard(`Computer Use: observe ${args.appId ?? args.hwnd ?? 'window'}`, 'read', { appId: args.appId, captureMode: args.captureMode }),
    async execute(args, exec) {
      const { config, driver } = runtime
      const disabled = requireEnabled(config)
      if (disabled !== null) return json({ text: disabled })

      const consent = await gateFirstUse(runtime, exec, 'computer_use_state')
      if (!consent.ok) return json({ text: consent.text, refused: consent.code })

      const appId = typeof args.appId === 'string' ? args.appId : undefined
      const hwnd = typeof args.hwnd === 'string' ? args.hwnd : undefined
      if (appId === undefined && hwnd === undefined) {
        return json({ text: 'computer_use_state needs appId or hwnd. Run computer_use_apps first to see what is available.' })
      }
      if (appId !== undefined) {
        const verdict = checkSandbox(appId, config, false)
        if (!verdict.allowed) {
          return json({ text: `Refused by the Computer Use sandbox (layer 1): ${verdict.reason}` })
        }
        // allowAllApps means every application, browsers included; the separate
        // allowedBrowsers switch exists for operators who want browsers without
        // wanting everything else.
        if (isBrowserApp(appId) && !bool(config, 'allowedBrowsers') && !bool(config, 'allowAllApps')) {
          return json({
            text:
              `"${normalizeAppId(appId)}" is a browser, and browser windows are not enabled by default. Its content is a web page, ` +
              'so the accessibility tree and a coordinate click describe different things and a click cannot be verified against the tree. ' +
              'Set computerUse.allowedBrowsers=true (or computerUse.allowAllApps=true) in Settings if you accept that, ' +
              'or use a purpose-built web tool instead.',
          })
        }
      }

      const captureMode = typeof args.captureMode === 'string' ? args.captureMode : 'tree'
      const wantsTree = captureMode === 'tree' || captureMode === 'both'
      const wantsShot = (captureMode === 'screenshot' || captureMode === 'both') && bool(config, 'allowScreenshots', true)

      const params: Record<string, unknown> = {}
      if (appId !== undefined) params['appId'] = appId
      if (hwnd !== undefined) params['hwnd'] = hwnd
      params['includeTree'] = wantsTree
      params['captureMode'] = wantsShot ? 'window' : 'none'
      params['onlyActionable'] = args.onlyActionable === true
      params['maxNodes'] = Math.max(20, Math.min(4000, Math.trunc(typeof args.maxNodes === 'number' ? args.maxNodes : num(config, 'maxTreeNodes', 400))))
      const scale = typeof args.scale === 'number' ? args.scale : num(config, 'captureScale', 1)
      params['scale'] = Math.max(0.1, Math.min(1, scale))

      let state: WindowState
      try {
        state = await driver.call<WindowState>('state', params, readPolicy(config), timeoutOf(config))
      } catch (error) {
        return json({ text: driverFailureText(error) })
      }
      driver.touchIdle()
      markObserved(state.window.appId, state.window.hwnd)

      const tree: AxTree = state.tree ?? { backend: 'none', nodeCount: 0, truncated: false, nodes: [], skipped: true }
      const rendered = renderTree(tree, Math.max(500, Math.trunc(num(config, 'maxTreeChars', 12_000))))
      const lines: string[] = [describeWindow(state.window, state.foreground)]
      if (state.desktopLocked) lines.push('WARNING: the desktop is locked; input injection will fail until it is unlocked.')
      lines.push(rendered.text)

      const payload: ToolPayload = { text: lines.join('\n'), tree: tree as unknown as Record<string, unknown> }
      const images: unknown[] = []
      if (state.screenshot !== undefined) {
        const shot = state.screenshot
        rememberScreenshot(windowKey(state.window.appId, state.window.hwnd), shot)
        const published = await publishScreenshot(attachmentsOf(runtime.ctx), shot, `${shot.appId ?? 'window'}-${Date.now()}`)
        lines.push('')
        lines.push(published.stored ? 'A screenshot of the window is attached to this result.' : `Screenshot: ${published.note}`)
        payload['text'] = lines.join('\n')
        payload['screenshotMeta'] = screenshotMeta(shot)
        if (published.stored) images.push(...published.blocks.filter((block) => block.type === 'image').map((block) => (block as { attachment: unknown }).attachment))
        void exec
      }
      if (images.length > 0) payload['images'] = images
      return json(payload)
    },
  })
}

function screenshotMeta(shot: Screenshot): Record<string, unknown> {
  return {
    width: shot.width,
    height: shot.height,
    scale: shot.scale,
    backend: shot.backend,
    covered: shot.covered,
    originX: shot.originX,
    originY: shot.originY,
    note: shot.note ?? '',
  }
}

function actTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'computer_use_act',
    description:
      'Perform exactly ONE action on a window, then (by default) return the new state and a verdict saying whether the interface ' +
      'actually reacted. Address elements by the index from the most recent computer_use_state, or by coordinates in the ' +
      'screenshot you were shown. Requires approval the first time an application is controlled, unless it is on the sandbox ' +
      'allow-list. Background dispatch never moves your physical mouse; foreground dispatch takes over the desktop for the action.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'click', 'double_click', 'right_click', 'middle_click', 'hover', 'drag', 'scroll', 'type', 'key',
          'set_value', 'invoke', 'toggle', 'expand', 'collapse', 'select', 'focus', 'activate', 'paste_text',
        ],
        description: 'The single action to perform.',
      },
      appId: { type: 'string', description: 'Target application id. Defaults to the application of the element you address.' },
      hwnd: { type: 'string', description: 'Target window handle.' },
      element: { type: 'integer', description: 'Element index from the most recent computer_use_state of this window.' },
      screenshotX: { type: 'number', description: 'X in the screenshot image you were shown (converted to physical pixels for you).' },
      screenshotY: { type: 'number', description: 'Y in the screenshot image you were shown.' },
      x: { type: 'number', description: 'Physical screen X. Prefer element or screenshotX/screenshotY.' },
      y: { type: 'number', description: 'Physical screen Y.' },
      text: { type: 'string', description: 'Text for type / paste_text.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Keys for key, e.g. ["ctrl","s"] or ["enter"].' },
      value: { type: 'string', description: 'Replacement text for set_value.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click/drag.' },
      count: { type: 'integer', description: 'Click count (2 = double click).' },
      clear: { type: 'boolean', description: 'For type: select all and replace instead of inserting at the caret.' },
      submit: { type: 'boolean', description: 'For type: press Enter afterwards.' },
      clicks: { type: 'integer', description: 'Wheel clicks for scroll; negative scrolls up.' },
      axis: { type: 'string', enum: ['vertical', 'horizontal'], description: 'Scroll axis.' },
      toScreenshotX: { type: 'number', description: 'Drag drop point, X in screenshot pixels.' },
      toScreenshotY: { type: 'number', description: 'Drag drop point, Y in screenshot pixels.' },
      toX: { type: 'number', description: 'Drag drop point, physical screen X.' },
      toY: { type: 'number', description: 'Drag drop point, physical screen Y.' },
      durationMs: { type: 'integer', description: 'Drag duration in milliseconds.' },
      dispatch: {
        type: 'string',
        enum: ['background', 'foreground', 'auto'],
        description: 'Override the configured dispatch mode for this one action. Use "foreground" only after the driver reported background_unavailable.',
      },
      refresh: { type: 'boolean', description: 'Return the post-action state (default: computerUse.autoRefreshAfterAction).' },
    },
    output: OUTPUT,
    presentCall: (args) => callCard(`Computer Use: ${args.action}${args.appId !== undefined ? ` on ${args.appId}` : ''}`, 'execute', {
      action: args.action,
      element: args.element,
      x: args.x,
      y: args.y,
    }),
    async execute(args, exec) {
      const { config, driver } = runtime
      const disabled = requireEnabled(config)
      if (disabled !== null) return json({ text: disabled })

      const consent = await gateFirstUse(runtime, exec, 'computer_use_act')
      if (!consent.ok) return json({ text: consent.text, refused: consent.code })

      const action = String(args.action)
      const appId = typeof args.appId === 'string' ? args.appId : undefined
      const hwnd = typeof args.hwnd === 'string' ? args.hwnd : undefined

      // A mutating action must name what it acts on. Without a target there is
      // nothing for the sandbox to approve, and a bare coordinate would land in
      // whatever window happens to be under the pixel.
      if (appId === undefined && hwnd === undefined && typeof args.element !== 'number') {
        return json({
          text:
            'computer_use_act needs a target: pass appId (from computer_use_apps), hwnd, or element (an index from the most ' +
            'recent computer_use_state). A coordinate alone cannot be approved, because the sandbox has to know which ' +
            'application you are about to touch. Nothing was injected.',
          refused: 'no_target',
        })
      }

      // Layer 1 needs an application id. When the caller only gave coordinates
      // or an element index, resolve the window first so the sandbox can judge it.
      let resolvedApp = appId
      let resolvedTitle = ''
      let resolvedHwnd = hwnd
      if (resolvedApp === undefined) {
        try {
          const probe = await driver.call<{ apps: AppSummary[] }>('apps.list', {}, readPolicy(config), timeoutOf(config))
          if (hwnd !== undefined) {
            const match = probe.apps.find((app) => app.hwnd === hwnd)
            if (match !== undefined) {
              resolvedApp = match.appId
              resolvedTitle = match.title
            }
          } else {
            const foreground = probe.apps.find((app) => app.foreground)
            if (foreground !== undefined) {
              resolvedApp = foreground.appId
              resolvedTitle = foreground.title
            }
          }
        } catch {
          // fall through: the driver will refuse with its own explanation
        }
      }
      if (resolvedApp !== undefined && resolvedTitle.length === 0) {
        try {
          const probe = await driver.call<{ apps: AppSummary[] }>('apps.list', {}, readPolicy(config), timeoutOf(config))
          const match = probe.apps.find((app) => app.appId === normalizeAppId(resolvedApp as string))
          if (match !== undefined) {
            resolvedTitle = match.title
            if (resolvedHwnd === undefined) resolvedHwnd = match.hwnd
          }
        } catch {
          // a missing title only makes the prompt less informative
        }
      }

      if (resolvedApp !== undefined) {
        const gate = await requireControl(runtime, exec, 'computer_use_act', resolvedApp, resolvedTitle, action)
        if (!gate.ok) return json({ text: gate.text, refused: gate.code })
      }

      const params: Record<string, unknown> = { action }
      const dispatch = typeof args.dispatch === 'string' && args.dispatch.length > 0 ? args.dispatch : dispatchOf(config)
      params['dispatch'] = dispatch
      if (resolvedApp !== undefined) params['appId'] = resolvedApp
      if (resolvedHwnd !== undefined) params['hwnd'] = resolvedHwnd
      if (typeof args.element === 'number') params['element'] = args.element
      copy(args, params, ['text', 'keys', 'value', 'button', 'count', 'clear', 'submit', 'clicks', 'axis', 'durationMs'])

      let before: string | null = null
      const wantsRefresh = args.refresh === true || (args.refresh !== false && bool(config, 'autoRefreshAfterAction', true))
      if (wantsRefresh && resolvedApp !== undefined) {
        before = await snapshotFingerprint(runtime, resolvedApp, resolvedHwnd)
      }

      // Coordinates may arrive in screenshot space; convert once, here.
      const shot = lastScreenshot(resolvedApp, resolvedHwnd)
      applyCoordinates(args, params, shot)

      // observeBeforeAct: an action addressed purely by coordinates on a window the
      // model has never looked at is a guess, not a plan.
      if (bool(config, 'observeBeforeAct', true) && typeof args.element !== 'number' && !wasObserved(resolvedApp, resolvedHwnd)) {
        return json({
          text:
            `computer_use_act was asked to ${action} by coordinates on a window that has not been observed in this session, ` +
            'and computerUse.observeBeforeAct is on. Nothing was injected. Call computer_use_state for this window first, ' +
            'then address the element index it returns (preferred) or coordinates from its screenshot.',
          refused: 'not_observed',
        })
      }
      if (shot !== null && (typeof args.screenshotX === 'number' || typeof args.screenshotY === 'number') && params['x'] === undefined) {
        return json({
          text:
            'You passed screenshotX/screenshotY but no screenshot has been taken for this window yet, so the coordinates cannot be ' +
            'mapped. Call computer_use_state with captureMode="screenshot" or "both" first, or pass physical screen x/y.',
        })
      }

      let result: ActionResult
      try {
        result = await driver.call<ActionResult>('act', params, driverPolicy(config, approvedIds(runtime, resolvedApp)), timeoutOf(config))
      } catch (error) {
        const failure = error
        if (failure instanceof DriverError && failure.needsForeground) {
          return json({
            text:
              `${failure.message}\n\n` +
              'Nothing was clicked. Options: re-issue the same call with dispatch="foreground" to accept the takeover; ' +
              'or set computerUse.dispatch="foreground" in Settings if this application is the point of the session; ' +
              'or ask the user to perform the step.',
            refused: failure.code,
            escalationHint: 'dispatch="foreground"',
          })
        }
        return json({ text: driverFailureText(error), refused: error instanceof DriverError ? error.code : 'driver_error' })
      }
      driver.touchIdle()

      const lines: string[] = [
        `${action} via ${result.dispatch} (${result.backend})${result.delivered !== undefined ? ` — ${result.delivered}` : ''}`,
      ]
      if (result.appId !== undefined) lines.push(`target: ${result.appId} "${result.title ?? ''}"${resolvedHwnd !== undefined ? ` hwnd=${resolvedHwnd}` : ''}`)
      if (result.point !== undefined) lines.push(`point: ${result.point.x},${result.point.y}`)
      if (result.written !== undefined) lines.push(`characters written: ${result.written}`)
      if (result.pasted !== undefined) lines.push(`characters pasted: ${result.pasted}`)
      if (result.keys !== undefined) lines.push(`keys: ${result.keys.join('+')}`)

      const payload: ToolPayload = { text: lines.join('\n'), result: result as unknown as Record<string, unknown> }
      const images: unknown[] = []

      if (wantsRefresh && resolvedApp !== undefined) {
        const after = await snapshotFingerprint(runtime, resolvedApp, resolvedHwnd)
        const verdict = verdictOf(before, after)
        payload['verdict'] = verdict.verdict
        payload['verdictWhy'] = verdict.why
        const refreshed = await observeForRefresh(runtime, resolvedApp, resolvedHwnd)
        if (refreshed !== null) {
          lines.push('')
          lines.push(`verdict: ${verdict.verdict} — ${verdict.why}`)
          lines.push(describeWindow(refreshed.window, refreshed.foreground))
          lines.push(renderTree(refreshed.tree ?? { backend: 'none', nodeCount: 0, truncated: false, nodes: [], skipped: true }, Math.max(500, Math.trunc(num(config, 'maxTreeChars', 12_000)))).text)
          if (refreshed.screenshot !== undefined) {
            const published = await publishScreenshot(attachmentsOf(runtime.ctx), refreshed.screenshot, `${refreshed.screenshot.appId ?? 'window'}-after-${Date.now()}`)
            if (published.stored) {
              images.push(...published.blocks.filter((block) => block.type === 'image').map((block) => (block as { attachment: unknown }).attachment))
              lines.push('A screenshot taken after the action is attached.')
            }
          }
          payload['state'] = { window: refreshed.window, foreground: refreshed.foreground }
        } else {
          lines.push('')
          lines.push(`verdict: ${verdict.verdict} — ${verdict.why}`)
          lines.push('(the follow-up observation failed; call computer_use_state to see the window)')
        }
      }

      payload['text'] = lines.join('\n')
      if (images.length > 0) payload['images'] = images
      void exec
      return json(payload)
    },
  })
}

function waitTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'computer_use_wait',
    description:
      'Wait for the interface to become ready instead of polling: text appearing or disappearing in the accessibility tree, an ' +
      'application window opening or closing, or a plain pause. Returns as soon as the condition holds, so it costs one call ' +
      'rather than a loop of screenshots.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['text', 'text-gone', 'window', 'sleep'],
        description: 'What to wait for.',
      },
      appId: { type: 'string', description: 'Application to watch.' },
      hwnd: { type: 'string', description: 'Window to watch.' },
      text: { type: 'string', description: 'Exact accessible name to wait for (kind=text / text-gone).' },
      closed: { type: 'boolean', description: 'For kind=window: wait for the window to disappear instead of appear.' },
      timeoutMs: { type: 'integer', description: 'Give up after this long (default 15000, max 120000).' },
      pollMs: { type: 'integer', description: 'Polling interval (default 250).' },
      ms: { type: 'integer', description: 'Duration for kind=sleep.' },
    },
    output: OUTPUT,
    presentCall: (args) => callCard(`Computer Use: wait for ${args.kind}`, 'read', { kind: args.kind, text: args.text }),
    async execute(args) {
      const { config, driver } = runtime
      const disabled = requireEnabled(config)
      if (disabled !== null) return json({ text: disabled })

      const params: Record<string, unknown> = { kind: args.kind }
      copy(args, params, ['appId', 'hwnd', 'text', 'closed', 'timeoutMs', 'pollMs', 'ms'])
      try {
        const result = await driver.call<WaitResult>('wait', params, readPolicy(config), Math.min(150_000, timeoutOf(config) + (typeof args.timeoutMs === 'number' ? args.timeoutMs : 15_000)))
        driver.touchIdle()
        const satisfied = result.satisfied ?? true
        const summary = satisfied
          ? `wait(${result.kind}) satisfied after ${result.elapsedMs} ms${result.text !== undefined ? ` — saw ${JSON.stringify(result.text)}` : ''}${result.appId !== undefined ? ` for ${result.appId}` : ''}.`
          : `wait(${result.kind}) timed out after ${result.elapsedMs} ms. ${result.note ?? ''}`
        // `text` goes last: WaitResult carries the needle in its own `text` field,
        // and spreading it afterwards would replace the model-facing summary.
        return json({ ...result, text: summary, matchedText: result.text ?? null })
      } catch (error) {
        return json({ text: driverFailureText(error) })
      }
    },
  })
}

function launchTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'computer_use_launch',
    description:
      'Start an application and wait for its first window. The sandbox must allow the application (allow-list, deny-list and the ' +
      'per-application approval all apply), because launching is how a computer-use agent reaches a program that is not running yet.',
    parameters: {
      app: { type: 'string', required: true, description: 'Executable name or absolute path, e.g. "mspaint.exe" or "C:\\\\Windows\\\\System32\\\\notepad.exe".' },
      args: { type: 'string', description: 'Command-line arguments.' },
      timeoutMs: { type: 'integer', description: 'How long to wait for the first window.' },
    },
    output: OUTPUT,
    presentCall: (args) => callCard(`Computer Use: launch ${args.app}`, 'execute', { app: args.app }),
    async execute(args, exec) {
      const { config, driver } = runtime
      const disabled = requireEnabled(config)
      if (disabled !== null) return json({ text: disabled })

      const consent = await gateFirstUse(runtime, exec, 'computer_use_launch')
      if (!consent.ok) return json({ text: consent.text, refused: consent.code })

      const app = String(args.app)
      const gate = await requireControl(runtime, exec, 'computer_use_launch', app, app, 'launch')
      if (!gate.ok) return json({ text: gate.text, refused: gate.code })

      const params: Record<string, unknown> = { path: app }
      if (typeof args.args === 'string' && args.args.length > 0) params['args'] = args.args
      params['timeoutMs'] = Math.max(1000, Math.min(120_000, typeof args.timeoutMs === 'number' ? args.timeoutMs : num(config, 'launchTimeoutMs', 20_000)))

      try {
        const result = await driver.call<LaunchResult>('apps.launch', params, driverPolicy(config, approvedIds(runtime, normalizeAppId(app))), timeoutOf(config) + 30_000)
        driver.touchIdle()
        const text = result.windowReady
          ? `Launched ${app} (pid ${result.pid}); window "${result.title ?? ''}" is open as appId="${result.appId ?? ''}". Next: computer_use_state on that appId.`
          : `Started ${app} (pid ${result.pid}) but no new window appeared within the timeout. ${result.note ?? 'It may still be loading.'}`
        return json({ text, ...(result as unknown as Record<string, unknown>) })
      } catch (error) {
        return json({ text: driverFailureText(error) })
      }
    },
  })
}

// --------------------------------------------------------------------------- helpers

/** Applications the driver should treat as cleared for this call. */
function approvedIds(runtime: Runtime, appId: string | undefined): string[] {
  const cleared = runtime.ledger.entries().map((entry) => entry.appId)
  if (appId !== undefined) {
    const id = normalizeAppId(appId)
    if (!cleared.includes(id)) cleared.push(id)
  }
  return cleared
}

/** Copy a whitelist of defined argument keys onto the driver params. */
function copy(args: Record<string, unknown>, params: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = args[key]
    if (value !== undefined && value !== null) params[key] = value
  }
}

/** Windows the model has actually looked at in this session, keyed like the screenshot memory. */
const observedWindows = new Set<string>()

/** Record that a window has been observed, so `observeBeforeAct` has something to check. */
function markObserved(appId: string, hwnd?: string): void {
  observedWindows.add(windowKey(appId, hwnd))
  if (hwnd !== undefined && hwnd.length > 0) observedWindows.add(`app:${normalizeAppId(appId)}`)
  if (observedWindows.size > 256) observedWindows.clear()
}

/** Whether this window has been observed at least once. */
function wasObserved(appId: string | undefined, hwnd?: string): boolean {
  if (hwnd !== undefined && hwnd.length > 0 && observedWindows.has(windowKey('', hwnd))) return true
  if (appId !== undefined && observedWindows.has(windowKey(appId))) return true
  return false
}

/** Remember the origin and scale of the last screenshot so coordinates can be converted. */
const shotMemory = new Map<string, Screenshot>()

/** Stable key for one window, used to remember the screenshot the model was shown. */
function windowKey(appId: string, hwnd?: string): string {
  return hwnd !== undefined && hwnd.length > 0 ? `hwnd:${hwnd}` : `app:${normalizeAppId(appId)}`
}

/** The most recent screenshot metadata for a window, if the model has been shown one. */
function lastScreenshot(appId: string | undefined, hwnd?: string): Screenshot | null {
  if (hwnd !== undefined && hwnd.length > 0) {
    const byHandle = shotMemory.get(windowKey('', hwnd))
    if (byHandle !== undefined) return byHandle
  }
  if (appId !== undefined) {
    const byApp = shotMemory.get(windowKey(appId))
    if (byApp !== undefined) return byApp
  }
  return null
}

/** Record a screenshot so later actions can map image coordinates back to the screen. */
export function rememberScreenshot(key: string, shot: Screenshot): void {
  shotMemory.set(key, shot)
  if (shotMemory.size > 32) {
    const oldest = shotMemory.keys().next()
    if (!oldest.done) shotMemory.delete(oldest.value)
  }
}

/** Translate screenshot-space coordinates into physical screen coordinates. */
function applyCoordinates(args: Record<string, unknown>, params: Record<string, unknown>, shot: Screenshot | null): void {
  const hasPhysical = typeof args.x === 'number' || typeof args.y === 'number'
  const sx = args.screenshotX
  const sy = args.screenshotY
  if (!hasPhysical && typeof sx === 'number' && typeof sy === 'number' && shot !== null) {
    const point = fromScreenshotSpace(shot, sx, sy)
    params['x'] = point.x
    params['y'] = point.y
  } else {
    if (typeof args.x === 'number') params['x'] = args.x
    if (typeof args.y === 'number') params['y'] = args.y
  }
  const tsx = args.toScreenshotX
  const tsy = args.toScreenshotY
  if (typeof tsx === 'number' && typeof tsy === 'number' && shot !== null) {
    const point = fromScreenshotSpace(shot, tsx, tsy)
    params['toX'] = point.x
    params['toY'] = point.y
  } else {
    if (typeof args.toX === 'number') params['toX'] = args.toX
    if (typeof args.toY === 'number') params['toY'] = args.toY
  }
}

/** Tree fingerprint for one application, or null when it cannot be read. */
async function snapshotFingerprint(runtime: Runtime, appId: string, hwnd?: string): Promise<string | null> {
  try {
    const params: Record<string, unknown> = { includeTree: true, captureMode: 'none', maxNodes: 600 }
    if (hwnd !== undefined) params['hwnd'] = hwnd
    else params['appId'] = appId
    const state = await runtime.driver.call<WindowState>('state', params, readPolicy(runtime.config), timeoutOf(runtime.config))
    return fingerprint(state.tree)
  } catch {
    return null
  }
}

/** Re-observe a window after an action, returning null when the read fails. */
async function observeForRefresh(runtime: Runtime, appId: string, hwnd?: string): Promise<WindowState | null> {
  try {
    const params: Record<string, unknown> = {
      includeTree: true,
      captureMode: bool(runtime.config, 'allowScreenshots', true) ? 'window' : 'none',
      maxNodes: Math.max(20, Math.trunc(num(runtime.config, 'maxTreeNodes', 400))),
      scale: Math.max(0.1, Math.min(1, num(runtime.config, 'captureScale', 1))),
    }
    if (hwnd !== undefined) params['hwnd'] = hwnd
    else params['appId'] = appId
    const state = await runtime.driver.call<WindowState>('state', params, readPolicy(runtime.config), timeoutOf(runtime.config))
    markObserved(state.window.appId, state.window.hwnd)
    if (state.screenshot !== undefined) rememberScreenshot(windowKey(state.window.appId, state.window.hwnd), state.screenshot)
    return state
  } catch {
    return null
  }
}

/** Turn a driver failure into text a model can act on. */
export function driverFailureText(error: unknown): string {
  if (error instanceof DriverError) {
    const detail = Object.keys(error.detail).length > 0 ? `\n  detail: ${JSON.stringify(error.detail)}` : ''
    return `${error.code}: ${error.message}${detail}`
  }
  return `${PRODUCT_NAME_EN} failed: ${(error as Error).message}`
}

/** Build every tool this plugin registers. */
export function buildTools(runtime: Runtime): ToolDefinition[] {
  return [
    statusTool(runtime),
    appsTool(runtime),
    stateTool(runtime),
    actTool(runtime),
    waitTool(runtime),
    launchTool(runtime),
  ]
}

/** The dispatch modes advertised to the model in tool descriptions. */
export const DISPATCH_HINT = DISPATCH_MODES.join(' | ')
