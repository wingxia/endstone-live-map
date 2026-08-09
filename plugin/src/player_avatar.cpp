#include "livemap/player_avatar.hpp"

#include <algorithm>
#include <cctype>
#include <string>

namespace livemap {
namespace {

std::string asciiLower(std::string_view value)
{
    std::string lowered(value);
    std::transform(lowered.begin(), lowered.end(), lowered.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return lowered;
}

}  // namespace

bool hasClassicSkinLayout(int width, int height)
{
    if (width < 64 || width % 64 != 0) {
        return false;
    }
    const int scale = width / 64;
    return height == 32 * scale || height == 64 * scale;
}

bool shouldFetchProfileAvatar(std::string_view skin_id, int width, int height)
{
    if (!hasClassicSkinLayout(width, height)) {
        return true;
    }

    const auto lowered = asciiLower(skin_id);
    return lowered.find("persona") != std::string::npos || lowered.starts_with("avatar-v");
}

}  // namespace livemap
