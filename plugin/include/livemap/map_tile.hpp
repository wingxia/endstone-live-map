#pragma once

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "livemap/chunk.hpp"
#include "livemap/protocol.hpp"

namespace livemap {

constexpr int kMapTileSize = 256;
constexpr int kMapTileMinZoom = -1;
constexpr int kMapTileMaxRenderedZoom = 3;
constexpr int kMapTileBaseZoom = 4;

struct MapTileRef {
    std::string world;
    std::string dimension;
    int zoom{};
    int tile_x{};
    int tile_z{};
};

struct RenderedMapTile {
    MapTileRef ref;
    std::int64_t source_version{};
    std::vector<std::uint8_t> png;
};

class ChunkSnapshotStore {
public:
    explicit ChunkSnapshotStore(std::filesystem::path root);

    [[nodiscard]] bool put(const ChunkSnapshot &snapshot, std::string *error = nullptr) const;
    [[nodiscard]] std::optional<ChunkSnapshot> get(const ChunkCoord &coord) const;
    [[nodiscard]] std::vector<ChunkSnapshot> getRange(const std::string &world, const std::string &dimension,
                                                      int min_chunk_x, int max_chunk_x, int min_chunk_z,
                                                      int max_chunk_z) const;

private:
    [[nodiscard]] std::filesystem::path pathFor(const ChunkCoord &coord) const;

    std::filesystem::path root_;
};

[[nodiscard]] std::vector<MapTileRef> mapTilesForChunk(const ChunkCoord &coord);
[[nodiscard]] std::vector<RenderedMapTile> renderMapTilesForSnapshots(const std::filesystem::path &cache_root,
                                                                      const std::vector<ChunkSnapshot> &snapshots,
                                                                      std::string *error = nullptr);
[[nodiscard]] std::string serializeRenderedChunkBatch(const std::vector<ChunkSnapshot> &snapshots,
                                                      const std::vector<RenderedMapTile> &tiles, bool broadcast,
                                                      ChunkBatchStorage storage = ChunkBatchStorage::Region);

}  // namespace livemap
