/*
 * The machine description: what a "virtual machine" in this app is.
 *
 * A machine only stores *settings* — the images themselves live in the store
 * (or are attached for the current session) and are referenced by id, so a
 * machine definition stays small enough for localStorage and can be copied
 * around.
 */

import { new_id } from "./store.js";

/** Boot orders as the BIOS expects them (see const.js in v86: 0x123 = CD first). */
export const BOOT_ORDERS = {
    cd: 0x123,      // CD-ROM, then hard disk
    hd: 0x312,      // hard disk, then CD-ROM
    floppy: 0x213,  // floppy, then hard disk
};

/** Guest memory: the standard wasm build maps up to 3 GiB. */
export const MEMORY_CHOICES = [128, 256, 512, 1024, 1536, 2048, 3072, 4096, 6144, 8192];
export const MAX_MEMORY_STANDARD = 3072;

export const VRAM_CHOICES = [4, 8, 16, 32, 64, 128];

/** Image kinds and what the file picker accepts for them. */
export const MEDIA_KINDS = {
    cdrom: { accept: ".iso,.img,.bin,application/x-iso9660-image", optional: true },
    hda: { accept: ".hdd,.img,.raw,.vhd,.qcow,.bin", optional: true },
    hdb: { accept: ".hdd,.img,.raw,.bin", optional: true },
    fda: { accept: ".img,.ima,.flp,.bin", optional: true },
};

/**
 * @param {Object=} patch
 * @return {Object} a complete machine definition
 */
export function create_machine(patch) {
    const machine = {
        id: new_id("vm-"),
        name: "",
        created: Date.now(),
        modified: Date.now(),

        system: {
            memory_mb: 512,
            vga_mb: 8,
            boot_order: "cd",
            acpi: true,
            fastboot: true,
        },

        audio: {
            enabled: true,
            volume: 0.8,
        },

        network: {
            device: "none",
            relay_url: "",
        },

        display: {
            scale: "fit",
            virtual_mouse: false,
        },

        serial: {
            enabled: true,
        },

        /**
         * kind -> media reference:
         *   {id, name, size, storage: "browser"|"session", writable}
         * or, for an image on a server,
         *   {id, name, size, url, storage: "url"}
         */
        media: {
            cdrom: null,
            hda: null,
            hdb: null,
            fda: null,
        },

        /** the last saved state of this machine, if any */
        state: null,
    };

    return merge_machine(machine, patch);
}

/**
 * Deep merge a patch into a machine (only for the keys the machine knows).
 * @param {Object} machine
 * @param {Object=} patch
 */
export function merge_machine(machine, patch) {
    if (!patch) {
        return machine;
    }
    for (const [key, value] of Object.entries(patch)) {
        if (key === "media" && value) {
            Object.assign(machine.media, value);
        } else if (value && typeof value === "object" && !Array.isArray(value) &&
                   machine[key] && typeof machine[key] === "object") {
            Object.assign(machine[key], value);
        } else if (value !== undefined) {
            machine[key] = value;
        }
    }
    machine.modified = Date.now();
    return machine;
}

/** @return {number} the value for the boot_order option */
export function boot_order_value(machine) {
    return BOOT_ORDERS[machine.system.boot_order] || BOOT_ORDERS.cd;
}

/** @return {boolean} whether more than the standard wasm build can map */
export function needs_memory64(machine) {
    return machine.system.memory_mb > MAX_MEMORY_STANDARD;
}

/**
 * The media that are attached to the machine, in boot order — used by the UI
 * to describe a machine and by the engine to build the options object.
 * @param {Object} machine
 * @return {Array<{kind: string, media: Object}>}
 */
export function attached_media(machine) {
    const order = ["cdrom", "hda", "hdb", "fda"];
    return order.filter(kind => machine.media[kind]).map(kind => ({ kind: kind, media: machine.media[kind] }));
}

/**
 * A human readable one line description of the media, e.g. "alpine.iso, disk.hdd".
 * @param {Object} machine
 * @return {string}
 */
export function media_summary(machine) {
    const attached = attached_media(machine);
    if (!attached.length) {
        return "";
    }
    return attached.map(entry => entry.media.name).join(", ");
}

/**
 * @param {Object} medium a media reference from machine.media
 * @return {boolean} whether it is an image streamed from a URL
 */
export function is_url_media(medium) {
    return !!(medium && medium.url);
}

/** Reset the timestamps and make sure a name exists. */
export function finalize_machine(machine, fallback_name) {
    machine.name = (machine.name || "").trim() || fallback_name || "x86-64";
    machine.modified = Date.now();
    return machine;
}

/** The value for the wasm build to use. */
export const WASM_FILES = {
    standard: "v86.wasm",
    mem64: "v86-mem64.wasm",
    fallback: "v86-fallback.wasm",
};

export default {
    create_machine, merge_machine, boot_order_value, needs_memory64,
    attached_media, media_summary, finalize_machine, is_url_media,
    BOOT_ORDERS, MEMORY_CHOICES, VRAM_CHOICES, MEDIA_KINDS, WASM_FILES,
};
