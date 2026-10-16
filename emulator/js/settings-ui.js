/*
 * The pages that configure a machine: they are used by the "new machine"
 * wizard (one step per page) and by the settings dialog of an existing
 * machine (one tab per page), so the two can never drift apart.
 *
 * Every page function returns { element, collect }, where collect() writes the
 * values back into the machine definition and returns it.
 */

import { t } from "./i18n.js";
import { format_bytes } from "./files.js";
import {
    MEDIA_KINDS, MEMORY_CHOICES, MAX_MEMORY_STANDARD, VRAM_CHOICES,
    attached_media, needs_memory64, DEFAULT_KERNEL_CMDLINE,
} from "./machine.js";
import { MEMORY64_SUPPORTED } from "./engine.js";
import { checkbox, el, field, select } from "./ui.js";

/** How the media kinds are called in the UI. */
export const MEDIA_LABELS = {
    kernel: "kernel",
    cdrom: "cdrom",
    hda: "hdd",
    hdb: "hdd2",
    fda: "floppy",
};

/**
 * @param {Object} machine
 * @return {{element: HTMLElement, collect: function(): Object}}
 */
export function system_page(machine) {
    const memory = select(MEMORY_CHOICES.map(mb => ({
        value: String(mb),
        label: `${mb} МиБ${mb > MAX_MEMORY_STANDARD ? " (memory64)" : ""}`,
    })), String(machine.system.memory_mb), value => {
        machine.system.memory_mb = parseInt(value, 10);
        update_hint();
    });

    const memory_hint = el("span.field-hint");
    function update_hint() {
        if (!needs_memory64(machine)) {
            memory_hint.textContent = t("engine_help");
            memory_hint.classList.remove("warning");
        } else if (MEMORY64_SUPPORTED) {
            memory_hint.textContent = t("mem64_needed", { mb: machine.system.memory_mb });
            memory_hint.classList.add("warning");
        } else {
            memory_hint.textContent = t("mem64_unsupported");
            memory_hint.classList.add("warning");
        }
    }
    update_hint();

    const vram = select(VRAM_CHOICES.map(mb => ({ value: String(mb), label: `${mb} МиБ` })),
        String(machine.system.vga_mb), value => { machine.system.vga_mb = parseInt(value, 10); });

    const boot = select([
        { value: "cd", label: t("boot_cd") },
        { value: "hd", label: t("boot_hd") },
        { value: "floppy", label: t("boot_floppy") },
    ], machine.system.boot_order, value => { machine.system.boot_order = value; });

    // the command line only matters for a kernel boot (media.kernel), but it
    // is part of the system, not of a medium, so it lives on this page
    const cmdline = el("input.input", {
        type: "text", spellcheck: "false", autocomplete: "off",
        placeholder: DEFAULT_KERNEL_CMDLINE,
        value: machine.system.cmdline || "",
        oninput: event => { machine.system.cmdline = event.target.value.trim(); },
    });

    const acpi = checkbox(t("acpi"), machine.system.acpi, value => { machine.system.acpi = value; });
    const fastboot = checkbox(t("fastboot"), machine.system.fastboot,
        value => { machine.system.fastboot = value; });

    const element = el("div.page", {}, [
        field(t("memory"), memory, null),
        memory_hint,
        field(t("vram"), vram),
        field(t("boot_order"), boot),
        field(t("cmdline"), cmdline, t("cmdline_hint")),
        el("div.page-row", {}, [acpi, fastboot]),
        el("div.engine-info", {}, [
            el("strong", { text: t("engine_name") }),
            el("p", { text: t("engine_help") }),
        ]),
    ]);

    return { element: element, collect: () => machine };
}

/**
 * One row per media slot.
 *
 * @param {string} kind
 * @param {Object} machine
 * @param {{pick: function(string), eject: function(string), create_blank: function(string),
 *          refresh: function()}} handlers
 */
export function media_row(kind, machine, handlers) {
    const media = machine.media[kind];
    const label = t(MEDIA_LABELS[kind]);

    const status = media
        ? el("span.media-name", {
            text: `${media.name} · ${format_bytes(media.size)}` +
                (media.storage === "browser" ? "" : " · " + "сессия"),
            title: media.name,
        })
        : el("span.media-name.empty", { text: t("no_media") });

    const buttons = el("div.media-buttons", {}, [
        el("button.button.small", {
            type: "button",
            text: media ? "Заменить…" : t("attach") + "…",
            onclick: () => handlers.pick(kind),
        }),
        el("button.button.small", {
            type: "button",
            text: t("attach_url") + "…",
            onclick: () => handlers.pick_url(kind),
        }),
        media ? el("button.button.small", {
            type: "button",
            text: t("eject"),
            onclick: () => handlers.eject(kind),
        }) : null,
        kind !== "cdrom" && kind !== "kernel" ? el("button.button.small", {
            type: "button",
            text: t("create_blank") + "…",
            onclick: () => handlers.create_blank(kind),
        }) : null,
    ]);

    const details = el("div.media-details", {}, [
        el("div.media-head", {}, [
            el("span.media-kind", { text: label }),
            status,
        ]),
        buttons,
    ]);

    if (kind === "kernel") {
        details.appendChild(el("div.media-hint", {}, [
            el("span.field-hint", { text: t("kernel_hint") }),
        ]));
    }

    if (media) {
        details.appendChild(el("div.media-write", {}, [
            media.writable === false
                ? el("span.field-hint", { text: "образ только для чтения, изменения хранятся отдельно" })
                : null,
        ]));
    }

    return details;
}

