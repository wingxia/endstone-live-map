#include "livemap/settings.hpp"

#include <algorithm>
#include <fstream>
#include <optional>
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

std::optional<int> maybeIntValue(const std::string &source, const std::string &key)
{
    const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
    std::smatch match;
    if (!std::regex_search(source, match, pattern)) {
        return std::nullopt;
    }
    return std::stoi(match[1].str());
}

int intValue(const std::string &source, const std::string &key, int fallback)
{
    const auto value = maybeIntValue(source, key);
    return value.has_value() ? *value : fallback;
}

int legacyIntValue(const std::string &source, const std::string &key, const std::string &legacy_key, int fallback)
{
    const auto value = maybeIntValue(source, key);
    if (value.has_value()) {
        return *value;
    }
    const auto legacy_value = maybeIntValue(source, legacy_key);
    return legacy_value.has_value() ? *legacy_value : fallback;
}

std::optional<bool> maybeBoolValue(const std::string &source, const std::string &key)
{
    const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false)");
    std::smatch match;
    if (!std::regex_search(source, match, pattern)) {
        return std::nullopt;
    }
    return match[1].str() == "true";
}

bool boolValue(const std::string &source, const std::string &key, bool fallback)
{
    const auto value = maybeBoolValue(source, key);
    return value.has_value() ? *value : fallback;
}

