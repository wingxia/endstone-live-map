#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "livemap/chunk.hpp"

namespace livemap {

struct PlayerState {
    std::string id;
    std::string name;
    std::string world;
    std::string dimension;
    double x{};
    double y{};
    double z{};
    double yaw{};
    double pitch{};
    std::int64_t updated_at_ms{};
};

std::string jsonEscape(std::string_view value);
std::string serializePlayerSnapshot(const std::vector<PlayerState> &players);
std::string serializeChunkSnapshot(const ChunkSnapshot &snapshot);
std::string serializeBlockUpdateBatch(const BlockUpdateBatch &batch);
std::string serializeChunkReady(const ChunkCoord &coord);
std::string serializeHeartbeat(std::string_view server_id, std::int64_t now_ms);

}  // namespace livemap
