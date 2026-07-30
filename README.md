# endstone-live-map

Endstone Bedrock 服务器的实时网页地图。插件在游戏进程内采样已加载区块，在后台生成本地 PNG 瓦片；Node 服务负责网页、API、缓存和实时事件；React + Leaflet 前端只读取已经生成的图片瓦片。Cloudflare R2/Worker 是可选镜像，不是本地地图运行的前置条件。

项目默认生成 `z4` 到 `z-8` 共 13 个缩放级别，支持实时玩家、公开领地、坐标复制、桌面端和移动端布局。

## 功能

- 玩家附近的已加载区块会自动进入地图采样队列。
- 放置、破坏、流体流动和爆炸会标记脏区块，并触发强制重采样。
- 区块指纹没有变化且完整瓦片已经存在时，不会重复渲染。
- `z4` 基础瓦片生成后，按层派生 `z3..z-8` 父瓦片。
- PNG 使用逐行自适应过滤和 zlib 压缩；旧版未压缩 PNG 可在后台原地优化。
- 启动或执行修复命令时，会从 `.rgba` 数据补回缺失的基础 PNG 和父级金字塔。
- 在线玩家每秒更新；位置变化只移动现有 DOM 标记，不会每秒销毁并重建全部标记。
- 支持玩家头像、玩家列表、点击定位和离线清理。
- 支持公开领地列表、搜索、矩形/点位覆盖、传送点和点击定位。
- 页面支持 `z4..z-8` 任意缩放、拖动、返回初始视角、坐标 HUD 和移动端布局。
- 本地 Node 服务提供有界瓦片缓存、缺图抑制、Brotli/Gzip、ETag 和 WebSocket。
- 可选把最终 PNG 镜像到 Cloudflare R2，并通过 Worker 在边缘读取。

## 运行逻辑

```text
Endstone 主线程
  已加载区块 / 玩家附近 / 方块事件 / 管理员命令
                    │
                    ▼
        采样地表 + 计算区块指纹
                    │
          去重、合批、按区块冷却、回压
                    │
                    ▼
后台单 FIFO 渲染器（避免旧批次覆盖新批次）
  z4 RGBA/PNG ──► z3 ──► ... ──► z-8
                    │
        原子写入本地磁盘并通知 Node
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   Node 本地地图服务      可选 R2 镜像
  索引/缓存/API/WebSocket   PUT 或 DELETE
          │
          ▼
 React + Leaflet 浏览器
 稳定瓦片 URL + 单瓦片版本刷新
```

### 1. 地图内容获取

Endstone API 的世界读取只发生在游戏主线程，并且只采样已经加载的区块，不会让后台线程直接访问游戏对象。自动采样由以下来源触发：

- 玩家进入后的延迟采样；
- 玩家附近半径的周期扫描；
- 区块加载事件；
- 放置、破坏、流体和爆炸产生的脏区块；
- `/livemap render-*` 管理员命令。

采样结果包含每个方块列的最高可见方块、高度和调色板索引。相同区块只保留最新待处理快照；队列达到上限时会延迟重采样，不会静默丢失最新地图变化。

### 2. 合批、顺序与冷却

- `chunk_upload_flush_seconds`：第一个待处理区块出现后，等待这一小段时间进行合批。
- `chunk_upload_batch_size`：单批最多包含的区块数。
- `chunk_upload_cooldown_seconds`：一个区块成功提交后，再次写入该区块前的最短间隔。
- `max_pending_chunk_uploads`：内存中的最新区块快照上限。

flush 和 cooldown 是两件不同的事：首次渲染只等待 flush；cooldown 仅作用于刚刚成功提交过的同一坐标。渲染任务严格使用单个 FIFO worker，因为相邻区块会共同修改父瓦片，多 worker 即使加文件锁也不能保证新旧批次顺序。

### 3. 压缩与储存

每个图片瓦片为 `256 × 256`：

- `.rgba` 是增量派生父瓦片所需的像素缓存，每个完整文件为 256 KiB；
- `.png` 是唯一对用户提供的格式，使用 PNG 自适应过滤和 zlib 压缩；
- 文件先写临时文件，再原子替换目标，避免用户读到半张图；
- 没有任何有效像素的瓦片会删除本地 PNG/RGBA；启用 R2 时也会删除对应旧对象；
- `chunk_baselines.tsv` 保存已确认的区块指纹；
- `world-index-v1.json` 保存紧凑的世界边界和区块计数。

默认目录：

```text
plugins/live_map/
├── live_map.json
├── live_map.log
├── live_map.log.1
├── chunk_baselines.tsv
└── map-data/
    ├── .png-filter-zlib-v1
    ├── world-index-v1.json
    ├── avatars/
    ├── lands/
    └── tiles/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.{png,rgba}
```

