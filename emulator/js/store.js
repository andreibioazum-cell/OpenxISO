/*
 * Persistence for the emulator: machines, the images that are attached to them
 * and saved machine states.
 *
 * Everything goes into IndexedDB, which is the only place in a browser where a
 * multi-megabyte (or multi-gigabyte) guest ISO can live and survive a reload.
 * When IndexedDB is unavailable (private windows, hardened browsers) the same
 * interface is served from memory: the app keeps working, but nothing is kept
 * after the page is closed.
 *
 * The interface is small on purpose: get/put/delete/get_all/count/clear for
 * every store, plus estimate() for the storage quota.
 */

const DB_NAME = "openxiso";
const DB_VERSION = 1;

/** Stores and their key paths. */
export const STORES = {
    machines: "id",
    media: "id",
    states: "id",
    settings: "key",
};

/* --------------------------------------------------------------- in memory */

/** Used when IndexedDB is missing, and by the tests. */
export class MemoryBackend {
    constructor() {
        this.data = new Map();
        for (const store of Object.keys(STORES)) {
            this.data.set(store, new Map());
        }
    }

    async get(store, key) {
        return this.data.get(store).get(key);
    }

    async get_all(store) {
        return Array.from(this.data.get(store).values());
    }

    async put(store, value) {
        const key_path = STORES[store];
        this.data.get(store).set(value[key_path], value);
        return value[key_path];
    }

    async delete(store, key) {
        this.data.get(store).delete(key);
    }

    async count(store) {
        return this.data.get(store).size;
    }

    async clear(store) {
        this.data.get(store).clear();
    }

    async estimate() {
        let used = 0;
        for (const store of this.data.values()) {
            for (const value of store.values()) {
                if (value.blob) {
                    used += value.blob.size;
                } else if (value.data) {
                    used += value.data.size || value.data.byteLength || 0;
                }
            }
        }
        return { usage: used, quota: undefined, persisted: false };
    }
}

/* -------------------------------------------------------------- indexed db */

function request_to_promise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

class IndexedDbBackend {
    constructor(database) {
        this.db = database;
    }

    store(store, mode) {
        return this.db.transaction(store, mode).objectStore(store);
    }

    async get(store, key) {
        return request_to_promise(this.store(store, "readonly").get(key));
    }

    async get_all(store) {
        return request_to_promise(this.store(store, "readonly").getAll());
    }

    async put(store, value) {
        return request_to_promise(this.store(store, "readwrite").put(value));
    }

    async delete(store, key) {
        return request_to_promise(this.store(store, "readwrite").delete(key));
    }

    async count(store) {
        return request_to_promise(this.store(store, "readonly").count());
    }

    async clear(store) {
        return request_to_promise(this.store(store, "readwrite").clear());
    }

    async estimate() {
        if (!navigator.storage || !navigator.storage.estimate) {
            return { usage: 0, quota: undefined, persisted: false };
        }
        const estimate = await navigator.storage.estimate();
        let persisted = false;
        try {
            persisted = await navigator.storage.persisted();
        } catch (error) {
            persisted = false;
        }
        return { usage: estimate.usage, quota: estimate.quota, persisted: persisted };
    }
}

/**
 * Ask the browser to keep the data even when storage runs low. Best effort:
 * browsers may refuse without a user gesture or without an installed app.
 * @return {Promise<boolean>}
 */
export async function request_persistent_storage() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            return await navigator.storage.persist();
        }
    } catch (error) {
        console.warn("persistent storage refused:", error);
    }
    return false;
}

/**
 * Open the database, falling back to memory when IndexedDB is not usable.
 * @return {Promise<MemoryBackend|IndexedDbBackend>}
 */
export async function open_store() {
    if (typeof indexedDB === "undefined") {
        console.warn("IndexedDB is not available, machines are not persisted");
        return new MemoryBackend();
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
        const database = request.result;
        for (const [store, key_path] of Object.entries(STORES)) {
            if (!database.objectStoreNames.contains(store)) {
                database.createObjectStore(store, { keyPath: key_path });
            }
        }
    };

    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(new IndexedDbBackend(request.result));
        request.onerror = () => reject(request.error);
        request.onblocked = () => console.warn("IndexedDB upgrade is blocked by another tab");
    }).catch(error => {
        console.error("cannot open IndexedDB:", error);
        return new MemoryBackend();
    });
}

/** @return {string} a short unique id */
export function new_id(prefix) {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix || ""}${Date.now().toString(36)}-${random}`;
}

export default { open_store, MemoryBackend, STORES, new_id, request_persistent_storage };
