/**
 * Plugin identity and the static parts of the sandbox.
 *
 * Every user-visible name in the plugin comes from here, so the Chinese desktop
 * build and the English README can never drift apart.
 * @module turtle-plugin-dsh-computer-use/constants
 */

/** Cordis plugin name; must equal the `id` of the loader entry in cordis.patch.yml. */
export const PLUGIN_NAME = 'computer-use'

/** English product name, used in README.md, npm, logs and most surfaces. */
export const PRODUCT_NAME_EN = 'TurtlePlugin-DSH_ComputerUSE'

/** Chinese product name, used in the Chinese desktop build and README.zh.md. */
export const PRODUCT_NAME_ZH = 'DSH操纵电脑（TurtlePlugin）'

/** Plugin version, mirrored in package.json and the native driver. */
export const VERSION = '0.1.0-rc1'

/** Loader entry id; also the settings namespace a form writes into. */
export const SETTINGS_NAMESPACE = PLUGIN_NAME

/** Directory under %LOCALAPPDATA% that holds consents, logs and a rebuilt driver. */
export const DATA_DIR_NAME = 'TurtlePlugin-DSH_ComputerUSE'

/** Native driver file name. */
export const DRIVER_EXE = 'TurtleComputerUse.exe'

/**
 * Applications the driver refuses unconditionally. The host keeps its own copy
 * so it can explain a refusal without spawning the driver, and so `status` can
 * report them. The driver enforces the same list independently: the host's copy
 * is for the explanation, not for the guarantee.
 */
export const ALWAYS_DENIED_APPS: Readonly<Record<string, string>> = Object.freeze({
  consent: 'the Windows UAC consent prompt',
  credentialuibroker: 'the Windows credential UI',
  logonui: 'the Windows logon/lock surface',
  winlogon: 'the Windows logon process',
  lsass: 'the Local Security Authority process',
  useraccountcontrolsettings: 'the UAC settings page',
  regedit: 'Registry Editor',
})

/**
 * Shells and terminals. A computer-use agent typing into a shell is arbitrary
 * code execution wearing a mouse costume, so the sandbox refuses them by
 * design and points the model at the shell tool instead.
 */
export const SHELL_APPS: readonly string[] = Object.freeze([
  'alacritty', 'bash', 'cmd', 'conemu64', 'conhost', 'cscript', 'curl', 'mintty',
  'mshta', 'net', 'netsh', 'openconsole', 'powershell', 'putty', 'pwsh', 'reg',
  'rundll32', 'sc', 'schtasks', 'ssh', 'wezterm-gui', 'windowsterminal', 'wscript',
  'wsl', 'wslhost', 'wt',
])

/**
 * Key combinations that always need a fresh approval, even for an approved
 * application, because they can leave the application's own surface.
 */
export const SENSITIVE_KEY_COMBOS: readonly string[] = Object.freeze([
  'alt+f4', 'ctrl+alt+delete', 'win+l', 'win+r', 'win+x', 'win+s', 'win+i',
  'alt+tab', 'ctrl+shift+esc', 'ctrl+esc', 'win+d', 'win+e', 'win+p', 'win+tab',
])

/** Dispatch modes the plugin exposes. */
export const DISPATCH_MODES = ['background', 'foreground', 'auto'] as const
export type DispatchMode = (typeof DISPATCH_MODES)[number]
