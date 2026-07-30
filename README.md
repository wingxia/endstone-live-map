# endstone-live-map

Endstone Bedrock 服务器实时网页地图。当前版本把地图渲染迁回服务器本地：C++ 插件采样已加载区块，在后台线程生成 PNG 瓦片，前端/API 由服务器本地 Node 服务提供，Cloudflare R2 只用于可选的远端瓦片镜像。

## 这个插件有什么用

- 在网页上显示服务器地图，支持缩放、拖动、坐标 HUD 和移动端布局。
- 实时显示在线玩家位置。
- 保留公开领地显示：领地列表搜索、矩形/点位覆盖、传送点标记、点击聚焦、按维度过滤。
- 在服务器本地生成 `z4` 基础瓦片；每批更新会先写完全部 `z4`，再按层去重生成 `z3..z-8` 父瓦片。
- PNG 使用逐行自适应过滤和 zlib 快速压缩；从旧版本升级时，插件会在后台利用现有 `.rgba` 缓存一次性重压缩历史瓦片，无需重新采样世界区块。
- 插件启动和配置重载时会扫描现有 `z4` 金字塔并自动补齐缺失缩放层，调整 `tile_min_zoom` 不需要重新采样历史区块。
- 本地 Node 服务首次升级时从实际存在的 `z4` 文件建立世界边界和区块数量，随后使用紧凑、原子写入的 `world-index-v1.json`；重启不再全盘扫描，瓦片上报也不再反复重写巨大的 `state.json`。
- Node 服务为版本化 PNG 瓦片提供有界内存 LRU，并对缺失瓦片做短时抑制，拖动和缩放时不会反复触发 NAS 小文件读取；首屏 JS/CSS 自动按客户端能力使用 Brotli 或 Gzip。
- 前端只在世界元数据和瓦片版本就绪后发起地图请求，交互期间按固定间隔渐进加载；地图 HUD、控件和标记不使用会在每一帧触发重栅格化的背景模糊。
- 配置的默认世界不存在时，前端会自动选择当前维度最近更新的可用世界。
- 高频玩家快照成功日志按玩家数变化或每分钟记录，后台日志达到 8 MiB 时保留一个轮转备份。
- 每 60 秒扫描在线玩家附近已加载区块；对应区域已有完整本地瓦片且区块指纹未变时跳过，玩家改动会进入脏区块缓存并强制重采样。
- 可选把生成完成的 PNG 瓦片直接上传到 Cloudflare R2，键格式为 `map-tiles/v2/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.png`。
- Worker 现在只保留可选边缘能力：健康检查、从 R2 读取公开瓦片、受 token 保护的清理接口。

## 安装需要什么

- Minecraft Bedrock + Endstone 服务器。
- Linux 服务器请使用 GitHub Actions 构建出的插件 `.so`；不要把 macOS 本地 `.dylib` 放到 Linux 服。
- C++ 插件默认针对 Endstone 0.11.6 API 构建。
- 本地构建 C++ 插件或 core 测试需要 zlib 开发包（Debian/Ubuntu 为 `zlib1g-dev`）。
- Node.js 22 或更高版本，用来运行本地前端/API 服务。
- 一个本地插件 token：`LIVE_MAP_PLUGIN_TOKEN`，Node 服务和插件配置里必须一致。
- 可选 Cloudflare R2：
  - R2 bucket。
  - R2 S3 endpoint，例如 `https://<account-id>.r2.cloudflarestorage.com`。
  - 环境变量 `LIVE_MAP_R2_ACCESS_KEY_ID`。
  - 环境变量 `LIVE_MAP_R2_SECRET_ACCESS_KEY`。
- 可选 Cloudflare Worker：只在需要公网边缘读取 R2 瓦片或远程清理 R2 时部署。

## 快速安装

1. 安装 JS 依赖：

```bash
npm ci
```

2. 构建前端、Node 服务和 Worker：

```bash
npm run build
```

3. 在服务器本地启动 Node 服务：

```bash
LIVE_MAP_DATA_DIR=/path/to/endstone/plugins/endstone_live_map/map-data \
LIVE_MAP_PLUGIN_TOKEN=replace-with-local-token \
LIVE_MAP_HOST=127.0.0.1 \
LIVE_MAP_PORT=8000 \
npm run server
```

4. 安装 C++ 插件，并把 [plugin/config/live_map.json.example](plugin/config/live_map.json.example) 放到插件数据目录为 `live_map.json`。至少设置：

```json
{
  "local_server_url": "http://127.0.0.1:8000",
  "plugin_token": "replace-with-local-token",
  "server_id": "your-server-id",
  "tile_data_dir": "map-data",
  "tile_min_zoom": -8,
  "tile_max_zoom": 4,
  "render_worker_threads": 2,
  "player_seed_interval_seconds": 60,
  "max_seed_chunks_per_pulse": 4,
  "dirty_block_push_seconds": 60,
  "upload_chunks": true,
  "upload_players": true,
  "upload_lands": true
}
```

5. 重启服务器。玩家附近已加载区块会每分钟逐步采样并生成瓦片；已渲染且区块指纹未变的区块不会重复写图，玩家方块改动会在 60 秒脏区块缓存 flush 后强制重采样。管理员也可以手动触发：

