#include "livemap/chunk.hpp"
#include "livemap/protocol.hpp"
#include "livemap/settings.hpp"

#include <curl/curl.h>

#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace livemap {

class CurlTransport {
public:
    explicit CurlTransport(LiveMapSettings settings) : settings_(std::move(settings)) {}

    bool postJson(std::string_view path, std::string_view json) const
    {
        static std::once_flag curl_once;
        std::call_once(curl_once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });

        CURL *curl = curl_easy_init();
        if (curl == nullptr) {
            return false;
        }

        const auto url = settings_.worker_url + std::string(path);
        struct curl_slist *headers = nullptr;
        headers = curl_slist_append(headers, "Content-Type: application/json");
        const auto auth = "Authorization: Bearer " + settings_.plugin_token;
        headers = curl_slist_append(headers, auth.c_str());

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json.data());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(json.size()));
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

        const auto result = curl_easy_perform(curl);
        long response_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &response_code);

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        return result == CURLE_OK && response_code >= 200 && response_code < 300;
    }

private:
    LiveMapSettings settings_;
};

bool postLiveJson(const LiveMapSettings &settings, std::string_view json)
{
    return CurlTransport(settings).postJson("/api/plugin/live", json);
}

bool uploadChunkSnapshot(const LiveMapSettings &settings, const ChunkSnapshot &snapshot)
{
    return CurlTransport(settings).postJson("/api/plugin/chunks", serializeChunkSnapshot(snapshot));
}

}  // namespace livemap
