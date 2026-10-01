import { PRODUCT_NAME_EN } from './constants.js';
/** One line of the rendered tree. */
function nodeLine(node) {
    const indent = '  '.repeat(Math.min(node.depth, 12));
    const parts = [`[${node.index}]`, node.role];
    if (node.name !== undefined && node.name.length > 0)
        parts.push(JSON.stringify(truncate(node.name, 120)));
    if (node.value !== undefined && node.value.length > 0)
        parts.push(`value=${JSON.stringify(truncate(node.value, 120))}`);
    if (node.offscreen === true)
        parts.push('(offscreen)');
    if (node.enabled === false)
        parts.push('(disabled)');
    if (node.focused === true)
        parts.push('(focused)');
    parts.push(`@${node.centerX},${node.centerY}`);
    if (node.actions !== undefined && node.actions.length > 0)
        parts.push(`actions=${node.actions.join('|')}`);
    return `${indent}${parts.join(' ')}`;
}
function truncate(text, limit) {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
/**
 * Render a captured accessibility tree as indexed text.
 * @param tree - the snapshot returned by the driver.
 * @param maxChars - character budget for the whole rendering.
 * @returns Model-facing text, plus whether the tree was cut.
 */
export function renderTree(tree, maxChars) {
    if (tree.skipped === true)
        return { text: '(accessibility tree not requested)', truncated: false };
    if (tree.nodes.length === 0) {
        return {
            text: '(the accessibility tree is empty for this window — it may be a custom-rendered or GPU-only surface. ' +
                'Ask for a screenshot, or use coordinates.)',
            truncated: false,
        };
    }
    const lines = [];
    let used = 0;
    let cut = false;
    for (const node of tree.nodes) {
        const line = nodeLine(node);
        if (used + line.length + 1 > maxChars) {
            cut = true;
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }
    const header = `# accessibility tree via ${tree.backend}: ${tree.nodes.length} nodes${tree.truncated ? ' (driver cap reached)' : ''}`;
    const footer = cut
        ? `\n# … truncated at ${lines.length} of ${tree.nodes.length} nodes; re-observe a narrower window or raise computerUse.maxTreeChars`
        : '';
    return { text: `${header}\n${lines.join('\n')}${footer}`, truncated: cut || tree.truncated };
}
/** One line describing a window, used by every tool's preamble. */
export function describeWindow(window, foreground) {
    const app = window.elevated ? `${window.appId} (elevated)` : window.appId;
    const state = window.minimized ? ' minimized' : window.maximized ? ' maximized' : '';
    return `${app} — ${JSON.stringify(window.title)} [${window.bounds.width}x${window.bounds.height} at ${window.bounds.x},${window.bounds.y}]${state}${foreground ? ' (foreground)' : ''}`;
}
/**
 * Publish a screenshot as a durable attachment and return it as a content block.
 *
 * A model needs pixels for canvases, charts and custom-rendered surfaces where
 * the accessibility tree is empty or misleading. Returning base64 would cost
 * more context than the image is worth, so the bytes go through the harness
 * attachment store and the transcript carries a durable reference.
 * @param attachments - the resolved attachment service, or undefined.
 * @param shot - the capture returned by the driver.
 * @param label - display name for the stored image.
 * @returns Content blocks: a short text summary plus the image when it could be stored.
 */
export async function publishScreenshot(attachments, shot, label) {
    const summary = screenshotSummary(shot, label);
    if (attachments === undefined) {
        return {
            blocks: [{ type: 'text', text: `${summary}\n(image not attached: no attachment service is composed in this profile)` }],
            stored: false,
            note: 'no attachment service',
        };
    }
    try {
        const data = Buffer.from(shot.base64, 'base64');
        const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: shot.mime, name: `${label}.png` });
        const blocks = [{ type: 'text', text: summary }];
        const hostPath = attachments.imageHostPath?.(ref);
        if (hostPath !== undefined)
            blocks.push({ type: 'text', text: `saved image: ${hostPath}` });
        blocks.push({ type: 'image', attachment: ref });
        return { blocks, stored: true, note: `stored ${data.byteLength} bytes` };
    }
    catch (error) {
        return {
            blocks: [{ type: 'text', text: `${summary}\n(image could not be attached: ${error.message})` }],
            stored: false,
            note: error.message,
        };
    }
}
/** Human summary of one capture, always returned even when the image itself fails. */
export function screenshotSummary(shot, label) {
    const parts = [`${PRODUCT_NAME_EN} screenshot (${label}) ${shot.width}x${shot.height} via ${shot.backend}`];
    if (shot.scale !== 1)
        parts.push(`scaled ${shot.scale}x`);
    if (shot.covered)
        parts.push('WARNING: the capture may show an overlapping window');
    if (shot.note !== undefined && shot.note.length > 0)
        parts.push(shot.note);
    parts.push(`origin ${shot.originX},${shot.originY}`);
    return parts.join(' · ');
}
/**
 * Map a point in screenshot space onto a physical screen point.
 *
 * Screenshots may be scaled and always start at the window's own origin, while
 * the driver injects in physical pixels. Doing the arithmetic here keeps a
 * single conversion in the whole plugin.
 * @param shot - the capture the model measured against.
 * @param x - x in the image the model saw.
 * @param y - y in the image the model saw.
 * @returns Physical screen coordinates.
 */
export function fromScreenshotSpace(shot, x, y) {
    const scale = shot.scale > 0 ? shot.scale : 1;
    return { x: Math.round(shot.originX + x / scale), y: Math.round(shot.originY + y / scale) };
}
/**
 * Compare two tree snapshots and say whether the interface reacted.
 *
 * A bare "ok" from an input-injection layer means the events were queued, not
 * that anything happened. Reporting a verdict is the difference between an agent
 * that notices a dropped click and one that keeps clicking into the void.
 * @param before - node lines before the action, or null when there was no baseline.
 * @param after - node lines after the action, or null when the follow-up failed.
 * @returns A verdict plus a one-line justification.
 */
export function verdictOf(before, after) {
    if (before === null || after === null) {
        return { verdict: 'unverifiable', why: 'no before/after observation pair was available' };
    }
    if (before === after) {
        return {
            verdict: 'suspected_noop',
            why: 'the accessibility tree is byte-identical after the action. Many applications swallow synthetic input — check with a screenshot, or retry with dispatch="foreground"',
        };
    }
    return { verdict: 'confirmed', why: 'the accessibility tree changed after the action' };
}
/** A cheap fingerprint of a tree, used as the before/after baseline. */
export function fingerprint(tree) {
    if (tree === undefined || tree.skipped === true)
        return null;
    return tree.nodes
        .map((node) => `${node.index}|${node.role}|${node.name ?? ''}|${node.value ?? ''}|${node.focused === true ? 'f' : ''}`)
        .join('\n');
}
/** Split base64 image bytes into a Uint8Array without copying twice. */
export function decodeBase64(base64) {
    return new Uint8Array(Buffer.from(base64, 'base64'));
}
