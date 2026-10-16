/*
 * The screen.
 *
 * v86 renders text mode into a <div> and graphic modes into a <canvas>, both
 * inside the container it is given ("screen_container"). This module adds what
 * VirtualBox users expect around that: a "click to capture the mouse" overlay,
 * pointer lock (with a virtual mouse for touch screens and for environments
 * where pointer lock is not allowed), scaling (fit / 1:1 / 2:1 / fullscreen),
 * a resolution readout and screenshots.
 */

import { t } from "./i18n.js";

/** How much one pixel of finger movement moves the guest pointer. */
const TOUCH_SPEED = 1.4;
/** Long press to get a right click, in milliseconds. */
const LONG_PRESS = 550;

export class Display {
    /**
     * @param {HTMLElement} container the element passed to v86 as screen_container
     * @param {{on_status?: function(string), on_capture?: function(boolean)}=} options
     */
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.machine = null;
        this.locked = false;
        this.scale = "fit";
        this.size = null;
        this.capture_overlay = null;
        this.busy = false;

        const canvas = container.querySelector("canvas");
        // v86 renders into the first <div> it finds inside the container, so
        // that one has to be the text screen, not a wrapper around it
        const text = container.querySelector("div, .text-screen");
        this.canvas = canvas;
        this.text = text && text !== canvas ? text : null;
        if (!this.text) {
            this.text = document.createElement("div");
            this.text.className = "text-screen";
            container.insertBefore(this.text, canvas || null);
        }

        // the element that is scaled: a wrapper v86 does not know about, so
        // its own width/height/transform bookkeeping cannot fight ours
        this.scaler = container.querySelector(".screen-scale");
        if (!this.scaler) {
            this.scaler = document.createElement("section");
            this.scaler.className = "screen-scale";
            container.insertBefore(this.scaler, this.text);
            this.scaler.append(this.text, canvas);
        } else if (this.text.parentNode !== this.scaler) {
            this.scaler.insertBefore(this.text, this.scaler.firstChild);
        }

