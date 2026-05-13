#include "livemap/base64.hpp"
#include "livemap/chunk.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"
#include "livemap/tile_math.hpp"

#include <cassert>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
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

void testProtocol()
{
    const std::vector<livemap::PlayerState> players = {{
        "uuid",
        "Player \"One\"",
        "world",
        "Overworld",
        12.5,
        64.0,
        -8.25,
        90.0,
        0.0,
        42,
    }};
    const auto json = livemap::serializePlayerSnapshot(players);
    assert(json.find("player_snapshot") != std::string::npos);
    assert(json.find("Player \\\"One\\\"") != std::string::npos);
    assert(json.find("\"z\":-8.25") != std::string::npos);

    const auto heartbeat = livemap::serializeHeartbeat("vvnas", 7);
    assert(heartbeat == "{\"type\":\"heartbeat\",\"serverId\":\"vvnas\",\"updatedAt\":7}");

    livemap::ChunkSnapshot snapshot;
    snapshot.world = "world";
    snapshot.dimension = "Overworld";
    snapshot.chunk_x = -1;
    snapshot.chunk_z = 2;
    snapshot.palette = {"minecraft:grass_block", "minecraft:water"};
    snapshot.blocks.fill(0);
    snapshot.blocks[3] = 1;
    snapshot.heights.fill(64);
    snapshot.heights[3] = 62;
    snapshot.updated_at_ms = 99;
    const auto chunk_json = livemap::serializeChunkSnapshot(snapshot);
    assert(chunk_json.find("\"chunkX\":-1") != std::string::npos);
    assert(chunk_json.find("\"palette\":[\"minecraft:grass_block\",\"minecraft:water\"]") != std::string::npos);
    assert(chunk_json.find("\"updatedAt\":99") != std::string::npos);

    livemap::BlockUpdateBatch batch;
    batch.world = "world";
    batch.dimension = "Overworld";
    batch.chunk_x = 0;
    batch.chunk_z = 0;
    batch.updates.push_back({1, 2, "minecraft:stone", 70});
    batch.updated_at_ms = 100;
    const auto update_json = livemap::serializeBlockUpdateBatch(batch);
    assert(update_json.find("\"updates\":[{\"localX\":1,\"localZ\":2") != std::string::npos);
    assert(update_json.find("\"block\":\"minecraft:stone\"") != std::string::npos);
}

void testBase64()
{
    const std::vector<std::uint8_t> bytes = {'M', 'a', 'p'};
    assert(livemap::base64Encode(bytes) == "TWFw");
    const std::vector<std::uint8_t> one = {'M'};
    assert(livemap::base64Encode(one) == "TQ==");
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
            << "  \"dirty_block_push_seconds\": 0,\n"
            << "  \"max_dirty_blocks_per_push\": 999,\n"
            << "  \"upload_tiles\": false,\n"
            << "  \"auto_seed_chunks\": true,\n"
            << "  \"upload_dirty_blocks\": false,\n"
            << "  \"upload_players\": false\n"
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
    assert(settings.dirty_block_push_seconds == 1);
    assert(settings.max_dirty_blocks_per_push == 512);
    assert(!settings.upload_chunks);
    assert(settings.auto_seed_chunks);
    assert(!settings.upload_dirty_blocks);
    assert(!settings.upload_players);
    std::filesystem::remove(path);
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
            << "  \"upload_chunks\": true,\n"
            << "  \"upload_tiles\": false,\n"
            << "  \"auto_seed_chunks\": false\n"
            << "}\n";
    }

    const auto settings = livemap::loadSettings(path);
    assert(settings.chunk_refresh_seconds == 30);
    assert(settings.max_chunks_per_refresh == 4);
    assert(settings.upload_chunks);
    assert(!settings.auto_seed_chunks);
    std::filesystem::remove(path);
}

}  // namespace

int main()
{
    testTileMath();
    testChunkMath();
    testDirtyTracker();
    testDirtyBlockTracker();
    testProtocol();
    testBase64();
    testSettingsLegacyKeys();
    testSettingsNewKeysOverrideLegacyKeys();
    std::cout << "livemap core tests passed\n";
    return 0;
}
