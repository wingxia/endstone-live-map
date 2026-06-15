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
        out << "{\"id\":\"" << jsonEscape(p.id) << "\",\"name\":\"" << jsonEscape(p.name) << "\",\"xuid\":\""
            << jsonEscape(p.xuid) << "\",\"world\":\"" << jsonEscape(p.world) << "\",\"dimension\":\""
            << jsonEscape(p.dimension) << "\",\"x\":" << p.x << ",\"y\":" << p.y << ",\"z\":" << p.z
            << ",\"yaw\":" << p.yaw << ",\"pitch\":" << p.pitch;
        if (!p.avatar_hash.empty()) {
            out << ",\"avatarHash\":\"" << jsonEscape(p.avatar_hash) << '"';
        }
        if (!p.avatar_png_base64.empty()) {
            out << ",\"avatarPngBase64\":\"" << jsonEscape(p.avatar_png_base64) << '"';
        }
        out << ",\"updatedAt\":" << p.updated_at_ms << '}';
    }
    out << "]}";
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
