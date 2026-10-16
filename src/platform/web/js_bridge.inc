/* JavaScript-аналоги всего, что раньше было на Java (EM_JS мосты). */
#ifndef CB_JS_BRIDGE_INC
#define CB_JS_BRIDGE_INC
#include <emscripten.h>
#include <emscripten/html5.h>

EM_JS(void, js_alert, (const char *msg), {
    if (typeof alert !== "undefined") alert(UTF8ToString(msg));
});

EM_JS(void, js_console_log, (int err, const char *s), {
    var t = UTF8ToString(s);
    if (err) console.error(t); else console.log(t);
});

/* ---- Клавиатура: аналог Java-InputMethod на чистом JS ---- */
EM_JS(void, js_kb_show, (), {
    if (!Module._kbInput) {
        var i = document.createElement("input");
        i.id = "_cb4kb";
        i.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;font-size:16px;";
        i.setAttribute("inputmode","text");
        i.autocomplete = "off";
        i.autocapitalize = "none";
        document.body.appendChild(i);
        Module._kbInput = i;
        i.addEventListener("input", function() {
            Module.__kb_text = i.value;
        });
        i.addEventListener("keydown", function(e) {
            if (e.key === "Enter") { Module.__kb_enter = 1; e.preventDefault(); }
        });
    }
    Module._kbInput.focus();
    Module.__kb_visible = 1;
});

EM_JS(void, js_kb_hide, (), {
    if (Module._kbInput) { Module._kbInput.blur(); Module._kbInput.style.left="-9999px"; }
    Module.__kb_visible = 0;
});

EM_JS(int, js_kb_visible, (), { return Module.__kb_visible ? 1 : 0; });
EM_JS(int, js_kb_enter, (), { var v = Module.__kb_enter ? 1 : 0; Module.__kb_enter = 0; return v; });

EM_JS(void, js_kb_gettext, (char *dst, int cap), {
    var s = (Module.__kb_text || "").substring(0, cap-1);
    for (var i = 0; i < s.length; i++) HEAP8[dst+i] = s.charCodeAt(i);
    HEAP8[dst+s.length] = 0;
});

EM_JS(void, js_kb_clear, (), {
    if (Module._kbInput) Module._kbInput.value = "";
    Module.__kb_text = "";
});

EM_JS(void, js_kb_type, (const char *t), {
    if (!Module._kbInput) return;
    Module._kbInput.value += UTF8ToString(t);
    Module.__kb_text = Module._kbInput.value;
});

EM_JS(void, js_kb_backspace, (), {
    if (!Module._kbInput) return;
    Module._kbInput.value = Module._kbInput.value.slice(0,-1);
    Module.__kb_text = Module._kbInput.value;
});

/* ---- Canvas 2D графика (вместо Vulkan/WebGPU — проще всего, меньше кода) ---- */
EM_JS(void, js_gfx_init, (const char *cid), {
    Module._canvas = document.getElementById(UTF8ToString(cid));
    if (!Module._canvas) { Module._canvas = document.createElement("canvas"); document.body.appendChild(Module._canvas); }
    Module._ctx = Module._canvas.getContext("2d");
    Module._canvas.style.width="100vw"; Module._canvas.style.height="100vh";
    Module._canvas.style.display="block";
    document.documentElement.style.margin=0; document.body.style.margin=0;
    document.body.style.overflow="hidden";
    document.body.style.background="#000";
});

EM_JS(void, js_gfx_resize, (int w, int h), {
    if (!Module._canvas) return;
    var dpr = window.devicePixelRatio || 1;
    Module._canvas.width = w; Module._canvas.height = h;
    Module._cw = w; Module._ch = h;
});

EM_JS(void, js_gfx_begin, (), {
    if (!Module._ctx) return;
    var c = Module._ctx; c.save(); c.setTransform(1,0,0,1,0,0);
    c.clearRect(0,0,Module._cw,Module._ch);
    c.imageSmoothingEnabled = false;
});

EM_JS(void, js_gfx_fill, (int rgba), {
    var c=Module._ctx;
    var r=(rgba)&0xff, g=(rgba>>8)&0xff, b=(rgba>>16)&0xff, a=((rgba>>24)&0xff)/255;
    c.fillStyle = "rgba("+r+","+g+","+b+","+a+")";
});

EM_JS(void, js_gfx_rect, (float x, float y, float w, float h, int rgba), {
    js_gfx_fill(rgba); Module._ctx.fillRect(x,y,w,h);
});

EM_JS(void, js_gfx_text, (const char *s, float x, float y, float sc, int rgba), {
    var c=Module._ctx; js_gfx_fill(rgba);
    c.font = Math.floor(16*sc)+"px monospace";
    c.textBaseline="top";
    c.fillText(UTF8ToString(s), x, y);
});

EM_JS(void, js_gfx_end, (), {
    Module._ctx.restore();
});

EM_JS(double, js_now, (), { return performance.now()/1000.0; });

EM_JS(void, js_request_fullscreen, (), {
    var c = Module._canvas; if (c && c.requestFullscreen) c.requestFullscreen().catch(function(){});
});

EM_JS(int, js_is_mobile, (), {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 1 : 0;
});

#endif /* CB_JS_BRIDGE_INC */
