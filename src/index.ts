/**
 * TurtlePlugin-DSH_ComputerUSE — Computer Use for DeepSeek Harness.
 *
 * Gives the agent a pair of eyes and a pair of hands on a Windows desktop:
 * UI Automation for perception, a native driver for input, and a synthetic
 * cursor so background control is legible without stealing the user's mouse.
 *
 * Two independent layers constrain it. The sandbox is static configuration —
 * application allow and deny lists, an observe-only mode, a rate limit, and a
 * refusal list for the surfaces where a mis-typed click is unrecoverable. The
 * approval layer is live: one system-level consent the first time, then one
 * ticket per application the allow-list does not already cover.
 *
 * Chinese product name: DSH操纵电脑（TurtlePlugin）
 * English product name: TurtlePlugin-DSH_ComputerUSE
 * @module turtle-plugin-dsh-computer-use
 */
import type { Context } from '@deepseek-ai/cordis'

import { Config, type ComputerUseConfig } from './config.js'
import { PLUGIN_NAME, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, VERSION } from './constants.js'
import { DriverClient } from './driver/client.js'
import { ApprovalLedger } from './policy.js'
import { buildTools, type Runtime } from './tools.js'

export { Config } from './config.js'
export type { ComputerUseConfig } from './config.js'
export { PLUGIN_NAME, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, VERSION } from './constants.js'
export { DriverClient } from './driver/client.js'
export { DriverError } from './driver/protocol.js'
export { normalizeAppId, checkSandbox, readConsent, consentPath } from './policy.js'

/** Cordis plugin name; must equal the `id` of the loader entry in cordis.patch.yml. */
export const name = PLUGIN_NAME

/** Services this plugin needs before `apply` runs. */
export const inject = ['tools']

/**
 * Mount the plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - validated configuration (volatile fields are live references).
 */
export function apply(ctx: Context, config: ComputerUseConfig): void {
  const log = (level: 'debug' | 'info' | 'warn', message: string): void => {
    const logger = ctx.logger
    const line = `[${PRODUCT_NAME_EN}] ${message}`
    if (level === 'warn') logger.warn(line)
    else if (level === 'debug') logger.debug(line)
    else logger.info(line)
  }

  const driver = new DriverClient({
    driverPath: typeof config.driverPath === 'string' ? config.driverPath : '',
    autoBuild: config.autoBuildDriver !== false,
    idleShutdownMs: typeof config.idleShutdownMs === 'number' ? config.idleShutdownMs : 300_000,
    log,
  })

  const runtime: Runtime = {
    ctx,
    config,
    driver,
    ledger: new ApprovalLedger(),
    log,
  }

  const tools = buildTools(runtime)
  for (const tool of tools) ctx.tools.register(tool)

  // The driver is a child process; it must not outlive the plugin.
  ctx.effect(() => () => {
    driver.dispose()
  })

  log('info', `${PRODUCT_NAME_ZH} / ${PRODUCT_NAME_EN} v${VERSION} mounted (${String(tools.length)} tools)`)
}
