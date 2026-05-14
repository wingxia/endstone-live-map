#include "livemap/baseline.hpp"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <string_view>

namespace livemap {
namespace {

void mixFingerprintByte(std::uint64_t &hash, std::uint8_t value)
{
    hash ^= value;
    hash *= 1099511628211ULL;
}

void mixFingerprintUint64(std::uint64_t &hash, std::uint64_t value)
{
    for (int shift = 0; shift < 64; shift += 8) {
        mixFingerprintByte(hash, static_cast<std::uint8_t>((value >> shift) & 0xFFU));
    }
}

void mixFingerprintString(std::uint64_t &hash, std::string_view value)
{
    mixFingerprintUint64(hash, static_cast<std::uint64_t>(value.size()));
    for (const auto ch : value) {
        mixFingerprintByte(hash, static_cast<std::uint8_t>(ch));
    }
}

bool parseBaselineLine(const std::string &line, ChunkBaselineRecord &record)
{
    if (line.empty() || line[0] == '#') {
        return false;
    }

    std::vector<std::string> fields;
    std::string field;
    std::istringstream line_stream(line);
    while (std::getline(line_stream, field, '\t')) {
        fields.push_back(field);
    }
    if (fields.size() != 6) {
        return false;
    }

    try {
        record.coord.world = fields[0];
        record.coord.dimension = fields[1];
        record.coord.x = std::stoi(fields[2]);
        record.coord.z = std::stoi(fields[3]);
        record.fingerprint = static_cast<std::uint64_t>(std::stoull(fields[4]));
        record.updated_at_ms = std::stoll(fields[5]);
    }
    catch (...) {
        return false;
    }
    return !record.coord.world.empty() && !record.coord.dimension.empty();
}

}  // namespace

std::uint64_t fingerprintChunkSnapshot(const ChunkSnapshot &snapshot)
{
    std::uint64_t hash = 14695981039346656037ULL;
    mixFingerprintString(hash, snapshot.world);
    mixFingerprintString(hash, snapshot.dimension);
    mixFingerprintUint64(hash, static_cast<std::uint64_t>(static_cast<std::int64_t>(snapshot.chunk_x)));
    mixFingerprintUint64(hash, static_cast<std::uint64_t>(static_cast<std::int64_t>(snapshot.chunk_z)));
    mixFingerprintUint64(hash, static_cast<std::uint64_t>(snapshot.palette.size()));
    for (const auto &block : snapshot.palette) {
        mixFingerprintString(hash, block);
    }
    for (const auto block : snapshot.blocks) {
        mixFingerprintUint64(hash, static_cast<std::uint64_t>(block));
    }
    for (const auto height : snapshot.heights) {
        mixFingerprintUint64(hash, static_cast<std::uint64_t>(static_cast<std::int64_t>(height)));
    }
    return hash;
}

void applyBlockUpdatesToSnapshot(ChunkSnapshot &snapshot, const std::vector<BlockColumnUpdate> &updates,
                                 std::int64_t updated_at_ms)
{
    for (const auto &update : updates) {
        if (update.local_x < 0 || update.local_x >= kChunkSize || update.local_z < 0 ||
            update.local_z >= kChunkSize) {
            continue;
        }

        auto palette_it = std::find(snapshot.palette.begin(), snapshot.palette.end(), update.block);
        std::uint16_t palette_index{};
        if (palette_it == snapshot.palette.end()) {
            palette_index = static_cast<std::uint16_t>(snapshot.palette.size());
            snapshot.palette.push_back(update.block);
        }
        else {
            palette_index = static_cast<std::uint16_t>(std::distance(snapshot.palette.begin(), palette_it));
        }

        const auto index = update.local_z * kChunkSize + update.local_x;
        snapshot.blocks[index] = palette_index;
        snapshot.heights[index] = update.height;
    }
    snapshot.updated_at_ms = updated_at_ms;
}

ChunkBaselineLoadResult loadChunkBaselineIndex(const std::filesystem::path &path)
{
    ChunkBaselineLoadResult result;
    std::ifstream in(path);
    if (!in) {
        return result;
    }

    std::string line;
    while (std::getline(in, line)) {
        ChunkBaselineRecord record;
        if (!parseBaselineLine(line, record)) {
            if (!line.empty() && line[0] != '#') {
                ++result.skipped_lines;
            }
            continue;
        }
        result.baselines[record.coord] = std::move(record);
    }
    return result;
}

bool saveChunkBaselineIndexAtomic(const std::filesystem::path &path, const ChunkBaselineMap &baselines,
                                  std::string *error)
{
    try {
        std::filesystem::create_directories(path.parent_path());
        const auto tmp_path = path.string() + ".tmp";
        {
            std::ofstream out(tmp_path, std::ios::trunc);
            if (!out) {
                if (error != nullptr) {
                    *error = "failed to open temporary baseline index";
                }
                return false;
            }

            std::vector<ChunkBaselineRecord> records;
            records.reserve(baselines.size());
            for (const auto &[coord, record] : baselines) {
                records.push_back(record);
            }
            std::sort(records.begin(), records.end(), [](const auto &left, const auto &right) {
                return left.coord < right.coord;
            });

            out << "# world\tdimension\tchunkX\tchunkZ\tfingerprint\tupdatedAt\n";
            for (const auto &record : records) {
                out << record.coord.world << '\t' << record.coord.dimension << '\t' << record.coord.x << '\t'
                    << record.coord.z << '\t' << record.fingerprint << '\t' << record.updated_at_ms << '\n';
            }
        }

        std::filesystem::rename(tmp_path, path);
        return true;
    }
    catch (const std::exception &exception) {
        if (error != nullptr) {
            *error = exception.what();
        }
        return false;
    }
    catch (...) {
        if (error != nullptr) {
            *error = "unknown error";
        }
        return false;
    }
}

}  // namespace livemap
