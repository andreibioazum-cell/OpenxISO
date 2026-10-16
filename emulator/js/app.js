/*
 * The application: machine list, power buttons, wizard, settings, snapshots
 * and everything that happens while a guest is running.
 *
 * The layout follows VirtualBox: a list of machines on the left, the selected
 * machine in the middle, and the buttons that control it above. Everything is
 * kept in the store (IndexedDB), including the images, so a machine survives a
 * reload of the page or a restart of the browser.
 */

import { t, set_language, get_language, languages, translate_dom } from "./i18n.js";
import { open_store, new_id, request_persistent_storage } from "./store.js";
import {
    create_machine, finalize_machine, attached_media, is_url_media, MEDIA_KINDS,
    DEFAULT_KERNEL_CMDLINE,
} from "./machine.js";
import { Machine, EngineError, MEMORY64_SUPPORTED } from "./engine.js";
import { Display } from "./display.js";
import { SerialConsole } from "./serial.js";
import { OnScreenKeyboard } from "./keyboard.js";
import {
    pick_files, guess_kind, looks_like_kernel, format_bytes, storage_info, can_store,
    download_blob,
    make_drop_target, blob_as_file,
} from "./files.js";
import { blank_image } from "./media.js";
import {
    el, clear, dialog, confirm, prompt_text, toast, format_duration, tabbar,
} from "./ui.js";
import * as settings from "./settings-ui.js";

/* ------------------------------------------------------------------- state */

const state = {
    store: null,
    machines: [],
    selected_id: null,
    machine: null,          // running engine.Machine
    last_error: null,
    started_at: 0,
    status_timer: null,
    activity: { disk: false, audio: false },
    /** images that are only in this session (the user did not store them) */
    session_media: new Map(),
    settings: {
        language: "ru",
        last_machine: null,
        keep_media: true,
    },
};

const dom = {};
let display = null;
let serial = null;
let osk = null;
let last_instruction_rate = 0;

/* ------------------------------------------------------------------ helpers */

function selected_machine() {
    return state.machines.find(machine => machine.id === state.selected_id) || null;
}

async function save_machine(machine) {
    machine.modified = Date.now();
    await state.store.put("machines", machine);
    const index = state.machines.findIndex(entry => entry.id === machine.id);
    if (index >= 0) {
        state.machines[index] = machine;
    } else {
        state.machines.push(machine);
    }
    return machine;
}

async function save_settings() {
    await state.store.put("settings", { key: "ui", value: state.settings });
}

function state_key() {
    if (state.last_error) {
        return "state_error";
    }
    if (!state.machine) {
        return "state_stopped";
    }
    if (state.machine.status === "loading") {
        return "state_loading";
    }
    if (state.machine.status === "paused") {
        return "state_paused";
    }
    if (state.machine.status === "starting") {
        return "state_starting";
    }
    return "state_running";
}

function update_status() {
    const machine = selected_machine();
    const running = state.machine;

    dom.status_state.textContent = t(state_key());
    dom.status_state.className = "status-value state-" + (state_key());
    dom.status_machine.textContent = running ? running.machine.name : (machine ? machine.name : "—");
    dom.status_memory.textContent = machine ? `${machine.system.memory_mb} МиБ` : "—";

    const media = running ? running.machine : machine;
    dom.status_media.textContent = media ? (attached_media(media).map(entry => entry.media.name).join(", ") || "—") : "—";

    if (running) {
        const stats = running.media_stats;
        dom.status_read.textContent = format_bytes(stats.read);
        dom.status_instructions.textContent = last_instruction_rate
            ? format_instructions(last_instruction_rate) + "/с" : "—";
        dom.status_uptime.textContent = format_duration(Date.now() - state.started_at);
    } else {
        dom.status_read.textContent = "—";
        dom.status_instructions.textContent = "—";
        dom.status_uptime.textContent = "—";
    }

    dom.activity_disk.classList.toggle("active", state.activity.disk);
    dom.activity_audio.classList.toggle("active", state.activity.audio);

    // power buttons follow the state of the selected machine
    const is_running = !!running;
    const paused = is_running && running.status === "paused";
    dom.btn_start.disabled = is_running;
    dom.btn_stop.disabled = !is_running;
    dom.btn_reset.disabled = !is_running;
    dom.btn_pause.disabled = !is_running;
    dom.btn_pause.textContent = paused ? t("resume") : t("pause");
    dom.btn_settings.disabled = !machine || is_running;
    dom.btn_suspend.disabled = !is_running;
    dom.btn_screenshot.disabled = !is_running;
}

function format_instructions(value) {
    if (value > 1e9) {
        return (value / 1e9).toFixed(2) + " млрд";
    }
    if (value > 1e6) {
        return (value / 1e6).toFixed(1) + " млн";
    }
    if (value > 1e3) {
        return (value / 1e3).toFixed(0) + " тыс";
    }
    return String(value);
}

/* ------------------------------------------------------------ machine list */

function render_machine_list() {
    clear(dom.machine_list);
    if (!state.machines.length) {
        dom.machine_list.appendChild(el("p.empty-hint", { text: t("no_machines") }));
        return;
    }

    for (const machine of state.machines) {
        const running = state.machine && state.machine.machine.id === machine.id;
        const entry = el("div.machine-entry" + (machine.id === state.selected_id ? ".selected" : ""), {
            onclick: () => select_machine(machine.id),
            ondblclick: () => start_machine(),
        }, [
            el("div.machine-icon" + (running ? ".running" : ""), { text: running ? "▶" : "▣" }),
            el("div.machine-text", {}, [
                el("div.machine-name", { text: machine.name }),
                el("div.machine-sub", {
                    text: [machine.system.memory_mb + " МиБ",
                           attached_media(machine).map(entry => entry.media.name).join(", ")]
                        .filter(Boolean).join(" · "),
                }),
            ]),
        ]);
        dom.machine_list.appendChild(entry);
    }
}

