/*
 * Keys, for phones: a normal keyboard does not exist on a touch screen, and
 * the system keyboard of a mobile browser only sends "key" events with a
 * virtual key code (229) that v86 ignores, so a guest never sees any input.
 *
 * This module (1) sends text and keys through the emulator interface and
 * (2) builds an on-screen keyboard that sends PC scan codes (set 1) for the
 * keys a Linux installer asks for: Enter, Tab, Esc, arrows, F-keys, Ctrl/Alt.
 */

/** Scan codes of the keys that are not simply "a letter". */
export const SCAN_CODES = {
    escape: 0x01, enter: 0x1c, backspace: 0x0e, tab: 0x0f, space: 0x39,
    minus: 0x0c, equal: 0x0d, bracket_left: 0x1a, bracket_right: 0x1b,
    backslash: 0x2b, semicolon: 0x27, quote: 0x28, backtick: 0x29,
    comma: 0x33, period: 0x34, slash: 0x35, caps_lock: 0x3a,

    f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40,
    f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,

    home: 0x47, arrow_up: 0x48, page_up: 0x49,
    arrow_left: 0x4b, arrow_right: 0x4d,
    end: 0x4f, arrow_down: 0x50, page_down: 0x51, insert: 0x52, delete: 0x53,

    shift_left: 0x2a, shift_right: 0x36, ctrl_left: 0x1d, ctrl_right: 0xe01d,
    alt_left: 0x38, alt_right: 0xe038, meta_left: 0xe05b, meta_right: 0xe05c,
    num_lock: 0x45, scroll_lock: 0x46, print_screen: 0xe037,
};

/*
 * Character -> scan code, with the characters that need shift as well. These
 * are the set 1 make codes a PS/2 keyboard sends.
 */
const CHARACTER_MAP = (() => {
    const map = new Map();

    const add = (character, code, needs_shift) => {
        map.set(character, { code: code, shift: !!needs_shift });
    };

    const digits = "1234567890";
    const shifted_digits = "!@#$%^&*()";
    const digit_codes = [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b];
    for (let i = 0; i < digits.length; i++) {
        add(digits[i], digit_codes[i], false);
        add(shifted_digits[i], digit_codes[i], true);
    }

    const letter_codes = [
        0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
        0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
    ];
    for (let i = 0; i < 26; i++) {
        const lower = String.fromCharCode(97 + i);
        add(lower, letter_codes[i], false);
        add(lower.toUpperCase(), letter_codes[i], true);
    }

    const punctuation = [
        ["-", "_", 0x0c], ["=", "+", 0x0d], ["[", "{", 0x1a], ["]", "}", 0x1b],
        ["\\", "|", 0x2b], [";", ":", 0x27], ["'", "\"", 0x28], ["`", "~", 0x29],
        [",", "<", 0x33], [".", ">", 0x34], ["/", "?", 0x35],
    ];
    for (const [plain, shifted, code] of punctuation) {
        add(plain, code, false);
        add(shifted, code, true);
    }

    add(" ", 0x39, false);
    add("\n", 0x1c, false);
    add("\r", 0x1c, false);
    add("\t", 0x0f, false);

    return map;
})();

/**
 * @param {string} character
 * @return {Array<number>} scan codes to press and release (a "make" and "break")
 */
export function character_scancodes(character) {
    const entry = CHARACTER_MAP.get(character);
    if (!entry) {
        return [];
    }
    if (entry.shift) {
        return [SCAN_CODES.shift_left, entry.code, entry.code | 0x80, SCAN_CODES.shift_left | 0x80];
    }
    return [entry.code, entry.code | 0x80];
}

/**
 * @param {string} text
 * @return {Array<number>} scan codes for every character of the text
 */
export function text_scancodes(text) {
    const codes = [];
    for (const character of text) {
        codes.push(...character_scancodes(character));
    }
    return codes;
}

/**
 * @param {string} key a name from SCAN_CODES
 * @return {Array<number>} make and break codes, with the 0xe0 prefix handled
 */
export function key_scancodes(key) {
    const code = SCAN_CODES[key];
    if (code === undefined) {
        return [];
    }
    if (code > 0xff) {
        const prefix = code >> 8;
        const base = code & 0xff;
        return [prefix, base, prefix, base | 0x80];
    }
    return [code, code | 0x80];
}

/** The keys that stay pressed until they are tapped again. */
const MODIFIER_KEYS = {
    shift_left: "shift",
    shift_right: "shift",
    ctrl_left: "ctrl",
    ctrl_right: "ctrl",
    alt_left: "alt",
    alt_right: "alt",
};

