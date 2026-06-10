#include "livemap/map_tile.hpp"

#include "livemap/base64.hpp"
#include "livemap/tile_math.hpp"

#include <zlib.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstring>
#include <fstream>
#include <optional>
#include <set>
#include <sstream>
#include <unordered_map>
#include <variant>

namespace livemap {
namespace {

constexpr std::array<std::uint8_t, 8> kPngSignature = {137, 80, 78, 71, 13, 10, 26, 10};
constexpr std::string_view kSnapshotMagic = "ELMSNAP1";
constexpr int kMinColumnHeight = -64;
constexpr int kSeaLevel = 63;

struct Rgba {
    int r{};
    int g{};
    int b{};
    int a{255};
};

struct TileRange {
    int min_chunk_x{};
    int max_chunk_x{};
    int min_chunk_z{};
    int max_chunk_z{};
    int min_block_x{};
    int min_block_z{};
};

std::string safeSegment(std::string_view value)
{
    std::string out;
    out.reserve(value.size());
    for (const unsigned char ch : value) {
        if (std::isalnum(ch) || ch == '_' || ch == '-' || ch == '.') {
            out.push_back(static_cast<char>(ch));
        }
        else {
            out.push_back('_');
        }
    }
    return out.empty() ? "world" : out;
}

std::string lowerBlockName(std::string_view value)
{
    std::string out(value.empty() ? "minecraft:air" : value);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    const auto colon = out.find(':');
    if (colon != std::string::npos) {
        out = out.substr(colon + 1);
    }
    return out;
}

bool contains(std::string_view value, std::string_view token)
{
    return value.find(token) != std::string_view::npos;
}

int clampByte(const double value)
{
    return std::clamp(static_cast<int>(std::round(value)), 0, 255);
}

Rgba adjustBrightness(const Rgba color, const double factor)
{
    return {clampByte(color.r * factor), clampByte(color.g * factor), clampByte(color.b * factor), color.a};
}

Rgba mixColors(const Rgba left, const Rgba right, const double amount)
{
    const auto keep = 1.0 - amount;
    return {
        clampByte(left.r * keep + right.r * amount),
        clampByte(left.g * keep + right.g * amount),
        clampByte(left.b * keep + right.b * amount),
        clampByte(left.a * keep + right.a * amount),
    };
}

bool isAirBlock(std::string_view block_id)
{
    const auto name = lowerBlockName(block_id);
    return name == "air" || name == "cave_air" || name == "void_air";
}

std::optional<Rgba> baseColorForBlock(std::string_view block_id)
{
    const auto name = lowerBlockName(block_id);
    if (name == "air" || name == "cave_air" || name == "void_air") {
        return std::nullopt;
    }
    if (contains(name, "water") || contains(name, "bubble_column")) {
        return Rgba{37, 99, 184, 220};
    }
    if (contains(name, "lava")) {
        return Rgba{224, 88, 36, 255};
    }
    if (contains(name, "grass_block")) {
        return Rgba{95, 159, 63, 255};
    }
    if (contains(name, "leaves") || contains(name, "azalea")) {
        return contains(name, "cherry") ? Rgba{242, 165, 201, 255} : Rgba{63, 127, 56, 255};
    }
    if (contains(name, "sand")) {
        return Rgba{196, 176, 112, 255};
    }
    if (contains(name, "dirt") || contains(name, "podzol") || contains(name, "farmland")) {
        return Rgba{117, 82, 48, 255};
    }
    if (contains(name, "snow")) {
        return Rgba{226, 232, 240, 255};
    }
    if (contains(name, "ice") || contains(name, "glass") || contains(name, "pane")) {
        return Rgba{159, 199, 209, 210};
    }
    if (contains(name, "oak") || contains(name, "spruce") || contains(name, "birch") || contains(name, "jungle") ||
        contains(name, "acacia") || contains(name, "mangrove") || contains(name, "cherry") || contains(name, "bamboo") ||
        contains(name, "log") || contains(name, "planks") || contains(name, "wood")) {
        return Rgba{142, 93, 50, 255};
    }
    if (contains(name, "wool") || contains(name, "carpet") || contains(name, "bed") || contains(name, "banner")) {
        return Rgba{178, 161, 143, 255};
    }
    if (contains(name, "gold")) {
        return Rgba{217, 182, 74, 255};
    }
    if (contains(name, "diamond")) {
        return Rgba{111, 200, 198, 255};
    }
    if (contains(name, "emerald")) {
        return Rgba{47, 181, 108, 255};
    }
    if (contains(name, "copper")) {
        return contains(name, "oxidized") ? Rgba{83, 151, 132, 255} : Rgba{181, 105, 64, 255};
    }
    if (contains(name, "netherrack") || contains(name, "nether")) {
        return Rgba{111, 47, 43, 255};
    }
    if (contains(name, "end_stone") || contains(name, "end_bricks")) {
        return Rgba{216, 207, 138, 255};
    }
    if (contains(name, "deepslate")) {
        return Rgba{74, 78, 85, 255};
    }
    if (contains(name, "stone") || contains(name, "andesite") || contains(name, "diorite") || contains(name, "granite") ||
        contains(name, "ore") || contains(name, "tuff") || contains(name, "basalt")) {
        return Rgba{126, 132, 132, 255};
    }
    if (contains(name, "torch") || contains(name, "lantern") || contains(name, "glowstone") || contains(name, "shroomlight") ||
        contains(name, "sea_lantern")) {
        return Rgba{216, 170, 74, 255};
    }
    if (contains(name, "flower") || contains(name, "poppy") || contains(name, "tulip") || contains(name, "dandelion")) {
        return Rgba{217, 209, 107, 255};
    }
    if (contains(name, "grass") || contains(name, "fern") || contains(name, "vine") || contains(name, "kelp") ||
        contains(name, "seagrass") || contains(name, "cactus") || contains(name, "bush")) {
        return Rgba{79, 143, 53, 255};
    }
    return Rgba{132, 126, 112, 255};
}

Rgba applyHeightShade(const Rgba color, const int height)
{
    if (height < kSeaLevel) {
        const auto depth = std::min(1.0, static_cast<double>(kSeaLevel - height) / 64.0);
        return mixColors(adjustBrightness(color, 0.78 - depth * 0.22), Rgba{36, 92, 148, color.a}, 0.18 + depth * 0.24);
    }
    if (height < 100) {
        return adjustBrightness(color, 0.93 + static_cast<double>(height - kSeaLevel) / 37.0 * 0.05);
    }
    if (height < 150) {
        return adjustBrightness(color, 1.02 + static_cast<double>(height - 100) / 50.0 * 0.08);
    }
    return adjustBrightness(color, 1.12 + std::min(0.14, static_cast<double>(height - 150) / 600.0));
}

std::uint32_t crc32Bytes(const std::uint8_t *data, const std::size_t size)
{
    std::uint32_t crc = 0xFFFFFFFFu;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
        }
    }
    return crc ^ 0xFFFFFFFFu;
}