function select_machine(id) {
    state.selected_id = id;
    render_machine_list();
    render_details();
    update_status();
}

/* ---------------------------------------------------------------- details */

function render_details() {
    const machine = selected_machine();
    clear(dom.details);

    if (!machine) {
        dom.details.appendChild(el("div.details-empty", {}, [
            el("h2", { text: t("app_name") }),
            el("p", { text: t("app_tagline") }),
            el("p.field-hint", { text: t("host_hint") }),
        ]));
        return;
    }

    const rows = [
        [t("memory"), `${machine.system.memory_mb} МиБ`],
        [t("vram"), `${machine.system.vga_mb} МиБ`],
        [t("boot_order"), t(machine.system.boot_order === "cd" ? "boot_cd" :
            machine.system.boot_order === "hd" ? "boot_hd" : "boot_floppy")],
        [t("audio"), machine.audio.enabled ? t("volume") + " " +
            Math.round(machine.audio.volume * 100) + "%" : "выключен"],
    ];

    for (const entry of attached_media(machine)) {
        rows.push([t(settings.MEDIA_LABELS[entry.kind]),
                   entry.media.size
                       ? `${entry.media.name} (${format_bytes(entry.media.size)})`
                       : `${entry.media.name} (${t("storage_url")})`]);
    }

    const buttons = el("div.details-buttons", {}, [
        el("button.button.primary", {
            type: "button", text: t("start"), onclick: () => start_machine(),
        }),
        el("button.button", {
            type: "button", text: t("settings"), onclick: () => open_settings(machine),
        }),
        el("button.button", {
            type: "button", text: t("rename"), onclick: () => rename_machine(machine),
        }),
        el("button.button", {
            type: "button", text: t("copy"), onclick: () => duplicate_machine(machine),
        }),
        el("button.button.danger", {
            type: "button", text: t("delete"), onclick: () => delete_machine(machine),
        }),
    ]);

    dom.details.appendChild(el("div.details", {}, [
        el("h2", { text: machine.name }),
        el("table.properties", {}, rows.map(([name, value]) =>
            el("tr", {}, [el("th", { text: name }), el("td", { text: value })]))),
        machine.last_error ? el("p.details-error", { text: machine.last_error }) : null,
        buttons,
    ]));
}

/* ------------------------------------------------------------- power actions */

/**
 * Collect what the engine needs for every attached medium: either the image
 * itself (a Blob, from the store or from this session) or an URL to stream it
 * from.
 *
 * @return {Promise<{images: Object, urls: Object, missing: Array<string>}>}
 */
async function images_of(machine) {
    const images = {};
    const urls = {};
    const missing = [];

    for (const kind of Object.keys(MEDIA_KINDS)) {
        const reference = machine.media[kind];
        if (!reference) {
            continue;
        }
        if (is_url_media(reference)) {
            urls[kind] = { url: reference.url, size: reference.size };
            continue;
        }
        let blob = state.session_media.get(reference.id);
        if (!blob) {
            const stored = await state.store.get("media", reference.id);
            blob = stored && stored.blob;
        }
        if (!blob) {
            missing.push(t(settings.MEDIA_LABELS[kind]));
            continue;
        }
        images[kind] = blob;
    }

    return { images: images, urls: urls, missing: missing };
}

async function start_machine() {
    const machine = selected_machine();
    if (!machine || state.machine) {
        return;
    }

    state.last_error = null;
    const { images, urls, missing } = await images_of(machine);
    if (missing.length) {
        toast("Не найдены образы: " + missing.join(", ") + " — подключите их снова", "error");
        open_settings(machine);
        return;
    }

    if (!Object.keys(images).length && !Object.keys(urls).length) {
        toast("У машины нет образов: подключите ISO или образ диска", "error");
        open_settings(machine);
        return;
    }

    const engine = new Machine(machine, images, dom.screen_container, {
        volume: machine.audio.volume,
        urls: urls,
        on_event: handle_engine_event,
    });
    state.machine = engine;
    state.started_at = Date.now();
    engine.status = "starting";

    display.attach(engine);
    dom.screen_empty && (dom.screen_empty.hidden = true);
    display.set_scale(machine.display.scale);
    if (machine.display.virtual_mouse) {
        display.enable_virtual_mouse(true);
    }

    render_machine_list();
    update_status();

    try {
        await engine.start();
        state.machine = engine;
        state.settings.last_machine = machine.id;
        await save_settings();
    } catch (error) {
        state.machine = null;
        display.attach(null);
        dom.screen_empty && (dom.screen_empty.hidden = false);
        console.error("cannot start the machine:", error);
        const message = error instanceof EngineError && error.message === "memory64_unsupported"
            ? t("mem64_unsupported")
            : [error && error.message, error && error.cause && error.cause.message]
                .filter(Boolean).join(": ") || String(error);
        state.last_error = message;
        machine.last_error = message;
        await save_machine(machine);
        toast(message, "error");
    }
    render_machine_list();
    render_details();
    update_status();
}

