#pragma once

#include <cstdint>
#include <span>
#include <vector>

#include "livemap/color_map.hpp"

namespace livemap {

std::vector<std::uint8_t> encodeBmp24(int width, int height, std::span<const Color> pixels);

}  // namespace livemap
