#include "livemap/base64.hpp"

namespace livemap {

std::string base64Encode(std::span<const std::uint8_t> bytes)
{
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((bytes.size() + 2) / 3) * 4);

    for (std::size_t i = 0; i < bytes.size(); i += 3) {
        const auto b0 = bytes[i];
        const auto b1 = (i + 1 < bytes.size()) ? bytes[i + 1] : 0;
        const auto b2 = (i + 2 < bytes.size()) ? bytes[i + 2] : 0;

        out.push_back(alphabet[(b0 >> 2) & 0x3F]);
        out.push_back(alphabet[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)]);
        out.push_back((i + 1 < bytes.size()) ? alphabet[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)] : '=');
        out.push_back((i + 2 < bytes.size()) ? alphabet[b2 & 0x3F] : '=');
    }

    return out;
}

}  // namespace livemap
