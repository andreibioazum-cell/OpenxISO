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
 * The machine can also have images attached to it. By default the test attaches
 * the two images make_test_images.py generates (build/emulator-tests): the
 * 64 MiB .hdd on the emulated IDE controller and the ISO on the emulated
 * CD-ROM. That is the whole disk path a user gets from the app's file picker:
 * the engine's IDE controller -> pata_legacy in the guest -> /dev/sda and
 * /dev/sr0 -> dd, md5sum, mkfs.ext2 and mount in the guest's shell.
 *
 *     node emulator/tests/linux_test.mjs
 *
 * Options: --kernel PATH, --cmdline TEXT, --timeout SECONDS, --verbose,
 *          --hda PATH, --cdrom PATH, --no-disks (boot with nothing attached),
 *          --keep-vga (print the whole text screen at the end).
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    hda: null,
    cdrom: null,
    no_disks: false,
};

/** Where make_test_images.py puts the images this test attaches by default. */
const TEST_IMAGES = path.join(repo, "build", "emulator-tests");

function parse_args(argv) {
    const options = { ...DEFAULTS };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--verbose") {
            options.verbose = true;
        } else if (arg === "--keep-vga") {
            options.keep_vga = true;
        } else if (arg === "--no-disks") {
            options.no_disks = true;
        } else if (arg === "--kernel") {
            options.kernel = argv[++index];
        } else if (arg === "--cmdline") {
            options.cmdline = argv[++index];
        } else if (arg === "--hda") {
            options.hda = argv[++index];
        } else if (arg === "--cdrom") {
            options.cdrom = argv[++index];
        } else if (arg === "--timeout") {
            options.timeout = Number(argv[++index]);
        } else if (arg === "--help") {
            console.log("usage: linux_test.mjs [--kernel PATH] [--cmdline TEXT] [--timeout SECONDS]" +
                " [--hda PATH] [--cdrom PATH] [--no-disks]");
            process.exit(0);
        } else {
            console.error(`error: unknown option ${arg}`);
            process.exit(2);
        }
    }
    return options;
}