function handle_engine_event(name, ...args) {
    switch (name) {
        case "state":
            update_status();
            if (args[0] === "stopped" && state.machine && !state.machine.emulator) {
                // the guest stopped on its own (or was switched off)
                state.machine = null;
                display.attach(null);
                render_machine_list();
                render_details();
                update_status();
            }
            break;

        case "serial":
            if (state.machine && state.machine.machine.serial.enabled) {
                serial && serial.put_byte(args[0]);
            }
            break;

        case "screen-size":
            display && display.set_size(args[0]);
            if (dom.status_screen) {
                dom.status_screen.textContent = args[0][2] === 0
                    ? "текст " + args[0][0] + "×" + args[0][1]
                    : args[0][0] + "×" + args[0][1] + "×" + args[0][2];
            }
            break;

        case "pointer-lock":
            if (dom.capture_hint) {
                dom.capture_hint.textContent = args[0] ? t("capture_hint_locked") : t("capture_hint");
            }
            break;

        case "disk-activity":
            state.activity.disk = args[0];
            break;

        case "dac":
            state.activity.audio = args[0];
            break;

        case "download-error":
            toast("Не удалось прочитать образ: " + (args[0] && args[0].message || args[0]), "error");
            break;
    }
}

async function stop_machine() {
    if (!state.machine) {
        return;
    }
    const engine = state.machine;
    state.machine = null;
    display.attach(null);
    dom.screen_empty && (dom.screen_empty.hidden = false);
    await engine.stop();
    state.activity = { disk: false, audio: false };
    render_machine_list();
    update_status();
}

async function reset_machine() {
    if (!state.machine) {
        return;
    }
    if (!await confirm("Перезагрузить гостевую систему (сброс без выключения)?")) {
        return;
    }
    try {
        await state.machine.reset();
        toast("Гостевая система перезагружается");
    } catch (error) {
        console.error("cannot reset the machine:", error);
        const message = [error && error.message, error && error.cause && error.cause.message]
            .filter(Boolean).join(": ") || String(error);
        toast(message, "error");
    }
}

function toggle_pause() {
    if (!state.machine) {
        return;
    }
    if (state.machine.status === "paused") {
        state.machine.resume();
    } else {
        state.machine.pause();
    }
    update_status();
}

/**
 * Suspend: write the whole machine state (memory and devices) into the store,
 * so it can be resumed later, exactly like the "save state" button of
 * VirtualBox.
 */
async function suspend_machine() {
    if (!state.machine) {
        return;
    }
    const engine = state.machine;
    const name = await prompt_text({
        title: t("snapshot_now"),
        label: t("snapshot_name"),
        value: new Date().toLocaleString(),
        ok: t("save"),
    });
    if (name === null) {
        return;
    }

    toast("Сохраняю состояние…");
    const started = Date.now();
    try {
        const blob = await engine.save_state();
        const record = {
            id: new_id("state-"),
            machine_id: engine.machine.id,
            name: name || new Date().toLocaleString(),
            created: Date.now(),
            memory_mb: engine.machine.system.memory_mb,
            data: blob,
        };
        await state.store.put("states", record);
        engine.machine.state = { id: record.id, name: record.name, created: record.created,
                                 memory_mb: record.memory_mb };
        await save_machine(engine.machine);
        toast(t("snapshot_created", { name: record.name }) + " · " +
              format_bytes(blob.size) + " за " + ((Date.now() - started) / 1000).toFixed(1) + " с",
              "success");
    } catch (error) {
        console.error(error);
        toast("Не удалось сохранить состояние: " + (error && error.message || error), "error");
    }
}

/** Restore a saved state into the running machine. */
async function restore_state(record) {
    if (!state.machine) {
        toast("Сначала запустите машину, затем восстанавливайте состояние", "error");
        return;
    }
    if (record.memory_mb && record.memory_mb !== state.machine.machine.system.memory_mb) {
        toast(t("restore_memory_mismatch", {
            was: record.memory_mb + " МиБ",
            now: state.machine.machine.system.memory_mb + " МиБ",
        }), "error");
        return;
    }
    if (!await confirm(t("restore_confirm", { name: record.name }))) {
        return;
    }
    try {
        await state.machine.restore_state(record.data);
        toast("Состояние восстановлено", "success");
    } catch (error) {
        console.error(error);
        toast("Не удалось восстановить состояние: " + (error && error.message || error), "error");
    }
}

/* ---------------------------------------------------------------- machines */

