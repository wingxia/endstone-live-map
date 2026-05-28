#include "livemap/baseline.hpp"
#include "livemap/chunk.hpp"
#include "livemap/land.hpp"
#include "livemap/map_blocks.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"
#include "livemap/tile_math.hpp"
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
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
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
    std::int64_t queued_at_ms{};
    bool force{};
};

struct ChunkUploadMeta {
    livemap::ChunkCoord coord;
    std::uint64_t fingerprint{};
    std::int64_t updated_at_ms{};
};

constexpr std::int64_t kChunkBatchRetryMinDelayMs = 30000;
constexpr std::int64_t kChunkBatchRetryMaxDelayMs = 300000;

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

std::vector<livemap::ChunkCoord> missingBaseChunksFromBody(const std::string &body)
{
    std::vector<livemap::ChunkCoord> chunks;
    std::size_t cursor = 0;
    while (true) {
        cursor = body.find("\"world\":\"", cursor);
        if (cursor == std::string::npos) {
            break;
        }
        cursor += 9;
        const auto world_end = body.find('"', cursor);
        if (world_end == std::string::npos) {
            break;
        }
        const auto world = body.substr(cursor, world_end - cursor);
        cursor = body.find("\"dimension\":\"", world_end);
        if (cursor == std::string::npos) {
            break;
        }
        cursor += 13;
        const auto dimension_end = body.find('"', cursor);
        if (dimension_end == std::string::npos) {
            break;
        }
        const auto dimension = body.substr(cursor, dimension_end - cursor);
        cursor = body.find("\"chunkX\":", dimension_end);
        if (cursor == std::string::npos) {
            break;
        }
        cursor += 9;
        char *end = nullptr;
        const auto chunk_x = static_cast<int>(std::strtol(body.c_str() + cursor, &end, 10));
        if (end == body.c_str() + cursor) {
            break;
        }
        cursor = body.find("\"chunkZ\":", static_cast<std::size_t>(end - body.c_str()));
        if (cursor == std::string::npos) {
            break;
        }
        cursor += 9;
        end = nullptr;
        const auto chunk_z = static_cast<int>(std::strtol(body.c_str() + cursor, &end, 10));
        if (end == body.c_str() + cursor) {
            break;
        }
        chunks.push_back({world, dimension, chunk_x, chunk_z});
        cursor = static_cast<std::size_t>(end - body.c_str());
    }
    return chunks;
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

struct UploadJob {
    enum class Kind {
        PlayerSnapshot,
        ChunkBatch,
        BlockUpdates,
        Lands,
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
};

class BackgroundLog {
public:
    bool open(const std::filesystem::path &path, std::string *error = nullptr)
    {
        try {
            std::scoped_lock lock(mutex_);
            path_ = path;
            std::filesystem::create_directories(path.parent_path());
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
        out_ << nowMs() << '\t' << level << '\t';
        (out_ << ... << values);
        out_ << '\n';
        out_.flush();
    }

    std::mutex mutex_;
    std::filesystem::path path_;
    std::ofstream out_;
};

class UploadDispatcher {
public:
    UploadDispatcher(livemap::LiveMapSettings settings, std::size_t max_queue_size)
        : settings_(std::move(settings)), max_queue_size_(std::max<std::size_t>(1, max_queue_size)),
          worker_([this] { workerLoop(); })
    {
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
        cv_.notify_one();
        if (worker_.joinable()) {
            worker_.join();
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
            auto transport = livemap::postPluginJson(settings_, job.path, job.json);
            const auto finished_at_ms = nowMs();
            {
                std::scoped_lock lock(mutex_);
                results_.push_back({job.kind, std::move(job.chunks), std::move(job.snapshots), job.update_count,
                                    std::move(job.resample_after_success_chunks), job.queued_at_ms, started_at_ms,
                                    finished_at_ms, std::move(transport)});
            }
        }
    }

    [[nodiscard]] static livemap::UploadPriority priorityFor(UploadJob::Kind kind)
    {
        switch (kind) {
        case UploadJob::Kind::BlockUpdates:
            return livemap::UploadPriority::High;
        case UploadJob::Kind::ChunkBatch:
            return livemap::UploadPriority::Normal;
        case UploadJob::Kind::Lands:
            return livemap::UploadPriority::Low;
        case UploadJob::Kind::PlayerSnapshot:
            return livemap::UploadPriority::High;
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
    std::thread worker_;
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

    void publish(std::string json, std::size_t item_count)
    {
        {
            std::scoped_lock lock(mutex_);
            const bool replaced = pending_.replace({std::move(json), item_count, nowMs()});
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
                                    payload.queued_at_ms, started_at_ms, finished_at_ms, std::move(transport)});
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
            "Endstone Live Map enabled for ", settings_.worker_url, " with uploads players=", settings_.upload_players,
            " chunks=", settings_.upload_chunks, " dirtyBlocks=", settings_.upload_dirty_blocks,
            " autoSeedChunks=", settings_.auto_seed_chunks, " legacyRadius=", settings_.scan_radius_chunks,
            " playerSeedRadius=", settings_.player_seed_radius_chunks,
            " playerSeedInterval=", settings_.player_seed_interval_seconds, "s maxSeedPerPulse=",
            settings_.max_seed_chunks_per_pulse, " seedPulse=", settings_.seed_pulse_seconds,
            "s playerSeedJoinDelay=", settings_.player_seed_join_delay_seconds, "s chunkUploadBatch=",
            settings_.chunk_upload_batch_size, " chunkUploadFlush=", settings_.chunk_upload_flush_seconds,
            "s httpTimeout=", settings_.http_timeout_seconds, "s dirtyBlockPush=", settings_.dirty_block_push_seconds,
            "s maxDirtyBlocks=",
            settings_.max_dirty_blocks_per_push, " maxDirtyChunks=", settings_.max_dirty_chunks_per_push,
            " maxUploadQueue=", settings_.max_upload_queue_size,
            " uploadLands=", settings_.upload_lands, " landPush=", settings_.land_push_seconds,
            "s landConfig=", settings_.land_config_file, " dimensions=", settings_.dimensions.size(),
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

        sender.sendMessage("Live map queued base chunks: " + std::to_string(seedQueueSize()) +
                           ", deferred base chunks: " + std::to_string(deferredSeedQueueSize()) +
                           ", dirty block columns: " + std::to_string(dirtyCount()));
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

    bool deferSeedChunk(const livemap::ChunkCoord &coord, bool force)
    {
        std::scoped_lock lock(state_mutex_);
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
            if (force) {
                queued_seed_chunks_.erase(coord);
            }
            if (queued_seed_chunks_.insert(coord).second) {
                seed_queue_.push_back({coord, nowMs(), force});
                queued = true;
            }
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
        std::scoped_lock lock(state_mutex_);
        loaded_chunks_ = std::move(loaded);
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
        if (!force && queued_seed_chunks_.find(coord) != queued_seed_chunks_.end()) {
            return 0;
        }
        if (force) {
            queued_seed_chunks_.erase(coord);
        }
        if (!queued_seed_chunks_.insert(coord).second) {
            return 0;
        }
        seed_queue_.push_back({coord, nowMs(), force});
        return 1;
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
        while (!seed_queue_.empty() && chunks.size() < limit) {
            const auto queued = seed_queue_.front();
            seed_queue_.pop_front();
            queued_seed_chunks_.erase(queued.coord);
            chunks.push_back(queued);
        }
        return chunks;
    }

    void publishPlayers()
    {
        if (!settings_.upload_players || settings_.plugin_token.empty()) {
            return;
        }

        std::vector<livemap::PlayerState> players;
        for (auto *player : getServer().getOnlinePlayers()) {
            if (player == nullptr) {
                continue;
            }
            const auto location = player->getLocation();
            auto &dimension = location.getDimension();
            players.push_back({
                player->getUniqueId().str(),
                player->getName(),
                dimension.getLevel().getName(),
                dimension.getName(),
                location.getX(),
                location.getY(),
                location.getZ(),
                location.getYaw(),
                location.getPitch(),
                nowMs(),
            });
        }
        if (players.empty()) {
            return;
        }

        if (player_dispatcher_ == nullptr) {
            background_log_.warning("Dropped live map player snapshot because player upload dispatcher is unavailable.");
            return;
        }
        player_dispatcher_->publish(livemap::serializePlayerSnapshot(players), players.size());
    }

    void publishLands()
    {
        if (!settings_.upload_lands || settings_.plugin_token.empty()) {
            return;
        }

        auto *level = getServer().getLevel();
        const auto world = level == nullptr ? std::string{"Bedrock level"} : level->getName();
        const auto parsed = livemap::loadLandConfig(resolveDataPath(settings_.land_config_file), world, nowMs());
        if (parsed.claims.empty() && parsed.skipped_entries == 0) {
            return;
        }

        if (!enqueueUpload({UploadJob::Kind::Lands, "/api/plugin/lands", livemap::serializeLandBatch(parsed.claims),
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

    void cacheChunkSnapshot(const livemap::ChunkSnapshot &snapshot)
    {
        std::scoped_lock lock(state_mutex_);
        for (int local_z = 0; local_z < livemap::kChunkSize; ++local_z) {
            for (int local_x = 0; local_x < livemap::kChunkSize; ++local_x) {
                const int index = local_z * livemap::kChunkSize + local_x;
                const int block_x = snapshot.chunk_x * livemap::kChunkSize + local_x;
                const int block_z = snapshot.chunk_z * livemap::kChunkSize + local_z;
                top_cache_[livemap::columnForBlock(snapshot.world, snapshot.dimension, block_x, block_z)] = {
                    snapshot.palette[snapshot.blocks[index]],
                    snapshot.heights[index],
                };
            }
        }
    }

    void cacheColumn(const livemap::BlockColumnCoord &coord, const ColumnTop &column)
    {
        std::scoped_lock lock(state_mutex_);
        top_cache_[coord] = column;
    }

    std::optional<ColumnTop> cachedColumn(const livemap::BlockColumnCoord &coord) const
    {
        std::scoped_lock lock(state_mutex_);
        const auto found = top_cache_.find(coord);
        if (found == top_cache_.end()) {
            return std::nullopt;
        }
        return found->second;
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

    bool queuePendingChunkUpload(livemap::ChunkSnapshot snapshot, bool force = false)
    {
        const auto coord = chunkCoordForSnapshot(snapshot);
        const auto fingerprint = livemap::fingerprintChunkSnapshot(snapshot);
        std::scoped_lock lock(state_mutex_);

        const auto confirmed = chunk_baselines_.find(coord);
        if (!force && confirmed != chunk_baselines_.end() && confirmed->second.fingerprint == fingerprint) {
            confirmed_chunk_snapshots_[coord] = std::move(snapshot);
            ++skipped_cached_chunks_;
            return false;
        }

        const auto pending = pending_chunk_fingerprints_.find(coord);
        if (!force && pending != pending_chunk_fingerprints_.end() && pending->second == fingerprint) {
            ++skipped_cached_chunks_;
            return false;
        }

        const auto meta = ChunkUploadMeta{coord, fingerprint, snapshot.updated_at_ms};
        pending_chunk_fingerprints_[coord] = fingerprint;
        for (std::size_t i = 0; i < pending_chunk_uploads_.size(); ++i) {
            if (pending_chunk_metas_[i].coord == coord) {
                pending_chunk_uploads_[i] = std::move(snapshot);
                pending_chunk_metas_[i] = meta;
                return true;
            }
        }

        if (pending_chunk_uploads_.empty()) {
            last_chunk_upload_flush_ms_ = nowMs();
        }
        pending_chunk_uploads_.push_back(std::move(snapshot));
        pending_chunk_metas_.push_back(meta);
        return true;
    }

    void restorePendingChunkUploads(std::vector<livemap::ChunkSnapshot> snapshots, std::vector<ChunkUploadMeta> metas)
    {
        if (snapshots.empty()) {
            return;
        }

        std::scoped_lock lock(state_mutex_);
        if (pending_chunk_uploads_.empty()) {
            last_chunk_upload_flush_ms_ = nowMs();
        }
        for (std::size_t i = 0; i < snapshots.size(); ++i) {
            auto existing = pending_chunk_fingerprints_.find(metas[i].coord);
            if (existing != pending_chunk_fingerprints_.end() && existing->second != metas[i].fingerprint) {
                continue;
            }
            pending_chunk_fingerprints_[metas[i].coord] = metas[i].fingerprint;
            auto pending = std::find_if(pending_chunk_metas_.begin(), pending_chunk_metas_.end(),
                                        [&metas, i](const ChunkUploadMeta &meta) {
                                            return meta.coord == metas[i].coord;
                                        });
            if (pending != pending_chunk_metas_.end()) {
                const auto index = static_cast<std::size_t>(std::distance(pending_chunk_metas_.begin(), pending));
                pending_chunk_uploads_[index] = std::move(snapshots[i]);
                pending_chunk_metas_[index] = metas[i];
                continue;
            }
            pending_chunk_uploads_.push_back(std::move(snapshots[i]));
            pending_chunk_metas_.push_back(metas[i]);
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

    bool flushPendingChunkUploads(bool force)
    {
        std::vector<livemap::ChunkSnapshot> snapshots;
        std::vector<ChunkUploadMeta> metas;
        const auto current_ms = nowMs();
        const auto max_batch_size = static_cast<std::size_t>(std::max(1, settings_.chunk_upload_batch_size));
        const auto flush_ms = static_cast<std::int64_t>(std::max(1, settings_.chunk_upload_flush_seconds)) * 1000;
        {
            std::scoped_lock lock(state_mutex_);
            if (pending_chunk_uploads_.empty()) {
                return false;
            }
            if (current_ms < chunk_upload_backoff_until_ms_) {
                return false;
            }
            if (!force && pending_chunk_uploads_.size() < max_batch_size &&
                current_ms - last_chunk_upload_flush_ms_ < flush_ms) {
                return false;
            }

            const auto count = std::min(max_batch_size, pending_chunk_uploads_.size());
            snapshots.reserve(count);
            metas.reserve(count);
            for (std::size_t i = 0; i < count; ++i) {
                snapshots.push_back(std::move(pending_chunk_uploads_[i]));
                metas.push_back(pending_chunk_metas_[i]);
                pending_chunk_fingerprints_.erase(pending_chunk_metas_[i].coord);
            }
            pending_chunk_uploads_.erase(pending_chunk_uploads_.begin(), pending_chunk_uploads_.begin() + count);
            pending_chunk_metas_.erase(pending_chunk_metas_.begin(), pending_chunk_metas_.begin() + count);
            last_chunk_upload_flush_ms_ = current_ms;
        }

        if (snapshots.empty()) {
            return false;
        }

        const auto json = livemap::serializeChunkBatch(snapshots, true, livemap::ChunkBatchStorage::Region);
        if (!enqueueUpload({UploadJob::Kind::ChunkBatch, "/api/plugin/chunks/batch", json, metas, snapshots,
                            snapshots.size(), {}})) {
            restorePendingChunkUploads(std::move(snapshots), metas);
            background_log_.warning("Delayed live map chunk batch upload because upload queue is full.");
            return false;
        }
        return true;
    }

    void confirmUploadedChunkBatch(const std::vector<ChunkUploadMeta> &chunks)
    {
        std::scoped_lock lock(state_mutex_);
        for (const auto &chunk : chunks) {
            chunk_baselines_[chunk.coord] = {chunk.coord, chunk.fingerprint, chunk.updated_at_ms};
            baselines_dirty_ = true;
        }
    }

    void removeConfirmedChunkBaselines(const std::vector<ChunkUploadMeta> &chunks)
    {
        std::scoped_lock lock(state_mutex_);
        for (const auto &chunk : chunks) {
            chunk_baselines_.erase(chunk.coord);
            confirmed_chunk_snapshots_.erase(chunk.coord);
            baselines_dirty_ = true;
        }
    }

    void confirmUploadedChunkSnapshots(const std::vector<livemap::ChunkSnapshot> &snapshots)
    {
        std::scoped_lock lock(state_mutex_);
        for (const auto &snapshot : snapshots) {
            confirmed_chunk_snapshots_[chunkCoordForSnapshot(snapshot)] = snapshot;
        }
    }

    std::optional<ChunkUploadMeta> prepareDirtyBaselineMeta(
        const livemap::ChunkCoord &coord, const std::vector<livemap::BlockColumnUpdate> &updates,
        std::int64_t updated_at_ms, bool &resample_after_success,
        std::vector<livemap::ChunkSnapshot> &updated_snapshots)
    {
        std::scoped_lock lock(state_mutex_);
        const auto baseline = chunk_baselines_.find(coord);
        if (baseline == chunk_baselines_.end()) {
            return std::nullopt;
        }

        const auto snapshot = confirmed_chunk_snapshots_.find(coord);
        if (snapshot == confirmed_chunk_snapshots_.end()) {
            resample_after_success = true;
            return ChunkUploadMeta{coord, baseline->second.fingerprint, baseline->second.updated_at_ms};
        }

        auto updated_snapshot = snapshot->second;
        livemap::applyBlockUpdatesToSnapshot(updated_snapshot, updates, updated_at_ms);
        const auto fingerprint = livemap::fingerprintChunkSnapshot(updated_snapshot);
        updated_snapshots.push_back(std::move(updated_snapshot));
        return ChunkUploadMeta{coord, fingerprint, updated_at_ms};
    }

    void logCachedChunkSkips(bool force)
    {
        std::size_t skipped = 0;
        const auto current_ms = nowMs();
        {
            std::scoped_lock lock(state_mutex_);
            if (skipped_cached_chunks_ == 0) {
                return;
            }
            if (!force && skipped_cached_chunks_ < 32 &&
                current_ms - last_chunk_cache_log_ms_ < 60000) {
                return;
            }
            skipped = skipped_cached_chunks_;
            skipped_cached_chunks_ = 0;
            last_chunk_cache_log_ms_ = current_ms;
        }
        background_log_.info("Skipped ", skipped, " unchanged live map base chunk upload(s) from local baseline.");
    }

    [[nodiscard]] static bool shouldBackoffChunkBatchRetry(const livemap::TransportResult &transport)
    {
        return transport.curl_code != 0 || transport.response_code == 0 || transport.response_code >= 500;
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
                background_log_.info("Uploaded player snapshot for ", result.update_count, " player(s) HTTP ",
                                     result.transport.response_code, " wait=", wait_ms, "ms duration=", duration_ms,
                                     "ms pending=", player_dispatcher_->pendingJobs(), " replaced=",
                                     player_dispatcher_->replacedCount(), ".");
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
            if (result.transport.ok && !result.transport.missing_base) {
                if (result.kind == UploadJob::Kind::ChunkBatch) {
                    confirmUploadedChunkBatch(result.chunks);
                    confirmUploadedChunkSnapshots(result.snapshots);
                    resetChunkBatchRetry();
                    background_log_.info("Uploaded chunk batch ", result.chunks.size(), " chunk(s) HTTP ",
                                         result.transport.response_code, ".");
                    persistChunkBaselines();
                }
                else if (result.kind == UploadJob::Kind::BlockUpdates) {
                    confirmUploadedChunkBatch(result.chunks);
                    confirmUploadedChunkSnapshots(result.snapshots);
                    background_log_.info("Uploaded ", result.update_count, " dirty block update(s) for ",
                                         result.chunks.size(), " chunk(s) HTTP ", result.transport.response_code, ".");
                    if (!result.resample_after_success_chunks.empty() && active_) {
                        for (const auto &chunk : result.resample_after_success_chunks) {
                            enqueueSeedChunk(chunk, true);
                        }
                        background_log_.info("Queued ", result.resample_after_success_chunks.size(),
                                             " base resample(s) after dirty update batch",
                                             " because confirmed snapshot was not available.");
                    }
                    persistChunkBaselines();
                }
                else if (result.kind == UploadJob::Kind::Lands) {
                    background_log_.info("Uploaded ", result.update_count, " land claim(s) HTTP ",
                                         result.transport.response_code, ".");
                }
                continue;
            }

            if (result.kind == UploadJob::Kind::Lands) {
                getLogger().error("Failed to upload land claims HTTP {} curl {} error={}",
                                  result.transport.response_code, result.transport.curl_code, result.transport.error);
                continue;
            }

            if (result.kind == UploadJob::Kind::BlockUpdates && result.transport.missing_base) {
                auto missing_chunks = missingBaseChunksFromBody(result.transport.body);
                if (missing_chunks.empty()) {
                    for (const auto &chunk : result.chunks) {
                        missing_chunks.push_back(chunk.coord);
                    }
                }
                std::vector<ChunkUploadMeta> missing_metas;
                missing_metas.reserve(missing_chunks.size());
                for (const auto &missing : missing_chunks) {
                    missing_metas.push_back({missing, 0, 0});
                }
                std::vector<ChunkUploadMeta> uploaded_metas;
                for (const auto &chunk : result.chunks) {
                    if (std::find(missing_chunks.begin(), missing_chunks.end(), chunk.coord) == missing_chunks.end()) {
                        uploaded_metas.push_back(chunk);
                    }
                }
                std::vector<livemap::ChunkSnapshot> uploaded_snapshots;
                for (const auto &snapshot : result.snapshots) {
                    if (std::find(missing_chunks.begin(), missing_chunks.end(), chunkCoordForSnapshot(snapshot)) ==
                        missing_chunks.end()) {
                        uploaded_snapshots.push_back(snapshot);
                    }
                }
                if (!uploaded_metas.empty()) {
                    confirmUploadedChunkBatch(uploaded_metas);
                    confirmUploadedChunkSnapshots(uploaded_snapshots);
                    if (!result.resample_after_success_chunks.empty() && active_) {
                        for (const auto &chunk : result.resample_after_success_chunks) {
                            if (std::find(missing_chunks.begin(), missing_chunks.end(), chunk) != missing_chunks.end()) {
                                continue;
                            }
                            enqueueSeedChunk(chunk, true);
                        }
                    }
                }
                removeConfirmedChunkBaselines(missing_metas);
                background_log_.warning("Dirty block batch missing ", missing_chunks.size(),
                                        " base chunk(s); queued base resample.");
                persistChunkBaselines();
                if (active_) {
                    for (const auto &chunk : missing_chunks) {
                        enqueueSeedChunk(chunk, false);
                    }
                }
                continue;
            }

            if (result.kind == UploadJob::Kind::ChunkBatch) {
                getLogger().error("Failed to upload chunk batch {} chunk(s) HTTP {} curl {} error={} body={}",
                                  result.chunks.size(), result.transport.response_code, result.transport.curl_code,
                                  result.transport.error, responseSnippet(result.transport.body));
                if (active_ && shouldBackoffChunkBatchRetry(result.transport)) {
                    restorePendingChunkUploads(std::move(result.snapshots), std::move(result.chunks));
                    const auto retry_after_ms = delayChunkBatchRetry();
                    background_log_.warning("Delayed retry for failed live map chunk batch by ",
                                            retry_after_ms / 1000, "s; response=", responseSnippet(result.transport.body),
                                            ".");
                    continue;
                }
            }
            else {
                const auto name = result.chunks.empty() ? std::string{"unknown"} : chunkName(result.chunks[0].coord);
                getLogger().error("Failed to upload dirty block updates for {} HTTP {} curl {} error={}", name,
                                  result.transport.response_code, result.transport.curl_code, result.transport.error);
            }
            if (active_) {
                for (const auto &chunk : result.chunks) {
                    enqueueSeedChunk(chunk.coord, false);
                }
            }
        }
        flushPendingChunkUploads(false);
        logCachedChunkSkips(false);
    }

    void pulsePlayerSeedQueue()
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return;
        }

        const auto newly_queued = queuePlayerSeedAreas();
        if (newly_queued > 0) {
            background_log_.info("Queued ", newly_queued, " player-radius live map base chunk(s).");
        }

        const auto chunks = drainSeedChunks(static_cast<std::size_t>(std::max(1, settings_.max_seed_chunks_per_pulse)));
        if (chunks.empty()) {
            flushPendingChunkUploads(false);
            return;
        }

        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return;
        }

        bool force_flush = false;
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
            cacheChunkSnapshot(*snapshot);

            force_flush = force_flush || queued.force;
            queuePendingChunkUpload(std::move(*snapshot), queued.force);
        }
        flushPendingChunkUploads(force_flush);
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

        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return;
        }

        std::map<livemap::ChunkCoord, std::vector<livemap::BlockColumnUpdate>> grouped;
        int skipped_below_top = 0;
        int queued_overlay_resamples = 0;
        for (const auto &dirty : dirty_columns) {
            auto *dimension = level->getDimension(dirty.coord.dimension);
            if (dimension == nullptr) {
                continue;
            }
            const auto chunk = livemap::chunkForBlock(dirty.coord.world, dirty.coord.dimension, dirty.coord.x,
                                                      dirty.coord.z);
            const auto cached = cachedColumn(dirty.coord);
            if (cached.has_value() && dirty.touched_y < cached->height) {
                ++skipped_below_top;
                continue;
            }

            const auto had_cached_column = cached.has_value();
            const auto current_sample = sampleColumnForMap(*dimension, dirty.coord.x, dirty.coord.z);
            if (!current_sample.has_value()) {
                requeueDirtyColumn(dirty);
                continue;
            }
            const auto current = current_sample->surface;
            const auto overlay = current_sample->overlay;

            if (!had_cached_column && current.height > dirty.touched_y) {
                cacheColumn(dirty.coord, current);
                ++skipped_below_top;
                continue;
            }

            if (cached.has_value() && cached->height == current.height && cached->block == current.block) {
                if (dirty.touched_y >= current.height) {
                    queued_overlay_resamples += static_cast<int>(enqueueSeedChunk(chunk, true));
                }
                continue;
            }

            cacheColumn(dirty.coord, current);
            grouped[chunk].push_back({
                livemap::localChunkCoord(dirty.coord.x, chunk.x),
                livemap::localChunkCoord(dirty.coord.z, chunk.z),
                current.block,
                current.height,
                current.state,
                overlay.block,
                overlay.height,
                overlay.state,
            });
        }

        if (grouped.empty()) {
            if (skipped_below_top > 0) {
                background_log_.info("Skipped ", skipped_below_top,
                                     " live map dirty block column(s) below cached top blocks.");
            }
            if (queued_overlay_resamples > 0) {
                background_log_.info("Queued ", queued_overlay_resamples,
                                     " live map chunk resample(s) for decoration-only column changes.");
            }
            return;
        }

        if (queued_overlay_resamples > 0) {
            background_log_.info("Queued ", queued_overlay_resamples,
                                 " live map chunk resample(s) for decoration-only column changes.");
        }
        background_log_.info("Uploading live map dirty block updates for ", grouped.size(), " chunk(s) in one batch.");
        std::vector<livemap::BlockUpdateBatch> batches;
        std::vector<ChunkUploadMeta> metas;
        std::vector<livemap::ChunkSnapshot> updated_snapshots;
        std::vector<livemap::ChunkCoord> resample_after_success_chunks;
        std::size_t update_count = 0;
        batches.reserve(grouped.size());
        metas.reserve(grouped.size());
        resample_after_success_chunks.reserve(grouped.size());
        for (const auto &[coord, updates] : grouped) {
            livemap::BlockUpdateBatch batch;
            batch.world = coord.world;
            batch.dimension = coord.dimension;
            batch.chunk_x = coord.x;
            batch.chunk_z = coord.z;
            batch.updates = updates;
            batch.updated_at_ms = nowMs();
            bool chunk_resample_after_success = false;
            const auto meta = prepareDirtyBaselineMeta(coord, updates, batch.updated_at_ms,
                                                       chunk_resample_after_success, updated_snapshots);
            if (!meta.has_value()) {
                enqueueSeedChunk(coord, false);
                background_log_.warning("Queued base resample for ", chunkName(coord),
                                        " because dirty update has no local baseline.");
                continue;
            }
            if (chunk_resample_after_success) {
                resample_after_success_chunks.push_back(coord);
            }
            metas.push_back(*meta);
            update_count += updates.size();
            batches.push_back(std::move(batch));
        }
        if (batches.empty()) {
            return;
        }
        if (!enqueueUpload({UploadJob::Kind::BlockUpdates, "/api/plugin/block-updates/batch",
                            livemap::serializeBlockUpdateBatches(batches), metas, updated_snapshots, update_count,
                            resample_after_success_chunks})) {
            for (const auto &meta : metas) {
                enqueueSeedChunk(meta.coord, false);
            }
            background_log_.warning("Queued ", metas.size(),
                                    " base resample(s) because dirty block batch upload queue is full.");
        }
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
    std::unordered_map<livemap::BlockColumnCoord, ColumnTop, livemap::BlockColumnCoordHash> top_cache_;
    std::vector<livemap::ChunkSnapshot> pending_chunk_uploads_;
    std::vector<ChunkUploadMeta> pending_chunk_metas_;
    std::unordered_map<livemap::ChunkCoord, std::uint64_t, livemap::ChunkCoordHash> pending_chunk_fingerprints_;
    livemap::ChunkBaselineMap chunk_baselines_;
    std::unordered_map<livemap::ChunkCoord, livemap::ChunkSnapshot, livemap::ChunkCoordHash> confirmed_chunk_snapshots_;
    bool baselines_dirty_ = false;
    std::filesystem::path background_log_path_;
    std::filesystem::path baseline_index_path_;
    BackgroundLog background_log_;
    std::int64_t last_chunk_upload_flush_ms_ = 0;
    std::int64_t chunk_upload_backoff_until_ms_ = 0;
    std::int64_t chunk_upload_retry_delay_ms_ = kChunkBatchRetryMinDelayMs;
    std::size_t skipped_cached_chunks_ = 0;
    std::int64_t last_chunk_cache_log_ms_ = 0;
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
        .description("Inspect or queue live map sampling")
        .usages("/livemap", "/livemap <render-near> [radius: int]", "/livemap <render-chunk> <chunkX: int> <chunkZ: int>")
        .permissions("livemap.command");

    permission("livemap.command")
        .description("Allow operators to inspect or queue live map rendering.")
        .default_(endstone::PermissionDefault::Operator);
}
