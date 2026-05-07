#pragma once

#include <cstdint>
#include <string_view>

namespace livemap {

struct Color {
    std::uint8_t r;
    std::uint8_t g;
    std::uint8_t b;
};

Color colorForBlock(std::string_view block_type, int y);
Color shadeForHeight(Color base, int y);

}  // namespace livemap