async function new_machine_wizard() {
    const machine = create_machine({ name: "x86-64 Linux" });
    const pages = [];
    let step = 0;

    const content = el("div.wizard");
    const footer_nav = el("div.wizard-nav");
    content.appendChild(el("p.field-hint", { text: t("wizard_hint") }));
    const step_label = el("div.wizard-step");
    const page_container = el("div.wizard-page");
    content.append(step_label, page_container, footer_nav);

    const media_handlers = {
        pick: kind => attach_media(machine, kind, () => rebuild()),
        pick_url: kind => attach_media_url(machine, kind, () => rebuild()),
        eject: kind => eject_media(machine, kind, () => rebuild()),
        create_blank: kind => create_blank_disk(machine, kind, () => rebuild()),
        refresh: () => rebuild(),
    };

    function build_pages() {
        pages.length = 0;
        pages.push({ title: t("wizard_step_system"), page: settings.system_page(machine) });
        pages.push({ title: t("wizard_step_media"), page: settings.media_page(machine, media_handlers) });
        pages.push({
            title: t("wizard_step_display"),
            page: (() => {
                const display_page = settings.display_page(machine);
                const audio_page = settings.audio_page(machine);
                const element = el("div", {}, [display_page.element, audio_page.element]);
                return { element: element, collect: () => { display_page.collect(); audio_page.collect(); return machine; } };
            })(),
        });
    }

    function rebuild() {
        build_pages();
        render_step();
    }

    function render_step() {
        page_container.replaceChildren(pages[step].page.element);
        step_label.textContent = `${t("step_of", { step: step + 1, total: pages.length })} · ${pages[step].title}`;
        clear(footer_nav);
        footer_nav.append(
            el("button.button", {
                type: "button", text: t("back"), disabled: step === 0,
                onclick: () => { step--; render_step(); },
            }),
            el("button.button.primary", {
                type: "button", text: step === pages.length - 1 ? t("create") : "Далее",
                onclick: async () => {
                    pages[step].page.collect();
                    if (step < pages.length - 1) {
                        step++;
                        render_step();
                    } else {
                        await create_machine_now();
                    }
                },
            }),
        );
    }

    const name_input = el("input.input", { type: "text", value: machine.name });
    name_input.addEventListener("input", () => { machine.name = name_input.value; });

    build_pages();
    render_step();

    const controller = dialog({
        title: t("wizard_title"),
        wide: true,
        content: el("div", {}, [
            el("label.field", {}, [el("span.field-label", { text: t("machine_name") }), name_input]),
            content,
        ]),
        buttons: [{ label: t("cancel"), action: () => false }],
    });

    async function create_machine_now() {
        machine.name = name_input.value;
        for (const entry of pages) {
            entry.page.collect();
        }
        finalize_machine(machine, "x86-64");
        await save_machine(machine);
        state.selected_id = machine.id;
        controller.close();
        render_machine_list();
        render_details();
        update_status();
        toast("Машина создана: " + machine.name, "success");
    }
}

async function rename_machine(machine) {
    const name = await prompt_text({ title: t("rename"), label: t("machine_name"), value: machine.name });
    if (name === null || !name) {
        return;
    }
    machine.name = name;
    await save_machine(machine);
    render_machine_list();
    render_details();
    update_status();
}

async function duplicate_machine(machine) {
    const copy = JSON.parse(JSON.stringify(machine));
    copy.id = new_id("vm-");
    copy.name = machine.name + " (копия)";
    copy.created = Date.now();
    // the images themselves are shared, they are immutable blobs in the store
    await save_machine(copy);
    select_machine(copy.id);
    toast("Машина скопирована", "success");
}

async function delete_machine(machine) {
    if (!await confirm(`Удалить машину «${machine.name}»? Образы останутся в хранилище.`,
                       { danger: true, ok: t("delete") })) {
        return;
    }
    await state.store.delete("machines", machine.id);
    state.machines = state.machines.filter(entry => entry.id !== machine.id);

    // states belong to the machine
    const states = await state.store.get_all("states");
    for (const record of states) {
        if (record.machine_id === machine.id) {
            await state.store.delete("states", record.id);
        }
    }

    if (state.selected_id === machine.id) {
        state.selected_id = state.machines.length ? state.machines[0].id : null;
    }
    render_machine_list();
    render_details();
    update_status();
}

/* ------------------------------------------------------------------- media */

/**
 * Put an image into the store (or keep it for this session only).
 * @return {Promise<Object>} the media reference to keep in the machine
 */
async function store_media(file, kind) {
    const reference = {
        id: new_id("media-"),
        name: file.name || (kind + ".img"),
        size: file.size,
        kind: guess_kind(file),
        writable: kind !== "cdrom",
        storage: "session",
    };

    const space = await can_store(file, state.store);
    const keep = state.settings.keep_media && space.ok;

    if (keep) {
        try {
            await state.store.put("media", {
                id: reference.id,
                name: reference.name,
                size: file.size,
                kind: reference.kind,
                created: Date.now(),
                blob: file,
            });
            reference.storage = "browser";
        } catch (error) {
            console.warn("cannot store the image:", error);
            state.session_media.set(reference.id, file);
            toast("Образ не поместился в хранилище браузера — он будет доступен только в этой сессии",
                  "error");
        }
    } else {
        state.session_media.set(reference.id, file);
        if (!space.ok && state.settings.keep_media) {
            toast(t("not_enough_space", {
                need: format_bytes(file.size),
                free: format_bytes(space.free || 0),
            }), "error");
        }
    }

    return reference;
}

/**
 * @param {Object} machine
 * @param {string} kind
 * @param {function()=} refresh
 */
async function attach_media(machine, kind, refresh) {
    const spec = MEDIA_KINDS[kind];
    const files = await pick_files(spec.accept);
    if (!files.length) {
        return;
    }
    const file = files[0];
    const reference = await store_media(file, kind);

    if (kind === "cdrom" && state.machine && state.machine.machine.id === machine.id) {
        try {
            await state.machine.set_cdrom(file, file.name);
            toast("Образ подключён к работающей машине", "success");
        } catch (error) {
            toast("Не удалось подключить образ: " + (error && error.message || error), "error");
        }
    }

    machine.media[kind] = reference;
    await save_machine(machine);
    refresh && refresh();
    render_details();
    update_status();
}

/**
 * Attach an image that lives on a server. The emulator reads it with HTTP range
 * requests, so a large ISO does not have to be downloaded or copied into the
 * browser storage first.
 */
/**
 * Ask a server how big the image behind a URL is. A missing Content-Length
 * (chunked responses, some CDNs) simply leaves the size unknown.
 *
 * @param {string} url
 * @return {Promise<number>}
 */
