/*
 * Media backends for the emulator.
 *
 * The emulator can be given an ISO or a disk image in three ways:
 *
 *   - as a URL (v86 downloads it with HTTP range requests, so multi-gigabyte
 *     images from a server are never held in memory),
 *   - as an ArrayBuffer (small images, everything in memory),
 *   - as a Blob/File with BlobBuffer, below.
 *
 * BlobBuffer is what makes "pick an ISO from the phone" work with images that
 * are much larger than the memory a browser tab gets: v86 asks for 256 byte
 * aligned blocks, BlobBuffer reads the surrounding chunk from the file with
 * Blob.slice().arrayBuffer() (phones serve that straight from storage), keeps a
 * bounded read cache and puts writes into an overlay. The overlay also ends up
 * in save states, and export_blob() turns image + overlay back into a file the
 * user can store on the device.
 *
 * The interface mirrors what v86 calls on a file buffer, see buffer.js in
 * v86_64: load(), onload, onprogress, byteLength, get(offset, length, fn,
 * options), get_and_cache, get_from_cache, set(start, data, fn), get_buffer,
 * get_state/set_state.
 */

/** v86 addresses files in blocks of 256 bytes. */
export const BLOCK_SIZE = 256;

/** Reads are rounded up to this size so that a 4 KiB filesystem read is one
 *  call into the file, not sixteen. */
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/** How much of an image is kept in memory. Reads are evicted in the order they
 *  arrived, writes are never evicted. */
const DEFAULT_CACHE_SIZE = 64 * 1024 * 1024;

/** get_buffer() reads the whole image into one ArrayBuffer; refuse for
 *  anything bigger than this. */
const MAX_FULL_READ = 512 * 1024 * 1024;

/**
 * A v86 file buffer backed by a Blob or a File.
 */
export class BlobBuffer {
    /**
     * @param {Blob|File} blob
     * @param {{name?: string, chunk_size?: number, cache_size?: number}} options
     */
    constructor(blob, options = {}) {
        if (!blob || typeof blob.size !== "number" || typeof blob.slice !== "function") {
            throw new TypeError("BlobBuffer needs a Blob or a File");
        }
        if (!blob.size) {
            throw new Error("the image is empty");
        }

        this.blob = blob;
        this.name = options.name || blob.name || "image";
        this.byteLength = blob.size;
        this.size = blob.size;
        this.chunk_size = options.chunk_size || DEFAULT_CHUNK_SIZE;
        this.cache_size = options.cache_size || DEFAULT_CACHE_SIZE;

        this.onload = undefined;
        this.onprogress = undefined;

        /** 256 byte blocks that are already known, keyed by block index. */
        this.block_cache = new Map();
        /** Block indices that were written by the guest. */
        this.block_cache_is_write = new Set();

        this.cache_bytes = 0;
        this.cache_reads = true;
        this.bytes_read = 0;
        this.read_requests = 0;
        /** Chunk index -> promise, so parallel readers share one file read. */
        this.pending = new Map();
    }

    /** Called by v86 before the machine starts. */
    async load() {
        this.onload && this.onload({});
    }

    /** True when the guest wrote something that is not in the original file. */
    get has_changes() {
        return this.block_cache_is_write.size > 0;
    }

    /** Number of bytes written to the image by the guest. */
    get dirty_bytes() {
        return this.block_cache_is_write.size * BLOCK_SIZE;
    }

    /* ---------------------------------------------------------------- reads */

    /**
     * @param {number} offset
     * @param {number} length
     * @return {Uint8Array|undefined} the data if every block is known
     */
    get_from_cache(offset, length) {
        const blocks = length / BLOCK_SIZE;
        const first = offset / BLOCK_SIZE;

        for (let i = 0; i < blocks; i++) {
            if (!this.block_cache.has(first + i)) {
                return undefined;
            }
        }

        if (blocks === 1) {
            return this.block_cache.get(first);
        }

        const result = new Uint8Array(length);
        for (let i = 0; i < blocks; i++) {
            result.set(this.block_cache.get(first + i), i * BLOCK_SIZE);
        }
        return result;
    }

