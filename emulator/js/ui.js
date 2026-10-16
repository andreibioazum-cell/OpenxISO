/*
 * Small DOM toolkit: element creation, dialogs, notifications.
 *
 * The app has no framework and no build step on purpose — it has to run from a
 * file:// URL in the Android WebView as well as from a web server, and every
 * framework would add a build step and several hundred kilobytes.
 */

/**
 * Create an element.
 * @param {string} tag tag name, optionally with classes: "button.primary.big"
 * @param {Object=} props attributes, properties and event handlers
 * @param {...(Node|string|Array|undefined|null)} children
 * @return {HTMLElement}
 */
export function el(tag, props, ...children) {
    const [name, ...classes] = tag.split(".");
    const element = document.createElement(name || "div");
    if (classes.length) {
        element.className = classes.join(" ");
    }

    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null) {
                continue;
            }
            if (key === "class" || key === "className") {
                element.className = (element.className ? element.className + " " : "") + value;
            } else if (key === "style" && typeof value === "object") {
                Object.assign(element.style, value);
            } else if (key === "dataset") {
                Object.assign(element.dataset, value);
            } else if (key.startsWith("on") && typeof value === "function") {
                element.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === "text") {
                element.textContent = value;
            } else if (key === "html") {
                element.innerHTML = value;
            } else if (key in element && key !== "list" && typeof value !== "string") {
                element[key] = value;
            } else {
                element.setAttribute(key, value);
            }
        }
    }

    append(element, children);
    return element;
}

/** Append children, flattening arrays and skipping empty values. */
export function append(parent, children) {
    for (const child of children) {
        if (child === undefined || child === null || child === false) {
            continue;
        }
        if (Array.isArray(child)) {
            append(parent, child);
        } else if (child instanceof Node) {
            parent.appendChild(child);
        } else {
            parent.appendChild(document.createTextNode(String(child)));
        }
    }
    return parent;
}

/** @return {DocumentFragment} */
export function frag(...children) {
    const fragment = document.createDocumentFragment();
    append(fragment, children);
    return fragment;
}

export function clear(element) {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
    return element;
}

/**
 * A modal dialog in the style of the operating system's own, with the buttons
 * the caller asks for.
 *
 * @param {{title: string, content: Node|Array<Node>, buttons?: Array<Object>,
 *          wide?: boolean, on_close?: function()=}} options
 * @return {{element: HTMLElement, close: function(), body: HTMLElement,
 *           footer: HTMLElement, set_title: function(string)}}
 */
export function dialog(options) {
    const body = el("div.dialog-body");
    append(body, [options.content]);

    const footer = el("div.dialog-footer");
    const element = el("dialog.dialog" + (options.wide ? ".wide" : ""), {}, [
        el("div.dialog-titlebar", {}, [
            el("span.dialog-title", { text: options.title }),
            el("button.dialog-close", {
                type: "button", text: "✕", title: "Закрыть",
                onclick: () => close(),
            }),
        ]),
        body,
        footer,
    ]);

    const close = () => {
        if (element.open) {
            element.close();
        }
        element.remove();
        options.on_close && options.on_close();
    };

    for (const button of options.buttons || []) {
        footer.appendChild(el("button.button" + (button.primary ? ".primary" : ""), {
            type: "button",
            text: button.label,
            onclick: async event => {
                const target = event.currentTarget;
                target.disabled = true;
                try {
                    const result = button.action ? await button.action(api) : true;
                    if (result !== false && button.keep_open !== true) {
                        close();
                    }
                } catch (error) {
                    console.error(error);
                    toast(String(error && error.message || error), "error");
                } finally {
                    target.disabled = false;
                }
            },
        }));
    }

    const api = { element: element, body: body, footer: footer, close: close,
        set_title: title => { element.querySelector(".dialog-title").textContent = title; } };

    element.addEventListener("cancel", event => {
        event.preventDefault();
        close();
    });

    document.body.appendChild(element);
    if (element.showModal) {
        element.showModal();
    } else {
        element.setAttribute("open", "");
    }
    return api;
}

/**
 * @param {string} message
 * @param {{title?: string, ok?: string, cancel?: string, danger?: boolean}} options
 * @return {Promise<boolean>}
 */
