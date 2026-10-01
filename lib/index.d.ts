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
import type { Context } from '@deepseek-ai/cordis';
import { type ComputerUseConfig } from './config.js';
export { Config } from './config.js';
export type { ComputerUseConfig } from './config.js';
export { PLUGIN_NAME, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, VERSION } from './constants.js';
export { DriverClient } from './driver/client.js';
export { DriverError } from './driver/protocol.js';
export { normalizeAppId, checkSandbox, readConsent, consentPath } from './policy.js';
/** Cordis plugin name; must equal the `id` of the loader entry in cordis.patch.yml. */
export declare const name = "computer-use";
/** Services this plugin needs before `apply` runs. */
export declare const inject: string[];
/**
 * Mount the plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - validated configuration (volatile fields are live references).
 */
export declare function apply(ctx: Context, config: ComputerUseConfig): void;
