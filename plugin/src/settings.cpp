#include "livemap/settings.hpp"

#include <fstream>
#include <regex>
#include <sstream>

namespace livemap {

namespace {

std::string readFile(const std::filesystem::path &path)
{
    std::ifstream in(path);
    if (!in) {
        return {};
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::string stringValue(const std::string &source, const std::string &key, std::string fallback)
{
    const std::regex pattern("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
    std::smatch match;
    return std::regex_search(source, match, pattern) ? match[1].str() : std::move(fallback);
}

int intValue(const std::string &source, const std::string &key, int fallback)
{
    const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
    std::smatch match;
    return std::regex_search(source, match, pattern) ? std::stoi(match[1].str()) : fallback;
}

bool boolValue(const std::string &source, const std::string &key, bool fallback)
{
    const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false)");
    std::smatch match;
    return std::regex_search(source, match, pattern) ? match[1].str() == "true" : fallback;
}

std::vector<std::string> dimensionsValue(const std::string &source, std::vector<std::string> fallback)
{
    const std::regex pattern("\"dimensions\"\\s*:\\s*\\[([^\\]]*)\\]");
    std::smatch match;
    if (!std::regex_search(source, match, pattern)) {
        return fallback;
    }

    std::vector<std::string> values;
    const std::string body = match[1].str();
    const std::regex item("\"([^\"]+)\"");
    for (auto it = std::sregex_iterator(body.begin(), body.end(), item); it != std::sregex_iterator(); ++it) {
        values.push_back((*it)[1].str());
    }
    return values.empty() ? std::move(fallback) : values;
}

}  // namespace

LiveMapSettings loadSettings(const std::filesystem::path &path)
{
    LiveMapSettings settings;
    const auto source = readFile(path);
    if (source.empty()) {
        return settings;
    }

    settings.worker_url = stringValue(source, "worker_url", settings.worker_url);
    settings.plugin_token = stringValue(source, "plugin_token", settings.plugin_token);
    settings.server_id = stringValue(source, "server_id", settings.server_id);
    settings.dimensions = dimensionsValue(source, settings.dimensions);
    settings.scan_radius_chunks = intValue(source, "scan_radius_chunks", settings.scan_radius_chunks);
    settings.chunk_refresh_seconds = intValue(source, "chunk_refresh_seconds", settings.chunk_refresh_seconds);
    settings.player_push_seconds = intValue(source, "player_push_seconds", settings.player_push_seconds);
    settings.max_chunks_per_refresh = intValue(source, "max_chunks_per_refresh", settings.max_chunks_per_refresh);
    settings.upload_chunks = boolValue(source, "upload_chunks", settings.upload_chunks);
    settings.upload_players = boolValue(source, "upload_players", settings.upload_players);
    return settings;
}

void writeExampleSettings(const std::filesystem::path &path)
{
    std::filesystem::create_directories(path.parent_path());
    std::ofstream out(path);
    out << "{\n"
        << "  \"worker_url\": \"https://map.buhe.li\",\n"
        << "  \"plugin_token\": \"replace-with-cloudflare-secret\",\n"
        << "  \"server_id\": \"vvnas\",\n"
        << "  \"dimensions\": [\"Overworld\", \"Nether\", \"TheEnd\"],\n"
        << "  \"scan_radius_chunks\": 8,\n"
        << "  \"chunk_refresh_seconds\": 60,\n"
        << "  \"player_push_seconds\": 1,\n"
        << "  \"max_chunks_per_refresh\": 1,\n"
        << "  \"upload_chunks\": true,\n"
        << "  \"upload_players\": true\n"
        << "}\n";
}

}  // namespace livemap
