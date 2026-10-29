# 品牌替换范围（WebGame）

目标：页面上看不到上游项目名与图形，只保留本项目的名称和图标；上游的贡献只在
[`CREDITS.md`](../CREDITS.md) 里致谢。本文记录**改了哪些、还要哪些、哪些不能改**。

判定口径：**用户能看见的才改，内部标识符一律不动**。改内部标识符的收益只有
"全仓 grep 干净"，代价是同时改后端契约、部署脚本和已部署机器上的目录。

## 1 已改（本次提交）

| 位置 | 改动 | 效果 |
|---|---|---|
| `selkies-dashboard/src/components/Sidebar.jsx` | 删掉内联 SVG 的 `SelkiesLogo`（viewBox 460×460，单条 path），换成 `BrandLogo` | 顶栏图标改由 `public/brand/logo.svg` 提供；文件不存在时不渲染，不出破图 |
| 同上 | `uiTitle` 默认值 `'Selkies'` → `'WebGame'` | 顶栏文字 |
| 同上 | 删掉包住图标和标题的两个 `<a href="https://github.com/selkies-project/selkies">` | 标题不再是外链，点了不会跳到上游 |
| `selkies-dashboard/index.html` | `<title>` → `WebGame` | 浏览器标签 |
| `selkies-web-core/index.html` | `<title>` → `WebGame` | core 的开发页 |
| `selkies-dashboard/public/manifest.json` | `name` / `short_name` → `WebGame` | PWA 安装后的应用名 |
| `selkies-web-core/lib/page-title.js` | 兜底 `document.title` → `WebGame` | manifest 解析前的标签名 |
| `selkies-dashboard/src/translations.js` | 删 19 条 `selkiesLogoAlt` | 组件删掉后这些键已无引用 |
| `selkies-web-core/lib/mode-switch.js` | prompt 文案去掉 "Selkies" | 切流模式要令牌时不再提上游 |
| `selkies-core.js` / `selkies-ws-core.js` / `selkies-wr-core.js` | 20 处 `console.*` 前缀 `[Selkies]` / `Selkies: ` → `[WebGame]` / `WebGame: ` | 控制台里不再出现上游名 |

验证（构建产物，不含源码）：

```
dist/assets/index-<hash>.js        Selkies=0   WebGame=1
dist/assets/selkies-core-<hash>.js Selkies=1   WebGame=21
dist/index.html                    <title>WebGame</title>
dist/manifest.json                 "name": "WebGame"
```

core 里剩下的那 1 处 `Selkies` 是 `auth-guard.js:105` 的正则（见 §3）。

## 2 需要你提供图形

| 文件 | 用在哪 | 规格 |
|---|---|---|
| `selkies-dashboard/public/brand/logo.svg` | 顶栏（30×30 显示） | SVG，方形 viewBox 最稳；深色/浅色两套主题下都要看得清 |
| `selkies-dashboard/public/icon.png` | favicon（`index.html:20`） | 建议 64×64 或 128×128 PNG |
| `selkies-dashboard/public/icon-512.png` | PWA 图标 + apple-touch-icon | 512×512 PNG |

放好之后重新 `npm --prefix addons/selkies-dashboard run build` 即可，代码不用改。
`public/selkies.svg` 目前没有任何引用（`index.html` 用的是 `icon.png`），可以直接删。

还有一处**配色**跟着旧 logo 走：`src/styles/Overlay.css:30-31,115-116` 的
`--wordmark-from` / `--wordmark-to`（深色主题 `#f4a6cf→#c3b1f7`，浅色 `#b93a82→#7b52b0`），
顶栏 "WebGame" 这几个字用的就是这条渐变。图标定了再一起调。

## 3 不能改（内部标识符与契约）

| 项 | 位置 | 为什么不能动 |
|---|---|---|
| `/^Bearer realm="Selkies/i` | `selkies-web-core/lib/auth-guard.js:105` | 匹配反向代理回给浏览器的 `WWW-Authenticate` realm。改了就在上游反代前面失效（当前部署没用到，但那是部署方决定的事） |
| `assets/selkies-core-<hash>.js` | core 的 vite entry 名 | `cloud-stream/toolchain/deploy.ps1:359` 用它判断"线上这份到底是不是 dashboard 构建"，改名要同时改后端脚本 |
| `window.__SELKIES_*`、`selkiesCoreInitialize`、`selkiesSurface` | core 入口 | 仪表盘、监听面文档、后端文档都在按名字引用 |
| `localStorage` 键前缀 | core | 改了等于清空用户已保存的清晰度、码率、按键绑定 |
| DOM id `selkies-stats-hud` / `selkies-stats-panel` | `lib/stats-hud.js` | HUD 内部互相引用 |
| 目录名 / npm 包名 `selkies-web-core`、`selkies-dashboard` | 全仓 | 所有相对 import、`npm --prefix`、部署脚本路径都指着它 |
| `SELKIES_COMMAND_ENABLED` | `translations.js` 19 处文案 | 那是**服务端设置名**，不是品牌；改文案会让用户找不到该改哪个设置 |
| `SELKIES_*` 环境变量、`__SELKIES_STREAMING_MODE__` | core | 与配置约定同名 |

后端侧还有 `C:\dev\selkies-web`（部署机上的静态目录）与 `deploy-selkies-web.zip`，
属于**已经落在机器上的路径契约**，改名要动被控机目录 + `start-stream.cmd` 的 `--dist`，
不在本轮范围。

## 4 不进产物的地方（可以不管）

`addons/{base,desktop,coder,ondemand,v4l2-interposer,input-interposer,coturn,turn-rest,fake-udev,universal-touch-gamepad,selkies-dashboard-wish}`
里有约 109 处 `Selkies`，都在 Dockerfile、README、C 源码和另一个未被使用的仪表盘
（`selkies-dashboard-wish`）里。它们是 Linux 侧组件，**不会打进入浏览器的那份 dist**，
本项目的部署也不使用。真要清，等哪天要重命名目录时一起做。
