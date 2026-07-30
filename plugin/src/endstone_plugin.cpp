#include "livemap/base64.hpp"
#include "livemap/baseline.hpp"
#include "livemap/chunk.hpp"
#include "livemap/land.hpp"
#include "livemap/map_blocks.hpp"
#include "livemap/png.hpp"
#include "livemap/protocol.hpp"
#include "livemap/r2_client.hpp"
#include "livemap/settings.hpp"
#include "livemap/sha256.hpp"
#include "livemap/tile_math.hpp"
#include "livemap/tile_renderer.hpp"
#include "livemap/upload_queue.hpp"

#include <endstone/endstone.hpp>
#include <endstone/event/chunk/chunk_load_event.h>
#include <endstone/event/chunk/chunk_unload_event.h>

#include <atomic>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <variant>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace livemap {
TransportResult postPluginJson(const LiveMapSettings &settings, std::string_view path, std::string_view json);
}  // namespace livemap

namespace {

std::int64_t nowMs()
{
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

struct ColumnTop {
    std::string block = "minecraft:air";
    int height = -64;
    livemap::BlockStateMap state;
};

struct ColumnSample {
    ColumnTop surface;
    ColumnTop overlay;
};

struct QueuedSeed {
    livemap::ChunkCoord coord;
    std::int64_t not_before_ms{};
    bool force{};
};

struct ChunkUploadMeta {
    livemap::ChunkCoord coord;
    std::uint64_t fingerprint{};
    std::int64_t updated_at_ms{};
};

struct PendingChunkUpload {
    livemap::ChunkSnapshot snapshot;
    ChunkUploadMeta meta;
    std::int64_t queued_at_ms{};
    std::int64_t ready_at_ms{};
};

enum class PendingChunkQueueResult {
    Queued,
    Skipped,
    Backpressured,
};

struct EncodedAvatar {
    std::string hash;
    std::string png_base64;
};

struct PlayerAvatarAck {
    std::string player_id;
    std::string hash;
};

constexpr std::int64_t kChunkBatchRetryMinDelayMs = 30000;
constexpr std::int64_t kChunkBatchRetryMaxDelayMs = 300000;
constexpr std::int64_t kPlayerSuccessLogIntervalMs = 60000;

std::string chunkName(const livemap::ChunkCoord &coord)
{
    return coord.world + "/" + coord.dimension + "/" + std::to_string(coord.x) + "/" + std::to_string(coord.z);
}

std::string responseSnippet(const std::string &body)
{
    constexpr std::size_t kMaxSnippetLength = 256;
    if (body.empty()) {
        return "<empty>";
    }
    std::string snippet;
    snippet.reserve(std::min(body.size(), kMaxSnippetLength));
    for (const auto ch : body) {
        if (snippet.size() >= kMaxSnippetLength) {
            snippet += "...";
            break;
        }
        snippet.push_back(std::isspace(static_cast<unsigned char>(ch)) ? ' ' : ch);
    }
    return snippet;
}

livemap::ChunkCoord chunkCoordForSnapshot(const livemap::ChunkSnapshot &snapshot)
{
    return {snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z};
}

livemap::BlockStateMap blockStateMapFromEndstone(const endstone::BlockStates &states)
{
    livemap::BlockStateMap normalized;
    for (const auto &[key, value] : states) {
        const std::string state_key = key;
        std::visit(
            [&normalized, &state_key](const auto &item) {
                using Item = std::decay_t<decltype(item)>;
                if constexpr (std::is_same_v<Item, bool>) {
                    normalized[state_key] = item;
                }
                else if constexpr (std::is_same_v<Item, int>) {
                    normalized[state_key] = item;
                }
                else {
                    normalized[state_key] = item;
                }
            },
            value);
    }
    return normalized;
}

livemap::BlockStateMap blockStatesForBlock(const endstone::Block &block)
{
    const auto data = block.getData();
    if (data == nullptr) {
        return {};
    }
    return blockStateMapFromEndstone(data->getBlockStates());
}

std::optional<EncodedAvatar> encodePlayerAvatar(const endstone::Player &player)
{
    try {
        const auto skin = player.getSkin();
        const auto &skin_image = skin.getImage();
        if (skin_image.getWidth() < 16 || skin_image.getHeight() < 16) {
            return std::nullopt;
        }

        constexpr int kHeadSourceX = 8;
        constexpr int kHeadSourceY = 8;
        constexpr int kHatSourceX = 40;
        constexpr int kHatSourceY = 8;
        constexpr int kFaceSize = 8;
        constexpr int kAvatarSize = 32;
        constexpr int kScale = kAvatarSize / kFaceSize;

        auto avatar = livemap::makeRgbaImage(kAvatarSize, kAvatarSize);
        for (int y = 0; y < kAvatarSize; ++y) {
            for (int x = 0; x < kAvatarSize; ++x) {
                const int source_x = kHeadSourceX + x / kScale;
                const int source_y = kHeadSourceY + y / kScale;
                auto color = skin_image.getColor(source_x, source_y);

                const bool has_hat_layer = skin_image.getWidth() >= kHatSourceX + kFaceSize &&
                                           skin_image.getHeight() >= kHatSourceY + kFaceSize;
                if (has_hat_layer) {
                    const auto hat = skin_image.getColor(kHatSourceX + x / kScale, kHatSourceY + y / kScale);
                    const auto alpha = hat.getAlpha();
                    if (alpha > 0) {
                        color = hat;
                    }
                }

                const auto offset = (static_cast<std::size_t>(y) * static_cast<std::size_t>(kAvatarSize) +
                                     static_cast<std::size_t>(x)) *
                                    4;
                avatar.pixels[offset] = static_cast<std::uint8_t>(color.getRed());
                avatar.pixels[offset + 1] = static_cast<std::uint8_t>(color.getGreen());
                avatar.pixels[offset + 2] = static_cast<std::uint8_t>(color.getBlue());
                avatar.pixels[offset + 3] = static_cast<std::uint8_t>(color.getAlpha());
            }
        }

        const auto png = livemap::encodePngRgba(avatar);
        return EncodedAvatar{livemap::hexLower(livemap::sha256(png)),
                             livemap::base64Encode(std::span<const std::uint8_t>(png.data(), png.size()))};
    }
    catch (...) {
        return std::nullopt;
    }
}

struct UploadJob {
    enum class Kind {
        PlayerSnapshot,
        ChunkBatch,
        Lands,
        TilePyramidRepair,
    };

    Kind kind{};
    std::string path;
    std::string json;
    std::vector<ChunkUploadMeta> chunks;
    std::vector<livemap::ChunkSnapshot> snapshots;
    std::size_t update_count{};
    std::vector<livemap::ChunkCoord> resample_after_success_chunks;
    std::int64_t queued_at_ms{};
};

struct UploadResult {
    UploadJob::Kind kind{};
    std::vector<ChunkUploadMeta> chunks;
    std::vector<livemap::ChunkSnapshot> snapshots;
    std::size_t update_count{};
    std::vector<livemap::ChunkCoord> resample_after_success_chunks;
    std::int64_t queued_at_ms{};
    std::int64_t started_at_ms{};
    std::int64_t finished_at_ms{};
    livemap::TransportResult transport;
    std::vector<PlayerAvatarAck> player_avatar_acks;
};

class BackgroundLog {
public:
    bool open(const std::filesystem::path &path, std::string *error = nullptr)
    {
        try {
            std::scoped_lock lock(mutex_);
            path_ = path;
            std::filesystem::create_directories(path.parent_path());
            std::error_code size_error;
            bytes_written_ = std::filesystem::file_size(path, size_error);
            if (size_error) {
                bytes_written_ = 0;
            }
            out_.open(path, std::ios::app);
            if (!out_) {
                if (error != nullptr) {
                    *error = "failed to open background log";
                }
                return false;
            }
            return true;
        }
        catch (const std::exception &exception) {
            if (error != nullptr) {
                *error = exception.what();
            }
            return false;
        }
        catch (...) {
            if (error != nullptr) {
                *error = "unknown error";
            }
            return false;
        }
    }

    void close()
    {
        std::scoped_lock lock(mutex_);
        out_.close();
    }

    template <typename... Values>
    void info(const Values &...values)
    {
        write("INFO", values...);
    }

    template <typename... Values>
    void warning(const Values &...values)
    {
        write("WARN", values...);
    }

private:
    template <typename... Values>
    void write(std::string_view level, const Values &...values)
    {
        std::scoped_lock lock(mutex_);
        if (!out_) {
            return;
        }
        std::ostringstream line;
        line << nowMs() << '\t' << level << '\t';
        (line << ... << values);
        line << '\n';
        const auto text = line.str();
        if (bytes_written_ > 0 && bytes_written_ + text.size() > kMaxBytes) {
            rotateLocked();
        }
        if (!out_) {
            return;
        }
        out_ << text;
        out_.flush();
        bytes_written_ += text.size();
    }

    void rotateLocked()
    {
        out_.close();
        auto backup_path = path_;
        backup_path += ".1";
        std::error_code remove_error;
        std::filesystem::remove(backup_path, remove_error);
        std::error_code rename_error;
        std::filesystem::rename(path_, backup_path, rename_error);
        if (rename_error) {
            std::error_code size_error;
            bytes_written_ = std::filesystem::file_size(path_, size_error);
            if (size_error) {
                bytes_written_ = 0;
            }
            out_.open(path_, std::ios::app);
            return;
        }
        out_.open(path_, std::ios::out | std::ios::trunc);
        bytes_written_ = 0;
    }

    static constexpr std::uintmax_t kMaxBytes = 8U * 1024U * 1024U;
    std::mutex mutex_;
    std::filesystem::path path_;
    std::ofstream out_;
    std::uintmax_t bytes_written_ = 0;
};

class UploadDispatcher {
public:
    UploadDispatcher(livemap::LiveMapSettings settings, std::size_t max_queue_size)
        : settings_(std::move(settings)), max_queue_size_(std::max<std::size_t>(1, max_queue_size))
    {
        // Tile batches can touch the same base and parent files. A single FIFO
        // dispatcher worker makes local render + notification order deterministic
        // and prevents an older batch from overwriting a newer batch.
        workers_.reserve(worker_count_);
        for (std::size_t i = 0; i < worker_count_; ++i) {
            workers_.emplace_back([this] { workerLoop(); });
        }
    }

    ~UploadDispatcher()
    {
        stop();
    }

    UploadDispatcher(const UploadDispatcher &) = delete;
    UploadDispatcher &operator=(const UploadDispatcher &) = delete;

    bool enqueue(UploadJob job)
    {
        const auto priority = priorityFor(job.kind);
        job.queued_at_ms = nowMs();
        {
            std::scoped_lock lock(mutex_);
            if (stopping_ || jobs_.size() >= max_queue_size_) {
                return false;
            }
            jobs_.push(std::move(job), priority, max_queue_size_);
        }
        cv_.notify_one();
        return true;
    }

    std::vector<UploadResult> drainResults()
    {
        std::scoped_lock lock(mutex_);
        std::vector<UploadResult> results;
        results.reserve(results_.size());
        while (!results_.empty()) {
            results.push_back(std::move(results_.front()));
            results_.pop_front();
        }
        return results;
    }

    [[nodiscard]] std::size_t pendingJobs() const
    {
        std::scoped_lock lock(mutex_);
        return jobs_.size();
    }

    void stop()
    {
        {
            std::scoped_lock lock(mutex_);
            if (stopping_) {
                return;
            }
            stopping_ = true;
            jobs_.clear();
        }
        cv_.notify_all();
        for (auto &worker : workers_) {
            if (worker.joinable()) {
                worker.join();
            }
        }
    }

private:
    void workerLoop()
    {
        while (true) {
            UploadJob job;
            {
                std::unique_lock lock(mutex_);
                cv_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
                if (stopping_ && jobs_.empty()) {
                    return;
                }
                auto next = jobs_.pop();
                if (!next.has_value()) {
                    continue;
                }
                job = std::move(*next);
            }

            const auto started_at_ms = nowMs();
            auto transport = performJob(job);
            const auto finished_at_ms = nowMs();
            {
                std::scoped_lock lock(mutex_);
                results_.push_back({job.kind, std::move(job.chunks), std::move(job.snapshots), job.update_count,
                                    std::move(job.resample_after_success_chunks), job.queued_at_ms, started_at_ms,
                                    finished_at_ms, std::move(transport)});
            }
        }
    }

    livemap::TransportResult performJob(const UploadJob &job) const
    {
        if (job.kind == UploadJob::Kind::TilePyramidRepair) {
            auto repair = livemap::repairMissingTilePyramid(settings_);
            if (!repair.ok) {
                return {.ok = false,
                        .error = repair.error.empty() ? "tile pyramid repair failed" : repair.error};
            }

            if (repair.tiles.empty()) {
                return {.ok = true,
                        .body = "{\"repairedTiles\":0,\"optimizedPngTiles\":" +
                                std::to_string(repair.optimized_png_tiles) +
                                ",\"r2MirrorOk\":true,\"r2Uploaded\":0,\"r2Deleted\":0}"};
            }
            auto notify = livemap::postPluginJson(settings_, "/api/plugin/tiles",
                                                   livemap::serializeTilesReady(repair));
            if (!notify.ok) {
                return notify;
            }
            const auto r2 = livemap::uploadRenderedTilesToR2(settings_, repair.tiles);
            notify.body = "{\"repairedTiles\":" + std::to_string(repair.tiles.size()) +
                           ",\"optimizedPngTiles\":" + std::to_string(repair.optimized_png_tiles) +
                           ",\"r2MirrorOk\":" + (r2.ok ? "true" : "false") +
                           ",\"r2Uploaded\":" + std::to_string(r2.uploaded) +
                           ",\"r2Deleted\":" + std::to_string(r2.deleted);
            if (!r2.ok) {
                notify.body += ",\"r2MirrorError\":\"" +
                               livemap::jsonEscape(r2.error.empty() ? "repaired tile R2 upload failed" : r2.error) +
                               "\"";
            }
            notify.body += "}";
            return notify;
        }
        if (job.kind != UploadJob::Kind::ChunkBatch) {
            return livemap::postPluginJson(settings_, job.path, job.json);
        }

        auto render = livemap::renderChunkSnapshotsToTiles(settings_, job.snapshots);
        if (!render.ok) {
            return {.ok = false, .error = render.error.empty() ? "tile render failed" : render.error};
        }

        auto notify = livemap::postPluginJson(settings_, "/api/plugin/tiles", livemap::serializeTilesReady(render));
        if (!notify.ok) {
            return notify;
        }
        const auto r2 = livemap::uploadRenderedTilesToR2(settings_, render.tiles);
        notify.body = "{\"renderedTiles\":" + std::to_string(render.tiles.size()) +
                      ",\"r2MirrorOk\":" + (r2.ok ? "true" : "false") +
                      ",\"r2Uploaded\":" + std::to_string(r2.uploaded) +
                      ",\"r2Deleted\":" + std::to_string(r2.deleted);
        if (!r2.ok) {
            notify.body += ",\"r2MirrorError\":\"" +
                           livemap::jsonEscape(r2.error.empty() ? "R2 upload failed" : r2.error) + "\"";
        }
        notify.body += "}";
        return notify;
    }

    [[nodiscard]] static livemap::UploadPriority priorityFor(UploadJob::Kind kind)
    {
        switch (kind) {
        case UploadJob::Kind::ChunkBatch:
            return livemap::UploadPriority::Normal;
        case UploadJob::Kind::Lands:
            return livemap::UploadPriority::Low;
        case UploadJob::Kind::PlayerSnapshot:
            return livemap::UploadPriority::High;
        case UploadJob::Kind::TilePyramidRepair:
            return livemap::UploadPriority::Low;
        }
        return livemap::UploadPriority::Normal;
    }

    livemap::LiveMapSettings settings_;
    std::size_t max_queue_size_{};
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    livemap::PrioritizedUploadQueue<UploadJob> jobs_;
    std::deque<UploadResult> results_;
    bool stopping_ = false;
    std::size_t worker_count_ = 1;
    std::vector<std::thread> workers_;
};

class LatestUploadDispatcher {
public:
    LatestUploadDispatcher(livemap::LiveMapSettings settings, std::string path)
        : settings_(std::move(settings)), path_(std::move(path)), worker_([this] { workerLoop(); })
    {
    }

    ~LatestUploadDispatcher()
    {
        stop();
    }

    LatestUploadDispatcher(const LatestUploadDispatcher &) = delete;
    LatestUploadDispatcher &operator=(const LatestUploadDispatcher &) = delete;

    void publish(std::string json, std::size_t item_count, std::vector<PlayerAvatarAck> player_avatar_acks)
    {
        {
            std::scoped_lock lock(mutex_);
            const bool replaced =
                pending_.replace({std::move(json), item_count, nowMs(), std::move(player_avatar_acks)});
            if (replaced) {
                ++replaced_count_;
            }
        }
        cv_.notify_one();
    }

    std::vector<UploadResult> drainResults()
    {
        std::scoped_lock lock(mutex_);
        std::vector<UploadResult> results;
        results.reserve(results_.size());
        while (!results_.empty()) {
            results.push_back(std::move(results_.front()));
            results_.pop_front();
        }
        return results;
    }

    [[nodiscard]] std::size_t pendingJobs() const
    {
        std::scoped_lock lock(mutex_);
        return pending_.size();
    }

    [[nodiscard]] std::size_t replacedCount() const
    {
        std::scoped_lock lock(mutex_);
        return replaced_count_;
    }

    void stop()
    {
        {
            std::scoped_lock lock(mutex_);
            if (stopping_) {
                return;
            }
            stopping_ = true;
            pending_.clear();
        }
        cv_.notify_one();
        if (worker_.joinable()) {
            worker_.join();
        }
    }

private:
    struct PendingPayload {
        std::string json;
        std::size_t item_count{};
        std::int64_t queued_at_ms{};
        std::vector<PlayerAvatarAck> player_avatar_acks;
    };

    void workerLoop()
    {
        while (true) {
            PendingPayload payload;
            {
                std::unique_lock lock(mutex_);
                cv_.wait(lock, [this] { return stopping_ || !pending_.empty(); });
                if (stopping_ && pending_.empty()) {
                    return;
                }
                auto next = pending_.take();
                if (!next.has_value()) {
                    continue;
                }
                payload = std::move(*next);
            }

            const auto started_at_ms = nowMs();
            auto transport = livemap::postPluginJson(settings_, path_, payload.json);
            const auto finished_at_ms = nowMs();
            {
                std::scoped_lock lock(mutex_);
                results_.push_back({UploadJob::Kind::PlayerSnapshot, {}, {}, payload.item_count, {},
                                    payload.queued_at_ms, started_at_ms, finished_at_ms, std::move(transport),
                                    std::move(payload.player_avatar_acks)});
            }
        }
    }

    livemap::LiveMapSettings settings_;
    std::string path_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    livemap::LatestUploadSlot<PendingPayload> pending_;
    std::deque<UploadResult> results_;
    std::size_t replaced_count_ = 0;
    bool stopping_ = false;
    std::thread worker_;
};

class LiveMapPlugin;

class LiveMapListener {
public:
    explicit LiveMapListener(LiveMapPlugin &plugin) : plugin_(plugin) {}

    void onBlockPlace(endstone::BlockPlaceEvent &event);
    void onBlockBreak(endstone::BlockBreakEvent &event);
    void onBlockFromTo(endstone::BlockFromToEvent &event);
    void onBlockExplode(endstone::BlockExplodeEvent &event);
    void onChunkLoad(endstone::ChunkLoadEvent &event);
    void onChunkUnload(endstone::ChunkUnloadEvent &event);

private:
    LiveMapPlugin &plugin_;
};

class LiveMapPlugin : public endstone::Plugin {
    friend class LiveMapListener;

public:
    void onEnable() override
    {
        const auto config_path = getDataFolder() / "live_map.json";
        bool created_config = false;
        if (!std::filesystem::exists(config_path)) {
            livemap::writeExampleSettings(config_path);
            created_config = true;
        }

        settings_ = livemap::loadSettings(config_path);
        settings_.tile_data_dir = resolveDataPath(settings_.tile_data_dir).string();
        background_log_path_ = resolveDataPath(settings_.background_log_file);
        baseline_index_path_ = resolveDataPath(settings_.baseline_index_file);
        std::string background_log_error;
        if (!background_log_.open(background_log_path_, &background_log_error)) {
            getLogger().error("Failed to open live map background log {}: {}", background_log_path_.string(),
                              background_log_error);
        }
        if (created_config) {
            background_log_.warning("Created ", config_path.string(), ", set plugin_token before enabling uploads.");
        }
        loadChunkBaselines();
        upload_dispatcher_ =
            std::make_unique<UploadDispatcher>(settings_, static_cast<std::size_t>(settings_.max_upload_queue_size));
        player_dispatcher_ = std::make_unique<LatestUploadDispatcher>(settings_, "/api/plugin/live");
        if (!enqueueUpload({UploadJob::Kind::TilePyramidRepair})) {
            background_log_.warning("Failed to queue startup tile pyramid repair.");
        }
        active_ = true;
        listener_ = std::make_unique<LiveMapListener>(*this);
        registerEvent(&LiveMapListener::onBlockPlace, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockBreak, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockFromTo, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockExplode, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onChunkLoad, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onChunkUnload, *listener_, endstone::EventPriority::Monitor, true);
        refreshLoadedChunks();

        const auto player_ticks = static_cast<std::uint64_t>(std::max(1, settings_.player_push_seconds) * 20);
        const auto seed_ticks = static_cast<std::uint64_t>(std::max(1, settings_.seed_pulse_seconds) * 20);
        const auto dirty_block_ticks = static_cast<std::uint64_t>(std::max(1, settings_.dirty_block_push_seconds) * 20);
        const auto land_ticks = static_cast<std::uint64_t>(std::max(10, settings_.land_push_seconds) * 20);
        player_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishPlayers(); }, player_ticks,
                                                               player_ticks);
        seed_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { pulsePlayerSeedQueue(); }, seed_ticks,
                                                             seed_ticks);
        dirty_block_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishDirtyBlocks(); },
                                                                    dirty_block_ticks, dirty_block_ticks);
        land_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishLands(); }, 20, land_ticks);
        upload_result_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { processUploadResults(); }, 20,
                                                                      20);

        background_log_.info(
            "Endstone Live Map enabled for local server ", settings_.local_server_url, " with uploads players=",
            settings_.upload_players, " chunks=", settings_.upload_chunks, " dirtyBlocks=",
            settings_.upload_dirty_blocks,
            " autoSeedChunks=", settings_.auto_seed_chunks, " legacyRadius=", settings_.scan_radius_chunks,
            " playerSeedRadius=", settings_.player_seed_radius_chunks,
            " playerSeedInterval=", settings_.player_seed_interval_seconds, "s maxSeedPerPulse=",
            settings_.max_seed_chunks_per_pulse, " seedPulse=", settings_.seed_pulse_seconds,
            "s playerSeedJoinDelay=", settings_.player_seed_join_delay_seconds, "s chunkUploadBatch=",
            settings_.chunk_upload_batch_size, " chunkUploadFlush=", settings_.chunk_upload_flush_seconds,
            "s chunkUploadCooldown=", settings_.chunk_upload_cooldown_seconds,
            "s httpTimeout=", settings_.http_timeout_seconds, "s dirtyBlockPush=", settings_.dirty_block_push_seconds,
            "s maxDirtyBlocks=",
            settings_.max_dirty_blocks_per_push, " maxDirtyChunks=", settings_.max_dirty_chunks_per_push,
            " maxUploadQueue=", settings_.max_upload_queue_size,
            " maxPendingChunkUploads=", settings_.max_pending_chunk_uploads,
            " uploadLands=", settings_.upload_lands, " landPush=", settings_.land_push_seconds,
            "s landConfig=", settings_.land_config_file, " tileDataDir=", settings_.tile_data_dir,
            " renderWorkers=1 (serialized; requested=", settings_.render_worker_threads,
            ") tileMinZoom=", settings_.tile_min_zoom,
            " r2Enabled=", settings_.r2_enabled, " r2Bucket=", settings_.r2_bucket,
            " r2MaxPerMinute=", settings_.r2_max_uploads_per_minute, " dimensions=", settings_.dimensions.size(),
            " loadedChunks=", loadedChunkCount(), ".");
    }

    void onDisable() override
    {
        active_ = false;
        if (player_task_ != nullptr) {
            player_task_->cancel();
        }
        if (seed_task_ != nullptr) {
            seed_task_->cancel();
        }
        if (dirty_block_task_ != nullptr) {
            dirty_block_task_->cancel();
        }
        if (land_task_ != nullptr) {
            land_task_->cancel();
        }
        if (upload_result_task_ != nullptr) {
            upload_result_task_->cancel();
        }
        processUploadResults();
        if (upload_dispatcher_ != nullptr) {
            upload_dispatcher_->stop();
            // A render that was already in flight can finish while stop() joins
            // the worker. Consume that final result before persisting baselines
            // so a graceful shutdown does not needlessly render it again.
            processUploadResults();
        }
        if (player_dispatcher_ != nullptr) {
            player_dispatcher_->stop();
            processPlayerUploadResults();
        }
        persistChunkBaselines();
        background_log_.info("Endstone Live Map disabled");
        background_log_.close();
    }

    bool onCommand(endstone::CommandSender &sender, const endstone::Command &command,
                   const std::vector<std::string> &args) override
    {
        if (command.getName() != "livemap") {
            return false;
        }

        if (!args.empty() && args[0] == "render-chunk") {
            if (args.size() < 3) {
                sender.sendMessage("Usage: /livemap render-chunk <chunkX> <chunkZ>");
                return true;
            }
            try {
                const int chunk_x = std::stoi(args[1]);
                const int chunk_z = std::stoi(args[2]);
                auto *level = getServer().getLevel();
                if (level == nullptr) {
                    sender.sendMessage("Level is not ready.");
                    return true;
                }
                const auto queued = enqueueSeedChunk({level->getName(), "Overworld", chunk_x, chunk_z}, true);
                sender.sendMessage("Queued " + std::to_string(queued) + " chunk for live map base sampling.");
                background_log_.info("Queued chunk ", level->getName(), "/Overworld/", chunk_x, "/", chunk_z,
                                     " for live map sampling.");
            }
            catch (...) {
                sender.sendMessage("Usage: /livemap render-chunk <chunkX> <chunkZ>");
            }
            return true;
        }

        if (!args.empty() && args[0] == "render-area") {
            if (args.size() < 5) {
                sender.sendMessage("Usage: /livemap render-area <minX> <minZ> <maxX> <maxZ>");
                return true;
            }
            try {
                const int min_x = std::stoi(args[1]);
                const int min_z = std::stoi(args[2]);
                const int max_x = std::stoi(args[3]);
                const int max_z = std::stoi(args[4]);
                if (max_x < min_x || max_z < min_z) {
                    sender.sendMessage("Usage: /livemap render-area <minX> <minZ> <maxX> <maxZ>");
                    return true;
                }
                auto *level = getServer().getLevel();
                if (level == nullptr) {
                    sender.sendMessage("Level is not ready.");
                    return true;
                }
                const int min_chunk_x = livemap::floorDiv(min_x, livemap::kChunkSize);
                const int max_chunk_x = livemap::floorDiv(max_x, livemap::kChunkSize);
                const int min_chunk_z = livemap::floorDiv(min_z, livemap::kChunkSize);
                const int max_chunk_z = livemap::floorDiv(max_z, livemap::kChunkSize);
                std::size_t queued = 0;
                for (int chunk_z = min_chunk_z; chunk_z <= max_chunk_z; ++chunk_z) {
                    for (int chunk_x = min_chunk_x; chunk_x <= max_chunk_x; ++chunk_x) {
                        queued += enqueueSeedChunk({level->getName(), "Overworld", chunk_x, chunk_z}, true);
                    }
                }
                sender.sendMessage("Queued " + std::to_string(queued) + " chunks for live map area rendering.");
                background_log_.info("Queued render-area chunks=", queued, " blockRange=", min_x, "/", min_z,
                                     " -> ", max_x, "/", max_z, ".");
            }
            catch (...) {
                sender.sendMessage("Usage: /livemap render-area <minX> <minZ> <maxX> <maxZ>");
            }
            return true;
        }

        if (!args.empty() && args[0] == "reload") {
            reloadSettings();
            sender.sendMessage("Reloaded live map settings and upload dispatchers.");
            return true;
        }

        if (!args.empty() && args[0] == "repair-pyramid") {
            if (enqueueUpload({UploadJob::Kind::TilePyramidRepair})) {
                sender.sendMessage("Queued live map tile pyramid repair.");
                background_log_.info("Queued manual live map tile pyramid repair.");
            }
            else {
                sender.sendMessage("Could not queue tile pyramid repair because the render queue is full.");
            }
            return true;
        }

        if (!args.empty() && (args[0] == "render-near" || args[0] == "render")) {
            int radius = settings_.scan_radius_chunks;
            if (args.size() >= 2) {
                try {
                    radius = std::clamp(std::stoi(args[1]), 0, 16);
                }
                catch (...) {
                    sender.sendMessage("Usage: /livemap render-near <radius>");
                    return true;
                }
            }
            const auto queued = queueChunksNearPlayers(radius, true);
            sender.sendMessage("Queued " + std::to_string(queued) + " chunks for live map sampling.");
            background_log_.info("Queued ", queued, " chunks for live map sampling with radius ", radius, ".");
            return true;
        }

        sender.sendMessage("Live map queued render chunks: " + std::to_string(seedQueueSize()) +
                           ", deferred chunks: " + std::to_string(deferredSeedQueueSize()) +
                           ", dirty block columns: " + std::to_string(dirtyCount()) +
                           ", pending render jobs: " + std::to_string(upload_dispatcher_ == nullptr ? 0 : upload_dispatcher_->pendingJobs()));
        return true;
    }

    void markBlock(const endstone::Block &block)
    {
        auto &dimension = block.getDimension();
        const auto dimension_name = dimension.getName();
        if (!dimensionEnabled(dimension_name)) {
            return;
        }
        const auto world = dimension.getLevel().getName();
        const auto x = block.getX();
        const auto y = block.getY();
        const auto z = block.getZ();
        getServer().getScheduler().runTaskLater(*this, [this, world, dimension_name, x, y, z] {
            if (!active_) {
                return;
            }
            std::scoped_lock lock(state_mutex_);
            dirty_blocks_.markBlock(world, dimension_name, x, z, y);
        }, 1);
    }

    void reloadSettings()
    {
        const auto config_path = getDataFolder() / "live_map.json";
        if (upload_dispatcher_ != nullptr) {
            upload_dispatcher_->stop();
        }
        if (player_dispatcher_ != nullptr) {
            player_dispatcher_->stop();
        }
        settings_ = livemap::loadSettings(config_path);
        settings_.tile_data_dir = resolveDataPath(settings_.tile_data_dir).string();
        {
            std::scoped_lock lock(state_mutex_);
            // A different token or endpoint may refer to a server that has never
            // received these images. Force bounded retransmission after reload.
            acknowledged_player_avatar_hashes_.clear();
        }
        upload_dispatcher_ =
            std::make_unique<UploadDispatcher>(settings_, static_cast<std::size_t>(settings_.max_upload_queue_size));
        player_dispatcher_ = std::make_unique<LatestUploadDispatcher>(settings_, "/api/plugin/live");
        if (!enqueueUpload({UploadJob::Kind::TilePyramidRepair})) {
            background_log_.warning("Failed to queue tile pyramid repair after settings reload.");
        }
        background_log_.info("Reloaded live map settings; localServer=", settings_.local_server_url,
                             " tileDataDir=", settings_.tile_data_dir, " r2Enabled=", settings_.r2_enabled, ".");
    }

    [[nodiscard]] std::size_t dirtyCount() const
    {
        std::scoped_lock lock(state_mutex_);
        return dirty_blocks_.size();
    }

