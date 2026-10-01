import { Config } from './config.js';
import { PLUGIN_NAME, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, VERSION } from './constants.js';
import { DriverClient } from './driver/client.js';
import { ApprovalLedger } from './policy.js';
import { buildTools } from './tools.js';
export { Config } from './config.js';
export { PLUGIN_NAME, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, VERSION } from './constants.js';
export { DriverClient } from './driver/client.js';
export { DriverError } from './driver/protocol.js';
export { normalizeAppId, checkSandbox, readConsent, consentPath } from './policy.js';
/** Cordis plugin name; must equal the `id` of the loader entry in cordis.patch.yml. */
export const name = PLUGIN_NAME;
/** Services this plugin needs before `apply` runs. */
export const inject = ['tools'];
/**
 * Mount the plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - validated configuration (volatile fields are live references).
 */
export function apply(ctx, config) {
    const log = (level, message) => {
        const logger = ctx.logger;
        const line = `[${PRODUCT_NAME_EN}] ${message}`;
        if (level === 'warn')
            logger.warn(line);
        else if (level === 'debug')
            logger.debug(line);
        else
            logger.info(line);
    };
    const driver = new DriverClient({
        driverPath: typeof config.driverPath === 'string' ? config.driverPath : '',
        autoBuild: config.autoBuildDriver !== false,
        idleShutdownMs: typeof config.idleShutdownMs === 'number' ? config.idleShutdownMs : 300_000,
        log,
    });
    const runtime = {
        ctx,
        config,
        driver,
        ledger: new ApprovalLedger(),
        log,
    };
    const tools = buildTools(runtime);
    for (const tool of tools)
        ctx.tools.register(tool);
    // The driver is a child process; it must not outlive the plugin.
    ctx.effect(() => () => {
        driver.dispose();
    });
    log('info', `${PRODUCT_NAME_ZH} / ${PRODUCT_NAME_EN} v${VERSION} mounted (${String(tools.length)} tools)`);
}
