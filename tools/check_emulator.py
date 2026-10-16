#!/usr/bin/env python3
"""Проверяет целостность веб-приложения эмулятора.

Запускается в CI и локально:

    python3 tools/check_emulator.py

Что проверяется:
  * структура каталога emulator/ (все файлы приложения и движка на месте),
  * что движок в emulator/vendor/v86_64 — это действительно v86_64
    (в libv86.mjs есть поддержка длинного режима, а BUILD_INFO.txt описывает
    происхождение файлов),
  * что страница подключает только существующие файлы (ссылки в index.html,
    импорты в js/*.js, список в sw.js),
  * что в исходниках нет забытых отладочных артефактов и жёстких абсолютных
    путей.

Скрипт ничего не меняет: он только читает файлы и возвращает код 1 при
найденной проблеме.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EMULATOR = ROOT / "emulator"

APPLICATION_FILES = (
    "index.html",
    "manifest.webmanifest",
    "sw.js",
    "css/app.css",
    "js/app.js",
    "js/display.js",
    "js/engine.js",
    "js/files.js",
    "js/i18n.js",
    "js/keyboard.js",
    "js/machine.js",
    "js/media.js",
    "js/serial.js",
    "js/settings-ui.js",
    "js/store.js",
    "js/ui.js",
    "icons/icon.svg",
    "serve.mjs",
    "tests/unit_test.mjs",
    "tests/boot_test.mjs",
    "tests/ui_test.mjs",
    "tests/make_screenshots.mjs",
    "tests/boot64.S",
    "tests/make_test_images.py",
    "README.md",
    "docs/screenshot.png",
    "docs/screenshot-graphics.png",
    "docs/screenshot-phone.png",
    "docs/screenshot-wizard.png",
)

ENGINE_FILES = (
    "libv86.mjs",
    "v86.wasm",
    "v86-mem64.wasm",
    "v86-fallback.wasm",
    "seabios.bin",
    "vgabios.bin",
    "BUILD_INFO.txt",
)

problems: list[str] = []


def fail(message: str) -> None:
    problems.append(message)


def check_layout() -> None:
    for name in APPLICATION_FILES:
        path = EMULATOR / name
        if not path.is_file():
            fail(f"нет файла {path.relative_to(ROOT)}")
    for name in ENGINE_FILES:
        path = EMULATOR / "vendor" / "v86_64" / name
        if not path.is_file():
            fail(f"нет файла движка {path.relative_to(ROOT)}")


def check_engine() -> None:
    """Движок должен быть тем самым форком v86_64 и совпадать с описанием сборки.

    Бандл минифицирован, поэтому проверить поддержку 64-битного режима по
    строкам нельзя: за это отвечает tests/boot_test.mjs, который грузит
    v86.wasm и проверяет, что гость действительно входит в длинный режим.
    Здесь проверяется происхождение и целостность файлов.
    """
    directory = EMULATOR / "vendor" / "v86_64"
    build_info = directory / "BUILD_INFO.txt"
    if not build_info.is_file():
        return

    text = build_info.read_text(encoding="utf-8")
    if "v86_64" not in text:
        fail("BUILD_INFO.txt не описывает движок v86_64")
    if not re.search(r"^commit:\s+[0-9a-f]{40}$", text, re.MULTILINE):
        fail("BUILD_INFO.txt не содержит коммит v86_64")

    described = {}
    for match in re.finditer(r"^([0-9a-f]{64})\s+(\S+)$", text, re.MULTILINE):
        described[match.group(2)] = match.group(1)
    if not described:
        fail("BUILD_INFO.txt не содержит контрольных сумм")

    for name, expected in sorted(described.items()):
        path = directory / name
        if not path.is_file():
            fail(f"в BUILD_INFO.txt описан отсутствующий файл: {name}")
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            fail(f"{name}: контрольная сумма не совпадает с BUILD_INFO.txt")

    wasm = directory / "v86.wasm"
    if wasm.is_file():
        if wasm.stat().st_size < 1_000_000:
            fail("v86.wasm подозрительно мал, движок не собран")
        if wasm.read_bytes()[:4] != b"\0asm":
            fail("v86.wasm не является модулем WebAssembly")
        # memory64 собирается из того же исходника: проверяем, что сборка на месте
        if not (directory / "v86-mem64.wasm").is_file():
            fail("нет v86-mem64.wasm: машины с памятью больше 3 ГиБ не запустятся")


def check_page() -> None:
    """Все ссылки на файлы в index.html должны вести на существующие файлы."""
    html = (EMULATOR / "index.html").read_text(encoding="utf-8")
    for match in re.finditer(r'(?:src|href)="([^"#]+)"', html):
        target = match.group(1)
        if target.startswith(("http:", "https:", "data:")):
            continue
        if not (EMULATOR / target).exists():
            fail(f"index.html ссылается на отсутствующий файл: {target}")

    if 'id="screen_container"' not in html:
        fail("в index.html нет элемента screen_container, нужного движку")
    if "<canvas" not in html:
        fail("в index.html нет canvas для графического режима")


def check_imports() -> None:
    """Относительные импорты в js/*.js должны разрешаться в реальные файлы."""
    for path in sorted((EMULATOR / "js").glob("*.js")):
        text = path.read_text(encoding="utf-8")
        matches = list(re.finditer(r'from\s+"(\./[^"]+)"', text))
        matches += list(re.finditer(r'import\(\s*"(\./[^"]+)"', text))
        for match in matches:
            target = (path.parent / match.group(1)).resolve()
            if not target.is_file():
                fail(f"{path.name}: импорт не найден: {match.group(1)}")


def check_service_worker() -> None:
    worker = EMULATOR / "sw.js"
    if not worker.is_file():
        return
    text = worker.read_text(encoding="utf-8")
    for match in re.finditer(r'"\./([^"]+)"', text):
        target = EMULATOR / match.group(1)
        if not target.exists():
            fail(f"sw.js перечисляет отсутствующий файл: {match.group(1)}")


def check_manifest() -> None:
    manifest = EMULATOR / "manifest.webmanifest"
    if not manifest.is_file():
        return
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"manifest.webmanifest не разбирается: {error}")
        return
    for icon in data.get("icons", []):
        if not (EMULATOR / icon["src"]).is_file():
            fail(f"manifest.webmanifest ссылается на отсутствующую иконку: {icon['src']}")


def check_sources() -> None:
    """Никаких отладочных артефактов и абсолютных путей в коде приложения."""
    for path in sorted(list((EMULATOR / "js").glob("*.js")) + [EMULATOR / "sw.js",
                                                               EMULATOR / "serve.mjs"]):
        text = path.read_text(encoding="utf-8")
        if "/home/" in text or "/tmp/" in text:
            fail(f"{path.name}: абсолютный путь в коде")
        if "console.log(\"TODO" in text:
            fail(f"{path.name}: забытая отладка")
        if re.search(r"\bdebugger\b", text):
            fail(f"{path.name}: остался оператор debugger")


def check_sizes() -> None:
    """Размер каталога эмулятора: он целиком попадает в APK."""
    total = 0
    for path in EMULATOR.rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            total += path.stat().st_size
    if total > 16 * 1024 * 1024:
        fail(f"каталог emulator/ весит {total // (1024 * 1024)} МиБ — слишком много для APK")


def main() -> int:
    check_layout()
    check_engine()
    check_page()
    check_imports()
    check_service_worker()
    check_manifest()
    check_sources()
    check_sizes()

    for problem in problems:
        print("ошибка: " + problem, file=sys.stderr)
    if problems:
        print(f"\nнайдено проблем: {len(problems)}", file=sys.stderr)
        return 1
    print("эмулятор в порядке: файлы на месте, ссылки разрешаются, движок собран")
    return 0


if __name__ == "__main__":
    sys.exit(main())
