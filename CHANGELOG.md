# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。正式版本的构建产物和完整说明同时发布到 GitHub Releases。

## [0.1.0] - 2026-08-08

首个正式版本，提供可在 Endstone Bedrock 服务器上运行的完整实时网页地图链路。

### 地图与交互

- 在 Endstone 主线程采样已加载区块，并在后台生成 `z4..z-8` PNG 瓦片金字塔。
- 支持方块放置、破坏、流体和爆炸后的增量刷新，以及区块指纹去重和渲染回压。
- 支持实时玩家、玩家头像、公开领地、坐标 HUD、桌面端和移动端布局。
- 优化拖动、缩放、出生点定位、瓦片缓存和单瓦片实时刷新。

### 服务与存储

- 提供本地 Node HTTP/WebSocket 服务、压缩响应、ETag、有界缓存和缺图抑制。
- 支持本地原子写入与可选 Cloudflare R2/Worker 镜像。
- 提供瓦片金字塔修复、旧 PNG 优化、R2 清理和安全 NAS 安装流程。

### 发布与兼容性

- 目标 Endstone API 为 `0.11.6`，正式插件面向 Linux x86_64。
- Web、Node 和 Worker 要求 Node.js 22 或更高版本。
- 将受影响的传递依赖 `nanoid` 更新到 `3.3.18`，发布审计结果为 0 个已知漏洞。
- GitHub Release 提供完整部署包、独立 `.so` 插件和 SHA-256 校验文件。

[0.1.0]: https://github.com/wingxia/endstone-live-map/releases/tag/v0.1.0
