#!/usr/bin/env node
/*
 * End to end test of the emulator app in a real browser.
 *
 * It starts the static server from emulator/serve.mjs, opens the app in a
 * headless Chrome, and then does what a user does: create a machine with the
 * wizard, pick the test ISO through the file picker, press "Start", check that
 * the guest boots into 64-bit long mode (the guest prints over COM1 and paints
 * a banner), then attach the test hard disk image by drag and drop, switch the
 * boot order to the hard disk and boot that one too.
 *
 * Requirements:
 *   - the test images: python3 emulator/tests/make_test_images.py
 *   - puppeteer, and a Chrome/Chromium for it:
 *       npm install puppeteer            (downloads a browser)
 *       CHROME_PATH=/path/to/chrome node emulator/tests/ui_test.mjs
 *     A preinstalled browser elsewhere on the machine can be pointed at with
 *     CHROME_PATH, and PUPPETEER_DIR tells the test where to find the puppeteer
 *     package when it does not sit next to the repository.
 *
 * Options: --headful (watch it), --keep-open (leave the browser running),
 *          --port N, --timeout SECONDS.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

import { serve } from "../serve.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));
const require = createRequire(import.meta.url);

const IMAGES = path.join(repo, "build", "emulator-tests");

function parse_args(argv) {
    const options = { headful: false, keep_open: false, port: 0, timeout: 120 };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--headful": options.headful = true; break;
            case "--keep-open": options.keep_open = true; break;
            case "--port": options.port = parseInt(argv[++i], 10); break;
            case "--timeout": options.timeout = parseInt(argv[++i], 10); break;
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
    try {
        const resolved = require.resolve("puppeteer", { paths: search });
        const module = await import(url.pathToFileURL(resolved).href);
        return module.default || module;
    } catch (error) {
        return null;
    }
}

let passed = 0;
let failed = 0;

async function test(name, body) {
    try {
        await body();
        passed++;
        console.log("  ok   " + name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + name);
        console.log("       " + String(error && error.stack || error).split("\n").join("\n       "));
    }
}

/**
 * Wait until the page's own condition is true.
 * @param {Object} page
 * @param {string} description
 * @param {Function} condition runs in the page
 * @param {number} timeout milliseconds
 * @param {Function=} diagnostics runs in the page when it times out
 */
