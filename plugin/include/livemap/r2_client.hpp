#pragma once

#include "livemap/settings.hpp"
#include "livemap/tile_renderer.hpp"

#include <string>
#include <vector>

namespace livemap {

struct R2UploadResult {
    bool ok = true;
    std::size_t uploaded = 0;
    std::string error;
};

R2UploadResult uploadRenderedTilesToR2(const LiveMapSettings &settings, const std::vector<RenderedTile> &tiles);

}  // namespace livemap