        this.build_overlay();
        this.bind_events();
    }

    build_overlay() {
        const overlay = document.createElement("div");
        overlay.className = "screen-capture";
        overlay.hidden = true;

        const hint = document.createElement("div");
        hint.className = "capture-hint";
        hint.textContent = t("capture_hint");
        overlay.appendChild(hint);

        const mouse = document.createElement("div");
        mouse.className = "capture-mouse";
        mouse.title = t("mouse_captured");
        overlay.appendChild(mouse);

        this.container.appendChild(overlay);
        this.capture_overlay = overlay;
    }

    bind_events() {
        document.addEventListener("pointerlockchange", () => {
            this.locked = document.pointerLockElement === document.body ||
                this.container.contains(document.pointerLockElement);
            this.capture_overlay.classList.toggle("locked", this.locked);
            this.options.on_capture && this.options.on_capture(this.locked);
        });

        // Clicking the screen is what captures the mouse in VirtualBox: the
        // guest only receives mouse movement once it is captured (pointer
        // lock), otherwise moving the mouse outside the window would leave the
        // guest pointer behind.
        this.container.addEventListener("mousedown", event => {
            if (!this.machine) {
                return;
            }
            if (!this.locked && !this.virtual_mouse) {
                this.machine.lock_mouse().catch(() => this.enable_virtual_mouse(true));
            }
            event.preventDefault();
        });

        this.container.addEventListener("contextmenu", event => event.preventDefault());
        this.container.addEventListener("wheel", event => {
            if (this.machine && (this.locked || this.virtual_mouse)) {
                this.machine.send_mouse_wheel(event.deltaX / 100, event.deltaY / 100);
                event.preventDefault();
            }
        }, { passive: false });

        this.bind_touch();
        window.addEventListener("resize", () => this.schedule_scale());
        window.addEventListener("orientationchange", () => setTimeout(() => {
            this.current_scale = undefined;
            this.schedule_scale();
        }, 250));
    }

    /** The virtual mouse moves the guest pointer with relative movements. */
    bind_touch() {
        let last_x = 0;
        let last_y = 0;
        let start_time = 0;
        let moved = 0;
        let long_press_timer = null;
        let multi_touch = false;

        const point = touch => ({ x: touch.clientX, y: touch.clientY });

        this.container.addEventListener("touchstart", event => {
            if (!this.machine) {
                return;
            }
            if (event.touches.length > 1) {
                multi_touch = true;
                return;
            }
            multi_touch = false;
            const position = point(event.touches[0]);
            last_x = position.x;
            last_y = position.y;
            start_time = Date.now();
            moved = 0;
            this.options.on_status && this.options.on_status("touch");
            long_press_timer = setTimeout(() => {
                if (this.machine && moved < 8) {
                    this.machine.send_mouse_click(false, false, true);
                    this.machine.send_mouse_click(false, false, false);
                    long_press_timer = null;
                }
            }, LONG_PRESS);
            event.preventDefault();
        }, { passive: false });

        this.container.addEventListener("touchmove", event => {
            if (!this.machine || multi_touch || !event.touches.length) {
                return;
            }
            const position = point(event.touches[0]);
            const delta_x = (position.x - last_x) * TOUCH_SPEED;
            const delta_y = (position.y - last_y) * TOUCH_SPEED;
            last_x = position.x;
            last_y = position.y;
            moved += Math.abs(delta_x) + Math.abs(delta_y);
            if (long_press_timer && moved >= 8) {
                clearTimeout(long_press_timer);
                long_press_timer = null;
            }
            this.machine.send_mouse_delta(delta_x, -delta_y);
            event.preventDefault();
        }, { passive: false });

        this.container.addEventListener("touchend", event => {
            if (long_press_timer) {
                clearTimeout(long_press_timer);
                long_press_timer = null;
                // a tap that neither moved nor lasted: a left click
                if (moved < 8 && Date.now() - start_time < LONG_PRESS) {
                    this.machine && this.machine.send_mouse_click(true, false, false);
                    this.machine && this.machine.send_mouse_click(false, false, false);
                }
            }
            if (event.touches.length === 0) {
                multi_touch = false;
            }
        });
    }

    /**
     * @param {import("./engine.js").Machine|null} machine
     */
    attach(machine) {
        this.machine = machine;
        this.capture_overlay.hidden = !machine;
        this.capture_overlay.classList.remove("locked");
        this.current_scale = undefined;
        this.current_offset_x = undefined;
        if (machine) {
            this.schedule_scale();
            this.schedule_scale(300);
        }
    }

    /** Virtual mouse: for touch screens and when pointer lock is unavailable. */
    enable_virtual_mouse(enabled) {
        this.virtual_mouse = !!enabled;
        this.container.classList.toggle("virtual-mouse", this.virtual_mouse);
        if (enabled) {
            this.capture_overlay.classList.add("no-lock");
            this.capture_overlay.querySelector(".capture-hint").textContent = t("mouse_virtual_help");
        } else {
            this.capture_overlay.classList.remove("no-lock");
            this.capture_overlay.querySelector(".capture-hint").textContent = t("capture_hint");
        }
    }

    /**
     * Change how the guest screen is scaled into the window.
     * @param {"fit"|"1"|"2"|"full"} scale
     */
    set_scale(scale) {
        this.scale = scale;
        this.current_scale = undefined;
        this.current_offset_x = undefined;
        this.schedule_scale();
    }

    /**
     * Fit the guest screen into the window.
     *
     * The scale is applied to the wrapper element around the text screen and
     * the canvas, and it is computed from the *layout* size of the guest
     * screen (offsetWidth/scrollWidth), which a CSS transform does not change.
     * That way the factor is exact in one step and never accumulates the way
     * it does when a library measures its own transformed element.
     */
    apply_scale() {
        const container = this.container;
        const box = container.getBoundingClientRect();
        if (!box.width || !box.height || !this.machine || !this.scaler) {
            return;
        }

        const natural = this.natural_size();
        if (!natural.width || !natural.height) {
            // the guest has not painted anything yet (or the mode changed and
            // the rows are still to come): look again shortly
            this.schedule_scale(120);
            return;
        }

        let scale;
        if (this.scale === "1") {
            scale = 1 / (window.devicePixelRatio > 1 ? window.devicePixelRatio : 1);
        } else if (this.scale === "2") {
            scale = 1;
        } else {
            scale = Math.min(box.width / natural.width, box.height / natural.height);
            scale = Math.max(0.15, Math.min(8, scale));
        }

        const width = natural.width * scale;
        const height = natural.height * scale;
        const offset_x = Math.max(0, (box.width - width) / 2);
        const offset_y = Math.max(0, (box.height - height) / 2);

        if (Math.abs(scale - this.current_scale) < 0.002 &&
            Math.abs(offset_x - (this.current_offset_x || 0)) < 1) {
            return;
        }
        this.current_scale = scale;
        this.current_offset_x = offset_x;
        this.current_offset_y = offset_y;

        this.scaler.style.transform =
            `translate(${offset_x.toFixed(1)}px, ${offset_y.toFixed(1)}px) scale(${scale.toFixed(4)})`;
        container.style.setProperty("--screen-scale", scale.toFixed(4));
        this.rendered = { width: width, height: height };
    }

    /**
     * The size the guest screen wants to have, in CSS pixels, ignoring any
     * transform: the text screen is as wide as its widest row and the canvas
     * is as big as the current video mode.
     *
     * @return {{width: number, height: number}}
     */
    natural_size() {
        let width = 0;
        let height = 0;

        if (this.canvas) {
            width = Math.max(width, this.canvas.offsetWidth, this.canvas.width);
            height = Math.max(height, this.canvas.offsetHeight, this.canvas.height);
        }
        if (this.text && this.text_mode !== false) {
            width = Math.max(width, this.text.scrollWidth, this.text.offsetWidth);
            height = Math.max(height, this.text.scrollHeight, this.text.offsetHeight);
        }

        return { width: width, height: height };
    }

    /**
     * Recompute the scale, optionally after a delay. The call is idempotent:
     * apply_scale() only changes anything when the result differs, so it is
     * safe to call it again and again (the guest paints its first rows a
     * moment after a mode change, and the size is not known before that).
     *
     * @param {number=} delay milliseconds
     */
    schedule_scale(delay) {
        if (this.scale_pending) {
            return;
        }
        this.scale_pending = true;
        const run = () => requestAnimationFrame(() => {
            this.scale_pending = false;
            this.apply_scale();
        });
        if (delay) {
            setTimeout(run, delay);
        } else {
            run();
        }
    }

    /**
     * Keep the fit correct while the guest runs: the text screen grows when
     * rows are added, the font can change with the video mode, and a window
     * resize can leave an old factor behind. Called from the status timer.
     */
    maintain() {
        if (!this.machine) {
            return;
        }
        const now = Date.now();
        if (now - (this.last_maintain || 0) < 1500) {
            return;
        }
        this.last_maintain = now;
        this.apply_scale();
    }

    /**
     * Called on the screen-set-size event of the emulator.
     * @param {Array<number>} args [width, height, bpp]
     */
    set_size(args) {
        this.size = { width: args[0], height: args[1], bpp: args[2] };
        this.text_mode = args[2] === 0;
        // A new resolution means the old fit has to be recomputed; the guest
        // paints the new mode a moment later, hence the retries.
        this.schedule_scale();
        this.schedule_scale(100);
        this.schedule_scale(400);
    }

    /** Toggle fullscreen for the whole screen container. */
    toggle_fullscreen() {
        // the container changes size, so the fit has to be recomputed
        setTimeout(() => {
            this.current_scale = undefined;
            this.schedule_scale();
        }, 300);
        const element = this.container;
        const request = element.requestFullscreen || element.webkitRequestFullscreen ||
            element.msRequestFullscreen;
        if (!request) {
            this.options.on_status && this.options.on_status("fullscreen-unsupported");
            return;
        }
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            request.call(element).then(() => this.machine && this.machine.lock_mouse()).catch(error => {
                console.warn("fullscreen refused:", error);
            });
        }
    }

    /**
     * Save a screenshot of the guest screen.
     * @return {Promise<Blob|null>}
     */
    async screenshot() {
        if (!this.machine) {
            return null;
        }
        const canvas = this.machine.screenshot();
        if (!canvas) {
            return null;
        }
        return new Promise(resolve => {
            if (canvas.toBlob) {
                canvas.toBlob(blob => resolve(blob), "image/png");
            } else {
                resolve(null);
            }
        });
    }
}

export default { Display };
