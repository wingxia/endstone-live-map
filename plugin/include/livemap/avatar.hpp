#pragma once

#include "livemap/png.hpp"

#include <optional>

namespace livemap {

[[nodiscard]] std::optional<RgbaImage> renderPlayerAvatar(const RgbaImage &skin, int output_size = 32);

}  // namespace livemap
