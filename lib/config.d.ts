/**
 * Plugin configuration.
 *
 * Fields marked `.volatile()` are the ones DeepSeek Harness renders as an
 * editable form in Settings; everything else is fixed at load time from the
 * profile's cordis.patch.yml. A volatile field parses into a `Volatile<T>`
 * reference rather than a value, so always read it through {@link live}.
 * @module turtle-plugin-dsh-computer-use/config
 */
import z from '@deepseek-ai/schemastery';
/** A schemastery value that may be a live-editable reference. */
export interface VolatileLike<T> {
    get(): T;
}
/** Read a possibly-volatile config field. */
export declare function live<T>(value: T | VolatileLike<T>): T;
/** Read a possibly-volatile list field into a plain array. */
export declare function liveList(value: unknown): string[];
export interface ComputerUseConfig {
    enabled: boolean;
    dispatch: 'background' | 'foreground' | 'auto';
    allowedApps: string[];
    allowAllApps: boolean;
    deniedApps: string[];
    readOnly: boolean;
    requireApproval: boolean;
    firstRunConsent: boolean;
    allowElevatedTargets: boolean;
    allowForegroundEscalation: boolean;
    allowScreenshots: boolean;
    syntheticCursor: boolean;
    cursorIdleHideMs: number;
    observeBeforeAct: boolean;
    autoRefreshAfterAction: boolean;
    maxTreeNodes: number;
    maxTreeChars: number;
    maxActionsPerMinute: number;
    requestTimeoutMs: number;
    launchTimeoutMs: number;
    captureScale: number;
    idleShutdownMs: number;
    driverPath: string;
    autoBuildDriver: boolean;
    allowedBrowsers: boolean;
}
/** Validated configuration schema; also the shape of the Settings form. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    dispatch: z<"background" | "foreground" | "auto", "background" | "foreground" | "auto", "volatile-defined">;
    allowedApps: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    deniedApps: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    readOnly: z<boolean, boolean, "volatile-defined">;
    requireApproval: z<boolean, boolean, "volatile-defined">;
    firstRunConsent: z<boolean, boolean, "volatile-defined">;
    allowElevatedTargets: z<boolean, boolean, "volatile-defined">;
    allowAllApps: z<boolean, boolean, "volatile-defined">;
    allowForegroundEscalation: z<boolean, boolean, "volatile-defined">;
    allowScreenshots: z<boolean, boolean, "volatile-defined">;
    syntheticCursor: z<boolean, boolean, "volatile-defined">;
    cursorIdleHideMs: z<number, number, "volatile-defined">;
    observeBeforeAct: z<boolean, boolean, "volatile-defined">;
    autoRefreshAfterAction: z<boolean, boolean, "volatile-defined">;
    maxTreeNodes: z<number, number, "volatile-defined">;
    maxTreeChars: z<number, number, "volatile-defined">;
    maxActionsPerMinute: z<number, number, "volatile-defined">;
    requestTimeoutMs: z<number, number, "volatile-defined">;
    launchTimeoutMs: z<number, number, "volatile-defined">;
    captureScale: z<number, number, "volatile-defined">;
    idleShutdownMs: z<number, number, "volatile-defined">;
    driverPath: z<string, string, "volatile-defined">;
    autoBuildDriver: z<boolean, boolean, "volatile-defined">;
    allowedBrowsers: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    dispatch: z<"background" | "foreground" | "auto", "background" | "foreground" | "auto", "volatile-defined">;
    allowedApps: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    deniedApps: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    readOnly: z<boolean, boolean, "volatile-defined">;
    requireApproval: z<boolean, boolean, "volatile-defined">;
    firstRunConsent: z<boolean, boolean, "volatile-defined">;
    allowElevatedTargets: z<boolean, boolean, "volatile-defined">;
    allowAllApps: z<boolean, boolean, "volatile-defined">;
    allowForegroundEscalation: z<boolean, boolean, "volatile-defined">;
    allowScreenshots: z<boolean, boolean, "volatile-defined">;
    syntheticCursor: z<boolean, boolean, "volatile-defined">;
    cursorIdleHideMs: z<number, number, "volatile-defined">;
    observeBeforeAct: z<boolean, boolean, "volatile-defined">;
    autoRefreshAfterAction: z<boolean, boolean, "volatile-defined">;
    maxTreeNodes: z<number, number, "volatile-defined">;
    maxTreeChars: z<number, number, "volatile-defined">;
    maxActionsPerMinute: z<number, number, "volatile-defined">;
    requestTimeoutMs: z<number, number, "volatile-defined">;
    launchTimeoutMs: z<number, number, "volatile-defined">;
    captureScale: z<number, number, "volatile-defined">;
    idleShutdownMs: z<number, number, "volatile-defined">;
    driverPath: z<string, string, "volatile-defined">;
    autoBuildDriver: z<boolean, boolean, "volatile-defined">;
    allowedBrowsers: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/** Read the numeric field with a floor, tolerating a volatile reference. */
export declare function num(config: ComputerUseConfig, key: keyof ComputerUseConfig, fallback: number): number;
/** Read the boolean field, tolerating a volatile reference. */
export declare function bool(config: ComputerUseConfig, key: keyof ComputerUseConfig, fallback?: boolean): boolean;
/** Read the string field, tolerating a volatile reference. */
export declare function str(config: ComputerUseConfig, key: keyof ComputerUseConfig, fallback?: string): string;
/** Read the list field, tolerating a volatile reference. */
export declare function list(config: ComputerUseConfig, key: keyof ComputerUseConfig): string[];
/** Read the dispatch field, tolerating a volatile reference and bad values. */
export declare function dispatchOf(config: ComputerUseConfig): 'background' | 'foreground' | 'auto';
