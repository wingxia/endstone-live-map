#pragma once

#include <cstddef>
#include <unordered_set>
#include <vector>

#include "livemap/tile_math.hpp"

namespace livemap {

class DirtyTileTracker {
public:
    bool markBlock(const std::string &world, const std::string &dimension, int block_x, int block_z, int zoom = 0);
    bool markTile(TileCoord coord);
    [[nodiscard]] std::size_t size() const;
    [[nodiscard]] bool empty() const;
    std::vector<TileCoord> drain(std::size_t limit);
    void clear();

private:
    std::unordered_set<TileCoord, TileCoordHash> dirty_;
};

}  // namespace livemap
