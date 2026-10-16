#!/usr/bin/env node
/*
 * Boots the test images from build/emulator-tests/ through the emulator engine
 * and checks that the guest really reaches 64-bit long mode.
 *
 * The guest (emulator/tests/boot64.S) switches the CPU into long mode itself,
 * runs 64-bit arithmetic with REX.W instructions and r8-r15, prints over COM1,
 * writes a banner into the VGA text buffer and beeps the PC speaker. On top of
 * that the interrupt build installs an IDT, remaps the PIC, programs the PIT
 * and the PS/2 controller and reports what the timer, the keyboard and the
 * mouse delivered, while the graphics build drives the Bochs VBE interface and
 * the linear framebuffer. This test fails if the 64-bit core, the BIOS, the
 * IDE controller, the display, the timers, the PS/2 controller or the media
 * backend (the code that streams an image into the emulator) break.
 *
 * Run it with:
 *     python3 emulator/tests/make_test_images.py
 *     node emulator/tests/boot_test.mjs
 *
 * Options: --iso PATH, --hdd PATH, --gfx PATH, --wasm PATH, --timeout SECONDS,
 *          --verbose
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { BlobBuffer, format_bytes } from "../js/media.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));
const vendor = path.join(here, "..", "vendor", "v86_64");

const BOOT_ORDER_CD_FIRST = 0x123;
const BOOT_ORDER_HD_FIRST = 0x312;

const EXPECTED = [
    "v86-64 test: bios boot ok",
    "v86-64 test: entering protected mode",
    "v86-64 test: protected mode ok",
    "v86-64 test: entering long mode",
    "v86-64 test: long mode ok",
    "v86-64 test: sum=edcba9777777778f nibble=e low=000000007777778f",
    "v86-64 test: done",
];

/* The interrupt build installs an IDT, remaps the PIC and waits two seconds for
 * PIT ticks, so it also proves that timer interrupts reach the 64-bit guest. */
const EXPECTED_IRQ = [
    ...EXPECTED.slice(0, 6),
    "v86-64 test: irq test ready",
    "v86-64 test: irq keyboard=",
    "v86-64 test: done",
];

const COUNTERS = /irq keyboard=([0-9a-f]{16}) mouse=([0-9a-f]{16}) ticks=([0-9a-f]{16})/;

const EXPECTED_GRAPHICS = [
    "v86-64 test: bios boot ok",
    "v86-64 test: entering protected mode",
    "v86-64 test: protected mode ok",
    "v86-64 test: entering long mode",
    "v86-64 test: long mode ok",
    // the framebuffer is found through the PCI BAR of the VGA device
    "v86-64 test: pci bar0=e0000008",
    "v86-64 test: framebuffer at 00000000e0000000",
    // and the three colour bands can be read back through the linear mapping
    "v86-64 test: framebuffer read back 0000000000ff0000,000000000000ff00,00000000000000ff",
    "v86-64 test: graphics ok 640x480x32",
    "v86-64 test: done",
];

const VGA_BANNER = "64-bit long mode ok";

function parse_args(argv) {
    const options = {
        iso: path.join(repo, "build", "emulator-tests", "long-mode-test.iso"),
        hdd: path.join(repo, "build", "emulator-tests", "long-mode-test.hdd"),
        gfx: path.join(repo, "build", "emulator-tests", "long-mode-gfx-test.iso"),
        wasm: path.join(vendor, "v86.wasm"),
        timeout: 120,
        verbose: false,
    };
    for (let i = 0; i < argv.length; i++) {
        switch (argv[i]) {
            case "--iso": options.iso = argv[++i]; break;
            case "--hdd": options.hdd = argv[++i]; break;
            case "--gfx": options.gfx = argv[++i]; break;
            case "--wasm": options.wasm = argv[++i]; break;
            case "--timeout": options.timeout = +argv[++i]; break;
            case "--verbose": options.verbose = true; break;
            default: throw new Error("unknown option " + argv[i]);
        }
    }
    return options;
}

/**
 * Boot one image and collect what the guest printed over COM1 and on the
 * emulated text screen.
 *
 * @param {{name: string, cdrom?: BlobBuffer, hda?: BlobBuffer, boot_order: number}} config
 */