void appendU32(std::vector<std::uint8_t> &out, const std::uint32_t value)
{
    out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
    out.push_back(static_cast<std::uint8_t>(value & 0xFF));
}

void appendChunk(std::vector<std::uint8_t> &out, const char type[4], const std::vector<std::uint8_t> &data)
{
    appendU32(out, static_cast<std::uint32_t>(data.size()));
    const auto type_start = out.size();
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), data.begin(), data.end());
    const auto crc = crc32Bytes(out.data() + type_start, out.size() - type_start);
    appendU32(out, crc);
}

std::vector<std::uint8_t> encodePngRgba(const int width, const int height, const std::vector<std::uint8_t> &rgba)
{
    std::vector<std::uint8_t> raw;
    raw.reserve(static_cast<std::size_t>(height) * (1 + static_cast<std::size_t>(width) * 4));
    for (int y = 0; y < height; ++y) {
        raw.push_back(0);
        const auto start = static_cast<std::size_t>(y) * static_cast<std::size_t>(width) * 4;
        raw.insert(raw.end(), rgba.begin() + static_cast<std::ptrdiff_t>(start),
                   rgba.begin() + static_cast<std::ptrdiff_t>(start + static_cast<std::size_t>(width) * 4));
    }

    std::vector<std::uint8_t> compressed(compressBound(static_cast<uLong>(raw.size())));
    uLongf compressed_size = static_cast<uLongf>(compressed.size());
    const auto result = compress2(compressed.data(), &compressed_size, raw.data(), static_cast<uLong>(raw.size()), 1);
    if (result != Z_OK) {
        return {};
    }
    compressed.resize(compressed_size);

    std::vector<std::uint8_t> out(kPngSignature.begin(), kPngSignature.end());
    std::vector<std::uint8_t> ihdr;
    appendU32(ihdr, static_cast<std::uint32_t>(width));
    appendU32(ihdr, static_cast<std::uint32_t>(height));
    ihdr.insert(ihdr.end(), {8, 6, 0, 0, 0});
    appendChunk(out, "IHDR", ihdr);
    appendChunk(out, "IDAT", compressed);
    appendChunk(out, "IEND", {});
    return out;
}

