/*
 * Files: getting an ISO or a disk image out of the device and back in.
 *
 * On a phone everything goes through the system file picker (the file input),
 * on a desktop drag and drop is nicer, so both are supported here. The module
 * also knows about the storage quota of the browser: an image that is kept in
 * the app may not fit, and it is better to say so before the machine starts
 * than to fail in the middle of a boot.
 */

/** Images bigger than this are never copied into the browser storage by default. */
export const AUTO_STORE_LIMIT = 2 * 1024 * 1024 * 1024;

/**
 * Open the system file picker.
 * @param {string} accept e.g. ".iso,.img"
 * @param {{multiple?: boolean}=} options
 * @return {Promise<Array<File>>} empty when the user cancelled
 */
export function pick_files(accept, options = {}) {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.multiple = !!options.multiple;
        input.style.display = "none";
        document.body.appendChild(input);

        let done = false;
        const finish = files => {
            if (done) {
                return;
            }
            done = true;
            input.remove();
            resolve(files);
        };

        input.addEventListener("change", () => finish(Array.from(input.files || [])));
        input.addEventListener("cancel", () => finish([]));
        input.click();
    });
}

/** @param {string} text @return {string} filename without the extension */
function without_extension(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Guess what an image is, from its name and size.
 * @param {File|Blob} file
 * @return {"iso"|"hdd"|"floppy"}
 */
export function guess_kind(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".iso") || name.endsWith(".cdr") || name.endsWith(".dmg")) {
        return "iso";
    }
    if (name.endsWith(".flp") || name.endsWith(".ima") || file.size === 1474560) {
        return "floppy";
    }
    return "hdd";
}

/**
 * @param {number} bytes
 * @param {number=} precision
 * @return {string}
 */
export function format_bytes(bytes, precision) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) {
        return "?";
    }
    const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = precision === undefined ? (value < 10 && unit ? 1 : 0) : precision;
    return value.toFixed(digits) + " " + units[unit];
}

/**
 * How much space is left for stored images.
 * @param {Object} store a store backend (see store.js)
 * @return {Promise<{usage: number, quota: number|undefined, free: number|undefined}>}
 */
export async function storage_info(store) {
    const estimate = await store.estimate();
    const quota = estimate.quota;
    const usage = estimate.usage || 0;
    return {
        usage: usage,
        quota: quota,
        free: quota === undefined ? undefined : Math.max(0, quota - usage),
        persisted: estimate.persisted,
    };
}

/**
 * Can this file be kept in the browser storage?
 * @param {File|Blob} file
 * @param {Object} store
 * @param {{margin?: number}=} options keep this much of the quota free
 * @return {Promise<{ok: boolean, free?: number, need: number}>}
 */
export async function can_store(file, store, options = {}) {
    const info = await storage_info(store);
    const margin = options.margin === undefined ? 64 * 1024 * 1024 : options.margin;
    const available = info.free === undefined ? undefined : info.free - margin;
    return {
        ok: available === undefined || file.size <= available,
        free: available,
        need: file.size,
    };
}

/**
 * Save a blob to the device. In a browser this is a download; in the Android
 * WebView it opens the "save as" dialog of the system, which is the same thing
 * the user expects on a phone.
 *
 * @param {Blob} blob
 * @param {string} name
 */
export function download_blob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

/**
 * A drop target that understands images.
 * @param {HTMLElement} element
 * @param {{on_files: function(Array<File>), on_hover?: function(boolean)}=} options
 */
export function make_drop_target(element, options) {
    let depth = 0;

    element.addEventListener("dragenter", event => {
        event.preventDefault();
        depth++;
        options.on_hover && options.on_hover(true);
    });
    element.addEventListener("dragleave", event => {
        event.preventDefault();
        depth = Math.max(0, depth - 1);
        if (!depth) {
            options.on_hover && options.on_hover(false);
        }
    });
    element.addEventListener("dragover", event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    });
    element.addEventListener("drop", event => {
        event.preventDefault();
        depth = 0;
        options.on_hover && options.on_hover(false);
        const files = Array.from(event.dataTransfer.files || []);
        if (files.length) {
            options.on_files(files);
        }
    });
}

/** Turn a Blob into a File so that it has a name again. */
export function blob_as_file(blob, name) {
    return blob instanceof File ? blob : new File([blob], name, { type: blob.type || "application/octet-stream" });
}

export { without_extension };

export default {
    pick_files, guess_kind, format_bytes, storage_info, can_store,
    download_blob, make_drop_target, blob_as_file, AUTO_STORE_LIMIT,
};
