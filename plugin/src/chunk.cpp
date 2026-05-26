#include "livemap/chunk.hpp"
#include "livemap/tile_math.hpp"

#include <algorithm>
#include <cctype>
#include <functional>
#include <string>
#include <tuple>

namespace livemap {

std::string ChunkCoord::path() const
{
    return world + "/" + dimension + "/" + std::to_string(x) + "/" + std::to_string(z) + ".json";
}

bool operator==(const ChunkCoord &left, const ChunkCoord &right)
{
    return left.world == right.world && left.dimension == right.dimension && left.x == right.x && left.z == right.z;
}

bool operator<(const ChunkCoord &left, const ChunkCoord &right)
{
    return std::tie(left.world, left.dimension, left.x, left.z) <
           std::tie(right.world, right.dimension, right.x, right.z);
}

bool operator==(const BlockColumnCoord &left, const BlockColumnCoord &right)
{
    return left.world == right.world && left.dimension == right.dimension && left.x == right.x && left.z == right.z;
}

bool operator<(const BlockColumnCoord &left, const BlockColumnCoord &right)
{
    return std::tie(left.world, left.dimension, left.x, left.z) <
           std::tie(right.world, right.dimension, right.x, right.z);
}

std::size_t ChunkCoordHash::operator()(const ChunkCoord &coord) const
{
    std::size_t seed = std::hash<std::string>{}(coord.world);
    const auto combine = [&seed](std::size_t value) {
        seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6U) + (seed >> 2U);
    };
    combine(std::hash<std::string>{}(coord.dimension));
    combine(std::hash<int>{}(coord.x));
    combine(std::hash<int>{}(coord.z));
    return seed;
}

std::size_t BlockColumnCoordHash::operator()(const BlockColumnCoord &coord) const
{
    std::size_t seed = std::hash<std::string>{}(coord.world);
    const auto combine = [&seed](std::size_t value) {
        seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6U) + (seed >> 2U);
    };
    combine(std::hash<std::string>{}(coord.dimension));
    combine(std::hash<int>{}(coord.x));
    combine(std::hash<int>{}(coord.z));
    return seed;
}

ChunkCoord chunkForBlock(std::string world, std::string dimension, int block_x, int block_z)
{
    return {
        std::move(world),
        std::move(dimension),
        floorDiv(block_x, kChunkSize),
        floorDiv(block_z, kChunkSize),
    };
}

BlockColumnCoord columnForBlock(std::string world, std::string dimension, int block_x, int block_z)
{
    return {
        std::move(world),
        std::move(dimension),
        block_x,
        block_z,
    };
}

int localChunkCoord(int block, int chunk)
{
    return block - chunk * kChunkSize;
}