template <typename Value>
void writePod(std::ostream &out, const Value &value)
{
    out.write(reinterpret_cast<const char *>(&value), sizeof(Value));
}

template <typename Value>
bool readPod(std::istream &in, Value &value)
{
    in.read(reinterpret_cast<char *>(&value), sizeof(Value));
    return static_cast<bool>(in);
}

void writeString(std::ostream &out, const std::string &value)
{
    const auto size = static_cast<std::uint32_t>(value.size());
    writePod(out, size);
    out.write(value.data(), static_cast<std::streamsize>(value.size()));
}

bool readString(std::istream &in, std::string &value)
{
    std::uint32_t size = 0;
    if (!readPod(in, size) || size > 65536) {
        return false;
    }
    value.assign(size, '\0');
    in.read(value.data(), static_cast<std::streamsize>(size));
    return static_cast<bool>(in);
}

void writeStateMap(std::ostream &out, const BlockStateMap &states)
{
    const auto size = static_cast<std::uint32_t>(states.size());
    writePod(out, size);
    for (const auto &[key, value] : states) {
        writeString(out, key);
        if (std::holds_alternative<bool>(value)) {
            const std::uint8_t type = 0;
            writePod(out, type);
            const std::uint8_t encoded = std::get<bool>(value) ? 1 : 0;
            writePod(out, encoded);
        }
        else if (std::holds_alternative<int>(value)) {
            const std::uint8_t type = 1;
            writePod(out, type);
            const auto encoded = static_cast<std::int32_t>(std::get<int>(value));
            writePod(out, encoded);
        }
        else {
            const std::uint8_t type = 2;
            writePod(out, type);
            writeString(out, std::get<std::string>(value));
        }
    }
}

bool readStateMap(std::istream &in, BlockStateMap &states)
{
    std::uint32_t size = 0;
    if (!readPod(in, size) || size > 128) {
        return false;
    }
    states.clear();
    for (std::uint32_t i = 0; i < size; ++i) {
        std::string key;
        std::uint8_t type = 0;
        if (!readString(in, key) || !readPod(in, type)) {
            return false;
        }
        if (type == 0) {
            std::uint8_t value = 0;
            if (!readPod(in, value)) {
                return false;
            }
            states[key] = value != 0;
        }
        else if (type == 1) {
            std::int32_t value = 0;
            if (!readPod(in, value)) {
                return false;
            }
            states[key] = static_cast<int>(value);
        }
        else if (type == 2) {
            std::string value;
            if (!readString(in, value)) {
                return false;
            }
            states[key] = std::move(value);
        }
        else {
            return false;
        }
    }
    return true;
}

template <typename Value, std::size_t Size>
void writeArray(std::ostream &out, const std::array<Value, Size> &values)
{
    out.write(reinterpret_cast<const char *>(values.data()), static_cast<std::streamsize>(sizeof(Value) * values.size()));
}

