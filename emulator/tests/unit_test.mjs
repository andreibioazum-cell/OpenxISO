#!/usr/bin/env node
/*
 * Unit tests for the parts of the emulator app that do not need a browser:
 * the image backend, the store, the machine model, the keyboard mapping and
 * the file helpers.
 *
 *     node emulator/tests/unit_test.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));

const { BlobBuffer, blank_image, parse_size, format_bytes } = await import(
    url.pathToFileURL(path.join(here, "..", "js", "media.js")).href);
const { MemoryBackend, new_id } = await import(
    url.pathToFileURL(path.join(here, "..", "js", "store.js")).href);
const machine_module = await import(
    url.pathToFileURL(path.join(here, "..", "js", "machine.js")).href);
const keyboard = await import(
    url.pathToFileURL(path.join(here, "..", "js", "keyboard.js")).href);
const files = await import(
    url.pathToFileURL(path.join(here, "..", "js", "files.js")).href);
const { SerialConsole } = await import(
    url.pathToFileURL(path.join(here, "..", "js", "serial.js")).href);

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {function(): (void|Promise<void>)} body
 */
async function test(name, body) {
    try {
        await body();
        passed++;
        console.log("  ok   " + name);
    } catch (error) {
        failed++;
        console.log("  FAIL " + name);
        console.log("       " + (error && error.stack || error).split("\n").join("\n       "));
    }
}

function section(title) {
    console.log("\n" + title);
}

/* ------------------------------------------------------------------- media */

section("image backend (media.js)");

await test("a BlobBuffer reads the whole image through 256 byte blocks", async () => {
    const data = new Uint8Array(64 * 1024);
    for (let i = 0; i < data.length; i++) {
        data[i] = i & 0xff;
    }
    const buffer = new BlobBuffer(new Blob([data]));
    assert.equal(buffer.byteLength, data.length);

    const block = await new Promise(resolve => buffer.get(1024, 512, resolve));
    assert.equal(block.length, 512);
    for (let i = 0; i < 512; i++) {
        assert.equal(block[i], (1024 + i) & 0xff);
    }

    // reads are cached: the second one does not touch the file again
    const requests = buffer.read_requests;
    await new Promise(resolve => buffer.get_and_cache(2048, 256, resolve));
    await new Promise(resolve => buffer.get_and_cache(2048, 256, resolve));
    assert.equal(buffer.read_requests, requests + 1);
});

await test("a BlobBuffer keeps guest writes in an overlay", async () => {
    const buffer = new BlobBuffer(new Blob([new Uint8Array(4096)]));
    const written = new Uint8Array(256).fill(0xab);
    await new Promise(resolve => buffer.set(512, written, resolve));

    assert.equal(buffer.has_changes, true);
    assert.equal(buffer.dirty_bytes, 256);

    const read_back = await new Promise(resolve => buffer.get(512, 256, resolve));
    assert.deepEqual(Array.from(read_back), Array.from(written));

    // the original bytes are still there after the written block
    const untouched = await new Promise(resolve => buffer.get(768, 256, resolve));
    assert.ok(untouched.every(value => value === 0));

    const exported = new Uint8Array(await buffer.export_blob().arrayBuffer());
    assert.equal(exported.length, 4096);
    assert.equal(exported[512], 0xab);
    assert.equal(exported[767], 0xab);
    assert.equal(exported[768], 0);
});

await test("a BlobBuffer survives save and restore of its state", async () => {
    const buffer = new BlobBuffer(new Blob([new Uint8Array(1024)]));
    await new Promise(resolve => buffer.set(0, new Uint8Array(256).fill(7), resolve));
    const state = buffer.get_state();

    const other = new BlobBuffer(new Blob([new Uint8Array(1024)]));
    other.set_state(state);
    const read_back = await new Promise(resolve => other.get(0, 256, resolve));
    assert.ok(read_back.every(value => value === 7));
});

await test("a read that is cancelled calls back with an empty block", async () => {
    const buffer = new BlobBuffer(new Blob([new Uint8Array(256 * 1024)]));
    const controller = new AbortController();
    controller.abort();
    const result = await new Promise(resolve =>
        buffer.get(0, 512, resolve, { signal: controller.signal }));
    assert.equal(result.length, 512);
    assert.ok(result.every(value => value === 0));
});