namespace {

bool isAirBlock(std::string block)
{
    std::transform(block.begin(), block.end(), block.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return block == "minecraft:air" || block == "minecraft:cave_air" || block == "minecraft:void_air" ||
           block == "air" || block == "cave_air" || block == "void_air";
}

}  // namespace

bool isEmptyChunkSnapshot(const ChunkSnapshot &snapshot)
{
    for (int index = 0; index < kChunkBlockCount; ++index) {
        const auto block_index = snapshot.blocks[static_cast<std::size_t>(index)];
        const auto block = block_index < snapshot.palette.size() ? snapshot.palette[block_index] : "minecraft:air";
        if (!isAirBlock(block) || snapshot.heights[static_cast<std::size_t>(index)] > -64) {
            return false;
        }
        const auto overlay_index = snapshot.overlay_blocks[static_cast<std::size_t>(index)];
        const auto overlay_block =
            overlay_index < snapshot.palette.size() ? snapshot.palette[overlay_index] : "minecraft:air";
        if (!isAirBlock(overlay_block) && snapshot.overlay_heights[static_cast<std::size_t>(index)] > -64) {
            return false;
        }
    }
    return true;
}

bool DirtyChunkTracker::markBlock(const std::string &world, const std::string &dimension, int block_x, int block_z)
{
    return markChunk(chunkForBlock(world, dimension, block_x, block_z));
}

bool DirtyChunkTracker::markChunk(ChunkCoord coord)
{
    return dirty_.insert(std::move(coord)).second;
}

std::size_t DirtyChunkTracker::size() const
{
    return dirty_.size();
}

bool DirtyChunkTracker::empty() const
{
    return dirty_.empty();
}

std::vector<ChunkCoord> DirtyChunkTracker::drain(std::size_t limit)
{
    std::vector<ChunkCoord> sorted(dirty_.begin(), dirty_.end());
    std::sort(sorted.begin(), sorted.end());
    if (limit < sorted.size()) {
        sorted.resize(limit);
    }

    for (const auto &coord : sorted) {
        dirty_.erase(coord);
    }
    return sorted;
}

void DirtyChunkTracker::clear()
{
    dirty_.clear();
}

bool DirtyBlockTracker::markBlock(const std::string &world, const std::string &dimension, int block_x, int block_z,
                                  int block_y)
{
    return markColumn(columnForBlock(world, dimension, block_x, block_z), block_y);
}

bool DirtyBlockTracker::markColumn(BlockColumnCoord coord, int touched_y)
{
    const auto [it, inserted] = dirty_.emplace(std::move(coord), touched_y);
    if (!inserted) {
        it->second = std::max(it->second, touched_y);
    }
    return inserted;
}

std::size_t DirtyBlockTracker::size() const
{
    return dirty_.size();
}

bool DirtyBlockTracker::empty() const
{
    return dirty_.empty();
}

std::vector<DirtyBlockColumn> DirtyBlockTracker::drain(std::size_t limit)
{
    std::vector<DirtyBlockColumn> sorted;
    sorted.reserve(dirty_.size());
    for (const auto &[coord, touched_y] : dirty_) {
        sorted.push_back({coord, touched_y});
    }
    std::sort(sorted.begin(), sorted.end(), [](const auto &left, const auto &right) {
        if (left.coord == right.coord) {
            return left.touched_y < right.touched_y;
        }
        return left.coord < right.coord;
    });
    if (limit < sorted.size()) {
        sorted.resize(limit);
    }

    for (const auto &column : sorted) {
        dirty_.erase(column.coord);
    }
    return sorted;
}

std::vector<DirtyBlockColumn> DirtyBlockTracker::drainForChunkLimit(std::size_t column_limit, std::size_t chunk_limit)
{
    std::vector<DirtyBlockColumn> sorted;
    sorted.reserve(dirty_.size());
    for (const auto &[coord, touched_y] : dirty_) {
        sorted.push_back({coord, touched_y});
    }
    std::sort(sorted.begin(), sorted.end(), [](const auto &left, const auto &right) {
        const auto left_chunk = chunkForBlock(left.coord.world, left.coord.dimension, left.coord.x, left.coord.z);
        const auto right_chunk = chunkForBlock(right.coord.world, right.coord.dimension, right.coord.x, right.coord.z);
        const auto left_tile_x = floorDiv(left_chunk.x, 2);
        const auto right_tile_x = floorDiv(right_chunk.x, 2);
        if (left_tile_x != right_tile_x) {
            return left_tile_x < right_tile_x;
        }
        const auto left_tile_z = floorDiv(left_chunk.z, 2);
        const auto right_tile_z = floorDiv(right_chunk.z, 2);
        if (left_tile_z != right_tile_z) {
            return left_tile_z < right_tile_z;
        }
        if (left_chunk == right_chunk) {
            if (left.coord == right.coord) {
                return left.touched_y < right.touched_y;
            }
            return left.coord < right.coord;
        }
        return left_chunk < right_chunk;
    });

    std::vector<DirtyBlockColumn> selected;
    selected.reserve(std::min(column_limit, sorted.size()));
    std::unordered_set<ChunkCoord, ChunkCoordHash> chunks;
    for (const auto &column : sorted) {
        if (selected.size() >= column_limit) {
            break;
        }
        const auto chunk = chunkForBlock(column.coord.world, column.coord.dimension, column.coord.x, column.coord.z);
        if (chunks.find(chunk) == chunks.end() && chunks.size() >= chunk_limit) {
            continue;
        }
        chunks.insert(chunk);
        selected.push_back(column);
    }

    for (const auto &column : selected) {
        dirty_.erase(column.coord);
    }
    return selected;
}

void DirtyBlockTracker::clear()
{
    dirty_.clear();
}

}  // namespace livemap
