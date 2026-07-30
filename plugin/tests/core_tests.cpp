#include "livemap/baseline.hpp"
#include "livemap/base64.hpp"
#include "livemap/chunk.hpp"
#include "livemap/land.hpp"
#include "livemap/map_blocks.hpp"
#include "livemap/png.hpp"
#include "livemap/protocol.hpp"
#include "livemap/r2_signing.hpp"
#include "livemap/settings.hpp"
#include "livemap/sha256.hpp"
#include "livemap/tile_math.hpp"
#include "livemap/tile_renderer.hpp"
#include "livemap/upload_queue.hpp"

#include <cassert>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <variant>
#include <vector>

namespace {

void testTileMath()
{
    assert(livemap::floorDiv(0, 16) == 0);
    assert(livemap::floorDiv(15, 16) == 0);
    assert(livemap::floorDiv(16, 16) == 1);
    assert(livemap::floorDiv(-1, 16) == -1);
    assert(livemap::floorDiv(-16, 16) == -1);
    assert(livemap::floorDiv(-17, 16) == -2);
}

void testDirtyTracker()
{
    livemap::DirtyChunkTracker tracker;
    assert(tracker.markBlock("world", "Overworld", 0, 0));
    assert(!tracker.markBlock("world", "Overworld", 1, 1));
    assert(tracker.markBlock("world", "Overworld", 16, 0));
    assert(tracker.size() == 2);

    const auto drained = tracker.drain(1);
    assert(drained.size() == 1);
    assert(tracker.size() == 1);
    tracker.clear();
    assert(tracker.empty());
}

void testDirtyBlockTracker()
{
    livemap::DirtyBlockTracker tracker;
    assert(tracker.markBlock("world", "Overworld", 0, 63, 10));
    assert(!tracker.markBlock("world", "Overworld", 0, 63, 8));
    assert(!tracker.markBlock("world", "Overworld", 0, 63, 64));
    assert(tracker.markBlock("world", "Overworld", 1, 63, 2));
    assert(tracker.size() == 2);

    const auto drained = tracker.drain(1);
    assert(drained.size() == 1);
    assert(drained[0].touched_y == 64);
    assert(tracker.size() == 1);
    tracker.clear();
    assert(tracker.empty());
}

void testUploadPriorityQueue()
{
    livemap::PrioritizedUploadQueue<int> queue;
    assert(queue.push(1, livemap::UploadPriority::Low, 3));
    assert(queue.push(2, livemap::UploadPriority::Normal, 3));
    assert(queue.push(3, livemap::UploadPriority::High, 3));
    assert(!queue.push(4, livemap::UploadPriority::High, 3));
    assert(queue.size() == 3);

    auto first = queue.pop();
    auto second = queue.pop();
    auto third = queue.pop();
    assert(first.has_value() && *first == 3);
    assert(second.has_value() && *second == 2);
    assert(third.has_value() && *third == 1);
    assert(!queue.pop().has_value());
}

void testLatestUploadSlot()
{
    livemap::LatestUploadSlot<int> slot;
    assert(slot.empty());
    assert(!slot.replace(10));
    assert(slot.size() == 1);
    assert(slot.replace(20));
    assert(slot.replacedCount() == 1);

    auto item = slot.take();
    assert(item.has_value() && *item == 20);
    assert(slot.empty());
    assert(!slot.take().has_value());
}

void testChunkMath()
{
    const auto origin = livemap::chunkForBlock("world", "Overworld", 0, 0);
    assert(origin.x == 0);
    assert(origin.z == 0);
    assert(origin.path() == "world/Overworld/0/0.json");

    const auto negative = livemap::chunkForBlock("world", "Overworld", -1, -17);
    assert(negative.x == -1);
    assert(negative.z == -2);
    assert(livemap::localChunkCoord(-1, -1) == 15);
    const auto column = livemap::columnForBlock("world", "Overworld", -1, -17);
    assert(column.x == -1);
    assert(column.z == -17);
}

void testEmptyChunkSnapshotDetection()
{
    livemap::ChunkSnapshot empty;
    empty.palette = {"minecraft:air"};
    empty.blocks.fill(0);
    empty.heights.fill(-64);
    empty.overlay_blocks.fill(0);
    empty.overlay_heights.fill(-64);
    assert(livemap::isEmptyChunkSnapshot(empty));

    auto terrain = empty;
    terrain.palette = {"minecraft:air", "minecraft:grass_block"};
    terrain.blocks[3] = 1;
    terrain.heights[3] = 64;
    assert(!livemap::isEmptyChunkSnapshot(terrain));

    auto overlay = empty;
    overlay.palette = {"minecraft:air", "minecraft:poppy"};
    overlay.overlay_blocks[3] = 1;
    overlay.overlay_heights[3] = 65;
    assert(!livemap::isEmptyChunkSnapshot(overlay));
}

void testMapBlockClassification()
{
    assert(!livemap::isMapSurfaceBlock("minecraft:air"));
    assert(!livemap::isMapSurfaceBlock("minecraft:poppy"));
    assert(!livemap::isMapSurfaceBlock("minecraft:glass_pane"));
    assert(livemap::isMapSurfaceBlock("minecraft:glass"));
    assert(!livemap::isMapSurfaceBlock("minecraft:oak_trapdoor"));
    assert(!livemap::isMapSurfaceBlock("minecraft:cake"));
    assert(!livemap::isMapSurfaceBlock("minecraft:end_rod"));
    assert(livemap::isMapSurfaceBlock("minecraft:grass_block"));
    assert(livemap::isMapSurfaceBlock("minecraft:oak_leaves"));
    assert(livemap::isMapSurfaceBlock("minecraft:cherry_leaves"));
    assert(!livemap::isMapSurfaceBlock("minecraft:bush"));
    assert(!livemap::isMapSurfaceBlock("minecraft:leaf_litter"));
    assert(livemap::isMapSurfaceBlock("minecraft:water"));
    assert(!livemap::isMapSurfaceBlock("minecraft:water", false));
    assert(livemap::isPlantBlock("minecraft:tall_grass"));
    assert(livemap::isPlantBlock("minecraft:bush"));
    assert(!livemap::isPlantBlock("minecraft:grass_block"));
    assert(!livemap::isPlantBlock("minecraft:grass_path"));
    assert(!livemap::isPlantBlock("minecraft:dirt_with_roots"));
    assert(livemap::isMapDecorationBlock("minecraft:iron_bars"));
    assert(livemap::isMapDecorationBlock("minecraft:cake"));
    assert(livemap::isMapDecorationBlock("minecraft:end_rod"));
    assert(livemap::isMapDecorationBlock("minecraft:unpowered_repeater"));
    assert(livemap::isMapDecorationBlock("minecraft:powered_comparator"));
    assert(livemap::isMapDecorationBlock("minecraft:lantern"));
    assert(livemap::isMapDecorationBlock("minecraft:soul_lantern"));
    assert(!livemap::isMapDecorationBlock("minecraft:sea_lantern"));
    assert(!livemap::isMapDecorationBlock("minecraft:jack_o_lantern"));
    assert(livemap::isMapDecorationBlock("minecraft:tube_coral"));
    assert(livemap::isMapDecorationBlock("minecraft:tube_coral_fan"));
    assert(livemap::isMapDecorationBlock("minecraft:horn_coral"));
    assert(!livemap::isMapDecorationBlock("minecraft:tube_coral_block"));
    assert(!livemap::isMapDecorationBlock("minecraft:dead_tube_coral_block"));
    assert(livemap::isMapDecorationBlock("minecraft:sea_pickle"));
    assert(livemap::isMapDecorationBlock("minecraft:bush"));
    assert(livemap::isMapDecorationBlock("minecraft:leaf_litter"));
    assert(!livemap::isMapDecorationBlock("minecraft:cherry_leaves"));
    assert(!livemap::isMapDecorationBlock("minecraft:glass"));
}

void testLandConfigParsing()
{
    const std::string json = R"json({
      "GieZi8670": [
        {
          "主城区": {
            "posa": "-375, 70, -473",
            "posb": "-227, 300, -580",
            "dim": "Overworld",
            "member": ["GieZi8670", "wingxia"],
            "tpposx": "-352",
            "tpposy": "70",
            "tpposz": "-479",
            "permission": [
              {"containter": "false"},
              {"build": "false"},
              {"mine": "false"},
              {"tp": "true"}
            ],
            "in": false,
            "son": ["猪人塔"]
          }
        },
        {
          "猪人塔": {
            "posa": "-329, 70, -544",
            "posb": "-300, 117, -510",
            "dim": "Overworld",
            "member": ["wingxia", "GieZi8670"],
            "tpposx": "-317",
            "tpposy": "75",
            "tpposz": "-534",
            "permission": [
              {"containter": "false"},
              {"build": "false"},
              {"mine": "false"},
              {"tp": "false"}
            ],
            "in": true,
            "father": "主城区",
            "son": []
          }
        },
        {
          "末地": {
            "posa": "100, 50, 0",
            "posb": "100, 50, 0",
            "dim": "TheEnd",
            "member": [],
            "tpposx": "100",
            "tpposy": "50",
            "tpposz": "0",
            "in": false,
            "son": []
          }
        },
        {
          "布尔公开": {
            "posa": "8, 63, 9",
            "posb": "16, 80, 20",
            "dim": "Overworld",
            "member": [],
            "tpposx": "12",
            "tpposy": "64",
            "tpposz": "14",
            "tppublic": true,
            "in": false,
            "son": []
          }
        },
        {
          "缺字段": {
            "posa": "0, 0, 0",
            "posb": "1, 1, 1",
            "dim": "Overworld"
          }
        }
      ]
    })json";

    const auto parsed = livemap::parseLandConfig(json, "Bedrock level", 123);
    assert(parsed.source_valid);
    assert(parsed.claims.size() == 4);
    assert(parsed.skipped_entries == 1);
    assert(parsed.claims[0].owner == "GieZi8670");
    assert(parsed.claims[0].name == "主城区");
    assert(parsed.claims[0].world == "Bedrock level");
    assert(parsed.claims[0].dimension == "Overworld");
    assert(parsed.claims[0].min_x == -375);
    assert(parsed.claims[0].max_x == -227);
    assert(parsed.claims[0].min_y == 70);
    assert(parsed.claims[0].max_y == 300);
    assert(parsed.claims[0].min_z == -580);
    assert(parsed.claims[0].max_z == -473);
    assert(parsed.claims[0].teleport.x == -352);
    assert(parsed.claims[0].teleport.y == 70);
    assert(parsed.claims[0].teleport.z == -479);
    assert(parsed.claims[0].members.size() == 2);
    assert(parsed.claims[0].children.size() == 1);
    assert(!parsed.claims[0].nested);
    assert(parsed.claims[0].public_teleport);
    assert(parsed.claims[1].parent == "主城区");
    assert(parsed.claims[1].nested);
    assert(!parsed.claims[1].public_teleport);
    assert(!parsed.claims[2].public_teleport);
    assert(parsed.claims[2].min_x == parsed.claims[2].max_x);
    assert(parsed.claims[2].min_z == parsed.claims[2].max_z);
    assert(parsed.claims[3].public_teleport);

    const auto serialized = livemap::serializeLandBatch(parsed.claims);
    assert(serialized.find("\"claims\"") != std::string::npos);
    assert(serialized.find("\"owner\":\"GieZi8670\"") != std::string::npos);
    assert(serialized.find("\"name\":\"主城区\"") != std::string::npos);
    assert(serialized.find("\"teleport\":{\"x\":-352,\"y\":70,\"z\":-479}") != std::string::npos);
    assert(serialized.find("\"publicTeleport\":true") != std::string::npos);
    assert(serialized.find("\"publicTeleport\":false") != std::string::npos);
    assert(serialized.find("\"nested\":true") != std::string::npos);

    const auto empty = livemap::parseLandConfig("{}", "Bedrock level", 456);
    assert(empty.source_valid);
    assert(empty.claims.empty());
    const auto authoritative_empty =
        livemap::serializeLandBatch(empty.claims, "Bedrock level", {"Overworld", "Nether", "TheEnd"});
    assert(authoritative_empty.find("\"world\":\"Bedrock level\"") != std::string::npos);
    assert(authoritative_empty.find("\"dimensions\":[\"Overworld\",\"Nether\",\"TheEnd\"]") != std::string::npos);
    assert(authoritative_empty.find("\"claims\":[]") != std::string::npos);

    assert(!livemap::parseLandConfig("{", "Bedrock level", 456).source_valid);
    assert(!livemap::parseLandConfig("[]", "Bedrock level", 456).source_valid);
    const auto missing_path = std::filesystem::temp_directory_path() / "live_map_missing_land_config.json";
    std::filesystem::remove(missing_path);
    assert(!livemap::loadLandConfig(missing_path, "Bedrock level", 456).source_valid);
}