不要通过网页提供 `.rgba` 文件。磁盘规划时应同时计算 PNG 和 RGBA；真正影响用户下载量的是 PNG 大小。

### 4. 用户访问、缩放与拖动

- HTML 首次响应直接嵌入世界元数据，地图不必先等待一次 `/api/worlds` 往返。
- 普通瓦片 URL 保持稳定并使用 ETag 重新验证，不会因为一个区块更新而让整张地图失去浏览器缓存。
- WebSocket 的 `tiles_ready` 只给变化瓦片增加版本参数，并同时携带最新世界元数据。
- 拖动过程中不发起新瓦片请求；拖动结束后再加载新视口。
- 缩放期间不边动画边解码新层；缩放落定后直接读取对应的预生成 PNG。
- 瓦片版本表、Node 瓦片缓存、缺图缓存、静态资源缓存和 WebSocket 发送缓冲都有上限。
- 玩家位置更新使用原位 `setLatLng`；头像或名字变化时才重建图标。

## 环境要求

- Minecraft Bedrock + Endstone。
- 插件目标 API：Endstone `0.11.6`。
- Linux x86_64；C++20、CMake 3.24+、Ninja、zlib 和 libcurl 开发包。
- 完整插件构建建议使用 Clang 20 + libc++，与 CI 保持一致。
- Node.js 22 或更高版本。
- 一个随机且保密的插件 token；Node 和插件配置必须完全一致。

Debian/Ubuntu 构建依赖示例：

```bash
sudo apt-get update
sudo apt-get install -y cmake ninja-build clang-20 libc++-20-dev libc++abi-20-dev \
  libcurl4-openssl-dev zlib1g-dev
```

## 构建

安装依赖并验证 Web、Node 和 Worker：

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run test:e2e
```

只构建和测试 C++ core：

```bash
cmake -S plugin -B plugin/build-core -GNinja -DLIVE_MAP_WITH_ENDSTONE=OFF
cmake --build plugin/build-core
ctest --test-dir plugin/build-core --output-on-failure
```

构建 Endstone Linux 插件：

```bash
cmake -S plugin -B plugin/build-endstone -GNinja \
  -DCMAKE_C_COMPILER=clang-20 \
  -DCMAKE_CXX_COMPILER=clang++-20 \
  -DCMAKE_CXX_FLAGS=-stdlib=libc++ \
  -DLIVE_MAP_WITH_ENDSTONE=ON \
  -DENDSTONE_API_VERSION=0.11.6
cmake --build plugin/build-endstone --target endstone_live_map
```

也可以直接下载 GitHub Actions 的 `endstone-live-map-plugin-linux-x86_64` 构建产物。Linux 服务器必须使用 `.so`，不能使用 macOS `.dylib`。

## 部署

### 1. 启动 Node 地图服务

先完成 `npm ci && npm run build`，然后配置：

```bash
export LIVE_MAP_DATA_DIR=/path/to/endstone/server/plugins/live_map/map-data
export LIVE_MAP_PLUGIN_TOKEN='replace-with-a-long-random-token'
export LIVE_MAP_HOST=127.0.0.1
export LIVE_MAP_PORT=8000
npm run server
```

生产启动时 `LIVE_MAP_PLUGIN_TOKEN` 是必填项。只有本地开发才可以显式设置：

```bash
LIVE_MAP_ALLOW_INSECURE_PLUGIN_WRITES=true npm run server
```

不要在公网生产环境使用这个绕过开关。

systemd 示例：

```ini
[Unit]
Description=Endstone Live Map
After=network-online.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/opt/endstone-live-map/current
EnvironmentFile=/etc/endstone-live-map.env
ExecStart=/usr/bin/node server/src/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

环境文件应设为 `0600`，并包含前述四个 `LIVE_MAP_*` 变量。推荐让 Nginx、Caddy 或 Cloudflare Tunnel 代理本地监听地址，同时保留 Node 返回的 `Cache-Control`、`ETag`、`Content-Encoding` 和 WebSocket Upgrade 头。

### 2. 安装插件

1. 停止对应的 Bedrock/Endstone 实例。
2. 备份现有 `plugins/endstone_live_map.so`。
3. 复制新 `.so`，权限通常为 `0755`。
4. 把 [plugin/config/live_map.json.example](plugin/config/live_map.json.example) 复制到 `plugins/live_map/live_map.json`。
5. 把配置文件权限设为 `0600`，因为其中包含 token。
6. 启动 Node 地图服务，再启动游戏实例。

