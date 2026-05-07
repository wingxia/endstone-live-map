#include "livemap/tile_math.hpp"

#include <functional>
#include <tuple>

namespace livemap {

std::string TileCoord::path(std::string_view extension) const
{
    return world + "/" + dimension + "/" + std::to_string(zoom) + "/" + std::to_string(x) + "/" +
           std::to_string(y) + "." + std::string(extension);
}

bool operator==(const TileCoord &left, const TileCoord &right)
{
    return left.world == right.world && left.dimension == right.dimension && left.zoom == right.zoom &&
           left.x == right.x && left.y == right.y;
}

bool operator<(const TileCoord &left, const TileCoord &right)
{
    return std::tie(left.world, left.dimension, left.zoom, left.x, left.y) <
           std::tie(right.world, right.dimension, right.zoom, right.x, right.y);
}

std::size_t TileCoordHash::operator()(const TileCoord &coord) const
{
    std::size_t seed = std::hash<std::string>{}(coord.world);
    const auto combine = [&seed](std::size_t value) {
        seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6U) + (seed >> 2U);
    };
    combine(std::hash<std::string>{}(coord.dimension));
    combine(std::hash<int>{}(coord.zoom));
    combine(std::hash<int>{}(coord.x));
    combine(std::hash<int>{}(coord.y));
    return seed;
}

int floorDiv(int value, int divisor)
{
    int quotient = value / divisor;
    const int remainder = value % divisor;
    if (remainder != 0 && ((remainder < 0) != (divisor < 0))) {
        --quotient;
    }
    return quotient;
}

int localCoord(int block, int tile)
{
    return block - tile * kTileSize;
}

TileCoord tileForBlock(std::string world, std::string dimension, int block_x, int block_z, int zoom)
{
    const int scale = 1 << zoom;
    const int world_tile_size = kTileSize * scale;
    return {
        std::move(world),
        std::move(dimension),
        zoom,
        floorDiv(block_x, world_tile_size),
        floorDiv(block_z, world_tile_size),
    };
}

}  // namespace livemap
