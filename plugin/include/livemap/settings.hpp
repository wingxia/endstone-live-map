#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace livemap {

struct LiveMapSettings {
    std::string worker_url = "https://map.buhe.li";
    std::string plugin_token;
    std::string server_id = "default";
    std::string background_log_file = "live_map.log";
    std::string baseline_index_file = "chunk_baselines.tsv";
    std::string land_config_file = "/vol1/1000/bedrock_server/plugins/land/land.json";
    std::vector<std::string> dimensions = {"Overworld"};
    int scan_radius_chunks = 8;
    int chunk_refresh_seconds = 20;
    int player_push_seconds = 1;
    int max_chunks_per_refresh = 32;
    int player_seed_radius_chunks = 4;
    int player_seed_interval_seconds = 600;
    int max_seed_chunks_per_pulse = 1;
    int seed_pulse_seconds = 1;
    int player_seed_join_delay_seconds = 10;
    int chunk_upload_batch_size = 8;
    int chunk_upload_flush_seconds = 10;
    int http_timeout_seconds = 30;
    int dirty_block_push_seconds = 1;
    int land_push_seconds = 60;
    int max_dirty_blocks_per_push = 64;
    int max_upload_queue_size = 256;
    bool upload_chunks = true;
    bool auto_seed_chunks = false;
    bool upload_dirty_blocks = true;
    bool upload_players = true;
    bool upload_lands = true;
};

struct TransportResult {
    bool ok = false;
    bool missing_base = false;
    long response_code = 0;
    int curl_code = 0;
    std::string error;
    std::string body;
};

LiveMapSettings loadSettings(const std::filesystem::path &path);
void writeExampleSettings(const std::filesystem::path &path);

}  // namespace livemap
