#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace livemap {

struct BlockSample {
    std::string type = "minecraft:air";
    int y = 0;
};

std::vector<std::uint8_t> renderTileBmp(int width, int height, const std::function<BlockSample(int, int)> &sample_at);

}  // namespace livemap
