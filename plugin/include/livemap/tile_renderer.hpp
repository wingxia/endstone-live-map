#pragma once

#include "livemap/chunk.hpp"
#include "livemap/png.hpp"
#include "livemap/settings.hpp"

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace livemap {

constexpr int kMapTileSize = 256;
constexpr int kMapTileBaseZoom = 4;

struct RenderedTile {
    std::string world;
    std::string dimension;
    int zoom{};
    int tile_x{};
    int tile_z{};
    std::filesystem::path png_path;
    std::string r2_key;
    std::int64_t updated_at_ms{};
    bool has_pixels = false;
};

struct RenderedChunk {
    ChunkCoord coord;
    std::uint64_t fingerprint{};
    std::int64_t updated_at_ms{};
};

struct TileRenderResult {
    bool ok = false;
    std::string error;
    std::vector<RenderedChunk> chunks;
    std::vector<RenderedTile> tiles;
};

[[nodiscard]] std::string cleanSegment(std::string_view value);
[[nodiscard]] std::filesystem::path tilePngPath(const LiveMapSettings &settings, std::string_view world,
                                                std::string_view dimension, int zoom, int tile_x, int tile_z);
[[nodiscard]] std::filesystem::path tileRawPath(const LiveMapSettings &settings, std::string_view world,
                                                std::string_view dimension, int zoom, int tile_x, int tile_z);
[[nodiscard]] std::string tileR2Key(const LiveMapSettings &settings, std::string_view world, std::string_view dimension,
                                    int zoom, int tile_x, int tile_z);
[[nodiscard]] bool renderedTileFilesExistForChunk(const LiveMapSettings &settings, const ChunkCoord &coord);
[[nodiscard]] RgbaImage renderChunkTile(const ChunkSnapshot &snapshot);
[[nodiscard]] TileRenderResult renderChunkSnapshotsToTiles(const LiveMapSettings &settings,
                                                           const std::vector<ChunkSnapshot> &snapshots);
[[nodiscard]] std::string serializeTilesReady(const TileRenderResult &result);

}  // namespace livemap
