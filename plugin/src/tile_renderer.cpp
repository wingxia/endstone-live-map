#include "livemap/tile_renderer.hpp"

#include "livemap/baseline.hpp"
#include "livemap/map_blocks.hpp"
#include "livemap/protocol.hpp"
#include "livemap/tile_math.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <tuple>

namespace livemap {
namespace {

struct Rgba {
    std::uint8_t r{};
    std::uint8_t g{};
    std::uint8_t b{};
    std::uint8_t a = 255;
};

using TileCoordinate = std::pair<int, int>;
using TileGroupKey = std::pair<std::string, std::string>;
using TileGroups = std::map<TileGroupKey, std::set<TileCoordinate>>;

std::mutex &tilePyramidMutex()
{
    static std::mutex mutex;
    return mutex;
}

constexpr auto kPngCompressionMarker = ".png-filter-zlib-v1";

std::int64_t nowMs()
{
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

std::string normalizedBlock(std::string_view block_id)
{
    std::string id(block_id.empty() ? "minecraft:air" : block_id);
    std::transform(id.begin(), id.end(), id.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    if (id.find(':') == std::string::npos) {
        id.insert(0, "minecraft:");
    }
    return id;
}

bool contains(std::string_view value, std::string_view token)
{
    return value.find(token) != std::string_view::npos;
}

Rgba colorForBlock(std::string_view block_id, const BlockStateMap &state = {})
{
    const auto id = normalizedBlock(block_id);
    const auto name = id.substr(id.find(':') + 1);
    if (name == "air" || name == "cave_air" || name == "void_air") {
        return {0, 0, 0, 0};
    }
    if (contains(name, "water") || contains(name, "bubble_column")) {
        return {37, 99, 184, 224};
    }
    if (contains(name, "lava")) {
        return {214, 95, 36, 255};
    }
    if (contains(name, "grass_block")) {
        return {95, 159, 63, 255};
    }
    if (contains(name, "leaves")) {
        if (contains(name, "cherry")) {
            return {242, 165, 201, 232};
        }
        return {63, 127, 56, 232};
    }
    if (contains(name, "sand")) {
        return {209, 194, 126, 255};
    }
    if (contains(name, "dirt") || contains(name, "farmland") || contains(name, "podzol")) {
        return {111, 75, 47, 255};
    }
    if (contains(name, "snow")) {
        return {232, 236, 236, 255};
    }
    if (contains(name, "ice") || contains(name, "glass") || contains(name, "pane")) {
        return {159, 199, 209, 176};
    }
    if (contains(name, "redstone")) {
        return {178, 44, 34, 255};
    }
    if (contains(name, "rail")) {
        return {156, 118, 67, 255};
    }
    if (contains(name, "gold")) {
        return {217, 182, 74, 255};
    }
    if (contains(name, "diamond")) {
        return {111, 200, 198, 255};
    }
    if (contains(name, "emerald")) {
        return {47, 181, 108, 255};
    }
    if (contains(name, "copper")) {
        if (contains(name, "oxidized")) {
            return {91, 154, 143, 255};
        }
        if (contains(name, "weathered")) {
            return {95, 143, 122, 255};
        }
        return {184, 111, 69, 255};
    }
    if (contains(name, "oak")) {
        return {159, 116, 66, 255};
    }
    if (contains(name, "spruce")) {
        return {111, 76, 45, 255};
    }
    if (contains(name, "birch")) {
        return {203, 183, 122, 255};
    }
    if (contains(name, "jungle")) {
        return {166, 108, 62, 255};
    }
    if (contains(name, "acacia")) {
        return {168, 93, 50, 255};
    }
    if (contains(name, "mangrove")) {
        return {123, 52, 47, 255};
    }
    if (contains(name, "cherry")) {
        return {216, 153, 143, 255};
    }
    if (contains(name, "bamboo")) {
        return {200, 170, 85, 255};
    }
    if (contains(name, "crimson")) {
        return {127, 59, 85, 255};
    }
    if (contains(name, "warped")) {
        return {55, 123, 116, 255};
    }
    if (contains(name, "wool") || contains(name, "concrete") || contains(name, "terracotta") || contains(name, "carpet")) {
        if (contains(name, "white")) {
            return {216, 216, 208, 255};
        }
        if (contains(name, "black")) {
            return {35, 35, 40, 255};
        }
        if (contains(name, "red")) {
            return {154, 56, 48, 255};
        }
        if (contains(name, "blue")) {
            return {70, 102, 178, 255};
        }
        if (contains(name, "green")) {
            return {80, 130, 72, 255};
        }
        if (contains(name, "yellow")) {
            return {210, 186, 70, 255};
        }
        if (contains(name, "orange")) {
            return {198, 120, 49, 255};
        }
        if (contains(name, "purple")) {
            return {133, 83, 165, 255};
        }
        if (contains(name, "pink")) {
            return {214, 133, 165, 255};
        }
        if (contains(name, "cyan")) {
            return {68, 145, 156, 255};
        }
        if (contains(name, "gray") || contains(name, "silver")) {
            return {130, 135, 138, 255};
        }
    }
    if (contains(name, "netherrack")) {
        return {122, 52, 47, 255};
    }
    if (contains(name, "deepslate")) {
        return {74, 78, 85, 255};
    }
    if (contains(name, "obsidian")) {
        return {70, 55, 95, 255};
    }
    if (contains(name, "end_stone") || contains(name, "end_brick")) {
        return {216, 207, 138, 255};
    }
    if (contains(name, "prismarine")) {
        return {95, 159, 150, 255};
    }
    if (contains(name, "amethyst")) {
        return {155, 120, 200, 255};
    }
    if (contains(name, "flower") || contains(name, "poppy") || contains(name, "tulip")) {
        return {217, 209, 107, 230};
    }
    if (contains(name, "grass") || contains(name, "fern") || contains(name, "vine") || contains(name, "kelp") ||
        contains(name, "bush") || contains(name, "cactus")) {
        return {79, 143, 53, 230};
    }
    if (contains(name, "stone") || contains(name, "andesite") || contains(name, "diorite") || contains(name, "granite") ||
        contains(name, "tuff") || contains(name, "brick")) {
        return {125, 133, 135, 255};
    }

    std::uint32_t hash = 2166136261U;
    for (const auto ch : name) {
        hash ^= static_cast<std::uint8_t>(ch);
        hash *= 16777619U;
    }
    return {
        static_cast<std::uint8_t>(72 + (hash & 0x7FU)),
        static_cast<std::uint8_t>(72 + ((hash >> 8U) & 0x7FU)),
        static_cast<std::uint8_t>(72 + ((hash >> 16U) & 0x7FU)),
        255,
    };
}

int stateNumber(const BlockStateMap &state, std::string_view key, int fallback = 0)
{
    const auto found = state.find(std::string(key));
    if (found == state.end()) {
        return fallback;
    }
    if (const auto *value = std::get_if<int>(&found->second)) {
        return *value;
    }
    if (const auto *text = std::get_if<std::string>(&found->second)) {
        try {
            return std::stoi(*text);
        }
        catch (...) {
            return fallback;
        }
    }
    return fallback;
}

void setPixel(RgbaImage &image, int x, int y, Rgba color)
{
    if (x < 0 || y < 0 || x >= image.width || y >= image.height || color.a == 0) {
        return;
    }
    const auto offset = (static_cast<std::size_t>(y) * static_cast<std::size_t>(image.width) +
                         static_cast<std::size_t>(x)) *
                        4;
    if (color.a == 255 || image.pixels[offset + 3] == 0) {
        image.pixels[offset] = color.r;
        image.pixels[offset + 1] = color.g;
        image.pixels[offset + 2] = color.b;
        image.pixels[offset + 3] = color.a;
        return;
    }
    const auto alpha = static_cast<int>(color.a);
    image.pixels[offset] = static_cast<std::uint8_t>((color.r * alpha + image.pixels[offset] * (255 - alpha)) / 255);
    image.pixels[offset + 1] =
        static_cast<std::uint8_t>((color.g * alpha + image.pixels[offset + 1] * (255 - alpha)) / 255);
    image.pixels[offset + 2] =
        static_cast<std::uint8_t>((color.b * alpha + image.pixels[offset + 2] * (255 - alpha)) / 255);
    image.pixels[offset + 3] = 255;
}

void fillRect(RgbaImage &image, int x, int y, int width, int height, Rgba color)
{
    for (int py = y; py < y + height; ++py) {
        for (int px = x; px < x + width; ++px) {
            setPixel(image, px, py, color);
        }
    }
}

Rgba shadeColor(Rgba color, int height, int north_height, int west_height)
{
    if (color.a == 0) {
        return color;
    }
    double factor = 0.95;
    if (height < 63) {
        factor -= std::min(0.25, (63 - height) / 180.0);
        color.b = static_cast<std::uint8_t>(std::min(255, color.b + 20));
    }
    else if (height > 140) {
        factor += std::min(0.2, (height - 140) / 500.0);
    }
    const auto shade_drop = std::max(0, height - std::min(north_height, west_height));
    factor += std::min(0.12, shade_drop * 0.01);
    const auto occlusion = std::max(0, std::max(north_height, west_height) - height);
    factor -= std::min(0.18, occlusion * 0.012);
    factor = std::clamp(factor, 0.55, 1.25);
    color.r = static_cast<std::uint8_t>(std::clamp(static_cast<int>(std::round(color.r * factor)), 0, 255));
    color.g = static_cast<std::uint8_t>(std::clamp(static_cast<int>(std::round(color.g * factor)), 0, 255));
    color.b = static_cast<std::uint8_t>(std::clamp(static_cast<int>(std::round(color.b * factor)), 0, 255));
    return color;
}

std::array<int, kChunkBlockCount> chunkHeights(const ChunkSnapshot &snapshot)
{
    return snapshot.heights;
}

int heightAt(const std::array<int, kChunkBlockCount> &heights, int local_x, int local_z, int fallback)
{
    if (local_x < 0 || local_x >= kChunkSize || local_z < 0 || local_z >= kChunkSize) {
        return fallback;
    }
    return heights[static_cast<std::size_t>(local_z * kChunkSize + local_x)];
}

void drawGlyph(RgbaImage &image, int block_x, int block_z, Rgba color, const std::string &block_id,
               const BlockStateMap &state)
{
    const int x = block_x * 16;
    const int y = block_z * 16;
    const auto id = normalizedBlock(block_id);
    if (contains(id, "redstone_wire")) {
        const auto power = stateNumber(state, "redstone_signal", stateNumber(state, "power", 8));
        color = {static_cast<std::uint8_t>(120 + std::min(15, power) * 7), 35, 30, 255};
        fillRect(image, x + 7, y + 7, 2, 2, color);
        fillRect(image, x + 0, y + 7, 16, 2, color);
        fillRect(image, x + 7, y + 0, 2, 16, color);
        return;
    }
    if (contains(id, "rail")) {
        fillRect(image, x + 4, y + 2, 2, 12, color);
        fillRect(image, x + 10, y + 2, 2, 12, color);
        fillRect(image, x + 2, y + 5, 12, 1, {95, 75, 54, 255});
        fillRect(image, x + 2, y + 10, 12, 1, {95, 75, 54, 255});
        return;
    }
    if (contains(id, "repeater") || contains(id, "comparator")) {
        fillRect(image, x + 2, y + 2, 12, 12, {98, 92, 86, 255});
        fillRect(image, x + 3, y + 7, 10, 2, {186, 56, 45, 255});
        fillRect(image, x + 5, y + 5, 2, 2, {220, 160, 90, 255});
        fillRect(image, x + 9, y + 9, 2, 2, {220, 160, 90, 255});
        return;
    }
    if (isMapDecorationBlock(id)) {
        fillRect(image, x + 5, y + 5, 6, 6, color);
        return;
    }
    fillRect(image, x, y, 16, 16, color);
}

bool hasPixels(const RgbaImage &image)
{
    for (std::size_t i = 3; i < image.pixels.size(); i += 4) {
        if (image.pixels[i] != 0) {
            return true;
        }
    }
    return false;
}

bool fileExistsWithBytes(const std::filesystem::path &path)
{
    std::error_code error;
    if (!std::filesystem::is_regular_file(path, error)) {
        return false;
    }
    return std::filesystem::file_size(path, error) > 0 && !error;
}

bool rawTileFileIsComplete(const std::filesystem::path &path)
{
    std::error_code error;
    if (!std::filesystem::is_regular_file(path, error)) {
        return false;
    }
    constexpr std::uintmax_t expected_size =
        static_cast<std::uintmax_t>(kMapTileSize) * kMapTileSize * 4;
    return std::filesystem::file_size(path, error) == expected_size && !error;
}

Rgba average2x2(const RgbaImage &image, int x, int y)
{
    int count = 0;
    int r = 0;
    int g = 0;
    int b = 0;
    int a = 0;
    for (int dy = 0; dy < 2; ++dy) {
        for (int dx = 0; dx < 2; ++dx) {
            const auto px = x + dx;
            const auto py = y + dy;
            if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
                continue;
            }
            const auto offset =
                (static_cast<std::size_t>(py) * static_cast<std::size_t>(image.width) + static_cast<std::size_t>(px)) * 4;
            const auto alpha = image.pixels[offset + 3];
            if (alpha == 0) {
                continue;
            }
            r += image.pixels[offset];
            g += image.pixels[offset + 1];
            b += image.pixels[offset + 2];
            a += alpha;
            ++count;
        }
    }
    if (count == 0) {
        return {0, 0, 0, 0};
    }
    return {static_cast<std::uint8_t>(r / count), static_cast<std::uint8_t>(g / count),
            static_cast<std::uint8_t>(b / count), static_cast<std::uint8_t>(a / count)};
}

RgbaImage composeParentTile(const LiveMapSettings &settings, std::string_view world, std::string_view dimension,
                            int source_zoom, int parent_x, int parent_z)
{
    auto parent = makeRgbaImage(kMapTileSize, kMapTileSize);
    for (int child_dz = 0; child_dz < 2; ++child_dz) {
        for (int child_dx = 0; child_dx < 2; ++child_dx) {
            const int child_x = parent_x * 2 + child_dx;
            const int child_z = parent_z * 2 + child_dz;
            const auto child = readRawRgba(tileRawPath(settings, world, dimension, source_zoom, child_x, child_z),
                                           kMapTileSize, kMapTileSize);
            for (int y = 0; y < 128; ++y) {
                for (int x = 0; x < 128; ++x) {
                    const auto color = average2x2(child, x * 2, y * 2);
                    setPixel(parent, child_dx * 128 + x, child_dz * 128 + y, color);
                }
            }
        }
    }
    return parent;
}

void writeTileFiles(const LiveMapSettings &settings, const RenderedTile &tile, const RgbaImage &image)
{
    std::string error;
    if (!hasPixels(image)) {
        std::filesystem::remove(tilePngPath(settings, tile.world, tile.dimension, tile.zoom, tile.tile_x, tile.tile_z));
        std::filesystem::remove(tileRawPath(settings, tile.world, tile.dimension, tile.zoom, tile.tile_x, tile.tile_z));
        return;
    }
    if (!writePngRgba(tile.png_path, image, &error)) {
        throw std::runtime_error(error.empty() ? "failed to write tile png" : error);
    }
    if (!writeRawRgba(tileRawPath(settings, tile.world, tile.dimension, tile.zoom, tile.tile_x, tile.tile_z), image,
                      &error)) {
        throw std::runtime_error(error.empty() ? "failed to write tile raw cache" : error);
    }
}

bool parseTileCoordinate(std::string_view text, int *coordinate)
{
    try {
        std::size_t consumed = 0;
        const auto value = std::stoi(std::string(text), &consumed);
        if (consumed != text.size()) {
            return false;
        }
        *coordinate = value;
        return true;
    }
    catch (...) {
        return false;
    }
}

std::size_t optimizeLegacyPngTiles(const LiveMapSettings &settings)
{
    const auto data_root = std::filesystem::path(settings.tile_data_dir);
    const auto marker_path = data_root / kPngCompressionMarker;
    if (std::filesystem::exists(marker_path)) {
        return 0;
    }

    const auto tile_root = data_root / "tiles";
    std::size_t optimized = 0;
    if (std::filesystem::is_directory(tile_root)) {
        constexpr auto kRawTileBytes =
            static_cast<std::uintmax_t>(kMapTileSize) * static_cast<std::uintmax_t>(kMapTileSize) * 4U;
        for (const auto &entry : std::filesystem::recursive_directory_iterator(tile_root)) {
            if (!entry.is_regular_file() || entry.path().extension() != ".rgba" ||
                entry.file_size() != kRawTileBytes) {
                continue;
            }

            auto png_path = entry.path();
            png_path.replace_extension(".png");
            if (!std::filesystem::is_regular_file(png_path) || std::filesystem::file_size(png_path) < kRawTileBytes) {
                continue;
            }

            const auto image = readRawRgba(entry.path(), kMapTileSize, kMapTileSize);
            std::string error;
            if (!writePngRgba(png_path, image, &error)) {
                throw std::runtime_error(error.empty() ? "failed to optimize legacy tile png" : error);
            }
            ++optimized;
        }
    }

    std::filesystem::create_directories(data_root);
    auto temporary_marker = marker_path;
    temporary_marker += ".tmp";
    {
        std::ofstream marker(temporary_marker, std::ios::binary | std::ios::trunc);
        if (!marker) {
            throw std::runtime_error("failed to create png compression marker");
        }
        marker << "filtered-zlib-png-v1\n";
        marker.flush();
        if (!marker) {
            throw std::runtime_error("failed to write png compression marker");
        }
    }
    std::error_code rename_error;
    std::filesystem::rename(temporary_marker, marker_path, rename_error);
    if (rename_error) {
        std::error_code cleanup_error;
        std::filesystem::remove(temporary_marker, cleanup_error);
        throw std::runtime_error("failed to install png compression marker: " + rename_error.message());
    }
    return optimized;
}

std::set<TileCoordinate> rawTileCoordinates(const std::filesystem::path &zoom_path)
{
    std::set<TileCoordinate> coordinates;
    if (!std::filesystem::is_directory(zoom_path)) {
        return coordinates;
    }
    for (const auto &x_entry : std::filesystem::directory_iterator(zoom_path)) {
        if (!x_entry.is_directory()) {
            continue;
        }
        int tile_x = 0;
        if (!parseTileCoordinate(x_entry.path().filename().string(), &tile_x)) {
            continue;
        }
        for (const auto &z_entry : std::filesystem::directory_iterator(x_entry.path())) {
            if (z_entry.path().extension() != ".rgba" || !rawTileFileIsComplete(z_entry.path())) {
                continue;
            }
            int tile_z = 0;
            if (parseTileCoordinate(z_entry.path().stem().string(), &tile_z)) {
                coordinates.emplace(tile_x, tile_z);
            }
        }
    }
    return coordinates;
}

TileGroups baseTileGroups(const LiveMapSettings &settings)
{
    TileGroups groups;
    const auto tile_root = std::filesystem::path(settings.tile_data_dir) / "tiles";
    if (!std::filesystem::is_directory(tile_root)) {
        return groups;
    }
    for (const auto &world_entry : std::filesystem::directory_iterator(tile_root)) {
        if (!world_entry.is_directory()) {
            continue;
        }
        for (const auto &dimension_entry : std::filesystem::directory_iterator(world_entry.path())) {
            if (!dimension_entry.is_directory()) {
                continue;
            }
            auto coordinates = rawTileCoordinates(dimension_entry.path() / ("z" + std::to_string(kMapTileBaseZoom)));
            if (!coordinates.empty()) {
                groups.emplace(TileGroupKey{world_entry.path().filename().string(),
                                            dimension_entry.path().filename().string()},
                               std::move(coordinates));
            }
        }
    }
    return groups;
}

TileGroups parentGroupsFor(const TileGroups &child_groups)
{
    TileGroups parent_groups;
    for (const auto &[group, child_coordinates] : child_groups) {
        auto &parent_coordinates = parent_groups[group];
        for (const auto &[child_x, child_z] : child_coordinates) {
            parent_coordinates.emplace(floorDiv(child_x, 2), floorDiv(child_z, 2));
        }
    }
    return parent_groups;
}

RenderedTile renderParentTile(const LiveMapSettings &settings, const TileGroupKey &group, int source_zoom, int zoom,
                              int parent_x, int parent_z, std::int64_t updated_at_ms)
{
    const auto &[world, dimension] = group;
    auto parent_image = composeParentTile(settings, world, dimension, source_zoom, parent_x, parent_z);
    RenderedTile parent;
    parent.world = world;
    parent.dimension = dimension;
    parent.zoom = zoom;
    parent.tile_x = parent_x;
    parent.tile_z = parent_z;
    parent.updated_at_ms = updated_at_ms;
    parent.png_path = tilePngPath(settings, world, dimension, zoom, parent_x, parent_z);
    parent.r2_key = tileR2Key(settings, world, dimension, zoom, parent_x, parent_z);
    parent.has_pixels = hasPixels(parent_image);
    writeTileFiles(settings, parent, parent_image);
    return parent;
}

bool hasChangedChild(const std::set<TileCoordinate> &changed_children, int parent_x, int parent_z)
{
    for (int child_dz = 0; child_dz < 2; ++child_dz) {
        for (int child_dx = 0; child_dx < 2; ++child_dx) {
            if (changed_children.contains({parent_x * 2 + child_dx, parent_z * 2 + child_dz})) {
                return true;
            }
        }
    }
    return false;
}

void renderParentLevels(const LiveMapSettings &settings, TileGroups affected_children, std::int64_t updated_at_ms,
                        TileRenderResult *result)
{
    int child_zoom = kMapTileBaseZoom;
    for (int zoom = kMapTileBaseZoom - 1; zoom >= settings.tile_min_zoom; --zoom) {
        auto affected_parents = parentGroupsFor(affected_children);
        for (const auto &[group, parent_coordinates] : affected_parents) {
            for (const auto &[parent_x, parent_z] : parent_coordinates) {
                result->tiles.push_back(
                    renderParentTile(settings, group, child_zoom, zoom, parent_x, parent_z, updated_at_ms));
            }
        }

        affected_children = std::move(affected_parents);
        child_zoom = zoom;
        if (affected_children.empty()) {
            break;
        }
    }
}

void repairParentLevels(const LiveMapSettings &settings, TileGroups source_groups, std::int64_t updated_at_ms,
                        TileRenderResult *result)
{
    TileGroups changed_children;
    int child_zoom = kMapTileBaseZoom;
    for (int zoom = kMapTileBaseZoom - 1; zoom >= settings.tile_min_zoom; --zoom) {
        auto expected_parents = parentGroupsFor(source_groups);
        TileGroups changed_parents;
        for (const auto &[group, parent_coordinates] : expected_parents) {
            const auto &[world, dimension] = group;
            const auto changed = changed_children.find(group);
            for (const auto &[parent_x, parent_z] : parent_coordinates) {
                const auto png_path = tilePngPath(settings, world, dimension, zoom, parent_x, parent_z);
                const auto raw_path = tileRawPath(settings, world, dimension, zoom, parent_x, parent_z);
                const bool child_changed =
                    changed != changed_children.end() && hasChangedChild(changed->second, parent_x, parent_z);
                if (!child_changed && fileExistsWithBytes(png_path) && rawTileFileIsComplete(raw_path)) {
                    continue;
                }

                result->tiles.push_back(
                    renderParentTile(settings, group, child_zoom, zoom, parent_x, parent_z, updated_at_ms));
                changed_parents[group].emplace(parent_x, parent_z);
            }
        }

        source_groups = std::move(expected_parents);
        changed_children = std::move(changed_parents);
        child_zoom = zoom;
        if (source_groups.empty()) {
            break;
        }
    }
}

}  // namespace

std::string cleanSegment(std::string_view value)
{
    std::string out;
    out.reserve(value.size());
    for (const auto ch : value) {
        const auto uch = static_cast<unsigned char>(ch);
        if (std::isalnum(uch) != 0 || ch == '-' || ch == '_' || ch == '.') {
            out.push_back(ch);
        }
        else {
            out.push_back('_');
        }
    }
    return out.empty() ? "default" : out;
}

std::filesystem::path tilePngPath(const LiveMapSettings &settings, std::string_view world, std::string_view dimension,
                                  int zoom, int tile_x, int tile_z)
{
    return std::filesystem::path(settings.tile_data_dir) / "tiles" / cleanSegment(world) / cleanSegment(dimension) /
           ("z" + std::to_string(zoom)) / std::to_string(tile_x) / (std::to_string(tile_z) + ".png");
}

std::filesystem::path tileRawPath(const LiveMapSettings &settings, std::string_view world, std::string_view dimension,
                                  int zoom, int tile_x, int tile_z)
{
    return std::filesystem::path(settings.tile_data_dir) / "tiles" / cleanSegment(world) / cleanSegment(dimension) /
           ("z" + std::to_string(zoom)) / std::to_string(tile_x) / (std::to_string(tile_z) + ".rgba");
}

std::string tileR2Key(const LiveMapSettings &settings, std::string_view world, std::string_view dimension, int zoom,
                      int tile_x, int tile_z)
{
    auto prefix = settings.r2_key_prefix;
    while (!prefix.empty() && prefix.front() == '/') {
        prefix.erase(prefix.begin());
    }
    while (!prefix.empty() && prefix.back() == '/') {
        prefix.pop_back();
    }
    return prefix + "/" + cleanSegment(world) + "/" + cleanSegment(dimension) + "/z" + std::to_string(zoom) + "/" +
           std::to_string(tile_x) + "/" + std::to_string(tile_z) + ".png";
}

bool renderedTileFilesExistForChunk(const LiveMapSettings &settings, const ChunkCoord &coord)
{
    int tile_x = coord.x;
    int tile_z = coord.z;
    for (int zoom = kMapTileBaseZoom; zoom >= settings.tile_min_zoom; --zoom) {
        if (!fileExistsWithBytes(tilePngPath(settings, coord.world, coord.dimension, zoom, tile_x, tile_z)) ||
            !rawTileFileIsComplete(tileRawPath(settings, coord.world, coord.dimension, zoom, tile_x, tile_z))) {
            return false;
        }
        tile_x = floorDiv(tile_x, 2);
        tile_z = floorDiv(tile_z, 2);
    }
    return true;
}

RgbaImage renderChunkTile(const ChunkSnapshot &snapshot)
{
    auto image = makeRgbaImage(kMapTileSize, kMapTileSize);
    const auto heights = chunkHeights(snapshot);
    for (int local_z = 0; local_z < kChunkSize; ++local_z) {
        for (int local_x = 0; local_x < kChunkSize; ++local_x) {
            const auto index = static_cast<std::size_t>(local_z * kChunkSize + local_x);
            const auto block_index = snapshot.blocks[index];
            const auto block_id = block_index < snapshot.palette.size() ? snapshot.palette[block_index] : "minecraft:air";
            const auto height = snapshot.heights[index];
            auto color = shadeColor(colorForBlock(block_id, snapshot.block_states[index]), height,
                                    heightAt(heights, local_x, local_z - 1, height),
                                    heightAt(heights, local_x - 1, local_z, height));
            drawGlyph(image, local_x, local_z, color, block_id, snapshot.block_states[index]);

            const auto overlay_index = snapshot.overlay_blocks[index];
            const auto overlay_id =
                overlay_index < snapshot.palette.size() ? snapshot.palette[overlay_index] : "minecraft:air";
            if (normalizedBlock(overlay_id) != "minecraft:air") {
                auto overlay = colorForBlock(overlay_id, snapshot.overlay_states[index]);
                overlay.a = std::min<std::uint8_t>(overlay.a, 220);
                drawGlyph(image, local_x, local_z, overlay, overlay_id, snapshot.overlay_states[index]);
            }
        }
    }
    return image;
}

TileRenderResult renderChunkSnapshotsToTiles(const LiveMapSettings &settings, const std::vector<ChunkSnapshot> &snapshots)
{
    TileRenderResult result;
    result.ok = true;
    std::scoped_lock pyramid_lock(tilePyramidMutex());
    try {
        std::map<ChunkCoord, const ChunkSnapshot *> latest_snapshots;
        for (const auto &snapshot : snapshots) {
            if (isEmptyChunkSnapshot(snapshot)) {
                continue;
            }
            latest_snapshots[{snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z}] = &snapshot;
        }

        TileGroups affected_base_tiles;
        for (const auto &[coord, snapshot_ptr] : latest_snapshots) {
            const auto &snapshot = *snapshot_ptr;
            RenderedChunk chunk;
            chunk.coord = coord;
            chunk.fingerprint = fingerprintChunkSnapshot(snapshot);
            chunk.updated_at_ms = snapshot.updated_at_ms;
            result.chunks.push_back(chunk);

            RenderedTile base;
            base.world = snapshot.world;
            base.dimension = snapshot.dimension;
            base.zoom = kMapTileBaseZoom;
            base.tile_x = snapshot.chunk_x;
            base.tile_z = snapshot.chunk_z;
            base.updated_at_ms = snapshot.updated_at_ms;
            base.png_path = tilePngPath(settings, base.world, base.dimension, base.zoom, base.tile_x, base.tile_z);
            base.r2_key = tileR2Key(settings, base.world, base.dimension, base.zoom, base.tile_x, base.tile_z);
            auto image = renderChunkTile(snapshot);
            base.has_pixels = hasPixels(image);
            writeTileFiles(settings, base, image);
            result.tiles.push_back(base);
            affected_base_tiles[{snapshot.world, snapshot.dimension}].emplace(snapshot.chunk_x, snapshot.chunk_z);
        }

        renderParentLevels(settings, std::move(affected_base_tiles), nowMs(), &result);
    }
    catch (const std::exception &exception) {
        result.ok = false;
        result.error = exception.what();
    }
    catch (...) {
        result.ok = false;
        result.error = "unknown tile render error";
    }
    return result;
}

TileRenderResult repairMissingTilePyramid(const LiveMapSettings &settings)
{
    TileRenderResult result;
    result.ok = true;
    std::scoped_lock pyramid_lock(tilePyramidMutex());
    try {
        result.optimized_png_tiles = optimizeLegacyPngTiles(settings);
        repairParentLevels(settings, baseTileGroups(settings), nowMs(), &result);
    }
    catch (const std::exception &exception) {
        result.ok = false;
        result.error = exception.what();
    }
    catch (...) {
        result.ok = false;
        result.error = "unknown tile pyramid repair error";
    }
    return result;
}

std::string serializeTilesReady(const TileRenderResult &result)
{
    std::int64_t updated_at = 0;
    for (const auto &chunk : result.chunks) {
        updated_at = std::max(updated_at, chunk.updated_at_ms);
    }
    for (const auto &tile : result.tiles) {
        updated_at = std::max(updated_at, tile.updated_at_ms);
    }
    std::ostringstream out;
    out << "{\"type\":\"tiles_ready\",\"updatedAt\":" << updated_at << ",\"chunks\":[";
    for (std::size_t i = 0; i < result.chunks.size(); ++i) {
        const auto &chunk = result.chunks[i];
        if (i != 0) {
            out << ',';
        }
        out << "{\"world\":\"" << jsonEscape(chunk.coord.world) << "\",\"dimension\":\""
            << jsonEscape(chunk.coord.dimension) << "\",\"chunkX\":" << chunk.coord.x << ",\"chunkZ\":"
            << chunk.coord.z << ",\"updatedAt\":" << chunk.updated_at_ms << '}';
    }
    out << "],\"tiles\":[";
    for (std::size_t i = 0; i < result.tiles.size(); ++i) {
        const auto &tile = result.tiles[i];
        if (i != 0) {
            out << ',';
        }
        out << "{\"world\":\"" << jsonEscape(tile.world) << "\",\"dimension\":\"" << jsonEscape(tile.dimension)
            << "\",\"zoom\":" << tile.zoom << ",\"tileX\":" << tile.tile_x << ",\"tileZ\":" << tile.tile_z
            << ",\"updatedAt\":" << tile.updated_at_ms << ",\"hasPixels\":"
            << (tile.has_pixels ? "true" : "false") << '}';
    }
    out << "]}";
    return out.str();
}

}  // namespace livemap
