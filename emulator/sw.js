/*
 * Service worker: makes the emulator work offline and installable.
 *
 * The app shell and the engine (a few megabytes of WebAssembly and BIOS
 * images) are cached on the first visit. The images the user attaches live in
 * IndexedDB, not here, so nothing large and private is ever put into the cache.
 *
 * Bump CACHE_VERSION when files change; old caches are deleted on activation.
 */

const CACHE_VERSION = "openxiso-v1";

const APP_SHELL = [
    "./",
    "./index.html",
    "./manifest.webmanifest",
    "./css/app.css",
    "./js/app.js",
    "./js/display.js",
    "./js/engine.js",
    "./js/files.js",
    "./js/i18n.js",
    "./js/keyboard.js",
    "./js/machine.js",
    "./js/media.js",
    "./js/serial.js",
    "./js/settings-ui.js",
    "./js/store.js",
    "./js/ui.js",
    "./icons/icon.svg",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
];

/** The engine is cached separately: a failed download must not break the UI. */
const ENGINE = [
    "./vendor/v86_64/libv86.mjs",
    "./vendor/v86_64/v86.wasm",
    "./vendor/v86_64/v86-fallback.wasm",
    "./vendor/v86_64/v86-mem64.wasm",
    "./vendor/v86_64/seabios.bin",
    "./vendor/v86_64/vgabios.bin",
];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_VERSION);
        await cache.addAll(APP_SHELL);
        // the engine files are big; cache them one by one and ignore failures
        for (const url of ENGINE) {
            try {
                await cache.add(new Request(url, { cache: "reload" }));
            } catch (error) {
                console.warn("not cached:", url, error);
            }
        }
        self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name !== CACHE_VERSION)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== location.origin) {
        return;
    }
    // image data is streamed with range requests and lives in the app, not in
    // the cache
    if (request.headers.has("range")) {
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_VERSION);
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) {
            // stale-while-revalidate: answer immediately, refresh in the back
            event.waitUntil((async () => {
                try {
                    const response = await fetch(request);
                    if (response && response.ok) {
                        await cache.put(request, response.clone());
                    }
                } catch (error) {
                    // offline: the cached copy is all we have
                }
            })());
            return cached;
        }

        try {
            const response = await fetch(request);
            if (response && response.ok && response.type === "basic") {
                cache.put(request, response.clone());
            }
            return response;
        } catch (error) {
            const fallback = await cache.match("./index.html");
            if (fallback) {
                return fallback;
            }
            throw error;
        }
    })());
});

self.addEventListener("message", event => {
    if (event.data === "skip-waiting") {
        self.skipWaiting();
    }
});
