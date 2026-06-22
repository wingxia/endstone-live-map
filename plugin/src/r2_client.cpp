#include "livemap/r2_client.hpp"

#include "livemap/r2_signing.hpp"
#include "livemap/sha256.hpp"

#include <curl/curl.h>

#include <chrono>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <mutex>
#include <sstream>
#include <thread>

namespace livemap {
namespace {

std::vector<std::uint8_t> readFileBytes(const std::filesystem::path &path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        return {};
    }
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

std::string envValue(const char *name)
{
    const auto *value = std::getenv(name);
    return value == nullptr ? std::string{} : std::string{value};
}

std::pair<std::string, std::string> timestamp()
{
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &time);
#else
    gmtime_r(&time, &tm);
#endif
    std::ostringstream date;
    date << std::put_time(&tm, "%Y%m%d");
    std::ostringstream amz;
    amz << std::put_time(&tm, "%Y%m%dT%H%M%SZ");
    return {date.str(), amz.str()};
}

size_t appendResponseBody(char *ptr, size_t size, size_t nmemb, void *userdata)
{
    auto *body = static_cast<std::string *>(userdata);
    const auto total = size * nmemb;
    body->append(ptr, total);
    return total;
}

long putObject(const LiveMapSettings &settings, const RenderedTile &tile, const std::vector<std::uint8_t> &body,
               std::string *error)
{
    static std::once_flag curl_once;
    std::call_once(curl_once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });

    const auto access_key = envValue("LIVE_MAP_R2_ACCESS_KEY_ID");
    const auto secret_key = envValue("LIVE_MAP_R2_SECRET_ACCESS_KEY");
    if (access_key.empty() || secret_key.empty()) {
        if (error != nullptr) {
            *error = "LIVE_MAP_R2_ACCESS_KEY_ID or LIVE_MAP_R2_SECRET_ACCESS_KEY is missing";
        }
        return 0;
    }

    const auto [date_stamp, amz_date] = timestamp();
    R2SigningInput input;
    input.endpoint = settings.r2_endpoint;
    input.bucket = settings.r2_bucket;
    input.key = tile.r2_key;
    input.region = settings.r2_region;
    input.access_key_id = access_key;
    input.secret_access_key = secret_key;
    input.amz_date = amz_date;
    input.date_stamp = date_stamp;
    input.payload_sha256 = hexLower(sha256(body));
    const auto signed_request = signR2Request(input);

    CURL *curl = curl_easy_init();
    if (curl == nullptr) {
        if (error != nullptr) {
            *error = "curl_easy_init failed";
        }
        return 0;
    }

    std::string response_body;
    char error_buffer[CURL_ERROR_SIZE] = {};
    struct curl_slist *headers = nullptr;
    for (const auto &[name, value] : signed_request.headers) {
        const auto header = name + ": " + value;
        headers = curl_slist_append(headers, header.c_str());
    }

    curl_easy_setopt(curl, CURLOPT_URL, signed_request.url.c_str());
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, reinterpret_cast<const char *>(body.data()));
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, static_cast<long>(settings.http_timeout_seconds));
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, error_buffer);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, appendResponseBody);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_body);

    const auto code = curl_easy_perform(curl);
    long response_code = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response_code);
    if (code != CURLE_OK && error != nullptr) {
        *error = error_buffer[0] != '\0' ? error_buffer : curl_easy_strerror(code);
    }
    else if ((response_code < 200 || response_code >= 300) && error != nullptr) {
        *error = "HTTP " + std::to_string(response_code) + " " + response_body;
    }
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return response_code;
}

}  // namespace

R2UploadResult uploadRenderedTilesToR2(const LiveMapSettings &settings, const std::vector<RenderedTile> &tiles)
{
    R2UploadResult result;
    if (!settings.r2_enabled) {
        return result;
    }
    if (settings.r2_endpoint.empty() || settings.r2_bucket.empty()) {
        result.ok = false;
        result.error = "r2_endpoint and r2_bucket are required when r2_enabled is true";
        return result;
    }

    UploadRateLimiter limiter(settings.r2_max_uploads_per_minute);
    for (const auto &tile : tiles) {
        if (!tile.has_pixels) {
            continue;
        }
        const auto body = readFileBytes(tile.png_path);
        if (body.empty()) {
            result.ok = false;
            result.error = "missing rendered tile " + tile.png_path.string();
            return result;
        }
        const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::system_clock::now().time_since_epoch())
                                .count();
        const auto delay = limiter.delayMs(now_ms);
        if (delay > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(delay));
        }

        std::string error;
        long status = 0;
        for (int attempt = 0; attempt <= settings.r2_retry_count; ++attempt) {
            status = putObject(settings, tile, body, &error);
            if (status >= 200 && status < 300) {
                ++result.uploaded;
                limiter.record(std::chrono::duration_cast<std::chrono::milliseconds>(
                                   std::chrono::system_clock::now().time_since_epoch())
                                   .count());
                error.clear();
                break;
            }
            if (attempt < settings.r2_retry_count) {
                std::this_thread::sleep_for(std::chrono::milliseconds(settings.r2_retry_backoff_ms * (attempt + 1)));
            }
        }
        if (!error.empty()) {
            result.ok = false;
            result.error = error;
            return result;
        }
    }
    return result;
}

}  // namespace livemap
