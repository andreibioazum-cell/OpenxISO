/*
 * The engine: everything that talks to v86_64.
 *
 * A Machine owns one v86 instance at a time. It is created from the machine
 * definition, the attached images (BlobBuffer objects, see media.js) and the
 * engine files in ../vendor/v86_64, and it exposes the handful of operations
 * the UI needs: start, stop, pause, resume, reset, suspend (save state),
 * resume from a state, attach/eject media, screenshots, scaling, audio and the
 * COM1 console.
 *
 * Nothing in here touches the DOM except for the screen container, which the
 * emulator itself needs (v86 draws text mode into a <div> and graphic modes
 * into a <canvas>).
 */

import { BLOCK_SIZE, BlobBuffer } from "./media.js";
import {
    MAX_MEMORY_STANDARD, boot_order_value, needs_memory64, WASM_FILES,
    DEFAULT_KERNEL_CMDLINE,
} from "./machine.js";

/** How much of an image the read cache keeps before evicting. */
const MEDIA_CACHE = 64 * 1024 * 1024;

export const VENDOR_PATH = "../vendor/v86_64/";

/** WebAssembly memory64 is needed for guests with more than 3 GiB of RAM. */
export const MEMORY64_SUPPORTED = (() => {
    try {
        // (module (memory i64 0))
        return WebAssembly.validate(new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x05, 0x03, 0x01, 0x04, 0x00,
        ]));
    } catch (error) {
        return false;
    }
})();

let v86_module = null;

/**
 * Load libv86.mjs once.
 * @return {Promise<Object>} the V86 class
 */
export async function load_engine() {
    if (!v86_module) {
        // the engine is imported by URL, so the app works from a file:// URL,
        // from a web server and from inside the Android WebView alike
        v86_module = import(/* @vite-ignore */ vendor_url("libv86.mjs"));
    }
    const module = await v86_module;
    const V86 = module.default || module.V86;
    if (!V86) {
        throw new EngineError("the engine has no V86 class: " + vendor_url("libv86.mjs"));
    }
    return V86;
}

/** @return {string} the absolute URL of an engine file */
export function vendor_url(file) {
    return new URL(VENDOR_PATH + file, import.meta.url).href;
}

/**
 * Turn a stored image (a Blob) into something v86 can read.
 * @param {Blob} blob
 * @param {{name?: string, cache_size?: number}=} options
 */
export function media_buffer(blob, options) {
    return new BlobBuffer(blob, Object.assign({ cache_size: MEDIA_CACHE }, options));
}

/** Everything that can go wrong while starting a machine. */
export class EngineError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = "EngineError";
        this.cause = cause;
    }
}

export class Machine {
    /**
     * @param {Object} machine machine definition (see machine.js)
     * @param {Object<string, Blob|undefined>} images kind -> image, e.g. {cdrom: File}
     * @param {HTMLElement} screen_container an element with a <canvas> and a <div>
     * @param {{on_event?: function(string, ...*), volume?: number,
     *          urls?: Object<string, {url: string, size?: number}>}=} options
     */
    constructor(machine, images, screen_container, options = {}) {
        this.machine = machine;
        this.images = images || {};
        /** Images that are streamed from a URL with range requests. */
        this.urls = options.urls || {};
        this.screen_container = screen_container;
        this.on_event = options.on_event || (() => {});
        this.volume = options.volume === undefined ? machine.audio.volume : options.volume;

        this.emulator = null;
        this.buffers = {};
        this.status = "stopped";
        this.error = null;
        this.started_at = 0;
        this.total_read = 0;
        this.instruction_counter = 0;
    }

    /* ------------------------------------------------------------- lifecycle */