    /**
     * Asynchronous read, used by the (A)TA controller.
     * @param {number} offset
     * @param {number} length
     * @param {function(!Uint8Array)} fn
     * @param {{signal?: AbortSignal}=} options
     */
    get(offset, length, fn, options) {
        if (offset % BLOCK_SIZE || length % BLOCK_SIZE || !length) {
            throw new Error("BlobBuffer.get: offset and length must be multiples of 256");
        }

        const cached = this.get_from_cache(offset, length);
        if (cached) {
            fn(cached);
            return;
        }

        let start = offset;
        let bytes = length;
        if (this.chunk_size > BLOCK_SIZE) {
            start = offset - (offset % this.chunk_size);
            bytes = Math.ceil((offset - start + length) / this.chunk_size) * this.chunk_size;
        }
        if (start + bytes > this.byteLength) {
            bytes = this.byteLength - start;
        }

        this.read_chunk(start, bytes).then(data => {
            if (options && options.signal && options.signal.aborted) {
                // The controller cancelled this transfer; it handles a late
                // callback as well, but there is no point in parsing it.
                fn(new Uint8Array(length));
                return;
            }

            // Written blocks (from the guest or from a restored state) win over
            // the bytes in the file.
            for (let block = start; block < start + bytes; block += BLOCK_SIZE) {
                const cached_block = this.block_cache.get(block / BLOCK_SIZE);
                if (cached_block) {
                    data.set(cached_block, block - start);
                }
            }

            if (start === offset && bytes === length) {
                fn(data);
            } else {
                fn(data.subarray(offset - start, offset - start + length));
            }
        }).catch(error => {
            console.error("image read failed", error);
            fn(new Uint8Array(length));
        });
    }

    /**
     * Read and remember whole blocks.
     * @param {number} offset
     * @param {number} length
     * @param {function(!Uint8Array)} fn
     * @param {{signal?: AbortSignal}=} options
     */
    get_and_cache(offset, length, fn, options) {
        this.get(offset, length, data => {
            if (this.cache_reads) {
                const first = offset / BLOCK_SIZE;
                for (let i = 0; i < length / BLOCK_SIZE; i++) {
                    if (!this.block_cache.has(first + i)) {
                        this.remember(first + i, data.slice(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE), false);
                    }
                }
            }
            fn(data);
        }, options);
    }

    /**
     * Read bytes from the file, sharing the work with other readers of the same
     * chunk.
     * @param {number} start
     * @param {number} bytes
     * @return {Promise<Uint8Array>}
     */
    read_chunk(start, bytes) {
        const key = start + ":" + bytes;
        let request = this.pending.get(key);
        if (request) {
            return request;
        }

        this.read_requests++;
        this.bytes_read += bytes;
        request = this.blob.slice(start, start + bytes).arrayBuffer().then(buffer => new Uint8Array(buffer));
        this.pending.set(key, request);
        const done = () => this.pending.delete(key);
        request.then(done, done);
        return request;
    }

    /**
     * @param {number} index block index
     * @param {!Uint8Array} block
     * @param {boolean} write
     */
    remember(index, block, write) {
        if (this.block_cache.has(index)) {
            return;
        }
        this.block_cache.set(index, block);
        this.cache_bytes += block.length;
        if (write) {
            this.block_cache_is_write.add(index);
        } else {
            this.evict();
        }
    }

    /** Drop the oldest read blocks until the cache is within its budget. */
    evict() {
        if (this.cache_bytes <= this.cache_size) {
            return;
        }
        for (const [index, block] of this.block_cache) {
            if (this.block_cache_is_write.has(index)) {
                continue;
            }
            this.block_cache.delete(index);
            this.cache_bytes -= block.length;
            if (this.cache_bytes <= this.cache_size) {
                return;
            }
        }
    }

    /* --------------------------------------------------------------- writes */