/** The layout of the on-screen keyboard. */
export const KEYBOARD_LAYOUT = [
    [
        { key: "escape", label: "Esc" },
        { key: "f1", label: "F1" }, { key: "f2", label: "F2" }, { key: "f3", label: "F3" },
        { key: "f4", label: "F4" }, { key: "f5", label: "F5" }, { key: "f6", label: "F6" },
        { key: "f7", label: "F7" }, { key: "f8", label: "F8" }, { key: "f9", label: "F9" },
        { key: "f10", label: "F10" }, { key: "f11", label: "F11" }, { key: "f12", label: "F12" },
    ],
    [
        { key: "`", label: "`" }, { key: "1", label: "1" }, { key: "2", label: "2" },
        { key: "3", label: "3" }, { key: "4", label: "4" }, { key: "5", label: "5" },
        { key: "6", label: "6" }, { key: "7", label: "7" }, { key: "8", label: "8" },
        { key: "9", label: "9" }, { key: "0", label: "0" }, { key: "-", label: "-" },
        { key: "=", label: "=" }, { key: "backspace", label: "⌫", wide: true },
    ],
    [
        { key: "tab", label: "Tab", wide: true }, { key: "q", label: "q" }, { key: "w", label: "w" },
        { key: "e", label: "e" }, { key: "r", label: "r" }, { key: "t", label: "t" },
        { key: "y", label: "y" }, { key: "u", label: "u" }, { key: "i", label: "i" },
        { key: "o", label: "o" }, { key: "p", label: "p" }, { key: "[", label: "[" },
        { key: "]", label: "]" }, { key: "\\", label: "\\" },
    ],
    [
        { key: "caps_lock", label: "Caps", wide: true }, { key: "a", label: "a" },
        { key: "s", label: "s" }, { key: "d", label: "d" }, { key: "f", label: "f" },
        { key: "g", label: "g" }, { key: "h", label: "h" }, { key: "j", label: "j" },
        { key: "k", label: "k" }, { key: "l", label: "l" }, { key: ";", label: ";" },
        { key: "'", label: "'" }, { key: "enter", label: "⏎", wide: true },
    ],
    [
        { key: "shift_left", label: "Shift", wide: true }, { key: "z", label: "z" }, { key: "x", label: "x" },
        { key: "c", label: "c" }, { key: "v", label: "v" }, { key: "b", label: "b" },
        { key: "n", label: "n" }, { key: "m", label: "m" }, { key: ",", label: "," },
        { key: ".", label: "." }, { key: "/", label: "/" }, { key: "arrow_up", label: "↑" },
    ],
    [
        { key: "ctrl_left", label: "Ctrl", wide: true }, { key: "alt_left", label: "Alt", wide: true },
        { key: "space", label: "", extra_wide: true },
        { key: "arrow_left", label: "←" }, { key: "arrow_down", label: "↓" },
        { key: "arrow_right", label: "→" },
    ],
];

/**
 * The on-screen keyboard widget.
 */
export class OnScreenKeyboard {
    /**
     * @param {HTMLElement} container
     * @param {{on_key: function(Array<number>), on_text?: function(string)}=} options
     */
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.shift = false;
        this.ctrl = false;
        this.alt = false;
        this.render();
    }

    render() {
        this.container.classList.add("osk");
        this.container.innerHTML = "";

        for (const row of KEYBOARD_LAYOUT) {
            const row_element = document.createElement("div");
            row_element.className = "osk-row";

            for (const key of row) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "osk-key";
                button.textContent = key.label;
                if (key.wide) {
                    button.classList.add("wide");
                }
                if (key.extra_wide) {
                    button.classList.add("extra-wide");
                }
                if (MODIFIER_KEYS[key.key]) {
                    button.classList.add("modifier");
                    button.classList.toggle("active", this.is_active(key.key));
                }
                button.addEventListener("click", event => {
                    event.preventDefault();
                    this.press(key.key, event);
                });
                row_element.appendChild(button);
            }
            this.container.appendChild(row_element);
        }
    }

    is_active(key) {
        const name = MODIFIER_KEYS[key];
        return !!name && this[name];
    }

    /**
     * @param {string} key a layout entry or a character
     * @param {Event=} event
     */
    press(key, event) {
        const send = codes => codes.length && this.options.on_key && this.options.on_key(codes);

        const modifier = MODIFIER_KEYS[key];
        if (modifier) {
            this[modifier] = !this[modifier];
            this.render();
            return;
        }

        const modifiers = [];
        if (this.ctrl) {
            modifiers.push(...key_scancodes("ctrl_left"));
        }
        if (this.alt) {
            modifiers.push(...key_scancodes("alt_left"));
        }

        let codes;
        if (SCAN_CODES[key] !== undefined) {
            codes = key_scancodes(key);
        } else if (this.shift) {
            codes = character_scancodes(shift_character(key));
        } else {
            codes = character_scancodes(key);
        }

        if (modifiers.length) {
            // press the modifiers, press the key, then release everything
            const make = codes.slice(0, codes.length / 2);
            const release = codes.slice(codes.length / 2);
            send([...modifiers.slice(0, modifiers.length / 2), ...make, ...release,
                  ...modifiers.slice(modifiers.length / 2)]);
        } else {
            send(codes);
        }

        if (this.shift && SCAN_CODES[key] === undefined) {
            this.shift = false;
            this.render();
        }
        void event;
    }
}

/** The shifted variant of a plain key label, e.g. "1" -> "!". */
function shift_character(character) {
    const shifted = {
        "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&",
        "8": "*", "9": "(", "0": ")", "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|",
        ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?",
    }[character];
    if (shifted) {
        return shifted;
    }
    return character.length === 1 ? character.toUpperCase() : character;
}

export default {
    OnScreenKeyboard, SCAN_CODES, KEYBOARD_LAYOUT,
    character_scancodes, text_scancodes, key_scancodes,
};
