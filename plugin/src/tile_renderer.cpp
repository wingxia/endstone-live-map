#include "livemap/tile_renderer.hpp"

#include <vector>

#include "livemap/bmp_writer.hpp"
#include "livemap/color_map.hpp"

namespace livemap {

std::vector<std::uint8_t> renderTileBmp(int width, int height, const std::function<BlockSample(int, int)> &sample_at)
{
    std::vector<Color> pixels(static_cast<std::size_t>(width * height));
    for (int z = 0; z < height; ++z) {
        for (int x = 0; x < width; ++x) {
            const auto sample = sample_at(x, z);
            pixels[static_cast<std::size_t>(z * width + x)] = colorForBlock(sample.type, sample.y);
        }
    }
    return encodeBmp24(width, height, pixels);
}

}  // namespace livemap
