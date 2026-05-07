#include "livemap/color_map.hpp"

#include <algorithm>
#include <string>
#include <unordered_map>

namespace livemap {

namespace {

std::string normalize(std::string_view block_type)
{
    std::string type(block_type);
    if (type.rfind("minecraft:", 0) == 0) {
        type.erase(0, 10);
    }
    return type;
}

Color clampColor(int r, int g, int b)
{
    return {
        static_cast<std::uint8_t>(std::clamp(r, 0, 255)),
        static_cast<std::uint8_t>(std::clamp(g, 0, 255)),
        static_cast<std::uint8_t>(std::clamp(b, 0, 255)),
    };
}

}  // namespace

Color shadeForHeight(Color base, int y)
{
    const int shade = std::clamp((y - 62) / 8, -18, 28);
    return clampColor(base.r + shade, base.g + shade, base.b + shade);
}

Color colorForBlock(std::string_view block_type, int y)
{
    static const std::unordered_map<std::string, Color> exact = {
        {"air", {38, 45, 52}},
        {"water", {47, 92, 180}},
        {"flowing_water", {47, 92, 180}},
        {"lava", {224, 92, 35}},
        {"flowing_lava", {224, 92, 35}},
        {"grass_block", {93, 151, 69}},
        {"dirt", {133, 96, 62}},
        {"coarse_dirt", {122, 88, 56}},
        {"stone", {124, 124, 120}},
        {"deepslate", {78, 78, 84}},
        {"sand", {218, 204, 137}},
        {"red_sand", {189, 99, 45}},
        {"gravel", {132, 126, 120}},
        {"snow", {238, 246, 248}},
        {"snow_layer", {238, 246, 248}},
        {"ice", {145, 189, 214}},
        {"packed_ice", {112, 171, 214}},
        {"blue_ice", {95, 165, 226}},
        {"oak_leaves", {70, 132, 58}},
        {"spruce_leaves", {49, 105, 70}},
        {"birch_leaves", {94, 145, 57}},
        {"jungle_leaves", {52, 130, 51}},
        {"acacia_leaves", {75, 123, 49}},
        {"dark_oak_leaves", {48, 96, 45}},
        {"mangrove_leaves", {56, 116, 63}},
        {"cherry_leaves", {224, 155, 183}},
        {"oak_log", {116, 86, 50}},
        {"spruce_log", {91, 67, 43}},
        {"birch_log", {190, 180, 137}},
        {"jungle_log", {112, 83, 48}},
        {"acacia_log", {143, 82, 46}},
        {"dark_oak_log", {68, 48, 30}},
        {"mangrove_log", {102, 55, 48}},
        {"netherrack", {111, 53, 52}},
        {"crimson_nylium", {132, 34, 48}},
        {"warped_nylium", {42, 117, 104}},
        {"end_stone", {218, 223, 158}},
        {"bedrock", {68, 68, 70}},
    };

    const auto type = normalize(block_type);
    if (const auto it = exact.find(type); it != exact.end()) {
        return shadeForHeight(it->second, y);
    }
    if (type.find("leaves") != std::string::npos) {
        return shadeForHeight({64, 125, 61}, y);
    }
    if (type.find("planks") != std::string::npos || type.find("wood") != std::string::npos) {
        return shadeForHeight({150, 111, 68}, y);
    }
    if (type.find("concrete") != std::string::npos) {
        return shadeForHeight({155, 158, 163}, y);
    }
    if (type.find("terracotta") != std::string::npos) {
        return shadeForHeight({149, 91, 66}, y);
    }
    if (type.find("ore") != std::string::npos) {
        return shadeForHeight({116, 116, 122}, y);
    }

    return shadeForHeight({126, 132, 128}, y);
}

}  // namespace livemap