void testProtocol()
{
    const std::vector<livemap::PlayerState> players = {{
        "uuid",
        "Player \"One\"",
        "xuid-1",
        "world",
        "Overworld",
        12.5,
        64.0,
        -8.25,
        90.0,
        0.0,
        "avatarhash",
        "iVBORw0KGgo=",
        42,
    }};
    const auto json = livemap::serializePlayerSnapshot(players);
    assert(json.find("player_snapshot") != std::string::npos);
    assert(json.find("Player \\\"One\\\"") != std::string::npos);
    assert(json.find("\"xuid\":\"xuid-1\"") != std::string::npos);
    assert(json.find("\"avatarHash\":\"avatarhash\"") != std::string::npos);
    assert(json.find("\"avatarPngBase64\":\"iVBORw0KGgo=\"") != std::string::npos);
    assert(json.find("\"z\":-8.25") != std::string::npos);
    assert(livemap::serializePlayerSnapshot({}) == "{\"type\":\"player_snapshot\",\"players\":[]}");

    const auto heartbeat = livemap::serializeHeartbeat("vvnas", 7);
    assert(heartbeat == "{\"type\":\"heartbeat\",\"serverId\":\"vvnas\",\"updatedAt\":7}");

}

void testBase64()
{
    const std::vector<std::uint8_t> bytes = {'M', 'a', 'p'};
    assert(livemap::base64Encode(bytes) == "TWFw");
    const std::vector<std::uint8_t> one = {'M'};
    assert(livemap::base64Encode(one) == "TQ==");
}

