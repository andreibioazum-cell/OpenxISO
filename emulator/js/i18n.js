/*
 * Translations for the emulator UI. Russian is the default, English is the
 * fallback for everything the user has not translated.
 *
 * t("key")            -> string
 * t("key", {n: 5})    -> "{n}" placeholders replaced
 * translate_dom(root) -> fills in [data-i18n], [data-i18n-placeholder], ...
 */

const strings = {
    ru: {
        app_name: "OpenxISO",
        app_tagline: "Эмулятор x86-64 прямо в браузере",

        machinelist: "Машины",
        no_machines: "Пока нет ни одной машины. Нажмите «Новая», чтобы создать её.",
        new_machine: "Новая",
        settings: "Настройки",
        start: "Запустить",
        pause: "Пауза",
        resume: "Продолжить",
        reset: "Сброс",
        stop: "Выключить",
        suspend: "Сохранить состояние",
        restore: "Восстановить",
        screenshot: "Снимок экрана",
        fullscreen: "Во весь экран",
        close: "Закрыть",
        cancel: "Отмена",
        create: "Создать",
        save: "Сохранить",
        apply: "Применить",
        delete: "Удалить",
        rename: "Переименовать",
        copy: "Дублировать",
        export: "Сохранить на устройство",
        back: "Назад",

        state_running: "Работает",
        state_paused: "Пауза",
        state_stopped: "Выключена",
        state_saved: "Состояние сохранено",
        state_starting: "Запуск…",
        state_error: "Ошибка",
        state_loading: "Загрузка образа…",

        machine_name: "Имя машины",
        machine_details: "Свойства машины",
        memory: "Оперативная память",
        vram: "Видеопамять",
        boot_order: "Порядок загрузки",
        cmdline: "Параметры ядра",
        cmdline_hint: "передаются ядру Linux при загрузке образа ядра",
        boot_cd: "CD/DVD, затем жёсткий диск",
        boot_hd: "Жёсткий диск, затем CD/DVD",
        boot_floppy: "Гибкий диск, затем жёсткий диск",
        acpi: "ACPI",
        fastboot: "Быстрая загрузка (без меню BIOS)",
        audio: "Звук",
        audio_enabled: "Включить звук (PC Speaker и Sound Blaster 16)",
        volume: "Громкость",
        mute: "Выключить звук",
        network: "Сеть",
        network_none: "Отключена",
        network_ne2k: "NE2000 (внутренний эмулятор)",
        network_virtio: "Virtio-net",
        network_help:
            "Сеть в эмуляторе работает только с внешним релеем (WebSocket). Для запуска " +
            "обычной системы сеть не нужна — оставьте «Отключена».",
        serial: "Последовательный порт",
        serial_enabled: "Показывать консоль COM1",
        serial_console: "Консоль COM1",
        serial_hint:
            "Чтобы получить текстовый вход в Linux без графики, допишите в параметры " +
            "ядра console=ttyS0 и выберите эту консоль.",
        serial_send: "Отправить",
        serial_placeholder: "введите текст и нажмите Enter…",
        serial_clear: "Очистить",
        serial_download: "Скачать журнал",

        media: "Носители",
        cdrom: "Оптический привод (ISO)",
        hdd: "Жёсткий диск",
        hdd2: "Второй жёсткий диск",
        floppy: "Гибкий диск",
        kernel: "Ядро Linux",
        kernel_hint: "образ ядра (bzImage, vmlinuz): машина загрузит его " +
            "напрямую, без поиска загрузочного сектора",
        attach: "Подключить",
        attach_url: "По ссылке",
        eject: "Отключить",
        create_blank: "Создать пустой…",
        no_media: "не подключён",
        storage_url: "по ссылке",
        media_storage: "Хранить образ в браузере",
        media_storage_help:
            "Если включено, образ копируется в хранилище браузера и машина сможет " +
            "запускаться после перезагрузки страницы без повторного выбора файла.",
        media_writable: "Изменяемый образ",
        pick_iso: "Выберите образ ISO",
        pick_hdd: "Выберите образ жёсткого диска",
        drop_hint: "Перетащите файл .iso или .hdd сюда",
        file_too_big: "Файл больше, чем свободное место в хранилище браузера",
        storage_used: "Занято: {used} из {quota}",
        not_enough_space: "Недостаточно места: нужно {need}, свободно {free}",
        blank_size: "Размер образа",
        create: "Создать",

        display: "Экран",
        scale_fit: "Вписать в окно",
        scale_1x: "1:1",
        scale_2x: "2:1",
        scale_fullscreen: "Полный экран",
        capture_hint: "Нажмите на экран, чтобы захватить мышь",
        capture_hint_locked: "Мышь захвачена — Esc, чтобы отпустить",
        mouse_captured: "Мышь",
        mouse_virtual: "Виртуальная мышь (для сенсорных экранов)",
        mouse_virtual_help:
            "Проведите пальцем по экрану — курсор сдвинется, короткое касание — щелчок " +
            "левой кнопкой, удержание — правой.",
        keyboard: "Клавиатура",
        keyboard_help: "Клавиатура телефона появляется по этой кнопке",
        send_ctrl_alt_del: "Ctrl+Alt+Del",
        paste: "Вставить текст",
        paste_help: "Текст будет напечатан в гостевой системе",
        resolution: "Разрешение",
        no_screen_yet: "Экран ещё не активен",

        snapshots: "Снимки состояния",
        snapshot_now: "Сохранить состояние",
        snapshot_name: "Название снимка",
        no_snapshots: "Снимков пока нет",
        snapshot_help:
            "Снимок сохраняет память и состояние устройств работающей машины. " +
            "Образы дисков остаются такими, какие они есть — изменения гостя " +
            "запоминаются отдельно и применяются при восстановлении.",
        snapshot_created: "Снимок создан: {name}",
        restore_confirm: "Восстановить состояние «{name}»? Текущее состояние будет потеряно.",
        restore_memory_mismatch: "Снимок сделан при другом размере памяти ({was} вместо {now})",

        wizard_title: "Новая машина",
        wizard_hint:
            "Дайте машине имя, выберите объём памяти и образ загрузки. " +
            "ISO или образ диска можно подключить сразу или позже.",
        wizard_step_system: "Система",
        wizard_step_media: "Носители",
        wizard_step_display: "Дисплей и звук",
        step_of: "Шаг {step} из {total}",

        engine: "Движок",
        engine_name: "v86_64 (64-битный long mode)",
        engine_help:
            "Это форк эмулятора v86 с поддержкой x86-64: гостевая система работает " +
            "в 64-битном длинном режиме. Так работают и 32-битные системы.",
        engine_loading: "Загрузка эмулятора…",
        engine_ready: "Готово",
        engine_missing: "Не найден файл движка: {file}",
        ram_limit: "Стандартный движок поддерживает до 3 ГиБ памяти.",
        mem64_needed: "Для {mb} МиБ памяти нужен движок v86-mem64.wasm (WebAssembly memory64)",
        mem64_unsupported: "Этот браузер не поддерживает WebAssembly memory64 (нужен Chrome 133+)",

        stats: "Статистика",
        stat_instructions: "Инструкции",
        stat_read: "Чтение образов",
        stat_disk: "Образы",
        activity: "Активность",
        host_hint: "Управление как в VirtualBox: слева машины, сверху кнопки питания.",

        about: "О программе",
        about_text:
            "OpenxISO — оболочка к эмулятору v86_64 (BSD-2-Clause, форк v86) с " +
            "интерфейсом в стиле VirtualBox. Больше подходит для 64-битных Linux " +
            "и других систем в режиме long mode.",
    },
    en: {
        app_name: "OpenxISO",
        app_tagline: "An x86-64 PC emulator in a browser tab",
    },
};

