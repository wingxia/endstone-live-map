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

ChunkCoord chunkForBlock(std::string world, std::string dimension, int block_x, int block_z)
{
    return {
        std::move(world),
        std::move(dimension),
        floorDiv(block_x, kChunkSize),
        floorDiv(block_z, kChunkSize),
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

}  // namespace livemap