private:
    std::filesystem::path resolveDataPath(const std::string &configured_path) const
    {
        std::filesystem::path path(configured_path.empty() ? "." : configured_path);
        if (path.is_relative()) {
            path = getDataFolder() / path;
        }
        return path;
    }

    [[nodiscard]] bool dimensionEnabled(const std::string &dimension) const
    {
        return std::find(settings_.dimensions.begin(), settings_.dimensions.end(), dimension) !=
               settings_.dimensions.end();
    }

    [[nodiscard]] std::size_t seedQueueSize() const
    {
        std::scoped_lock lock(state_mutex_);
        return seed_queue_.size();
    }

    [[nodiscard]] std::size_t deferredSeedQueueSize() const
    {
        std::scoped_lock lock(state_mutex_);
        return deferred_seed_chunks_.size();
    }

    [[nodiscard]] std::size_t loadedChunkCount() const
    {
        std::scoped_lock lock(state_mutex_);
        return loaded_chunks_.size();
    }

    [[nodiscard]] bool isChunkLoaded(const livemap::ChunkCoord &coord) const
    {
        std::scoped_lock lock(state_mutex_);
        return loaded_chunks_.find(coord) != loaded_chunks_.end();
    }

    bool queueSeedChunkLocked(const livemap::ChunkCoord &coord, bool force, std::int64_t not_before_ms)
    {
        if (queued_seed_chunks_.insert(coord).second) {
            seed_queue_.push_back({coord, not_before_ms, force});
            return true;
        }
        if (force) {
            for (auto &queued : seed_queue_) {
                if (queued.coord == coord) {
                    queued.force = true;
                    break;
                }
            }
        }
        return false;
    }

    bool deferSeedChunk(const livemap::ChunkCoord &coord, bool force)
    {
        std::scoped_lock lock(state_mutex_);
        // Chunk load events and the seed pulse run independently. The chunk may
        // finish loading after pulsePlayerSeedQueue() checks it but before this
        // method records the deferred work. Requeue atomically in that case so
        // the work cannot miss the one load event and remain deferred forever.
        if (loaded_chunks_.find(coord) != loaded_chunks_.end()) {
            queueSeedChunkLocked(coord, force, nowMs());
            return false;
        }
        auto found = deferred_seed_chunks_.find(coord);
        if (found == deferred_seed_chunks_.end()) {
            deferred_seed_chunks_.emplace(coord, force);
            return true;
        }
        if (force && !found->second) {
            found->second = true;
            return true;
        }
        return false;
    }

    void markChunkLoaded(const livemap::ChunkCoord &coord)
    {
        bool queued = false;
        bool force = false;
        {
            std::scoped_lock lock(state_mutex_);
            loaded_chunks_.insert(coord);
            auto deferred = deferred_seed_chunks_.find(coord);
            if (deferred == deferred_seed_chunks_.end()) {
                return;
            }
            force = deferred->second;
            deferred_seed_chunks_.erase(deferred);
            queued = queueSeedChunkLocked(coord, force, nowMs());
        }
        if (queued) {
            background_log_.info("Queued deferred live map base chunk ", chunkName(coord),
                                 " after chunk load; force=", force, ".");
        }
    }

    void markChunkUnloaded(const livemap::ChunkCoord &coord)
    {
        std::scoped_lock lock(state_mutex_);
        loaded_chunks_.erase(coord);
    }

    void refreshLoadedChunks()
    {
        std::unordered_set<livemap::ChunkCoord, livemap::ChunkCoordHash> loaded;
        auto *level = getServer().getLevel();
        if (level != nullptr) {
            for (const auto &dimension_name : settings_.dimensions) {
                auto *dimension = level->getDimension(dimension_name);
                if (dimension == nullptr) {
                    continue;
                }
                for (const auto &chunk : dimension->getLoadedChunks()) {
                    if (chunk == nullptr) {
                        continue;
                    }
                    loaded.insert({dimension->getLevel().getName(), dimension->getName(), chunk->getX(), chunk->getZ()});
                }
            }
        }
        std::size_t recovered = 0;
        {
            std::scoped_lock lock(state_mutex_);
            loaded_chunks_ = std::move(loaded);
            for (auto deferred = deferred_seed_chunks_.begin(); deferred != deferred_seed_chunks_.end();) {
                if (loaded_chunks_.find(deferred->first) == loaded_chunks_.end()) {
                    ++deferred;
                    continue;
                }
                const auto coord = deferred->first;
                const auto force = deferred->second;
                deferred = deferred_seed_chunks_.erase(deferred);
                if (queueSeedChunkLocked(coord, force, nowMs())) {
                    ++recovered;
                }
            }
        }
        if (recovered > 0) {
            background_log_.info("Recovered ", recovered,
                                 " deferred live map base chunk(s) after reconciling loaded chunks.");
        }
    }

    void handleChunkLoad(const endstone::Chunk &chunk)
    {
        auto &dimension = chunk.getDimension();
        if (!dimensionEnabled(dimension.getName())) {
            return;
        }
        markChunkLoaded({dimension.getLevel().getName(), dimension.getName(), chunk.getX(), chunk.getZ()});
    }

    void handleChunkUnload(const endstone::Chunk &chunk)
    {
        auto &dimension = chunk.getDimension();
        if (!dimensionEnabled(dimension.getName())) {
            return;
        }
        markChunkUnloaded({dimension.getLevel().getName(), dimension.getName(), chunk.getX(), chunk.getZ()});
    }

    std::size_t enqueueSeedChunk(const livemap::ChunkCoord &coord, bool force)
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return 0;
        }
        std::scoped_lock lock(state_mutex_);
        auto deferred = deferred_seed_chunks_.find(coord);
        if (deferred != deferred_seed_chunks_.end() && loaded_chunks_.find(coord) == loaded_chunks_.end()) {
            if (force && !deferred->second) {
                deferred->second = true;
                return 1;
            }
            return 0;
        }
        if (deferred != deferred_seed_chunks_.end()) {
            deferred_seed_chunks_.erase(deferred);
        }
        return queueSeedChunkLocked(coord, force, nowMs()) ? 1 : 0;
    }

    void requeueSeedChunkAfterPendingBackpressure(const livemap::ChunkCoord &coord, bool force)
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return;
        }
        const auto retry_at_ms =
            nowMs() + static_cast<std::int64_t>(std::max(1, settings_.chunk_upload_flush_seconds)) * 1000;
        std::scoped_lock lock(state_mutex_);
        if (queueSeedChunkLocked(coord, force, retry_at_ms)) {
            return;
        }
        for (auto &queued : seed_queue_) {
            if (queued.coord == coord) {
                queued.force = queued.force || force;
                queued.not_before_ms = std::max(queued.not_before_ms, retry_at_ms);
                return;
            }
        }
    }

    std::size_t enqueueChunkSquare(const std::string &world, const std::string &dimension, int center_x, int center_z,
                                   int radius, bool force)
    {
        std::size_t queued = 0;
        for (int dz = -radius; dz <= radius; ++dz) {
            for (int dx = -radius; dx <= radius; ++dx) {
                queued += enqueueSeedChunk({world, dimension, center_x + dx, center_z + dz}, force);
            }
        }
        return queued;
    }

    std::size_t queueChunksNearPlayers(int radius, bool force)
    {
        std::size_t queued = 0;
        for (auto *player : getServer().getOnlinePlayers()) {
            if (player == nullptr) {
                continue;
            }
            const auto location = player->getLocation();
            auto &dimension = location.getDimension();
            if (!dimensionEnabled(dimension.getName())) {
                continue;
            }
            const int chunk_x = livemap::floorDiv(static_cast<int>(std::floor(location.getX())), livemap::kChunkSize);
            const int chunk_z = livemap::floorDiv(static_cast<int>(std::floor(location.getZ())), livemap::kChunkSize);
            queued += enqueueChunkSquare(dimension.getLevel().getName(), dimension.getName(), chunk_x, chunk_z, radius,
                                         force);
        }
        return queued;
    }

    std::size_t queuePlayerSeedAreas()
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return 0;
        }

        const auto current_ms = nowMs();
        std::size_t queued = 0;
        std::unordered_set<std::string> online_player_keys;
        for (auto *player : getServer().getOnlinePlayers()) {
            if (player == nullptr) {
                continue;
            }
            const auto location = player->getLocation();
            auto &dimension = location.getDimension();
            if (!dimensionEnabled(dimension.getName())) {
                continue;
            }
            const auto player_key = player->getUniqueId().str() + "|" + dimension.getName();
            online_player_keys.insert(player_key);
            const int chunk_x = livemap::floorDiv(static_cast<int>(std::floor(location.getX())), livemap::kChunkSize);
            const int chunk_z = livemap::floorDiv(static_cast<int>(std::floor(location.getZ())), livemap::kChunkSize);
            const auto center_key = std::to_string(chunk_x) + "/" + std::to_string(chunk_z);
            {
                std::scoped_lock lock(state_mutex_);
                const auto first_seen = player_first_seen_ms_.emplace(player_key, current_ms);
                if (current_ms - first_seen.first->second <
                    static_cast<std::int64_t>(settings_.player_seed_join_delay_seconds) * 1000) {
                    continue;
                }
                const auto last_center = player_last_seed_center_.find(player_key);
                const auto due = player_next_seed_ms_.find(player_key);
                if (last_center != player_last_seed_center_.end() && last_center->second == center_key &&
                    due != player_next_seed_ms_.end() && current_ms < due->second) {
                    continue;
                }
                player_last_seed_center_[player_key] = center_key;
                player_next_seed_ms_[player_key] =
                    current_ms + static_cast<std::int64_t>(settings_.player_seed_interval_seconds) * 1000;
            }
            queued += enqueueChunkSquare(dimension.getLevel().getName(), dimension.getName(), chunk_x, chunk_z,
                                         settings_.player_seed_radius_chunks, false);
        }
        {
            std::scoped_lock lock(state_mutex_);
            std::erase_if(player_first_seen_ms_, [&online_player_keys](const auto &entry) {
                return online_player_keys.find(entry.first) == online_player_keys.end();
            });
            std::erase_if(player_last_seed_center_, [&online_player_keys](const auto &entry) {
                return online_player_keys.find(entry.first) == online_player_keys.end();
            });
            std::erase_if(player_next_seed_ms_, [&online_player_keys](const auto &entry) {
                return online_player_keys.find(entry.first) == online_player_keys.end();
            });
        }
        return queued;
    }

    std::vector<QueuedSeed> drainSeedChunks(std::size_t limit)
    {
        std::vector<QueuedSeed> chunks;
        std::scoped_lock lock(state_mutex_);
        const auto current_ms = nowMs();
        const auto scan_count = seed_queue_.size();
        for (std::size_t scanned = 0; scanned < scan_count && chunks.size() < limit; ++scanned) {
            auto queued = std::move(seed_queue_.front());
            seed_queue_.pop_front();
            if (queued.not_before_ms > current_ms) {
                seed_queue_.push_back(std::move(queued));
                continue;
            }
            queued_seed_chunks_.erase(queued.coord);
            chunks.push_back(std::move(queued));
        }
        return chunks;
    }

    void publishPlayers()
    {
        if (!settings_.upload_players || settings_.plugin_token.empty()) {
            return;
        }

        std::vector<livemap::PlayerState> players;
        std::vector<PlayerAvatarAck> player_avatar_acks;
        std::unordered_set<std::string> online_player_ids;
        for (auto *player : getServer().getOnlinePlayers()) {
            if (player == nullptr) {
                continue;
            }
            const auto location = player->getLocation();
            auto &dimension = location.getDimension();
            const auto player_id = player->getUniqueId().str();
            online_player_ids.insert(player_id);
            auto avatar = encodePlayerAvatar(*player);
            std::string avatar_hash;
            std::string avatar_png_base64;
            if (avatar.has_value()) {
                avatar_hash = std::move(avatar->hash);
                bool should_send_avatar = false;
                {
                    std::scoped_lock lock(state_mutex_);
                    const auto acknowledged = acknowledged_player_avatar_hashes_.find(player_id);
                    should_send_avatar = acknowledged == acknowledged_player_avatar_hashes_.end() ||
                                         acknowledged->second != avatar_hash;
                }
                if (should_send_avatar) {
                    avatar_png_base64 = std::move(avatar->png_base64);
                    player_avatar_acks.push_back({player_id, avatar_hash});
                }
            }
            players.push_back({
                player_id,
                player->getName(),
                player->getXuid(),
                dimension.getLevel().getName(),
                dimension.getName(),
                location.getX(),
                location.getY(),
                location.getZ(),
                location.getYaw(),
                location.getPitch(),
                std::move(avatar_hash),
                std::move(avatar_png_base64),
                nowMs(),
            });
        }
        {
            std::scoped_lock lock(state_mutex_);
            std::erase_if(acknowledged_player_avatar_hashes_, [&online_player_ids](const auto &entry) {
                return online_player_ids.find(entry.first) == online_player_ids.end();
            });
        }
        if (player_dispatcher_ == nullptr) {
            background_log_.warning("Dropped live map player snapshot because player upload dispatcher is unavailable.");
            return;
        }
        player_dispatcher_->publish(livemap::serializePlayerSnapshot(players), players.size(),
                                    std::move(player_avatar_acks));
    }

    void publishLands()
    {
        if (!settings_.upload_lands || settings_.plugin_token.empty()) {
            return;
        }

        auto *level = getServer().getLevel();
        const auto world = level == nullptr ? std::string{"Bedrock level"} : level->getName();
        const auto land_config_path = resolveDataPath(settings_.land_config_file);
        const auto parsed = livemap::loadLandConfig(land_config_path, world, nowMs());
        if (!parsed.source_valid) {
            background_log_.warning("Skipped authoritative live map land snapshot because ", land_config_path.string(),
                                    " is missing, unreadable, or invalid.");
            return;
        }

        if (!enqueueUpload({UploadJob::Kind::Lands, "/api/plugin/lands",
                            livemap::serializeLandBatch(parsed.claims, world, settings_.dimensions),
                            {}, {}, parsed.claims.size(), {}})) {
            background_log_.warning("Dropped live map land snapshot because upload queue is full.");
            return;
        }
        background_log_.info("Queued ", parsed.claims.size(), " land claim(s) for live map upload; skipped ",
                             parsed.skipped_entries, " invalid land entrie(s).");
    }

    std::optional<ColumnSample> sampleColumnForMap(endstone::Dimension &dimension, int block_x, int block_z)
    {
        try {
            int highest_y = dimension.getHighestBlockYAt(block_x, block_z);
            const int min_y = minSampleY(dimension);
            if (highest_y < min_y) {
                highest_y = min_y;
            }
            ColumnSample sample;
            bool found_overlay = false;
            for (int y = highest_y; y >= min_y; --y) {
                const auto block = dimension.getBlockAt(block_x, y, block_z);
                if (block == nullptr) {
                    continue;
                }
                const auto type = block->getType();
                if (!found_overlay && livemap::isMapDecorationBlock(type)) {
                    sample.overlay = {type, block->getY(), blockStatesForBlock(*block)};
                    found_overlay = true;
                }
                if (livemap::isMapSurfaceBlock(type)) {
                    sample.surface = {type, block->getY(), blockStatesForBlock(*block)};
                    return sample;
                }
            }
            return sample;
        }
        catch (const std::exception &error) {
            getLogger().error("Failed to sample live map column {}/{}: {}", block_x, block_z, error.what());
            return std::nullopt;
        }
        catch (...) {
            getLogger().error("Failed to sample live map column {}/{}.", block_x, block_z);
            return std::nullopt;
        }
    }

    std::optional<ColumnTop> sampleColumn(endstone::Dimension &dimension, int block_x, int block_z)
    {
        const auto sample = sampleColumnForMap(dimension, block_x, block_z);
        if (!sample.has_value()) {
            return std::nullopt;
        }
        return sample->surface;
    }

    static int minSampleY(const endstone::Dimension &dimension)
    {
        const auto type = dimension.getType();
        if (type == endstone::Dimension::Type::Nether || type == endstone::Dimension::Type::TheEnd) {
            return 0;
        }
        return -64;
    }

    std::optional<livemap::ChunkSnapshot> sampleChunk(endstone::Dimension &dimension, const livemap::ChunkCoord &coord)
    {
        livemap::ChunkSnapshot snapshot;
        snapshot.world = coord.world;
        snapshot.dimension = coord.dimension;
        snapshot.chunk_x = coord.x;
        snapshot.chunk_z = coord.z;
        snapshot.updated_at_ms = nowMs();
        std::unordered_map<std::string, std::uint16_t> palette_indexes;

        const auto palette_index = [&snapshot, &palette_indexes](const std::string &block_type) {
            const auto found = palette_indexes.find(block_type);
            if (found != palette_indexes.end()) {
                return found->second;
            }
            const auto index = static_cast<std::uint16_t>(snapshot.palette.size());
            snapshot.palette.push_back(block_type);
            palette_indexes.emplace(block_type, index);
            return index;
        };

        for (int local_z = 0; local_z < livemap::kChunkSize; ++local_z) {
            for (int local_x = 0; local_x < livemap::kChunkSize; ++local_x) {
                const int block_x = coord.x * livemap::kChunkSize + local_x;
                const int block_z = coord.z * livemap::kChunkSize + local_z;
                const int index = local_z * livemap::kChunkSize + local_x;
                const auto column = sampleColumnForMap(dimension, block_x, block_z);
                if (!column.has_value()) {
                    return std::nullopt;
                }
                snapshot.blocks[index] = palette_index(column->surface.block);
                snapshot.heights[index] = column->surface.height;
                snapshot.block_states[index] = column->surface.state;
                snapshot.overlay_blocks[index] = palette_index(column->overlay.block);
                snapshot.overlay_heights[index] = column->overlay.height;
                snapshot.overlay_states[index] = column->overlay.state;
            }
        }
        return snapshot;
    }

    void requeueDirtyColumn(const livemap::DirtyBlockColumn &column)
    {
        std::scoped_lock lock(state_mutex_);
        dirty_blocks_.markColumn(column.coord, column.touched_y);
    }

    void loadChunkBaselines()
    {
        const auto loaded = livemap::loadChunkBaselineIndex(baseline_index_path_);
        {
            std::scoped_lock lock(state_mutex_);
            chunk_baselines_ = loaded.baselines;
            baselines_dirty_ = false;
        }
        background_log_.info("Loaded ", loaded.baselines.size(), " live map chunk baseline(s) from ",
                             baseline_index_path_.string(), ".");
        if (loaded.skipped_lines > 0) {
            background_log_.warning("Skipped ", loaded.skipped_lines, " invalid live map baseline line(s).");
        }
    }

    void persistChunkBaselines()
    {
        livemap::ChunkBaselineMap baselines;
        {
            std::scoped_lock lock(state_mutex_);
            if (!baselines_dirty_) {
                return;
            }
            baselines = chunk_baselines_;
            baselines_dirty_ = false;
        }

        std::string error;
        if (!livemap::saveChunkBaselineIndexAtomic(baseline_index_path_, baselines, &error)) {
            {
                std::scoped_lock lock(state_mutex_);
                baselines_dirty_ = true;
            }
            getLogger().error("Failed to persist live map chunk baseline index {}: {}", baseline_index_path_.string(),
                              error);
            return;
        }
        background_log_.info("Persisted ", baselines.size(), " live map chunk baseline(s) to ",
                             baseline_index_path_.string(), ".");
    }

    [[nodiscard]] bool enqueueUpload(UploadJob job)
    {
        if (upload_dispatcher_ == nullptr || !upload_dispatcher_->enqueue(std::move(job))) {
            return false;
        }
        return true;
    }

    void pruneChunkUploadCooldownsLocked(std::int64_t current_ms)
    {
        if (current_ms < next_chunk_cooldown_prune_ms_) {
            return;
        }
        std::erase_if(chunk_upload_cooldown_until_ms_, [current_ms](const auto &entry) {
            return entry.second <= current_ms;
        });
        next_chunk_cooldown_prune_ms_ = current_ms + 1000;
    }

    [[nodiscard]] std::int64_t pendingChunkReadyAtLocked(const livemap::ChunkCoord &coord,
                                                         std::int64_t current_ms) const
    {
        const auto cooldown = chunk_upload_cooldown_until_ms_.find(coord);
        if (cooldown != chunk_upload_cooldown_until_ms_.end()) {
            return std::max(current_ms, cooldown->second);
        }
        return current_ms;
    }

    PendingChunkQueueResult queuePendingChunkUpload(livemap::ChunkSnapshot snapshot, bool force = false)
    {
        const auto coord = chunkCoordForSnapshot(snapshot);
        const auto fingerprint = livemap::fingerprintChunkSnapshot(snapshot);
        const auto current_ms = nowMs();
        std::scoped_lock lock(state_mutex_);
        pruneChunkUploadCooldownsLocked(current_ms);

        const auto confirmed = chunk_baselines_.find(coord);
        if (!force && confirmed != chunk_baselines_.end() && confirmed->second.fingerprint == fingerprint &&
            livemap::renderedTileFilesExistForChunk(settings_, coord)) {
            ++skipped_cached_chunks_;
            return PendingChunkQueueResult::Skipped;
        }

        auto pending = pending_chunk_uploads_.find(coord);
        if (!force && pending != pending_chunk_uploads_.end() && pending->second.meta.fingerprint == fingerprint) {
            ++skipped_cached_chunks_;
            return PendingChunkQueueResult::Skipped;
        }

        const auto meta = ChunkUploadMeta{coord, fingerprint, snapshot.updated_at_ms};
        if (pending != pending_chunk_uploads_.end()) {
            pending->second.snapshot = std::move(snapshot);
            pending->second.meta = meta;
            pending->second.ready_at_ms =
                std::max(pending->second.ready_at_ms,
                         pendingChunkReadyAtLocked(coord, current_ms));
            return PendingChunkQueueResult::Queued;
        }

        const auto max_pending = static_cast<std::size_t>(std::max(1, settings_.max_pending_chunk_uploads));
        if (pending_chunk_uploads_.size() >= max_pending) {
            ++backpressured_pending_chunk_uploads_;
            return PendingChunkQueueResult::Backpressured;
        }

        if (pending_chunk_uploads_.empty()) {
            pending_chunk_flush_deadline_ms_ =
                current_ms +
                static_cast<std::int64_t>(std::max(1, settings_.chunk_upload_flush_seconds)) * 1000;
        }
        pending_chunk_uploads_.emplace(
            coord,
            PendingChunkUpload{std::move(snapshot), meta, current_ms, pendingChunkReadyAtLocked(coord, current_ms)});
        return PendingChunkQueueResult::Queued;
    }

    void restorePendingChunkUploads(std::vector<livemap::ChunkSnapshot> snapshots, std::vector<ChunkUploadMeta> metas)
    {
        if (snapshots.empty()) {
            return;
        }

        const auto current_ms = nowMs();
        std::size_t restored = 0;
        std::size_t skipped = 0;
        std::vector<livemap::ChunkCoord> backpressured_coords;
        {
            std::scoped_lock lock(state_mutex_);
            pruneChunkUploadCooldownsLocked(current_ms);
            for (std::size_t i = 0; i < snapshots.size(); ++i) {
                auto existing = pending_chunk_uploads_.find(metas[i].coord);
                if (existing != pending_chunk_uploads_.end() &&
                    existing->second.meta.fingerprint != metas[i].fingerprint) {
                    ++skipped;
                    continue;
                }
                if (existing != pending_chunk_uploads_.end()) {
                    existing->second.snapshot = std::move(snapshots[i]);
                    existing->second.meta = metas[i];
                    ++restored;
                    continue;
                }
                const auto max_pending = static_cast<std::size_t>(std::max(1, settings_.max_pending_chunk_uploads));
                if (pending_chunk_uploads_.size() >= max_pending) {
                    ++backpressured_pending_chunk_uploads_;
                    backpressured_coords.push_back(metas[i].coord);
                    continue;
                }
                const auto coord = metas[i].coord;
                if (pending_chunk_uploads_.empty()) {
                    pending_chunk_flush_deadline_ms_ =
                        current_ms +
                        static_cast<std::int64_t>(std::max(1, settings_.chunk_upload_flush_seconds)) * 1000;
                }
                pending_chunk_uploads_.emplace(
                    coord,
                    PendingChunkUpload{std::move(snapshots[i]), metas[i], current_ms,
                                       pendingChunkReadyAtLocked(coord, current_ms)});
                ++restored;
            }
        }
        for (const auto &coord : backpressured_coords) {
            requeueSeedChunkAfterPendingBackpressure(coord, true);
        }
        if (skipped > 0) {
            background_log_.warning("Skipped restoring ", skipped,
                                     " stale live map chunk upload(s); restored ", restored, " chunk(s).");
        }
    }

    std::int64_t delayChunkBatchRetry()
    {
        std::scoped_lock lock(state_mutex_);
        const auto retry_after_ms = chunk_upload_retry_delay_ms_;
        chunk_upload_backoff_until_ms_ = std::max(chunk_upload_backoff_until_ms_, nowMs() + retry_after_ms);
        chunk_upload_retry_delay_ms_ =
            std::min(chunk_upload_retry_delay_ms_ * 2, kChunkBatchRetryMaxDelayMs);
        return retry_after_ms;
    }

    void resetChunkBatchRetry()
    {
        std::scoped_lock lock(state_mutex_);
        chunk_upload_retry_delay_ms_ = kChunkBatchRetryMinDelayMs;
        chunk_upload_backoff_until_ms_ = 0;
    }

    bool flushPendingChunkUploads()
    {
        bool queued_any = false;
        const auto current_ms = nowMs();
        const auto max_batch_size = static_cast<std::size_t>(std::max(1, settings_.chunk_upload_batch_size));
        while (true) {
            std::vector<livemap::ChunkSnapshot> snapshots;
            std::vector<ChunkUploadMeta> metas;
            std::size_t remaining = 0;
            std::size_t waiting_pending = 0;
            std::int64_t ready_remaining_ms = 0;
            std::int64_t backoff_remaining_ms = 0;
            bool waiting = false;
            bool log_waiting = false;
            {
                std::scoped_lock lock(state_mutex_);
                pruneChunkUploadCooldownsLocked(current_ms);
                if (pending_chunk_uploads_.empty()) {
                    pending_chunk_flush_deadline_ms_ = 0;
                    return queued_any;
                }
                if (current_ms < chunk_upload_backoff_until_ms_ ||
                    current_ms < pending_chunk_flush_deadline_ms_) {
                    waiting = true;
                    waiting_pending = pending_chunk_uploads_.size();
                    ready_remaining_ms =
                        std::max<std::int64_t>(0, pending_chunk_flush_deadline_ms_ - current_ms);
                    backoff_remaining_ms = std::max<std::int64_t>(0, chunk_upload_backoff_until_ms_ - current_ms);
                    if (current_ms - last_chunk_pending_log_ms_ >= 30000) {
                        last_chunk_pending_log_ms_ = current_ms;
                        log_waiting = true;
                    }
                }
                if (!waiting) {
                    std::vector<livemap::ChunkCoord> coords;
                    coords.reserve(pending_chunk_uploads_.size());
                    std::int64_t next_ready_at_ms = 0;
                    for (const auto &[coord, upload] : pending_chunk_uploads_) {
                        if (upload.ready_at_ms <= current_ms) {
                            coords.push_back(coord);
                        }
                        else if (next_ready_at_ms == 0 || upload.ready_at_ms < next_ready_at_ms) {
                            next_ready_at_ms = upload.ready_at_ms;
                        }
                    }
                    if (coords.empty()) {
                        waiting = true;
                        waiting_pending = pending_chunk_uploads_.size();
                        ready_remaining_ms = std::max<std::int64_t>(0, next_ready_at_ms - current_ms);
                        if (current_ms - last_chunk_pending_log_ms_ >= 30000) {
                            last_chunk_pending_log_ms_ = current_ms;
                            log_waiting = true;
                        }
                    }
                    else {
                        std::sort(coords.begin(), coords.end(), [this](const auto &left, const auto &right) {
                            const auto left_upload = pending_chunk_uploads_.find(left);
                            const auto right_upload = pending_chunk_uploads_.find(right);
                            if (left_upload != pending_chunk_uploads_.end() &&
                                right_upload != pending_chunk_uploads_.end() &&
                                left_upload->second.queued_at_ms != right_upload->second.queued_at_ms) {
                                return left_upload->second.queued_at_ms < right_upload->second.queued_at_ms;
                            }
                            return left < right;
                        });

                        const auto count = std::min(max_batch_size, coords.size());
                        snapshots.reserve(count);
                        metas.reserve(count);
                        for (std::size_t i = 0; i < count; ++i) {
                            auto pending = pending_chunk_uploads_.find(coords[i]);
                            if (pending == pending_chunk_uploads_.end()) {
                                continue;
                            }
                            snapshots.push_back(std::move(pending->second.snapshot));
                            metas.push_back(pending->second.meta);
                            pending_chunk_uploads_.erase(pending);
                        }
                        remaining = pending_chunk_uploads_.size();
                        if (pending_chunk_uploads_.empty()) {
                            pending_chunk_flush_deadline_ms_ = 0;
                        }
                    }
                }
            }

            if (waiting) {
                if (log_waiting) {
                    background_log_.info("Accumulating ", waiting_pending,
                                         " pending live map chunk upload(s); flushOrCooldownRemaining=",
                                         ready_remaining_ms / 1000, "s retryRemaining=",
                                         backoff_remaining_ms / 1000, "s.");
                }
                return queued_any;
            }

            if (snapshots.empty()) {
                return queued_any;
            }

            if (!enqueueUpload({UploadJob::Kind::ChunkBatch, "/api/plugin/tiles", "", metas, snapshots,
                                snapshots.size(), {}})) {
                restorePendingChunkUploads(std::move(snapshots), metas);
                const auto retry_after_ms = delayChunkBatchRetry();
                background_log_.warning("Delayed live map tile render batch because upload queue is full; retry in ",
                                        retry_after_ms / 1000, "s.");
                return queued_any;
            }
            queued_any = true;
            background_log_.info("Queued live map tile render batch with ", metas.size(),
                                 " chunk(s); pendingAfter=", remaining, ".");
        }
    }

    void confirmUploadedChunkBatch(const std::vector<ChunkUploadMeta> &chunks)
    {
        const auto current_ms = nowMs();
        const auto cooldown_until_ms =
            current_ms + static_cast<std::int64_t>(std::max(1, settings_.chunk_upload_cooldown_seconds)) * 1000;
        std::scoped_lock lock(state_mutex_);
        pruneChunkUploadCooldownsLocked(current_ms);
        for (const auto &chunk : chunks) {
            const auto confirmed = chunk_baselines_.find(chunk.coord);
            if (confirmed == chunk_baselines_.end() ||
                confirmed->second.updated_at_ms <= chunk.updated_at_ms) {
                chunk_baselines_[chunk.coord] = {chunk.coord, chunk.fingerprint, chunk.updated_at_ms};
                baselines_dirty_ = true;
            }
            auto &coord_cooldown_until_ms = chunk_upload_cooldown_until_ms_[chunk.coord];
            coord_cooldown_until_ms = std::max(coord_cooldown_until_ms, cooldown_until_ms);
            const auto pending = pending_chunk_uploads_.find(chunk.coord);
            if (pending != pending_chunk_uploads_.end()) {
                pending->second.ready_at_ms =
                    std::max(pending->second.ready_at_ms, coord_cooldown_until_ms);
            }
        }
    }

    void logCachedChunkSkips(bool force)
    {
        std::size_t skipped = 0;
        std::size_t backpressured = 0;
        const auto current_ms = nowMs();
        {
            std::scoped_lock lock(state_mutex_);
            if (skipped_cached_chunks_ == 0 && backpressured_pending_chunk_uploads_ == 0) {
                return;
            }
            if (!force && skipped_cached_chunks_ < 32 && backpressured_pending_chunk_uploads_ == 0 &&
                current_ms - last_chunk_cache_log_ms_ < 60000) {
                return;
            }
            skipped = skipped_cached_chunks_;
            backpressured = backpressured_pending_chunk_uploads_;
            skipped_cached_chunks_ = 0;
            backpressured_pending_chunk_uploads_ = 0;
            last_chunk_cache_log_ms_ = current_ms;
        }
        if (skipped > 0) {
            background_log_.info("Skipped ", skipped, " unchanged live map base chunk upload(s) from local baseline.");
        }
        if (backpressured > 0) {
            background_log_.warning("Deferred ", backpressured,
                                    " live map base chunk upload(s) because the pending chunk buffer is full; "
                                    "the latest chunks remain queued for resampling.");
        }
    }

    [[nodiscard]] static bool shouldBackoffChunkBatchRetry(const livemap::TransportResult &transport)
    {
        return transport.curl_code != 0 || transport.response_code == 0 || transport.response_code >= 500;
    }

    [[nodiscard]] static bool shouldSplitChunkBatchRetry(const livemap::TransportResult &transport,
                                                         const std::size_t chunk_count)
    {
        return chunk_count > 1 && (transport.response_code == 500 || transport.response_code == 503) &&
               (transport.body.find("1101") != std::string::npos ||
                transport.body.find("1102") != std::string::npos);
    }

    void processPlayerUploadResults()
    {
        if (player_dispatcher_ == nullptr) {
            return;
        }

        for (auto &result : player_dispatcher_->drainResults()) {
            const auto wait_ms = std::max<std::int64_t>(0, result.started_at_ms - result.queued_at_ms);
            const auto duration_ms = std::max<std::int64_t>(0, result.finished_at_ms - result.started_at_ms);
            if (result.transport.ok) {
                if (!result.player_avatar_acks.empty()) {
                    std::scoped_lock lock(state_mutex_);
                    for (const auto &avatar : result.player_avatar_acks) {
                        acknowledged_player_avatar_hashes_[avatar.player_id] = avatar.hash;
                    }
                }
                if (!last_player_success_log_count_.has_value() ||
                    last_player_success_log_count_.value() != result.update_count ||
                    result.finished_at_ms >= next_player_success_log_ms_) {
                    background_log_.info("Uploaded player snapshot for ", result.update_count, " player(s) HTTP ",
                                         result.transport.response_code, " wait=", wait_ms, "ms duration=", duration_ms,
                                         "ms pending=", player_dispatcher_->pendingJobs(), " replaced=",
                                         player_dispatcher_->replacedCount(), ".");
                    last_player_success_log_count_ = result.update_count;
                    next_player_success_log_ms_ = result.finished_at_ms + kPlayerSuccessLogIntervalMs;
                }
                continue;
            }
            getLogger().error("Failed to upload player snapshot HTTP {} curl {} error={}",
                              result.transport.response_code, result.transport.curl_code, result.transport.error);
            background_log_.warning("Dropped latest player snapshot upload for ", result.update_count,
                                    " player(s) HTTP ", result.transport.response_code, " curl ",
                                    result.transport.curl_code, " wait=", wait_ms, "ms duration=", duration_ms,
                                    "ms; next snapshot will replace it.");
        }
    }

    void processUploadResults()
    {
        processPlayerUploadResults();
        if (upload_dispatcher_ == nullptr) {
            return;
        }

        for (auto &result : upload_dispatcher_->drainResults()) {
            if (result.transport.ok) {
                if (result.kind == UploadJob::Kind::ChunkBatch) {
                    confirmUploadedChunkBatch(result.chunks);
                    resetChunkBatchRetry();
                    if (result.transport.body.find("\"r2MirrorOk\":false") != std::string::npos) {
                        background_log_.warning("Local live map tile batch committed, but the optional R2 mirror "
                                                "failed: ",
                                                responseSnippet(result.transport.body), ".");
                    }
                    background_log_.info("Rendered live map tile batch for ", result.chunks.size(),
                                         " chunk(s), notified local server HTTP ", result.transport.response_code,
                                         " response=", responseSnippet(result.transport.body), ".");
                    persistChunkBaselines();
                }
                else if (result.kind == UploadJob::Kind::Lands) {
                    background_log_.info("Uploaded ", result.update_count, " land claim(s) HTTP ",
                                         result.transport.response_code, ".");
                }
                else if (result.kind == UploadJob::Kind::TilePyramidRepair) {
                    if (result.transport.body.find("\"r2MirrorOk\":false") != std::string::npos) {
                        background_log_.warning("Local live map tile pyramid repair committed, but the optional R2 "
                                                "mirror failed: ",
                                                responseSnippet(result.transport.body), ".");
                    }
                    background_log_.info("Completed live map tile pyramid repair response=",
                                         responseSnippet(result.transport.body), ".");
                }
                continue;
            }

            if (result.kind == UploadJob::Kind::Lands) {
                getLogger().error("Failed to upload land claims HTTP {} curl {} error={}",
                                  result.transport.response_code, result.transport.curl_code, result.transport.error);
                continue;
            }

            if (result.kind == UploadJob::Kind::ChunkBatch) {
                getLogger().error("Failed to render/upload tile batch {} chunk(s) HTTP {} curl {} error={} body={}",
                                  result.chunks.size(), result.transport.response_code, result.transport.curl_code,
                                  result.transport.error, responseSnippet(result.transport.body));
                if (active_ && shouldBackoffChunkBatchRetry(result.transport)) {
                    restorePendingChunkUploads(std::move(result.snapshots), std::move(result.chunks));
                    const auto retry_after_ms = delayChunkBatchRetry();
                    if (shouldSplitChunkBatchRetry(result.transport, result.update_count)) {
                        settings_.chunk_upload_batch_size = std::max(1, settings_.chunk_upload_batch_size / 2);
                        background_log_.warning("Delayed retry for live map tile render batch by ",
                                                retry_after_ms / 1000, "s; reduced chunkUploadBatchSize=",
                                                settings_.chunk_upload_batch_size, " response=",
                                                responseSnippet(result.transport.body), ".");
                    }
                    else {
                        background_log_.warning("Delayed retry for failed live map tile render batch by ",
                                                retry_after_ms / 1000, "s; response=",
                                                responseSnippet(result.transport.body), ".");
                    }
                    continue;
                }
            }
            if (result.kind == UploadJob::Kind::TilePyramidRepair) {
                getLogger().error("Failed to repair live map tile pyramid HTTP {} curl {} error={} body={}",
                                  result.transport.response_code, result.transport.curl_code, result.transport.error,
                                  responseSnippet(result.transport.body));
                continue;
            }
            if (active_) {
                for (const auto &chunk : result.chunks) {
                    enqueueSeedChunk(chunk.coord, false);
                }
            }
        }
        flushPendingChunkUploads();
        logCachedChunkSkips(false);
    }

    void pulsePlayerSeedQueue()
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return;
        }

        const auto current_ms = nowMs();
        if (current_ms >= next_loaded_chunk_refresh_ms_) {
            refreshLoadedChunks();
            next_loaded_chunk_refresh_ms_ =
                current_ms + static_cast<std::int64_t>(std::max(5, settings_.chunk_refresh_seconds)) * 1000;
        }

        const auto newly_queued = queuePlayerSeedAreas();
        if (newly_queued > 0) {
            background_log_.info("Queued ", newly_queued, " player-radius live map base chunk(s).");
        }

        const auto chunks = drainSeedChunks(static_cast<std::size_t>(std::max(1, settings_.max_seed_chunks_per_pulse)));
        if (chunks.empty()) {
            flushPendingChunkUploads();
            return;
        }

        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return;
        }

        for (const auto &queued : chunks) {
            const auto &coord = queued.coord;
            auto *dimension = level->getDimension(coord.dimension);
            if (dimension == nullptr) {
                continue;
            }
            if (!isChunkLoaded(coord)) {
                if (deferSeedChunk(coord, queued.force)) {
                    background_log_.info("Deferred live map base chunk ", chunkName(coord),
                                         " until the chunk is loaded; force=", queued.force, ".");
                }
                continue;
            }
            auto snapshot = sampleChunk(*dimension, coord);
            if (!snapshot.has_value()) {
                enqueueSeedChunk(coord, false);
                continue;
            }
            if (livemap::isEmptyChunkSnapshot(*snapshot)) {
                background_log_.warning("Skipped empty live map chunk sample for ", chunkName(coord),
                                        "; dropped sample to avoid retrying unloaded chunks every tick.");
                continue;
            }
            const auto pending_result = queuePendingChunkUpload(std::move(*snapshot), queued.force);
            if (pending_result == PendingChunkQueueResult::Backpressured) {
                requeueSeedChunkAfterPendingBackpressure(coord, queued.force);
            }
        }
        flushPendingChunkUploads();
    }

    void publishDirtyBlocks()
    {
        if (!settings_.upload_chunks || !settings_.upload_dirty_blocks || settings_.plugin_token.empty()) {
            return;
        }

        std::vector<livemap::DirtyBlockColumn> dirty_columns;
        {
            std::scoped_lock lock(state_mutex_);
            dirty_columns = dirty_blocks_.drainForChunkLimit(
                static_cast<std::size_t>(std::max(1, settings_.max_dirty_blocks_per_push)),
                static_cast<std::size_t>(std::max(1, settings_.max_dirty_chunks_per_push)));
        }
        if (dirty_columns.empty()) {
            return;
        }
        std::set<livemap::ChunkCoord> chunks;
        for (const auto &dirty : dirty_columns) {
            chunks.insert(livemap::chunkForBlock(dirty.coord.world, dirty.coord.dimension, dirty.coord.x, dirty.coord.z));
        }
        std::size_t queued = 0;
        for (const auto &chunk : chunks) {
            queued += enqueueSeedChunk(chunk, true);
        }
        background_log_.info("Queued ", queued, " chunk resample(s) from ", dirty_columns.size(),
                             " dirty block column(s); local renderer will rewrite affected tiles.");
    }

    livemap::LiveMapSettings settings_;
    std::unique_ptr<LiveMapListener> listener_;
    std::shared_ptr<endstone::Task> player_task_;
    std::shared_ptr<endstone::Task> seed_task_;
    std::shared_ptr<endstone::Task> dirty_block_task_;
    std::shared_ptr<endstone::Task> land_task_;
    std::shared_ptr<endstone::Task> upload_result_task_;
    std::unique_ptr<UploadDispatcher> upload_dispatcher_;
    std::unique_ptr<LatestUploadDispatcher> player_dispatcher_;
    mutable std::mutex state_mutex_;
    std::atomic_bool active_{false};
    livemap::DirtyBlockTracker dirty_blocks_;
    std::deque<QueuedSeed> seed_queue_;
    std::unordered_set<livemap::ChunkCoord, livemap::ChunkCoordHash> queued_seed_chunks_;
    std::unordered_set<livemap::ChunkCoord, livemap::ChunkCoordHash> loaded_chunks_;
    std::unordered_map<livemap::ChunkCoord, bool, livemap::ChunkCoordHash> deferred_seed_chunks_;
    std::unordered_map<std::string, std::int64_t> player_next_seed_ms_;
    std::unordered_map<std::string, std::int64_t> player_first_seen_ms_;
    std::unordered_map<std::string, std::string> player_last_seed_center_;
    std::unordered_map<std::string, std::string> acknowledged_player_avatar_hashes_;
    std::unordered_map<livemap::ChunkCoord, PendingChunkUpload, livemap::ChunkCoordHash> pending_chunk_uploads_;
    std::unordered_map<livemap::ChunkCoord, std::int64_t, livemap::ChunkCoordHash> chunk_upload_cooldown_until_ms_;
    livemap::ChunkBaselineMap chunk_baselines_;
    bool baselines_dirty_ = false;
    std::filesystem::path background_log_path_;
    std::filesystem::path baseline_index_path_;
    BackgroundLog background_log_;
    std::optional<std::size_t> last_player_success_log_count_;
    std::int64_t next_player_success_log_ms_ = 0;
    std::int64_t pending_chunk_flush_deadline_ms_ = 0;
    std::int64_t chunk_upload_backoff_until_ms_ = 0;
    std::int64_t chunk_upload_retry_delay_ms_ = kChunkBatchRetryMinDelayMs;
    std::int64_t next_chunk_cooldown_prune_ms_ = 0;
    std::size_t skipped_cached_chunks_ = 0;
    std::size_t backpressured_pending_chunk_uploads_ = 0;
    std::int64_t last_chunk_cache_log_ms_ = 0;
    std::int64_t last_chunk_pending_log_ms_ = 0;
    std::int64_t next_loaded_chunk_refresh_ms_ = 0;
};

