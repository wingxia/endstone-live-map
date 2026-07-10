#include "livemap/png.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <fstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

namespace livemap {
namespace {

constexpr std::array<std::uint8_t, 8> kPngSignature = {137, 80, 78, 71, 13, 10, 26, 10};
std::atomic_uint64_t temporary_file_sequence{0};

bool writeBytesAtomic(const std::filesystem::path &path, const std::uint8_t *bytes, std::size_t size,
                      std::string_view description, std::string *error)
{
    auto temporary = path;
    temporary += ".tmp-" + std::to_string(temporary_file_sequence.fetch_add(1, std::memory_order_relaxed));
    try {
        std::filesystem::create_directories(path.parent_path());
        {
            std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
            if (!out) {
                throw std::runtime_error("failed to open temporary " + std::string(description) + " path");
            }
            out.write(reinterpret_cast<const char *>(bytes), static_cast<std::streamsize>(size));
            out.flush();
            if (!out) {
                throw std::runtime_error("failed to write temporary " + std::string(description));
            }
        }

        std::error_code rename_error;
        std::filesystem::rename(temporary, path, rename_error);
#ifdef _WIN32
        if (rename_error) {
            std::error_code remove_error;
            std::filesystem::remove(path, remove_error);
            rename_error.clear();
            std::filesystem::rename(temporary, path, rename_error);
        }
#endif
        if (rename_error) {
            throw std::runtime_error("failed to replace " + std::string(description) + ": " + rename_error.message());
        }
        return true;
    }
    catch (const std::exception &exception) {
        std::error_code cleanup_error;
        std::filesystem::remove(temporary, cleanup_error);
        if (error != nullptr) {
            *error = exception.what();
        }
        return false;
    }
}

void appendUint32(std::vector<std::uint8_t> &out, std::uint32_t value)
{
    out.push_back(static_cast<std::uint8_t>((value >> 24U) & 0xFFU));
    out.push_back(static_cast<std::uint8_t>((value >> 16U) & 0xFFU));
    out.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xFFU));
    out.push_back(static_cast<std::uint8_t>(value & 0xFFU));
}

std::uint32_t crc32(const std::uint8_t *data, std::size_t size)
{
    std::uint32_t crc = 0xFFFFFFFFU;
    for (std::size_t i = 0; i < size; ++i) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1U) ^ (0xEDB88320U & (0U - (crc & 1U)));
        }
    }
    return crc ^ 0xFFFFFFFFU;
}

std::uint32_t adler32(const std::vector<std::uint8_t> &data)
{
    constexpr std::uint32_t kMod = 65521U;
    std::uint32_t a = 1;
    std::uint32_t b = 0;
    for (const auto byte : data) {
        a = (a + byte) % kMod;
        b = (b + a) % kMod;
    }
    return (b << 16U) | a;
}

void appendChunk(std::vector<std::uint8_t> &out, const char type[4], const std::vector<std::uint8_t> &data)
{
    appendUint32(out, static_cast<std::uint32_t>(data.size()));
    const auto type_start = out.size();
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), data.begin(), data.end());
    appendUint32(out, crc32(out.data() + type_start, out.size() - type_start));
}

std::vector<std::uint8_t> zlibStore(const std::vector<std::uint8_t> &raw)
{
    std::vector<std::uint8_t> out;
    out.reserve(raw.size() + raw.size() / 65535 + 16);
    out.push_back(0x78);
    out.push_back(0x01);

    std::size_t offset = 0;
    while (offset < raw.size()) {
        const auto remaining = raw.size() - offset;
        const auto block_size = static_cast<std::uint16_t>(std::min<std::size_t>(remaining, 65535));
        const bool final = offset + block_size >= raw.size();
        out.push_back(final ? 0x01 : 0x00);
        out.push_back(static_cast<std::uint8_t>(block_size & 0xFFU));
        out.push_back(static_cast<std::uint8_t>((block_size >> 8U) & 0xFFU));
        const auto nlen = static_cast<std::uint16_t>(~block_size);
        out.push_back(static_cast<std::uint8_t>(nlen & 0xFFU));
        out.push_back(static_cast<std::uint8_t>((nlen >> 8U) & 0xFFU));
        out.insert(out.end(), raw.begin() + static_cast<std::ptrdiff_t>(offset),
                   raw.begin() + static_cast<std::ptrdiff_t>(offset + block_size));
        offset += block_size;
    }
    appendUint32(out, adler32(raw));
    return out;
}

}  // namespace

RgbaImage makeRgbaImage(int width, int height)
{
    if (width <= 0 || height <= 0) {
        throw std::invalid_argument("image dimensions must be positive");
    }
    RgbaImage image;
    image.width = width;
    image.height = height;
    image.pixels.assign(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4, 0);
    return image;
}

std::vector<std::uint8_t> encodePngRgba(const RgbaImage &image)
{
    if (image.width <= 0 || image.height <= 0 ||
        image.pixels.size() != static_cast<std::size_t>(image.width) * static_cast<std::size_t>(image.height) * 4) {
        throw std::invalid_argument("invalid rgba image");
    }

    std::vector<std::uint8_t> out(kPngSignature.begin(), kPngSignature.end());
    std::vector<std::uint8_t> ihdr;
    ihdr.reserve(13);
    appendUint32(ihdr, static_cast<std::uint32_t>(image.width));
    appendUint32(ihdr, static_cast<std::uint32_t>(image.height));
    ihdr.push_back(8);
    ihdr.push_back(6);
    ihdr.push_back(0);
    ihdr.push_back(0);
    ihdr.push_back(0);
    appendChunk(out, "IHDR", ihdr);

    std::vector<std::uint8_t> raw;
    raw.reserve(static_cast<std::size_t>(image.height) * (static_cast<std::size_t>(image.width) * 4 + 1));
    for (int y = 0; y < image.height; ++y) {
        raw.push_back(0);
        const auto row_start = static_cast<std::size_t>(y) * static_cast<std::size_t>(image.width) * 4;
        raw.insert(raw.end(), image.pixels.begin() + static_cast<std::ptrdiff_t>(row_start),
                   image.pixels.begin() + static_cast<std::ptrdiff_t>(row_start + static_cast<std::size_t>(image.width) * 4));
    }
    appendChunk(out, "IDAT", zlibStore(raw));
    appendChunk(out, "IEND", {});
    return out;
}

bool writePngRgba(const std::filesystem::path &path, const RgbaImage &image, std::string *error)
{
    try {
        const auto encoded = encodePngRgba(image);
        return writeBytesAtomic(path, encoded.data(), encoded.size(), "png", error);
    }
    catch (const std::exception &exception) {
        if (error != nullptr) {
            *error = exception.what();
        }
        return false;
    }
}

bool writeRawRgba(const std::filesystem::path &path, const RgbaImage &image, std::string *error)
{
    return writeBytesAtomic(path, image.pixels.data(), image.pixels.size(), "raw rgba", error);
}

RgbaImage readRawRgba(const std::filesystem::path &path, int width, int height)
{
    auto image = makeRgbaImage(width, height);
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return image;
    }
    in.read(reinterpret_cast<char *>(image.pixels.data()), static_cast<std::streamsize>(image.pixels.size()));
    if (in.gcount() != static_cast<std::streamsize>(image.pixels.size())) {
        image.pixels.assign(image.pixels.size(), 0);
    }
    return image;
}

}  // namespace livemap
