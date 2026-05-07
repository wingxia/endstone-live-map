#include "livemap/bmp_writer.hpp"

#include <stdexcept>

namespace livemap {

namespace {

void writeU16(std::vector<std::uint8_t> &out, std::uint16_t value)
{
    out.push_back(static_cast<std::uint8_t>(value & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
}

void writeU32(std::vector<std::uint8_t> &out, std::uint32_t value)
{
    out.push_back(static_cast<std::uint8_t>(value & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
    out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
}

}  // namespace

std::vector<std::uint8_t> encodeBmp24(int width, int height, std::span<const Color> pixels)
{
    if (width <= 0 || height <= 0) {
        throw std::invalid_argument("BMP dimensions must be positive");
    }
    if (pixels.size() != static_cast<std::size_t>(width * height)) {
        throw std::invalid_argument("BMP pixel buffer size does not match dimensions");
    }

    const int row_stride = ((width * 3 + 3) / 4) * 4;
    const std::uint32_t pixel_bytes = static_cast<std::uint32_t>(row_stride * height);
    const std::uint32_t file_size = 14 + 40 + pixel_bytes;

    std::vector<std::uint8_t> out;
    out.reserve(file_size);

    out.push_back('B');
    out.push_back('M');
    writeU32(out, file_size);
    writeU16(out, 0);
    writeU16(out, 0);
    writeU32(out, 14 + 40);

    writeU32(out, 40);
    writeU32(out, static_cast<std::uint32_t>(width));
    writeU32(out, static_cast<std::uint32_t>(height));
    writeU16(out, 1);
    writeU16(out, 24);
    writeU32(out, 0);
    writeU32(out, pixel_bytes);
    writeU32(out, 2835);
    writeU32(out, 2835);
    writeU32(out, 0);
    writeU32(out, 0);

    std::vector<std::uint8_t> row(static_cast<std::size_t>(row_stride), 0);
    for (int y = height - 1; y >= 0; --y) {
        std::fill(row.begin(), row.end(), 0);
        for (int x = 0; x < width; ++x) {
            const auto &pixel = pixels[static_cast<std::size_t>(y * width + x)];
            const auto offset = static_cast<std::size_t>(x * 3);
            row[offset + 0] = pixel.b;
            row[offset + 1] = pixel.g;
            row[offset + 2] = pixel.r;
        }
        out.insert(out.end(), row.begin(), row.end());
    }

    return out;
}

}  // namespace livemap
