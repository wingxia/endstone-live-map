#pragma once

#include <cstdint>
#include <span>
#include <string>

namespace livemap {

std::string base64Encode(std::span<const std::uint8_t> bytes);

}  // namespace livemap
