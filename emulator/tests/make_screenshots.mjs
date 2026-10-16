#!/usr/bin/env node
/*
 * Produce the screenshots used by emulator/README.md.
 *
 * It serves the repository, opens the app in a headless Chrome, boots the test
 * images from build/emulator-tests/ and writes four PNG files into
 * emulator/docs/:
 *
 *   screenshot.png           a machine running the 64-bit test guest, with the
 *                            COM1 console open next to the screen
 *   screenshot-graphics.png  the same guest after it set up a 640x480x32 VBE
 *                            framebuffer and drew its colour bands
 *   screenshot-phone.png     the phone layout (a running machine, no details)
 *   screenshot-wizard.png    the "new machine" wizard on the media page
 *
 * Usage:
 *     python3 emulator/tests/make_test_images.py      # the images it boots
 *     node emulator/tests/make_screenshots.mjs
 *
 * puppeteer and a Chrome are needed, see emulator/tests/ui_test.mjs; the same
 * CHROME_PATH and PUPPETEER_DIR variables work here.
 *
 * Options: --out DIR, --headful, --port N.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

import { serve } from "../serve.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));

function parse_args(argv) {
    const options = { out: path.join(repo, "emulator", "docs"), headful: false, port: 0 };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--out": options.out = argv[++i]; break;
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

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Start the app on a page and wait until it is ready. Every screenshot gets its
 * own browser context, so the machine list in each of them is the one the
 * screenshot itself created (the store lives in IndexedDB, which contexts do
 * not share).
 */
async function open_app(browser, base, viewport, query) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport(viewport);
    await page.goto(`${base}/index.html${query}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.OpenxISO, { timeout: 30000 });
    return page;
}

/**
 * Create a machine that boots one of the test images and wait until the guest
 * says it is done.
 */
async function boot_test_guest(page, image, name) {
    await page.evaluate(async (image_url, machine_name) => {
        const blob = await (await fetch(image_url)).blob();
        await window.OpenxISO.new_machine({ name: machine_name });
        await window.OpenxISO.attach_blob("cdrom", blob, image_url.split("/").pop());
        await window.OpenxISO.start_machine();
    }, `../build/emulator-tests/${image}`, name);
    await page.waitForFunction(
        () => window.OpenxISO.serial_text().includes("v86-64 test: done"),
        { timeout: 180000 });
    await sleep(1200);
}

async function main() {
    const options = parse_args(process.argv.slice(2));

    for (const image of ["long-mode-test.iso", "long-mode-gfx-test.iso"]) {
        const file = path.join(repo, "build", "emulator-tests", image);
        if (!fs.existsSync(file)) {
            console.error(`error: ${file} is missing`);
            console.error("hint: run python3 emulator/tests/make_test_images.py first");
            process.exit(2);
        }
    }

    const puppeteer = await load_puppeteer();
    const running = await serve({ port: options.port, quiet: true });
    const base = `http://127.0.0.1:${running.port}/emulator`;
    fs.mkdirSync(options.out, { recursive: true });

    const launch = {
        headless: !options.headful,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
            "--autoplay-policy=no-user-gesture-required", "--use-gl=swiftshader",
            "--hide-scrollbars"],
        env: process.env,
    };
    if (process.env.CHROME_PATH) {
        launch.executablePath = process.env.CHROME_PATH;
    }
    const browser = await puppeteer.launch(launch);
    const shot = (page, name) => page.screenshot({ path: path.join(options.out, name) });

    // 1. a running 64-bit guest, with the COM1 console next to the screen
    const desktop = await open_app(browser, base, { width: 1280, height: 860 }, "?nosw");
    await boot_test_guest(desktop, "long-mode-test.iso", "Тестовая x86-64");
    await desktop.click("#btn-serial");
    await desktop.evaluate(() => {
        // show the end of the transcript, that is where "done" is
        const output = document.getElementById("serial-output");
        output.scrollTop = output.scrollHeight;
    });
    await sleep(800);
    await shot(desktop, "screenshot.png");
    console.log("screenshot.png");

    // 2. the same guest in a graphical mode: Bochs VBE, 640x480x32
    const graphics = await open_app(browser, base, { width: 1280, height: 860 }, "?nosw&demo=gfx");
    await graphics.waitForFunction(
        () => window.OpenxISO.serial_text().includes("graphics ok"),
        { timeout: 180000 });
    await sleep(1500);
    await shot(graphics, "screenshot-graphics.png");
    console.log("screenshot-graphics.png");

    // 3. the phone layout
    const phone = await open_app(browser, base,
        { width: 412, height: 880, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, "?nosw");
    await boot_test_guest(phone, "long-mode-test.iso", "Тестовая x86-64");
    await phone.evaluate(() => {
        const details = document.querySelector(".details");
        if (details) {
            details.style.display = "none";
        }
        document.querySelector(".vm-window").scrollIntoView();
    });
    await sleep(800);
    await shot(phone, "screenshot-phone.png");
    console.log("screenshot-phone.png");

    // 4. the wizard, on the page where the images are attached
    const wizard = await open_app(browser, base, { width: 1280, height: 860 }, "?nosw");
    await wizard.click("#btn-new");
    await wizard.waitForSelector("dialog.dialog", { visible: true });
    await wizard.$eval(".wizard-nav .button.primary", button => button.click());
    await wizard.waitForFunction(() =>
        document.querySelector(".wizard-step").textContent.includes("Носители"));
    await sleep(400);
    await shot(wizard, "screenshot-wizard.png");
    console.log("screenshot-wizard.png");

    await browser.close();
    await running.close();
    console.log(`\nwritten to ${options.out}`);
}

await main();
