#include "livemap/base64.hpp"
#include "livemap/bmp_writer.hpp"
#include "livemap/chunk.hpp"
#include "livemap/color_map.hpp"
#include "livemap/protocol.hpp"
#include "livemap/tile_renderer.hpp"

#include <cassert>
#include <cstdint>
#include <iostream>
#include <vector>

namespace {

void testTileMath()
{
    assert(livemap::floorDiv(0, 256) == 0);
    assert(livemap::floorDiv(255, 256) == 0);
    assert(livemap::floorDiv(256, 256) == 1);
    assert(livemap::floorDiv(-1, 256) == -1);
    assert(livemap::floorDiv(-256, 256) == -1);
    assert(livemap::floorDiv(-257, 256) == -2);

    const auto coord = livemap::tileForBlock("world", "Overworld", -1, 256);
    assert(coord.x == -1);
    assert(coord.y == 1);
    assert(coord.path("bmp") == "world/Overworld/0/-1/1.bmp");
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
}

void testBmpAndRenderer()
{
    const std::vector<livemap::Color> pixels = {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 255}};
    const auto bmp = livemap::encodeBmp24(2, 2, pixels);
    assert(bmp.size() == 70);
    assert(bmp[0] == 'B' && bmp[1] == 'M');

    const auto rendered = livemap::renderTileBmp(4, 4, [](int x, int z) {
        return livemap::BlockSample{(x + z) % 2 == 0 ? "minecraft:grass_block" : "minecraft:water", 64};
    });
    assert(rendered.size() > 54);
    assert(rendered[0] == 'B' && rendered[1] == 'M');
}

void testBase64()
{
    const std::vector<std::uint8_t> bytes = {'M', 'a', 'p'};
    assert(livemap::base64Encode(bytes) == "TWFw");
    const std::vector<std::uint8_t> one = {'M'};
    assert(livemap::base64Encode(one) == "TQ==");
}

}  // namespace

int main()
{
    testTileMath();
    testChunkMath();
    testDirtyTracker();
    testProtocol();
    testBmpAndRenderer();
    testBase64();
    std::cout << "livemap core tests passed\n";
    return 0;
}
