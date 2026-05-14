#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace livemap {

struct LandTeleport {
    int x{};
    int y{};
    int z{};
};

struct LandClaim {
    std::string id;
    std::string owner;
    std::string name;
    std::string world;
    std::string dimension;
    int min_x{};
    int max_x{};
    int min_y{};
    int max_y{};
    int min_z{};
    int max_z{};
    LandTeleport teleport;
    std::vector<std::string> members;
    std::string parent;
    std::vector<std::string> children;
    bool nested = false;
    bool public_teleport = false;
    std::int64_t updated_at_ms{};
};

struct LandParseResult {
    std::vector<LandClaim> claims;
    std::size_t skipped_entries = 0;
};

LandParseResult parseLandConfig(std::string_view source, std::string_view world, std::int64_t updated_at_ms);
LandParseResult loadLandConfig(const std::filesystem::path &path, std::string_view world, std::int64_t updated_at_ms);
std::string serializeLandBatch(const std::vector<LandClaim> &claims);

}  // namespace livemap