async function probe_size(url) {
    try {
        const response = await fetch(url, { method: "HEAD" });
        return parseInt(response.headers.get("content-length") || "0", 10) || 0;
    } catch (error) {
        return 0;
    }
}

async function attach_media_url(machine, kind, refresh, preset_url) {
    let url = preset_url;
    let size = 0;

    if (!url) {
        const answer = await prompt_text({
            title: t("attach_url"),
            label: "https://… (ISO или образ диска)",
            value: "",
            ok: t("attach"),
        });
        if (!answer) {
            return;
        }
        url = answer.trim();
    }
    if (!/^https?:\/\//i.test(url)) {
        toast("Нужна ссылка http:// или https://", "error");
        return;
    }

    // ask the server for the size; it also tells us early whether the URL works
    try {
        const response = await fetch(url, { method: "HEAD" });
        size = parseInt(response.headers.get("content-length") || "0", 10);
        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }
    } catch (error) {
        console.warn("cannot check the image:", error);
        if (!await confirm("Не удалось проверить ссылку (" + (error && error.message || error) +
                           "). Подключить всё равно?")) {
            return;
        }
    }

    const name = decodeURIComponent(url.split("/").pop() || "image.iso").split("?")[0];
    machine.media[kind] = {
        id: new_id("url-"),
        name: name,
        size: size,
        url: url,
        storage: "url",
        writable: false,
    };
    await save_machine(machine);
    refresh && refresh();
    render_details();
    update_status();
    toast(`Образ подключён по ссылке: ${name}`, "success");
}

async function eject_media(machine, kind, refresh) {
    const reference = machine.media[kind];
    machine.media[kind] = null;
    await save_machine(machine);

    if (state.machine && state.machine.machine.id === machine.id) {
        if (kind === "cdrom") {
            state.machine.eject_cdrom();
        } else if (kind === "fda") {
            state.machine.eject_fda();
        } else {
            toast("Образ отключён — изменения вступят в силу после перезапуска машины");
        }
    }

    refresh && refresh();
    render_details();
    update_status();
    void reference;
}

/** A blank disk image is a sparse blob, it costs no memory. */
async function create_blank_disk(machine, kind, refresh) {
    const size_text = await prompt_text({
        title: t("create_blank"),
        label: t("blank_size") + " (МиБ)",
        value: "2048",
        ok: t("create"),
    });
    if (size_text === null) {
        return;
    }
    const megabytes = Math.max(1, Math.min(65536, parseInt(size_text, 10) || 0));
    if (!megabytes) {
        return;
    }

    const size = megabytes * 1024 * 1024;
    // A partitioned image, not just zeros: the guest has to find a disk it can
    // partition itself, so an empty image (all zeros, no MBR) is what we want.
    const blob = blank_image(size);
    const file = blob_as_file(blob, `${machine.name.replace(/\s+/g, "-")}-${megabytes}m.img`);
    const reference = await store_media(file, kind);
    machine.media[kind] = reference;
    await save_machine(machine);
    refresh && refresh();
    render_details();
    update_status();
    toast(`Создан пустой образ ${megabytes} МиБ`, "success");
}

/* -------------------------------------------------------------- snapshots */

async function open_snapshots(machine) {
    const records = (await state.store.get_all("states"))
        .filter(record => record.machine_id === machine.id)
        .sort((a, b) => b.created - a.created);

    const list = el("div.snapshot-list");
    if (!records.length) {
        list.appendChild(el("p.empty-hint", { text: t("no_snapshots") }));
    }

    for (const record of records) {
        list.appendChild(el("div.snapshot-entry", {}, [
            el("div.snapshot-text", {}, [
                el("div.snapshot-name", { text: record.name }),
                el("div.snapshot-sub", {
                    text: new Date(record.created).toLocaleString() + " · " +
                        format_bytes(record.data.size) + " · " + record.memory_mb + " МиБ",
                }),
            ]),
            el("div.snapshot-buttons", {}, [
                el("button.button.small", {
                    type: "button", text: t("restore"),
                    onclick: () => restore_state(record),
                }),
                el("button.button.small", {
                    type: "button", text: t("export"),
                    onclick: () => download_blob(record.data,
                        `${machine.name}-${record.name}.state`.replace(/\s+/g, "-")),
                }),
                el("button.button.small.danger", {
                    type: "button", text: t("delete"),
                    onclick: async () => {
                        await state.store.delete("states", record.id);
                        toast("Снимок удалён");
                        controller.close();
                        open_snapshots(machine);
                    },
                }),
            ]),
        ]));
    }

    const controller = dialog({
        title: t("snapshots") + " — " + machine.name,
        wide: true,
        content: el("div", {}, [el("p.field-hint", { text: t("snapshot_help") }), list]),
        buttons: [
            { label: t("snapshot_now"), action: async () => { await suspend_machine(); return false; } },
            { label: t("close"), primary: true },
        ],
    });
}

/* --------------------------------------------------------------- settings */

