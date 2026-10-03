# DSH操纵电脑（TurtlePlugin）

**V0.1.0-rc1** · [English](README.md) | 中文

面向 Windows 上 DeepSeek Harness 的 Computer Use 能力：代理通过 UI Automation 观察窗口，通过原生驱动执行操作。
它与 `codex-computer-use.exe`、Qwen Code 提供的能力属于同一形态——用无障碍树做感知、用合成输入做动作——
区别在于它前面有两道相互独立的控制层，并且对自己做不到的事情如实说明。

| | |
|---|---|
| 英文产品名 | `TurtlePlugin-DSH_ComputerUSE` |
| 中文产品名 | `DSH操纵电脑（TurtlePlugin）` |
| 这两个名字的来源 | `locale/en.json` 与 `locale/zh.json`；应用显示与界面语言一致的那个（见 §7.9） |
| 本文档 | [`README.md`](README.md)（English）· `README.zh.md`（中文） |
| 版本 | `0.1.0-rc1`（显示为 `V0.1.0-rc1`） |
| npm 包名 | `turtle-plugin-dsh-computer-use` |
| Cordis 插件 id | `computer-use` |
| 原生驱动 | `TurtleComputerUse.exe` |
| 仓库 | <https://github.com/turtlelnc/TurtlePlugin-DSH_ComputerUSE> |
| 平台 | Windows 10 / 11（`os: ["win32"]`） |
| 许可证 | Apache-2.0 |

---

## 1. 它能做什么

插件向 DeepSeek Harness 注册六个工具。它们合起来让模型可以：

* 枚举当前打开的应用程序与窗口；
* 把一个窗口的无障碍树读成带索引的文本（UI Automation，对老式工具包回退到 MSAA），和/或对它截图得到 PNG；
* 执行恰好一个输入动作——点击、输入、按键、滚动、拖拽、设置值、调用控件——通过 UIA 模式、定向窗口消息或真实系统输入队列；
* 等待某个条件成立，而不是轮询；
* 启动一个应用程序并等待它的第一个窗口出现。

Windows 特有的现实问题由一个独立进程处理：`TurtleComputerUse.exe`。它负责 DPI 感知（per-monitor v2，因此截图像素就是物理像素）、
窗口枚举、截图、无障碍遍历，以及每一次注入的事件。Harness 一侧从不直接接触桌面，只通过 stdin/stdout 上的
换行分隔 JSON 与驱动通信。

---

## 2. 两种下发方式（dispatch）

`dispatch` 决定输入**如何**到达目标。这是最多人需要调整、后果也最直白的设置。

| 模式 | 会发生什么 | 你的鼠标键盘 |
|---|---|---|
| `background`（默认） | 插件在覆盖整个虚拟屏幕的透明、点击穿透、永不激活的分层窗口上绘制自己的光标，先用 UIA 模式、再用定向窗口消息（`PostMessage`）驱动目标。完全不动系统输入队列，因此目标窗口不必在前台。 | 不受影响 |
| `foreground` | 窗口被激活（`SetForegroundWindow`，含常规的线程输入附加处理），输入走 `SendInput`——真实指针会移动，行为与 `codex-computer-use.exe` 一致。 | 在该动作期间被占用 |
| `auto` | 先走后台。当目标**确证**无法在后台驱动，且 `allowForegroundEscalation` 打开时，这一个动作才落到前台。 | 除非发生升级，否则不受影响 |

这个设计有三点关键性质：

1. **后台模式会拒绝，而不是偷偷抢前台。** 当目标无法在后台驱动时，驱动抛出结构化的 `background_unavailable`
   错误并附带原因（窗口类、`appId`、类名）。它不会静默升级。工具结果随后直接给出解法：

   ```text
   background_unavailable: This target cannot be driven without taking the foreground: Chromium
   content ignores synthetic window messages for coordinate input; it needs the system input queue.
   Re-issue the same action with dispatch="foreground" to accept the takeover, ...
   ```

2. **调用方按动作逐个授权。** `computer_use_act` 接受 `dispatch` 参数
   （`background` | `foreground` | `auto`），它只覆盖这一次调用的配置值：

   ```json
   { "action": "click", "appId": "notepad", "element": 12, "dispatch": "foreground" }
   ```

   在 **设置 → 插件（Settings → Plugins）** 里把 `computerUse.dispatch` 设为 `foreground`，则整个会话默认接管前台。

3. **`auto` 不等于可以随便升级。** 在 `auto` 模式下，只有当驱动有确切理由（已知会吞掉窗口消息的窗口类）
   **且** `allowForegroundEscalation` 为 `true` 时才会升级。若 `allowForegroundEscalation: false`，
   即使 `auto` 也只会返回 `background_unavailable`，把决定权交回给人。

按动作细看（因为"后台"并不是一种机制，而是三种）：

| 动作 | 后台路径 | 后台拒绝条件 |
|---|---|---|
| `click`、`double_click`、`right_click`、`middle_click` | 给了元素索引时用 UIA `InvokePattern`/`TogglePattern`，否则在该元素的客户区坐标上发 `WM_*BUTTON*` 窗口消息 | 命中会吞消息的窗口类 |
| `type` | 定位到可写值元素时用 UIA `ValuePattern.SetValue`，否则发 `WM_CHAR` 消息 | 命中会吞消息的窗口类 |
| `key` | 向窗口（或拥有焦点的子窗口）发 `WM_KEYDOWN`/`WM_KEYUP` 消息 | 命中会吞消息的窗口类 |
| `scroll` | UIA `ScrollPattern`，否则 `WM_MOUSEWHEEL` | 命中会吞消息的窗口类 |
| `hover` | 发 `WM_MOUSEMOVE` 消息 | 永不拒绝（没有点击发生） |
| `drag` | 不可用——拖拽需要在系统队列上做连续的按下-移动-抬起 | 始终返回 `background_unavailable` |
| `set_value`、`invoke`、`toggle`、`expand`、`collapse`、`select` | 对应的 UIA 模式；这些本质上只能在后台执行 | `no_uia_element` / `pattern_unavailable` |
| `paste_text` | 写剪贴板 + 发 `WM_KEYDOWN ctrl` / `v` 消息（窗口类不阻塞时） | 命中会吞消息的窗口类，或 `allowForegroundEscalation: false` |
| `focus`、`activate` | 不可用——这两个按定义就是前台操作 | — |

