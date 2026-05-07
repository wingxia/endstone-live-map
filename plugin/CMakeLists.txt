cmake_minimum_required(VERSION 3.24)

project(endstone_live_map VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(LIVE_MAP_WITH_ENDSTONE "Build the Endstone plugin shared library" ON)
set(ENDSTONE_API_VERSION "0.11.3" CACHE STRING "Endstone API version")

add_library(livemap_core
    src/base64.cpp
    src/bmp_writer.cpp
    src/color_map.cpp
    src/dirty_tile_tracker.cpp
    src/protocol.cpp
    src/settings.cpp
    src/tile_math.cpp
    src/tile_renderer.cpp
)
target_include_directories(livemap_core PUBLIC include)
target_compile_features(livemap_core PUBLIC cxx_std_20)

include(CTest)
if(BUILD_TESTING)
    add_executable(livemap_core_tests tests/core_tests.cpp)
    target_link_libraries(livemap_core_tests PRIVATE livemap_core)
    add_test(NAME livemap_core_tests COMMAND livemap_core_tests)
endif()

if(LIVE_MAP_WITH_ENDSTONE)
    include(FetchContent)
    FetchContent_Declare(
        endstone
        URL https://github.com/EndstoneMC/endstone/archive/refs/tags/v${ENDSTONE_API_VERSION}.tar.gz
    )
    FetchContent_MakeAvailable(endstone)

    find_package(CURL REQUIRED)

    endstone_add_plugin(${PROJECT_NAME}
        src/endstone_plugin.cpp
        src/http_transport.cpp
    )
    target_include_directories(${PROJECT_NAME} PRIVATE include)
    target_link_libraries(${PROJECT_NAME} PRIVATE livemap_core CURL::libcurl)
endif()
