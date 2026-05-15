# endstone-live-map

[中文](#中文) | [English](#english)

Realtime 2D web map for Endstone Bedrock servers.

Live demo: [map.buhe.li](https://map.buhe.li)

## 中文

`endstone-live-map` 是给 Endstone Bedrock 服务器使用的实时 2D 网页地图。它由服务器插件、Cloudflare Worker API 和 React 前端组成：插件从服务器内采样区块、玩家和领地信息，Worker 负责鉴权、存储和实时接口，前端把这些数据渲染成可浏览的地图。

### 功能简介

- 实时显示在线玩家位置，并独立于地形刷新。
- 玩家在线时自动采样附近区块，作为地图的主要数据来源。
- 方块变化按列增量上传，减少全量重扫和无效请求。
- 支持读取领地插件 JSON，把可公开传送的领地作为地图标记展示。
- 使用 Cloudflare R2 保存区块快照和纹理图集，使用 Durable Object 推送实时状态。
- 保留 Worker 侧 MySQL/Hyperdrive 标记接口，便于后续恢复自定义标记功能。

### 使用前需要准备

- 一个可运行 Endstone 的 Minecraft Bedrock 服务器。
- Node.js 22 或更高版本。
- Cloudflare 账号，以及 Worker、R2、Durable Object、Hyperdrive 的部署权限。
- 一个只给插件和 Worker 共用的 `PLUGIN_TOKEN`。
- GitHub Actions 部署所需的 secrets：
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `PLUGIN_TOKEN`
  - 可选：`MARKER_WRITE_TOKEN`
- GitHub repository variable：
  - `CLOUDFLARE_HYPERDRIVE_ID`
- Bedrock 原版资源包或服务器资源包，用来生成地图纹理图集。

### 如何使用

1. 安装依赖：

```bash
npm ci
```

2. 准备 Cloudflare 资源。可以参考 [scripts/cloudflare-bootstrap.md](scripts/cloudflare-bootstrap.md)，或运行手动 provision workflow 创建 R2、DNS 和 Hyperdrive。

3. 构建并上传纹理图集：

```bash
npm run textures:atlas -- --input /path/to/vanilla_resource_pack --input /path/to/server_override_pack --output /tmp/livemap-textures
npm run textures:upload -- --input /tmp/livemap-textures --worker-url https://map.buhe.li --token "$PLUGIN_TOKEN"
```

4. 部署 Worker：

```bash
npm run build
npm run deploy -w worker
```

也可以使用 GitHub Actions 里的 `deploy-worker` 手动 workflow 部署生产环境。

5. 构建 Endstone 插件。Linux 服务器推荐使用 GitHub Actions 生成的 `.so` artifact；不要把本机 macOS `.dylib` 当作 Linux 插件上传。

6. 安装插件并创建配置。把 [plugin/config/live_map.json.example](plugin/config/live_map.json.example) 复制到服务器插件数据目录，保存为 `live_map.json`，至少设置：

```json
{
  "worker_url": "https://map.buhe.li",
  "plugin_token": "replace-with-shared-token",
  "server_id": "your-server-id",
  "upload_chunks": true,
  "upload_players": true,
  "upload_lands": true
}
```

7. 重启服务器后，等待玩家在线触发区块采样，或由管理员在游戏内执行：

```text
/livemap render-near
/livemap render-chunk <chunkX> <chunkZ>
```

### 本地开发和测试

```bash
npm run test -w worker
npm run test -w web
npm run typecheck
npm run build
```

C++ core 测试：

```bash
cmake -S plugin -B plugin/build-core -GNinja -DLIVE_MAP_WITH_ENDSTONE=OFF
cmake --build plugin/build-core
ctest --test-dir plugin/build-core --output-on-failure
```

### 目录结构

```text
.github/   GitHub Actions CI、Worker 部署和 Cloudflare 初始化 workflow
infra/     数据库初始化脚本，目前包含 MySQL marker schema
plugin/    C++20 Endstone 插件，负责采样区块、玩家、领地并上传到 Worker
scripts/   Cloudflare 初始化、NAS 安装、纹理图集生成和上传脚本
web/       React + Leaflet 前端地图
worker/    Cloudflare Worker API、R2 存储访问、Durable Object 实时房间
```

### 贡献

欢迎大佬提 PR。建议 PR 里说明改动范围、验证方式，以及是否影响插件协议、Worker API、R2 数据格式或前端渲染逻辑。

提交前建议至少运行：

```bash
npm test
npm run typecheck
npm run build
```

如果改到 C++ 插件核心逻辑，也请运行 C++ core 测试。

### 致谢

感谢 [MipaSenpai/MipMap](https://github.com/MipaSenpai/MipMap) 项目提供参考和启发。

## English

`endstone-live-map` is a realtime 2D web map for Endstone Bedrock servers. It is split into an Endstone plugin, a Cloudflare Worker API, and a React frontend. The plugin samples terrain, players, and land claims from the server; the Worker handles authentication, storage, and realtime APIs; the frontend renders the browser map.

### Features

- Shows online players in near realtime.
- Seeds map chunks around online players as the primary terrain data path.
- Uploads dirty block columns incrementally instead of rescanning the whole world.
- Reads land-claim JSON and displays publicly teleportable claims as map markers.
- Stores chunk snapshots and the texture atlas in Cloudflare R2.
- Uses a Durable Object for live state fanout.
- Keeps the Worker-side MySQL/Hyperdrive marker API available for future marker UI work.

### Requirements

- A Minecraft Bedrock server running Endstone.
- Node.js 22 or newer.
- A Cloudflare account with permission to deploy Workers, R2, Durable Objects, and Hyperdrive.
- A shared `PLUGIN_TOKEN` used only between the plugin and Worker.
- GitHub Actions secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `PLUGIN_TOKEN`
  - Optional: `MARKER_WRITE_TOKEN`
- GitHub repository variable:
  - `CLOUDFLARE_HYPERDRIVE_ID`
- A Bedrock vanilla resource pack or server resource pack for generating the texture atlas.

### Usage

1. Install dependencies:

```bash
npm ci
```

2. Prepare Cloudflare resources. See [scripts/cloudflare-bootstrap.md](scripts/cloudflare-bootstrap.md), or run the manual provision workflow in GitHub Actions.

3. Build and upload the texture atlas:

```bash
npm run textures:atlas -- --input /path/to/vanilla_resource_pack --input /path/to/server_override_pack --output /tmp/livemap-textures
npm run textures:upload -- --input /tmp/livemap-textures --worker-url https://map.buhe.li --token "$PLUGIN_TOKEN"
```

4. Deploy the Worker:

```bash
npm run build
npm run deploy -w worker
```

Production deployments can also use the manual `deploy-worker` GitHub Actions workflow.

5. Build the Endstone plugin. For Linux servers, use the `.so` artifact built by GitHub Actions. Do not deploy a local macOS `.dylib` to a Linux server.

6. Install the plugin and create its config. Copy [plugin/config/live_map.json.example](plugin/config/live_map.json.example) into the plugin data directory as `live_map.json`, then set at least:

```json
{
  "worker_url": "https://map.buhe.li",
  "plugin_token": "replace-with-shared-token",
  "server_id": "your-server-id",
  "upload_chunks": true,
  "upload_players": true,
  "upload_lands": true
}
```

7. Restart the server. Map data will appear as players load nearby chunks. Operators can force sampling with:

```text
/livemap render-near
/livemap render-chunk <chunkX> <chunkZ>
```

### Development

```bash
npm run test -w worker
npm run test -w web
npm run typecheck
npm run build
```

C++ core tests:

```bash
cmake -S plugin -B plugin/build-core -GNinja -DLIVE_MAP_WITH_ENDSTONE=OFF
cmake --build plugin/build-core
ctest --test-dir plugin/build-core --output-on-failure
```

### Repository Layout

```text
.github/   GitHub Actions workflows for CI, Worker deploys, and Cloudflare provisioning
infra/     Infrastructure schemas, currently the MySQL marker schema
plugin/    C++20 Endstone plugin that samples chunks, players, and land claims
scripts/   Cloudflare setup, NAS install, texture atlas build, and texture upload scripts
web/       React + Leaflet browser map
worker/    Cloudflare Worker API, R2 access, and Durable Object live room
```

### Contributing

PRs are welcome. Please describe the change scope, how it was tested, and whether it affects the plugin protocol, Worker API, R2 data format, or frontend rendering.

Before opening a PR, run:

```bash
npm test
npm run typecheck
npm run build
```

If the C++ plugin core changes, run the C++ core tests too.

### Credits

Thanks to [MipaSenpai/MipMap](https://github.com/MipaSenpai/MipMap) for reference and inspiration.
