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
    int tile_refresh_seconds = 60;
    int player_push_seconds = 1;
    int max_tiles_per_refresh = 1;
    bool upload_tiles = true;
    bool upload_players = true;
};

LiveMapSettings loadSettings(const std::filesystem::path &path);
void writeExampleSettings(const std::filesystem::path &path);

}  // namespace livemap