template <typename Value, std::size_t Size>
bool readArray(std::istream &in, std::array<Value, Size> &values)
{
    in.read(reinterpret_cast<char *>(values.data()), static_cast<std::streamsize>(sizeof(Value) * values.size()));
    return static_cast<bool>(in);
}

int chunksPerMapTile(const int zoom)
{
    return 1 << (kMapTileBaseZoom - zoom);
}

TileRange tileRange(const MapTileRef &tile)
{
    const auto chunks_per_tile = chunksPerMapTile(tile.zoom);
    const auto min_chunk_x = tile.tile_x * chunks_per_tile;
    const auto min_chunk_z = tile.tile_z * chunks_per_tile;
    return {
        min_chunk_x,
        min_chunk_x + chunks_per_tile - 1,
        min_chunk_z,
        min_chunk_z + chunks_per_tile - 1,
        min_chunk_x * kChunkSize,
        min_chunk_z * kChunkSize,
    };
}

std::string coordKey(const int chunk_x, const int chunk_z)
{
    return std::to_string(chunk_x) + "/" + std::to_string(chunk_z);
}

const ChunkSnapshot *chunkAt(const std::unordered_map<std::string, ChunkSnapshot> &chunks, const int world_x,
                             const int world_z)
{
    const auto chunk_x = floorDiv(world_x, kChunkSize);
    const auto chunk_z = floorDiv(world_z, kChunkSize);
    const auto found = chunks.find(coordKey(chunk_x, chunk_z));
    if (found == chunks.end()) {
        return nullptr;
    }
    return &found->second;
}

std::optional<Rgba> columnColor(const std::unordered_map<std::string, ChunkSnapshot> &chunks, const int world_x,
                                const int world_z)
{
    const auto *chunk = chunkAt(chunks, world_x, world_z);
    if (chunk == nullptr) {
        return std::nullopt;
    }
    const auto local_x = localChunkCoord(world_x, chunk->chunk_x);
    const auto local_z = localChunkCoord(world_z, chunk->chunk_z);
    if (local_x < 0 || local_x >= kChunkSize || local_z < 0 || local_z >= kChunkSize) {
        return std::nullopt;
    }
    const auto index = static_cast<std::size_t>(local_z * kChunkSize + local_x);
    const auto block_index = chunk->blocks[index] < chunk->palette.size() ? chunk->blocks[index] : 0;
    const auto block_id = chunk->palette.empty() ? std::string{"minecraft:air"} : chunk->palette[block_index];
    const auto overlay_height = chunk->overlay_heights[index];
    const auto overlay_index = chunk->overlay_blocks[index] < chunk->palette.size() ? chunk->overlay_blocks[index] : 0;
    const auto overlay_id = overlay_height > kMinColumnHeight && !chunk->palette.empty() ? chunk->palette[overlay_index] : std::string{"minecraft:air"};
    if (isAirBlock(block_id) && isAirBlock(overlay_id)) {
        return std::nullopt;
    }
    auto color = baseColorForBlock(block_id);
    const auto overlay_color = baseColorForBlock(overlay_id);
    if (!color.has_value() && overlay_color.has_value()) {
        color = overlay_color;
    }
    else if (color.has_value() && overlay_color.has_value() && !isAirBlock(overlay_id)) {
        color = mixColors(*color, *overlay_color, 0.28);
    }
    if (!color.has_value()) {
        return std::nullopt;
    }
    return applyHeightShade(*color, std::max(chunk->heights[index], overlay_height));
}

void setPixel(std::vector<std::uint8_t> &rgba, const int x, const int y, const Rgba color)
{
    if (x < 0 || x >= kMapTileSize || y < 0 || y >= kMapTileSize) {
        return;
    }
    const auto offset = static_cast<std::size_t>(y * kMapTileSize + x) * 4;
    rgba[offset] = static_cast<std::uint8_t>(color.r);
    rgba[offset + 1] = static_cast<std::uint8_t>(color.g);
    rgba[offset + 2] = static_cast<std::uint8_t>(color.b);
    rgba[offset + 3] = static_cast<std::uint8_t>(color.a);
}