void LiveMapListener::onBlockPlace(endstone::BlockPlaceEvent &event)
{
    auto block = event.getBlockPlacedState().getBlock();
    if (block != nullptr) {
        plugin_.markBlock(*block);
    }
}

void LiveMapListener::onBlockBreak(endstone::BlockBreakEvent &event)
{
    plugin_.markBlock(event.getBlock());
}

void LiveMapListener::onBlockFromTo(endstone::BlockFromToEvent &event)
{
    plugin_.markBlock(event.getBlock());
    plugin_.markBlock(event.getToBlock());
}

void LiveMapListener::onBlockExplode(endstone::BlockExplodeEvent &event)
{
    plugin_.markBlock(event.getBlock());
    for (const auto &block : event.getBlockList()) {
        if (block != nullptr) {
            plugin_.markBlock(*block);
        }
    }
}

void LiveMapListener::onChunkLoad(endstone::ChunkLoadEvent &event)
{
    plugin_.handleChunkLoad(event.getChunk());
}

void LiveMapListener::onChunkUnload(endstone::ChunkUnloadEvent &event)
{
    plugin_.handleChunkUnload(event.getChunk());
}

}  // namespace

ENDSTONE_PLUGIN("live_map", "0.1.0", LiveMapPlugin)
{
    prefix = "LiveMap";
    description = "Realtime 2D web map publisher for Endstone servers";
    website = "https://github.com/wingxia/endstone-live-map";
    authors = {"Wing Xia"};

    command("livemap")
        .description("Inspect, repair, or queue live map sampling")
        .usages("/livemap", "/livemap <status>", "/livemap <render-near> [radius: int]",
                "/livemap <render-chunk> <chunkX: int> <chunkZ: int>",
                "/livemap <render-area> <minX: int> <minZ: int> <maxX: int> <maxZ: int>",
                "/livemap <repair-pyramid>", "/livemap <reload>")
        .permissions("livemap.command");

    permission("livemap.command")
        .description("Allow operators to inspect or queue live map rendering.")
        .default_(endstone::PermissionDefault::Operator);
}
