#!/usr/bin/env node
/*
 * A small static file server for the emulator, so the app can be opened in a
 * browser with
 *
 *     node emulator/serve.mjs
 *     open http://localhost:8080/
 *
 * It serves the emulator directory (and, for convenience, the repository root
 * so that the test images under build/ are reachable as well), understands
 * Range requests (v86 downloads URL based images in 256 byte blocks) and sends
 * the MIME types a WebAssembly application needs.
 *
 * Options:
 *     --port N        port to listen on (default 8080, 0 picks a free one)
 *     --host HOST     address to bind (default 0.0.0.0)
 *     --no-root       only serve the emulator directory
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(here);

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".wasm": "application/wasm",
    ".bin": "application/octet-stream",
    ".iso": "application/x-iso9660-image",
    ".img": "application/octet-stream",
    ".hdd": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".map": "application/json",
};

/**
 * @param {{port?: number, host?: string, roots?: Array<string>, quiet?: boolean}=} options
 * @return {Promise<{server: http.Server, port: number, url: string, close: function()}>}
 */
export async function serve(options = {}) {
    const roots = options.roots || [here, repo];
    const quiet = options.quiet === true;

    const server = http.createServer(async (request, response) => {
        const requested = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const relative = requested.replace(/^\/+/, "") || "index.html";

        let file = null;
        for (const root of roots) {
            const candidate = path.resolve(root, relative);
            if (!candidate.startsWith(path.resolve(root))) {
                continue; // no escaping the served directories
            }
            for (const name of [candidate, path.join(candidate, "index.html")]) {
                try {
                    const stats = await fsp.stat(name);
                    if (stats.isFile()) {
                        file = { path: name, stats: stats };
                        break;
                    }
                } catch (error) {
                    // try the next candidate
                }
            }
            if (file) {
                break;
            }
        }

        if (!file) {
            if (!quiet) {
                console.log(`404 ${request.url}`);
            }
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            response.end("not found: " + requested + "\n");
            return;
        }

        const type = MIME_TYPES[path.extname(file.path).toLowerCase()] || "application/octet-stream";
        const headers = {
            "content-type": type,
            "cache-control": "no-cache",
            "accept-ranges": "bytes",
            // a WebAssembly application wants to be able to use SharedArrayBuffer
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-embedder-policy": "require-corp",
            "cross-origin-resource-policy": "same-origin",
        };

        const range = request.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (match) {
                const size = file.stats.size;
                let start = match[1] === "" ? undefined : parseInt(match[1], 10);
                let end = match[2] === "" ? undefined : parseInt(match[2], 10);
                if (start === undefined) {
                    start = Math.max(0, size - (end === undefined ? 0 : end + 1));
                    end = size - 1;
                } else if (end === undefined || end >= size) {
                    end = size - 1;
                }
                if (start > end || start >= size) {
                    response.writeHead(416, { "content-range": `bytes */${size}` });
                    response.end();
                    return;
                }
                headers["content-range"] = `bytes ${start}-${end}/${size}`;
                headers["content-length"] = String(end - start + 1);
                response.writeHead(206, headers);
                if (request.method === "HEAD") {
                    response.end();
                    return;
                }
                fs.createReadStream(file.path, { start: start, end: end }).pipe(response);
                return;
            }
        }

        headers["content-length"] = String(file.stats.size);
        response.writeHead(200, headers);
        if (request.method === "HEAD") {
            response.end();
            return;
        }
        fs.createReadStream(file.path).pipe(response);
        if (!quiet) {
            console.log(`${request.method} ${request.url} -> ${path.relative(repo, file.path)} (${file.stats.size} B)`);
        }
    });

    const port = options.port === undefined ? 8080 : options.port;
    const host = options.host || "0.0.0.0";

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });

    const address = server.address();
    return {
        server: server,
        port: address.port,
        url: `http://127.0.0.1:${address.port}/emulator/index.html`,
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

function parse_args(argv) {
    const options = { port: 8080 };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--port": options.port = parseInt(argv[++i], 10); break;
            case "--host": options.host = argv[++i]; break;
            case "--no-root": options.roots = [here]; break;
            case "--quiet": options.quiet = true; break;
            default: throw new Error("unknown option: " + argv[i]);
        }
    }
    return options;
}

const is_main = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));

if (is_main) {
    const options = parse_args(process.argv.slice(2));
    const running = await serve(options);
    console.log(`OpenxISO is served on http://localhost:${running.port}/`);
    console.log(`  app:    http://localhost:${running.port}/emulator/index.html`);
    console.log(`  engine: http://localhost:${running.port}/emulator/vendor/v86_64/libv86.mjs`);
    if (options.roots !== undefined && options.roots.length > 1) {
        console.log("the repository root is served as well, so build/emulator-tests/ is reachable");
    }
}

export default { serve };
