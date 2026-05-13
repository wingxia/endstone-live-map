#include "livemap/chunk.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"
#include "livemap/tile_math.hpp"

#include <endstone/endstone.hpp>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace livemap {
TransportResult postLiveJson(const LiveMapSettings &settings, std::string_view json);
TransportResult uploadChunkSnapshot(const LiveMapSettings &settings, const ChunkSnapshot &snapshot);
TransportResult uploadBlockUpdateBatch(const LiveMapSettings &settings, const BlockUpdateBatch &batch);
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
};

struct QueuedSeed {
    livemap::ChunkCoord coord;
    std::int64_t queued_at_ms{};
};

class LiveMapPlugin;

class LiveMapListener {
public:
    explicit LiveMapListener(LiveMapPlugin &plugin) : plugin_(plugin) {}

    void onBlockPlace(endstone::BlockPlaceEvent &event);
    void onBlockBreak(endstone::BlockBreakEvent &event);
    void onBlockFromTo(endstone::BlockFromToEvent &event);
    void onBlockExplode(endstone::BlockExplodeEvent &event);

private:
    LiveMapPlugin &plugin_;
};

class LiveMapPlugin : public endstone::Plugin {
public:
    void onEnable() override
    {
        const auto config_path = getDataFolder() / "live_map.json";
        if (!std::filesystem::exists(config_path)) {
            livemap::writeExampleSettings(config_path);
            getLogger().warning("Created {}, set plugin_token before enabling uploads.", config_path.string());
        }

        settings_ = livemap::loadSettings(config_path);
        active_ = true;
        listener_ = std::make_unique<LiveMapListener>(*this);
        registerEvent(&LiveMapListener::onBlockPlace, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockBreak, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockFromTo, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockExplode, *listener_, endstone::EventPriority::Monitor, true);

        const auto player_ticks = static_cast<std::uint64_t>(std::max(1, settings_.player_push_seconds) * 20);
        const auto seed_ticks = static_cast<std::uint64_t>(std::max(1, settings_.seed_pulse_seconds) * 20);
        const auto dirty_block_ticks = static_cast<std::uint64_t>(std::max(1, settings_.dirty_block_push_seconds) * 20);
        player_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishPlayers(); }, player_ticks,
                                                               player_ticks);
        seed_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { pulsePlayerSeedQueue(); }, seed_ticks,
                                                             seed_ticks);
        dirty_block_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishDirtyBlocks(); },
                                                                    dirty_block_ticks, dirty_block_ticks);

        getLogger().info(
            "Endstone Live Map enabled for {} with uploads players={} chunks={} dirtyBlocks={} autoSeedChunks={} "
            "legacyRadius={} playerSeedRadius={} playerSeedInterval={}s maxSeedPerPulse={} seedPulse={}s "
            "dirtyBlockPush={}s maxDirtyBlocks={} dimensions={}.",
            settings_.worker_url, settings_.upload_players, settings_.upload_chunks, settings_.upload_dirty_blocks,
            settings_.auto_seed_chunks, settings_.scan_radius_chunks, settings_.player_seed_radius_chunks,
            settings_.player_seed_interval_seconds, settings_.max_seed_chunks_per_pulse, settings_.seed_pulse_seconds,
            settings_.dirty_block_push_seconds, settings_.max_dirty_blocks_per_push, settings_.dimensions.size());
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
        getLogger().info("Endstone Live Map disabled");
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
                getLogger().info("Queued chunk {}/Overworld/{}/{} for live map sampling.", level->getName(), chunk_x,
                                 chunk_z);
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
            getLogger().info("Queued {} chunks for live map sampling with radius {}.", queued, radius);
            return true;
        }

        sender.sendMessage("Live map queued base chunks: " + std::to_string(seedQueueSize()) +
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

    std::size_t enqueueSeedChunk(const livemap::ChunkCoord &coord, bool force)
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return 0;
        }
        std::scoped_lock lock(state_mutex_);
        if (!force && queued_seed_chunks_.find(coord) != queued_seed_chunks_.end()) {
            return 0;
        }
        if (force) {
            queued_seed_chunks_.erase(coord);
        }
        if (!queued_seed_chunks_.insert(coord).second) {
            return 0;
        }
        seed_queue_.push({coord, nowMs()});
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
            const int chunk_x = livemap::floorDiv(static_cast<int>(std::floor(location.getX())), livemap::kChunkSize);
            const int chunk_z = livemap::floorDiv(static_cast<int>(std::floor(location.getZ())), livemap::kChunkSize);
            const auto center_key = std::to_string(chunk_x) + "/" + std::to_string(chunk_z);
            {
                std::scoped_lock lock(state_mutex_);
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
        return queued;
    }

    bool chunkIsLoaded(endstone::Dimension &dimension, int chunk_x, int chunk_z)
    {
        for (const auto &loaded : dimension.getLoadedChunks()) {
            if (loaded != nullptr && loaded->getX() == chunk_x && loaded->getZ() == chunk_z) {
                return true;
            }
        }
        return false;
    }

    std::vector<livemap::ChunkCoord> drainSeedChunks(std::size_t limit)
    {
        std::vector<livemap::ChunkCoord> chunks;
        std::scoped_lock lock(state_mutex_);
        while (!seed_queue_.empty() && chunks.size() < limit) {
            const auto queued = seed_queue_.front();
            seed_queue_.pop();
            queued_seed_chunks_.erase(queued.coord);
            chunks.push_back(queued.coord);
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

        const auto json = livemap::serializePlayerSnapshot(players);
        const auto settings = settings_;
        getServer().getScheduler().runTaskAsync(*this, [settings, json] {
            const auto result = livemap::postLiveJson(settings, json);
            if (result.ok) {
                return;
            }
            std::cerr << "[LiveMap] Failed to upload player snapshot HTTP " << result.response_code << " curl "
                      << result.curl_code;
            if (!result.error.empty()) {
                std::cerr << " error=" << result.error;
            }
            std::cerr << std::endl;
        });
    }

    std::optional<ColumnTop> sampleColumn(endstone::Dimension &dimension, int block_x, int block_z)
    {
        try {
            const int highest_y = dimension.getHighestBlockYAt(block_x, block_z);
            const auto block = dimension.getBlockAt(block_x, highest_y, block_z);
            if (block == nullptr) {
                return ColumnTop{};
            }
            return ColumnTop{block->getType(), block->getY()};
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
                const auto column = sampleColumn(dimension, block_x, block_z);
                if (!column.has_value()) {
                    return std::nullopt;
                }
                snapshot.blocks[index] = palette_index(column->block);
                snapshot.heights[index] = column->height;
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

    void pulsePlayerSeedQueue()
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return;
        }

        const auto newly_queued = queuePlayerSeedAreas();
        if (newly_queued > 0) {
            getLogger().info("Queued {} player-radius live map base chunk(s).", newly_queued);
        }

        const auto chunks = drainSeedChunks(static_cast<std::size_t>(std::max(1, settings_.max_seed_chunks_per_pulse)));
        if (chunks.empty()) {
            return;
        }
        getLogger().info("Sampling {} queued live map base chunk(s).", chunks.size());

        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return;
        }

        for (const auto &coord : chunks) {
            auto *dimension = level->getDimension(coord.dimension);
            if (dimension == nullptr) {
                continue;
            }
            if (!chunkIsLoaded(*dimension, coord.x, coord.z)) {
                enqueueSeedChunk(coord, false);
                getLogger().warning("Deferred live map base chunk {}/{}/{} because it is not loaded.", coord.world,
                                    coord.x, coord.z);
                continue;
            }

            auto snapshot = sampleChunk(*dimension, coord);
            if (!snapshot.has_value()) {
                enqueueSeedChunk(coord, false);
                continue;
            }
            cacheChunkSnapshot(*snapshot);

            const auto settings = settings_;
            getServer().getScheduler().runTaskAsync(*this, [this, settings, snapshot = std::move(*snapshot)] {
                const auto result = livemap::uploadChunkSnapshot(settings, snapshot);
                const auto chunk_name = snapshot.world + "/" + snapshot.dimension + "/" +
                                        std::to_string(snapshot.chunk_x) + "/" + std::to_string(snapshot.chunk_z);
                if (result.ok) {
                    std::cout << "[LiveMap] Uploaded chunk " << chunk_name << " HTTP " << result.response_code
                              << std::endl;
                    return;
                }
                std::cerr << "[LiveMap] Failed to upload chunk " << chunk_name << " HTTP " << result.response_code
                          << " curl " << result.curl_code;
                if (!result.error.empty()) {
                    std::cerr << " error=" << result.error;
                }
                std::cerr << std::endl;
                if (active_) {
                    enqueueSeedChunk({snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z}, false);
                }
            });
        }
    }

    void publishDirtyBlocks()
    {
        if (!settings_.upload_chunks || !settings_.upload_dirty_blocks || settings_.plugin_token.empty()) {
            return;
        }

        std::vector<livemap::DirtyBlockColumn> dirty_columns;
        {
            std::scoped_lock lock(state_mutex_);
            dirty_columns =
                dirty_blocks_.drain(static_cast<std::size_t>(std::max(1, settings_.max_dirty_blocks_per_push)));
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
        for (const auto &dirty : dirty_columns) {
            auto *dimension = level->getDimension(dirty.coord.dimension);
            if (dimension == nullptr) {
                continue;
            }
            const auto chunk = livemap::chunkForBlock(dirty.coord.world, dirty.coord.dimension, dirty.coord.x,
                                                      dirty.coord.z);
            if (!chunkIsLoaded(*dimension, chunk.x, chunk.z)) {
                requeueDirtyColumn(dirty);
                continue;
            }

            const auto cached = cachedColumn(dirty.coord);
            if (cached.has_value() && dirty.touched_y < cached->height) {
                ++skipped_below_top;
                continue;
            }

            const auto current = sampleColumn(*dimension, dirty.coord.x, dirty.coord.z);
            if (!current.has_value()) {
                requeueDirtyColumn(dirty);
                continue;
            }
            cacheColumn(dirty.coord, *current);

            if (!cached.has_value() && current->height > dirty.touched_y) {
                ++skipped_below_top;
                continue;
            }
            if (cached.has_value() && cached->height == current->height && cached->block == current->block) {
                continue;
            }

            grouped[chunk].push_back({
                livemap::localChunkCoord(dirty.coord.x, chunk.x),
                livemap::localChunkCoord(dirty.coord.z, chunk.z),
                current->block,
                current->height,
            });
        }

        if (grouped.empty()) {
            if (skipped_below_top > 0) {
                getLogger().info("Skipped {} live map dirty block column(s) below cached top blocks.",
                                 skipped_below_top);
            }
            return;
        }

        getLogger().info("Uploading live map dirty block updates for {} chunk(s).", grouped.size());
        const auto settings = settings_;
        for (const auto &[coord, updates] : grouped) {
            livemap::BlockUpdateBatch batch;
            batch.world = coord.world;
            batch.dimension = coord.dimension;
            batch.chunk_x = coord.x;
            batch.chunk_z = coord.z;
            batch.updates = updates;
            batch.updated_at_ms = nowMs();
            getServer().getScheduler().runTaskAsync(*this, [this, settings, batch = std::move(batch)] {
                const auto result = livemap::uploadBlockUpdateBatch(settings, batch);
                const auto chunk_name = batch.world + "/" + batch.dimension + "/" + std::to_string(batch.chunk_x) +
                                        "/" + std::to_string(batch.chunk_z);
                if (result.ok && !result.missing_base) {
                    std::cout << "[LiveMap] Uploaded " << batch.updates.size() << " dirty block update(s) for "
                              << chunk_name << " HTTP " << result.response_code << std::endl;
                    return;
                }
                if (result.missing_base) {
                    std::cerr << "[LiveMap] Dirty block update missing base chunk " << chunk_name
                              << "; queued base resample" << std::endl;
                    if (active_) {
                        enqueueSeedChunk({batch.world, batch.dimension, batch.chunk_x, batch.chunk_z}, false);
                    }
                    return;
                }
                std::cerr << "[LiveMap] Failed to upload dirty block updates for " << chunk_name << " HTTP "
                          << result.response_code << " curl " << result.curl_code;
                if (!result.error.empty()) {
                    std::cerr << " error=" << result.error;
                }
                std::cerr << std::endl;
                if (active_) {
                    enqueueSeedChunk({batch.world, batch.dimension, batch.chunk_x, batch.chunk_z}, false);
                }
            });
        }
    }

    livemap::LiveMapSettings settings_;
    std::unique_ptr<LiveMapListener> listener_;
    std::shared_ptr<endstone::Task> player_task_;
    std::shared_ptr<endstone::Task> seed_task_;
    std::shared_ptr<endstone::Task> dirty_block_task_;
    mutable std::mutex state_mutex_;
    std::atomic_bool active_{false};
    livemap::DirtyBlockTracker dirty_blocks_;
    std::queue<QueuedSeed> seed_queue_;
    std::unordered_set<livemap::ChunkCoord, livemap::ChunkCoordHash> queued_seed_chunks_;
    std::unordered_map<std::string, std::int64_t> player_next_seed_ms_;
    std::unordered_map<std::string, std::string> player_last_seed_center_;
    std::unordered_map<livemap::BlockColumnCoord, ColumnTop, livemap::BlockColumnCoordHash> top_cache_;
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