```text
/livemap render-chunk <chunkX> <chunkZ>
/livemap render-near [radius]
/livemap render-area <minX> <minZ> <maxX> <maxZ>
/livemap repair-pyramid
/livemap status
/livemap reload
```

## R2 配置

R2 是可选项。不开 R2 时，地图仍能通过本地 Node 服务访问。

插件配置：

```json
{
  "r2_enabled": true,
  "r2_endpoint": "https://<account-id>.r2.cloudflarestorage.com",
  "r2_bucket": "endstone-live-map-tiles",
  "r2_region": "auto",
  "r2_key_prefix": "map-tiles/v2",
  "r2_max_concurrent_uploads": 1,
  "r2_max_uploads_per_minute": 60,
  "r2_retry_count": 3,
  "r2_retry_backoff_ms": 1000
}
```

插件进程环境变量：

```bash
export LIVE_MAP_R2_ACCESS_KEY_ID=...
export LIVE_MAP_R2_SECRET_ACCESS_KEY=...
```

插件只上传已经写好的 PNG 瓦片，不再上传区块 JSON、方块更新 JSON、region 数据或纹理 atlas。R2 镜像写入由 `r2_max_uploads_per_minute` 限速，避免公网对象存储写入过快。

## R2 清理

清理脚本默认 dry-run，并保留 `lands/v1/` 和 `markers/v1/`：

```bash
LIVE_MAP_R2_ACCESS_KEY_ID=... \
LIVE_MAP_R2_SECRET_ACCESS_KEY=... \
npm run cleanup:r2 -- \
  --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket endstone-live-map-tiles
```

确认删除旧地图数据：

```bash
LIVE_MAP_R2_ACCESS_KEY_ID=... \
LIVE_MAP_R2_SECRET_ACCESS_KEY=... \
npm run cleanup:r2 -- \
  --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket endstone-live-map-tiles \
  --confirm delete-map-data-v2
```

默认只删除旧 `map-tiles/v1/`、旧 chunk/block/region 数据、旧 dirty/backfill 队列、旧 texture atlas 和旧 meta。`lands/v1/`、`markers/v1/` 和新的 `map-tiles/v2/` PNG 瓦片会被保护。

## 本地 API

Node 服务默认监听 `127.0.0.1:8000`，环境变量：

- `LIVE_MAP_DATA_DIR`：插件共享数据目录，默认 `plugin-data/live_map`。
- `LIVE_MAP_PLUGIN_TOKEN`：保护插件写入接口。
- `LIVE_MAP_HOST`：默认 `127.0.0.1`。
- `LIVE_MAP_PORT`：默认 `8000`。
- `LIVE_MAP_TILE_CACHE_MAX_BYTES`：PNG 瓦片内存缓存上限，默认 64 MiB；设为 `0` 可关闭。
- `LIVE_MAP_TILE_CACHE_MAX_ENTRIES`：瓦片与缺图缓存条目上限，默认 4096。
- `LIVE_MAP_TILE_CACHE_FRESH_MS`：无版本瓦片再次检查磁盘前的保鲜时间，默认 1000 ms。
- `LIVE_MAP_MISSING_TILE_CACHE_MS`：缺失瓦片磁盘探测抑制时间，默认 750 ms。
- `LIVE_MAP_STATIC_CACHE_MAX_BYTES`：静态资源及其压缩表示的内存缓存上限，默认 16 MiB。
- `LIVE_MAP_STATIC_CACHE_MAX_ENTRIES`：静态资源缓存条目上限，默认 128。

公开接口：

- `GET /api/health`
- `GET /api/config`
- `GET /api/worlds`
- `GET /api/lands?world=<world>&dimension=<dimension>`
- `GET /api/players`
- `GET /api/local-map-tiles/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.png`
- `GET /api/live` WebSocket

地图瓦片是可变资源：本地服务和 Worker 会返回需要重新验证的缓存头，缺失瓦片占位图不会缓存。前端收到 `tiles_ready` 后会带版本参数刷新可见瓦片并重新读取 `/api/worlds`。

插件写入接口：

- `POST /api/plugin/live`
- `POST /api/plugin/lands`
- `POST /api/plugin/tiles`

## 文件结构

```text
plugin/   C++20 Endstone 插件；采样区块、渲染 PNG、生成低缩放瓦片、上传 R2、推送玩家/领地事件
server/   本地 Node 服务；托管 web/dist、读取本地瓦片、提供 API 和 WebSocket
web/      React + Leaflet 前端；只使用图片瓦片，不再拉取 chunk JSON 或纹理 atlas
worker/   可选 Cloudflare Worker；R2 瓦片 GET、health、受保护清理接口
scripts/  R2 清理、Cloudflare/NAS 运维辅助脚本
shared/   前端共享方块颜色 helper
```

## 开发和测试

```bash
npm run test -w server
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

## 致谢

地图渲染架构参考 [MipaSenpai/MipMap](https://github.com/MipaSenpai/MipMap)（`main` at `c309987`，MIT License）：本项目借鉴其“本地采样地表、生成基础瓦片、从高缩放派生低缩放”的思路。没有复制 MipMap 或 Minecraft 的贴图资产。
