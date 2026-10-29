# cloud-stream-web

[`cloud-stream`](https://github.com/cocosoys/cloud-stream) 的**浏览器前端**：打开页面就能看到
被控机的桌面，键盘、鼠标、触屏、剪贴板、文件上传全部走浏览器原生能力，不需要装客户端。

这个仓库源自 [Selkies](https://github.com/selkies-project/selkies) 的 webclient，
保留了完整的上游 `addons/`，在此之上把流客户端改造成对接 `cloud-stream` 服务端的信令契约
（VP8 + 两条 DataChannel，`/api/<app>/signaling/`）。

## 两个真正在用的包

| 目录 | 角色 | 技术栈 |
|---|---|---|
| `addons/selkies-web-core/` | 流客户端本体：信令、WebRTC 解码、输入采集、剪贴板、文件上传、统计浮层 | 纯 ES module + Vite，无框架 |
| `addons/selkies-dashboard/` | 页面外壳：侧边栏、设置面板、文件管理器，把 core 挂到 DOM 上 | React 19 + Vite |

其余 `addons/`（`base` `desktop` `coder` `coturn` `turn-rest` `ondemand` `fake-udev`
`*-interposer` `universal-touch-gamepad` `selkies-dashboard-wish`）是上游的 Linux 侧组件，
Windows 串流用不到，保留只为跟随上游。

```
addons/selkies-web-core/lib/
  signaling.js        线协议：HELLO / session / SDP / ICE / PongReply
  webrtc.js           RTCPeerConnection 装配、track、DataChannel
  decode-gate.js      首帧门控：拿到 IDR 之前不往 canvas 上贴
  input.js            键鼠/触屏/手柄事件 → kd/ku/kh/... 消息（60+ 处注册的唯一收口）
  touch-controls.js   虚拟摇杆与触屏手势
  clipboard-sync.js   剪贴板双向同步（文本 + 二进制图片）
  file-upload.js      POST /api/upload 与 /api/files 目录浏览
  stats-hud.js        右上角统计浮层，F3 收起、F4 麦克风开关
  listener-surface.js 浏览器侧监听面的鉴权插桩（window.selkiesSurface，14 个面）
  selkies-core.js     入口：装配上面所有模块并挂到 window
```

## 构建

前置：Node.js 20+（`vite` 8 需要），npm。

**顺序不能反**：`dashboard` 的 `prebuild` 会把 `core` 的构建产物拷进 `src/`，
core 没先构建就会直接报错退出（这是故意的，避免产出一个看着完整、打开却在浏览器里失败的 dist）。

```bash
# 1. 核心
npm --prefix addons/selkies-web-core install
npm --prefix addons/selkies-web-core run build      # → addons/selkies-web-core/dist/selkies-core.js

# 2. 页面外壳
npm --prefix addons/selkies-dashboard install
npm --prefix addons/selkies-dashboard run build     # → addons/selkies-dashboard/dist/
```

产出 `addons/selkies-dashboard/dist/` 就是服务端 `--dist` 指向的目录：
`index.html` + `assets/` + `jsdb/`（手柄映射库，按 VID/PID 分近 2000 个文件）+ `codecs/`。

开发时用 Vite dev server：

```bash
npm --prefix addons/selkies-dashboard run dev
```

## 与服务端的契约

| 端点 / 消息 | 用途 |
|---|---|
| `WS /api/<app>/signaling/` | 信令：`HELLO`、会话请求、offer/answer、ICE 候选 |
| `GET /api/status` | 服务端状态（分辨率、帧率、编码器、版本） |
| `GET /api/files/{rel}` | 目录列表 / 文件下载，根在服务端 `--upload-dir` |
| `POST /api/upload` | 原始 octet-stream 上传，目标路径在 URL 参数里 |
| `kd` `ku` `kh` `kr` | 键盘按下 / 抬起 / 组合 / 重复 |
| `m` `p` | 鼠标移动 / 按键 |
| `vp` `sf` `js` | 滚轮 / 单指触屏 / 手柄 |
| `cb` `cbs` `cbd` `cbe` | 剪贴板读、读回、写、结束（文本与二进制共用一套） |

完整线协议见服务端仓库的 [`docs/stage1-signaling-session.md`](https://github.com/cocosoys/cloud-stream/blob/main/docs/stage1-signaling-session.md)。

## 快捷键

| 键 | 作用 |
|---|---|
| `F3` | 显示 / 隐藏右上角统计浮层（也可以点右边缘那条粉色把手） |
| `F4` | 麦克风开关 |

## 监听面与鉴权

所有浏览器侧事件（键盘、指针、触屏、手柄、滚轮、剪贴板、麦克风、摄像头、文件上传、
生命周期）都经过 `lib/listener-surface.js` 的 `admit()` 单一收口，可在运行时注入裁决函数：

```js
window.selkiesSurface.setInterceptor((surface, detail) =>
    surface === 'input.keyboard' ? 'deny' : true);
```

未注入拦截器时全部放行（默认行为）。这是给上层项目（例如 WebGame）做站点级鉴权用的骨架，
服务端对应的插桩点见 `cloud-stream` 仓库的 `docs/listener-surface.md`。

## 说明

- 仓库里只保留源码与配置，`node_modules/`、`dist/`、`.env*` 均不入库。
- `addons/selkies-web-core/selkies-ws-core.js` 等几个 `selkies-*-core.js` 是历史遗留的单文件
  构建，当前构建链路走 `lib/` + `selkies-core.js`。