---

## 3. 两道控制层

一次 Computer Use 动作的许可被判定两次，由两个互不信任的机制各自判定。第 1 层是位于宿主侧、
并对每个触及窗口的动作由驱动再次强制执行的静态配置；第 2 层是通过 DeepSeek Harness 审批服务提出的实时询问。
（有一处不对称：**启动应用**由宿主把关，因为驱动对 `apps.launch` 只强制 `readOnly` 与频率预算——
见 [docs/driver-protocol.md](docs/driver-protocol.md#7-reciprocity-who-enforces-what)。）

### 第 1 层 —— 沙盒（sandbox）

| 控制项 | 设置 | 默认值 | 效果 |
|---|---|---|---|
| 允许清单 | `allowedApps` | `[]`（空） | 列在这里的应用无需审批即可放行。**空清单不等于"什么都不允许"**：空意味着"任何未被拒绝的应用都需要一次审批"。非空清单则是限制性的：不在清单上的应用以 `app_not_allowlisted` 被拒绝。 |
| 全部允许 | `allowAllApps` | `false` | 预先放行**本机所有应用**（除拒绝清单与内置硬拒绝清单之外），核准层不再逐应用发问。要"允许所有程序"请用这个开关，而不是把程序逐个列进白名单——非空 `allowedApps` 是**限制性**的，列"全部"既列不完也不可靠。它无法解除下面的硬拒绝。 |
| 拒绝清单 | `deniedApps` | `[]` | 永远优先于允许清单。以 `app_denied` 拒绝。 |
| 只观察 | `readOnly` | `false` | 窗口枚举、无障碍树和截图照常可用；每一次点击、按键和启动都以 `read_only` 被拒绝。 |
| 频率限制 | `maxActionsPerMinute` | `240` | 对注入动作的一分钟滚动预算，在驱动内强制执行（`rate_limited`）。`0` 表示不限制。 |
| 高权限目标 | `allowElevatedTargets` | `false` | 关闭时，属于提权进程的窗口会在任何注入发生之前以 `target_elevated` 被拒绝。 |
| 浏览器 | `allowedBrowsers` | `false` | 默认只描述浏览器窗口而不放行：其内容是网页，坐标点击无法与无障碍树互相印证。 |

此外还有一份**任何配置都无法解除**的拒绝清单，由 `TurtleComputerUse.exe` 独立于宿主的那份副本强制执行
（`policy.explain` 会同时报告两份清单）：

* **Shell 与终端**——`cmd`、`powershell`、`pwsh`、`windowsterminal`、`wt`、`conhost`、`openconsole`、
  `bash`、`wsl`、`wslhost`、`cscript`、`wscript`、`mshta`、`rundll32`、`reg`、`net`、`netsh`、
  `schtasks`、`sc`、`curl`、`ssh`、`putty`、`mintty`、`conemu64`、`alacritty`、`wezterm-gui`。
  让 computer-use 代理往 shell 里打字，等于披着鼠标外衣的任意代码执行；拒绝信息会指引模型改用 shell 工具。
* **安全界面**——UAC 同意提示（`consent`）、凭据界面（`credentialuibroker`）、登录/锁屏界面（`logonui`）、
  `winlogon`、`lsass`、UAC 设置页（`useraccountcontrolsettings`）、注册表编辑器（`regedit`）。

还有两条沙盒性质值得了解，因为它们堵住的是真实漏洞：

* **坐标必须落在已批准的窗口内。** 如果调用方指定了窗口，而坐标落在其边界之外，驱动会抛出
  `point_outside_target` 且不注入任何东西。没有这条检查，"批准应用 A、却在应用 B 上的像素处点击"就是沙盒的一个洞。
* **动作必须指明目标。** 既没有 `appId`、也没有 `hwnd`、也没有 `element` 的纯坐标操作会被直接拒绝（`no_target`），
  因为沙盒必须先知道它要碰的是哪个应用，才可能去批准它。

### 第 2 层 —— 审批（approval）

1. **一次系统级授权，只记录一次。** DeepSeek Harness 弹出唯一一个审批问题，说明驱动在当前下发模式下能看到什么、能做什么。
   它会在**第一次真正触碰桌面**时自动弹出——`computer_use_state`、`computer_use_act` 或 `computer_use_launch`——同意后写入
   `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\consent.json`，此后不再询问；
   `computer_use_status` 会报告授权是否已记录，也可以用 `action: "consent"` 主动重新弹出，
   `firstRunConsent: false` 可以完全关闭该提示。
   `computer_use_apps` 不受此门控，因此模型始终可以在不打扰你的前提下发现当前打开了哪些程序。
2. **每个应用问一次。** 对于不在允许清单、且本会话尚未放行的应用，弹出一次审批提示，其中写明应用、窗口标题、首个动作和下发方式。
3. **只在会话内记住，而不是永久记住。** Harness 的审批词表是封闭且一次性的——`allowed-once` / `rejected` /
   `cancelled` / `unavailable`，没有 `allow-always`、没有记忆规则、也没有授权存储。因此插件把这次同意记在内存账本里，
   供本会话后续使用，而不是假装 harness 提供了永久授权。`computer_use_status` 的 `action: "reset"` 可清空账本；
   真正让授权跨重启保留的做法，是把应用写进设置里的 `allowedApps`。
4. **失败即拒绝（fail closed）。** 当会话审批策略为 `never`、profile 中没有装配应答方、调用上没有 agent，
   或者问题无法送达时，请求一律被**拒绝**，不点击、不输入、不启动。不存在"默认同意"的路径。

---

## 4. 设置项

schema 中每一个标记了 `.volatile()` 的字段都可以在 **设置 → 插件（Settings → Plugins）** 中实时编辑
（命名空间为 `computer-use`）；同样的值也可以在加载时由 profile 的 `cordis.patch.yml` 写入。下表中的默认值就是 schema 的真实默认值。

| 设置 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关闭时每个工具都返回拒绝，而不接触桌面。 |
| `dispatch` | `background` \| `foreground` \| `auto` | `background` | 见第 2 节。 |
| `allowedApps` | string[] | `[]` | 沙盒允许清单。条目是可执行文件叶子名（`excel.exe`、`mspaint.exe`、`notepad.exe`）。命中它们不会弹审批。**非空清单会限制其余所有应用**，所以要放行整台机器请用 `allowAllApps`，而不是把每个程序都列进去。 |
| `allowAllApps` | boolean | `false` | 不逐个列举、也不逐个弹窗，直接允许本机所有应用。预先放行一切不在 `deniedApps`、也不在内置硬拒绝清单上的应用，并隐含 `allowedBrowsers`。硬拒绝清单——终端与 Shell、UAC 提示、凭据界面、登录/锁屏界面、注册表编辑器——仍然拒绝，没有任何设置能解除。 |
| `deniedApps` | string[] | `[]` | 沙盒拒绝清单。永远优先于允许清单。 |
| `readOnly` | boolean | `false` | 只观察沙盒。 |
| `requireApproval` | boolean | `true` | 第 2 层。关闭后，沙盒放行的应用会被直接驱动而不弹提示。 |
| `firstRunConsent` | boolean | `true` | 首次使用时显示一次系统级授权提示。 |
| `allowForegroundEscalation` | boolean | `true` | 允许单个动作在目标确证无法后台驱动时落到前台注入。关闭时改为返回 `background_unavailable`。 |
| `allowElevatedTargets` | boolean | `false` | 允许驱动属于提权进程的窗口（只有在 DeepSeek Harness 自身以管理员身份运行时才有效——见第 5 节）。 |
| `allowScreenshots` | boolean | `true` | 关闭后，无障碍树成为感知窗口的唯一途径。 |
| `syntheticCursor` | boolean | `true` | 在点击穿透的浮层上绘制插件自己的光标，让你看到代理即将操作的位置。它绝不移动你的物理指针。 |
| `cursorIdleHideMs` | number | `2500` | 合成光标在空闲这么久之后淡出。`0` 表示一直显示。 |
| `observeBeforeAct` | boolean | `true` | 要求每个动作前重新观察一次，使元素索引始终属于读到它的那份快照。 |
| `autoRefreshAfterAction` | boolean | `true` | 每个动作后返回新的窗口状态，并附上界面是否真的发生变化的判定（verdict）。 |
| `maxTreeNodes` | number | `400` | 单次观察返回的无障碍树节点上限。 |
| `maxTreeChars` | number | `12000` | 返回给模型的树文本字符上限。 |
| `maxActionsPerMinute` | number | `240` | 沙盒对注入动作的频率限制（每分钟）。`0` 表示不限制。 |
| `requestTimeoutMs` | number | `20000` | 对驱动的单次请求超时。超时后驱动会被结束并在下次调用时重启。 |
| `launchTimeoutMs` | number | `20000` | `computer_use_launch` 等待被启动应用打开第一个窗口的时长。 |
| `captureScale` | number | `1`（0.1–1） | 截图缩放。点击始终按物理像素发送，插件会替你换算；4K 屏上可用 `0.5` 减半图像开销。 |
| `idleShutdownMs` | number | `300000` | 空闲这么久之后回收驱动进程。`0` 表示常驻。 |
| `driverPath` | string | `''` | `TurtleComputerUse.exe` 的绝对路径。留空表示自动探测：先用插件内随包发布的副本，再用 `%LOCALAPPDATA%` 下曾编译出的副本。 |
| `autoBuildDriver` | boolean | `true` | 找不到可执行文件时，用系统自带的 .NET Framework 编译器从 `native/` 编译驱动。不需要 SDK、不需要 NuGet、不需要联网。 |
| `allowedBrowsers` | boolean | `false` | 允许驱动浏览器窗口。 |

**应用标识会被归一化。** `allowedApps` 与 `deniedApps` 的条目、工具接收的 `appId`，以及驱动比较的一切，
都会被归约为小写、去掉 `.exe` 后缀的可执行文件叶子名：`mspaint.exe`、`MSPAINT`、
`C:\Windows\System32\mspaint.exe`、`process:C:\apps\EXCEL.EXE` 都能匹配。你眼前是哪种写法就写哪种。

**每个开关真正生效的位置。** `readOnly`、`maxActionsPerMinute`、`allowElevatedTargets`、
`allowForegroundEscalation`、`deniedApps`、`syntheticCursor`、`cursorIdleHideMs`
以及已放行应用列表，会随每个请求放在 `policy` 块中交给驱动，由驱动自己强制执行——
包括硬编码的 Shell/UAC 拒绝清单，驱动对「启动」和「动作」一视同仁地施加该检查。
允许清单、授权记录和审批账本则位于 harness 一侧。

`observeBeforeAct` 在两处生效：驱动对不属于最新快照的元素索引返回 `no_snapshot` / `stale_element`；
host 则拒绝「本会话从未观察过该窗口、却只用坐标寻址」的动作（`not_observed`）——
在没看过的窗口上给坐标是猜测而不是计划。调用 `computer_use_state` 即可解除该限制。

---

## 5. 六个工具

| 工具 | 用途 |
|---|---|
| `computer_use_status` | 自检：驱动路径与版本、桌面会话、锁屏状态、两道控制层、生效的下发方式，以及本会话已放行的应用。只读。 |
| `computer_use_apps` | 列出 Computer Use 当前能看到的应用程序与窗口，含归一化后的 `appId`、可执行文件、标题、尺寸、是否提权，以及沙盒是否会放行。只读，永不需要审批。从这里开始。 |
| `computer_use_state` | 观察一个窗口：带索引的无障碍树、截图，或两者都要。元素索引的唯一来源。 |
| `computer_use_act` | 执行恰好**一个**动作，然后返回新状态与判定（verdict）。 |
| `computer_use_wait` | 等待文本出现或消失、窗口打开或关闭，或单纯等待一段时间——一次调用，而不是轮询循环。 |
| `computer_use_launch` | 启动一个应用程序并等待它的第一个窗口。会经过两道控制层。 |

完整的参数、类型、默认值与示例调用见 [docs/api.md](docs/api.md)。

### 工具假设的工作纪律

**观察 → 一个动作 → 再观察。**

* **元素索引是快照，不是句柄。** 它们来自该窗口最近一次 `computer_use_state`，也仅对该次快照有效。
  驱动只保留一份快照，因此来自更早调用的索引会以 `stale_element` 失败，而不是落在一个看起来合理却错误的位置。
  每个动作之后都要重新观察。
* **每次调用只做一个动作。** `computer_use_act` 刻意没有批量模式：批量化会架空逐动作的频率限制、
  审批审计和判定（verdict）。
* **每个动作都带判定。** 来自输入注入层的一句 "ok" 只说明事件被排入了队列，不代表任何事真的发生了。
  在开启刷新（默认开启）时，插件会在动作前后对无障碍树取指纹，并给出以下之一：

  | 判定 | 含义 |
  |---|---|
  | `confirmed` | 动作之后无障碍树发生了变化 |
  | `suspected_noop` | 动作之后无障碍树逐字节相同。许多应用会吞掉合成输入——用截图确认，或用 `dispatch: "foreground"` 重试 |
  | `unverifiable` | 没有可用的动作前/后观察对 |

* **坐标有明确的坐标系。** `computer_use_state` 返回图像，并记录其原点与缩放；
  `screenshotX`/`screenshotY`（拖拽时为 `toScreenshotX`/`toScreenshotY`）按该图像解释并换算为物理像素。
  `x`/`y` 是物理屏幕像素，属最后手段——优先使用元素索引。
* **截图会变成附件，而不是塞进对话的 base64。** 字节经 harness 附件存储落盘，对话中只保留一个持久引用。

---

## 6. 权限与首次使用

**授权提示说了什么。** 它在第一次使用 Computer Use 感知窗口或注入输入时自动弹出
（`computer_use_state`、`computer_use_act`、`computer_use_launch`），也可以用
`computer_use_status action: "consent"` 主动重新触发；提示写明插件名称，
说明这是一次性的系统级授权，并逐条列出随后成为可能的事：
读取窗口无障碍树并截图；在当前下发模式下点击、输入、滚动、拖拽、启动应用；
你的鼠标键盘是被接管（`foreground`）还是不受影响（`background`）；以及终端、Shell、UAC 提示、凭据界面与锁屏
由沙盒硬性拒绝、无法开启。它还会显示当前允许清单和驱动版本。关于你的屏幕不会被记录任何东西——
落盘的只有 `consent.json`，它记录的只是你点了"允许"。

**驱动高权限窗口需要 harness 自身提权。** Windows 的用户界面特权隔离（UIPI）会丢弃从低完整性进程发往高完整性窗口的合成输入。
因此 `allowElevatedTargets: true` 本身不起作用：DeepSeek Harness（以及它派生出的驱动）必须自己以管理员身份运行。
`computer_use_status` 会专门对"开关已打开、进程未提权"这一组合发出警告；当开关关闭时，驱动按动作以
`target_elevated` 拒绝。驱动的清单刻意声明 `asInvoker` 与 `uiAccess="false"`：它绝不静默获取提权，
所以当真需要提权时，是**你**用那种方式启动了 harness，Windows 才会弹出它自己的 UAC 提示。

**驱动是一个独立可执行文件。** `TurtleComputerUse.exe` 不是转手调用 PowerShell，也不是 Node 插件；
它是一个带有 Win32 消息循环的小型 C# 程序。它随包预编译发布（`lib/native/TurtleComputerUse.exe`），
也可以在做工机器上重新编译——安装时通过 `npm run build`，或在可执行文件缺失且 `autoBuildDriver` 打开时于首次使用时编译——
使用的是 .NET Framework 自带的 C# 编译器（`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`）。
不需要 SDK、不需要 NuGet 还原、不需要联网。编译产物缓存在
`%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\bin\`。详见 [native/README.md](native/README.md)。

---

## 7. 安装

目前有两代 harness 并存，它们的插件安装方式**完全不同**。请先看 §7.1。

### 7.1 你用的是哪一代？

| Harness | 运行时版本 | 可用的安装入口 | 状态 |
|---|---|---|---|
| **DeepSeek Harness 桌面端 v0.2.0** | `0.2.0-rc.2` | Web 侧边栏 → **插件** → **添加插件** | 已支持 |
| **`dsh` CLI `0.1.7-rc.2`**（含 `0.1.7-rc.1`、`0.1.6-*`、`0.1.5-rc.*`） | `0.1.7-rc.2` | `dsh plugin --profile <名称> add …` | 已支持，同一个构建 |
| 其他 harness | — | — | 未验证 |

插件把 peer 声明成 `>=0.1.7-rc.2 <0.3.0`，所以**一份构建同时服务两条线**。这不是乐观估计：
在 `0.1.7-rc.2` 与 `0.2.0-rc.2` 之间，本插件真正使用的那三个包——
`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-user-approval`——
**逐字节完全相同**，只有各自的 `package.json` 不同。`@deepseek-ai/cordis` 两条线都是 `~4.0.4`，
`@deepseek-ai/schemastery` 两条线都是 `~3.18.4`。用下面的命令确认自己用的是哪个版本：

```powershell
dsh --version
```

**包还没有发布到 npm。** 目前可用的是 tarball、Git 地址和本地绝对路径三种；
npm 包名方式要等发布之后才成立。

### 7.2 桌面端 v0.2.0

桌面端拥有自己的 profile，CLI 无权管理它，因此侧边栏页面是唯一受支持的入口。全部操作都在应用内完成。

1. **打开插件页。** 左侧栏选择 **插件**（英文界面为 **Plugins**）。它通过 `api-remotes` 读取当前
   profile 已安装的组合包；没有受管 profile 的 Host 会把该页面显示为不可用。

2. **选择安装源。** 点击 **添加插件**（**Add plugin**）。输入框旁边有 **安装源**（**Registry**）选择器：
   官方 npm 源、**npmmirror**（中国大陆镜像，如果你那里 `registry.npmjs.org` 很慢或不通就选它）、
   或自定义 `http(s)` 地址（私有源）。首次使用时应用会并发探测官方源与 npmmirror，把最先 ping 通的
   那个设为默认；你的选择随后会记在这个浏览器里。

   > **镜像代理的是 npm 源，不是 GitHub。** 如果你用 *Git 地址* 安装而 GitHub 不通，换到 npmmirror
   > 没有帮助——对话框会提示 **无法访问 GitHub** 并给出 **使用中国大陆镜像**，点了仍会回到空输入框。
   > GitHub 被墙时请改用 **tarball** 或 **npm 包名**。

3. **填入 spec。** 这个输入框接受的正是 README 里 `dsh plugin add` 后面那一段，另外还接受 Git 地址和路径。
   目前请用下面之一：

   ```text
   C:\Users\<你>\Downloads\turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz      ← tarball（推荐）
   C:\Users\<你>\Videos\Turtle.AI-DSH_Plugin\Turtle.AIplugin-DSH_ComputerUSE  ← 本地绝对路径
   github:turtlelnc/TurtlePlugin-DSH_ComputerUse                              ← Git（需要能访问 GitHub）
   turtle-plugin-dsh-computer-use@0.1.0-rc1                                   ← npm，发布之后
   ```

   目前也还没有 GitHub Releases 可以下载 tarball——用 §7.7 一步生成，或者克隆仓库后把目录填进去。

4. **读完信任提示再安装。** **安装** 按钮上方那行提示始终可见，它说明已安装的插件**不会自动更新**：
   升级意味着卸载后安装新版本。安装会在 profile 目录里运行 `pnpm add`，也就是说从这一刻起，该包里的
   代码会在 harness 进程内执行。pnpm 的命令与输出折叠在 **查看安装详情** 之后。

   Host 会在安装前先读出 spec 指向什么：源里没有这个名字、路径下没有 `package.json`、包里没有
   `dsh.bundle` 声明、或者 pnpm 会拒绝的 spec，都会在输入框下方用一句话说明。

5. **启用它。** 安装完成后会出现 **立即启用**，点击即打开该组合包、关闭对话框并把列表滚到它。
   如果直接关闭，组合包保持已安装但处于**关闭**状态——在 **已安装** 里打开它的卡片，手动开启开关。

6. **重启 DeepSeek Harness。** loader patch 在 profile 启动时读取，所以在重启之前那六个
   `computer_use_*` 工具并不存在。

7. **配置白名单。** 两种方式都可以：
   * **插件 → computer-use → 配置**——插件自己的配置页，由 schema 渲染，包含白名单、黑名单、下发模式等；
   * **设置 → 内置插件**——只读清单，用来确认它到底挂载上没有。

### 7.3 `dsh` CLI（0.1.7-rc.2 及 0.1.x 全线）

`dsh plugin --profile <名称> <pnpm 参数>` 会把参数转发给 **profile 目录内** 的 pnpm，因此
`add`、`remove`、`update`、`install` 都可以用，另外还有 §7.4 的版本豁免子命令。

> **`desktop` profile 无法从 CLI 管理。** `desktop` 这个名字属于 Electron 拥有的 profile，CLI 会拒绝
> 针对它的启动、config-dump 和插件管理请求。那个 profile 请用桌面端的插件页（§7.2）；CLI 请在
> `web` 或其他 profile 里操作。

```powershell
# 0. 一次性：先拿到可安装的 tarball。
git clone https://github.com/turtlelnc/TurtlePlugin-DSH_ComputerUse.git
cd TurtlePlugin-DSH_ComputerUse
pnpm install
pnpm pack
#   → turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz

# 1. 装进某个 profile。`web` 是 CLI 自带的 Web profile，首次使用会自动初始化；
#    换成你实际运行的那个 profile 名称即可。
dsh plugin --profile web add .\turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz

# 2. 对账：包必须同时出现在 dependencies 和 dsh.profile.bundles 里。
Get-Content $env:USERPROFILE\.dsh\profiles\web\package.json

# 3. 层组合检查：应出现 "# == turtle-plugin-dsh-computer-use" 层，
#    且没有 duplicate-id 告警、没有 "declares no dsh.bundle" 报错。
dsh --profile web --dump-config | Select-String "turtle-plugin" -Context 2,12

# 4. 用该 profile 重启 harness。
dsh --profile web
```

如果你不想把它放在 `%USERPROFILE%\.dsh` 下，`$DSH_HOME` 可以整体搬走 `profiles/` 目录。

重启之后，桌面端 **配置** 页的对应物就是插件的设置表单：它能出现，是因为每个可配置字段都声明了
`.volatile()`；表单的写入会落到该 profile 的 `cordis.patch.yml`。

同样的三种 spec 形式在这里也能用：

```powershell
dsh plugin --profile web add turtle-plugin-dsh-computer-use          # npm 包名（发布之后）
dsh plugin --profile web add github:turtlelnc/TurtlePlugin-DSH_ComputerUse
dsh plugin --profile web add C:\绝对\路径\Turtle.AIplugin-DSH_ComputerUse
```

> **优先用 tarball，不要用本地目录。** 在 Windows + pnpm 10/11 上，`add <绝对路径>` 可能生成坏符号链接
> （随后 dsh 会误报 *"declares no dsh.bundle"*）；而且链接方式的插件真实路径在
> `$DSH_HOME/profiles/` 树外时，运行时解析不到它的 peer 依赖。tarball 的行为与从源安装完全一致。

### 7.4 如果版本检查拒绝了安装

两条线都会在 pnpm 运行之前，**把声明的 DSH peer 范围与正在运行的运行时版本做校验**。本插件声明
`>=0.1.7-rc.2 <0.3.0`，两条线都满足，所以正常情况下不会被拒。若将来某个版本真的被拒，harness 会打印
应当执行的确切命令——这是一条**精确版本豁免**，记录在该 profile 自己的 `compatibility.json` 里
（与 `package.json` 同级）：

```powershell
dsh plugin --profile web version-exemptions                              # 当前运行时 + 已保存的豁免
dsh plugin --profile web allow-version turtle-plugin-dsh-computer-use@0.1.0-rc1 `
    --dsh-version 0.1.7-rc.2 --accept-risk
dsh plugin --profile web revoke-version turtle-plugin-dsh-computer-use@0.1.0-rc1 `
    --dsh-version 0.1.7-rc.2
```

一条豁免只覆盖**一个确切的插件版本 + 一个确切的运行时版本**：既不会随插件升级继承，也不会随 harness
升级继承，并在下一次组合时生效。桌面端会在安装失败对话框里提供同样的入口。接受之前请读一遍风险提示：
不兼容的插件在进程内运行，可能让 harness 崩溃或损坏数据。

### 7.5 验证安装

在会话里，两种 harness 都一样：

```text
computer_use_status     → 驱动路径与版本、桌面锁定状态、两道控制层
computer_use_apps       → 当前可见的东西
```

`computer_use_status` 是区分「装坏了」和「驱动坏了」最快的办法：可执行文件缺失时它会报
`native driver: UNAVAILABLE` 并给出原因，否则会完整报告沙盒与核准层的状态。

### 7.6 升级与卸载

**桌面端：** **插件 → 已安装 → 该组合包的卡片**。卸载会要求确认。升级就是卸载后安装新版本——
已安装的插件永远不会自己更新。

**CLI：**

```powershell
dsh plugin --profile web remove turtle-plugin-dsh-computer-use
```

如果上一次是从一个磁盘上已不存在的 tarball 安装的，请先 `remove` 再 `add` 新的：残留的 `file:` spec
会让 pnpm 报 `ENOENT`。

### 7.7 从源码构建

```powershell
git clone https://github.com/turtlelnc/TurtlePlugin-DSH_ComputerUse.git
cd TurtlePlugin-DSH_ComputerUse
pnpm install          # 保留 .npmrc：auto-install-peers=false 是必需的
pnpm build            # tsc → lib/，然后 csc → lib/native/TurtleComputerUse.exe
pnpm pack             # → turtle-plugin-dsh-computer-use-0.1.0-rc1.tgz
```

`lib/` 与 `lib/native/TurtleComputerUse.exe` 是**有意提交进仓库**的：从 Git 安装时 harness 直接加载
`lib/index.js`，**不会执行构建步骤**，所以把构建产物一起发出去，才能让一台没有任何工具链的机器装上就能用。
每次改动 `src/` 或 `native/` 之后，请在提交前重新跑一次 `pnpm build`。

在非 Windows 主机上，`pnpm build` 只编译 TypeScript，并跳过原生步骤给出警告。

**仅限 Windows。** 包声明了 `os: ["win32"]`。在其他平台上清单检查会直接失败，而不是装上一个不可能工作的东西。

### 7.8 环境要求

| 要求 | 版本 / 说明 |
|---|---|
| Windows | Windows 10 或 Windows 11，且位于交互式桌面（不是 Session 0，也不是 SSH 登录会话——见 §9） |
| .NET Framework | 4.x，系统自带。仅用于编译驱动；可执行文件本身除 Windows 自带组件外不需要额外运行时 |
| Node.js | `^22.19.0 \|\| >=24.0.0`（harness 的要求，插件继承） |
| DeepSeek Harness | 桌面端 **v0.2.0**（`0.2.0-rc.2`），或 CLI **`0.1.7-rc.2`** 及 0.1.x 全线——见 §7.1 |
| Cordis | `~4.0.4`（`@deepseek-ai/cordis`）——两条线相同 |
| Schemastery | `~3.18.4`（`@deepseek-ai/schemastery`）——两条线相同 |
| 审批通道 | `@deepseek-ai/dsh-user-approval`。可选，但没有它审批层无处发问，会失败即拒绝，因此除非应用在白名单里，否则什么都驱动不了 |

### 7.9 应用里显示的名字

插件页、组合包与插件行的详情页、以及设置里的插件清单，都会**按当前界面语言**渲染插件的标题与描述。
Host 对两个字段各自独立回退：

| 字段 | 回退顺序 |
|---|---|
| 标题 | `locale/<语言>.json` → `meta.title` → `package.json` 的 `name` → Cordis 模块全名 |
| 描述 | `locale/<语言>.json` → `meta.description` → `package.json` 的 `description` → 无描述 |

所以没有 locale 文件的插件，只能以 npm 包名露面——这正是没加之前应用里显示
`turtle-plugin-dsh-computer-use`、而不是产品名的原因。本插件两种语言都随包提供：

```json
// locale/en.json
{ "meta": { "title": "TurtlePlugin-DSH_ComputerUSE", "description": "Computer Use for DeepSeek Harness: …" } }
```

```json
// locale/zh.json
{ "meta": { "title": "DSH操纵电脑（TurtlePlugin）", "description": "DeepSeek Harness 的 Computer Use 能力：…" } }
```

它们通过 `./locale/*.json` 导出、并列在 `files` 里，这就是 Host 需要的全部：它经由导出映射解析
`<包名>/locale/en.json` 并读取 JSON，**不会为此激活插件**。把应用在中文与英文之间切换，卡片上的
名字随之变化。

`npm run check` 会断言这两个文件、两个标题、两者确实不同，以及导出映射能解析出
`<包名>/locale/<语言>.json`——因此打包出错会让检查失败，而不是悄悄退化成包名。

**两个名字，两份文档。** GitHub 仓库首页展示的是 `README.md`，标题是英文产品名；中文文档是
[`README.zh.md`](README.zh.md)，标题为 **DSH操纵电脑（TurtlePlugin）**，并在英文文档第一行有链接。
而在应用内部，看到哪个名字由上表决定。

---

## 8. 验证

五条命令，各自证明不同的事情。它们都不需要正在运行的 harness。

```powershell
npm run typecheck
```

用真实的 `@deepseek-ai/*` 类型定义对 `src/` 做类型检查，证明插件仍能对声明的 peer 版本编译通过。

```powershell
npm run build
```

先用 `tsc` 产出 `lib/`，再用系统自带的 .NET Framework 编译器把 `native/src/*.cs` 编译为
`lib/native/TurtleComputerUse.exe`，并写出 `lib/native/TurtleComputerUse.build.json`
（名称、版本、构建时间、SHA-256、大小、编译器路径、源文件清单）。在没有 C# 编译器的机器上，
原生步骤会带警告跳过；插件仍可安装，并在首次使用时编译驱动。

```powershell
npm run check
```

加载检查：**69 项检查**，针对 mock 的 Cordis 上下文运行。它从 schemastery schema 读出真实默认值、
挂载插件、注册六个工具、校验工具名与参数 schema、对每个工具的三种 payload 形态驱动 `output.render`、
跑一遍沙盒策略表（`normalizeAppId`、shell、UAC、允许清单、拒绝清单、只观察）、执行生命周期 disposer，
并用构建戳记核对已构建的驱动。**它对桌面没有任何影响**——不枚举窗口，不注入输入。

```powershell
npm run smoke
```

用**真实**驱动跑**真实**线协议，只读：握手、`ping`、`status`、`capabilities`、`policy.explain`、
`apps.list`、`windows.list`、一次无障碍快照，以及针对刚检查过的那个窗口的三次结构化拒绝
（`app_denied`、`app_not_approved`、`read_only`）。加 `--capture` 还会截取一张窗口图像并写到
`%TEMP%\turtle-computer-use-smoke\`。不点击、不输入、不启动任何东西。

```powershell
node scripts/e2e-act.mjs --yes
```

**这一条会真的动你的桌面。** 它把真实插件挂到 harness 替身上，启动**字符映射表**（经典多实例 Win32 程序，
因此每次运行相互隔离），用快照返回的元素索引向其中的 `Edit` 控件输入一段标记文本，等待该文本出现在无障碍树中，
检查截图已作为附件送达、系统授权与应用审批提示都弹过并被记住、落在已批准窗口之外的坐标被拒绝
（`point_outside_target`）、纯坐标点击被拒绝（`no_target`）、shell 在任何接触之前就被拒绝、
只观察模式拒绝注入——共 **22 项检查**——最后关掉它自己启动的进程，并等到该应用真的从桌面消失才退出。

`--yes` 是必需的；没有它，脚本只打印它将要做什么然后退出。`--app=<exe>` 可以更换目标。

两条刻意的安全性质：

* **目标已经打开时它会拒绝运行。** 记事本是最顺手的测试目标，也是最糟糕的一个：Windows 11 记事本是打包应用、
  **单实例**、且会恢复上次的标签页——在它已经打开时启动，只会往**你的**文档里加一个标签页，
  之后所有动作都会落到那里。因此目标已打开时会以退出码 3 中止，而不是接管你的窗口。
* **它不会把应用留在桌面上。** 清理用绝对路径调用 `%SystemRoot%\System32\taskkill.exe`
  （`taskkill` 并非在所有环境都在 `PATH` 上，而静默失败会让进程残留、让下一次运行直接中止），
  然后等到目标确实消失才退出。

---

## 9. 已知限制

逐条直说，因为每一条都曾让某个 computer-use 实现栽过跟头：

* **最小化的窗口没有像素。** 对最小化窗口请求截图会以 `window_minimized` 失败。先还原窗口，或者只观察无障碍树
  （`captureMode: "tree"`，或驱动的 `ax` 截图模式）。
* **硬件合成界面会返回黑帧。** 通过 DirectComposition、WinUI 3 或其他 GPU 界面绘制的窗口会让 `PrintWindow`
  得到空白结果。驱动会检测到这一点，回退为屏幕区域的 `BitBlt` 拷贝，并标记 `covered: true` 且附注说明：
  该图可能包含压在它上面的其他窗口，而且驱动无法告诉你具体是哪一个。几乎全黑的区域也会以同样方式报告。
* **Chromium、Electron 与 UWP 内容会忽略合成窗口消息。** 对这些窗口类，驱动会以 `background_unavailable`
  拒绝后台坐标输入并说明原因；该动作需要 `dispatch: "foreground"`（或在你接受升级的前提下用 `auto`）。
  某些 UWP 界面会接受一部分合成消息、丢掉另一部分，这正是该拒绝是无条件而非尽力而为的原因。
* **无障碍树有时为空或具有误导性。** 自绘和纯 GPU 界面暴露不出有用信息。渲染出的树会明确说明这一点，
  并建议改用截图或坐标；画布与图表应当使用 `captureMode: "both"`。
* **无障碍提供程序卡死时不会阻塞 harness。** 第三方 UIA 提供程序允许卡死。`requestTimeoutMs`（默认 20 秒）
  为每个请求设界；超时后驱动被结束，并在下次调用时重启，调用方收到 `driver_timeout` 并知道是哪个方法卡住了——
  而不是整个会话冻结。
* **没有 UIAccess。** 驱动的清单是 `asInvoker` 加 `uiAccess="false"`，因此无法绕过前台锁定。把窗口提到前台可能被拒绝
  （`activation_failed`）；此时动作会失败，而不是点到恰好压在上面的那个窗口上。
* **Session 0 与 SSH 登录没有桌面。** 以服务方式启动、由服务启动、或通过 SSH 登录启动的 harness 看不到真实窗口；
  驱动回答 `session_0`，且 `status` 会给出 `interactiveSession: false`。请从已登录的桌面启动 DeepSeek Harness。
* **锁屏会表现得像一堆互不相关的故障。** 桌面锁定时，前台激活、剪贴板与 `SendInput` 会同时失败。
  所有针对窗口的读取与写入都会以 `desktop_locked` 被拒绝——唯一还能用的是整屏截图——
  因此驱动只报告这一个根因，而不是一堆互不相关的错误。解锁后重试。
* **基于剪贴板的粘贴是可见的。** `paste_text` 会替换剪贴板内容。
* **在你允许的前提下，屏幕内容会被采集。** `allowScreenshots: false` 会移除该能力；只要它是开的，
  被采集窗口内可见的任何东西——包括在 `covered: true` 回退路径中压在其上的其他窗口——都会进入模型的上下文。
  见 [docs/security.md](docs/security.md)。

---

## 10. 故障排查

每一次拒绝都是结构化的：稳定的 `code`、写给模型看的 `message`，通常还有 `detail` 对象。最可能遇到的代码：

| 代码 | 含义 | 该怎么办 |
|---|---|---|
| `desktop_locked` | 交互式桌面被锁定或已切换走。锁定时前台激活、剪贴板与 `SendInput` 全部失败，所有针对窗口的读取与写入都被拒绝，只有整屏截图仍可用。 | 解锁桌面后重试。锁定时不要反复重试输入类动作。 |
| `target_elevated` | 目标窗口属于提权进程，而驱动不是。UIPI 会丢弃输入。 | 以管理员身份运行 DeepSeek Harness、设置 `allowElevatedTargets: true`，或者这一步由你自己来做。 |
| `app_denied` | 拒绝清单、硬编码 shell 清单或硬编码安全界面清单拒绝了该应用。 | 若是你的 `deniedApps`，删掉该条目。若是 shell 或 UAC/凭据/锁屏/regedit 清单，无法解除——请改用 shell 工具或自己操作。 |
| `app_not_approved` | 宿主没有为这次变更类动作放行该应用。 | 同意审批提示、把应用加入 `allowedApps`，或用 `computer_use_status` 查看账本。 |
| `read_only` | `readOnly` 已开启，因此不允许任何点击、按键或启动。 | 确实需要控制时，在 **设置 → 插件** 里关闭 `readOnly`。 |
| `background_unavailable` | 目标必须占用前台才能驱动（Chromium/UWP 内容、拖拽，或不升级的策略）。 | 用 `dispatch: "foreground"` 重发同一动作，或设 `computerUse.dispatch = "foreground"`，或请用户自己完成。 |
| `point_outside_target` | 坐标落在沙盒批准的窗口之外。 | 用 `computer_use_state` 重新观察并改为寻址元素，或发送窗口内的坐标。 |
| `window_minimized` | 对最小化窗口请求了截图，而它没有像素。 | 还原窗口，或改用 `captureMode: "tree"`。 |
| `rate_limited` | 每分钟动作预算（`maxActionsPerMinute`，默认 240）已用尽。 | 等滚动窗口过去，或有意提高该上限。 |
| `driver_missing` | 找不到 `TurtleComputerUse.exe`：没有 `driverPath`、没有随包副本、没有缓存构建，且编译失败或 `autoBuildDriver` 关闭。 | 运行 `npm run build:native`、设置 `driverPath`，或打开 `autoBuildDriver: true` 并查看 `%LOCALAPPDATA%\TurtlePlugin-DSH_ComputerUse\driver.log`。 |
| `driver_timeout` | 驱动在 `requestTimeoutMs` 内没有应答；它已被结束，并会在下次调用时重启。通常是目标应用里的无障碍提供程序卡死。 | 重试一次（会启动新的驱动进程），然后查看驱动日志；如果总是同一个应用复现，就避免驱动该应用。 |
| `activation_failed` | 无法把窗口提到前台：桌面被锁定，或有其他进程占着前台。 | 解锁桌面后重试，或改用后台下发。 |
| `clipboard_failed` | 多次尝试后仍无法写入剪贴板——桌面被锁定，或有进程占着剪贴板。 | 解锁桌面、关闭占用剪贴板的程序，或用 `type` 代替 `paste_text`。 |
| `no_target` | 动作没有指向任何应用：既无 `appId`、`hwnd`、`element`，或指定的窗口已不存在。 | 运行 `computer_use_apps`，再传有效的 `appId`（或最近一次 `computer_use_state` 给出的 `element`）。 |

驱动或宿主还可能返回：`no_snapshot`、`stale_element`、`no_uia_element`、`pattern_unavailable`、
`pattern_failed`、`read_only_element`、`window_empty`、`input_rejected`、`launch_failed`、
`no_accessibility_tree`、`capture_failed`、`unknown_app`、`unknown_method`、`bad_request`、
`invalid_request`、`parse_error`、`session_0`、`driver_error`（以上来自驱动），以及
`app_not_allowlisted`、`driver_exited`、`driver_stopped`、`approval_rejected`、`approval_cancelled`、
`approval_unavailable`、`approval_failed`（以上来自宿主）。完整清单及产生每个错误的请求见
[docs/driver-protocol.md](docs/driver-protocol.md)。

---

## 11. 仓库结构

| 路径 | 内容 |
|---|---|
| `src/` | Cordis 插件：配置 schema、六个工具、两道控制层、渲染、驱动传输。 |
| `src/driver/protocol.ts` | 与驱动共享的线协议类型；不导入任何 harness 包，因此浏览器打包也能复用。 |
| `native/src/*.cs` | 驱动：RPC 循环、策略、窗口枚举与截图、无障碍、输入、剪贴板、合成光标。 |
| `native/build.ps1` | `npm run build`、`plugin add` 与 `autoBuildDriver` 共用的 C# 5 构建脚本。 |
| `native/app.manifest` | `asInvoker`、`uiAccess="false"`、per-monitor-v2 DPI 感知、长路径感知。 |
| `scripts/` | `build.mjs`、`load-check.mjs`、`smoke-driver.mjs`、`e2e-act.mjs`。 |
| `cordis.patch.yml` | loader patch：一个条目，`id: computer-use`，`name: turtle-plugin-dsh-computer-use`。 |
| `docs/` | 架构、安全、API 参考、驱动协议。 |

延伸阅读：

* [docs/architecture.md](docs/architecture.md) —— 宿主插件、驱动与两道控制层如何拼在一起。
* [docs/security.md](docs/security.md) —— 威胁模型，以及确切的保证与边界。
* [docs/api.md](docs/api.md) —— 每个工具的全部参数。
* [docs/driver-protocol.md](docs/driver-protocol.md) —— NDJSON JSON-RPC 契约。
* [native/README.md](native/README.md) —— C# 驱动的结构、为什么用 C# 5、以及如何构建。

---

## 12. 许可证

[Apache License 2.0](LICENSE)。

Copyright the TurtlePlugin-DSH_ComputerUSE contributors. Licensed under the Apache License,
Version 2.0 (the "License"); you may not use this file except in compliance with the License.
You may obtain a copy of the License at

<http://www.apache.org/licenses/LICENSE-2.0>

Unless required by applicable law or agreed to in writing, software distributed under the License
is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied. See the License for the specific language governing permissions and limitations under the
License.

贡献者：

* `Owen_WWX <owen620293@outlook.com>`
* `turtlelnc <turtlelnc@outlook.com>`
* `Owen_WWX的Deepseek Harness <turtleqqmail@qq.com>`
* `turtlea001 <turtlea001@gmail.com>`