let current = "ru";

export const languages = [
    { code: "ru", label: "Русский" },
    { code: "en", label: "English" },
];

export function set_language(code) {
    if (languages.some(language => language.code === code)) {
        current = code;
    }
    return current;
}

export function get_language() {
    return current;
}

/**
 * @param {string} key
 * @param {Object=} values placeholders, e.g. {n: 3}
 * @return {string}
 */
export function t(key, values) {
    let text = strings.ru[key];

    if (text === undefined) {
        text = strings.en[key];
    }
    if (text === undefined) {
        console.warn("missing translation:", key);
        text = key;
    }
    if (values) {
        text = text.replace(/\{([a-z_0-9]+)\}/gi, (all, name) =>
            values[name] === undefined ? all : String(values[name]));
    }
    return text;
}

/**
 * Fill in the translated text of a DOM subtree.
 * @param {ParentNode} root
 */
export function translate_dom(root) {
    for (const element of root.querySelectorAll("[data-i18n]")) {
        element.textContent = t(element.dataset.i18n);
    }
    for (const element of root.querySelectorAll("[data-i18n-title]")) {
        element.title = t(element.dataset.i18nTitle);
    }
    for (const element of root.querySelectorAll("[data-i18n-placeholder]")) {
        element.placeholder = t(element.dataset.i18nPlaceholder);
    }
    for (const element of root.querySelectorAll("[data-i18n-html]")) {
        element.innerHTML = t(element.dataset.i18nHtml);
    }
}

export default { t, set_language, get_language, translate_dom, languages };
