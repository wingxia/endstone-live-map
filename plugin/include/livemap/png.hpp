#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace livemap {

struct RgbaImage {
    int width{};
    int height{};
    std::vector<std::uint8_t> pixels;
};

[[nodiscard]] RgbaImage makeRgbaImage(int width, int height);
[[nodiscard]] RgbaImage renderSkinAvatar(const RgbaImage &skin, int avatar_size = 32);
[[nodiscard]] std::vector<std::uint8_t> encodePngRgba(const RgbaImage &image);
bool writePngRgba(const std::filesystem::path &path, const RgbaImage &image, std::string *error = nullptr);
bool writeRawRgba(const std::filesystem::path &path, const RgbaImage &image, std::string *error = nullptr);
[[nodiscard]] RgbaImage readRawRgba(const std::filesystem::path &path, int width, int height);

}  // namespace livemap
