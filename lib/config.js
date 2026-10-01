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
/** Read a possibly-volatile config field. */
export function live(value) {
    const candidate = value;
    return typeof candidate?.get === 'function' ? candidate.get() : value;
}
/** Read a possibly-volatile list field into a plain array. */
export function liveList(value) {
    const resolved = live(value);
    return Array.isArray(resolved) ? resolved.filter((entry) => typeof entry === 'string') : [];
}
/** Validated configuration schema; also the shape of the Settings form. */
export const Config = z.object({
    enabled: z.boolean().default(true)
        .description('Master switch. When off, every Computer Use tool returns a refusal instead of touching the desktop.')
        .volatile(),
    dispatch: z.union([z.const('background'), z.const('foreground'), z.const('auto')])
        .default('background')
        .description('background = independent virtual cursor, your mouse and keyboard stay yours; foreground = codex-computer-use style takeover that really moves the pointer; auto = background first, escalate only when the target cannot be driven that way.')
        .volatile(),
    allowedApps: z.array(z.string()).default([])
        .description('Sandbox allow-list (layer 1). Empty means "any application that is not denied". Entries are exe leaf names, e.g. excel.exe, mspaint.exe, notepad.exe. Hit these and no approval prompt is raised.')
        .volatile(),
    deniedApps: z.array(z.string()).default([])
        .description('Sandbox deny-list. Always wins over the allow-list. Terminals, shells, the UAC prompt and the credential UI are refused by the driver even if you list them here.')
        .volatile(),
    readOnly: z.boolean().default(false)
        .description('Observe-only sandbox: window listing, accessibility trees and screenshots stay available, every click, keystroke and launch is refused.')
        .volatile(),
    requireApproval: z.boolean().default(true)
        .description('Approval layer (layer 2). When on, the first touch of an application that is not on the allow-list raises a DeepSeek Harness approval prompt.')
        .volatile(),
    firstRunConsent: z.boolean().default(true)
        .description('Show the one-time system-level consent prompt the first time Computer Use runs, explaining exactly what the driver can see and do.')
        .volatile(),
    allowElevatedTargets: z.boolean().default(false)
        .description('Allow driving windows that belong to elevated processes. Windows UIPI drops synthetic input from a non-elevated process, so this only works when DeepSeek Harness itself runs elevated.')
        .volatile(),
    allowForegroundEscalation: z.boolean().default(true)
        .description('In background mode, allow a single action to fall back to foreground injection when the target provably cannot be driven in the background. When off, the plugin returns background_unavailable and asks you instead.')
        .volatile(),
    allowScreenshots: z.boolean().default(true)
        .description('Allow screen capture. Turning this off leaves the accessibility tree as the only way to perceive the window.')
        .volatile(),
    syntheticCursor: z.boolean().default(true)
        .description('Paint the plugin\'s own cursor on a click-through overlay so you can see where the agent is about to act. It never moves your physical pointer.')
        .volatile(),
    cursorIdleHideMs: z.natural().default(2500)
        .description('Fade the synthetic cursor out after this much idle time, in milliseconds. 0 keeps it visible.')
        .volatile(),
    observeBeforeAct: z.boolean().default(true)
        .description('Require a fresh observation before each action, so element indexes always belong to the snapshot they were read from.')
        .volatile(),
    autoRefreshAfterAction: z.boolean().default(true)
        .description('Return a fresh window state after every action, together with a verdict saying whether the interface actually changed.')
        .volatile(),
    maxTreeNodes: z.natural().default(400)
        .description('Maximum accessibility-tree nodes returned per observation.')
        .volatile(),
    maxTreeChars: z.natural().default(12000)
        .description('Maximum characters of rendered tree text returned to the model.')
        .volatile(),
    maxActionsPerMinute: z.natural().default(240)
        .description('Sandbox rate limit on injected actions, per minute. 0 disables the limit.')
        .volatile(),
    requestTimeoutMs: z.natural().default(20000)
        .description('Per-request timeout for the native driver, in milliseconds. On timeout the driver is killed and restarted.')
        .volatile(),
    launchTimeoutMs: z.natural().default(20000)
        .description('How long computer_use_launch waits for a launched application to open its first window.')
        .volatile(),
    captureScale: z.number().min(0.1).max(1).default(1)
        .description('Screenshot scale. Clicks are always sent in physical pixels, so the plugin converts back for you; use 0.5 on a 4K display to halve the image cost.')
        .volatile(),
    idleShutdownMs: z.natural().default(300000)
        .description('Reclaim the driver process after this much idle time, in milliseconds. 0 keeps it resident.')
        .volatile(),
    driverPath: z.string().default('')
        .description('Absolute path to TurtleComputerUse.exe. Empty means auto-detect: the copy shipped in the plugin, then a previously compiled copy under %LOCALAPPDATA%.')
        .volatile(),
    autoBuildDriver: z.boolean().default(true)
        .description('Compile the driver from native/ with the in-box .NET Framework compiler when no executable is found. No SDK, no NuGet, no network.')
        .volatile(),
    allowedBrowsers: z.boolean().default(false)
        .description('Allow driving browser windows. Off by default: their content is a web page, so a coordinate click cannot be checked against the accessibility tree the way a native control can.')
        .volatile(),
});
/** Read the numeric field with a floor, tolerating a volatile reference. */
export function num(config, key, fallback) {
    const raw = live(config[key]);
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}
/** Read the boolean field, tolerating a volatile reference. */
export function bool(config, key, fallback = false) {
    const raw = live(config[key]);
    return typeof raw === 'boolean' ? raw : fallback;
}
/** Read the string field, tolerating a volatile reference. */
export function str(config, key, fallback = '') {
    const raw = live(config[key]);
    return typeof raw === 'string' ? raw : fallback;
}
/** Read the list field, tolerating a volatile reference. */
export function list(config, key) {
    return liveList(config[key]);
}
/** Read the dispatch field, tolerating a volatile reference and bad values. */
export function dispatchOf(config) {
    const raw = str(config, 'dispatch', 'background');
    return raw === 'foreground' || raw === 'auto' ? raw : 'background';
}
