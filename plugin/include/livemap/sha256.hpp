#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace livemap {

using Sha256Digest = std::array<std::uint8_t, 32>;

[[nodiscard]] Sha256Digest sha256(std::string_view data);
[[nodiscard]] Sha256Digest sha256(const std::vector<std::uint8_t> &data);
[[nodiscard]] Sha256Digest hmacSha256(const std::vector<std::uint8_t> &key, std::string_view data);
[[nodiscard]] std::string hexLower(const std::uint8_t *data, std::size_t size);
[[nodiscard]] std::string hexLower(const Sha256Digest &digest);

}  // namespace livemap