export function confirm(message, options = {}) {
    return new Promise(resolve => {
        let answered = false;
        const answer = value => {
            answered = true;
            resolve(value);
        };
        dialog({
            title: options.title || "Подтверждение",
            content: el("p.dialog-text", { text: message }),
            on_close: () => { if (!answered) { resolve(false); } },
            buttons: [
                { label: options.cancel || "Отмена", action: () => answer(false) },
                {
                    label: options.ok || "OK",
                    primary: !options.danger,
                    action: () => answer(true),
                },
            ],
        });
    });
}

/**
 * @param {{title?: string, label: string, value?: string, ok?: string}} options
 * @return {Promise<string|null>}
 */
export function prompt_text(options) {
    return new Promise(resolve => {
        const input = el("input.input", { type: "text", value: options.value || "" });
        let answered = false;
        dialog({
            title: options.title || options.label,
            content: el("label.field", {}, [el("span.field-label", { text: options.label }), input]),
            on_close: () => { if (!answered) { resolve(null); } },
            buttons: [
                { label: "Отмена", action: () => resolve(null) },
                {
                    label: options.ok || "OK",
                    primary: true,
                    action: () => {
                        answered = true;
                        resolve(input.value.trim());
                    },
                },
            ],
        });
        setTimeout(() => input.focus(), 50);
        input.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                answered = true;
                resolve(input.value.trim());
                input.closest("dialog").close();
            }
        });
    });
}

/**
 * A short notification in the corner.
 * @param {string} message
 * @param {"info"|"error"|"success"=} kind
 */
export function toast(message, kind) {
    let container = document.getElementById("toasts");
    if (!container) {
        container = el("div#toasts");
        document.body.appendChild(container);
    }
    const element = el("div.toast" + (kind ? "." + kind : ""), { text: message });
    container.appendChild(element);
    setTimeout(() => element.classList.add("visible"), 10);
    setTimeout(() => {
        element.classList.remove("visible");
        setTimeout(() => element.remove(), 300);
    }, kind === "error" ? 8000 : 4000);
}

/**
 * A labelled form field with an optional hint under it.
 * @param {string} label
 * @param {Node|Array<Node>} control
 * @param {string=} hint
 */
export function field(label, control, hint) {
    return el("label.field", {}, [
        el("span.field-label", { text: label }),
        control,
        hint ? el("span.field-hint", { text: hint }) : null,
    ]);
}

/**
 * @param {Array<{value: string, label: string}>} options
 * @param {string} value
 * @param {function(string)} on_change
 */
export function select(options, value, on_change) {
    const element = el("select.input");
    for (const option of options) {
        element.appendChild(el("option", { value: option.value, text: option.label }));
    }
    element.value = value;
    element.addEventListener("change", () => on_change(element.value));
    return element;
}

/**
 * @param {string} label
 * @param {boolean} checked
 * @param {function(boolean)} on_change
 */
export function checkbox(label, checked, on_change) {
    const input = el("input", { type: "checkbox", checked: checked });
    input.addEventListener("change", () => on_change(input.checked));
    return el("label.checkbox", {}, [input, el("span", { text: label })]);
}

/**
 * A row of tabs.
 * @param {Array<{id: string, label: string}>} tabs
 * @param {function(string)} on_select
 * @return {{element: HTMLElement, select: function(string)}}
 */
export function tabbar(tabs, on_select) {
    const element = el("div.tabbar");
    const buttons = new Map();

    for (const tab of tabs) {
        const button = el("button.tab", {
            type: "button",
            text: tab.label,
            onclick: () => select(tab.id),
        });
        buttons.set(tab.id, button);
        element.appendChild(button);
    }

    function select(id) {
        for (const [key, button] of buttons) {
            button.classList.toggle("active", key === id);
        }
        on_select(id);
    }

    return { element: element, select: select };
}

/** @param {number} milliseconds @return {string} */
export function format_duration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const pad = value => String(value).padStart(2, "0");
    return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

export default {
    el, frag, append, clear, dialog, confirm, prompt_text, toast, field,
    select, checkbox, tabbar, format_duration,
};