    /**
     * @return {Promise<void>}
     */
    async start() {
        if (this.emulator) {
            throw new EngineError("the machine is already running");
        }

        const V86 = await load_engine();
        const machine = this.machine;

        if (needs_memory64(machine) && !MEMORY64_SUPPORTED) {
            throw new EngineError("memory64_unsupported");
        }

        this.buffers = {};
        for (const [kind, blob] of Object.entries(this.images)) {
            // the kernel is not a block device: the engine wants its bytes
            if (blob && kind !== "kernel") {
                this.buffers[kind] = media_buffer(blob, { name: (machine.media[kind] || {}).name || kind });
            }
        }

        const wasm = needs_memory64(machine) ? WASM_FILES.mem64 : WASM_FILES.standard;

        this.status = "loading";
        this.error = null;
        this.on_event("state", this.status);

        const options = {
            wasm_path: vendor_url(wasm),
            bios: { url: vendor_url("seabios.bin") },
            vga_bios: { url: vendor_url("vgabios.bin") },
            memory_size: machine.system.memory_mb * 1024 * 1024,
            vga_memory_size: machine.system.vga_mb * 1024 * 1024,
            acpi: machine.system.acpi,
            fastboot: machine.system.fastboot,
            boot_order: boot_order_value(machine),
            screen_container: this.screen_container,
            disable_speaker: !machine.audio.enabled,
            // the engine loads the wasm module and the images asynchronously
            // and starts the CPU itself once that is done ("emulator-loaded"),
            // so start() waits for that event instead of calling run() too early
            autostart: true,
        };

        for (const kind of ["cdrom", "hda", "hdb", "fda"]) {
            if (this.buffers[kind]) {
                options[kind] = this.buffers[kind];
            } else if (this.urls[kind]) {
                // v86 reads these in 256 byte aligned blocks with Range
                // requests, so a multi-gigabyte image on a server never has to
                // be downloaded by the browser
                options[kind] = {
                    url: this.urls[kind].url,
                    // undefined makes the engine ask the server for the size
                    // with "Range: bytes=0-0"; 0 would mean "empty image"
                    size: this.urls[kind].size || undefined,
                    fixed_chunk_size: 256 * 1024,
                    async: true,
                };
            }
        }

        // A kernel image is booted through the Linux boot protocol: the engine
        // takes the raw bytes of the bzImage plus the machine's command line,
        // and it does not matter what else is attached to the machine.
        if (this.images.kernel) {
            options.bzimage = new Uint8Array(await this.images.kernel.arrayBuffer());
        } else if (this.urls.kernel) {
            // read it here instead of letting the engine do a synchronous
            // request: a kernel is a few megabytes and the tab would freeze
            const response = await fetch(this.urls.kernel.url);
            if (!response.ok) {
                throw new EngineError(`the kernel image could not be loaded (${response.status})`);
            }
            options.bzimage = new Uint8Array(await response.arrayBuffer());
        }
        if (options.bzimage) {
            options.cmdline = machine.system.cmdline || DEFAULT_KERNEL_CMDLINE;
        }

        if (machine.network.device && machine.network.device !== "none") {
            options.net_device = {
                type: machine.network.device === "virtio" ? "virtio" : "ne2k",
            };
            if (machine.network.relay_url) {
                options.net_device.relay_url = machine.network.relay_url;
            }
        }

        this.instruction_counter = 0;
        const emulator = new V86(options);
        this.emulator = emulator;
        this.attach_events();

        try {
            await this.wait_until_loaded(emulator);
        } catch (error) {
            this.status = "error";
            this.error = error;
            this.on_event("state", this.status, error);
            throw new EngineError("the emulator failed to start", error);
        }

        this.status = "running";
        this.started_at = Date.now();
        this.set_volume(this.volume);
        this.on_event("state", this.status);
    }

    /**
     * Resolve when the engine has loaded the wasm module and every image and
     * started the guest ("emulator-loaded"), or when the guest is already
     * running.
     *
     * @param {Object} emulator
     * @return {Promise<void>}
     */
    wait_until_loaded(emulator, timeout) {
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = error => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                error ? reject(error) : resolve();
            };
            const timer = setTimeout(() => {
                // the event can be missed when a state is restored into an
                // already running machine, so fall back to a real check
                if (emulator.v86 && emulator.v86.cpu) {
                    finish();
                } else {
                    finish(new Error("the engine did not finish loading in time"));
                }
            }, timeout || 120000);