仓库提供安全安装脚本。它要求明确的服务器根目录和环境变量 token，拒绝在该实例仍运行时替换插件，自动备份旧 `.so`、保留已有配置，而且不会擅自重启任何服务：

```bash
LIVE_MAP_SERVER_ROOT=/path/to/endstone/server \
LIVE_MAP_PLUGIN_TOKEN='replace-with-a-long-random-token' \
LIVE_MAP_LOCAL_SERVER_URL=http://127.0.0.1:8000 \
./scripts/nas-install.sh /path/to/endstone_live_map.so
```

首次安装且没有领地文件时，脚本默认生成 `upload_lands: false`；可以通过 `LIVE_MAP_UPLOAD_LANDS=true|false` 明确覆盖。

最小配置：

```json
{
  "local_server_url": "http://127.0.0.1:8000",
  "plugin_token": "replace-with-the-same-token",
  "server_id": "my-bedrock-server",
  "land_config_file": "/path/to/land/plugin/land.json",
  "tile_data_dir": "map-data",
  "dimensions": ["Overworld", "Nether", "TheEnd"],
  "tile_min_zoom": -8,
  "render_worker_threads": 1,
  "player_push_seconds": 1,
  "player_seed_radius_chunks": 4,
  "player_seed_join_delay_seconds": 10,
  "chunk_upload_batch_size": 8,
  "chunk_upload_flush_seconds": 10,
  "chunk_upload_cooldown_seconds": 60,
  "dirty_block_push_seconds": 60,
  "upload_chunks": true,
  "upload_dirty_blocks": true,
  "upload_players": true,
  "upload_lands": true
}
```

本地瓦片写入为顺序操作，`render_worker_threads` 请保持 `1`。如果服务器没有兼容的领地配置文件，请设置 `upload_lands: false`；缺失或损坏的领地源不会清空网页数据，而一个有效的空 JSON 对象 `{}` 会发布权威空快照并清除旧领地。

### 3. 升级与回滚

- 代码和 Web 资源应部署到新的版本目录，再原子切换 `current` 软链接。
- 插件 `.so` 只在游戏实例停止后替换。
- 不要删除 `plugins/live_map/map-data` 和 `chunk_baselines.tsv`。
- 保留上一版代码目录和 `.so` 备份；回滚时恢复两者并重启对应服务。
- 首次从旧版升级时，后台 PNG 优化和金字塔修复可能持续一段时间，但 Node 服务可以继续提供已经完整的瓦片。

## 插件命令

```text
/livemap status
/livemap render-chunk <chunkX> <chunkZ>
/livemap render-near [radius]
/livemap render-area <minX> <minZ> <maxX> <maxZ>
/livemap repair-pyramid
/livemap reload
```

- `status`：显示脏块、加载区块、种子队列、延迟队列、待渲染和后台任务数量。
- `render-chunk`：强制渲染主世界指定区块。
- `render-near`：强制渲染执行者附近的区块。
- `render-area`：按方块坐标批量加入渲染队列。
- `repair-pyramid`：补回缺失/损坏的基础 PNG 和父级缩放层，并优化旧 PNG。
- `reload`：重新读取配置并重建上传调度器。

## Node 环境变量

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `LIVE_MAP_DATA_DIR` | `plugin-data/live_map` | 插件与 Node 共用的数据目录 |
| `LIVE_MAP_PLUGIN_TOKEN` | 无 | 保护三个插件写入接口；生产必填 |
| `LIVE_MAP_HOST` | `127.0.0.1` | 监听地址 |
| `LIVE_MAP_PORT` | `8000` | HTTP/WebSocket 端口 |
| `LIVE_MAP_MAX_JSON_BODY_BYTES` | `8388608` | 插件 JSON 请求体上限 |
| `LIVE_MAP_WEBSOCKET_MAX_BUFFERED_BYTES` | `1048576` | 单个慢客户端发送缓冲上限 |
| `LIVE_MAP_TILE_CACHE_MAX_BYTES` | `67108864` | PNG 内存缓存上限 |
| `LIVE_MAP_TILE_CACHE_MAX_ENTRIES` | `4096` | 瓦片和缺图缓存条目上限 |
| `LIVE_MAP_TILE_CACHE_FRESH_MS` | `1000` | 无版本瓦片再次检查磁盘前的时间 |
| `LIVE_MAP_MISSING_TILE_CACHE_MS` | `750` | 缺图磁盘探测抑制时间 |
| `LIVE_MAP_STATIC_CACHE_MAX_BYTES` | `16777216` | 静态资源及压缩表示缓存上限 |
| `LIVE_MAP_STATIC_CACHE_MAX_ENTRIES` | `128` | 静态缓存条目上限 |

## API

公开读取：

