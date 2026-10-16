# Сборка Web/WASM

## Что
Одна сборка → один `index.html`, который работает и в десктоп-браузерах, и на телефонах (адаптивный canvas на всю вьюпорт, PWA manifest).

- **WASM**: `emcc -s WASM=1`
- **Графика**: Canvas 2D (самый простой и короткий вариант)
- **Клавиатура**: JS `<input>` (вместо JNI/Java InputMethod)
- **Всё от Java убрано**: нет JNI, нет `com.cb4.*` — только браузерные API
- **Начальный alert**: `alert("это та табличка в начале игры ^_^")`

## Как собрать
```bash
# Установить emsdk (один раз)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh && cd ..

./build_web.sh
```

Результат в `build/web/`:
- `index.html` (копия `cb4.html`)
- `cb4.html`, `cb4.js`, `cb4.wasm`, `cb4.data`
- `manifest.json` (PWA)

## CI
GitHub Actions: `.github/workflows/main.yml` — два джоба:
- `build-android` → APK
- `build-web` → один `index.html` (артефакт `Cubic-Battle-4-Web`)

Android NDK-сборка продолжает работать как раньше.
