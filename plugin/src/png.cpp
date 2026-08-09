#include "livemap/png.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

#include <zlib.h>

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

void appendChunk(std::vector<std::uint8_t> &out, const char type[4], const std::vector<std::uint8_t> &data)
{
    appendUint32(out, static_cast<std::uint32_t>(data.size()));
    const auto type_start = out.size();
    out.insert(out.end(), type, type + 4);
    out.insert(out.end(), data.begin(), data.end());
    appendUint32(out, crc32(out.data() + type_start, out.size() - type_start));
}

std::vector<std::uint8_t> zlibCompress(const std::vector<std::uint8_t> &raw)
{
    if (raw.size() > std::numeric_limits<uLong>::max()) {
        throw std::length_error("png scanline data exceeds zlib input limit");
    }

    const auto source_size = static_cast<uLong>(raw.size());
    uLongf compressed_size = compressBound(source_size);
    std::vector<std::uint8_t> out(static_cast<std::size_t>(compressed_size));
    const auto status = compress2(
        reinterpret_cast<Bytef *>(out.data()),
        &compressed_size,
        reinterpret_cast<const Bytef *>(raw.data()),
        source_size,
        2);
    if (status != Z_OK) {
        throw std::runtime_error("failed to compress png scanlines with zlib: " + std::to_string(status));
    }
    out.resize(static_cast<std::size_t>(compressed_size));
    return out;
}

int paethPredictor(int left, int above, int upper_left)
{
    const auto estimate = left + above - upper_left;
    const auto left_distance = std::abs(estimate - left);
    const auto above_distance = std::abs(estimate - above);
    const auto upper_left_distance = std::abs(estimate - upper_left);
    if (left_distance <= above_distance && left_distance <= upper_left_distance) {
        return left;
    }
    return above_distance <= upper_left_distance ? above : upper_left;
}

std::uint64_t filterScanline(const std::uint8_t *current, const std::uint8_t *previous, std::size_t size,
                             std::uint8_t filter_type, std::vector<std::uint8_t> *filtered)
{
    constexpr std::size_t kBytesPerPixel = 4;
    std::uint64_t score = 0;
    filtered->resize(size);
    for (std::size_t index = 0; index < size; ++index) {
        const auto source = static_cast<int>(current[index]);
        const auto left = index >= kBytesPerPixel ? static_cast<int>(current[index - kBytesPerPixel]) : 0;
        const auto above = previous != nullptr ? static_cast<int>(previous[index]) : 0;
        const auto upper_left =
            previous != nullptr && index >= kBytesPerPixel ? static_cast<int>(previous[index - kBytesPerPixel]) : 0;
        int predictor = 0;
        switch (filter_type) {
        case 1:
            predictor = left;
            break;
        case 2:
            predictor = above;
            break;
        case 3:
            predictor = (left + above) / 2;
            break;
        case 4:
            predictor = paethPredictor(left, above, upper_left);
            break;
        default:
            break;
        }
        const auto value = static_cast<std::uint8_t>(source - predictor);
        (*filtered)[index] = value;
        score += std::min<unsigned int>(value, 256U - value);
    }
    return score;
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

RgbaImage renderSkinAvatar(const RgbaImage &skin, int avatar_size)
{
    if (skin.width < 64 || skin.width % 64 != 0 || skin.height < skin.width / 2 || avatar_size <= 0 ||
        skin.pixels.size() != static_cast<std::size_t>(skin.width) * static_cast<std::size_t>(skin.height) * 4) {
        throw std::invalid_argument("unsupported minecraft skin image");
    }

    const int texture_scale = skin.width / 64;
    const int face_x = 8 * texture_scale;
    const int face_y = 8 * texture_scale;
    const int hat_x = 40 * texture_scale;
    const int face_size = 8 * texture_scale;
    const bool has_hat_layer = skin.width >= hat_x + face_size && skin.height >= face_y + face_size;
    auto avatar = makeRgbaImage(avatar_size, avatar_size);

    const auto pixel = [&skin](int x, int y) {
        return (static_cast<std::size_t>(y) * static_cast<std::size_t>(skin.width) + static_cast<std::size_t>(x)) * 4;
    };
    for (int y = 0; y < avatar_size; ++y) {
        for (int x = 0; x < avatar_size; ++x) {
            const int source_x = face_x + x * face_size / avatar_size;
            const int source_y = face_y + y * face_size / avatar_size;
            const auto base = pixel(source_x, source_y);
            const auto target = (static_cast<std::size_t>(y) * static_cast<std::size_t>(avatar_size) +
                                 static_cast<std::size_t>(x)) * 4;
            for (std::size_t channel = 0; channel < 4; ++channel) {
                avatar.pixels[target + channel] = skin.pixels[base + channel];
            }

            if (!has_hat_layer) {
                continue;
            }
            const auto overlay = pixel(hat_x + x * face_size / avatar_size, source_y);
            const auto overlay_alpha = static_cast<unsigned int>(skin.pixels[overlay + 3]);
            if (overlay_alpha == 0) {
                continue;
            }
            const auto base_alpha = static_cast<unsigned int>(avatar.pixels[target + 3]);
            const auto out_alpha = overlay_alpha + (base_alpha * (255U - overlay_alpha) + 127U) / 255U;
            for (std::size_t channel = 0; channel < 3; ++channel) {
                const auto overlay_premultiplied = static_cast<unsigned int>(skin.pixels[overlay + channel]) * overlay_alpha;
                const auto base_premultiplied = static_cast<unsigned int>(avatar.pixels[target + channel]) * base_alpha;
                const auto numerator = overlay_premultiplied +
                    (base_premultiplied * (255U - overlay_alpha) + 127U) / 255U;
                avatar.pixels[target + channel] = out_alpha == 0 ? 0 : static_cast<std::uint8_t>((numerator + out_alpha / 2U) / out_alpha);
            }
            avatar.pixels[target + 3] = static_cast<std::uint8_t>(out_alpha);
        }
    }
    return avatar;
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
    const auto row_bytes = static_cast<std::size_t>(image.width) * 4;
    raw.reserve(static_cast<std::size_t>(image.height) * (row_bytes + 1));
    std::vector<std::uint8_t> candidate;
    std::vector<std::uint8_t> best;
    for (int y = 0; y < image.height; ++y) {
        const auto row_start = static_cast<std::size_t>(y) * row_bytes;
        const auto *current = image.pixels.data() + row_start;
        const auto *previous = y > 0 ? current - row_bytes : nullptr;
        std::uint64_t best_score = std::numeric_limits<std::uint64_t>::max();
        std::uint8_t best_filter = 0;
        for (std::uint8_t filter_type = 0; filter_type <= 4; ++filter_type) {
            const auto score = filterScanline(current, previous, row_bytes, filter_type, &candidate);
            if (score < best_score) {
                best_score = score;
                best_filter = filter_type;
                best = candidate;
            }
        }
        raw.push_back(best_filter);
        raw.insert(raw.end(), best.begin(), best.end());
    }
    appendChunk(out, "IDAT", zlibCompress(raw));
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
