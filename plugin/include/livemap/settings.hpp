#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace livemap {

struct LiveMapSettings {
    std::string worker_url = "https://map.buhe.li";
    std::string local_server_url = "http://127.0.0.1:8000";
    std::string plugin_token;
    std::string server_id = "default";
    std::string background_log_file = "live_map.log";
    std::string baseline_index_file = "chunk_baselines.tsv";
    std::string land_config_file = "/vol1/1000/bedrock_server/plugins/land/land.json";
    std::string tile_data_dir = "map-data";
    std::string r2_endpoint;
    std::string r2_bucket;
    std::string r2_region = "auto";
    std::string r2_key_prefix = "map-tiles/v2";
    std::vector<std::string> dimensions = {"Overworld"};
    int tile_min_zoom = -1;
    int tile_max_zoom = 4;
    int render_worker_threads = 2;
    int scan_radius_chunks = 8;
    int chunk_refresh_seconds = 20;
    int player_push_seconds = 1;
    int max_chunks_per_refresh = 32;
    int player_seed_radius_chunks = 4;
    int player_seed_interval_seconds = 60;
    int max_seed_chunks_per_pulse = 4;
    int seed_pulse_seconds = 1;
    int player_seed_join_delay_seconds = 10;
    int chunk_upload_batch_size = 8;
    int chunk_upload_flush_seconds = 10;
    int chunk_upload_cooldown_seconds = 60;
    int http_timeout_seconds = 30;
    int dirty_block_push_seconds = 60;
    int land_push_seconds = 60;
    int max_dirty_blocks_per_push = 2048;
    int max_dirty_chunks_per_push = 64;
    int max_upload_queue_size = 256;
    int max_pending_chunk_uploads = 4096;
    int r2_max_concurrent_uploads = 1;
    int r2_max_uploads_per_minute = 60;
    int r2_retry_count = 3;
    int r2_retry_backoff_ms = 1000;
    bool upload_chunks = true;
    bool auto_seed_chunks = false;
    bool upload_dirty_blocks = true;
    bool upload_players = true;
    bool upload_lands = true;
    bool r2_enabled = false;
};

struct TransportResult {
    bool ok = false;
    long response_code = 0;
    int curl_code = 0;
    std::string error;
    std::string body;
};

LiveMapSettings loadSettings(const std::filesystem::path &path);
void writeExampleSettings(const std::filesystem::path &path);

}  // namespace livemap
