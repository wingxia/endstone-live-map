#pragma once

#include <string_view>

namespace livemap {

bool isMapSurfaceBlock(std::string_view block_id, bool include_liquids = true);
bool isMapDecorationBlock(std::string_view block_id);
bool isPlantBlock(std::string_view block_id);

}  // namespace livemap