function open_settings(machine) {
    const pages = new Map();
    let current_page = "system";

    const container = el("div.settings");
    const page_host = el("div.settings-page");

    const media_handlers = {
        pick: kind => attach_media(machine, kind, () => refresh_page("media")),
        pick_url: kind => attach_media_url(machine, kind, () => refresh_page("media")),
        eject: kind => eject_media(machine, kind, () => refresh_page("media")),
        create_blank: kind => create_blank_disk(machine, kind, () => refresh_page("media")),
        refresh: () => refresh_page("media"),
    };

    function build_page(id) {
        switch (id) {
            case "system": return settings.system_page(machine);
            case "media": return settings.media_page(machine, media_handlers);
            case "display": return settings.display_page(machine);
            case "audio": return settings.audio_page(machine);
            case "network": return settings.network_page(machine);
            case "serial": return settings.serial_page(machine);
            default: return settings.system_page(machine);
        }
    }

    function refresh_page(id) {
        pages.set(id, build_page(id));
        if (id === current_page) {
            page_host.replaceChildren(pages.get(id).element);
        }
    }

    const tabs = tabbar([
        { id: "system", label: t("wizard_step_system") },
        { id: "media", label: t("media") },
        { id: "display", label: t("display") },
        { id: "audio", label: t("audio") },
        { id: "network", label: t("network") },
        { id: "serial", label: t("serial") },
    ], id => {
        if (pages.has(current_page)) {
            pages.get(current_page).collect();
        }
        current_page = id;
        refresh_page(id);
    });

    refresh_page("system");
    container.append(tabs.element, page_host);

    dialog({
        title: t("settings") + " — " + machine.name,
        wide: true,
        content: container,
        buttons: [
            {
                label: t("snapshots"),
                action: () => { open_snapshots(machine); return false; },
            },
            { label: t("cancel"), action: () => false },
            {
                label: t("save"),
                primary: true,
                action: async () => {
                    for (const page of pages.values()) {
                        page.collect();
                    }
                    await save_machine(machine);
                    if (state.machine && state.machine.machine.id === machine.id) {
                        state.machine.set_volume(machine.audio.volume);
                        display.set_scale(machine.display.scale);
                        display.enable_virtual_mouse(machine.display.virtual_mouse);
                    }
                    render_machine_list();
                    render_details();
                    update_status();
                },
            },
        ],
    });
}

/* -------------------------------------------------------------- toolbars */

function bind_toolbar() {
    dom.btn_new.addEventListener("click", () => new_machine_wizard());
    dom.btn_start.addEventListener("click", () => start_machine());
    dom.btn_stop.addEventListener("click", () => stop_machine());
    dom.btn_reset.addEventListener("click", () => reset_machine());
    dom.btn_pause.addEventListener("click", () => toggle_pause());
    dom.btn_settings.addEventListener("click", () => {
        const machine = selected_machine();
        machine && open_settings(machine);
    });
    dom.btn_suspend.addEventListener("click", () => suspend_machine());
    dom.btn_snapshots.addEventListener("click", () => {
        const machine = selected_machine();
        machine && open_snapshots(machine);
    });
    dom.btn_screenshot.addEventListener("click", async () => {
        const blob = display ? await display.screenshot() : null;
        if (blob) {
            download_blob(blob, `${(selected_machine() || {}).name || "screen"}-screen.png`);
        } else {
            toast("Снимок экрана недоступен", "error");
        }
    });
    dom.btn_language.addEventListener("click", async () => {
        const codes = languages.map(language => language.code);
        const next = codes[(codes.indexOf(get_language()) + 1) % codes.length];
        set_language(next);
        state.settings.language = next;
        await save_settings();
        location.reload();
    });

    dom.btn_fullscreen.addEventListener("click", () => display.toggle_fullscreen());
    dom.btn_ctrl_alt_del.addEventListener("click", () => state.machine && state.machine.send_ctrl_alt_del());
    dom.btn_keyboard.addEventListener("click", () => {
        // only one panel at a time: on a phone they are overlays on the guest
        // screen and would hide each other anyway
        const show = dom.osk_panel.classList.contains("hidden");
        dom.osk_panel.classList.toggle("hidden", !show);
        if (show) {
            dom.serial_panel.classList.add("hidden");
        }
    });
    dom.btn_mouse.addEventListener("click", () => {
        const machine = selected_machine();
        const enabled = !(machine && machine.display.virtual_mouse);
        if (machine) {
            machine.display.virtual_mouse = enabled;
            save_machine(machine);
        }
        display.enable_virtual_mouse(enabled);
        toast(enabled ? "Виртуальная мышь включена" : "Мышь захватывается кликом");
    });
    dom.btn_serial.addEventListener("click", () => {
        const show = dom.serial_panel.classList.contains("hidden");
        dom.serial_panel.classList.toggle("hidden", !show);
        if (show) {
            dom.osk_panel.classList.add("hidden");
        }
        const machine = selected_machine();
        if (machine) {
            machine.serial.enabled = show;
            save_machine(machine);
        }
    });
    dom.btn_paste.addEventListener("click", async () => {
        const text = await prompt_text({ title: t("paste"), label: t("paste_help") });
        if (text && state.machine) {
            state.machine.send_text(text);
        }
    });

    dom.btn_scale.addEventListener("click", () => {
        const machine = selected_machine();
        const order = ["fit", "1", "2"];
        const current = machine ? machine.display.scale : "fit";
        const next = order[(order.indexOf(current) + 1) % order.length];
        if (machine) {
            machine.display.scale = next;
            save_machine(machine);
        }
        display.set_scale(next);
        const labels = { fit: t("scale_fit"), "1": t("scale_1x"), "2": t("scale_2x") };
        dom.btn_scale.textContent = labels[next];
    });
}

