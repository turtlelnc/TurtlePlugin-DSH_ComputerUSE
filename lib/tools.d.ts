/**
 * The six model-facing tools.
 *
 * The shape follows the discipline that computer-use systems converge on:
 * look, then do exactly one thing, then look again. `state` is the only way to
 * obtain element indexes; `act` performs one action and can hand back a fresh
 * state plus a verdict saying whether the interface actually reacted.
 * @module turtle-plugin-dsh-computer-use/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type ComputerUseConfig } from './config.js';
import type { DriverClient } from './driver/client.js';
import { type Screenshot } from './driver/protocol.js';
import { ApprovalLedger } from './policy.js';
/** Everything the tools need, assembled once by the plugin entry. */
export interface Runtime {
    ctx: Context;
    config: ComputerUseConfig;
    driver: DriverClient;
    ledger: ApprovalLedger;
    log(level: 'debug' | 'info' | 'warn', message: string): void;
}
/** Record a screenshot so later actions can map image coordinates back to the screen. */
export declare function rememberScreenshot(key: string, shot: Screenshot): void;
/** Turn a driver failure into text a model can act on. */
export declare function driverFailureText(error: unknown): string;
/** Build every tool this plugin registers. */
export declare function buildTools(runtime: Runtime): ToolDefinition[];
/** The dispatch modes advertised to the model in tool descriptions. */
export declare const DISPATCH_HINT: string;
