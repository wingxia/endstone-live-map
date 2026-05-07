#pragma once

#include <cstddef>
#include <string>

namespace livemap {

constexpr int kTileSize = 256;

struct TileCoord {
    std::string world;
    std::string dimension;
    int zoom{};
    int x{};
    int y{};

    [[nodiscard]] std::string path(std::string_view extension) const;
};

bool operator==(const TileCoord &left, const TileCoord &right);
bool operator<(const TileCoord &left, const TileCoord &right);

struct TileCoordHash {
    std::size_t operator()(const TileCoord &coord) const;
};

int floorDiv(int value, int divisor);
int localCoord(int block, int tile);
TileCoord tileForBlock(std::string world, std::string dimension, int block_x, int block_z, int zoom = 0);

}  // namespace livemap
