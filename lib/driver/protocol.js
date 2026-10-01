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
/** Error codes the driver can raise, and what they mean for the caller. */
export const DRIVER_ERROR_CODES = [
    'bad_request',
    'unknown_method',
    'parse_error',
    'invalid_request',
    'no_target',
    'unknown_app',
    'app_denied',
    'app_not_approved',
    'read_only',
    'target_elevated',
    'desktop_locked',
    'session_0',
    'rate_limited',
    'background_unavailable',
    'no_snapshot',
    'stale_element',
    'no_uia_element',
    'pattern_unavailable',
    'pattern_failed',
    'read_only_element',
    'window_minimized',
    'window_empty',
    'activation_failed',
    'input_rejected',
    'clipboard_failed',
    'launch_failed',
    'no_accessibility_tree',
    'driver_error',
];
/**
 * A structured refusal from the driver.
 *
 * `code` is the machine-readable contract; `message` is written to be read by a
 * model, and always says what to do next rather than only what went wrong.
 */
export class DriverError extends Error {
    code;
    detail;
    constructor(code, message, detail = {}) {
        super(message);
        this.name = 'DriverError';
        this.code = code;
        this.detail = detail;
    }
    /** True when the target needs the foreground and the caller must opt in. */
    get needsForeground() {
        return this.code === 'background_unavailable';
    }
}
