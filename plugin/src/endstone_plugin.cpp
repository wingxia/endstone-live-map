#include "livemap/dirty_tile_tracker.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"
#include "livemap/tile_renderer.hpp"

#include <endstone/endstone.hpp>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <memory>
#include <mutex>
#include <span>
#include <string>
#include <vector>

namespace livemap {
bool postLiveJson(const LiveMapSettings &settings, std::string_view json);
bool uploadTileBmp(const LiveMapSettings &settings, const TileCoord &coord, std::span<const std::uint8_t> bytes);
}  // namespace livemap

namespace {

std::int64_t nowMs()
{
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

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
        const auto tile_ticks = static_cast<std::uint64_t>(std::max(5, settings_.tile_refresh_seconds) * 20);
        player_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { publishPlayers(); }, player_ticks,
                                                               player_ticks);
        tile_task_ = getServer().getScheduler().runTaskTimer(*this, [this] { renderDirtyTiles(); }, tile_ticks,
                                                             tile_ticks);

        seedLoadedChunks();
        getLogger().info("Endstone Live Map enabled for {}", settings_.worker_url);
    }

    void onDisable() override
    {
        if (player_task_ != nullptr) {
            player_task_->cancel();
        }
        if (tile_task_ != nullptr) {
            tile_task_->cancel();
        }
        getLogger().info("Endstone Live Map disabled");
    }

    bool onCommand(endstone::CommandSender &sender, const endstone::Command &command,
                   const std::vector<std::string> &args) override
    {
        if (command.getName() != "livemap") {
            return false;
        }

        if (!args.empty() && args[0] == "render") {
            seedLoadedChunks();
            sender.sendMessage("Queued loaded chunks for live map rendering.");
            return true;
        }

        sender.sendMessage("Live map dirty tiles: " + std::to_string(dirtyCount()));
        return true;
    }

    void markBlock(const endstone::Block &block)
    {
        auto &dimension = block.getDimension();
        std::scoped_lock lock(dirty_mutex_);
        dirty_.markBlock(dimension.getLevel().getName(), dimension.getName(), block.getX(), block.getZ());
    }

    [[nodiscard]] std::size_t dirtyCount() const
    {
        std::scoped_lock lock(dirty_mutex_);
        return dirty_.size();
    }

private:
    void seedLoadedChunks()
    {
        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return;
        }

        std::scoped_lock lock(dirty_mutex_);
        for (auto *dimension : level->getDimensions()) {
            if (dimension == nullptr) {
                continue;
            }
            for (auto &chunk : dimension->getLoadedChunks()) {
                const int block_x = chunk->getX() * 16;
                const int block_z = chunk->getZ() * 16;
                dirty_.markBlock(level->getName(), dimension->getName(), block_x, block_z);
            }
        }
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

        const auto json = livemap::serializePlayerSnapshot(players);
        const auto settings = settings_;
        getServer().getScheduler().runTaskAsync(*this, [settings, json] { livemap::postLiveJson(settings, json); });
    }

    void renderDirtyTiles()
    {
        if (!settings_.upload_tiles || settings_.plugin_token.empty()) {
            return;
        }

        std::vector<livemap::TileCoord> tiles;
        {
            std::scoped_lock lock(dirty_mutex_);
            tiles = dirty_.drain(static_cast<std::size_t>(std::max(1, settings_.max_tiles_per_refresh)));
        }
        if (tiles.empty()) {
            return;
        }

        auto *level = getServer().getLevel();
        if (level == nullptr) {
            return;
        }

        for (const auto &coord : tiles) {
            auto *dimension = level->getDimension(coord.dimension);
            if (dimension == nullptr) {
                continue;
            }

            auto bmp = livemap::renderTileBmp(livemap::kTileSize, livemap::kTileSize, [&](int local_x, int local_z) {
                const int block_x = coord.x * livemap::kTileSize + local_x;
                const int block_z = coord.y * livemap::kTileSize + local_z;
                const auto block = dimension->getHighestBlockAt(block_x, block_z);
                if (block == nullptr) {
                    return livemap::BlockSample{};
                }
                return livemap::BlockSample{block->getType(), block->getY()};
            });

            const auto settings = settings_;
            getServer().getScheduler().runTaskAsync(*this, [settings, coord, bmp = std::move(bmp)] {
                livemap::uploadTileBmp(settings, coord, std::span<const std::uint8_t>(bmp.data(), bmp.size()));
            });
        }
    }

    livemap::LiveMapSettings settings_;
    std::unique_ptr<LiveMapListener> listener_;
    std::shared_ptr<endstone::Task> player_task_;
    std::shared_ptr<endstone::Task> tile_task_;
    mutable std::mutex dirty_mutex_;
    livemap::DirtyTileTracker dirty_;
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

ENDSTONE_PLUGIN("endstone_live_map", "0.1.0", LiveMapPlugin)
{
    prefix = "LiveMap";
    description = "Realtime 2D web map publisher for Endstone servers";
    website = "https://github.com/wingxia/endstone-live-map";
    authors = {"Wing Xia"};

    command("livemap")
        .description("Inspect or queue live map rendering")
        .usages("/livemap", "/livemap render")
        .permissions("livemap.command");

    permission("livemap.command")
        .description("Allow operators to inspect or queue live map rendering.")
        .default_(endstone::PermissionDefault::Operator);
}
