/**
 * Wire types for the NDJSON JSON-RPC conversation with TurtleComputerUse.exe.
 *
 * The protocol is deliberately flat: one request performs one action and returns
 * one result, so the host can approve, log and rate-limit each thing the agent
 * does. Nothing here imports a DeepSeek Harness package, so the same file can be
 * reused by a client-side panel without dragging the host runtime into a browser
 * bundle.
 * @module turtle-plugin-dsh-computer-use/driver/protocol
 */
/** Sandbox decisions the host hands down with every request. */
export interface DriverPolicy {
    readOnly: boolean;
    approvedApps: string[];
    deniedApps: string[];
    allowElevatedTargets: boolean;
    allowForegroundEscalation: boolean;
    maxActionsPerMinute: number;
    /** Whether the driver may paint its synthetic cursor. */
    syntheticCursor?: boolean;
    /** Fade the synthetic cursor out after this much idle time; 0 keeps it visible. */
    cursorIdleHideMs?: number;
}
export interface DriverRequest {
    id: number;
    method: string;
    params: Record<string, unknown>;
    policy?: DriverPolicy;
}
export interface DriverErrorBody {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
}
export type DriverFrame = {
    event: 'ready';
    version: string;
    pid: number;
    elevated: boolean;
} | {
    id: number;
    ok: true;
    result: Record<string, unknown>;
} | {
    id: number;
    ok: false;
    error: DriverErrorBody;
};
/** One rectangle in physical screen pixels. */
export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface WindowSummary {
    hwnd: string;
    pid: number;
    exe: string;
    exePath: string;
    appId: string;
    title: string;
    className: string;
    minimized: boolean;
    maximized: boolean;
    enabled: boolean;
    elevated: boolean;
    offscreen: boolean;
    bounds: Bounds;
    clientBounds: Bounds;
}
export interface AppSummary {
    appId: string;
    exe: string;
    exePath: string;
    pid: number;
    elevated: boolean;
    title: string;
    hwnd: string;
    windowCount: number;
    foreground: boolean;
    titles: string[];
    shell: boolean;
    alwaysDenied: boolean;
    approved: boolean;
    drivable: boolean;
}
export interface AxNode {
    index: number;
    depth: number;
    role: string;
    name?: string;
    value?: string;
    automationId?: string;
    className?: string;
    bounds: Bounds;
    centerX: number;
    centerY: number;
    enabled?: boolean;
    focused?: boolean;
    offscreen?: boolean;
    focusable?: boolean;
    actions?: string[];
}
export interface AxTree {
    backend: string;
    nodeCount: number;
    truncated: boolean;
    nodes: AxNode[];
    skipped?: boolean;
}
export interface Screenshot {
    mime: string;
    base64: string;
    width: number;
    height: number;
    scale: number;
    backend: string;
    covered: boolean;
    note?: string;
    originX: number;
    originY: number;
    byteLength: number;
    hwnd?: string;
    appId?: string;
    title?: string;
}
export interface DriverStatus {
    version: string;
    pid: number;
    elevated: boolean;
    desktopLocked: boolean;
    desktopName: string;
    interactiveSession: boolean;
    sessionId: number;
    uptimeMs: number;
    os: string;
    dpi: number;
    virtualScreen: Bounds;
    logPath: string;
}
export interface WindowState {
    window: WindowSummary;
    foreground: boolean;
    desktopLocked: boolean;
    tree: AxTree;
    screenshot?: Screenshot;
}
export interface ActionResult {
    action: string;
    dispatch: 'background' | 'foreground';
    backend: string;
    delivered?: string;
    hwnd?: string;
    appId?: string;
    title?: string;
    exe?: string;
    point?: {
        x: number;
        y: number;
    };
    element?: number;
    keys?: string[];
    clicks?: number;
    written?: number;
    pasted?: number;
    from?: {
        x: number;
        y: number;
    };
    to?: {
        x: number;
        y: number;
    };
}
export interface LaunchResult {
    pid: number;
    path: string;
    appId?: string;
    exe?: string;
    hwnd?: string;
    title?: string;
    windowReady: boolean;
    note?: string;
}
export interface WaitResult {
    kind: string;
    satisfied?: boolean;
    appId?: string;
    text?: string;
    elapsedMs: number;
    window?: WindowSummary | null;
    note?: string;
}
/** Error codes the driver can raise, and what they mean for the caller. */
export declare const DRIVER_ERROR_CODES: readonly ["bad_request", "unknown_method", "parse_error", "invalid_request", "no_target", "unknown_app", "app_denied", "app_not_approved", "read_only", "target_elevated", "desktop_locked", "session_0", "rate_limited", "background_unavailable", "no_snapshot", "stale_element", "no_uia_element", "pattern_unavailable", "pattern_failed", "read_only_element", "window_minimized", "window_empty", "activation_failed", "input_rejected", "clipboard_failed", "launch_failed", "no_accessibility_tree", "driver_error"];
export type DriverErrorCode = (typeof DRIVER_ERROR_CODES)[number];
/**
 * A structured refusal from the driver.
 *
 * `code` is the machine-readable contract; `message` is written to be read by a
 * model, and always says what to do next rather than only what went wrong.
 */
export declare class DriverError extends Error {
    readonly code: string;
    readonly detail: Record<string, unknown>;
    constructor(code: string, message: string, detail?: Record<string, unknown>);
    /** True when the target needs the foreground and the caller must opt in. */
    get needsForeground(): boolean;
}
