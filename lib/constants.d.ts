/**
 * Plugin identity and the static parts of the sandbox.
 *
 * Every user-visible name in the plugin comes from here, so the Chinese desktop
 * build and the English README can never drift apart.
 * @module turtle-plugin-dsh-computer-use/constants
 */
/** Cordis plugin name; must equal the `id` of the loader entry in cordis.patch.yml. */
export declare const PLUGIN_NAME = "computer-use";
/** English product name, used in README.md, npm, logs and most surfaces. */
export declare const PRODUCT_NAME_EN = "TurtlePlugin-DSH_ComputerUSE";
/** Chinese product name, used in the Chinese desktop build and README.zh.md. */
export declare const PRODUCT_NAME_ZH = "DSH\u64CD\u7EB5\u7535\u8111\uFF08TurtlePlugin\uFF09";
/** Plugin version, mirrored in package.json and the native driver. */
export declare const VERSION = "0.1.0-rc1";
/** Loader entry id; also the settings namespace a form writes into. */
export declare const SETTINGS_NAMESPACE = "computer-use";
/** Directory under %LOCALAPPDATA% that holds consents, logs and a rebuilt driver. */
export declare const DATA_DIR_NAME = "TurtlePlugin-DSH_ComputerUSE";
/** Native driver file name. */
export declare const DRIVER_EXE = "TurtleComputerUse.exe";
/**
 * Applications the driver refuses unconditionally. The host keeps its own copy
 * so it can explain a refusal without spawning the driver, and so `status` can
 * report them. The driver enforces the same list independently: the host's copy
 * is for the explanation, not for the guarantee.
 */
export declare const ALWAYS_DENIED_APPS: Readonly<Record<string, string>>;
/**
 * Shells and terminals. A computer-use agent typing into a shell is arbitrary
 * code execution wearing a mouse costume, so the sandbox refuses them by
 * design and points the model at the shell tool instead.
 */
export declare const SHELL_APPS: readonly string[];
/**
 * Key combinations that always need a fresh approval, even for an approved
 * application, because they can leave the application's own surface.
 */
export declare const SENSITIVE_KEY_COMBOS: readonly string[];
/** Dispatch modes the plugin exposes. */
export declare const DISPATCH_MODES: readonly ["background", "foreground", "auto"];
export type DispatchMode = (typeof DISPATCH_MODES)[number];
