#include "livemap/avatar.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace livemap {
namespace {

struct Rgba {
    std::uint8_t r{};
    std::uint8_t g{};
    std::uint8_t b{};
    std::uint8_t a{};
};

Rgba pixelAt(const RgbaImage &image, int x, int y)
{
    const auto offset = (static_cast<std::size_t>(y) * static_cast<std::size_t>(image.width) +
                         static_cast<std::size_t>(x)) *
                        4;
    return {image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2], image.pixels[offset + 3]};
}

void setPixel(RgbaImage &image, int x, int y, const Rgba &pixel)
{
    const auto offset = (static_cast<std::size_t>(y) * static_cast<std::size_t>(image.width) +
                         static_cast<std::size_t>(x)) *
                        4;
    image.pixels[offset] = pixel.r;
    image.pixels[offset + 1] = pixel.g;
    image.pixels[offset + 2] = pixel.b;
    image.pixels[offset + 3] = pixel.a;
}

Rgba composite(const Rgba &base, const Rgba &overlay)
{
    const double overlay_alpha = static_cast<double>(overlay.a) / 255.0;
    const double base_alpha = static_cast<double>(base.a) / 255.0;
    const double output_alpha = overlay_alpha + base_alpha * (1.0 - overlay_alpha);
    if (output_alpha <= 0.0) {
        return {};
    }
    const auto channel = [&](std::uint8_t base_channel, std::uint8_t overlay_channel) {
        const double value = (static_cast<double>(overlay_channel) * overlay_alpha +
                              static_cast<double>(base_channel) * base_alpha * (1.0 - overlay_alpha)) /
                             output_alpha;
        return static_cast<std::uint8_t>(std::clamp(std::lround(value), 0L, 255L));
    };
    return {
        channel(base.r, overlay.r),
        channel(base.g, overlay.g),
        channel(base.b, overlay.b),
        static_cast<std::uint8_t>(std::clamp(std::lround(output_alpha * 255.0), 0L, 255L)),
    };
}

}  // namespace

std::optional<RgbaImage> renderPlayerAvatar(const RgbaImage &skin, int output_size)
{
    if (output_size <= 0 || skin.width < 64 || skin.width % 64 != 0) {
        return std::nullopt;
    }
    const int skin_scale = skin.width / 64;
    if (skin.height != 32 * skin_scale && skin.height != 64 * skin_scale) {
        return std::nullopt;
    }
    const auto expected_pixels = static_cast<std::size_t>(skin.width) * static_cast<std::size_t>(skin.height) * 4;
    if (skin.pixels.size() != expected_pixels) {
        return std::nullopt;
    }

    auto avatar = makeRgbaImage(output_size, output_size);
    bool has_visible_pixel = false;
    for (int y = 0; y < output_size; ++y) {
        for (int x = 0; x < output_size; ++x) {
            const int face_x = 8 * skin_scale + (x * 8 * skin_scale) / output_size;
            const int face_y = 8 * skin_scale + (y * 8 * skin_scale) / output_size;
            const int hat_x = 40 * skin_scale + (x * 8 * skin_scale) / output_size;
            const int hat_y = face_y;
            const auto output = composite(pixelAt(skin, face_x, face_y), pixelAt(skin, hat_x, hat_y));
            setPixel(avatar, x, y, output);
            has_visible_pixel = has_visible_pixel || output.a != 0;
        }
    }
    return has_visible_pixel ? std::optional<RgbaImage>(std::move(avatar)) : std::nullopt;
}

}  // namespace livemap
