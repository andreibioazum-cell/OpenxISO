#!/usr/bin/env node
/*
 * Drives the emulator app in a real browser the way a user would, but with a
 * *real* operating system inside the machine: Linux 6.6 for x86-64 with a
 * BusyBox userland, the kernel image from emulator/images.
 *
 * The app is opened with ?demo=linux, which creates a machine, attaches the
 * kernel image and presses "power on" - so this test covers the whole path:
 * the VirtualBox style shell, the file being loaded as a kernel image, the
 * engine booting it through the Linux boot protocol, the emulated screen
 * showing the guest's own output, the click-to-capture mouse, the emulated
 * keyboard typing into the guest's console, the serial panel talking to the
 * guest's shell, and the audio devices being wired up.
 *
 * Requirements:
 *   - the kernel image: emulator/images/linux-6.6-x86_64.bzImage
 *     (tools/linux-guest/build.py rebuilds it from upstream sources)
 *   - puppeteer, and a Chrome/Chromium for it:
 *       npm install puppeteer            (downloads a browser)
 *       CHROME_PATH=/path/to/chrome node emulator/tests/linux_ui_test.mjs
 *
 * Options: --headful (watch it), --keep-open (leave the browser running),
 *          --port N, --timeout SECONDS.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

import { serve } from "../serve.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));
const require = createRequire(import.meta.url);

const KERNEL = path.join(repo, "emulator", "images", "linux-6.6-x86_64.bzImage");

function parse_args(argv) {
    const options = { headful: false, keep_open: false, port: 0, timeout: 240 };
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

async function wait_for(page, description, condition, timeout, diagnostics, argument) {
    const deadline = Date.now() + (timeout || 60000);
    for (;;) {
        // the condition runs inside the page: anything it needs from here has to
        // be passed as an argument, a closure would lose it
        const value = await page.evaluate(condition, argument);
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

/** What the page looks like when something goes wrong. */
function diagnose() {
    const app = window.OpenxISO;
    return {
        status: app.state.machine ? app.state.machine.status : null,
        last_error: app.state.last_error,
        serial: app.serial_text().slice(-500),
        screen: (document.querySelector("#screen_container .text-screen") || {}).textContent,
        media: app.state.machines.length ?
            Object.keys(app.state.machines[0].media)
                .filter(kind => app.state.machines[0].media[kind]) : [],
    };
}