void fillRect(std::vector<std::uint8_t> &rgba, const int x, const int y, const int size, const Rgba color)
{
    for (int py = y; py < y + size; ++py) {
        for (int px = x; px < x + size; ++px) {
            setPixel(rgba, px, py, color);
        }
    }
}

std::optional<Rgba> averageColors(const std::vector<Rgba> &colors)
{
    if (colors.empty()) {
        return std::nullopt;
    }
    double r = 0;
    double g = 0;
    double b = 0;
    double a = 0;
    for (const auto color : colors) {
        r += color.r;
        g += color.g;
        b += color.b;
        a += color.a;
    }
    const auto count = static_cast<double>(colors.size());
    return Rgba{clampByte(r / count), clampByte(g / count), clampByte(b / count), clampByte(a / count)};
}

std::optional<RenderedMapTile> renderTile(const ChunkSnapshotStore &store, const MapTileRef &tile)
{
    const auto range = tileRange(tile);
    const auto source_chunks = store.getRange(tile.world, tile.dimension, range.min_chunk_x, range.max_chunk_x,
                                              range.min_chunk_z, range.max_chunk_z);
    if (source_chunks.empty()) {
        return std::nullopt;
    }

    std::unordered_map<std::string, ChunkSnapshot> chunks;
    chunks.reserve(source_chunks.size());
    std::int64_t source_version = 0;
    for (const auto &chunk : source_chunks) {
        source_version = std::max(source_version, chunk.updated_at_ms);
        chunks.emplace(coordKey(chunk.chunk_x, chunk.chunk_z), chunk);
    }

    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(kMapTileSize) * kMapTileSize * 4, 0);
    bool has_pixels = false;
    if (tile.zoom >= 0) {
        const auto block_scale = 1 << tile.zoom;
        for (const auto &chunk : source_chunks) {
            for (int local_z = 0; local_z < kChunkSize; ++local_z) {
                for (int local_x = 0; local_x < kChunkSize; ++local_x) {
                    const auto world_x = chunk.chunk_x * kChunkSize + local_x;
                    const auto world_z = chunk.chunk_z * kChunkSize + local_z;
                    const auto color = columnColor(chunks, world_x, world_z);
                    if (!color.has_value()) {
                        continue;
                    }
                    const auto pixel_x = (world_x - range.min_block_x) * block_scale;
                    const auto pixel_y = (world_z - range.min_block_z) * block_scale;
                    fillRect(rgba, pixel_x, pixel_y, block_scale, *color);
                    has_pixels = true;
                }
            }
        }
    }
    else {
        constexpr int kBlocksPerPixel = 2;
        for (int pixel_y = 0; pixel_y < kMapTileSize; ++pixel_y) {
            for (int pixel_x = 0; pixel_x < kMapTileSize; ++pixel_x) {
                std::vector<Rgba> colors;
                colors.reserve(kBlocksPerPixel * kBlocksPerPixel);
                const auto start_x = range.min_block_x + pixel_x * kBlocksPerPixel;
                const auto start_z = range.min_block_z + pixel_y * kBlocksPerPixel;
                for (int dz = 0; dz < kBlocksPerPixel; ++dz) {
                    for (int dx = 0; dx < kBlocksPerPixel; ++dx) {
                        auto color = columnColor(chunks, start_x + dx, start_z + dz);
                        if (color.has_value()) {
                            colors.push_back(*color);
                        }
                    }
                }
                const auto average = averageColors(colors);
                if (!average.has_value()) {
                    continue;
                }
                setPixel(rgba, pixel_x, pixel_y, *average);
                has_pixels = true;
            }
        }
    }

    if (!has_pixels) {
        return std::nullopt;
    }
    auto png = encodePngRgba(kMapTileSize, kMapTileSize, rgba);
    if (png.empty()) {
        return std::nullopt;
    }
    return RenderedMapTile{tile, source_version, std::move(png)};
}

}  // namespace

ChunkSnapshotStore::ChunkSnapshotStore(std::filesystem::path root) : root_(std::move(root)) {}

