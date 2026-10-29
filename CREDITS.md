# 致谢

本仓库的浏览器端流客户端**源自以下开源项目**，在此表示感谢。界面上的品牌标识已全部替换为
本项目自己的名称与图标，但代码里的技术选择、协议实现与大量边界处理仍然来自它们。

## Selkies

- 项目：[selkies-project/selkies](https://github.com/selkies-project/selkies)
- 用途：本仓库 `addons/` 下的 webclient 基线（`selkies-web-core` 的信令、解码、输入、
  剪贴板、文件传输等模块均由它演化而来），以及 `selkies-dashboard` 的页面外壳。
- 协议：多数文件头部保留 MPL-2.0 声明。这部分代码的许可与归属不因品牌替换而改变。

我们做的是改造而非重写：把流客户端接到 `cloud-stream` 服务端的 VP8 + DataChannel 信令契约上，
并补了自己需要的东西（秒级关键帧、统计浮层、监听面鉴权骨架、长按重复键等）。
品牌层（图标、名称、页面标题）保持与本项目一致，不再展示上游名称。

## 其他

| 项目 | 用途 |
|---|---|
| [SDL_GameControllerDB](https://github.com/mdqinc/SDL_GameControllerDB) | `jsdb/` 手柄映射库，构建时按固定 commit 拉取 |
| [libopus-wasm](https://www.npmjs.com/package/libopus-wasm) | 浏览器端 Opus 解码 |
| [RustDesk](https://github.com/rustdesk/rustdesk) | 服务端仓库 `vendor/hbb_common` 的来源（见后端仓库） |

如果发现某个文件的归属标注遗漏，请提 issue 指出，我们会补上。
