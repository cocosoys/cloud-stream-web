# 指针坐标：唯一真相与禁区

指针打偏是本项目**复发率最高**的缺陷。它每次的根因都不是"算错了一个数"，而是
"用了不该用的那套公式"，而且偏得很安静 —— 画面正常、点击也响应，只是落点短一截。
本文记下坐标系的分层、这次的根因、以及**后来者不许动的地方**。

## 1 三层坐标系（按正确性排序）

| 层 | 位置 | 它知道什么 | 何时可信 |
|---|---|---|---|
| **A 画面实体** | `_sinkBox()` | 画布缓冲区（服务端像素）+ 画布屏幕矩形（CSS 像素） | **总是**。它就是在屏幕上显示的那些像素 |
| B 窗口推导 | `_windowMath()` | overlay 的矩形和 `offsetWidth`，乘 dpr | 仅当 overlay 恰好等于 `流像素 / dpr` |
| C 密度 | `_inputDpr()` / `streamDensity()` | 每 CSS 像素多少服务端像素 | 由 A/B 决定用途，自己不能当尺寸用 |

A 与 B 只要一致就没有问题；不一致时，**A 对 B 错**，因为 B 依赖一个没人保证的
等式（`overlay 尺寸 == 流尺寸 / dpr`）。

## 2 本次根因（#118）

### 2.1 用标志位决定用哪套公式

```js
// 修改前 —— 靠四个布尔量决定要不要相信画面实体
const sink = ((measureCursor || window.manual_resolution || this.isSharedMode ||
               window.streamResolutionDiverged) && canvas) ? canvas : ...
```

四个标志量分布在两条传输（ws / wr）、共享模式、手动分辨率、分辨率分歧四条路径上，
**任何一条漏置位**，映射就静默回落到 B 层。而 B 层只在 1:1 时正确，于是：

- 画面被拉伸/压缩（窗口不是 16:9、侧栏展开、面板改了画布样式）→ 落点按比例短一截；
- 症状表现成"整体错开一截"，用户描述为"指针偏了"，看着像固定偏移，其实是比例；
- **两种传输、两种模式全偏**，因为 `input.js` 是共享的，只有 `_sinkBox` 的门禁不同；
- 刷新页面后标志量复位，同一台机器上时好时坏，于是被当成"偶发"。

修法：**取消门禁**。谁有缓冲区、谁有矩形，谁就是真相；`manual_*` /
`isSharedMode` / `streamResolutionDiverged` 不再参与选择。见 `_sinkBox()` 开头注释。

### 2.2 幽灵指针乘反了方向

```js
// 修改前
this._ghostX += serverX * scale.x;   // scale = 服务端像素 / CSS 像素
// 修改后
this._ghostX += serverX / scale.x;
```

线上增量（`_relativeToServer()` 的返回值）是**服务端像素**，幽灵指针累加的是
**CSS 像素**，一个服务端像素只覆盖 `1 / scale` 个 CSS 像素。乘上去等于让幽灵指针
以 `scale²` 的速度跑：1:1 时看不出来（1²=1），画面一缩放就冲出去。

这一处历史上被从**两个相反方向**各修过一次：

- `068cb92 fix(input): 游戏模式指针比手慢 11% —— 相对增量漏了画面缩放`
- `351a92c Revert "…"`（同一处，因为对游戏来说是相机灵敏度，不该跟随窗口大小）

结论：**线上增量保持 1:1 不缩放**（#74，游戏灵敏度不随窗口变），**幽灵指针按屏幕
表现累加**（除以 scale）。两者不冲突，别再"顺手统一"。

## 3 禁区（违反其中任意一条，本节开头的缺陷就会回来）

1. **不许在 `_sinkBox()` 里加回任何模式判断**（`manual_resolution`、
   `manualResolution`、`isSharedMode`、`streamResolutionDiverged`、`measureCursor`）。
   有缓冲区有矩形就量它。
2. **不许用 `element.offsetWidth` 当流尺寸**。它是布局整数、含 border/padding，
   且和流像素没有必然关系。要流尺寸就看画布缓冲区或 `videoWidth`。
3. **不许把 `_windowMath()` 当默认路径**。它只是"没有任何表面可量"时的兜底。
   要修偏移，去查是谁把画布/overlay 的尺寸弄错了，不要在 `_windowMath()` 里凑常数。
4. **不许把 `_pointerScale()` 用在相对增量上**（`_relativeToServer()` 必须直通）。
   它服务绝对坐标；用在锁定路径上会得到随窗口变化的灵敏度。
5. **不许在 `_ghostMove()` 里改回乘法**，也不许给它加 gain —— 它的唯一职责是把
   宿主已经收到的增量按屏幕表现画出来。
6. **新增渲染面（worker canvas、离屏图层等）必须同时**：加进 `_sinkBox()` 的
   `mirrorId` 列表、在尺寸变化时调用 `syncSinkToCanvasStyle()`，否则坐标会指向旧尺寸。

## 4 复发时的排查顺序（三步定位）

1. 打开控制台，找这一行：
   ```
   [selkies] pointer mapping skew: … sink=… scale=… window=… overlay=… dpr=…
   ```
   有它 → `_reportMappingSkew()` 已经确认两套公式不等价，**错误量、两个盒子、
   overlay 尺寸、dpr 全在行里**，直接按行里的 `overlay` 和 `sink` 反查是谁改的样式。
2. 没有这行 → 偏移不在坐标映射，去看采集侧（`displays:` 日志）与服务端
   `TargetSpace`（多显示器 origin / `MOUSEEVENTF_VIRTUALDESK`）。
3. 只有游戏模式偏 → 是幽灵指针，看 `_ghostMove()` 与 `_pointerScale()`，不是绝对坐标。

## 5 验证

- 1:1：窗口与流同尺寸，点击画面四角，落点即指针；
- 缩放：把浏览器窗口拉到明显不是 16:9，再点四角，落点仍是指针；
- HiDPI：系统缩放 125%/150% 各点一次四角；
- 游戏模式：锁定后小幅画圈，幽灵指针不应逐渐跑赢或跑输真实指针；
- 控制台**不应**出现 `pointer mapping skew`。出现了就是上游样式又漂了，按第 4 节查。