async function main() {
    const options = parse_args(process.argv.slice(2));

    if (!fs.existsSync(KERNEL)) {
        console.error("the kernel image is missing: " + KERNEL);
        console.error("build it with: python3 tools/linux-guest/build.py");
        process.exit(2);
    }

    const puppeteer = await load_puppeteer();
    if (!puppeteer) {
        console.log("puppeteer is not installed, skipping the browser test");
        console.log("  npm install puppeteer");
        process.exit(0);
    }

    const running = await serve({ port: options.port, quiet: true });
    console.log(`serving http://127.0.0.1:${running.port}/`);

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

    // ?nosw keeps the page from registering its service worker, so a reload in
    // the middle of a test does not serve a cached copy
    await page.goto(`http://127.0.0.1:${running.port}/emulator/index.html?nosw&demo=linux`,
        { waitUntil: "domcontentloaded" });

    console.log("\nthe app boots a real Linux kernel");

    await test("the demo machine is created with the kernel image attached", async () => {
        await wait_for(page, "the app to initialise", () => !!window.OpenxISO, 30000);
        const machine = await wait_for(page, "the machine to appear", () => {
            const list = window.OpenxISO.state.machines;
            if (!list.length) {
                return false;
            }
            return {
                name: list[0].name,
                kernel: list[0].media.kernel ? list[0].media.kernel.name : null,
                storage: list[0].media.kernel ? list[0].media.kernel.storage : null,
                cmdline: list[0].system.cmdline,
                memory: list[0].system.memory_mb,
            };
        }, 60000, diagnose);
        assert.match(machine.name, /Демонстрация/);
        assert.equal(machine.kernel, "linux-6.6-x86_64.bzImage");
        assert.equal(machine.storage, "url", "the image is streamed from the server");
        assert.match(machine.cmdline, /console=ttyS0/, "the kernel gets a serial console");
        assert.ok(machine.memory >= 512, "the machine has room for the kernel and its initramfs");
    });

    await test("the machine powers on and Linux comes up", async () => {
        await wait_for(page, "the machine to run", () => {
            const machine = window.OpenxISO.state.machine;
            return !!machine && machine.status === "running";
        }, 60000, diagnose);

        const serial = await wait_for(page, "the kernel to reach userland",
            () => window.OpenxISO.serial_text().includes("openxiso:~#") ?
                window.OpenxISO.serial_text() : false, options.timeout * 1000, diagnose);
        assert.match(serial, /Linux version 6\.6\.\d+/);
        assert.match(serial, /Command line:/, "the command line reached the kernel");
        assert.match(serial, /Run \/init as init process/);
        assert.match(serial, /OpenxISO guest: Linux 6\.6\.\d+ on x86_64/);
    });

    await test("the emulated screen shows what the guest prints", async () => {
        const screen = await wait_for(page, "the guest's own output on tty1", () => {
            const element = document.querySelector("#screen_container .text-screen");
            const text = element ? element.textContent : "";
            return text.includes("openxiso:~#") ? text : false;
        }, 60000, diagnose);
        assert.match(screen, /64-bit x86 emulator/);
        assert.match(screen, /Run \/init as init process/);
    });

    await test("clicking the screen captures the mouse, like VirtualBox does", async () => {
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
        assert.equal(captured, true, "the click captured the pointer (pointer lock or virtual mouse)");
    });

    await test("the emulated keyboard types into the guest's console", async () => {
        // the shell on tty1 is the one on the emulated screen: whatever is typed
        // here has to come back as output from a real Linux userland
        await page.keyboard.type("uname -a\n");
        const screen = await wait_for(page, "uname to answer on the screen", () => {
            const element = document.querySelector("#screen_container .text-screen");
            const text = element ? element.textContent : "";
            return /Linux openxiso 6\.6\.\d+ .*x86_64 GNU\/Linux/.test(text) ? text : false;
        }, 60000, diagnose);
        assert.match(screen, /Linux openxiso 6\.6\.\d+/,
            "a real kernel release came back from the guest's own uname");
    });

    await test("the serial panel talks to the guest's shell", async () => {
        await page.evaluate(() => {
            document.getElementById("serial-input").value = "free | head -2";
            document.getElementById("serial-send").click();
        });
        const serial = await wait_for(page, "the serial shell to answer", () => {
            const text = window.OpenxISO.serial_text();
            return /Mem:\s+\d+/.test(text) ? text : false;
        }, 30000, diagnose);
        // the command itself is echoed by the guest's own line discipline
        assert.match(serial, /free \| head -2/);
        assert.match(serial, /Mem:\s+\d+/, "the guest reported its memory");
        assert.match(serial, /openxiso:~#/, "the guest keeps its prompt");
    });

    await test("the guest is a 64-bit long mode operating system", async () => {
        const answer = await page.evaluate(async () => {
            window.OpenxISO.state.machine.emulator.serial0_send("grep -m1 '^flags' /proc/cpuinfo\n");
            return true;
        });
        assert.ok(answer);
        const serial = await wait_for(page, "the CPU flags", () => {
            const text = window.OpenxISO.serial_text().slice(-4000);
            return /(^|\s)lm(\s|$)/m.test(text) ? text : false;
        }, 30000, diagnose);
        assert.match(serial, /(^|\s)lm(\s|$)/m, "long mode is visible to the guest");
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
            };
        });
        assert.equal(audio.has_speaker, true, "the speaker adapter exists");
        assert.equal(audio.has_pcspeaker, true, "the PC speaker is connected");
        assert.equal(audio.has_dac, true, "the sound card DAC is connected");
        assert.equal(audio.sb16, true, "the emulated Sound Blaster 16 exists");
    });

    await test("the guest's beep reaches the emulator's sound hardware", async () => {
        // the page listens to the engine directly: every frequency the emulated
        // PC speaker is programmed with lands in this array
        await page.evaluate(() => {
            window.__oid_tones = [];
            window.OpenxISO.state.machine.emulator.add_listener("pcspeaker-update",
                ([mode, reload]) => {
                    if (reload) {
                        window.__oid_tones.push(Math.round(1193182 / reload));
                    }
                });
        });
        await page.evaluate(() => {
            document.getElementById("serial-input").value = "beep";
            document.getElementById("serial-send").click();
        });
        const tones = await wait_for(page, "a tone on the PC speaker", () => {
            const tones = window.__oid_tones || [];
            return tones.some(hz => Math.abs(hz - 880) <= 5) ? tones : false;
        }, 30000, diagnose);
        assert.ok(tones.length > 0, "the speaker was programmed from inside the guest");
    });

    await test("a .hdd dropped on the window is attached to the machine", async () => {
        // a disk has to be there when the machine is created (the emulated IDE
        // controller has no hot plug), so: stop, drop the image, power on again
        await page.evaluate(() => document.getElementById("btn-stop").click());
        await wait_for(page, "the machine to stop", () => !window.OpenxISO.state.machine, 30000, diagnose);

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
            return machine.media.hda ? { name: machine.media.hda.name, storage: machine.media.hda.storage } : false;
        }, 60000, diagnose);
        assert.equal(attached.name, "long-mode-test.hdd");
        assert.equal(attached.storage, "browser", "the image is kept in the page, not uploaded");
    });

    await test("the guest boots with the disk and its own script finds it", async () => {
        await page.evaluate(() => document.getElementById("btn-start").click());
        const serial = await wait_for(page, "the guest to come up with the disk",
            () => {
                const text = window.OpenxISO.serial_text();
                return /Disk:\s+\/dev\/sda, \d+ MiB/.test(text) ? text : false;
            }, options.timeout * 1000, diagnose);
        assert.match(serial, /ata1: PATA max MWDMA2/, "the emulated PIIX3 IDE controller was found");
        assert.match(serial, /sd 0:0:0:0: \[sda\] 131072 512-byte logical blocks/,
            "the kernel sized the attached image itself");
        assert.match(serial, /Disk:\s+\/dev\/sda, 64 MiB/, "the guest reported the disk it booted with");
    });

    await test("the guest reads the disk image that was dropped on it", async () => {
        const image = fs.readFileSync(path.join(repo, "build", "emulator-tests", "long-mode-test.hdd"));
        const expected = crypto.createHash("md5").update(image.subarray(0, 2048)).digest("hex");
        await page.evaluate(() => {
            document.getElementById("serial-input").value =
                "dd if=/dev/sda bs=512 count=4 2>/dev/null | md5sum";
            document.getElementById("serial-send").click();
        });
        const serial = await wait_for(page, "the guest to hash the start of the disk", wanted => {
            const text = window.OpenxISO.serial_text();
            return text.includes(wanted) ? text : false;
        }, 60000, diagnose, expected);
        assert.ok(serial.includes(expected),
            "the first four sectors of the file came back through the emulated disk");
    });

    await test("the reset button brings the guest back", async () => {
        // the engine's warm restart kills the emulator on a machine that was
        // booted through the Linux boot protocol, so the app does a power cycle
        // (see the limitations in emulator/README.md): the guest has to come up
        // again, on the same disk
        const before = await page.evaluate(() => window.OpenxISO.serial_text().length);
        await page.evaluate(() => document.getElementById("btn-reset").click());
        await page.waitForSelector("dialog.dialog", { visible: true });
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll("dialog.dialog .dialog-footer .button"));
            const ok = buttons.find(button => button.textContent.trim() === "OK");
            (ok || buttons[buttons.length - 1]).click();
        });
        const serial = await wait_for(page, "the guest to boot again", length_before => {
            const all = window.OpenxISO.serial_text();
            // the serial panel is not cleared on a restart, so look at what came
            // after the click (and at everything if the panel was cleared)
            const text = all.length > length_before ? all.slice(length_before) : all;
            return /Disk:\s+\/dev\/sda, 64 MiB/.test(text) && /openxiso:~#/.test(text) ? text : false;
        }, options.timeout * 1000, diagnose, before);
        assert.match(serial, /Run \/init as init process/,
            "the guest went through a whole boot again");
        assert.match(serial, /Disk:\s+\/dev\/sda, 64 MiB/, "the disk is still attached");
    });

    await test("the status bar follows the machine", async () => {
        // the status bar is repainted on a timer, so it can still show the
        // state a reset went through; wait for it to catch up
        const status = await wait_for(page, "the status bar to show the running machine", () => {
            const state = document.getElementById("status-state").textContent;
            return /Работает/.test(state) ? state : false;
        }, 30000, diagnose);
        assert.match(status, /Работает/);
        const machine = await page.evaluate(() =>
            document.getElementById("status-machine").textContent);
        assert.match(machine, /Демонстрация/);
    });

    await test("a CD boot starts the same Linux on a bare machine", async () => {
        // the app's own path for a CD: ?demo=cd attaches
        // emulator/images/linux-6.6-x86_64.iso, SeaBIOS reads the El Torito
        // entry from it and the loader in that entry starts the kernel - no
        // kernel image and no command line are handed to the engine at all
        await page.goto(`http://127.0.0.1:${running.port}/emulator/index.html?nosw&demo=cd`,
            { waitUntil: "domcontentloaded" });
        const media = await wait_for(page, "the CD to be attached", () => {
            // the machines of the earlier checks are still in the list, so
            // find the demo machine by the CD it carries
            const machine = window.OpenxISO.state.machines.find(candidate =>
                candidate.media.cdrom && candidate.media.cdrom.name === "linux-6.6-x86_64.iso");
            if (!machine || !machine.media.kernel) {
                return machine ? { name: machine.media.cdrom.name,
                    storage: machine.media.cdrom.storage } : false;
            }
            return false;
        }, 60000, diagnose);
        assert.equal(media.name, "linux-6.6-x86_64.iso");
        assert.equal(media.storage, "url", "the CD is streamed from the server");
        const serial = await wait_for(page, "the CD to boot the kernel",
            () => window.OpenxISO.serial_text().includes("openxiso:~#") ?
                window.OpenxISO.serial_text() : false, options.timeout * 1000, diagnose);
        assert.match(serial, /openxiso linux boot loader/,
            "the loader in the CD's first block ran");
        assert.match(serial, /Command line: .*console=ttyS0,115200 ro/,
            "the kernel got the command line from the loader");
        assert.match(serial, /CD:     \/dev\/sr0 mounted on \/mnt\/cdrom/,
            "the guest mounted the CD it booted from");
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
