#!/usr/bin/env bash
# Одна WebAssembly-сборка → build/web/index.html (+ cb4.js + cb4.wasm + manifest.json)
# Один файл работает и на десктопе, и на телефонах (адаптивный canvas, viewport).
set -e
cd "$(dirname "$0")"
SRC="$PWD"
mkdir -p build/web
emcc "$SRC/src/platform/web/web_main.c" \
  -I"$SRC/src" -I"$SRC" \
  -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1 \
  -s "EXPORTED_RUNTIME_METHODS=['UTF8ToString','HEAP8','ccall','cwrap']" \
  -s INVOKE_RUN=1 \
  --shell-file "$SRC/build/web/shell.html" \
  --preload-file "$SRC/assets@/assets" \
  -o "$SRC/build/web/cb4.html" -O2
cp "$SRC/build/web/cb4.html" "$SRC/build/web/index.html"
cp "$SRC/build/phone/manifest.json" "$SRC/build/web/manifest.json"
echo "ГОТОВО: build/web/index.html (десктоп + телефоны в одном файле)"
ls -la build/web/
