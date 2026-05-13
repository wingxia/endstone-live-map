#include "livemap/chunk.hpp"

#include "livemap/tile_math.hpp"

#include <algorithm>
#include <functional>
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

void DirtyBlockTracker::clear()
{
    dirty_.clear();
}

}  // namespace livemap