void testPngEncoding()
{
    auto image = livemap::makeRgbaImage(2, 2);
    image.pixels = {
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
    };
    const auto png = livemap::encodePngRgba(image);
    assert(png.size() > 40);
    assert(png[0] == 137);
    assert(png[1] == 80);
    assert(png[2] == 78);
    assert(png[3] == 71);
    assert(std::string(reinterpret_cast<const char *>(png.data() + 12), 4) == "IHDR");

    auto tile = livemap::makeRgbaImage(livemap::kMapTileSize, livemap::kMapTileSize);
    for (int y = 0; y < tile.height; ++y) {
        for (int x = 0; x < tile.width; ++x) {
            const auto offset =
                (static_cast<std::size_t>(y) * static_cast<std::size_t>(tile.width) + static_cast<std::size_t>(x)) * 4;
            const auto block_x = static_cast<std::uint8_t>(x / 16);
            const auto block_y = static_cast<std::uint8_t>(y / 16);
            tile.pixels[offset] = static_cast<std::uint8_t>(32 + block_x * 9);
            tile.pixels[offset + 1] = static_cast<std::uint8_t>(48 + block_y * 7);
            tile.pixels[offset + 2] = static_cast<std::uint8_t>(80 + (block_x + block_y) * 4);
            tile.pixels[offset + 3] = 255;
        }
    }
    const auto compressed_tile = livemap::encodePngRgba(tile);
    assert(compressed_tile.size() < tile.pixels.size() / 4);

    auto gradient_tile = livemap::makeRgbaImage(livemap::kMapTileSize, livemap::kMapTileSize);
    for (int y = 0; y < gradient_tile.height; ++y) {
        for (int x = 0; x < gradient_tile.width; ++x) {
            const auto offset =
                (static_cast<std::size_t>(y) * static_cast<std::size_t>(gradient_tile.width) +
                 static_cast<std::size_t>(x)) *
                4;
            gradient_tile.pixels[offset] = static_cast<std::uint8_t>(x + y);
            gradient_tile.pixels[offset + 1] = static_cast<std::uint8_t>(x * 2 + y);
            gradient_tile.pixels[offset + 2] = static_cast<std::uint8_t>(x + y * 2);
            gradient_tile.pixels[offset + 3] = 255;
        }
    }
    const auto compressed_gradient = livemap::encodePngRgba(gradient_tile);
    assert(compressed_gradient.size() < gradient_tile.pixels.size() / 16);

    auto detailed_tile = livemap::makeRgbaImage(livemap::kMapTileSize, livemap::kMapTileSize);
    std::uint32_t random_state = 0x12345678U;
    for (std::size_t offset = 0; offset < detailed_tile.pixels.size(); offset += 4) {
        for (std::size_t channel = 0; channel < 3; ++channel) {
            random_state ^= random_state << 13U;
            random_state ^= random_state >> 17U;
            random_state ^= random_state << 5U;
            detailed_tile.pixels[offset + channel] = static_cast<std::uint8_t>(random_state);
        }
        detailed_tile.pixels[offset + 3] = 255;
    }
    const auto compressed_detail = livemap::encodePngRgba(detailed_tile);
    assert(compressed_detail.size() < detailed_tile.pixels.size());
}

