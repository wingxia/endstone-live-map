#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace livemap {

struct R2SigningInput {
    std::string method = "PUT";
    std::string endpoint;
    std::string bucket;
    std::string key;
    std::string region = "auto";
    std::string access_key_id;
    std::string secret_access_key;
    std::string amz_date;
    std::string date_stamp;
    std::string payload_sha256;
    std::string content_type = "image/png";
};

struct R2SignedRequest {
    std::string url;
    std::map<std::string, std::string> headers;
    std::string canonical_request;
    std::string string_to_sign;
    std::string authorization;
};

[[nodiscard]] std::string uriEncode(std::string_view value, bool encode_slash = false);
[[nodiscard]] std::string r2Host(std::string_view endpoint);
[[nodiscard]] R2SignedRequest signR2Request(const R2SigningInput &input);

class UploadRateLimiter {
public:
    explicit UploadRateLimiter(int max_per_minute = 60);
    [[nodiscard]] std::int64_t delayMs(std::int64_t now_ms);
    void record(std::int64_t now_ms);

private:
    int max_per_minute_;
    std::vector<std::int64_t> sent_at_ms_;
};

}  // namespace livemap