    /**
     * @param {number} start
     * @param {!Uint8Array} data
     * @param {function()} fn
     */
    set(start, data, fn) {
        if (start % BLOCK_SIZE || data.length % BLOCK_SIZE || !data.length) {
            throw new Error("BlobBuffer.set: start and length must be multiples of 256");
        }

        const first = start / BLOCK_SIZE;
        for (let i = 0; i < data.length / BLOCK_SIZE; i++) {
            const block = data.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE);
            const existing = this.block_cache.get(first + i);
            if (existing) {
                existing.set(block);
            } else {
                const copy = block.slice();
                this.block_cache.set(first + i, copy);
                this.cache_bytes += copy.length;
            }
            this.block_cache_is_write.add(first + i);
        }

        fn();
    }

    /* ------------------------------------------------------------ snapshots */

    get_state() {
        const written = [];
        for (const [index, block] of this.block_cache) {
            if (this.block_cache_is_write.has(index)) {
                written.push([index, block]);
            }
        }
        this.evict();
        return [written];
    }

    set_state(state) {
        const written = state[0] || [];
        this.block_cache.clear();
        this.block_cache_is_write.clear();
        this.cache_bytes = 0;
        for (const [index, block] of written) {
            this.block_cache.set(index, block);
            this.block_cache_is_write.add(index);
            this.cache_bytes += block.length;
        }
    }

    /* ---------------------------------------------------------------- export */

    /**
     * The image with every guest write applied, as a Blob. Untouched parts are
     * referenced, not copied, so this is cheap.
     * @return {Blob}
     */
    export_blob() {
        const parts = [];
        const indices = Array.from(this.block_cache_is_write).sort((a, b) => a - b);
        let position = 0;

        for (const index of indices) {
            const offset = index * BLOCK_SIZE;
            if (offset > position) {
                parts.push(this.blob.slice(position, offset));
            }
            parts.push(this.block_cache.get(index));
            position = offset + BLOCK_SIZE;
        }

        if (position < this.byteLength) {
            parts.push(this.blob.slice(position, this.byteLength));
        }

        return new Blob(parts, { type: "application/octet-stream" });
    }

    /** Read the whole image into memory (only for reasonably sized images). */
    get_buffer(fn) {
        if (this.byteLength > MAX_FULL_READ) {
            console.warn("BlobBuffer.get_buffer: image is too large to read into memory");
            fn(undefined);
            return;
        }
        this.export_blob().arrayBuffer().then(fn, error => {
            console.error(error);
            fn(undefined);
        });
    }

    /** Progress of the transfer for the UI: how much of the image was read. */
    get progress() {
        return {
            read: Math.min(this.bytes_read, this.byteLength),
            total: this.byteLength,
            requests: this.read_requests,
        };
    }
}

/**
 * A blank disk image without allocating it all in memory.
 * @param {number} size in bytes
 * @return {Blob}
 */
export function blank_image(size) {
    const chunk = new Uint8Array(Math.min(size, 1024 * 1024));
    const parts = [];
    let left = size;
    while (left > 0) {
        parts.push(chunk.subarray(0, Math.min(left, chunk.length)));
        left -= chunk.length;
    }
    return new Blob(parts, { type: "application/octet-stream" });
}

/**
 * Parse a size like "512", "512M", "2G" or "1.5 GiB" into bytes.
 * @param {string|number} value
 * @param {number=} fallback
 * @return {number}
 */
export function parse_size(value, fallback) {
    if (typeof value === "number") {
        return value;
    }
    const match = String(value || "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)(?:i?b?)?$/i);
    if (!match) {
        return fallback === undefined ? 0 : fallback;
    }
    const factors = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
    return Math.round(parseFloat(match[1]) * factors[match[2].toLowerCase()]);
}

/**
 * @param {number} bytes
 * @param {number=} precision
 * @return {string}
 */
export function format_bytes(bytes, precision) {
    if (!bytes && bytes !== 0) {
        return "?";
    }
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = precision === undefined ? (value < 10 && unit ? 1 : 0) : precision;
    return value.toFixed(digits) + " " + units[unit];
}
