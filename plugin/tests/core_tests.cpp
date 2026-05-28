#include "livemap/baseline.hpp"
#include "livemap/base64.hpp"
#include "livemap/chunk.hpp"
#include "livemap/land.hpp"
#include "livemap/map_blocks.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"
#include "livemap/tile_math.hpp"
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
    snapshot.block_states[3] = {{"facing_direction", 1}};
    snapshot.overlay_blocks.fill(0);
    snapshot.overlay_heights.fill(-64);
    snapshot.palette.push_back("minecraft:poppy");
    snapshot.overlay_blocks[3] = 2;
    snapshot.overlay_heights[3] = 63;
    snapshot.overlay_states[3] = {{"open_bit", true}, {"direction", 2}};
    snapshot.updated_at_ms = 99;
    const auto chunk_json = livemap::serializeChunkSnapshot(snapshot);
    assert(chunk_json.find("\"chunkX\":-1") != std::string::npos);
    assert(chunk_json.find("\"palette\":[\"minecraft:grass_block\",\"minecraft:water\",\"minecraft:poppy\"]") != std::string::npos);
    assert(chunk_json.find("\"blockStates\"") != std::string::npos);
    assert(chunk_json.find("\"facing_direction\":1") != std::string::npos);
    assert(chunk_json.find("\"overlayBlocks\"") != std::string::npos);
    assert(chunk_json.find("\"overlayHeights\"") != std::string::npos);
    assert(chunk_json.find("\"overlayStates\"") != std::string::npos);
    assert(chunk_json.find("\"open_bit\":true") != std::string::npos);
    assert(chunk_json.find("\"updatedAt\":99") != std::string::npos);
    const auto chunk_batch_json = livemap::serializeChunkBatch({snapshot}, true);
    assert(chunk_batch_json.find("\"broadcast\":true") != std::string::npos);
    assert(chunk_batch_json.find("\"storage\":\"chunk\"") != std::string::npos);
    assert(chunk_batch_json.find("\"chunks\":[{\"world\":\"world\"") != std::string::npos);
    const auto region_batch_json = livemap::serializeChunkBatch({snapshot}, true, livemap::ChunkBatchStorage::Region);
    assert(region_batch_json.find("\"broadcast\":true") != std::string::npos);
    assert(region_batch_json.find("\"storage\":\"region\"") != std::string::npos);

    livemap::BlockUpdateBatch batch;
    batch.world = "world";
    batch.dimension = "Overworld";
    batch.chunk_x = 0;
    batch.chunk_z = 0;
    batch.updates.push_back({1, 2, "minecraft:stone", 70, {{"bite_counter", 3}}, "minecraft:poppy", 71, {{"facing_direction", 0}}});
    batch.updated_at_ms = 100;
    const auto update_json = livemap::serializeBlockUpdateBatch(batch);
    assert(update_json.find("\"updates\":[{\"localX\":1,\"localZ\":2") != std::string::npos);
    assert(update_json.find("\"block\":\"minecraft:stone\"") != std::string::npos);
    assert(update_json.find("\"state\":{\"bite_counter\":3}") != std::string::npos);
    assert(update_json.find("\"overlayBlock\":\"minecraft:poppy\"") != std::string::npos);
    assert(update_json.find("\"overlayState\":{\"facing_direction\":0}") != std::string::npos);
    livemap::BlockUpdateBatch second = batch;
    second.chunk_x = 1;
    const auto update_batches_json = livemap::serializeBlockUpdateBatches({batch, second});
    assert(update_batches_json.find("\"batches\":[{\"world\":\"world\"") != std::string::npos);
    assert(update_batches_json.find("\"chunkX\":1") != std::string::npos);
}

void testBase64()
{
    const std::vector<std::uint8_t> bytes = {'M', 'a', 'p'};
    assert(livemap::base64Encode(bytes) == "TWFw");
    const std::vector<std::uint8_t> one = {'M'};
    assert(livemap::base64Encode(one) == "TQ==");
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
    testChunkSnapshotFingerprint();
    testChunkBaselineIndex();
    testSettingsLegacyKeys();
    testSettingsDirtyBatchDefaults();
    testSettingsNewKeysOverrideLegacyKeys();
    testDirtyBlockChunkLimitedDrain();
    std::cout << "livemap core tests passed\n";
    return 0;
}
