#!/usr/bin/env node
/*
 * The text screen, checked against the guest's own video memory.
 *
 * v86 draws text mode incrementally: every write the guest makes into video
 * memory is translated into a row and a column, and whenever the guest moves
 * the CRT start address - that is how Linux' vgacon scrolls, and how the BIOS
 * used to scroll - the whole screen is redrawn from the new window. So what
 * the browser shows has to be exactly the window at the start address, and a
 * stale row or a window that is one line off would show up here.
 *
 * The tool boots the Linux demo (`?demo=linux`) and prints both views side by
 * side, row by row. It exits non-zero when they differ.
 *
 * Usage:
 *     node emulator/tests/vga_debug.mjs
 *     node emulator/tests/vga_debug.mjs --query "?nosw&demo=linux" --timeout 300
 *
 * puppeteer and a Chrome are needed, see emulator/tests/ui_test.mjs (the same
 * CHROME_PATH and PUPPETEER_DIR variables work here).
 */

import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

import { serve } from "../serve.mjs";

const repo = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

function parse_args(argv) {
    const options = {
        query: "?nosw&demo=linux",
        wait: "openxiso:~#",
        timeout: 300,
        headful: false,
        port: 0,
    };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--query": options.query = argv[++i]; break;
            case "--wait": options.wait = argv[++i]; break;
            case "--timeout": options.timeout = parseInt(argv[++i], 10); break;
            case "--headful": options.headful = true; break;
            case "--port": options.port = parseInt(argv[++i], 10); break;
            default: throw new Error("unknown option: " + argv[i]);
        }
    }
    return options;
}

async function load_puppeteer() {
    const search = [repo];
    if (process.env.PUPPETEER_DIR) {
        search.push(process.env.PUPPETEER_DIR);
    }
    const resolved = createRequire(import.meta.url).resolve("puppeteer", { paths: search });
    const module = await import(url.pathToFileURL(resolved).href);
    return module.default || module;
}

/** What the engine draws, what its video memory holds, and where the window is. */
const read_screen = page => page.evaluate(() => {
    const v86 = window.OpenxISO.state.machine.emulator.v86;
    const vga = v86.vga || (v86.cpu && v86.cpu.devices && v86.cpu.devices.vga);
    if (!vga) {
        return { error: "the running engine has no VGA device" };
    }

    const memory_rows = [];
    for (let row = 0; row < vga.max_rows; row++) {
        let text = "";
        for (let col = 0; col < vga.max_cols; col++) {
            const address = (vga.start_address + row * vga.max_cols + col) * 2;
            const chr = vga.vga_memory[address] || 32;
            text += String.fromCharCode(chr >= 32 && chr < 127 ? chr : 32);
        }
        memory_rows.push(text.replace(/\s+$/, ""));
    }

    // one <div> per row; the engine only rewrites the rows that changed
    const drawn_rows = [...document.querySelectorAll("#screen_container .text-screen > div")]
        .map(element => element.textContent.replace(/\u00a0/g, " ").replace(/\s+$/, ""));

    return {
        state: {
            start_address: vga.start_address,
            start_address_latched: vga.start_address_latched,
            cursor_address: vga.cursor_address,
            graphical_mode: vga.graphical_mode,
            max_rows: vga.max_rows,
            max_cols: vga.max_cols,
            line_compare: vga.line_compare,
        },
        memory_rows,
        drawn_rows,
    };
});

function differences(report) {
    const rows = [];
    for (let row = 0; row < report.memory_rows.length; row++) {
        const drawn = report.drawn_rows[row] === undefined ? "(no row)" : report.drawn_rows[row];
        if (drawn !== report.memory_rows[row]) {
            rows.push(row);
        }
    }
    return rows;
}

async function main() {
    const options = parse_args(process.argv.slice(2));
    const puppeteer = await load_puppeteer();
    const running = await serve({ port: options.port, quiet: true });

    const launch = {
        headless: !options.headful,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
            "--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader"],
        env: process.env,
    };
    if (process.env.CHROME_PATH) {
        launch.executablePath = process.env.CHROME_PATH;
    }
    const browser = await puppeteer.launch(launch);

    try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${running.port}/emulator/index.html${options.query}`,
            { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => !!window.OpenxISO, { timeout: 30000 });
        await page.waitForFunction(text => window.OpenxISO.serial_text().includes(text),
            { timeout: options.timeout * 1000 }, options.wait);

        // the engine draws on animation frames, so give the last write a frame
        // before comparing (the very last row can be one frame behind)
        await new Promise(resolve => setTimeout(resolve, 1000));
        let report = await read_screen(page);
        if (report.error) {
            throw new Error(report.error);
        }

        console.log(JSON.stringify(report.state));
        console.log();
        for (let row = 0; row < report.memory_rows.length; row++) {
            const drawn = report.drawn_rows[row] === undefined ? "(no row)" : report.drawn_rows[row];
            const same = drawn === report.memory_rows[row];
            console.log(`row ${String(row).padStart(2)} ${same ? "=" : "!"} ${drawn}`);
            if (!same) {
                console.log(`            | ${report.memory_rows[row]}`);
            }
        }

        let rows = differences(report);
        if (rows.length) {
            // one retry: a row can be a frame behind right after a write
            await new Promise(resolve => setTimeout(resolve, 1000));
            report = await read_screen(page);
            rows = differences(report);
        }

        console.log();
        if (rows.length) {
            console.log(`the screen differs from video memory in ${rows.length}` +
                ` row(s): ${rows.join(", ")}`);
            process.exitCode = 1;
        } else {
            console.log(`the screen shows exactly the window at the start address ` +
                `(${report.state.start_address}, cursor ${report.state.cursor_address})`);
        }
    } finally {
        await browser.close();
        await running.close();
    }
}

await main();
