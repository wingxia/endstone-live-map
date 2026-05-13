#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace livemap {

constexpr int kChunkSize = 16;
constexpr int kChunkBlockCount = kChunkSize * kChunkSize;

struct ChunkCoord {
    std::string world;
    std::string dimension;
    int x{};
    int z{};

    [[nodiscard]] std::string path() const;
};

struct BlockColumnCoord {
    std::string world;
    std::string dimension;
    int x{};
    int z{};
};

struct DirtyBlockColumn {
    BlockColumnCoord coord;
    int touched_y{};
};

bool operator==(const ChunkCoord &left, const ChunkCoord &right);
bool operator<(const ChunkCoord &left, const ChunkCoord &right);
bool operator==(const BlockColumnCoord &left, const BlockColumnCoord &right);
bool operator<(const BlockColumnCoord &left, const BlockColumnCoord &right);

struct ChunkCoordHash {
    std::size_t operator()(const ChunkCoord &coord) const;
};

struct BlockColumnCoordHash {
    std::size_t operator()(const BlockColumnCoord &coord) const;
};

ChunkCoord chunkForBlock(std::string world, std::string dimension, int block_x, int block_z);
BlockColumnCoord columnForBlock(std::string world, std::string dimension, int block_x, int block_z);
int localChunkCoord(int block, int chunk);

class DirtyChunkTracker {
public:
    bool markBlock(const std::string &world, const std::string &dimension, int block_x, int block_z);
    bool markChunk(ChunkCoord coord);
    [[nodiscard]] std::size_t size() const;
    [[nodiscard]] bool empty() const;
    std::vector<ChunkCoord> drain(std::size_t limit);
    void clear();

private:
    std::unordered_set<ChunkCoord, ChunkCoordHash> dirty_;
};

class DirtyBlockTracker {
public:
    bool markBlock(const std::string &world, const std::string &dimension, int block_x, int block_z, int block_y);
    bool markColumn(BlockColumnCoord coord, int touched_y);
    [[nodiscard]] std::size_t size() const;
    [[nodiscard]] bool empty() const;
    std::vector<DirtyBlockColumn> drain(std::size_t limit);
    void clear();

private:
    std::unordered_map<BlockColumnCoord, int, BlockColumnCoordHash> dirty_;
};

struct ChunkSnapshot {
    std::string world;
    std::string dimension;
    int chunk_x{};
    int chunk_z{};
    std::vector<std::string> palette;
    std::array<std::uint16_t, kChunkBlockCount> blocks{};
    std::array<int, kChunkBlockCount> heights{};
    std::int64_t updated_at_ms{};
};

struct BlockColumnUpdate {
    int local_x{};
    int local_z{};
    std::string block;
    int height{};
};

struct BlockUpdateBatch {
    std::string world;
    std::string dimension;
    int chunk_x{};
    int chunk_z{};
    std::vector<BlockColumnUpdate> updates;
    std::int64_t updated_at_ms{};
};

}  // namespace livemap