void testSha256AndHmac()
{
    assert(livemap::hexLower(livemap::sha256("abc")) ==
           "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const std::vector<std::uint8_t> key = {'k', 'e', 'y'};
    assert(livemap::hexLower(livemap::hmacSha256(key, "The quick brown fox jumps over the lazy dog")) ==
           "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
}

void testR2SigningAndRateLimit()
{
    livemap::R2SigningInput input;
    input.endpoint = "https://account.r2.cloudflarestorage.com";
    input.bucket = "bucket";
    input.key = "map-tiles/v2/Bedrock_level/Overworld/z4/-1/2.png";
    input.access_key_id = "ACCESS";
    input.secret_access_key = "SECRET";
    input.amz_date = "20260612T000000Z";
    input.date_stamp = "20260612";
    input.payload_sha256 = livemap::hexLower(livemap::sha256("payload"));
    const auto signed_request = livemap::signR2Request(input);
    assert(signed_request.url ==
           "https://account.r2.cloudflarestorage.com/bucket/map-tiles/v2/Bedrock_level/Overworld/z4/-1/2.png");
    assert(signed_request.canonical_request.find("host:account.r2.cloudflarestorage.com") != std::string::npos);

    input.method = "DELETE";
    input.payload_sha256 = livemap::hexLower(livemap::sha256(std::vector<std::uint8_t>{}));
    const auto signed_delete = livemap::signR2Request(input);
    assert(signed_delete.canonical_request.starts_with("DELETE\n"));
    assert(signed_delete.canonical_request.find(input.payload_sha256) != std::string::npos);
    assert(signed_request.authorization.find("Credential=ACCESS/20260612/auto/s3/aws4_request") !=
           std::string::npos);

    livemap::UploadRateLimiter limiter(2);
    assert(limiter.delayMs(0) == 0);
    limiter.record(0);
    assert(limiter.delayMs(1000) == 0);
    limiter.record(1000);
    assert(limiter.delayMs(2000) == 58000);
    assert(limiter.delayMs(61000) == 0);
}

livemap::ChunkSnapshot makeBaselineTestSnapshot()
{
    livemap::ChunkSnapshot snapshot;
    snapshot.world = "world";
    snapshot.dimension = "Overworld";
    snapshot.chunk_x = -1;
    snapshot.chunk_z = 2;
    snapshot.palette = {"minecraft:grass_block", "minecraft:water"};
    snapshot.blocks.fill(0);
    snapshot.heights.fill(64);
    snapshot.blocks[3] = 1;
    snapshot.heights[3] = 62;
    snapshot.block_states[3] = {{"facing_direction", 1}};
    snapshot.overlay_blocks.fill(0);
    snapshot.overlay_heights.fill(-64);
    snapshot.updated_at_ms = 99;
    return snapshot;
}

void testChunkSnapshotFingerprint()
{
    auto first = makeBaselineTestSnapshot();
    auto second = makeBaselineTestSnapshot();
    assert(livemap::fingerprintChunkSnapshot(first) == livemap::fingerprintChunkSnapshot(second));

    livemap::applyBlockUpdatesToSnapshot(second, {{3, 0, "minecraft:stone", 70, {}, "minecraft:air", -64, {}}}, 100);
    assert(livemap::fingerprintChunkSnapshot(first) != livemap::fingerprintChunkSnapshot(second));
    assert(second.updated_at_ms == 100);

    auto third = makeBaselineTestSnapshot();
    livemap::applyBlockUpdatesToSnapshot(
        third, {{3, 0, "minecraft:grass_block", 64, {}, "minecraft:poppy", 65, {}}}, 101);
    assert(livemap::fingerprintChunkSnapshot(first) != livemap::fingerprintChunkSnapshot(third));

    auto fourth = makeBaselineTestSnapshot();
    livemap::applyBlockUpdatesToSnapshot(
        fourth, {{3, 0, "minecraft:water", 62, {{"facing_direction", 2}}, "minecraft:air", -64, {}}}, 102);
    assert(livemap::fingerprintChunkSnapshot(first) != livemap::fingerprintChunkSnapshot(fourth));
    assert(std::get<int>(fourth.block_states[3].at("facing_direction")) == 2);
}

void testTileRendering()
{
    auto dir = std::filesystem::temp_directory_path() / "live_map_tile_render_test";
    std::filesystem::remove_all(dir);

    livemap::LiveMapSettings settings;
    settings.tile_data_dir = dir.string();
    settings.tile_min_zoom = -8;
    settings.r2_key_prefix = "map-tiles/v2";

    livemap::ChunkSnapshot snapshot;
    snapshot.world = "Bedrock level";
    snapshot.dimension = "Overworld";
    snapshot.chunk_x = -1;
    snapshot.chunk_z = 2;
    snapshot.palette = {"minecraft:grass_block", "minecraft:redstone_wire", "minecraft:air"};
    snapshot.blocks.fill(0);
    snapshot.heights.fill(64);
    snapshot.block_states[0] = {{"redstone_signal", 12}};
    snapshot.blocks[0] = 1;
    snapshot.overlay_blocks.fill(2);
    snapshot.overlay_heights.fill(-64);
    snapshot.updated_at_ms = 123;

    const auto image = livemap::renderChunkTile(snapshot);
    assert(image.width == 256);
    assert(image.height == 256);
    bool saw_alpha = false;
    for (std::size_t index = 3; index < image.pixels.size(); index += 4) {
        if (image.pixels[index] != 0) {
            saw_alpha = true;
            break;
        }
    }
    assert(saw_alpha);

    const auto result = livemap::renderChunkSnapshotsToTiles(settings, {snapshot});
    assert(result.ok);
    assert(result.chunks.size() == 1);
    assert(result.tiles.size() == 13);
    assert(std::filesystem::exists(livemap::tilePngPath(settings, "Bedrock level", "Overworld", 4, -1, 2)));
    assert(std::filesystem::exists(livemap::tilePngPath(settings, "Bedrock level", "Overworld", 3, -1, 1)));
    assert(livemap::renderedTileFilesExistForChunk(settings, {"Bedrock level", "Overworld", -1, 2}));
    assert(livemap::tileR2Key(settings, "Bedrock level", "Overworld", 4, -1, 2) ==
           "map-tiles/v2/Bedrock_level/Overworld/z4/-1/2.png");
    const auto json = livemap::serializeTilesReady(result);
    assert(json.find("\"type\":\"tiles_ready\"") != std::string::npos);
    assert(json.find("\"zoom\":-8") != std::string::npos);

    std::filesystem::remove(livemap::tilePngPath(settings, "Bedrock level", "Overworld", 3, -1, 1));
    assert(!livemap::renderedTileFilesExistForChunk(settings, {"Bedrock level", "Overworld", -1, 2}));

    const auto rerendered = livemap::renderChunkSnapshotsToTiles(settings, {snapshot});
    assert(rerendered.ok);
    assert(livemap::renderedTileFilesExistForChunk(settings, {"Bedrock level", "Overworld", -1, 2}));

    std::filesystem::remove(livemap::tileRawPath(settings, "Bedrock level", "Overworld", 4, -1, 2));
    assert(!livemap::renderedTileFilesExistForChunk(settings, {"Bedrock level", "Overworld", -1, 2}));

    std::filesystem::remove_all(dir);
}

livemap::ChunkSnapshot makeTilePyramidSnapshot(int chunk_x, int chunk_z, std::int64_t updated_at_ms)
{
    livemap::ChunkSnapshot snapshot;
    snapshot.world = "Bedrock level";
    snapshot.dimension = "Overworld";
    snapshot.chunk_x = chunk_x;
    snapshot.chunk_z = chunk_z;
    snapshot.palette = {"minecraft:grass_block", "minecraft:air"};
    snapshot.blocks.fill(0);
    snapshot.heights.fill(64);
    snapshot.overlay_blocks.fill(1);
    snapshot.overlay_heights.fill(-64);
    snapshot.updated_at_ms = updated_at_ms;
    return snapshot;
}

void testTilePyramidBatchingAndRepair()
{
    auto dir = std::filesystem::temp_directory_path() / "live_map_tile_pyramid_repair_test";
    std::filesystem::remove_all(dir);

    livemap::LiveMapSettings settings;
    settings.tile_data_dir = dir.string();
    settings.tile_min_zoom = 3;

    const auto adjacent = livemap::renderChunkSnapshotsToTiles(
        settings, {makeTilePyramidSnapshot(0, 0, 100), makeTilePyramidSnapshot(1, 0, 101)});
    assert(adjacent.ok);
    assert(adjacent.chunks.size() == 2);
    assert(adjacent.tiles.size() == 3);
    const auto parent = livemap::readRawRgba(
        livemap::tileRawPath(settings, "Bedrock level", "Overworld", 3, 0, 0),
        livemap::kMapTileSize, livemap::kMapTileSize);
    const auto alpha_at = [&parent](int x, int y) {
        return parent.pixels[(static_cast<std::size_t>(y) * parent.width + static_cast<std::size_t>(x)) * 4 + 3];
    };
    assert(alpha_at(64, 64) > 0);
    assert(alpha_at(192, 64) > 0);

    std::filesystem::remove_all(dir);
    settings.tile_min_zoom = -1;
    const std::vector<livemap::ChunkSnapshot> historical = {
        makeTilePyramidSnapshot(-9, 4, 200),
        makeTilePyramidSnapshot(20, -17, 201),
        makeTilePyramidSnapshot(21, -17, 202),
    };
    const auto historical_render = livemap::renderChunkSnapshotsToTiles(settings, historical);
    assert(historical_render.ok);
    for (const auto &snapshot : historical) {
        assert(livemap::renderedTileFilesExistForChunk(
            settings, {snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z}));
    }

    settings.tile_min_zoom = -4;
    for (const auto &snapshot : historical) {
        assert(!livemap::renderedTileFilesExistForChunk(
            settings, {snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z}));
    }

    const auto repair = livemap::repairMissingTilePyramid(settings);
    assert(repair.ok);
    assert(repair.tiles.size() == 6);
    for (const auto &tile : repair.tiles) {
        assert(tile.zoom <= -2);
        assert(tile.has_pixels);
    }
    for (const auto &snapshot : historical) {
        assert(livemap::renderedTileFilesExistForChunk(
            settings, {snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z}));
    }
    const auto repair_json = livemap::serializeTilesReady(repair);
    assert(repair_json.find("\"chunks\":[]") != std::string::npos);
    assert(repair_json.find("\"updatedAt\":0") == std::string::npos);

    const auto no_op_repair = livemap::repairMissingTilePyramid(settings);
    assert(no_op_repair.ok);
    assert(no_op_repair.tiles.empty());
    assert(no_op_repair.optimized_png_tiles == 0);

    const auto legacy_png = livemap::tilePngPath(settings, "Bedrock level", "Overworld", 4, -9, 4);
    const auto compression_marker = std::filesystem::path(settings.tile_data_dir) / ".png-filter-zlib-v1";
    std::filesystem::remove(compression_marker);
    {
        std::ofstream out(legacy_png, std::ios::binary | std::ios::trunc);
        std::vector<char> legacy_bytes(
            static_cast<std::size_t>(livemap::kMapTileSize) * livemap::kMapTileSize * 4 + 512, '\0');
        out.write(legacy_bytes.data(), static_cast<std::streamsize>(legacy_bytes.size()));
    }
    const auto optimized_repair = livemap::repairMissingTilePyramid(settings);
    assert(optimized_repair.ok);
    assert(optimized_repair.optimized_png_tiles == 1);
    assert(std::filesystem::file_size(legacy_png) <
           static_cast<std::uintmax_t>(livemap::kMapTileSize) * livemap::kMapTileSize);
    assert(std::filesystem::exists(compression_marker));

    const auto damaged_png = livemap::tilePngPath(settings, "Bedrock level", "Overworld", -3, -1, 0);
    const auto damaged_raw = livemap::tileRawPath(settings, "Bedrock level", "Overworld", -3, -1, 0);
    std::filesystem::remove(damaged_png);
    {
        std::ofstream out(damaged_raw, std::ios::binary | std::ios::trunc);
        out.put('\0');
    }
    assert(!livemap::renderedTileFilesExistForChunk(
        settings, {historical[0].world, historical[0].dimension, historical[0].chunk_x, historical[0].chunk_z}));
    const auto damaged_repair = livemap::repairMissingTilePyramid(settings);
    assert(damaged_repair.ok);
    assert(damaged_repair.tiles.size() == 2);
    assert(damaged_repair.tiles[0].zoom == -3);
    assert(damaged_repair.tiles[1].zoom == -4);
    assert(std::filesystem::file_size(damaged_raw) ==
           static_cast<std::uintmax_t>(livemap::kMapTileSize) * livemap::kMapTileSize * 4);

    std::filesystem::remove_all(dir);

    settings.tile_min_zoom = -4;
    const auto first_branch = livemap::renderChunkSnapshotsToTiles(settings, {makeTilePyramidSnapshot(0, 0, 300)});
    assert(first_branch.ok);
    const auto shared_ancestor_path =
        livemap::tileRawPath(settings, "Bedrock level", "Overworld", -3, 0, 0);
    const auto before = livemap::readRawRgba(shared_ancestor_path, livemap::kMapTileSize, livemap::kMapTileSize);
    const auto alpha_pixels = [](const livemap::RgbaImage &image) {
        std::size_t count = 0;
        for (std::size_t index = 3; index < image.pixels.size(); index += 4) {
            count += image.pixels[index] == 0 ? 0 : 1;
        }
        return count;
    };
    const auto before_alpha = alpha_pixels(before);

    settings.tile_min_zoom = -1;
    const auto second_branch =
        livemap::renderChunkSnapshotsToTiles(settings, {makeTilePyramidSnapshot(64, 0, 301)});
    assert(second_branch.ok);
    settings.tile_min_zoom = -4;
    const auto propagated_repair = livemap::repairMissingTilePyramid(settings);
    assert(propagated_repair.ok);
    assert(propagated_repair.tiles.size() == 3);
    assert(propagated_repair.tiles[0].zoom == -2);
    assert(propagated_repair.tiles[1].zoom == -3);
    assert(propagated_repair.tiles[2].zoom == -4);
    const auto after = livemap::readRawRgba(shared_ancestor_path, livemap::kMapTileSize, livemap::kMapTileSize);
    assert(alpha_pixels(after) > before_alpha);
    assert(livemap::repairMissingTilePyramid(settings).tiles.empty());

    std::filesystem::remove_all(dir);
}

void testBaseTilePngRepairBeforeParentDerivation()
{
    const auto dir = std::filesystem::temp_directory_path() / "live_map_base_tile_png_repair_test";
    std::filesystem::remove_all(dir);

    livemap::LiveMapSettings settings;
    settings.tile_data_dir = dir.string();
    settings.tile_min_zoom = 1;

    const auto snapshot = makeTilePyramidSnapshot(-3, 5, 400);
    const auto rendered = livemap::renderChunkSnapshotsToTiles(settings, {snapshot});
    assert(rendered.ok);
    assert(rendered.tiles.size() == 4);

    const auto base_png =
        livemap::tilePngPath(settings, snapshot.world, snapshot.dimension, livemap::kMapTileBaseZoom,
                             snapshot.chunk_x, snapshot.chunk_z);
    const auto base_raw =
        livemap::tileRawPath(settings, snapshot.world, snapshot.dimension, livemap::kMapTileBaseZoom,
                             snapshot.chunk_x, snapshot.chunk_z);
    const auto expected_png =
        livemap::encodePngRgba(livemap::readRawRgba(base_raw, livemap::kMapTileSize, livemap::kMapTileSize));

    const auto read_bytes = [](const std::filesystem::path &path) {
        const auto size = std::filesystem::file_size(path);
        std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
        std::ifstream in(path, std::ios::binary);
        assert(in);
        in.read(reinterpret_cast<char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        assert(in.gcount() == static_cast<std::streamsize>(bytes.size()));
        return bytes;
    };
    const auto assert_repaired = [&]() {
        const auto repaired = livemap::repairMissingTilePyramid(settings);
        assert(repaired.ok);
        assert(repaired.tiles.size() == 4);
        for (std::size_t index = 0; index < repaired.tiles.size(); ++index) {
            assert(repaired.tiles[index].zoom == livemap::kMapTileBaseZoom - static_cast<int>(index));
            assert(repaired.tiles[index].has_pixels);
        }
        assert(read_bytes(base_png) == expected_png);
        assert(livemap::repairMissingTilePyramid(settings).tiles.empty());
    };

    std::filesystem::remove(base_png);
    assert_repaired();

    {
        std::ofstream out(base_png, std::ios::binary | std::ios::trunc);
    }
    assert_repaired();

    auto invalid_png = expected_png;
    assert(invalid_png.size() > 29);
    invalid_png[29] ^= 0xFFU;
    {
        std::ofstream out(base_png, std::ios::binary | std::ios::trunc);
        out.write(reinterpret_cast<const char *>(invalid_png.data()),
                  static_cast<std::streamsize>(invalid_png.size()));
    }
    assert_repaired();

    std::filesystem::remove_all(dir);
}

void testChunkBaselineIndex()
{
    const auto path = std::filesystem::temp_directory_path() / "live_map_chunk_baselines_test.tsv";
    std::filesystem::remove(path);

    auto snapshot = makeBaselineTestSnapshot();
    const auto coord = livemap::ChunkCoord{snapshot.world, snapshot.dimension, snapshot.chunk_x, snapshot.chunk_z};
    livemap::ChunkBaselineMap baselines;
    baselines[coord] = {coord, livemap::fingerprintChunkSnapshot(snapshot), snapshot.updated_at_ms};

    std::string error;
    assert(livemap::saveChunkBaselineIndexAtomic(path, baselines, &error));

    auto loaded = livemap::loadChunkBaselineIndex(path);
    assert(loaded.skipped_lines == 0);
    assert(loaded.baselines.size() == 1);
    assert(loaded.baselines.at(coord).fingerprint == baselines.at(coord).fingerprint);
    assert(loaded.baselines.at(coord).updated_at_ms == 99);

    livemap::applyBlockUpdatesToSnapshot(snapshot, {{1, 1, "minecraft:stone", 71, {}, "minecraft:air", -64, {}}},
                                         101);
    baselines[coord] = {coord, livemap::fingerprintChunkSnapshot(snapshot), snapshot.updated_at_ms};
    assert(livemap::saveChunkBaselineIndexAtomic(path, baselines, &error));
    loaded = livemap::loadChunkBaselineIndex(path);
    assert(loaded.baselines.size() == 1);
    assert(loaded.baselines.at(coord).updated_at_ms == 101);

    {
        std::ofstream out(path, std::ios::app);
        out << "bad\tline\n";
    }
    loaded = livemap::loadChunkBaselineIndex(path);
    assert(loaded.skipped_lines == 1);
    assert(loaded.baselines.size() == 1);
    std::filesystem::remove(path);
}

void testSettingsLegacyKeys()
{
    const auto path = std::filesystem::temp_directory_path() / "live_map_legacy_settings_test.json";
    {
        std::ofstream out(path);
        out << "{\n"
            << "  \"worker_url\": \"https://example.invalid\",\n"
            << "  \"plugin_token\": \"token\",\n"
            << "  \"server_id\": \"vvnas\",\n"
            << "  \"dimensions\": [\"Overworld\", \"Nether\"],\n"
            << "  \"scan_radius_chunks\": 99,\n"
            << "  \"tile_refresh_seconds\": 2,\n"
            << "  \"player_push_seconds\": 0,\n"
            << "  \"max_tiles_per_refresh\": 999,\n"
            << "  \"player_seed_radius_chunks\": 99,\n"
            << "  \"player_seed_interval_seconds\": 1,\n"
            << "  \"max_seed_chunks_per_pulse\": 99,\n"
            << "  \"seed_pulse_seconds\": 0,\n"
            << "  \"player_seed_join_delay_seconds\": 999,\n"
            << "  \"chunk_upload_batch_size\": 999,\n"
            << "  \"chunk_upload_flush_seconds\": 0,\n"
            << "  \"http_timeout_seconds\": 999,\n"
            << "  \"dirty_block_push_seconds\": 0,\n"
            << "  \"land_push_seconds\": 1,\n"
            << "  \"max_dirty_blocks_per_push\": 99999,\n"
            << "  \"max_dirty_chunks_per_push\": 999,\n"
            << "  \"max_upload_queue_size\": 99999,\n"
            << "  \"upload_tiles\": false,\n"
            << "  \"auto_seed_chunks\": true,\n"
            << "  \"upload_dirty_blocks\": false,\n"
            << "  \"upload_players\": false,\n"
            << "  \"upload_lands\": false\n"
            << "}\n";
    }

    const auto settings = livemap::loadSettings(path);
    assert(settings.worker_url == "https://example.invalid");
    assert(settings.plugin_token == "token");
    assert(settings.server_id == "vvnas");
    assert(settings.dimensions.size() == 2);
    assert(settings.scan_radius_chunks == 16);
    assert(settings.chunk_refresh_seconds == 5);
    assert(settings.player_push_seconds == 1);
    assert(settings.max_chunks_per_refresh == 64);
    assert(settings.player_seed_radius_chunks == 8);
    assert(settings.player_seed_interval_seconds == 30);
    assert(settings.max_seed_chunks_per_pulse == 16);
    assert(settings.seed_pulse_seconds == 1);
    assert(settings.player_seed_join_delay_seconds == 300);
    assert(settings.chunk_upload_batch_size == 128);
    assert(settings.chunk_upload_flush_seconds == 1);
    assert(settings.http_timeout_seconds == 120);
    assert(settings.dirty_block_push_seconds == 1);
    assert(settings.land_push_seconds == 10);
    assert(settings.max_dirty_blocks_per_push == 4096);
    assert(settings.max_dirty_chunks_per_push == 256);
    assert(settings.max_upload_queue_size == 4096);
    assert(!settings.upload_chunks);
    assert(settings.auto_seed_chunks);
    assert(!settings.upload_dirty_blocks);
    assert(!settings.upload_players);
    assert(!settings.upload_lands);
    std::filesystem::remove(path);
}

void testSettingsDirtyBatchDefaults()
{
    const auto path = std::filesystem::temp_directory_path() / "live_map_dirty_batch_defaults_test.json";
    std::filesystem::remove(path);
    const auto settings = livemap::loadSettings(path);
    assert(settings.player_seed_interval_seconds == 60);
    assert(settings.max_seed_chunks_per_pulse == 4);
    assert(settings.tile_min_zoom == -8);
    assert(settings.dirty_block_push_seconds == 60);
    assert(settings.max_dirty_blocks_per_push == 2048);
    assert(settings.max_dirty_chunks_per_push == 64);
}

void testSettingsNewKeysOverrideLegacyKeys()
{
    const auto path = std::filesystem::temp_directory_path() / "live_map_new_settings_test.json";
    {
        std::ofstream out(path);
        out << "{\n"
            << "  \"chunk_refresh_seconds\": 30,\n"
            << "  \"tile_refresh_seconds\": 5,\n"
            << "  \"max_chunks_per_refresh\": 4,\n"
            << "  \"max_tiles_per_refresh\": 64,\n"
            << "  \"http_timeout_seconds\": 2,\n"
            << "  \"land_config_file\": \"/tmp/land.json\",\n"
            << "  \"local_server_url\": \"http://127.0.0.1:9001\",\n"
            << "  \"tile_data_dir\": \"/tmp/live-map-tiles\",\n"
            << "  \"tile_min_zoom\": -99,\n"
            << "  \"tile_max_zoom\": 4,\n"
            << "  \"render_worker_threads\": 99,\n"
            << "  \"r2_enabled\": true,\n"
            << "  \"r2_endpoint\": \"https://account.r2.cloudflarestorage.com\",\n"
            << "  \"r2_bucket\": \"bucket\",\n"
            << "  \"r2_region\": \"auto\",\n"
            << "  \"r2_key_prefix\": \"map-tiles/v2\",\n"
            << "  \"r2_max_concurrent_uploads\": 99,\n"
            << "  \"r2_max_uploads_per_minute\": 9999,\n"
            << "  \"r2_retry_count\": 99,\n"
            << "  \"r2_retry_backoff_ms\": 1,\n"
            << "  \"land_push_seconds\": 120,\n"
            << "  \"upload_chunks\": true,\n"
            << "  \"upload_tiles\": false,\n"
            << "  \"auto_seed_chunks\": false,\n"
            << "  \"upload_lands\": true\n"
            << "}\n";
    }

    const auto settings = livemap::loadSettings(path);
    assert(settings.chunk_refresh_seconds == 30);
    assert(settings.max_chunks_per_refresh == 4);
    assert(settings.chunk_upload_batch_size == 8);
    assert(settings.http_timeout_seconds == 5);
    assert(settings.land_config_file == "/tmp/land.json");
    assert(settings.local_server_url == "http://127.0.0.1:9001");
    assert(settings.tile_data_dir == "/tmp/live-map-tiles");
    assert(settings.tile_min_zoom == -8);
    assert(settings.tile_max_zoom == 4);
    assert(settings.render_worker_threads == 8);
    assert(settings.r2_enabled);
    assert(settings.r2_endpoint == "https://account.r2.cloudflarestorage.com");
    assert(settings.r2_bucket == "bucket");
    assert(settings.r2_region == "auto");
    assert(settings.r2_key_prefix == "map-tiles/v2");
    assert(settings.r2_max_concurrent_uploads == 4);
    assert(settings.r2_max_uploads_per_minute == 600);
    assert(settings.r2_retry_count == 10);
    assert(settings.r2_retry_backoff_ms == 100);
    assert(settings.land_push_seconds == 120);
    assert(settings.upload_chunks);
    assert(!settings.auto_seed_chunks);
    assert(settings.upload_lands);
    std::filesystem::remove(path);
}

void testDirtyBlockChunkLimitedDrain()
{
    livemap::DirtyBlockTracker tracker;
    assert(tracker.markBlock("world", "Overworld", 0, 0, 64));
    assert(!tracker.markBlock("world", "Overworld", 0, 0, 70));
    assert(tracker.markBlock("world", "Overworld", 1, 0, 64));
    assert(tracker.markBlock("world", "Overworld", 16, 0, 64));
    assert(tracker.markBlock("world", "Overworld", 32, 0, 64));
    assert(tracker.size() == 4);

    const auto first = tracker.drainForChunkLimit(3, 2);
    assert(first.size() == 3);
    assert(tracker.size() == 1);
    bool saw_updated_column = false;
    for (const auto &column : first) {
        if (column.coord.x == 0 && column.coord.z == 0) {
            assert(column.touched_y == 70);
            saw_updated_column = true;
        }
    }
    assert(saw_updated_column);

    const auto second = tracker.drainForChunkLimit(10, 10);
    assert(second.size() == 1);
    assert(tracker.empty());

    livemap::DirtyBlockTracker sparse_tracker;
    assert(sparse_tracker.markBlock("world", "Overworld", 0, 0, 64));
    assert(sparse_tracker.markBlock("world", "Overworld", 16, 0, 64));
    assert(sparse_tracker.markBlock("world", "Overworld", 32, 0, 64));
    const auto sparse_first = sparse_tracker.drainForChunkLimit(10, 2);
    assert(sparse_first.size() == 2);
    assert(sparse_tracker.size() == 1);
    const auto sparse_second = sparse_tracker.drainForChunkLimit(10, 2);
    assert(sparse_second.size() == 1);
    assert(sparse_tracker.empty());
}

}  // namespace

int main()
{
    testTileMath();
    testChunkMath();
    testEmptyChunkSnapshotDetection();
    testMapBlockClassification();
    testLandConfigParsing();
    testDirtyTracker();
    testDirtyBlockTracker();
    testUploadPriorityQueue();
    testLatestUploadSlot();
    testProtocol();
    testBase64();
    testPngEncoding();
    testSha256AndHmac();
    testR2SigningAndRateLimit();
    testChunkSnapshotFingerprint();
    testChunkBaselineIndex();
    testTileRendering();
    testTilePyramidBatchingAndRepair();
    testBaseTilePngRepairBeforeParentDerivation();
    testSettingsLegacyKeys();
    testSettingsDirtyBatchDefaults();
    testSettingsNewKeysOverrideLegacyKeys();
    testDirtyBlockChunkLimitedDrain();
    std::cout << "livemap core tests passed\n";
    return 0;
}
