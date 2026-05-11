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
#include <memory>
#include <mutex>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace livemap {
bool postLiveJson(const LiveMapSettings &settings, std::string_view json);
bool uploadChunkSnapshot(const LiveMapSettings &settings, const ChunkSnapshot &snapshot);
}  // namespace livemap

namespace {

std::int64_t nowMs()
{
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

bool isAirBlock(const std::string &type)
{
    return type == "minecraft:air" || type == "minecraft:cave_air" || type == "minecraft:void_air";
}

struct TopBlockSample {
    std::string type = "minecraft:air";
    int y = -64;
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
        listener_ = std::make_unique<LiveMapListener>(*this);
        registerEvent(&LiveMapListener::onBlockPlace, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockBreak, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockFromTo, *listener_, endstone::EventPriority::Monitor, true);
        registerEvent(&LiveMapListener::onBlockExplode, *listener_, endstone::EventPriority::Monitor, true);

        const auto player_ticks = static_cast<std::uint64_t>(std::max(1, settings_.player_push_seconds) * 20);
        const auto chunk_ticks = static_cast<std::uint64_t>(std::max(5, settings_.chunk_refresh_seconds) * 20);
        player_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishPlayers(); }, player_ticks,
                                                               player_ticks);
        chunk_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishDirtyChunks(); }, chunk_ticks,
                                                              chunk_ticks);

        getLogger().info("Endstone Live Map enabled for {}", settings_.worker_url);
    }

    void onDisable() override
    {
        if (player_task_ != nullptr) {
            player_task_->cancel();
        }
        if (chunk_task_ != nullptr) {
            chunk_task_->cancel();
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
                int queued = 0;
                {
                    std::scoped_lock lock(dirty_mutex_);
                    queued = dirty_.markChunk({level->getName(), "Overworld", chunk_x, chunk_z}) ? 1 : 0;
                }
                sender.sendMessage("Queued " + std::to_string(queued) + " chunk for live map sampling.");
                getLogger().info("Queued chunk {}/Overworld/{}/{} for live map sampling.", level->getName(), chunk_x,
                                 chunk_z);
                if (queued > 0) {
                    publishDirtyChunks();
                }
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
            const auto queued = seedChunksNearPlayers(radius);
            sender.sendMessage("Queued " + std::to_string(queued) + " chunks for live map sampling.");
            getLogger().info("Queued {} chunks for live map sampling with radius {}.", queued, radius);
            return true;
        }

        sender.sendMessage("Live map dirty chunks: " + std::to_string(dirtyCount()));
        return true;
    }

    void markBlock(const endstone::Block &block)
    {
        auto &dimension = block.getDimension();
        if (!dimensionEnabled(dimension.getName())) {
            return;
        }
        std::scoped_lock lock(dirty_mutex_);
        dirty_.markBlock(dimension.getLevel().getName(), dimension.getName(), block.getX(), block.getZ());
    }

    [[nodiscard]] std::size_t dirtyCount() const
    {
        std::scoped_lock lock(dirty_mutex_);
        return dirty_.size();
    }