function bind_serial_panel() {
    dom.serial_send.addEventListener("click", () => {
        if (!state.machine) {
            return;
        }
        state.machine.serial_send(dom.serial_input.value + "\n");
        serial.put_text("> " + dom.serial_input.value + "\n");
        dom.serial_input.value = "";
    });
    dom.serial_input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            dom.serial_send.click();
        }
        event.stopPropagation();
    });
    dom.serial_clear.addEventListener("click", () => serial.clear());
    dom.serial_download.addEventListener("click", () => {
        download_blob(serial.to_blob(), `com1-${Date.now()}.log`);
    });
}

/**
 * What kind of image was dropped on the workspace?  The file name decides most
 * of it; a Linux kernel is recognised by its own header instead, so a file
 * called image.bin or kernel still boots as a kernel.
 *
 * @param {File} file
 * @return {Promise<string>} "iso" | "hdd" | "floppy" | "kernel"
 */
async function classify_drop(file) {
    const named = guess_kind(file);
    if (named === "kernel") {
        return "kernel";
    }
    return (await looks_like_kernel(file)) ? "kernel" : named;
}

function bind_drop_target() {
    make_drop_target(dom.workspace, {
        on_hover: hover => dom.drop_overlay.classList.toggle("visible", hover),
        on_files: async files => {
            const file = files[0];
            const kind = await classify_drop(file);
            const machine = selected_machine();
            if (!machine) {
                toast("Сначала создайте машину", "error");
                return;
            }
            const media_kind = kind === "iso" ? "cdrom"
                : kind === "floppy" ? "fda"
                : kind === "kernel" ? "kernel"
                : "hda";
            const reference = await store_media(file, media_kind);
            machine.media[media_kind] = reference;
            await save_machine(machine);
            render_machine_list();
            render_details();
            update_status();
            toast(`Образ подключён: ${file.name} → ${t(settings.MEDIA_LABELS[media_kind])}`, "success");
        },
    });
}

/* ------------------------------------------------------------------ start */