await test("blank_image() creates a sparse image of the right size", async () => {
    const blob = blank_image(5 * 1024 * 1024);
    assert.equal(blob.size, 5 * 1024 * 1024);
    const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    assert.ok(head.every(value => value === 0));
});

await test("sizes are formatted and parsed", () => {
    assert.equal(parse_size("512M"), 512 * 1024 * 1024);
    assert.equal(parse_size("2 GiB"), 2 * 1024 ** 3);
    assert.equal(parse_size("1024"), 1024);
    assert.equal(format_bytes(1536), "1.5 KiB");
    assert.equal(format_bytes(0), "0 B");
});

/* ------------------------------------------------------------------- store */

section("store and machine model");

await test("the in-memory store keeps machines, images and states", async () => {
    const store = new MemoryBackend();
    const machine = machine_module.create_machine({ name: "test" });
    await store.put("machines", machine);

    assert.equal((await store.get_all("machines")).length, 1);
    assert.equal((await store.get("machines", machine.id)).name, "test");
    assert.equal(await store.count("machines"), 1);

    await store.delete("machines", machine.id);
    assert.equal(await store.count("machines"), 0);
});

await test("ids are unique", () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
        ids.add(new_id("vm-"));
    }
    assert.equal(ids.size, 200);
});

await test("a new machine has usable defaults", () => {
    const machine = machine_module.create_machine();
    assert.equal(machine.system.memory_mb, 512);
    assert.equal(machine.system.boot_order, "cd");
    assert.equal(machine_module.boot_order_value(machine), 0x123);
    assert.equal(machine_module.needs_memory64(machine), false);
    assert.equal(machine_module.attached_media(machine).length, 0);
});

await test("a patch is merged into the machine without losing the rest", () => {
    const machine = machine_module.create_machine();
    machine_module.merge_machine(machine, {
        name: "Ubuntu",
        system: { memory_mb: 2048 },
        media: { cdrom: { id: "media-1", name: "ubuntu.iso", size: 100 } },
    });
    assert.equal(machine.name, "Ubuntu");
    assert.equal(machine.system.memory_mb, 2048);
    assert.equal(machine.system.vga_mb, 8, "other system settings survive");
    assert.equal(machine_module.attached_media(machine).length, 1);
    assert.equal(machine_module.media_summary(machine), "ubuntu.iso");
    assert.equal(machine_module.needs_memory64(machine), false);
});

await test("the floppy boot order is what the BIOS expects", () => {
    const machine = machine_module.create_machine({ system: { boot_order: "floppy" } });
    assert.equal(machine_module.boot_order_value(machine), 0x213);
    const hard_disk = machine_module.create_machine({ system: { boot_order: "hd" } });
    assert.equal(machine_module.boot_order_value(hard_disk), 0x312);
});

await test("a machine without a name gets a fallback", () => {
    const machine = machine_module.create_machine({ name: "   " });
    machine_module.finalize_machine(machine, "x86-64");
    assert.equal(machine.name, "x86-64");
});

/* --------------------------------------------------------------- keyboard */

section("keyboard mapping");

await test("plain characters map to set 1 scan codes", () => {
    assert.deepEqual(keyboard.character_scancodes("a"), [0x1e, 0x9e]);
    assert.deepEqual(keyboard.character_scancodes("1"), [0x02, 0x82]);
    assert.deepEqual(keyboard.character_scancodes(" "), [0x39, 0xb9]);
    assert.deepEqual(keyboard.key_scancodes("enter"), [0x1c, 0x9c]);
});

await test("shifted characters press shift around the key", () => {
    assert.deepEqual(keyboard.character_scancodes("A"), [0x2a, 0x1e, 0x9e, 0xaa]);
    assert.deepEqual(keyboard.character_scancodes("!"), [0x2a, 0x02, 0x82, 0xaa]);
    assert.deepEqual(keyboard.character_scancodes("?"), [0x2a, 0x35, 0xb5, 0xaa]);
});

