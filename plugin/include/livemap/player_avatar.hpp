#pragma once

#include <string_view>

namespace livemap {

[[nodiscard]] bool hasClassicSkinLayout(int width, int height);
[[nodiscard]] bool shouldFetchProfileAvatar(std::string_view skin_id, int width, int height);

}  // namespace livemap