std::filesystem::path ChunkSnapshotStore::pathFor(const ChunkCoord &coord) const
{
    return root_ / "v1" / safeSegment(coord.world) / safeSegment(coord.dimension) / std::to_string(coord.x) /
           (std::to_string(coord.z) + ".bin");
}

bool ChunkSnapshotStore::put(const ChunkSnapshot &snapshot, std::string *error) const
{
    try {
        const auto coord = ChunkCoord{snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z};
        const auto path = pathFor(coord);
        std::filesystem::create_directories(path.parent_path());
        const auto tmp = path.string() + ".tmp";
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) {
            if (error != nullptr) {
                *error = "failed to open temporary snapshot cache file";
            }
            return false;
        }
        out.write(kSnapshotMagic.data(), static_cast<std::streamsize>(kSnapshotMagic.size()));
        writeString(out, snapshot.world);
        writeString(out, snapshot.dimension);
        writePod(out, static_cast<std::int32_t>(snapshot.chunk_x));
        writePod(out, static_cast<std::int32_t>(snapshot.chunk_z));
        writePod(out, static_cast<std::int64_t>(snapshot.updated_at_ms));
        const auto palette_size = static_cast<std::uint32_t>(snapshot.palette.size());
        writePod(out, palette_size);
        for (const auto &entry : snapshot.palette) {
            writeString(out, entry);
        }
        writeArray(out, snapshot.blocks);
        writeArray(out, snapshot.heights);
        for (const auto &states : snapshot.block_states) {
            writeStateMap(out, states);
        }
        writeArray(out, snapshot.overlay_blocks);
        writeArray(out, snapshot.overlay_heights);
        for (const auto &states : snapshot.overlay_states) {
            writeStateMap(out, states);
        }
        out.close();
        std::filesystem::rename(tmp, path);
        return true;
    }
    catch (const std::exception &exception) {
        if (error != nullptr) {
            *error = exception.what();
        }
        return false;
    }
}

std::optional<ChunkSnapshot> ChunkSnapshotStore::get(const ChunkCoord &coord) const
{
    try {
        std::ifstream in(pathFor(coord), std::ios::binary);
        if (!in) {
            return std::nullopt;
        }
        std::string magic(kSnapshotMagic.size(), '\0');
        in.read(magic.data(), static_cast<std::streamsize>(magic.size()));
        if (magic != kSnapshotMagic) {
            return std::nullopt;
        }
        ChunkSnapshot snapshot;
        std::int32_t chunk_x = 0;
        std::int32_t chunk_z = 0;
        if (!readString(in, snapshot.world) || !readString(in, snapshot.dimension) || !readPod(in, chunk_x) ||
            !readPod(in, chunk_z) || !readPod(in, snapshot.updated_at_ms)) {
            return std::nullopt;
        }
        snapshot.chunk_x = chunk_x;
        snapshot.chunk_z = chunk_z;
        std::uint32_t palette_size = 0;
        if (!readPod(in, palette_size) || palette_size > kChunkBlockCount * 2) {
            return std::nullopt;
        }
        snapshot.palette.clear();
        snapshot.palette.reserve(palette_size);
        for (std::uint32_t i = 0; i < palette_size; ++i) {
            std::string entry;
            if (!readString(in, entry)) {
                return std::nullopt;
            }
            snapshot.palette.push_back(std::move(entry));
        }
        if (!readArray(in, snapshot.blocks) || !readArray(in, snapshot.heights)) {
            return std::nullopt;
        }
        for (auto &states : snapshot.block_states) {
            if (!readStateMap(in, states)) {
                return std::nullopt;
            }
        }
        if (!readArray(in, snapshot.overlay_blocks) || !readArray(in, snapshot.overlay_heights)) {
            return std::nullopt;
        }
        for (auto &states : snapshot.overlay_states) {
            if (!readStateMap(in, states)) {
                return std::nullopt;
            }
        }
        return snapshot;
    }
    catch (...) {
        return std::nullopt;
    }
}

