cmake_minimum_required(VERSION 3.16)
project(CubicBattle4 LANGUAGES C CXX)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

set(CB_SOURCE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/src")

if(EMSCRIPTEN)
    # --- WebAssembly сборка: один output = index.html (+ .js + .wasm + .data)
    #     Работает и на десктопе, и на телефонах (viewport-fit=cover, PWA manifest).
    #     - графика: Canvas 2D (самый простой вариант)
    #     - клавиатура/алерты: чисто JS (без Java/JNI)
    add_executable(cb4_web "${CB_SOURCE_ROOT}/platform/web/web_main.c")
    set_target_properties(cb4_web PROPERTIES
        SUFFIX ".html"
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build/web"
        OUTPUT_NAME "cb4"
        LINK_FLAGS "-s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1 \
-s EXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAP8','ccall','cwrap'] \
-s INVOKE_RUN=1 \
--shell-file ${CMAKE_CURRENT_SOURCE_DIR}/build/web/shell.html \
--preload-file ${CMAKE_CURRENT_SOURCE_DIR}/assets@/assets -O2"
    )
    target_include_directories(cb4_web PRIVATE "${CB_SOURCE_ROOT}" "${CMAKE_CURRENT_SOURCE_DIR}")
else()
    if(NOT CMAKE_C_COMPILER_ID MATCHES "^(Apple)?Clang$")
        message(FATAL_ERROR "Android build requires Clang.")
    endif()
    if(NOT ANDROID)
        message(FATAL_ERROR
            "Configure with either -DEMSCRIPTEN= via emcmake (Web/WASM) or "
            "with the Android NDK toolchain (Android .so).")
    endif()
    set(CB_ANDROID_GLUE "${ANDROID_NDK}/sources/android/native_app_glue")
    add_library(cb_game SHARED
        "${CB_SOURCE_ROOT}/game/game.c"
        "${CB_SOURCE_ROOT}/game/cpp/ui_fx.cpp"
        "${CB_SOURCE_ROOT}/engine/runtime.c"
        "${CB_SOURCE_ROOT}/platform/android/android_main.c"
        "${CB_ANDROID_GLUE}/android_native_app_glue.c"
    )
    target_include_directories(cb_game PRIVATE
        "${CB_SOURCE_ROOT}"
        "${CMAKE_CURRENT_SOURCE_DIR}"
        "${CB_ANDROID_GLUE}"
    )
    target_link_libraries(cb_game PRIVATE android log dl m vulkan)
endif()