            emulator.add_listener("emulator-loaded", () => finish());
            emulator.add_listener("download-error", error =>
                finish(error instanceof Error ? error : new Error(String(error))));
        });
    }

    /** Wire the bus events the UI cares about to on_event(). */
    attach_events() {
        const emulator = this.emulator;
        const emit = (name, ...args) => this.on_event(name, ...args);

        emulator.add_listener("emulator-ready", () => {
            this.status = "running";
            emit("state", this.status);
        });
        emulator.add_listener("emulator-started", () => emit("started"));
        emulator.add_listener("emulator-stopped", () => {
            this.status = "stopped";
            emit("state", this.status);
        });
        emulator.add_listener("serial0-output-byte", byte => emit("serial", byte));
        emulator.add_listener("screen-set-size", args => emit("screen-size", args));
        emulator.add_listener("screen-put-char", args => emit("screen-char", args));
        emulator.add_listener("mouse-enable", enabled => emit("mouse", enabled));
        emulator.add_listener("mouse-pointer-lock", locked => emit("pointer-lock", locked));
        emulator.add_listener("pcspeaker-enable", () => emit("speaker", true));
        emulator.add_listener("pcspeaker-disable", () => emit("speaker", false));
        emulator.add_listener("dac-enable", () => emit("dac", true));
        emulator.add_listener("dac-disable", () => emit("dac", false));
        emulator.add_listener("ide-read-start", () => emit("disk-activity", true));
        emulator.add_listener("ide-read-end", () => emit("disk-activity", false));
        emulator.add_listener("download-progress", progress => emit("download", progress));
        emulator.add_listener("download-error", error => emit("download-error", error));
    }

    /**
     * Stop the emulator. The guest is not asked to shut down, exactly like
     * pulling the plug.
     */
    async stop() {
        const emulator = this.emulator;
        if (!emulator) {
            return;
        }
        this.emulator = null;
        this.buffers = {};
        this.status = "stopped";

        try {
            await emulator.destroy();
        } catch (error) {
            console.warn("while destroying the emulator:", error);
        }
        this.on_event("state", this.status);
    }

    /**
     * Reset the machine: a power cycle.
     *
     * v86's own restart() cannot be used here.  A machine that was booted
     * through the Linux boot protocol comes back through the BIOS when it is
     * restarted, and the v86_64 engine's CPU dies on the #GP that path hits
     * ("panicked at cpu.rs: Unimplemented: #GP handler" in the wasm module, the
     * emulator is gone afterwards - see the limitations in emulator/README.md).
     * Stopping and starting the machine instead brings the guest up exactly the
     * way it came up the first time; like a power cycle, whatever the guest had
     * written into an attached image is lost (the app can save the image with
     * its own button before that).
     *
     * @return {Promise<void>}
     */
    async reset() {
        if (!this.emulator) {
            throw new EngineError("the machine is not running");
        }
        await this.stop();
        await this.start();
    }

    pause() {
        this.emulator && this.emulator.stop();
        this.status = "paused";
        this.on_event("state", this.status);
    }

    resume() {
        this.emulator && this.emulator.run();
        this.status = "running";
        this.on_event("state", this.status);
    }

    /** @return {boolean} */
    get is_running() {
        return !!this.emulator && this.emulator.is_running();
    }

    /* ------------------------------------------------------------ media swap */

    /**
     * Insert (or replace) a CD-ROM image while the machine is running.
     * @param {Blob} blob
     * @param {string=} name
     */
    async set_cdrom(blob, name) {
        if (!this.emulator) {
            throw new EngineError("the machine is not running");
        }
        const buffer = media_buffer(blob, { name: name || "cdrom.iso" });
        await this.emulator.set_cdrom(buffer);
        this.buffers.cdrom = buffer;
    }

    eject_cdrom() {
        if (this.emulator) {
            this.emulator.eject_cdrom();
            delete this.buffers.cdrom;
        }
    }

    async set_fda(blob, name) {
        if (!this.emulator) {
            throw new EngineError("the machine is not running");
        }
        const buffer = media_buffer(blob, { name: name || "floppy.img" });
        await this.emulator.set_fda(buffer);
        this.buffers.fda = buffer;
    }

    eject_fda() {
        if (this.emulator) {
            this.emulator.eject_fda();
            delete this.buffers.fda;
        }
    }

    /** @return {Object<string, BlobBuffer>} */
    get media_buffers() {
        return this.buffers;
    }

    /* ---------------------------------------------------------------- input */

    send_keys(scancodes) {
        this.emulator && this.emulator.keyboard_send_scancodes(scancodes);
    }

    send_text(text) {
        this.emulator && this.emulator.keyboard_send_text(text);
    }

    /** Ctrl+Alt+Del, the classic "send the guest a reboot". */
    send_ctrl_alt_del() {
        this.send_keys([0x1d, 0x38, 0x53, 0xd3, 0xb8, 0x9d]);
    }

    send_mouse_delta(delta_x, delta_y) {
        this.emulator && this.emulator.bus.send("mouse-delta", [delta_x, delta_y]);
    }

    send_mouse_click(left, middle, right) {
        this.emulator && this.emulator.bus.send("mouse-click", [!!left, !!middle, !!right]);
    }

    send_mouse_wheel(delta_x, delta_y) {
        this.emulator && this.emulator.bus.send("mouse-wheel", [delta_x, delta_y]);
    }

    lock_mouse() {
        return this.emulator ? this.emulator.lock_mouse() : Promise.resolve();
    }

    serial_send(text) {
        this.emulator && this.emulator.serial0_send(text);
    }

    /* --------------------------------------------------------------- screen */

    screen_set_scale(scale_x, scale_y) {
        this.emulator && this.emulator.screen_set_scale(scale_x, scale_y);
    }

    screen_fullscreen() {
        this.emulator && this.emulator.screen_go_fullscreen();
    }

    /** @return {HTMLCanvasElement|null} */
    screenshot() {
        return this.emulator ? this.emulator.screen_make_screenshot() : null;
    }

    /* ---------------------------------------------------------------- audio */

    /**
     * Master volume of the emulated mixer: 0 is silence, 1 is the guest's own
     * level, up to 4 amplifies (the mixer works in decibel).
     *
     * @param {number} volume
     */
    set_volume(volume) {
        this.volume = volume;
        const adapter = this.emulator && this.emulator.speaker_adapter;
        if (!adapter) {
            return;
        }
        try {
            // Browsers only allow audio after a user gesture; the power button
            // is one, but a context that was suspended in the meantime (a call,
            // a background tab) has to be resumed again.
            if (adapter.audio_context.state === "suspended") {
                adapter.audio_context.resume();
            }
            const gain = Math.max(0.0001, Math.min(4, volume));
            const decibel = 20 * Math.log10(gain);
            // MIXER_SRC_MASTER = 0, MIXER_CHANNEL_BOTH = 2 (see const.js in v86)
            this.emulator.bus.send("mixer-volume", [0, 2, decibel]);
        } catch (error) {
            console.warn("cannot set the volume:", error);
        }
    }

    /** @return {boolean} whether the guest (Sound Blaster DAC) is playing */
    get audio_playing() {
        const adapter = this.emulator && this.emulator.speaker_adapter;
        return !!(adapter && adapter.dac && adapter.dac.enabled);
    }

    /* --------------------------------------------------------- save / restore */

    /**
     * @return {Promise<Blob>} a save state (guest memory + device state)
     */
    async save_state() {
        if (!this.emulator) {
            throw new EngineError("the machine is not running");
        }
        const state = await this.emulator.save_state();
        const blob = state instanceof Blob ? state : new Blob([state], { type: "application/octet-stream" });
        return blob;
    }

    /**
     * @param {Blob} blob a state created by save_state()
     */
    async restore_state(blob) {
        if (!this.emulator) {
            throw new EngineError("the machine is not running");
        }
        const buffer = await blob.arrayBuffer();
        await this.emulator.restore_state(buffer);
        this.status = "running";
        this.on_event("state", this.status);
    }

    /* ------------------------------------------------------------ statistics */

    /** @return {{read: number, requests: number, images: number}} */
    get media_stats() {
        let read = 0;
        let requests = 0;
        let images = 0;
        for (const buffer of Object.values(this.buffers)) {
            read += buffer.bytes_read;
            requests += buffer.read_requests;
            images++;
        }
        return { read: read, requests: requests, images: images };
    }

    /**
     * How many instructions the guest has executed since the last poll.
     * @return {number}
     */
    poll_instructions() {
        if (!this.emulator) {
            return 0;
        }
        const counter = this.emulator.get_instruction_counter();
        const difference = (counter - this.instruction_counter) >>> 0;
        this.instruction_counter = counter;
        return difference;
    }

    /** Export every image with the guest's writes applied. */
    *export_images() {
        for (const [kind, buffer] of Object.entries(this.buffers)) {
            if (buffer instanceof BlobBuffer && buffer.has_changes) {
                const media = this.machine.media[kind] || {};
                yield { kind: kind, name: media.name || kind, blob: buffer.export_blob() };
            }
        }
    }

    /** @return {number} bytes written by the guest across all images */
    get dirty_bytes() {
        let total = 0;
        for (const buffer of Object.values(this.buffers)) {
            total += buffer.dirty_bytes;
        }
        return total;
    }
}

export { MAX_MEMORY_STANDARD, BLOCK_SIZE };

export default { Machine, load_engine, vendor_url, media_buffer, MEMORY64_SUPPORTED };
