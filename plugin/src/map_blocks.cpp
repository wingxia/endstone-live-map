#include "livemap/map_blocks.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <string>
#include <string_view>

namespace livemap {
namespace {

constexpr std::array<std::string_view, 3> kAirBlocks = {
    "minecraft:air",
    "minecraft:cave_air",
    "minecraft:void_air",
};

constexpr std::array<std::string_view, 4> kLiquidBlocks = {
    "minecraft:water",
    "minecraft:flowing_water",
    "minecraft:lava",
    "minecraft:flowing_lava",
};

constexpr std::array<std::string_view, 16> kPlantExactBlocks = {
    "minecraft:azalea",
    "minecraft:bamboo",
    "minecraft:bamboo_sapling",
    "minecraft:big_dripleaf",
    "minecraft:brown_mushroom",
    "minecraft:bush",
    "minecraft:cactus_flower",
    "minecraft:crimson_fungus",
    "minecraft:deadbush",
    "minecraft:flowering_azalea",
    "minecraft:kelp",
    "minecraft:red_mushroom",
    "minecraft:small_dripleaf_block",
    "minecraft:spore_blossom",
    "minecraft:sugar_cane",
    "minecraft:warped_fungus",
};

constexpr std::array<std::string_view, 45> kPlantTokens = {
    "allium",
    "azure_bluet",
    "beetroot",
    "blue_orchid",
    "carrots",
    "cave_vines",
    "cornflower",
    "dandelion",
    "fern",
    "flower",
    "crimson_roots",
    "hanging_roots",
    "kelp",
    "lilac",
    "lily_of_the_valley",
    "melon_stem",
    "nether_sprouts",
    "nether_wart",
    "oxeye_daisy",
    "peony",
    "petals",
    "pitcher_crop",
    "pitcher_plant",
    "poppy",
    "potatoes",
    "pumpkin_stem",
    "rose_bush",
    "sapling",
    "seagrass",
    "short_grass",
    "sprouts",
    "sugar_cane",
    "sunflower",
    "sweet_berry_bush",
    "tall_grass",
    "torchflower",
    "tulip",
    "twisting_vines",
    "vine",
    "warped_fungus",
    "warped_roots",
    "weeping_vines",
    "wheat",
    "wildflowers",
    "wither_rose",
};

constexpr std::array<std::string_view, 43> kCutoutSurfaceTokens = {
    "amethyst_cluster",
    "banner",
    "bell",
    "brewing_stand",
    "button",
    "cake",
    "campfire",
    "candle",
    "carpet",
    "chain",
    "cobweb",
    "conduit",
    "copper_grate",
    "coral",
    "door",
    "end_rod",
    "fence",
    "fence_gate",
    "flower_pot",
    "grate",
    "bars",
    "head",
    "iron_bars",
    "ladder",
    "lantern",
    "leaf_litter",
    "lever",
    "pane",
    "pressure_plate",
    "rail",
    "redstone_torch",
    "redstone_wire",
    "scaffolding",
    "sea_pickle",
    "sign",
    "skull",
    "snow_layer",
    "torch",
    "trapdoor",
    "tripwire",
    "tripwire_hook",
    "turtle_egg",
    "web",
};

constexpr std::array<std::string_view, 2> kCutoutSurfaceExactExclusions = {
    "minecraft:jack_o_lantern",
    "minecraft:sea_lantern",
};

constexpr std::array<std::string_view, 1> kCutoutSurfaceSuffixExclusions = {
    "_coral_block",
};

std::string normalizedBlockId(std::string_view value)
{
    std::string id(value.empty() ? "minecraft:air" : value);
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    if (id.find(':') == std::string::npos) {
        id.insert(0, "minecraft:");
    }
    return id;
}

template <std::size_t Size>
bool containsExact(const std::array<std::string_view, Size> &values, std::string_view id)
{
    return std::find(values.begin(), values.end(), id) != values.end();
}

template <std::size_t Size>
bool containsAnyToken(const std::array<std::string_view, Size> &tokens, std::string_view id)
{
    return std::any_of(tokens.begin(), tokens.end(), [id](std::string_view token) {
        return id.find(token) != std::string_view::npos;
    });
}

bool endsWith(std::string_view value, std::string_view suffix)
{
    return value.size() >= suffix.size() && value.substr(value.size() - suffix.size()) == suffix;
}

template <std::size_t Size>
bool containsAnySuffix(const std::array<std::string_view, Size> &suffixes, std::string_view id)
{
    return std::any_of(suffixes.begin(), suffixes.end(), [id](std::string_view suffix) {
        return endsWith(id, suffix);
    });
}

}  // namespace

bool isMapSurfaceBlock(std::string_view block_id, bool include_liquids)
{
    const auto id = normalizedBlockId(block_id);
    if (containsExact(kAirBlocks, id)) {
        return false;
    }
    if (containsExact(kLiquidBlocks, id)) {
        return include_liquids;
    }
    return !isMapDecorationBlock(id);
}

bool isMapDecorationBlock(std::string_view block_id)
{
    const auto id = normalizedBlockId(block_id);
    if (containsExact(kCutoutSurfaceExactExclusions, id) || containsAnySuffix(kCutoutSurfaceSuffixExclusions, id)) {
        return false;
    }
    return isPlantBlock(id) || containsAnyToken(kCutoutSurfaceTokens, id);
}

bool isPlantBlock(std::string_view block_id)
{
    const auto id = normalizedBlockId(block_id);
    if (id == "minecraft:grass_block" || endsWith(id, "_mushroom_block") || endsWith(id, "_wart_block") ||
        endsWith(id, "_leaves")) {
        return false;
    }
    return containsExact(kPlantExactBlocks, id) || containsAnyToken(kPlantTokens, id);
}

}  // namespace livemap