await test("extended keys carry the 0xe0 prefix", () => {
    assert.deepEqual(keyboard.key_scancodes("arrow_up"), [0x48, 0xc8]);
    assert.deepEqual(keyboard.key_scancodes("ctrl_right"), [0xe0, 0x1d, 0xe0, 0x9d]);
});

await test("every key of the on-screen keyboard produces scan codes", () => {
    for (const row of keyboard.KEYBOARD_LAYOUT) {
        for (const key of row) {
            const codes = keyboard.key_scancodes(key.key).length
                ? keyboard.key_scancodes(key.key)
                : keyboard.character_scancodes(key.key);
            assert.ok(codes.length > 0, "no scan code for " + key.key);
            assert.equal(codes.length % 2, 0, "press and release for " + key.key);
        }
    }
});

await test("typing a line of text produces a make/break pair per character", () => {
    // h and i are plain (2 codes each), ! needs shift (4), \n is Enter (2)
    const codes = keyboard.text_scancodes("hi!\n");
    assert.equal(codes.length, 2 + 2 + 4 + 2);
    assert.deepEqual(keyboard.text_scancodes("hi").slice(0, 2), [0x23, 0xa3]);
});

/* ------------------------------------------------------------------ files */

section("file helpers");

await test("images are recognised from their name and size", () => {
    assert.equal(files.guess_kind({ name: "alpine.iso", size: 1000 }), "iso");
    assert.equal(files.guess_kind({ name: "disk.hdd", size: 1000 }), "hdd");
    assert.equal(files.guess_kind({ name: "boot.img", size: 1474560 }), "floppy");
    assert.equal(files.guess_kind({ name: "boot.img", size: 999 }), "hdd");
});

await test("byte sizes are human readable", () => {
    assert.equal(files.format_bytes(1024), "1.0 КиБ");
    assert.equal(files.format_bytes(536870912), "512 МиБ");
});

/* ------------------------------------------------------------------ serial */

section("serial console");

/** A SerialConsole with a fake output element. */
function make_console() {
    return new SerialConsole({ addEventListener() {}, textContent: "" }, {});
}

await test("plain output is rendered line by line", () => {
    const console_ = make_console();
    console_.put_text("hello\r\nworld\r\n");
    assert.equal(console_.text, "hello\nworld\n");
});

await test("a carriage return overwrites the line instead of clearing it", () => {
    const console_ = make_console();
    console_.put_text("progress:  0%\rprogress: 42%\r\n");
    assert.equal(console_.text, "progress: 42%\n");
    // the text that is not overwritten stays
    console_.clear();
    console_.put_text("loading 100%\rdone\r\n");
    assert.equal(console_.text, "doneing 100%\n");
});

await test("ANSI escape sequences are stripped", () => {
    const console_ = make_console();
    console_.put_text("\x1b[0;32mOK\x1b[0m \x1b[1;31mFAIL\x1b[0m\r\n");
    assert.equal(console_.text, "OK FAIL\n");
    console_.clear();
    // erase the line, go back to the first column and write something else
    console_.put_text("value\x1b[2K\rOK\r\n");
    assert.equal(console_.text, "OK\n");
});

await test("an OSC sequence (window title) is consumed", () => {
    const console_ = make_console();
    console_.put_text("\x1b]0;login: root\x07hello\r\n");
    assert.equal(console_.text, "hello\n");
});

await test("backspace and tab move the cursor", () => {
    const console_ = make_console();
    console_.put_text("ab\b\bX\r\n");
    assert.equal(console_.text, "Xb\n");
    console_.clear();
    console_.put_text("a\tb\r\n");
    assert.equal(console_.text, "a       b\n");
});

await test("the console does not grow without bounds", () => {
    const console_ = make_console();
    for (let i = 0; i < 20000; i++) {
        console_.put_text("line " + i + "\r\n");
    }
    assert.ok(console_.text.length < 300 * 1024, "history is trimmed: " + console_.text.length);
    assert.match(console_.text.slice(-40), /line 19999/);
});

/* --------------------------------------------------------------------- end */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
