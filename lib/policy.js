/**
 * The two-layer control model.
 *
 * Layer 1 — sandbox: a static, configurable policy evaluated before anything
 * touches the desktop. Application allow/deny lists, an observe-only mode, a
 * per-minute action budget, and a fixed refusal list for the surfaces where a
 * mis-typed click costs more than the task is worth (terminals, UAC, credential
 * UI, the secure desktop).
 *
 * Layer 2 — approval: a live decision asked through the DeepSeek Harness
 * approval service. One system-level consent the first time Computer Use runs,
 * then one ticket per application that is not on the allow-list. Approvals are
 * one-shot by design: the harness vocabulary has `allowed-once` and nothing
 * else, so the plugin remembers a grant for the session rather than inventing a
 * permanent one.
 * @module turtle-plugin-dsh-computer-use/policy
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALWAYS_DENIED_APPS, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, SHELL_APPS, VERSION } from './constants.js';
import { bool, dispatchOf, list, live, num, str } from './config.js';
import { dataDir } from './driver/client.js';
/**
 * Normalise an application identifier to a comparable leaf name.
 *
 * Accepts `mspaint.exe`, `MSPAINT`, `process:C:\Windows\System32\mspaint.exe`
 * and `C:\Windows\System32\mspaint.exe` and yields `mspaint`, so a user can
 * write whichever form they have in front of them.
 * @param value - app id, exe name, or path.
 * @returns The lowercase leaf name without its `.exe` suffix.
 */
export function normalizeAppId(value) {
    let text = value.trim();
    if (text.toLowerCase().startsWith('process:'))
        text = text.slice(8);
    const slash = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    if (slash >= 0)
        text = text.slice(slash + 1);
    if (text.toLowerCase().endsWith('.exe'))
        text = text.slice(0, -4);
    return text.toLowerCase();
}
/** True when the sandbox refuses this application no matter what is configured. */
export function isAlwaysDenied(appId) {
    return normalizeAppId(appId) in ALWAYS_DENIED_APPS;
}
/** True when the application is a shell or terminal. */
export function isShell(appId) {
    return SHELL_APPS.includes(normalizeAppId(appId));
}
/** Why the sandbox refuses an application outright, or null when it does not. */
export function staticRefusal(appId) {
    const id = normalizeAppId(appId);
    const always = ALWAYS_DENIED_APPS[id];
    if (always !== undefined) {
        return `${always} is refused by the Computer Use sandbox and cannot be enabled by configuration.`;
    }
    if (SHELL_APPS.includes(id)) {
        return `"${id}" is a shell or terminal. A computer-use agent driving a shell is arbitrary code execution, so the sandbox refuses it outright — use the shell tool instead.`;
    }
    return null;
}
/**
 * Evaluate layer 1 for one application.
 * @param appId - normalized or raw application identifier.
 * @param config - the plugin configuration.
 * @param mutating - whether the pending operation injects input.
 * @returns The verdict, with a model-readable reason when it refuses.
 */
