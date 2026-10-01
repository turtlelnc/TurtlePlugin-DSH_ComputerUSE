import { type ComputerUseConfig } from './config.js';
import { type DriverClient } from './driver/client.js';
import type { DriverPolicy } from './driver/protocol.js';
/**
 * Normalise an application identifier to a comparable leaf name.
 *
 * Accepts `mspaint.exe`, `MSPAINT`, `process:C:\Windows\System32\mspaint.exe`
 * and `C:\Windows\System32\mspaint.exe` and yields `mspaint`, so a user can
 * write whichever form they have in front of them.
 * @param value - app id, exe name, or path.
 * @returns The lowercase leaf name without its `.exe` suffix.
 */
export declare function normalizeAppId(value: string): string;
/** True when the sandbox refuses this application no matter what is configured. */
export declare function isAlwaysDenied(appId: string): boolean;
/** True when the application is a shell or terminal. */
export declare function isShell(appId: string): boolean;
/** Why the sandbox refuses an application outright, or null when it does not. */
export declare function staticRefusal(appId: string): string | null;
/** The outcome of the sandbox layer for one application. */
export interface SandboxVerdict {
    allowed: boolean;
    /** True when the application is on the allow-list and therefore skips approval. */
    whitelisted: boolean;
    code: string;
    reason: string;
}
/**
 * Evaluate layer 1 for one application.
 * @param appId - normalized or raw application identifier.
 * @param config - the plugin configuration.
 * @param mutating - whether the pending operation injects input.
 * @returns The verdict, with a model-readable reason when it refuses.
 */
export declare function checkSandbox(appId: string, config: ComputerUseConfig, mutating: boolean): SandboxVerdict;
/** Build the policy block the driver enforces alongside its own static rules. */
export declare function driverPolicy(config: ComputerUseConfig, approvedApps: Iterable<string>): DriverPolicy;
interface ConsentRecord {
    version: number;
    plugin: string;
    grantedAt: string;
    mode: string;
    note: string;
}
/** Path of the first-run consent record. */
export declare function consentPath(): string;
/** Read the persisted first-run consent, or null when it was never granted. */
export declare function readConsent(): ConsentRecord | null;
/** Persist the first-run consent so later sessions do not re-ask. */
export declare function writeConsent(mode: string): ConsentRecord;
/** Minimal shape of the harness approval service this plugin uses. */
interface ApprovalServiceLike {
    request(request: {
        agent: unknown;
        toolName: string;
        reason?: string;
        displayReason?: {
            en: string;
            [locale: string]: string;
        };
    }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}
/** The agent identity an approval question is routed through. */
export interface ApprovalContextLike {
    agent?: unknown;
    signal?: AbortSignal;
}
/**
 * Ask the harness approval service, mapping every non-grant onto a refusal.
 *
 * The outcome vocabulary is closed and one-shot, so there is no "allow always":
 * the plugin remembers a grant for the session instead of pretending the
 * harness offered permanence.
 * @param approval - the resolved approval service, or undefined when none is composed.
 * @param exec - execution context supplying the agent to route the question through.
 * @param toolName - tool the user is being asked about.
 * @param reason - audited, model-readable explanation.
 * @param display - localized presentation text.
 * @returns True when the user granted exactly this action.
 */
export declare function askApproval(approval: ApprovalServiceLike | undefined, exec: ApprovalContextLike, toolName: string, reason: string, display: {
    en: string;
    zh: string;
}): Promise<{
    granted: boolean;
    code: string;
    message: string;
}>;
/** Per-session memory of which applications the user has already cleared. */
export declare class ApprovalLedger {
    private readonly granted;
    /** Record a grant. */
    grant(appId: string, kind: 'allow-list' | 'approved'): void;
    /** Read a grant. */
    get(appId: string): {
        at: number;
        kind: 'allow-list' | 'approved';
    } | undefined;
    /** Forget every grant; used by `computer_use_status action="reset"`. */
    reset(): void;
    /** The applications cleared so far in this session, in insertion order. */
    entries(): Array<{
        appId: string;
        kind: string;
        at: string;
    }>;
}
/** Build the human text of the first-run system consent prompt. */
export declare function consentPrompt(config: ComputerUseConfig, driver: DriverClient | null): {
    reason: string;
    en: string;
    zh: string;
};
/** Build the per-application approval text. */
export declare function appApprovalPrompt(appId: string, title: string, action: string, dispatch: string): {
    reason: string;
    en: string;
    zh: string;
};
/** Convenience: read the effective dispatch mode with volatile unwrapping. */
export declare function effectiveDispatch(config: ComputerUseConfig): 'background' | 'foreground' | 'auto';
export {};