async function boot(config, options) {
    const { V86 } = await import(url.pathToFileURL(path.join(vendor, "libv86.mjs")).href);

    const serial = [];
    const screen = new Map();
    let beep = null;
    let started = false;

    const emulator = new V86({
        wasm_path: options.wasm,
        bios: { url: path.join(vendor, "seabios.bin") },
        vga_bios: { url: path.join(vendor, "vgabios.bin") },
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        acpi: true,
        cdrom: config.cdrom,
        hda: config.hda,
        boot_order: config.boot_order,
        autostart: true,
    });

    emulator.add_listener("emulator-started", () => { started = true; });
    emulator.add_listener("serial0-output-byte", byte => {
        if (options.verbose) {
            process.stdout.write(String.fromCharCode(byte));
        }
        serial.push(String.fromCharCode(byte));
    });
    emulator.add_listener("screen-put-char", ([row, col, chr]) => {
        screen.set(row * 256 + col, String.fromCharCode(chr));
    });
    emulator.add_listener("pcspeaker-enable", () => { beep = beep || { enabled: true }; });
    emulator.add_listener("pcspeaker-update", ([mode, reload]) => {
        // 1193182 Hz / reload, the frequency a real speaker would play.
        const frequency = mode === 3 ? Math.round(1193182 / reload) : 0;
        beep = { enabled: true, mode: mode, reload: reload, frequency: frequency };
    });

    const text = () => serial.join("");
    const deadline = Date.now() + options.timeout * 1000;

    while (Date.now() < deadline) {
        if (text().includes("v86-64 test: done") || text().includes("failed")) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Give the VGA device a moment to render the finished screen.
    await new Promise(resolve => setTimeout(resolve, 500));

    const rows = [];
    for (let row = 0; row < 25; row++) {
        let line = "";
        for (let col = 0; col < 80; col++) {
            line += screen.get(row * 256 + col) || " ";
        }
        rows.push(line.trimEnd());
    }

    const result = {
        output: text(),
        screen: rows.join("\n").trimEnd(),
        beep,
        started,
        media: Object.values(config).filter(value => value instanceof BlobBuffer),
    };

    emulator.destroy();
    return result;
}

async function main() {
    const options = parse_args(process.argv.slice(2));
    let failures = 0;

    for (const file of [options.iso, options.hdd, options.gfx, options.wasm]) {
        if (!fs.existsSync(file)) {
            console.error(`error: ${file} is missing`);
            if (file.includes("emulator-tests")) {
                console.error("hint: run python3 emulator/tests/make_test_images.py first");
            }
            process.exit(2);
        }
    }

    const cases = [
        {
            name: "CD-ROM (ISO9660 / El Torito)",
            boot_order: BOOT_ORDER_CD_FIRST,
            expect: EXPECTED_IRQ,
            media: async () => ({
                cdrom: new BlobBuffer(await fs.openAsBlob(options.iso), { name: "long-mode-test.iso" }),
            }),
        },
        {
            name: "hard disk (raw .hdd image)",
            boot_order: BOOT_ORDER_HD_FIRST,
            expect: EXPECTED_IRQ,
            media: async () => ({
                hda: new BlobBuffer(await fs.openAsBlob(options.hdd), { name: "long-mode-test.hdd" }),
            }),
        },
        {
            name: "graphics (Bochs VBE, 640x480x32 framebuffer)",
            boot_order: BOOT_ORDER_CD_FIRST,
            expect: EXPECTED_GRAPHICS,
            graphics: true,
            media: async () => ({
                cdrom: new BlobBuffer(await fs.openAsBlob(options.gfx), { name: "long-mode-gfx-test.iso" }),
            }),
        },
    ];

    for (const test of cases) {
        const media = await test.media();
        process.stdout.write(`boot from ${test.name}: `);

        let result;
        try {
            result = await boot({ ...test, ...media }, options);
        } catch (error) {
            console.log("FAIL");
            console.error("  " + (error && error.stack || error));
            failures++;
            continue;
        }

        const problems = [];
        for (const line of test.expect || EXPECTED) {
            if (!result.output.includes(line)) {
                problems.push(`missing serial output: ${JSON.stringify(line)}`);
            }
        }
        for (const fault of ["page fault at", "general protection fault", "unexpected exception"]) {
            if (result.output.includes(fault)) {
                problems.push(`the guest raised an exception: ${fault}`);
            }
        }
        if (!result.started) {
            problems.push("the emulator never started");
        }
        if (!test.graphics && !result.screen.includes(VGA_BANNER)) {
            problems.push(`the screen does not show "${VGA_BANNER}":\n${result.screen}`);
        }
        if (!result.beep) {
            problems.push("the PC speaker never beeped");
        }
        if (test.expect === EXPECTED_IRQ) {
            // the guest waited for 200 ticks at 100 Hz and nothing was typed on
            // it, so the counters have to be exactly zero
            const counters = COUNTERS.exec(result.output);
            if (!counters) {
                problems.push("the guest never reported its interrupt counters");
            } else {
                const [, keyboard, mouse, ticks] = counters;
                if (keyboard !== "0000000000000000" || mouse !== "0000000000000000") {
                    problems.push(`input arrived out of nowhere: keyboard=${keyboard} mouse=${mouse}`);
                }
                const ticks_number = parseInt(ticks, 16);
                if (ticks_number < 200) {
                    problems.push(`the PIT delivered ${ticks_number} ticks, expected at least 200`);
                }
            }
        }
        for (const file of result.media) {
            if (!file.bytes_read) {
                problems.push(`nothing was read from ${file.name}`);
            }
        }

        if (problems.length) {
            console.log("FAIL");
            for (const problem of problems) {
                console.error("  " + problem);
            }
            console.error("  serial output was: " + JSON.stringify(result.output));
            failures++;
        } else {
            const reads = result.media
                .map(file => `${file.name}: ${format_bytes(file.bytes_read)} in ${file.read_requests} read(s)`)
                .join(", ");
            const speaker = result.beep.frequency ? `, beep at ${result.beep.frequency} Hz` : "";
            const counters = COUNTERS.exec(result.output);
            const interrupts = counters ? `, ${parseInt(counters[3], 16)} timer ticks` : "";
            console.log(`ok (${reads}${speaker}${interrupts})`);
        }
    }

    if (failures) {
        console.error(`\n${failures} test(s) failed`);
        process.exit(1);
    }
    console.log("\nall boot tests passed: the guest reaches 64-bit long mode");
}

const is_main = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
if (is_main) {
    await main();
}

export { boot, EXPECTED };