std::vector<ChunkSnapshot> ChunkSnapshotStore::getRange(const std::string &world, const std::string &dimension,
                                                        const int min_chunk_x, const int max_chunk_x,
                                                        const int min_chunk_z, const int max_chunk_z) const
{
    std::vector<ChunkSnapshot> chunks;
    for (int chunk_z = min_chunk_z; chunk_z <= max_chunk_z; ++chunk_z) {
        for (int chunk_x = min_chunk_x; chunk_x <= max_chunk_x; ++chunk_x) {
            auto chunk = get({world, dimension, chunk_x, chunk_z});
            if (chunk.has_value()) {
                chunks.push_back(std::move(*chunk));
            }
        }
    }
    return chunks;
}

std::vector<MapTileRef> mapTilesForChunk(const ChunkCoord &coord)
{
    std::vector<MapTileRef> tiles;
    tiles.reserve(kMapTileMaxRenderedZoom - kMapTileMinZoom + 1);
    for (int zoom = kMapTileMinZoom; zoom <= kMapTileMaxRenderedZoom; ++zoom) {
        const auto chunks_per_tile = chunksPerMapTile(zoom);
        tiles.push_back({coord.world, coord.dimension, zoom, floorDiv(coord.x, chunks_per_tile),
                         floorDiv(coord.z, chunks_per_tile)});
    }
    return tiles;
}

std::vector<RenderedMapTile> renderMapTilesForSnapshots(const std::filesystem::path &cache_root,
                                                        const std::vector<ChunkSnapshot> &snapshots,
                                                        std::string *error)
{
    ChunkSnapshotStore store(cache_root);
    std::vector<MapTileRef> refs;
    std::set<std::string> seen;
    for (const auto &snapshot : snapshots) {
        if (!store.put(snapshot, error)) {
            return {};
        }
        for (const auto &ref : mapTilesForChunk({snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z})) {
            const auto key = ref.world + "\n" + ref.dimension + "\n" + std::to_string(ref.zoom) + "\n" +
                             std::to_string(ref.tile_x) + "\n" + std::to_string(ref.tile_z);
            if (seen.insert(key).second) {
                refs.push_back(ref);
            }
        }
    }
    std::sort(refs.begin(), refs.end(), [](const auto &left, const auto &right) {
        if (left.zoom != right.zoom) {
            return left.zoom > right.zoom;
        }
        if (left.tile_z != right.tile_z) {
            return left.tile_z < right.tile_z;
        }
        return left.tile_x < right.tile_x;
    });

    std::vector<RenderedMapTile> rendered;
    rendered.reserve(refs.size());
    for (const auto &ref : refs) {
        auto tile = renderTile(store, ref);
        if (tile.has_value()) {
            rendered.push_back(std::move(*tile));
        }
    }
    if (rendered.empty() && error != nullptr) {
        *error = "rendered tile set was empty";
    }
    return rendered;
}

std::string serializeRenderedChunkBatch(const std::vector<ChunkSnapshot> &snapshots,
                                        const std::vector<RenderedMapTile> &tiles, const bool broadcast,
                                        const ChunkBatchStorage storage)
{
    std::ostringstream out;
    out << "{\"broadcast\":" << (broadcast ? "true" : "false") << ",\"storage\":\""
        << (storage == ChunkBatchStorage::Region ? "region" : "chunk") << "\",\"chunks\":[";
    for (std::size_t i = 0; i < snapshots.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << serializeChunkSnapshot(snapshots[i]);
    }
    out << "],\"tiles\":[";
    for (std::size_t i = 0; i < tiles.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        const auto &tile = tiles[i];
        out << "{\"world\":\"" << jsonEscape(tile.ref.world) << "\",\"dimension\":\""
            << jsonEscape(tile.ref.dimension) << "\",\"zoom\":" << tile.ref.zoom
            << ",\"tileX\":" << tile.ref.tile_x << ",\"tileZ\":" << tile.ref.tile_z
            << ",\"sourceVersion\":" << tile.source_version << ",\"tileVersion\":" << tile.source_version
            << ",\"pngBase64\":\"" << base64Encode(std::span<const std::uint8_t>(tile.png.data(), tile.png.size()))
            << "\"}";
    }
    out << "]}";
    return out.str();
}

}  // namespace livemap