/**
 * @param {Object} machine
 * @param {Object} handlers see media_row
 */
export function media_page(machine, handlers) {
    const list = el("div.media-list");
    const element = el("div.page", {}, [list]);

    const refresh = () => {
        list.replaceChildren();
        // the kernel image first: it is what makes the machine boot a real
        // Linux kernel straight from the phone's storage
        for (const kind of ["kernel", "cdrom", "hda", "hdb", "fda"]) {
            list.appendChild(media_row(kind, machine, {
                pick: handlers.pick,
                pick_url: handlers.pick_url || (() => {}),
                eject: handlers.eject,
                create_blank: handlers.create_blank,
                refresh: refresh,
            }));
        }
    };
    refresh();

    return { element: element, collect: () => machine, refresh: refresh };
}

/** Display: how the guest screen is scaled, and the virtual mouse. */
export function display_page(machine) {
    const scale = select([
        { value: "fit", label: t("scale_fit") },
        { value: "1", label: t("scale_1x") },
        { value: "2", label: t("scale_2x") },
    ], machine.display.scale, value => { machine.display.scale = value; });

    const virtual_mouse = checkbox(t("mouse_virtual"), machine.display.virtual_mouse,
        value => { machine.display.virtual_mouse = value; });

    const element = el("div.page", {}, [
        field(t("display"), scale),
        virtual_mouse,
        el("p.field-hint", { text: t("mouse_virtual_help") }),
    ]);

    return { element: element, collect: () => machine };
}

/** Audio: on/off and the master volume. */
export function audio_page(machine) {
    const volume = el("input.range", {
        type: "range", min: "0", max: "1.5", step: "0.05",
        value: String(machine.audio.volume),
    });
    const value_label = el("span.range-value", { text: Math.round(machine.audio.volume * 100) + "%" });
    volume.addEventListener("input", () => {
        machine.audio.volume = parseFloat(volume.value);
        value_label.textContent = Math.round(machine.audio.volume * 100) + "%";
    });

    const enabled = checkbox(t("audio_enabled"), machine.audio.enabled,
        value => { machine.audio.enabled = value; });

    return {
        element: el("div.page", {}, [
            enabled,
            field(t("volume"), el("div.range-row", {}, [volume, value_label])),
            el("p.field-hint", {
                text: "Sound Blaster 16 и PC Speaker: звук в гостевой системе " +
                    "выводится через Web Audio, громкость браузера остаётся вашей.",
            }),
        ]),
        collect: () => machine,
    };
}

/** Network: mostly "off", because a relay is needed for anything else. */
export function network_page(machine) {
    const device = select([
        { value: "none", label: t("network_none") },
        { value: "ne2k", label: t("network_ne2k") },
        { value: "virtio", label: t("network_virtio") },
    ], machine.network.device, value => { machine.network.device = value; });

    const relay = el("input.input", {
        type: "url", value: machine.network.relay_url || "",
        placeholder: "wss://…",
    });
    relay.addEventListener("change", () => { machine.network.relay_url = relay.value.trim(); });

    return {
        element: el("div.page", {}, [
            field(t("network"), device),
            field("WebSocket-релей", relay),
            el("p.field-hint", { text: t("network_help") }),
        ]),
        collect: () => machine,
    };
}

/** The COM1 console. */
export function serial_page(machine) {
    const enabled = checkbox(t("serial_enabled"), machine.serial.enabled,
        value => { machine.serial.enabled = value; });

    return {
        element: el("div.page", {}, [enabled, el("p.field-hint", { text: t("serial_hint") })]),
        collect: () => machine,
    };
}

/** A short summary of a machine, used in the list and the details pane. */
export function machine_summary(machine) {
    const media = attached_media(machine);
    return {
        memory: `${machine.system.memory_mb} МиБ`,
        media: media.map(entry => `${t(MEDIA_LABELS[entry.kind])}: ${entry.media.name}`),
        boot: machine.system.boot_order,
    };
}

export default {
    system_page, media_page, display_page, audio_page, network_page, serial_page,
    media_row, machine_summary, MEDIA_LABELS,
};