bool legacyBoolValue(const std::string &source, const std::string &key, const std::string &legacy_key, bool fallback)
{
    const auto value = maybeBoolValue(source, key);
    if (value.has_value()) {
        return *value;
    }
    const auto legacy_value = maybeBoolValue(source, legacy_key);
    return legacy_value.has_value() ? *legacy_value : fallback;
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
    settings.background_log_file = stringValue(source, "background_log_file", settings.background_log_file);
    settings.baseline_index_file = stringValue(source, "baseline_index_file", settings.baseline_index_file);
    settings.tile_snapshot_cache_dir = stringValue(source, "tile_snapshot_cache_dir", settings.tile_snapshot_cache_dir);
    settings.land_config_file = stringValue(source, "land_config_file", settings.land_config_file);
    settings.dimensions = dimensionsValue(source, settings.dimensions);
    settings.scan_radius_chunks = intValue(source, "scan_radius_chunks", settings.scan_radius_chunks);
    settings.chunk_refresh_seconds =
        legacyIntValue(source, "chunk_refresh_seconds", "tile_refresh_seconds", settings.chunk_refresh_seconds);
    settings.player_push_seconds = intValue(source, "player_push_seconds", settings.player_push_seconds);
    settings.max_chunks_per_refresh =
        legacyIntValue(source, "max_chunks_per_refresh", "max_tiles_per_refresh", settings.max_chunks_per_refresh);
    settings.player_seed_radius_chunks = intValue(source, "player_seed_radius_chunks", settings.player_seed_radius_chunks);
    settings.player_seed_interval_seconds =
        intValue(source, "player_seed_interval_seconds", settings.player_seed_interval_seconds);
    settings.max_seed_chunks_per_pulse = intValue(source, "max_seed_chunks_per_pulse", settings.max_seed_chunks_per_pulse);
    settings.seed_pulse_seconds = intValue(source, "seed_pulse_seconds", settings.seed_pulse_seconds);
    settings.player_seed_join_delay_seconds =
        intValue(source, "player_seed_join_delay_seconds", settings.player_seed_join_delay_seconds);
    settings.chunk_upload_batch_size = intValue(source, "chunk_upload_batch_size", settings.chunk_upload_batch_size);
    settings.chunk_upload_flush_seconds =
        intValue(source, "chunk_upload_flush_seconds", settings.chunk_upload_flush_seconds);
    settings.chunk_upload_cooldown_seconds =
        intValue(source, "chunk_upload_cooldown_seconds", settings.chunk_upload_cooldown_seconds);
    settings.map_tile_render_threads = intValue(source, "map_tile_render_threads", settings.map_tile_render_threads);
    settings.map_tile_render_flush_seconds =
        intValue(source, "map_tile_render_flush_seconds", settings.map_tile_render_flush_seconds);
    settings.map_tile_upload_batch_size =
        intValue(source, "map_tile_upload_batch_size", settings.map_tile_upload_batch_size);
    settings.max_tile_bundle_bytes = intValue(source, "max_tile_bundle_bytes", settings.max_tile_bundle_bytes);
    settings.http_timeout_seconds = intValue(source, "http_timeout_seconds", settings.http_timeout_seconds);
    settings.dirty_block_push_seconds = intValue(source, "dirty_block_push_seconds", settings.dirty_block_push_seconds);
    settings.land_push_seconds = intValue(source, "land_push_seconds", settings.land_push_seconds);
    settings.max_dirty_blocks_per_push = intValue(source, "max_dirty_blocks_per_push", settings.max_dirty_blocks_per_push);
    settings.max_dirty_chunks_per_push = intValue(source, "max_dirty_chunks_per_push", settings.max_dirty_chunks_per_push);
    settings.max_upload_queue_size = intValue(source, "max_upload_queue_size", settings.max_upload_queue_size);
    settings.max_pending_chunk_uploads =
        intValue(source, "max_pending_chunk_uploads", settings.max_pending_chunk_uploads);
    settings.upload_chunks = legacyBoolValue(source, "upload_chunks", "upload_tiles", settings.upload_chunks);
    settings.map_tile_render_enabled =
        boolValue(source, "map_tile_render_enabled", settings.map_tile_render_enabled);
    settings.auto_seed_chunks = boolValue(source, "auto_seed_chunks", settings.auto_seed_chunks);
    settings.upload_dirty_blocks = boolValue(source, "upload_dirty_blocks", settings.upload_dirty_blocks);
    settings.upload_players = boolValue(source, "upload_players", settings.upload_players);
    settings.upload_lands = boolValue(source, "upload_lands", settings.upload_lands);

    settings.scan_radius_chunks = std::clamp(settings.scan_radius_chunks, 0, 16);
    settings.chunk_refresh_seconds = std::clamp(settings.chunk_refresh_seconds, 5, 3600);
    settings.player_push_seconds = std::clamp(settings.player_push_seconds, 1, 300);
    settings.max_chunks_per_refresh = std::clamp(settings.max_chunks_per_refresh, 1, 64);
    settings.player_seed_radius_chunks = std::clamp(settings.player_seed_radius_chunks, 0, 8);
    settings.player_seed_interval_seconds = std::clamp(settings.player_seed_interval_seconds, 30, 7200);
    settings.max_seed_chunks_per_pulse = std::clamp(settings.max_seed_chunks_per_pulse, 1, 16);
    settings.seed_pulse_seconds = std::clamp(settings.seed_pulse_seconds, 1, 60);
    settings.player_seed_join_delay_seconds = std::clamp(settings.player_seed_join_delay_seconds, 0, 300);
    settings.chunk_upload_batch_size = std::clamp(settings.chunk_upload_batch_size, 1, 128);
    settings.chunk_upload_flush_seconds = std::clamp(settings.chunk_upload_flush_seconds, 1, 60);
    settings.chunk_upload_cooldown_seconds = std::clamp(settings.chunk_upload_cooldown_seconds, 1, 600);
    settings.map_tile_render_threads = std::clamp(settings.map_tile_render_threads, 1, 1);
    settings.map_tile_render_flush_seconds = std::clamp(settings.map_tile_render_flush_seconds, 1, 300);
    settings.map_tile_upload_batch_size = std::clamp(settings.map_tile_upload_batch_size, 1, 128);
    settings.max_tile_bundle_bytes = std::clamp(settings.max_tile_bundle_bytes, 262144, 16777216);
    settings.http_timeout_seconds = std::clamp(settings.http_timeout_seconds, 5, 120);
    settings.dirty_block_push_seconds = std::clamp(settings.dirty_block_push_seconds, 1, 60);
    settings.land_push_seconds = std::clamp(settings.land_push_seconds, 10, 3600);
    settings.max_dirty_blocks_per_push = std::clamp(settings.max_dirty_blocks_per_push, 1, 4096);
    settings.max_dirty_chunks_per_push = std::clamp(settings.max_dirty_chunks_per_push, 1, 256);
    settings.max_upload_queue_size = std::clamp(settings.max_upload_queue_size, 1, 4096);
    settings.max_pending_chunk_uploads = std::clamp(settings.max_pending_chunk_uploads, 1, 65536);
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
        << "  \"background_log_file\": \"live_map.log\",\n"
        << "  \"baseline_index_file\": \"chunk_baselines.tsv\",\n"
        << "  \"tile_snapshot_cache_dir\": \"tile_snapshot_cache\",\n"
        << "  \"land_config_file\": \"/vol1/1000/bedrock_server/plugins/land/land.json\",\n"
        << "  \"dimensions\": [\"Overworld\", \"Nether\", \"TheEnd\"],\n"
        << "  \"scan_radius_chunks\": 8,\n"
        << "  \"chunk_refresh_seconds\": 20,\n"
        << "  \"player_push_seconds\": 1,\n"
        << "  \"max_chunks_per_refresh\": 32,\n"
        << "  \"player_seed_radius_chunks\": 4,\n"
        << "  \"player_seed_interval_seconds\": 600,\n"
        << "  \"max_seed_chunks_per_pulse\": 1,\n"
        << "  \"seed_pulse_seconds\": 1,\n"
        << "  \"player_seed_join_delay_seconds\": 10,\n"
        << "  \"chunk_upload_batch_size\": 8,\n"
        << "  \"chunk_upload_flush_seconds\": 10,\n"
        << "  \"chunk_upload_cooldown_seconds\": 60,\n"
        << "  \"map_tile_render_enabled\": true,\n"
        << "  \"map_tile_render_threads\": 1,\n"
        << "  \"map_tile_render_flush_seconds\": 15,\n"
        << "  \"map_tile_upload_batch_size\": 8,\n"
        << "  \"max_tile_bundle_bytes\": 2097152,\n"
        << "  \"http_timeout_seconds\": 30,\n"
        << "  \"dirty_block_push_seconds\": 60,\n"
        << "  \"land_push_seconds\": 60,\n"
        << "  \"max_dirty_blocks_per_push\": 2048,\n"
        << "  \"max_dirty_chunks_per_push\": 64,\n"
        << "  \"max_upload_queue_size\": 256,\n"
        << "  \"max_pending_chunk_uploads\": 4096,\n"
        << "  \"upload_chunks\": true,\n"
        << "  \"auto_seed_chunks\": false,\n"
        << "  \"upload_dirty_blocks\": true,\n"
        << "  \"upload_players\": true,\n"
        << "  \"upload_lands\": true\n"
        << "}\n";
}

}  // namespace livemap
