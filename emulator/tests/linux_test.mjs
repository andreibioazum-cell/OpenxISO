#!/usr/bin/env node
/*
 * Boots a *real* Linux kernel in the emulator and checks that it comes up all
 * the way into a BusyBox userland, on both consoles, and that the guest takes
 * input over the emulated serial port.
 *
 * The kernel is emulator/images/linux-6.6-x86_64.bzImage: Linux 6.6 for x86-64
 * with a BusyBox initramfs built into the image (see emulator/images/README.md
 * and tools/linux-guest/build.py). The engine loads it through the Linux boot
 * protocol, so no BIOS, boot sector or disk image is involved - the machine
 * boots a 64-bit Linux kernel from a single file.
 *
 *     node emulator/tests/linux_test.mjs
 *
 * Options: --kernel PATH, --cmdline TEXT, --timeout SECONDS, --verbose,
 *          --keep-vga (print the whole text screen at the end).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(here));
const vendor = path.join(here, "..", "vendor", "v86_64");

const DEFAULTS = {
    kernel: path.join(here, "..", "images", "linux-6.6-x86_64.bzImage"),
    cmdline: "console=tty0 console=ttyS0,115200",
    timeout: 180,
    verbose: false,
    keep_vga: false,
};

function parse_args(argv) {
    const options = { ...DEFAULTS };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--verbose") {
            options.verbose = true;
        } else if (arg === "--keep-vga") {
            options.keep_vga = true;
        } else if (arg === "--kernel") {
            options.kernel = argv[++index];
        } else if (arg === "--cmdline") {
            options.cmdline = argv[++index];
        } else if (arg === "--timeout") {
            options.timeout = Number(argv[++index]);
        } else if (arg === "--help") {
            console.log("usage: linux_test.mjs [--kernel PATH] [--cmdline TEXT] [--timeout SECONDS]");
            process.exit(0);
        } else {
            console.error(`error: unknown option ${arg}`);
            process.exit(2);
        }
    }
    return options;
}

/** What the guest must print for the boot to count as complete. */
const BOOT_MARKERS = [
    ["the kernel banner", /Linux version 6\.6\.\d+/],
    // the compiler and linker that built the kernel are part of the banner:
    // an image whose configuration lost CONFIG_CC_VERSION_TEXT prints "()"
    // here, which is how a build from a half-written .config is spotted
    ["the compiler that built the kernel", /Linux version 6\.6\.\d+ \([^)]*\) \(gcc/],
    ["the command line the machine passed", /Command line: .*console=ttyS0/],
    ["the memory map", /BIOS-provided physical RAM map/],
    ["the serial port", /serial8250: ttyS0 at I\/O 0x3f8 \(irq = 4/],
    ["the PS\/2 controller", /input: AT Translated Set 2 keyboard/],
    ["the VGA text console", /Console: colour VGA\+ 80x25/],
    ["the long mode page tables", /Memory: \d+K\/\d+K available/],
    ["the jump into userland", /Run \/init as init process/],
    ["the busybox initramfs", /OpenxISO guest: Linux 6\.6\.\d+ on x86_64/],
    ["a shell on COM1", /openxiso:~#/],
];

/** Command -> what the busybox shell must answer. */
const COMMANDS = [
    ["uname -a", /Linux openxiso 6\.6\.\d+ .* x86_64 GNU\/Linux/],
    ["echo openxiso-64", /openxiso-64/],
    ["ls /bin/busybox", /\/bin\/busybox/],
    ["cat /proc/version", /^Linux version 6\.6\.\d+ \(/m],
    ["echo $((6 * 7))", /^42$/m],
    ["free", /Mem:/],
    // "lm" in the CPU flags is the guest's own confirmation that the CPU the
    // emulator presents is a 64-bit long mode one: a 32-bit guest cannot see it
    ["grep -m1 '^flags' /proc/cpuinfo", /(^|\s)lm(\s|$)/m],
    ["ls /dev/ttyS0", /\/dev\/ttyS0/],
    ["ls /dev/input", /event0/],
    ["beep 440 150", /beep: 440 Hz for 150 ms through \/dev\/input\/event0/],
];

async function main() {
    const options = parse_args(process.argv.slice(2));
    const kernel = fs.readFileSync(options.kernel);
    console.log(`kernel:  ${options.kernel} (${kernel.length} bytes)`);
    console.log(`cmdline: ${options.cmdline}\n`);

    const { V86 } = await import(url.pathToFileURL(path.join(vendor, "libv86.mjs")).href);

    const serial = [];
    const screen = new Map();

    /** Every frequency (Hz) the guest asked the emulated PC speaker for. */
    const tones = [];

    const emulator = new V86({
        wasm_path: path.join(vendor, "v86.wasm"),
        bios: { url: path.join(vendor, "seabios.bin") },
        vga_bios: { url: path.join(vendor, "vgabios.bin") },
        bzimage: new Uint8Array(kernel),
        cmdline: options.cmdline,
        memory_size: 512 * 1024 * 1024,
        vga_memory_size: 8 * 1024 * 1024,
        acpi: true,
        autostart: true,
    });

    emulator.add_listener("serial0-output-byte", byte => {
        const char = String.fromCharCode(byte);
        serial.push(char);
        if (options.verbose) {
            process.stdout.write(char);
        }
    });
    emulator.add_listener("screen-put-char", ([row, col, chr]) => {
        screen.set(row * 256 + col, String.fromCharCode(chr));
    });
    // the PC speaker is programmed through the 8253: 1193182 Hz / reload
    emulator.add_listener("pcspeaker-update", ([mode, reload]) => {
        if (reload) {
            tones.push(Math.round(1193182 / reload));
        }
    });

    const text = () => serial.join("");
    const deadline = Date.now() + options.timeout * 1000;

    /**
     * Wait until the guest printed `pattern`, without spinning the CPU faster
     * than 50 times a second.
     */
    async function wait_for(what, pattern, timeout = 60) {
        const until = Date.now() + timeout * 1000;
        while (Date.now() < until) {
            if (pattern.test(text())) {
                return true;
            }
            if (/Kernel panic|not syncing/.test(text())) {
                throw new Error(`the kernel panicked while waiting for ${what}`);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`timed out after ${timeout}s waiting for ${what}`);
    }

    let failures = 0;
    const check = async (name, fn) => {
        try {
            await fn();
            console.log(`  ok   ${name}`);
        } catch (error) {
            failures++;
            console.log(`  FAIL ${name}: ${error.message}`);
        }
    };

    console.log("booting Linux in the emulator");
    await check("the guest boots to a shell", async () => {
        await wait_for("the shell prompt", /openxiso:~#/, options.timeout);
    });

    for (const [name, pattern] of BOOT_MARKERS) {
        await check(`${name}: ${pattern.source.slice(0, 46)}`, async () => {
            assert.match(text(), pattern);
        });
    }

    await check("no kernel panic", async () => {
        assert.doesNotMatch(text(), /Kernel panic/);
    });

    console.log("\ntalking to the guest over the serial port");
    for (const [command, expected] of COMMANDS) {
        await check(`"${command}" answers`, async () => {
            const before = text().length;
            emulator.serial0_send(command + "\n");
            const until = Date.now() + 20000;
            while (Date.now() < until) {
                const answer = text().slice(before);
                if (expected.test(answer)) {
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error(`the shell did not answer ${expected}`);
        });
    }

    console.log("\nsound");

    await check("the guest plays a tone on the emulated PC speaker", async () => {
        emulator.serial0_send("beep\n");
        const until = Date.now() + 20000;
        while (Date.now() < until) {
            // beep's default is 880 Hz; the driver programs the timer with a
            // divisor, so the frequency the emulator computes is a rounded one
            if (tones.some(hz => Math.abs(hz - 880) <= 5)) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`the speaker stayed quiet; it saw ${JSON.stringify(tones)}`);
    });

    console.log("\nchecking that the guest is still healthy");

    await check("the guest left no crash behind", async () => {
        assert.doesNotMatch(text(), /Kernel panic|not syncing|Call Trace:|Unable to handle kernel|Badness at/);
    });

    await check("the guest still answers on COM1", async () => {
        const before = text().length;
        emulator.serial0_send("echo still-here\n");
        const until = Date.now() + 20000;
        while (Date.now() < until) {
            if (text().slice(before).includes("still-here")) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("the guest stopped answering");
    });

    const rows = [];
    for (let row = 0; row < 25; row++) {
        let line = "";
        for (let col = 0; col < 80; col++) {
            line += screen.get(row * 256 + col) || " ";
        }
        rows.push(line.trimEnd());
    }
    const vga = rows.join("\n").trimEnd();

    await check("the VGA text screen shows the guest", async () => {
        // the boot log has scrolled past by now, so look for what the guest
        // prints when it comes up: the init banner, the shell's motd and its
        // prompt, all of which are on tty1
        assert.match(vga, /Run \/init as init process/);
        assert.match(vga, /64-bit x86 emulator/);
        assert.match(vga, /openxiso:~#/);
    });

    if (options.keep_vga || options.verbose) {
        console.log("\n======== VGA text screen ========");
        console.log(vga);
        console.log("=================================");
    }

    emulator.destroy();
    console.log(failures ? `\n${failures} failed` : "\nall checks passed");
    process.exit(failures ? 1 : 0);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