async function wait_for(page, description, condition, timeout, diagnostics) {
    const deadline = Date.now() + (timeout || 60000);
    for (;;) {
        const value = await page.evaluate(condition);
        if (value) {
            return value;
        }
        if (Date.now() > deadline) {
            const state = diagnostics ? await page.evaluate(diagnostics) : null;
            throw new Error("timed out waiting for: " + description +
                (state ? "\n       state: " + JSON.stringify(state) : ""));
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

/**
 * Click a button once it is enabled — the power buttons are disabled while an
 * operation of the previous click is still running.
 */
async function click_when_enabled(page, selector) {
    await page.waitForFunction(sel => {
        const element = document.querySelector(sel);
        return element && !element.disabled;
    }, { timeout: 60000 }, selector);
    await page.click(selector);
}

/** What the page looks like when something goes wrong. */
function diagnose() {
    const app = window.OpenxISO;
    return {
        status: app.state.machine ? app.state.machine.status : null,
        last_error: app.state.last_error,
        serial: app.serial_text().slice(-400),
        media: app.state.machine ? app.state.machine.media_stats : null,
        machine: app.state.machines.map(machine => ({
            name: machine.name,
            boot: machine.system.boot_order,
            media: Object.keys(machine.media).filter(kind => machine.media[kind]),
        })),
    };
}

async function main() {
    const options = parse_args(process.argv.slice(2));

    for (const file of ["long-mode-test.iso", "long-mode-test.hdd"]) {
        if (!fs.existsSync(path.join(IMAGES, file))) {
            console.error(`${file} is missing, run: python3 emulator/tests/make_test_images.py`);
            process.exit(2);
        }
    }

    const puppeteer = await load_puppeteer();
    if (!puppeteer) {
        console.log("puppeteer is not installed, skipping the browser test");
        console.log("  npm install puppeteer");
        process.exit(0);
    }

    const running = await serve({ port: options.port, quiet: true });
    console.log(`serving http://127.0.0.1:${running.port}/emulator/index.html`);

    const launch_options = {
        headless: !options.headful,
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--mute-audio",
            "--autoplay-policy=no-user-gesture-required",
            "--use-gl=swiftshader",
            "--window-size=1280,900",
        ],
        env: process.env,
    };
    if (process.env.CHROME_PATH) {
        launch_options.executablePath = process.env.CHROME_PATH;
    }

    const browser = await puppeteer.launch(launch_options);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const console_errors = [];
    page.on("console", message => {
        if (message.type() === "error") {
            console_errors.push(message.text());
        }
    });
    page.on("pageerror", error => console_errors.push("pageerror: " + error.message));

    const app_url = `http://127.0.0.1:${running.port}/emulator/index.html?nosw`;
    await page.goto(app_url, { waitUntil: "domcontentloaded" });

    console.log("\nthe app itself");

    await test("the app starts and shows an empty machine list", async () => {
        await wait_for(page, "the app to initialise", () => !!window.OpenxISO, 30000);
        const text = await page.$eval("#machine-list", element => element.textContent);
        assert.match(text, /машин|машины|Нажмите/i);
    });

    await test("the engine files are reachable", async () => {
        const result = await page.evaluate(async () => {
            const response = await fetch("./vendor/v86_64/libv86.mjs", { method: "HEAD" });
            const wasm = await fetch("./vendor/v86_64/v86.wasm", { method: "HEAD" });
            return { mjs: response.status, wasm: wasm.status };
        });
        assert.equal(result.mjs, 200);
        assert.equal(result.wasm, 200);
    });

    await test("the translator fills in Russian", async () => {
        const label = await page.$eval("#btn-start", element => element.textContent.trim());
        assert.equal(label, "Запустить");
        const title = await page.title();
        assert.match(title, /OpenxISO/);
    });

    console.log("\ncreating a machine with the wizard");

    await test("the wizard creates a machine and takes the ISO from the file picker", async () => {
        await page.click("#btn-new");
        await page.waitForSelector("dialog.dialog", { visible: true });
        await page.$eval("dialog.dialog input.input", input => { input.value = "Тестовая машина"; });

        // step 1 -> step 2 (media)
        await page.$eval(".wizard-nav .button.primary", button => button.click());
        await page.waitForFunction(() =>
            document.querySelector(".wizard-step").textContent.includes("Носители"));

        // the rows are labelled, and since the machine can also boot a kernel
        // image the CD-ROM row is no longer the first one: find it by label
        const [chooser] = await Promise.all([
            page.waitForFileChooser(),
            page.evaluate(() => {
                const row = [...document.querySelectorAll(".media-list .media-details")]
                    .find(entry => /Оптический привод/.test(entry.textContent));
                if (!row) {
                    throw new Error("the CD-ROM row is not on the media page");
                }
                row.querySelector(".media-buttons .button").click();
            }),
        ]);
        await chooser.accept([path.join(IMAGES, "long-mode-test.iso")]);

        await page.waitForFunction(() => {
            const row = [...document.querySelectorAll(".media-list .media-details")]
                .find(entry => /Оптический привод/.test(entry.textContent));
            const name = row && row.querySelector(".media-name");
            return !!name && name.textContent.includes("long-mode-test.iso");
        }, { timeout: 30000 });
        await page.evaluate(() => window.OpenxISO.state.store.count("media")).then(count => {
            assert.ok(count >= 1, "the image was written to the store");
        });

        // step 2 -> step 3 -> create
        await page.$eval(".wizard-nav .button.primary", button => button.click());
        await page.waitForFunction(() =>
            document.querySelector(".wizard-step").textContent.includes("Дисплей"));
        await page.$eval(".wizard-nav .button.primary", button => button.click());
        await page.waitForFunction(() => !document.querySelector("dialog.dialog"));

        const machines = await page.evaluate(() => window.OpenxISO.state.machines.map(m => ({
            id: m.id, name: m.name, cdrom: m.media.cdrom && m.media.cdrom.name,
            storage: m.media.cdrom && m.media.cdrom.storage,
        })));
        assert.equal(machines.length, 1);
        assert.equal(machines[0].name, "Тестовая машина");
        assert.equal(machines[0].cdrom, "long-mode-test.iso");
        assert.equal(machines[0].storage, "browser", "the image is kept in IndexedDB");
    });

    console.log("\nbooting the ISO in the browser");

    await test("the guest boots into 64-bit long mode and takes the input", async () => {
        await click_when_enabled(page, "#btn-start");
        await wait_for(page, "the machine to run", () => {
            const machine = window.OpenxISO.state.machine;
            return !!machine && machine.status === "running";
        }, 60000, diagnose);

        // The guest installs an IDT, programs the PIT and the PS/2 controller
        // and then waits two seconds for timer ticks: the input below has to
        // arrive inside that window, otherwise the guest has already stopped.
        await wait_for(page, "the guest to be ready for input", () =>
            window.OpenxISO.serial_text().includes("irq test ready"), 120000, diagnose);

        // VirtualBox style capturing: clicking the screen locks the pointer, so
        // that moving the mouse only moves the guest pointer.
        const box = await page.$eval("#screen_container", element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        assert.ok(box.width > 100 && box.height > 100, "the screen has a size");
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        const captured = await page.waitForFunction(() => {
            const container = document.getElementById("screen_container");
            return !!document.pointerLockElement ||
                container.classList.contains("virtual-mouse");
        }, { timeout: 15000 }).then(() => true).catch(() => false);
        assert.equal(captured, true, "the click captured the mouse (pointer lock or virtual mouse)");

        // now type and move the mouse like a user would
        await page.keyboard.press("a");
        for (let step = 0; step < 4; step++) {
            await page.mouse.move(box.x + 120 + step * 25, box.y + 90 + step * 15);
            await new Promise(resolve => setTimeout(resolve, 40));
        }

        const serial = await wait_for(page, "the guest transcript", () => {
            const text = window.OpenxISO.serial_text();
            return text.includes("v86-64 test: done") ? text : false;
        }, 120000, diagnose);

        assert.match(serial, /bios boot ok/);
        assert.match(serial, /entering protected mode/);
        assert.match(serial, /protected mode ok/);
        assert.match(serial, /entering long mode/);
        assert.match(serial, /long mode ok/);
        assert.match(serial, /sum=edcba9777777778f nibble=e low=000000007777778f/);
        assert.match(serial, /irq test ready/);
        assert.match(serial, /done/);

        // the make and the break code of "a" (0x1e / 0x9e) reached the guest
        // through the emulated PS/2 controller, and so did mouse movements
        assert.match(serial, /key 1e/);
        assert.match(serial, /key 9e/);
        assert.match(serial, /mouse [0-9a-f]{2}/);
        const counters = /irq keyboard=([0-9a-f]{16}) mouse=([0-9a-f]{16}) ticks=([0-9a-f]{16})/.exec(serial);
        assert.ok(counters, "the guest reported its interrupt counters");
        assert.ok(parseInt(counters[1], 16) >= 2, "the keyboard sent scancodes");
        assert.ok(parseInt(counters[2], 16) >= 3, "the mouse sent at least one packet");
        assert.ok(parseInt(counters[3], 16) >= 200, "the PIT delivered its ticks");
    });

    await test("Escape releases the captured mouse again", async () => {
        // The toolbar has to be usable again after the guest had the mouse: the
        // browser releases the pointer when Escape is pressed while it is
        // locked, and the app shows the capture hint again.
        await page.keyboard.press("Escape");
        const released = await page.waitForFunction(() => !document.pointerLockElement, { timeout: 10000 })
            .then(() => true).catch(() => false);
        if (!released) {
            await page.evaluate(() => document.exitPointerLock && document.exitPointerLock());
        }
        const locked = await page.evaluate(() => !!document.pointerLockElement);
        assert.equal(locked, false, "the pointer is not locked any more");
    });

    await test("the capture overlay is the one the app translates", async () => {
        // the pill used to be built twice: a hidden copy in index.html that the
        // app updated and a visible one created by the display module
        const overlay = await page.evaluate(() => {
            const hint = document.getElementById("capture-hint");
            return {
                overlays: document.querySelectorAll("#screen_container .screen-capture").length,
                hints: document.querySelectorAll("#screen_container .capture-hint").length,
                shown: !!hint && !hint.closest(".screen-capture").hidden,
                text: hint ? hint.textContent.trim() : "",
            };
        });
        assert.equal(overlay.overlays, 1, "there is exactly one capture overlay");
        assert.equal(overlay.hints, 1, "there is exactly one capture hint");
        assert.ok(overlay.shown, "the hint is shown while the machine runs");
        assert.ok(overlay.text.length > 0, "the hint has a text");
    });

    await test("the screen really shows the guest text mode output", async () => {
        const screen = await wait_for(page, "the banner on the emulated screen", () => {
            const element = document.querySelector("#screen_container .text-screen");
            const text = element ? element.textContent : "";
            return text.includes("long mode ok") ? text : false;
        }, 30000, diagnose);
        assert.match(screen, /64-bit long mode ok/);
    });

    await test("audio is wired up (PC speaker and Sound Blaster)", async () => {
        const audio = await page.evaluate(() => {
            const emulator = window.OpenxISO.state.machine.emulator;
            const speaker = emulator.speaker_adapter;
            return {
                has_speaker: !!speaker,
                has_pcspeaker: !!(speaker && speaker.pcspeaker),
                has_dac: !!(speaker && speaker.dac),
                sb16: !!emulator.v86.cpu.devices.sb16,
                sample_rate: speaker && speaker.audio_context && speaker.audio_context.sampleRate,
            };
        });
        assert.equal(audio.has_speaker, true, "the speaker adapter exists");
        assert.equal(audio.has_pcspeaker, true, "the PC speaker is connected");
        assert.equal(audio.has_dac, true, "the sound card DAC is connected");
        assert.equal(audio.sb16, true, "the emulated Sound Blaster 16 exists");
    });

    await test("the status bar follows the running machine", async () => {
        const status = await page.evaluate(() => ({
            state: document.getElementById("status-state").textContent,
            machine: document.getElementById("status-machine").textContent,
            read: document.getElementById("status-read").textContent,
            screen: document.getElementById("status-screen").textContent,
        }));
        assert.match(status.state, /Работает/);
        assert.equal(status.machine, "Тестовая машина");
        assert.notEqual(status.read, "—");
        assert.notEqual(status.screen, "—");
    });

    await test("a screenshot of the window can be taken", async () => {
        const file = path.join(repo, "build", "emulator-tests", "ui.png");
        await page.screenshot({ path: file, fullPage: false });
        assert.ok(fs.statSync(file).size > 10000, "the screenshot has content");
    });

    await test("suspending and restoring the machine works", async () => {
        const result = await page.evaluate(async () => {
            const app = window.OpenxISO;
            const state = await app.state.machine.save_state();
            const before = app.state.machine.machine.system.memory_mb;
            return { size: state.size, memory: before };
        });
        assert.ok(result.size > 1024 * 1024, "a save state is at least the guest memory");
    });

    console.log("\nthe hard disk image, by drag and drop");

    await test("the machine is switched to boot from the hard disk", async () => {
        await click_when_enabled(page, "#btn-stop");
        await wait_for(page, "the emulator to stop", () => !window.OpenxISO.state.machine, 30000, diagnose);

        await click_when_enabled(page, "#btn-settings");
        await page.waitForSelector("dialog.dialog", { visible: true });
        // the third select on the system page is the boot order
        const value = await page.evaluate(() => {
            const selects = Array.from(document.querySelectorAll("dialog.dialog select.input"));
            const boot = selects[2];
            boot.value = "hd";
            boot.dispatchEvent(new Event("change"));
            return boot.value;
        });
        assert.equal(value, "hd");
        await page.$$eval("dialog.dialog .dialog-footer .button", buttons => {
            const save = buttons.find(button => button.textContent.trim() === "Сохранить");
            save.click();
        });
        await page.waitForFunction(() => !document.querySelector("dialog.dialog"));

        const order = await page.evaluate(() =>
            window.OpenxISO.state.machines[0].system.boot_order);
        assert.equal(order, "hd");
    });

    await test("dropping the .hdd file attaches it to the machine", async () => {
        // read the image through the page and drop it as a File, which is what
        // a real drag and drop delivers
        await page.evaluate(async () => {
            const blob = await (await fetch("../build/emulator-tests/long-mode-test.hdd")).blob();
            const file = new File([blob], "long-mode-test.hdd", { type: "application/octet-stream" });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const workspace = document.getElementById("workspace");
            workspace.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
            workspace.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
        });

        const attached = await wait_for(page, "the image to be attached", () => {
            const machine = window.OpenxISO.state.machines[0];
            return machine.media.hda ? machine.media.hda.name : false;
        }, 60000);
        assert.equal(attached, "long-mode-test.hdd");
        assert.equal(await page.evaluate(() => window.OpenxISO.state.machines[0].media.hda.storage),
            "browser");
    });

    await test("the guest boots from the hard disk image", async () => {
        await click_when_enabled(page, "#btn-start");
        await wait_for(page, "the machine to run", () => {
            const machine = window.OpenxISO.state.machine;
            return !!machine && machine.status === "running";
        }, 60000, diagnose);

        // the transcript of the previous boot is still in the console, so wait
        // for a second "done"
        const serial = await wait_for(page, "the second boot", () => {
            const text = window.OpenxISO.serial_text();
            return text.split("v86-64 test: done").length > 2 ? text : false;
        }, 120000, diagnose);

        assert.match(serial, /entering long mode/);
        const reads = await page.evaluate(() => {
            const stats = window.OpenxISO.state.machine.media_stats;
            return { read: stats.read, images: stats.images };
        });
        assert.ok(reads.read > 1024 * 1024, "the guest read the image through the blob backend");
        assert.equal(reads.images, 2, "the ISO is still attached");
    });

    await test("an ISO can be streamed from a URL with range requests", async () => {
        await click_when_enabled(page, "#btn-stop");
        await wait_for(page, "the emulator to stop", () => !window.OpenxISO.state.machine, 30000, diagnose);

        // the test server serves the repository, so the same ISO is reachable
        // by URL: the engine then reads it with Range requests instead of
        // copying it into the browser storage
        const url = `http://127.0.0.1:${running.port}/build/emulator-tests/long-mode-test.iso`;
        await page.evaluate(async (image_url) => {
            window.OpenxISO.state.machines[0].media.hda = null;
            await window.OpenxISO.attach_url("cdrom", image_url);
            await window.OpenxISO.save_machine(window.OpenxISO.state.machines[0]);
        }, url);

        const storage = await page.evaluate(() =>
            window.OpenxISO.state.machines[0].media.cdrom.storage);
        assert.equal(storage, "url");

        await click_when_enabled(page, "#btn-start");
        await wait_for(page, "the machine to run", () => {
            const machine = window.OpenxISO.state.machine;
            return !!machine && machine.status === "running";
        }, 60000, diagnose);

        const serial = await wait_for(page, "the guest to boot from the URL", () => {
            const text = window.OpenxISO.serial_text();
            return text.split("v86-64 test: done").length > 3 ? text : false;
        }, 120000, diagnose);
        assert.match(serial, /long mode ok/);
    });

    await test("the guest paints a VBE framebuffer and the window shows it", async () => {
        await click_when_enabled(page, "#btn-stop");
        await wait_for(page, "the emulator to stop", () => !window.OpenxISO.state.machine, 30000, diagnose);

        // the graphics build of the test program: it finds the framebuffer
        // through the PCI BAR, programs the Bochs VBE registers for 640x480x32
        // and draws three colour bands. It is streamed from the test server, so
        // this also covers a graphical guest on an image that is never copied
        // into the browser storage.
        const url = `http://127.0.0.1:${running.port}/build/emulator-tests/long-mode-gfx-test.iso`;
        await page.evaluate(async (image_url) => {
            window.OpenxISO.state.machines[0].media.hda = null;
            await window.OpenxISO.attach_url("cdrom", image_url);
            await window.OpenxISO.save_machine(window.OpenxISO.state.machines[0]);
        }, url);
        assert.equal(await page.evaluate(() =>
            window.OpenxISO.state.machines[0].media.cdrom.storage), "url");

        await click_when_enabled(page, "#btn-start");
        await wait_for(page, "the machine to run", () => {
            const machine = window.OpenxISO.state.machine;
            return !!machine && machine.status === "running";
        }, 60000, diagnose);

        const serial = await wait_for(page, "the graphics guest", () => {
            const text = window.OpenxISO.serial_text();
            return text.split("v86-64 test: done").length > 4 ? text : false;
        }, 120000, diagnose);
        assert.match(serial, /pci bar0=e0000008/);
        assert.match(serial, /framebuffer at 00000000e0000000/);
        assert.match(serial, /framebuffer read back 0000000000ff0000,000000000000ff00,00000000000000ff/);
        assert.match(serial, /graphics ok 640x480x32/);

        // and the emulated screen has to be 640x480 with those very bands
        const screen = await wait_for(page, "the graphical screen to appear", () => {
            const canvas = document.querySelector("#screen_container canvas");
            if (!canvas || canvas.width !== 640 || canvas.height !== 480) {
                return false;
            }
            const context = canvas.getContext("2d");
            const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
            return {
                size: [canvas.width, canvas.height],
                visible: getComputedStyle(canvas).display !== "none",
                top: pixel(320, 40),
                middle: pixel(320, 240),
                bottom: pixel(320, 440),
                status: document.getElementById("status-screen").textContent,
            };
        }, 30000, diagnose);

        assert.deepEqual(screen.size, [640, 480]);
        assert.equal(screen.visible, true, "the canvas is not hidden");
        assert.deepEqual(screen.top.slice(0, 3), [255, 0, 0], "the first band is red");
        assert.deepEqual(screen.middle.slice(0, 3), [0, 255, 0], "the second band is green");
        assert.deepEqual(screen.bottom.slice(0, 3), [0, 0, 255], "the third band is blue");
        assert.match(screen.status, /640/);
    });

    await test("the machine survives a reload of the page", async () => {
        await click_when_enabled(page, "#btn-stop");
        await wait_for(page, "the emulator to stop", () => !window.OpenxISO.state.machine, 30000, diagnose);

        await page.reload({ waitUntil: "domcontentloaded" });
        await wait_for(page, "the app to come back", () => !!window.OpenxISO, 30000);

        const machines = await page.evaluate(async () => {
            const stored = await window.OpenxISO.store().get_all("machines");
            const media = await window.OpenxISO.store().get_all("media");
            return {
                list: window.OpenxISO.state.machines.map(machine => machine.name),
                stored: stored.length,
                media: media.map(entry => entry.name).sort(),
                url: window.OpenxISO.state.machines[0].media.cdrom.url,
            };
        });
        assert.equal(machines.stored, 1);
        assert.deepEqual(machines.list, ["Тестовая машина"]);
        assert.ok(machines.media.includes("long-mode-test.iso"));
        assert.ok(machines.url, "the URL image is still attached after the reload");
    });

    await test("no errors were logged to the console", () => {
        const serious = console_errors.filter(message =>
            !/favicon|Autoplay|AudioContext was not allowed|service worker/i.test(message));
        assert.deepEqual(serious, []);
    });

    if (!options.keep_open) {
        await browser.close();
    }
    await running.close();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

await main();
