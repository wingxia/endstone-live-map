#pragma once

#include "livemap/chunk.hpp"

#include <cstdint>
#include <filesystem>
#include <string>
#include <unordered_map>
#include <vector>

namespace livemap {

struct ChunkBaselineRecord {
    ChunkCoord coord;
    std::uint64_t fingerprint{};
    std::int64_t updated_at_ms{};
};

using ChunkBaselineMap = std::unordered_map<ChunkCoord, ChunkBaselineRecord, ChunkCoordHash>;

struct ChunkBaselineLoadResult {
    ChunkBaselineMap baselines;
    std::size_t skipped_lines{};
};

std::uint64_t fingerprintChunkSnapshot(const ChunkSnapshot &snapshot);
void applyBlockUpdatesToSnapshot(ChunkSnapshot &snapshot, const std::vector<BlockColumnUpdate> &updates,
                                 std::int64_t updated_at_ms);

ChunkBaselineLoadResult loadChunkBaselineIndex(const std::filesystem::path &path);
bool saveChunkBaselineIndexAtomic(const std::filesystem::path &path, const ChunkBaselineMap &baselines,
                                  std::string *error = nullptr);

}  // namespace livemap
