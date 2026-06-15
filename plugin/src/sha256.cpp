#include "livemap/sha256.hpp"

#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

namespace livemap {
namespace {

constexpr std::array<std::uint32_t, 64> k = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U,
    0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU,
    0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU,
    0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
    0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
    0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U,
    0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U,
    0xc67178f2U,
};

std::uint32_t rotr(std::uint32_t value, std::uint32_t bits)
{
    return (value >> bits) | (value << (32U - bits));
}

std::uint32_t loadBe32(const std::uint8_t *data)
{
    return (static_cast<std::uint32_t>(data[0]) << 24U) | (static_cast<std::uint32_t>(data[1]) << 16U) |
           (static_cast<std::uint32_t>(data[2]) << 8U) | static_cast<std::uint32_t>(data[3]);
}

void storeBe32(std::uint8_t *out, std::uint32_t value)
{
    out[0] = static_cast<std::uint8_t>((value >> 24U) & 0xFFU);
    out[1] = static_cast<std::uint8_t>((value >> 16U) & 0xFFU);
    out[2] = static_cast<std::uint8_t>((value >> 8U) & 0xFFU);
    out[3] = static_cast<std::uint8_t>(value & 0xFFU);
}

std::vector<std::uint8_t> padded(std::string_view data)
{
    std::vector<std::uint8_t> bytes(data.begin(), data.end());
    const auto bit_length = static_cast<std::uint64_t>(bytes.size()) * 8ULL;
    bytes.push_back(0x80);
    while ((bytes.size() % 64) != 56) {
        bytes.push_back(0);
    }
    for (int shift = 56; shift >= 0; shift -= 8) {
        bytes.push_back(static_cast<std::uint8_t>((bit_length >> shift) & 0xFFU));
    }
    return bytes;
}

}  // namespace

Sha256Digest sha256(std::string_view data)
{
    auto bytes = padded(data);
    std::array<std::uint32_t, 8> h = {0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
                                     0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U};

    for (std::size_t offset = 0; offset < bytes.size(); offset += 64) {
        std::array<std::uint32_t, 64> w{};
        for (int i = 0; i < 16; ++i) {
            w[i] = loadBe32(bytes.data() + offset + static_cast<std::size_t>(i) * 4);
        }
        for (int i = 16; i < 64; ++i) {
            const auto s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3U);
            const auto s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10U);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }

        auto a = h[0];
        auto b = h[1];
        auto c = h[2];
        auto d = h[3];
        auto e = h[4];
        auto f = h[5];
        auto g = h[6];
        auto hh = h[7];

        for (int i = 0; i < 64; ++i) {
            const auto s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const auto ch = (e & f) ^ ((~e) & g);
            const auto temp1 = hh + s1 + ch + k[i] + w[i];
            const auto s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const auto maj = (a & b) ^ (a & c) ^ (b & c);
            const auto temp2 = s0 + maj;
            hh = g;
            g = f;
            f = e;
            e = d + temp1;
            d = c;
            c = b;
            b = a;
            a = temp1 + temp2;
        }

        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }

    Sha256Digest digest{};
    for (std::size_t i = 0; i < h.size(); ++i) {
        storeBe32(digest.data() + i * 4, h[i]);
    }
    return digest;
}

Sha256Digest sha256(const std::vector<std::uint8_t> &data)
{
    return sha256(std::string_view(reinterpret_cast<const char *>(data.data()), data.size()));
}

Sha256Digest hmacSha256(const std::vector<std::uint8_t> &key, std::string_view data)
{
    std::array<std::uint8_t, 64> block{};
    if (key.size() > block.size()) {
        const auto digest = sha256(std::string_view(reinterpret_cast<const char *>(key.data()), key.size()));
        std::copy(digest.begin(), digest.end(), block.begin());
    }
    else {
        std::copy(key.begin(), key.end(), block.begin());
    }

    std::array<std::uint8_t, 64> outer{};
    std::array<std::uint8_t, 64> inner{};
    for (std::size_t i = 0; i < block.size(); ++i) {
        inner[i] = block[i] ^ 0x36;
        outer[i] = block[i] ^ 0x5c;
    }
    std::string inner_data(reinterpret_cast<const char *>(inner.data()), inner.size());
    inner_data.append(data);
    const auto inner_digest = sha256(inner_data);
    std::string outer_data(reinterpret_cast<const char *>(outer.data()), outer.size());
    outer_data.append(reinterpret_cast<const char *>(inner_digest.data()), inner_digest.size());
    return sha256(outer_data);
}

std::string hexLower(const std::uint8_t *data, std::size_t size)
{
    static constexpr char hex[] = "0123456789abcdef";
    std::string out;
    out.reserve(size * 2);
    for (std::size_t i = 0; i < size; ++i) {
        out.push_back(hex[(data[i] >> 4U) & 0x0FU]);
        out.push_back(hex[data[i] & 0x0FU]);
    }
    return out;
}

std::string hexLower(const Sha256Digest &digest)
{
    return hexLower(digest.data(), digest.size());
}

}  // namespace livemap
