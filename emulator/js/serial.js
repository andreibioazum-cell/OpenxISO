/*
 * COM1 console.
 *
 * v86 can write the guest's serial output into a DOM element, but a Linux boot
 * log is full of ANSI escape sequences, and the element would grow without
 * bounds, so this renders the output itself: it keeps a cursor (CR moves it,
 * LF opens a new line, characters overwrite what is under the cursor), drops
 * the escape sequences it does not implement, and keeps the text in a ring
 * buffer so a machine that has been up for hours does not fill the memory of
 * the browser tab.
 */

/** How much serial text is remembered (the visible part is much smaller). */
const HISTORY_BYTES = 256 * 1024;
/** How much of it is rendered at once. */
const VIEW_BYTES = 64 * 1024;
/** A very long line (a progress bar) is cut here. */
const MAX_COLUMNS = 4096;

export class SerialConsole {
    /**
     * @param {HTMLElement} output the element the text is rendered into
     * @param {{on_send?: function(string), on_bell?: function()}=} options
     */
    constructor(output, options = {}) {
        this.output = output;
        this.options = options;
        this.lines = [""];
        this.column = 0;
        this.bytes = 0;
        this.escape = null;
        this.dirty = false;
        this.render_pending = false;
        this.autoscroll = true;

        output.addEventListener("scroll", () => {
            const distance = output.scrollHeight - output.scrollTop - output.clientHeight;
            this.autoscroll = distance < 40;
        });
    }

    /** @return {string} everything that was printed, as plain text */
    get text() {
        return this.lines.join("\n");
    }

    /** @return {string} the line the cursor is on */
    get line() {
        return this.lines[this.lines.length - 1];
    }

    clear() {
        this.lines = [""];
        this.column = 0;
        this.bytes = 0;
        this.schedule_render();
    }

    /**
     * @param {number} byte
     */
    put_byte(byte) {
        // inside an escape sequence the byte is part of it
        if (this.escape !== null) {
            this.handle_escape(byte);
            return;
        }

        switch (byte) {
            case 0x1b:
                this.escape = "";
                return;
            case 0x0d:                      // carriage return: back to column 0
                this.column = 0;
                return;
            case 0x0a:                      // line feed
                this.new_line();
                return;
            case 0x08:                      // backspace
                this.column = Math.max(0, this.column - 1);
                return;
            case 0x07:                      // bell
                this.options.on_bell && this.options.on_bell();
                return;
            case 0x09: {                    // tab: to the next multiple of 8
                const spaces = 8 - (this.column % 8);
                this.write_text(" ".repeat(spaces));
                return;
            }
            case 0x00:
                return;
        }

        if (byte < 32) {
            return;
        }
        this.write_text(String.fromCharCode(byte));
    }

    /** @param {string} text */
    put_text(text) {
        for (const character of text) {
            this.put_byte(character.charCodeAt(0));
        }
    }

    /**
     * Handle the next byte of an escape sequence.
     *
     * ESC [ ... <letter>      CSI (colors, cursor movement, erase)
     * ESC ] ... BEL           OSC (window title, and the like)
     * ESC <letter>            a simple sequence
     * ESC ( X                 character set selection
     */
    handle_escape(byte) {
        const character = String.fromCharCode(byte);
        this.escape += character;

        if (this.escape.length === 1) {
            if (character === "]") {
                this.escape_osc = true;
            } else if (character !== "[") {
                // ESC ( B, ESC = and friends: two characters and done
                this.escape = character === "(" || character === ")" ||
                    character === "*" || character === "+" ? this.escape : null;
            }
            return;
        }

        if (this.escape_osc) {
            if (character === "\u0007" || this.escape.endsWith("\u001b\\") || this.escape.length > 256) {
                this.escape = null;
                this.escape_osc = false;
            }
            return;
        }

        if (this.escape.indexOf("[") === 0 && byte >= 0x40 && byte <= 0x7e) {
            this.apply_csi(this.escape.slice(1, -1), character);
            this.escape = null;
            return;
        }

        if (this.escape.indexOf("[") !== 0) {
            // ESC ( B or any other two character sequence
            this.escape = null;
            return;
        }

        if (this.escape.length > 64) {
            this.escape = null;
        }
    }

    /**
     * Apply the escape sequences that change the text: erasing. Colours and
     * cursor movement are ignored (the console is a log, not a terminal).
     *
     * @param {string} parameters
     * @param {string} final
     */
    apply_csi(parameters, final) {
        const numbers = parameters.split(";").map(value => parseInt(value, 10) || 0);

        switch (final) {
            case "K": {                     // erase in line
                const mode = numbers[0];
                if (mode === 2) {
                    this.set_line("");
                    this.column = 0;
                } else if (mode === 1) {
                    this.set_line(" ".repeat(this.column) + this.line.slice(this.column));
                    this.column = 0;
                } else {
                    this.set_line(this.line.slice(0, this.column));
                }
                break;
            }
            case "J": {                     // erase in display
                if (numbers[0] === 2) {
                    this.lines = [""];
                    this.column = 0;
                } else {
                    this.set_line(this.line.slice(0, this.column));
                }
                break;
            }
            case "C":                       // cursor forward
                this.write_text(" ".repeat(Math.min(256, numbers[0] || 1)));
                break;
            case "G":                       // cursor to column
                this.column = Math.max(0, Math.min(MAX_COLUMNS, (numbers[0] || 1) - 1));
                break;
            default:
                // SGR (m), cursor movement, mode setting: nothing to draw
                break;
        }
    }

    /** Write text at the cursor, overwriting what is already there. */
    write_text(text) {
        const line = this.line;
        const before = line.slice(0, this.column);
        const after = line.slice(this.column + text.length);
        this.set_line((before + text + after).slice(0, MAX_COLUMNS));
        this.column += text.length;
        this.bytes += text.length;
        this.trim();
        this.schedule_render();
    }

    set_line(text) {
        this.lines[this.lines.length - 1] = text;
    }

    /** @return {boolean} whether the cursor is past the end of the line */
    new_line() {
        this.lines.push("");
        this.column = 0;
        this.trim();
        this.schedule_render();
    }

    /** Drop old output so the console stays small. */
    trim() {
        while (this.bytes > HISTORY_BYTES && this.lines.length > 2) {
            this.bytes -= this.lines[0].length + 1;
            this.lines.shift();
        }
        while (this.lines.length > 1 && this.lines[this.lines.length - 1] === "" &&
               this.lines[this.lines.length - 2] === "") {
            this.lines.pop();
        }
    }

    schedule_render() {
        this.dirty = true;
        if (this.render_pending) {
            return;
        }
        this.render_pending = true;
        const schedule = typeof requestAnimationFrame === "function"
            ? requestAnimationFrame : fn => setTimeout(fn, 16);
        schedule(() => this.render());
    }

    render() {
        this.render_pending = false;
        if (!this.dirty) {
            return;
        }
        this.dirty = false;

        let text = this.text;
        if (text.length > VIEW_BYTES) {
            text = text.slice(-VIEW_BYTES);
        }
        if (this.output.textContent !== text) {
            this.output.textContent = text;
        }

        if (this.autoscroll) {
            this.output.scrollTop = this.output.scrollHeight;
        }
    }

    /**
     * Send text to the guest (the guest has to listen on COM1).
     * @param {string} text
     */
    send(text) {
        this.options.on_send && this.options.on_send(text);
    }

    /** @return {Blob} the console contents, for download */
    to_blob() {
        return new Blob([this.text], { type: "text/plain" });
    }
}

export default { SerialConsole };
