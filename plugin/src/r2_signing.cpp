#include "livemap/r2_signing.hpp"

#include "livemap/sha256.hpp"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <stdexcept>

namespace livemap {
namespace {

std::vector<std::uint8_t> bytes(std::string_view value)
{
    return {value.begin(), value.end()};
}

std::string trimSlashes(std::string value)
{
    while (!value.empty() && value.front() == '/') {
        value.erase(value.begin());
    }
    while (!value.empty() && value.back() == '/') {
        value.pop_back();
    }
    return value;
}

std::string lower(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
        return static_cast<char>(std::tolower(ch));
    });
    return value;
}

}  // namespace

std::string uriEncode(std::string_view value, bool encode_slash)
{
    static constexpr char hex[] = "0123456789ABCDEF";
    std::string out;
    for (const auto ch : value) {
        const auto uch = static_cast<unsigned char>(ch);
        const bool unreserved = (uch >= 'A' && uch <= 'Z') || (uch >= 'a' && uch <= 'z') ||
                                (uch >= '0' && uch <= '9') || uch == '-' || uch == '_' || uch == '.' || uch == '~';
        if (unreserved || (!encode_slash && ch == '/')) {
            out.push_back(ch);
            continue;
        }
        out.push_back('%');
        out.push_back(hex[(uch >> 4U) & 0x0FU]);
        out.push_back(hex[uch & 0x0FU]);
    }
    return out;
}

std::string r2Host(std::string_view endpoint)
{
    std::string value(endpoint);
    const auto scheme = value.find("://");
    if (scheme != std::string::npos) {
        value.erase(0, scheme + 3);
    }
    const auto slash = value.find('/');
    if (slash != std::string::npos) {
        value.erase(slash);
    }
    return lower(value);
}

R2SignedRequest signR2Request(const R2SigningInput &input)
{
    if (input.endpoint.empty() || input.bucket.empty() || input.key.empty() || input.access_key_id.empty() ||
        input.secret_access_key.empty() || input.amz_date.empty() || input.date_stamp.empty() ||
        input.payload_sha256.empty()) {
        throw std::invalid_argument("missing R2 signing input");
    }

    const auto host = r2Host(input.endpoint);
    const auto canonical_uri = "/" + uriEncode(trimSlashes(input.bucket) + "/" + trimSlashes(input.key));
    const auto canonical_headers = "content-type:" + input.content_type + "\n" + "host:" + host + "\n" +
                                   "x-amz-content-sha256:" + input.payload_sha256 + "\n" + "x-amz-date:" +
                                   input.amz_date + "\n";
    const auto signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    const auto canonical_request = input.method + "\n" + canonical_uri + "\n\n" + canonical_headers + "\n" +
                                   signed_headers + "\n" + input.payload_sha256;

    const auto credential_scope = input.date_stamp + "/" + input.region + "/s3/aws4_request";
    const auto string_to_sign = "AWS4-HMAC-SHA256\n" + input.amz_date + "\n" + credential_scope + "\n" +
                                hexLower(sha256(canonical_request));
    const auto k_date = hmacSha256(bytes("AWS4" + input.secret_access_key), input.date_stamp);
    const auto k_region = hmacSha256({k_date.begin(), k_date.end()}, input.region);
    const auto k_service = hmacSha256({k_region.begin(), k_region.end()}, "s3");
    const auto k_signing = hmacSha256({k_service.begin(), k_service.end()}, "aws4_request");
    const auto signature = hexLower(hmacSha256({k_signing.begin(), k_signing.end()}, string_to_sign));
    const auto authorization = "AWS4-HMAC-SHA256 Credential=" + input.access_key_id + "/" + credential_scope +
                               ", SignedHeaders=" + signed_headers + ", Signature=" + signature;

    R2SignedRequest request;
    auto endpoint = std::string(input.endpoint);
    while (!endpoint.empty() && endpoint.back() == '/') {
        endpoint.pop_back();
    }
    request.url = endpoint + canonical_uri;
    request.canonical_request = canonical_request;
    request.string_to_sign = string_to_sign;
    request.authorization = authorization;
    request.headers = {
        {"Authorization", authorization},
        {"Content-Type", input.content_type},
        {"Host", host},
        {"x-amz-content-sha256", input.payload_sha256},
        {"x-amz-date", input.amz_date},
    };
    return request;
}

UploadRateLimiter::UploadRateLimiter(int max_per_minute) : max_per_minute_(std::max(1, max_per_minute)) {}

std::int64_t UploadRateLimiter::delayMs(std::int64_t now_ms)
{
    const auto cutoff = now_ms - 60000;
    sent_at_ms_.erase(std::remove_if(sent_at_ms_.begin(), sent_at_ms_.end(), [cutoff](auto value) {
                         return value <= cutoff;
                     }),
                      sent_at_ms_.end());
    if (sent_at_ms_.size() < static_cast<std::size_t>(max_per_minute_)) {
        return 0;
    }
    return std::max<std::int64_t>(0, sent_at_ms_.front() + 60000 - now_ms);
}

void UploadRateLimiter::record(std::int64_t now_ms)
{
    sent_at_ms_.push_back(now_ms);
}

}  // namespace livemap