```text
GET /api/health
GET /api/config
GET /api/worlds
GET /api/lands?world=<world>&dimension=<dimension>
GET /api/players
GET /api/players/<id>/avatar.png
GET /api/local-map-tiles/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.png
GET /api/live                         WebSocket
```

需要 token 的插件写入：

```text
POST /api/plugin/live
POST /api/plugin/lands
POST /api/plugin/tiles
```

未带版本的瓦片使用 ETag 重新验证；收到实时更新后，只有变化瓦片会使用不可变版本 URL。未带版本的缺图不缓存，已确认版本的缺图占位图可以长期缓存，从而避免视口反复请求同一空白位置。

## 可选 Cloudflare R2 / Worker

不开 R2 时，本地地图功能完整。启用后，插件在本地文件和 Node 通知成功之后镜像最终 PNG：

```json
{
  "r2_enabled": true,
  "r2_endpoint": "https://<account-id>.r2.cloudflarestorage.com",
  "r2_bucket": "endstone-live-map-tiles",
  "r2_region": "auto",
  "r2_key_prefix": "map-tiles/v2",
  "r2_max_uploads_per_minute": 60,
  "r2_retry_count": 3,
  "r2_retry_backoff_ms": 1000
}
```

凭据只放在游戏进程环境变量中：

```bash
export LIVE_MAP_R2_ACCESS_KEY_ID=...
export LIVE_MAP_R2_SECRET_ACCESS_KEY=...
```

R2 键格式：

```text
map-tiles/v2/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.png
```

本地提交成功而可选 R2 镜像失败时，插件会记录明确警告，但不会让本地网页回滚。空瓦片会向 R2 发送 DELETE，避免旧地图残留。

旧数据清理默认是 dry-run：

```bash
LIVE_MAP_R2_ACCESS_KEY_ID=... \
LIVE_MAP_R2_SECRET_ACCESS_KEY=... \
npm run cleanup:r2 -- \
  --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket endstone-live-map-tiles
```

确认后才会执行删除：

```bash
LIVE_MAP_R2_ACCESS_KEY_ID=... \
LIVE_MAP_R2_SECRET_ACCESS_KEY=... \
npm run cleanup:r2 -- \
  --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket endstone-live-map-tiles \
  --confirm delete-map-data-v2
```

清理范围受到白名单限制；`lands/v1/`、`markers/v1/` 和当前 `map-tiles/v2/` 不会被这个命令误删。

## 性能验收

发布前至少执行：

```bash
npm ci
npm audit
npm test
npm run typecheck
npm run build
npm run test:e2e
ctest --test-dir plugin/build-core --output-on-failure
```

浏览器验收应覆盖：

- 首屏只请求 PNG 瓦片，不请求旧 chunk JSON 或纹理 atlas；
- `z4、z3、…、z-8` 每一级都能加载完整图片；
- 拖动按下期间不产生新瓦片请求，释放后加载新视口；
- 单个 `tiles_ready` 不会让未变化瓦片更换 URL；
- 玩家每秒更新时标记 DOM 保持不变；
- 桌面端和 390 px 移动端 HUD 不遮挡主要地图。

线上排查加载慢时，先对比本地源站和公网的首字节时间，再检查：

1. 浏览器拿到的是 `.png`，不是 `.rgba`；
2. PNG 不是固定约 256 KiB 的未压缩旧文件；
3. `map-data/.png-filter-zlib-v1` 已生成；
4. 静态 JS/CSS 返回 Brotli 或 Gzip；
5. 反向代理没有覆盖 ETag 和 Cache-Control；
6. 公网域名实际指向了当前 Node 服务和当前 `LIVE_MAP_DATA_DIR`。

## 项目结构

```text
plugin/   C++20 Endstone 插件：采样、去重、渲染、金字塔、玩家/领地、可选 R2
server/   Node 服务：静态网页、本地瓦片、索引、缓存、API、WebSocket
web/      React + Leaflet：图片瓦片、玩家、领地、桌面/移动交互
worker/   可选 Cloudflare Worker：R2 瓦片读取、健康检查、受保护清理
scripts/  NAS 安装、R2 清理和 Cloudflare 运维说明
shared/   前端与渲染相关的共享方块颜色数据
```

## 致谢 MipMap

地图渲染架构参考了 [MipaSenpai/MipMap](https://github.com/MipaSenpai/MipMap) 的思路：在服务器本地采样地表、生成基础瓦片，再从高缩放层派生低缩放层。感谢 MipMap 作者公开项目和设计经验。

本项目没有复制 MipMap 或 Minecraft 的贴图资产；地图像素由本插件自己的方块颜色映射生成。MipMap 使用 MIT License，本项目也以仓库中的 [MIT License](LICENSE) 发布。
