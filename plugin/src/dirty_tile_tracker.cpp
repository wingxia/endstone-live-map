#include "livemap/dirty_tile_tracker.hpp"

#include <algorithm>

namespace livemap {

bool DirtyTileTracker::markBlock(const std::string &world, const std::string &dimension, int block_x, int block_z,
                                 int zoom)
{
    return markTile(tileForBlock(world, dimension, block_x, block_z, zoom));
}

bool DirtyTileTracker::markTile(TileCoord coord)
{
    return dirty_.insert(std::move(coord)).second;
}

std::size_t DirtyTileTracker::size() const
{
    return dirty_.size();
}

bool DirtyTileTracker::empty() const
{
    return dirty_.empty();
}

std::vector<TileCoord> DirtyTileTracker::drain(std::size_t limit)
{
    std::vector<TileCoord> sorted(dirty_.begin(), dirty_.end());
    std::sort(sorted.begin(), sorted.end());
    if (limit < sorted.size()) {
        sorted.resize(limit);
    }

    for (const auto &coord : sorted) {
        dirty_.erase(coord);
    }
    return sorted;
}

void DirtyTileTracker::clear()
{
    dirty_.clear();
}

}  // namespace livemap
