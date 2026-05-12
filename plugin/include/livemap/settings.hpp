#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace livemap {

struct LiveMapSettings {
    std::string worker_url = "https://map.buhe.li";
    std::string plugin_token;
    std::string server_id = "default";
    std::vector<std::string> dimensions = {"Overworld"};
    int scan_radius_chunks = 8;
    int chunk_refresh_seconds = 20;
    int player_push_seconds = 1;
    int max_chunks_per_refresh = 32;
    bool upload_chunks = true;
    bool upload_players = true;
};

LiveMapSettings loadSettings(const std::filesystem::path &path);
void writeExampleSettings(const std::filesystem::path &path);

}  // namespace livemap
