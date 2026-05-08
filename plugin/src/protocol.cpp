#include "livemap/protocol.hpp"

#include <sstream>

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
    out << "],\"updatedAt\":" << snapshot.updated_at_ms << '}';
    return out.str();
}

std::string serializeChunkReady(const ChunkCoord &coord)
{
    std::ostringstream out;
    out << "{\"type\":\"chunk_ready\",\"world\":\"" << jsonEscape(coord.world) << "\",\"dimension\":\""
        << jsonEscape(coord.dimension) << "\",\"chunkX\":" << coord.x << ",\"chunkZ\":" << coord.z << '}';
    return out.str();
}

std::string serializeTileReady(const TileCoord &coord, std::string content_type)
{
    std::ostringstream out;
    out << "{\"type\":\"tile_ready\",\"world\":\"" << jsonEscape(coord.world) << "\",\"dimension\":\""
        << jsonEscape(coord.dimension) << "\",\"z\":" << coord.zoom << ",\"x\":" << coord.x << ",\"y\":"
        << coord.y << ",\"contentType\":\"" << jsonEscape(content_type) << "\"}";
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
