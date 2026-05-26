#include "livemap/protocol.hpp"

#include <array>
#include <type_traits>
#include <sstream>
#include <variant>

namespace livemap {

std::string jsonEscape(std::string_view value)
{
    std::string out;
    out.reserve(value.size() + 8);
    for (const char ch : value) {
        switch (ch) {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\b':
            out += "\\b";
            break;
        case '\f':
            out += "\\f";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (static_cast<unsigned char>(ch) < 0x20) {
                out += "\\u00";
                static constexpr char hex[] = "0123456789abcdef";
                out.push_back(hex[(ch >> 4) & 0x0F]);
                out.push_back(hex[ch & 0x0F]);
            }
            else {
                out.push_back(ch);
            }
        }
    }
    return out;
}

void writeJsonValue(std::ostringstream &out, const BlockStateValue &value)
{
    std::visit(
        [&out](const auto &item) {
            using Item = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<Item, bool>) {
                out << (item ? "true" : "false");
            }
            else if constexpr (std::is_same_v<Item, int>) {
                out << item;
            }
            else {
                out << '"' << jsonEscape(item) << '"';
            }
        },
        value);
}

void writeJsonStateMap(std::ostringstream &out, const BlockStateMap &states)
{
    out << '{';
    bool first = true;
    for (const auto &[key, value] : states) {
        if (!first) {
            out << ',';
        }
        first = false;
        out << '"' << jsonEscape(key) << "\":";
        writeJsonValue(out, value);
    }
    out << '}';
}

void writeJsonStateArray(std::ostringstream &out, const std::array<BlockStateMap, kChunkBlockCount> &states)
{
    out << '[';
    for (std::size_t i = 0; i < states.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        writeJsonStateMap(out, states[i]);
    }
    out << ']';
}

std::string serializePlayerSnapshot(const std::vector<PlayerState> &players)
{
    std::ostringstream out;
    out << "{\"type\":\"player_snapshot\",\"players\":[";
    for (std::size_t i = 0; i < players.size(); ++i) {
        const auto &p = players[i];
        if (i != 0) {
            out << ',';
        }
        out << "{\"id\":\"" << jsonEscape(p.id) << "\",\"name\":\"" << jsonEscape(p.name) << "\",\"world\":\""
            << jsonEscape(p.world) << "\",\"dimension\":\"" << jsonEscape(p.dimension) << "\",\"x\":" << p.x
            << ",\"y\":" << p.y << ",\"z\":" << p.z << ",\"yaw\":" << p.yaw << ",\"pitch\":" << p.pitch
            << ",\"updatedAt\":" << p.updated_at_ms << '}';
    }
    out << "]}";
    return out.str();
}

std::string serializeChunkSnapshot(const ChunkSnapshot &snapshot)
{
    std::ostringstream out;
    out << "{\"world\":\"" << jsonEscape(snapshot.world) << "\",\"dimension\":\"" << jsonEscape(snapshot.dimension)
        << "\",\"chunkX\":" << snapshot.chunk_x << ",\"chunkZ\":" << snapshot.chunk_z << ",\"palette\":[";
    for (std::size_t i = 0; i < snapshot.palette.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << '"' << jsonEscape(snapshot.palette[i]) << '"';
    }
    out << "],\"blocks\":[";
    for (std::size_t i = 0; i < snapshot.blocks.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << snapshot.blocks[i];
    }
    out << "],\"heights\":[";
    for (std::size_t i = 0; i < snapshot.heights.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << snapshot.heights[i];
    }
    out << "],\"blockStates\":";
    writeJsonStateArray(out, snapshot.block_states);
    out << ",\"overlayBlocks\":[";
    for (std::size_t i = 0; i < snapshot.overlay_blocks.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << snapshot.overlay_blocks[i];
    }
    out << "],\"overlayHeights\":[";
    for (std::size_t i = 0; i < snapshot.overlay_heights.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << snapshot.overlay_heights[i];
    }
    out << "],\"overlayStates\":";
    writeJsonStateArray(out, snapshot.overlay_states);
    out << ",\"updatedAt\":" << snapshot.updated_at_ms << '}';
    return out.str();
}

std::string serializeChunkBatch(const std::vector<ChunkSnapshot> &snapshots, bool broadcast)
{
    std::ostringstream out;
    out << "{\"broadcast\":" << (broadcast ? "true" : "false") << ",\"storage\":\"chunk\",\"chunks\":[";
    for (std::size_t i = 0; i < snapshots.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << serializeChunkSnapshot(snapshots[i]);
    }
    out << "]}";
    return out.str();
}

std::string serializeBlockUpdateBatch(const BlockUpdateBatch &batch)
{
    std::ostringstream out;
    out << "{\"world\":\"" << jsonEscape(batch.world) << "\",\"dimension\":\"" << jsonEscape(batch.dimension)
        << "\",\"chunkX\":" << batch.chunk_x << ",\"chunkZ\":" << batch.chunk_z << ",\"updates\":[";
    for (std::size_t i = 0; i < batch.updates.size(); ++i) {
        const auto &update = batch.updates[i];
        if (i != 0) {
            out << ',';
        }
        out << "{\"localX\":" << update.local_x << ",\"localZ\":" << update.local_z << ",\"block\":\""
            << jsonEscape(update.block) << "\",\"height\":" << update.height << ",\"state\":";
        writeJsonStateMap(out, update.state);
        out << ",\"overlayBlock\":\"" << jsonEscape(update.overlay_block) << "\",\"overlayHeight\":"
            << update.overlay_height << ",\"overlayState\":";
        writeJsonStateMap(out, update.overlay_state);
        out << '}';
    }
    out << "],\"updatedAt\":" << batch.updated_at_ms << '}';
    return out.str();
}

std::string serializeBlockUpdateBatches(const std::vector<BlockUpdateBatch> &batches)
{
    std::ostringstream out;
    out << "{\"batches\":[";
    for (std::size_t i = 0; i < batches.size(); ++i) {
        if (i != 0) {
            out << ',';
        }
        out << serializeBlockUpdateBatch(batches[i]);
    }
    out << "]}";
    return out.str();
}

std::string serializeChunkReady(const ChunkCoord &coord)
{
    std::ostringstream out;
    out << "{\"type\":\"chunk_ready\",\"world\":\"" << jsonEscape(coord.world) << "\",\"dimension\":\""
        << jsonEscape(coord.dimension) << "\",\"chunkX\":" << coord.x << ",\"chunkZ\":" << coord.z << '}';
    return out.str();
}

std::string serializeHeartbeat(std::string_view server_id, std::int64_t now_ms)
{
    std::ostringstream out;
    out << "{\"type\":\"heartbeat\",\"serverId\":\"" << jsonEscape(server_id) << "\",\"updatedAt\":" << now_ms
        << '}';
    return out.str();
}

}  // namespace livemap