/** The generated test image of that name, or null when it is not there. */
function test_image(name) {
    const candidate = path.join(TEST_IMAGES, name);
    return fs.existsSync(candidate) ? candidate : null;
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

    // the disk side of the machine: a .hdd on the emulated IDE controller and
    // an ISO on the emulated CD-ROM, both written by make_test_images.py
    if (!options.no_disks) {
        options.hda = options.hda || test_image("long-mode-test.hdd");
        options.cdrom = options.cdrom || test_image("long-mode-test.iso");
    }

    /** An exact sized ArrayBuffer, which is what v86 takes for {buffer}. */
    const read_image = file => new Uint8Array(fs.readFileSync(file)).buffer;

    const label = name => (name + ":").padEnd(9);
    console.log(label("kernel") + `${options.kernel} (${kernel.length} bytes)`);
    console.log(label("cmdline") + options.cmdline);
    console.log(label("hda") + (options.hda ?
        `${options.hda} (${fs.statSync(options.hda).size} bytes)` : "nothing attached"));
    console.log(label("cdrom") + (options.cdrom ?
        `${options.cdrom} (${fs.statSync(options.cdrom).size} bytes)` : "nothing attached"));
    console.log("");

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
        hda: options.hda ? { buffer: read_image(options.hda) } : undefined,
        cdrom: options.cdrom ? { buffer: read_image(options.cdrom) } : undefined,
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

    /**
     * Run a command in the guest's shell and return what it printed.
     *
     * The shell echoes the command line over the same line, so the answer is
     * bracketed with two markers and the *last* opening marker is the one the
     * shell printed itself (the first one is the echo of the command).
     */
    let counter = 0;
    async function question(command, timeout = 30000) {
        // the markers are built with printf so that the line the shell echoes
        // back (which is the command itself) cannot contain the finished
        // marker: only the guest's own output can
        const tag = `q${(counter++).toString(36)}x${process.pid}`;
        const open = `OID-L${tag}-R`;
        const close = `OID-X${tag}-Y`;
        const before = text().length;
        emulator.serial0_send("printf 'OID-L%s-R\\n' " + tag + "; " + command +
            "; printf 'OID-X%s-Y\\n' " + tag + "\n");
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            const answer = text().slice(before);
            const from = answer.indexOf(open);
            const to = answer.indexOf(close, from + open.length);
            if (from >= 0 && to > from) {
                return answer.slice(from + open.length, to).replace(/\r/g, "").trim();
            }
            if (/Kernel panic|not syncing/.test(text())) {
                throw new Error(`the kernel panicked while running "${command}"`);
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`the guest did not run "${command}"`);
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

    console.log("\nthe attached hard disk image");

    if (options.hda) {
        const image = fs.readFileSync(options.hda);
        const md5 = bytes => crypto.createHash("md5").update(bytes).digest("hex");
        const expected_sectors = image.length / 512;

        await check("the guest sees the .hdd as /dev/sda, with the size of the file", async () => {
            const size = await question("cat /sys/block/sda/size");
            assert.equal(Number(size.trim()), expected_sectors,
                "the kernel reports the disk in 512 byte sectors");
            const partitions = await question("cat /proc/partitions");
            assert.match(partitions, /^\s*\d+\s+\d+\s+\d+\s+sda$/m, "the disk is a block device");
        });

        await check("the guest reads the host's image byte for byte", async () => {
            const answer = await question("dd if=/dev/sda bs=512 count=4 2>/dev/null | md5sum");
            assert.equal(answer.split(/\s+/)[0], md5(image.subarray(0, 2048)),
                "the first four sectors came back exactly as they are in the file");
        });

        await check("the guest writes to the disk at the offset it was told to", async () => {
            await question("dd if=/dev/zero of=/dev/sda bs=512 seek=2048 count=8 " +
                "conv=notrunc 2>/dev/null; sync");
            const written = await question("dd if=/dev/sda bs=512 skip=2048 count=8 " +
                "2>/dev/null | md5sum");
            assert.equal(written.split(/\s+/)[0], md5(Buffer.alloc(8 * 512)),
                "the sectors that were written read back as zero");
            const untouched = await question("dd if=/dev/sda bs=512 count=4 2>/dev/null | md5sum");
            assert.equal(untouched.split(/\s+/)[0], md5(image.subarray(0, 2048)),
                "the sectors that were not written are still the ones from the file");
        });

        await check("the guest formats the disk, mounts it and reads its file back", async () => {
            await question("mkfs.ext2 -qF /dev/sda 2>&1; sync", 180000);
            const answer = await question(
                "mkdir -p /mnt/d; mount /dev/sda /mnt/d && " +
                "echo openxiso-disk-ok > /mnt/d/proof.txt && sync && umount /mnt/d && " +
                "mount /dev/sda /mnt/d && cat /mnt/d/proof.txt", 120000);
            assert.match(answer, /openxiso-disk-ok/,
                "a file written through the ext2 filesystem came back from it");
            const usage = await question("df /mnt/d | tail -n 1");
            assert.match(usage, /\/mnt\/d/, "the filesystem is mounted inside the guest");
        });

        await check("the file on the host is untouched (the guest writes to the emulator's copy)", async () => {
            const again = fs.readFileSync(options.hda);
            assert.equal(again.length, image.length, "the image size did not change");
            assert.equal(md5(again.subarray(0, 2048)), md5(image.subarray(0, 2048)),
                "not a byte of the disk image on the host was modified");
        });

        await check("the guest's writes can be taken out of the machine and booted again", async () => {
            // the engine holds the modified image in the disk buffer, and this
            // is the same buffer the app's "save the image" button hands back
            const modified = await new Promise(resolve => {
                emulator.v86.cpu.devices.ide.primary.master.buffer.get_buffer(resolve);
            });
            assert.ok(modified && modified.byteLength === image.length,
                "the whole image can be read back out of the machine");

            // boot a second machine with those bytes: if they are really the
            // filesystem the guest formatted, its own boot script finds the
            // filesystem on the disk and mounts it without being asked
            const second = new V86({
                wasm_path: path.join(vendor, "v86.wasm"),
                bios: { url: path.join(vendor, "seabios.bin") },
                vga_bios: { url: path.join(vendor, "vgabios.bin") },
                bzimage: new Uint8Array(kernel),
                cmdline: options.cmdline,
                hda: { buffer: modified },
                memory_size: 512 * 1024 * 1024,
                vga_memory_size: 8 * 1024 * 1024,
                acpi: true,
                autostart: true,
            });
            const log = [];
            second.add_listener("serial0-output-byte", byte => log.push(String.fromCharCode(byte)));
            const booted = () => {
                const text = log.join("").replace(/\r/g, "");
                return /openxiso:~#/.test(text) ? text : null;
            };
            let text = null;
            const until = Date.now() + 180000;
            while (Date.now() < until && !(text = booted())) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            second.destroy();
            assert.ok(text, "the second machine came up");
            assert.match(text, new RegExp(`Disk:\\s+/dev/sda, ${image.length >> 20} MiB`),
                "it reported the disk it was given");
            assert.match(text, /mounted on \/mnt\/disk, read-write/,
                "the filesystem the first machine created was mounted by itself");
            assert.match(text, /proof\.txt/, "and its contents are there");
        });
    } else {
        console.log("  (no .hdd attached; build/emulator-tests has one: run make_test_images.py)");
    }

    if (options.cdrom) {
        await check("the guest mounts the ISO from the emulated CD-ROM", async () => {
            const answer = await question(
                "mkdir -p /mnt/cd; mount -t iso9660 -o ro /dev/sr0 /mnt/cd && ls /mnt/cd", 60000);
            assert.match(answer, /readme\.txt/i, "the ISO's root directory is readable");
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
        // by now the boot log has scrolled off the screen, so what has to be
        // there is what the guest prints when it comes up: the motd and the
        // prompt of the shell on tty1 (the boot log itself is checked above,
        // on the serial console)
        assert.match(vga, /64-bit x86 emulator/);
        assert.match(vga, /guest: Linux on x86_64/);
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