async function main() {
    for (const [key, id] of Object.entries({
        machine_list: "machine-list", details: "machine-details", workspace: "workspace",
        screen_container: "screen_container", status_state: "status-state",
        status_machine: "status-machine", status_memory: "status-memory",
        status_media: "status-media", status_read: "status-read",
        status_instructions: "status-instructions", status_uptime: "status-uptime",
        status_screen: "status-screen", activity_disk: "activity-disk",
        activity_audio: "activity-audio",
        btn_new: "btn-new", btn_start: "btn-start", btn_stop: "btn-stop",
        btn_reset: "btn-reset", btn_pause: "btn-pause", btn_settings: "btn-settings",
        btn_suspend: "btn-suspend", btn_snapshots: "btn-snapshots",
        btn_screenshot: "btn-screenshot", btn_language: "btn-language",
        btn_fullscreen: "btn-fullscreen", btn_ctrl_alt_del: "btn-ctrl-alt-del",
        btn_keyboard: "btn-keyboard", btn_mouse: "btn-mouse", btn_serial: "btn-serial",
        btn_paste: "btn-paste", btn_scale: "btn-scale",
        serial_panel: "serial-panel", serial_output: "serial-output",
        serial_input: "serial-input", serial_send: "serial-send",
        serial_clear: "serial-clear", serial_download: "serial-download",
        osk_panel: "osk-panel", drop_overlay: "drop-overlay",
        capture_hint: "capture-hint", status_storage: "status-storage",
        screen_empty: "screen-empty",
    })) {
        dom[key] = document.getElementById(id);
        if (!dom[key]) {
            console.warn("missing element #" + id);
        }
    }

    state.store = await open_store();

    const stored_settings = await state.store.get("settings", "ui");
    if (stored_settings && stored_settings.value) {
        Object.assign(state.settings, stored_settings.value);
    }
    set_language(state.settings.language);
    translate_dom(document);
    document.documentElement.lang = get_language();

    state.machines = (await state.store.get_all("machines"))
        .sort((a, b) => (a.created || 0) - (b.created || 0));

    display = new Display(dom.screen_container, {
        on_capture: locked => {
            dom.capture_hint && (dom.capture_hint.textContent = locked
                ? t("capture_hint_locked") : t("capture_hint"));
        },
    });
    serial = new SerialConsole(dom.serial_output, {
        on_send: text => state.machine && state.machine.serial_send(text),
    });
    osk = new OnScreenKeyboard(dom.osk_panel, {
        on_key: codes => state.machine && state.machine.send_keys(codes),
    });

    dom.osk_panel.classList.add("hidden");
    if (!state.machines.length) {
        dom.serial_panel.classList.add("hidden");
    }

    if (state.machines.length) {
        const last = state.machines.find(machine => machine.id === state.settings.last_machine);
        state.selected_id = (last || state.machines[0]).id;
    }

    bind_toolbar();
    bind_serial_panel();
    bind_drop_target();

    render_machine_list();
    render_details();
    update_status();
    dom.btn_scale.textContent = {
        fit: t("scale_fit"), "1": t("scale_1x"), "2": t("scale_2x"),
    }[(selected_machine() || { display: { scale: "fit" } }).display.scale];

    // Offline support and installation as an app. Registration fails in some
    // sandboxes and in private windows, that is not fatal.
    const no_service_worker = new URLSearchParams(location.search).has("nosw");
    if (!no_service_worker && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
        navigator.serviceWorker.register("sw.js").catch(error => {
            console.warn("service worker not registered:", error);
        });
    }

    request_persistent_storage().then(persisted => {
        if (persisted) {
            console.log("storage is persistent");
        }
    });

    storage_info(state.store).then(info => {
        if (info.quota) {
            dom.status_storage.textContent = t("storage_used", {
                used: format_bytes(info.usage),
                quota: format_bytes(info.quota),
            });
        }
    });

    state.status_timer = setInterval(() => {
        if (state.machine) {
            last_instruction_rate = state.machine.poll_instructions();
        }
        display && display.maintain();
        update_status();
    }, 1000);

    // deep link: #vm=<id> selects a machine, #vm=<id>&start starts it
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const wanted = params.get("vm");
    if (wanted && state.machines.some(machine => machine.id === wanted)) {
        select_machine(wanted);
        if (params.get("start") !== null) {
            await start_machine();
        }
    }

    // ?demo=<url of an ISO or of a kernel> (or one of the names below, for the
    // images that ship with the repository) creates a machine and boots it,
    // which is handy for a quick look at the emulator without attaching
    // anything by hand.  ?demo=linux boots the real Linux guest image from
    // emulator/images and needs nothing else at all; ?demo=cd boots the same
    // Linux from the CD in that directory, through the BIOS, the way a real
    // machine (and a real ISO from the user's device) boots it.
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo !== null) {
        const images = {
            "": { kind: "cdrom", file: "long-mode-test.iso" },
            "1": { kind: "cdrom", file: "long-mode-test.iso" },
            "iso": { kind: "cdrom", file: "long-mode-test.iso" },
            "2": { kind: "cdrom", file: "long-mode-gfx-test.iso" },
            "gfx": { kind: "cdrom", file: "long-mode-gfx-test.iso" },
            "64": { kind: "kernel", dir: "images/", file: "linux-6.6-x86_64.bzImage" },
            "linux": { kind: "kernel", dir: "images/", file: "linux-6.6-x86_64.bzImage" },
            // the CD that carries the same kernel: SeaBIOS reads the El Torito
            // entry, the loader in it starts the kernel off the CD.  This is the
            // way a real machine (and a real ISO from the user's device) boots,
            // and it needs the memory the kernel decompresses into.
            "cd": { kind: "cdrom", dir: "images/", file: "linux-6.6-x86_64.iso",
                memory_mb: 256 },
            "linux-iso": { kind: "cdrom", dir: "images/", file: "linux-6.6-x86_64.iso",
                memory_mb: 256 },
        };
        const known = images[demo];
        const url = known
            ? new URL((known.dir || "../build/emulator-tests/") + known.file, location.href).href
            : demo;
        const machine = create_machine({ name: "Демонстрация x86-64" });
        const kind = known ? known.kind : "cdrom";
        machine.media[kind] = {
            id: new_id("url-"), name: url.split("/").pop(), size: await probe_size(url),
            url: url, storage: "url", writable: false,
        };
        if (kind === "kernel") {
            // a kernel boot wants a bit of memory and a command line; 64 MiB
            // would be enough, but 512 MiB leaves room for a big initramfs
            machine.system.memory_mb = Math.max(machine.system.memory_mb, 512);
            machine.system.cmdline = DEFAULT_KERNEL_CMDLINE;
        }
        if (known && known.memory_mb) {
            // a CD boot needs what the kernel decompresses into (init_size)
            machine.system.memory_mb = Math.max(machine.system.memory_mb, known.memory_mb);
        }
        finalize_machine(machine, "Демонстрация");
        await save_machine(machine);
        select_machine(machine.id);
        toast("Демонстрационный образ: " + machine.media[kind].name);
        await start_machine();
    }

    window.addEventListener("beforeunload", event => {
        if (state.machine) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    // the browser throws away frames of the guest while the tab is hidden in
    // some configurations, warn instead of leaving the user with a frozen screen
    document.addEventListener("visibilitychange", () => {
        if (document.hidden && state.machine && state.machine.status === "running") {
            console.log("tab hidden, emulation continues (this can be slow on phones)");
        }
    });
}

/*
 * A minimal handle for the browser console and for the automated UI test in
 * emulator/tests/ui_test.mjs. Everything it exposes is a function the UI itself
 * calls, so there is no second code path to keep in sync.
 */
const debug_api = {
    state: state,
    store: () => state.store,
    select_machine: select_machine,
    start_machine: start_machine,
    stop_machine: stop_machine,
    reset_machine: reset_machine,
    toggle_pause: toggle_pause,
    suspend_machine: suspend_machine,
    save_machine: save_machine,
    new_machine: async patch => {
        const machine = create_machine(patch);
        finalize_machine(machine, "x86-64");
        await save_machine(machine);
        select_machine(machine.id);
        return machine;
    },
    /** Attach an image to the selected machine from the console. */
    attach_blob: async (kind, blob, name) => {
        if (!MEDIA_KINDS[kind]) {
            throw new Error("unknown media kind: " + kind);
        }
        const machine = selected_machine();
        if (!machine) {
            throw new Error("no machine selected");
        }
        const reference = await store_media(blob_as_file(blob, name || kind + ".img"), kind);
        machine.media[kind] = reference;
        await save_machine(machine);
        render_details();
        update_status();
        return reference;
    },
    /** Attach an image that is streamed from a URL (range requests). */
    attach_url: async (kind, url) => attach_media_url(selected_machine(), kind, null, url),
    /** Everything the guest printed on COM1 so far. */
    serial_text: () => (serial ? serial.text : ""),
    display: () => display,
    media: () => state.machine && state.machine.media_buffers,
};

window.OpenxISO = debug_api;

window.addEventListener("DOMContentLoaded", () => {
    main().catch(error => {
        console.error(error);
        toast("Ошибка запуска приложения: " + (error && error.message || error), "error");
    });
});

export { main, state };