export function checkSandbox(appId, config, mutating) {
    const id = normalizeAppId(appId);
    const refusal = staticRefusal(id);
    if (refusal !== null)
        return { allowed: false, whitelisted: false, code: 'app_denied', reason: refusal };
    if (list(config, 'deniedApps').some((entry) => normalizeAppId(entry) === id)) {
        return {
            allowed: false,
            whitelisted: false,
            code: 'app_denied',
            reason: `The Computer Use sandbox deny-list refuses "${id}" for this session. Remove it from computerUse.deniedApps in Settings if that is wrong.`,
        };
    }
    if (mutating && bool(config, 'readOnly')) {
        return {
            allowed: false,
            whitelisted: false,
            code: 'read_only',
            reason: 'The Computer Use sandbox is in observe-only mode, so it will describe the window but will not click, type or launch anything. ' +
                'Turn off computerUse.readOnly in Settings to allow control.',
        };
    }
    const allow = list(config, 'allowedApps');
    if (mutating && allow.length > 0 && !allow.some((entry) => normalizeAppId(entry) === id)) {
        return {
            allowed: false,
            whitelisted: false,
            code: 'app_not_allowlisted',
            reason: `"${id}" is not on the Computer Use allow-list, and the allow-list is currently restrictive ` +
                `(computerUse.allowedApps = ${JSON.stringify(allow)}). Add it in Settings, or empty the list to fall back to ` +
                'per-application approval.',
        };
    }
    return { allowed: true, whitelisted: mutating && allow.some((entry) => normalizeAppId(entry) === id), code: 'ok', reason: '' };
}
/** Build the policy block the driver enforces alongside its own static rules. */
export function driverPolicy(config, approvedApps) {
    return {
        readOnly: bool(config, 'readOnly'),
        approvedApps: [...approvedApps],
        deniedApps: list(config, 'deniedApps'),
        allowElevatedTargets: bool(config, 'allowElevatedTargets'),
        allowForegroundEscalation: bool(config, 'allowForegroundEscalation'),
        maxActionsPerMinute: Math.max(0, Math.trunc(num(config, 'maxActionsPerMinute', 240))),
        syntheticCursor: bool(config, 'syntheticCursor', true),
        cursorIdleHideMs: Math.max(0, Math.trunc(num(config, 'cursorIdleHideMs', 2500))),
    };
}
/** Path of the first-run consent record. */
export function consentPath() {
    return join(dataDir(), 'consent.json');
}
/** Read the persisted first-run consent, or null when it was never granted. */
export function readConsent() {
    try {
        const path = consentPath();
        if (!existsSync(path))
            return null;
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed.grantedAt === 'string' && parsed.grantedAt.length > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
/** Persist the first-run consent so later sessions do not re-ask. */
export function writeConsent(mode) {
    const record = {
        version: 1,
        plugin: VERSION,
        grantedAt: new Date().toISOString(),
        mode,
        note: 'The user accepted the system-level Computer Use consent prompt.',
    };
    try {
        mkdirSync(dataDir(), { recursive: true });
        writeFileSync(consentPath(), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    }
    catch {
        // Persisting is best-effort: a read-only profile re-asks next session rather than failing the action.
    }
    return record;
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
export async function askApproval(approval, exec, toolName, reason, display) {
    if (approval === undefined) {
        return {
            granted: false,
            code: 'approval_unavailable',
            message: `${PRODUCT_NAME_ZH} requires approval for this action, but no approval channel is composed in this profile. ` +
                'Mount @deepseek-ai/dsh-user-approval, or add the application to computerUse.allowedApps in Settings.',
        };
    }
    if (exec.agent === undefined) {
        return {
            granted: false,
            code: 'approval_unavailable',
            message: 'This Computer Use action requires approval, but the tool call has no agent to route the question through.',
        };
    }
    let outcome;
    try {
        outcome = await approval.request({
            agent: exec.agent,
            toolName,
            reason,
            displayReason: { en: display.en, zh: display.zh },
        });
    }
    catch (error) {
        return {
            granted: false,
            code: 'approval_failed',
            message: `The approval question could not be delivered: ${error.message}`,
        };
    }
    switch (outcome) {
        case 'allowed-once':
            return { granted: true, code: 'allowed-once', message: 'granted' };
        case 'rejected':
            return {
                granted: false,
                code: 'approval_rejected',
                message: 'The user rejected this Computer Use action, so nothing was done. Stop and ask what they want instead of working around the refusal.',
            };
        case 'cancelled':
            return { granted: false, code: 'approval_cancelled', message: 'The approval question was cancelled, so nothing was done.' };
        case 'unavailable':
            return {
                granted: false,
                code: 'approval_unavailable',
                message: 'No approval answerer was available, so the request failed closed and nothing was done. ' +
                    'This is also what happens when the session approval policy is "never": every ask is rejected without a prompt. ' +
                    'Switch the session policy to "ask", or add the application to computerUse.allowedApps.',
            };
        default:
            return { granted: false, code: 'approval_unavailable', message: 'The approval channel returned an unknown outcome; treated as a refusal.' };
    }
}
/** Per-session memory of which applications the user has already cleared. */
export class ApprovalLedger {
    granted = new Map();
    /** Record a grant. */
    grant(appId, kind) {
        this.granted.set(normalizeAppId(appId), { at: Date.now(), kind });
    }
    /** Read a grant. */
    get(appId) {
        return this.granted.get(normalizeAppId(appId));
    }
    /** Forget every grant; used by `computer_use_status action="reset"`. */
    reset() {
        this.granted.clear();
    }
    /** The applications cleared so far in this session, in insertion order. */
    entries() {
        return [...this.granted.entries()].map(([appId, record]) => ({
            appId,
            kind: record.kind,
            at: new Date(record.at).toISOString(),
        }));
    }
}
/** Build the human text of the first-run system consent prompt. */
export function consentPrompt(config, driver) {
    const mode = dispatchOf(config);
    const allow = list(config, 'allowedApps');
    const allowText = allow.length > 0 ? allow.join(', ') : '(empty: every application that is not denied needs its own approval)';
    const driverText = driver?.handshake !== null && driver !== null ? `driver v${driver.handshake.version}, pid ${driver.handshake.pid}` : 'driver not yet started';
    return {
        reason: `First run of ${PRODUCT_NAME_EN} Computer Use. Mode=${mode}. Allow-list=${allowText}. ` +
            'Granting this lets the plugin read window contents and accessibility trees, take screenshots, and inject clicks and keystrokes ' +
            'into applications you approve. Terminals, shells, the UAC prompt and the credential UI are refused by the sandbox regardless.',
        en: `Allow ${PRODUCT_NAME_EN} to control your computer?\n\n` +
            `This is a one-time system-level consent. After you allow it:\n` +
            `• the plugin can read the accessibility tree and take screenshots of windows;\n` +
            `• it can click, type, scroll, drag and launch applications, in ${mode} mode;\n` +
            `• ${mode === 'foreground' ? 'in foreground mode YOUR mouse and keyboard are taken over while it works' : 'in background mode it uses its own virtual cursor and your mouse and keyboard stay yours'};\n` +
            `• terminals, shells, the UAC prompt, the credential UI and the lock screen are refused by the sandbox and cannot be enabled.\n\n` +
            `Application allow-list: ${allowText}\n(${driverText})`,
        zh: `允许「${PRODUCT_NAME_ZH}」操纵你的电脑吗？\n\n` +
            `这是首次使用的系统级授权，点击“允许”之后：\n` +
            `• 插件可以读取窗口的无障碍树并截图；\n` +
            `• 插件可以在${mode === 'foreground' ? '“前台接管”' : mode === 'background' ? '“后台虚拟光标”' : '当前'}模式下点击、输入、滚动、拖拽、启动应用；\n` +
            `• ${mode === 'foreground' ? '前台接管模式下，它工作期间会占用你的鼠标和键盘' : '后台模式下它使用独立的虚拟光标，你的鼠标和键盘不受影响'}；\n` +
            `• 终端、Shell、UAC 提示、凭据窗口与锁屏由沙盒硬性拒绝，无法开启。\n\n` +
            `应用白名单：${allowText}\n（${driverText}）`,
    };
}
/** Build the per-application approval text. */
export function appApprovalPrompt(appId, title, action, dispatch) {
    const takeover = dispatch === 'foreground';
    return {
        reason: `Computer Use wants to ${action} the application "${appId}" (window: ${title}) in ${dispatch} mode. ` +
            `Granting approves this application for the rest of the session. The sandbox already cleared it; this is layer 2.`,
        en: `Let ${PRODUCT_NAME_EN} control "${appId}"?\n\n` +
            `Window: ${title}\nFirst action: ${action}\nDispatch: ${dispatch}${takeover ? ' (your mouse and keyboard are taken over while it works)' : ' (virtual cursor; your mouse and keyboard stay yours)'}\n\n` +
            'Allow once approves this application for the rest of this session. Add it to computerUse.allowedApps in Settings to skip this prompt in future sessions.',
        zh: `允许「${PRODUCT_NAME_ZH}」操控「${appId}」吗？\n\n` +
            `窗口：${title}\n首个动作：${action}\n下发方式：${dispatch}${takeover ? '（前台接管，工作期间会占用你的鼠标键盘）' : '（后台虚拟光标，你的鼠标键盘不受影响）'}\n\n` +
            '点击“允许”后，本次会话中该应用不再重复询问。把它加入设置里的 computerUse.allowedApps 可跳过以后的提示。',
    };
}
/** Convenience: read the effective dispatch mode with volatile unwrapping. */
export function effectiveDispatch(config) {
    void str(config, 'dispatch', 'background');
    void live(config.dispatch);
    return dispatchOf(config);
}