private:
    [[nodiscard]] bool dimensionEnabled(const std::string &dimension) const
    {
        return std::find(settings_.dimensions.begin(), settings_.dimensions.end(), dimension) !=
               settings_.dimensions.end();
    }

    std::size_t markChunkSquare(const std::string &world, const std::string &dimension, int center_x, int center_z,
                                int radius)
    {
        std::size_t queued = 0;
        for (int dz = -radius; dz <= radius; ++dz) {
            for (int dx = -radius; dx <= radius; ++dx) {
                if (dirty_.markChunk({world, dimension, center_x + dx, center_z + dz})) {
                    ++queued;
                }
            }
        }
        return queued;
    }

    std::size_t seedChunksNearPlayers(int radius)
    {
        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return 0;
        }

        std::size_t queued = 0;
        std::scoped_lock lock(dirty_mutex_);
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
            queued += markChunkSquare(dimension.getLevel().getName(), dimension.getName(), chunk_x, chunk_z, radius);
        }

        if (queued == 0) {
            for (const auto &dimension_name : settings_.dimensions) {
                auto *dimension = level->getDimension(dimension_name);
                if (dimension == nullptr) {
                    continue;
                }
                queued += markChunkSquare(level->getName(), dimension->getName(), 0, 0, radius);
            }
        }

        return queued;
    }

    TopBlockSample sampleTopVisibleBlock(endstone::Dimension &dimension, int block_x, int block_z)
    {
        const auto highest = dimension.getHighestBlockAt(block_x, block_z);
        if (highest != nullptr && !isAirBlock(highest->getType())) {
            return {highest->getType(), highest->getY()};
        }

        const int start_y =
            highest != nullptr ? highest->getY() : std::clamp(dimension.getHighestBlockYAt(block_x, block_z), -64, 320);
        for (int y = start_y; y >= -64; --y) {
            const auto block = dimension.getBlockAt(block_x, y, block_z);
            if (block != nullptr && !isAirBlock(block->getType())) {
                return {block->getType(), block->getY()};
            }
        }

        return {"minecraft:air", start_y};
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

    void requeueChunk(const livemap::ChunkCoord &coord)
    {
        std::scoped_lock lock(dirty_mutex_);
        dirty_.markChunk(coord);
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
        getServer().getScheduler().runTaskAsync(*this, [settings, json] { livemap::postLiveJson(settings, json); });
    }

    void publishDirtyChunks()
    {
        if (!settings_.upload_chunks || settings_.plugin_token.empty()) {
            return;
        }

        std::vector<livemap::ChunkCoord> chunks;
        {
            std::scoped_lock lock(dirty_mutex_);
            chunks = dirty_.drain(static_cast<std::size_t>(std::max(1, settings_.max_chunks_per_refresh)));
        }
        if (chunks.empty()) {
            return;
        }
        getLogger().info("Sampling {} dirty live map chunk(s).", chunks.size());

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
                requeueChunk(coord);
                getLogger().warning("Deferred live map chunk {}/{}/{} because it is not loaded.", coord.world, coord.x,
                                    coord.z);
                continue;
            }

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

            try {
                for (int local_z = 0; local_z < livemap::kChunkSize; ++local_z) {
                    for (int local_x = 0; local_x < livemap::kChunkSize; ++local_x) {
                        const int block_x = coord.x * livemap::kChunkSize + local_x;
                        const int block_z = coord.z * livemap::kChunkSize + local_z;
                        const int index = local_z * livemap::kChunkSize + local_x;
                        const auto sample = sampleTopVisibleBlock(*dimension, block_x, block_z);
                        snapshot.blocks[index] = palette_index(sample.type);
                        snapshot.heights[index] = sample.y;
                    }
                }
            }
            catch (const std::exception &error) {
                requeueChunk(coord);
                getLogger().error("Failed to sample live map chunk {}/{}/{}: {}", coord.world, coord.x, coord.z,
                                  error.what());
                continue;
            }
            catch (...) {
                requeueChunk(coord);
                getLogger().error("Failed to sample live map chunk {}/{}/{}.", coord.world, coord.x, coord.z);
                continue;
            }

            const auto settings = settings_;
            getServer().getScheduler().runTaskAsync(*this, [settings, snapshot = std::move(snapshot)] {
                const auto ok = livemap::uploadChunkSnapshot(settings, snapshot);
                const auto prefix = std::string("[LiveMap] ");
                auto &stream = ok ? std::cout : std::cerr;
                stream << prefix << (ok ? "Uploaded" : "Failed to upload") << " chunk " << snapshot.world << "/"
                       << snapshot.dimension << "/" << snapshot.chunk_x << "/" << snapshot.chunk_z << std::endl;
            });
        }
    }

    livemap::LiveMapSettings settings_;
    std::unique_ptr<LiveMapListener> listener_;
    std::shared_ptr<endstone::Task> player_task_;
    std::shared_ptr<endstone::Task> chunk_task_;
    mutable std::mutex dirty_mutex_;
    livemap::DirtyChunkTracker dirty_;
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
