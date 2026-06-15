#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace livemap {

struct PlayerState {
    std::string id;
    std::string name;
    std::string xuid;
    std::string world;
    std::string dimension;
    double x{};
    double y{};
    double z{};
    double yaw{};
    double pitch{};
    std::string avatar_hash;
    std::string avatar_png_base64;
    std::int64_t updated_at_ms{};
};

std::string jsonEscape(std::string_view value);
std::string serializePlayerSnapshot(const std::vector<PlayerState> &players);
std::string serializeHeartbeat(std::string_view server_id, std::int64_t now_ms);

}  // namespace livemap
