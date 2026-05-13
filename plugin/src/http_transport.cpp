#include "livemap/chunk.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"

#include <curl/curl.h>

#include <mutex>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace livemap {

class CurlTransport {
public:
    explicit CurlTransport(LiveMapSettings settings) : settings_(std::move(settings)) {}

    TransportResult postJson(std::string_view path, std::string_view json) const
    {
        static std::once_flag curl_once;
        std::call_once(curl_once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });

        CURL *curl = curl_easy_init();
        if (curl == nullptr) {
            return {.ok = false, .error = "curl_easy_init failed"};
        }

        const auto url = settings_.worker_url + std::string(path);
        char error_buffer[CURL_ERROR_SIZE] = {};
        struct curl_slist *headers = nullptr;
        headers = curl_slist_append(headers, "Content-Type: application/json");
        const auto auth = "Authorization: Bearer " + settings_.plugin_token;
        headers = curl_slist_append(headers, auth.c_str());

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, error_buffer);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json.data());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(json.size()));
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

        const auto result = curl_easy_perform(curl);
        long response_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response_code);

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);

        TransportResult transport_result;
        transport_result.ok = result == CURLE_OK && response_code >= 200 && response_code < 300;
        transport_result.response_code = response_code;
        transport_result.curl_code = static_cast<int>(result);
        if (result != CURLE_OK) {
            transport_result.error = error_buffer[0] != '\0' ? error_buffer : curl_easy_strerror(result);
        }
        else if (!transport_result.ok) {
            transport_result.error = "HTTP " + std::to_string(response_code);
        }
        return transport_result;
    }

private:
    LiveMapSettings settings_;
};

TransportResult postLiveJson(const LiveMapSettings &settings, std::string_view json)
{
    return CurlTransport(settings).postJson("/api/plugin/live", json);
}

TransportResult uploadChunkSnapshot(const LiveMapSettings &settings, const ChunkSnapshot &snapshot)
{
    return CurlTransport(settings).postJson("/api/plugin/chunks", serializeChunkSnapshot(snapshot));
}

}  // namespace livemap
