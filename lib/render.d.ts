/**
 * Turning driver data into something a model can read.
 *
 * Two renderings matter. The accessibility tree becomes compact indexed text —
 * indexes are the currency the model addresses elements with, so they are
 * always printed. A screenshot becomes a durable image attachment, because a
 * base64 blob in the transcript is both huge and unusable.
 * @module turtle-plugin-dsh-computer-use/render
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { AxTree, Screenshot, WindowSummary } from './driver/protocol.js';
/** Minimal attachment-service surface this plugin uses. */
interface AttachmentServiceLike {
    saveImage(input: {
        data: Uint8Array;
        mediaType: string;
        name?: string;
    }): Promise<unknown>;
    imageHostPath?(ref: unknown): string | undefined;
}
/**
 * Render a captured accessibility tree as indexed text.
 * @param tree - the snapshot returned by the driver.
 * @param maxChars - character budget for the whole rendering.
 * @returns Model-facing text, plus whether the tree was cut.
 */
export declare function renderTree(tree: AxTree, maxChars: number): {
    text: string;
    truncated: boolean;
};
/** One line describing a window, used by every tool's preamble. */
export declare function describeWindow(window: WindowSummary, foreground: boolean): string;
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
export declare function publishScreenshot(attachments: AttachmentServiceLike | undefined, shot: Screenshot, label: string): Promise<{
    blocks: ContentBlock[];
    stored: boolean;
    note: string;
}>;
/** Human summary of one capture, always returned even when the image itself fails. */
export declare function screenshotSummary(shot: Screenshot, label: string): string;
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
export declare function fromScreenshotSpace(shot: Screenshot, x: number, y: number): {
    x: number;
    y: number;
};
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
export declare function verdictOf(before: string | null, after: string | null): {
    verdict: string;
    why: string;
};
/** A cheap fingerprint of a tree, used as the before/after baseline. */
export declare function fingerprint(tree: AxTree | undefined): string | null;
/** Split base64 image bytes into a Uint8Array without copying twice. */
export declare function decodeBase64(base64: string): Uint8Array;
export {};
