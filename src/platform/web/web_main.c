/* Главный цикл веб-версии (Emscripten + WebAssembly + Canvas 2D).
 * Компилируется emcc в .wasm + .js. Всё от Java убрано, клавиатура и
 * алерты — на чистом JavaScript, графика — Canvas 2D (простейший вариант). */
#include <emscripten.h>
#include <emscripten/html5.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>

/* --- Замена Android-заголовков (на вебе нет NDK, никакой Java) --- */
/* Определения AAssetManager/ANativeWindow и __android_log_print даются в
 * engine/runtime/core.inc (используется одинаково на всём web-пути). */
#ifndef EM_TRUE
#define EM_TRUE 1
#define EM_FALSE 0
#endif

#include "platform/web/js_bridge.inc"
#include "engine/runtime.h"
#include "engine/network.h"
#include "game/game.h"

void web_show_start_alert_once(void);
static AAssetManager web_amgr = {0};
static int game_active = 0;
static int init_done = 0;
static int game_started_once = 0;
static Buffer frame = {0};
static double prev_frame_t = 0;

static double now_sec(void) { return js_now(); }

static void protected_game_init(void *u) { game_init((AAssetManager*)u); }
static void protected_game_reset(void *u) { (void)u; game_reset(); }
static void protected_game_update(void *u) { (void)u; game_update(); }
static void protected_game_draw(void *u) { game_draw((Buffer*)u); }
typedef struct { float x,y; int action; int id; } TouchCall;
static void protected_game_touch(void *u) {
    TouchCall *c = (TouchCall*)u;
    game_touch(c->x, c->y, c->action, c->id);
}

static int start_game(int reset) {
    ds_clear_runtime_error(); ds_clear_game_restart(); ds_string_pool_reset();
    if (reset) { ds_call_protected(protected_game_reset, NULL, "reset"); }
    ds_clear_runtime_error();
    if (!ds_call_protected(protected_game_init, &web_amgr, "init")) return 0;
    game_active = 1; game_started_once = 1;
    return 1;
}

/* --- Обработчики ввода с DOM --- */
static EM_BOOL on_mouse(int type, const EmscriptenMouseEvent *e, void *ud) {
    (void)type; (void)ud;
    if (!game_active) return EM_FALSE;
    TouchCall c = { (float)e->canvasX, (float)e->canvasY,
        type==EMSCRIPTEN_EVENT_MOUSEDOWN?0:(type==EMSCRIPTEN_EVENT_MOUSEUP?1:2), 0 };
    mouse_clicked = (type==EMSCRIPTEN_EVENT_MOUSEDOWN)?1:0;
    ds_mouse_x = c.x; ds_mouse_y = c.y;
    ds_call_protected(protected_game_touch, &c, "mouse");
    return EM_TRUE;
}

static EM_BOOL on_touch(int type, const EmscriptenTouchEvent *e, void *ud) {
    (void)type; (void)ud;
    if (!game_active || e->numTouches==0) return EM_FALSE;
    for (int i=0;i<e->numTouches;i++) {
        TouchCall c = { (float)e->touches[i].canvasX, (float)e->touches[i].canvasY,
            type==EMSCRIPTEN_EVENT_TOUCHSTART?0:(type==EMSCRIPTEN_EVENT_TOUCHEND?1:2),
            e->touches[i].identifier };
        ds_call_protected(protected_game_touch, &c, "touch");
    }
    return EM_TRUE;
}

static EM_BOOL on_key(int type, const EmscriptenKeyboardEvent *e, void *ud) {
    (void)type; (void)ud;
    /* Esc=back */
    if (e->keyCode==27) { game_back(); return EM_TRUE; }
    if (keyboard_visible()) {
        /* JS-ввод сам попадает в <input>, здесь ничего не делаем */
        return EM_TRUE;
    }
    return EM_FALSE;
}

static void do_frame(void) {
    if (!init_done) return;
    ds_string_pool_tick();
    double t = now_sec();
    dt = prev_frame_t ? (t - prev_frame_t) : 0.0;
    if (dt<0) dt=0; if (dt>0.1) dt=0.1;
    prev_frame_t = t;

    int w, h;
    emscripten_get_canvas_element_size("gameCanvas", &w, &h);
    if (w<1) w=800; if (h<1) h=600;
    screen_w = w; screen_h = h;

    if (game_active) {
        if (!ds_call_protected(protected_game_update, NULL, "update")) game_active = 0;
    }
    frame.pixels = NULL; frame.width = w; frame.height = h; frame.stride = w;
    if (ds_graphics_begin_frame(&frame)) {
        if (game_active) {
            if (!ds_call_protected(protected_game_draw, &frame, "draw")) game_active = 0;
            ds_graphics_end_frame();
        } else {
            ds_graphics_cancel_frame();
            if (!game_started_once || !game_active) start_game(game_started_once);
        }
    }
}

int main(void) {
    srand((unsigned)(time(0)^0x9E3779B9u));
    js_gfx_init("gameCanvas");
    /* Фиксированный размер canvas; для телефонов полноэкранный */
    int w = 900, h = 1600;
    emscripten_set_canvas_element_size("gameCanvas", w, h);
    screen_w = w; screen_h = h;

    emscripten_set_mousedown_callback("gameCanvas", 0, 1, on_mouse);
    emscripten_set_mouseup_callback("gameCanvas", 0, 1, on_mouse);
    emscripten_set_mousemove_callback("gameCanvas", 0, 1, on_mouse);
    emscripten_set_touchstart_callback("gameCanvas", 0, 1, on_touch);
    emscripten_set_touchend_callback("gameCanvas", 0, 1, on_touch);
    emscripten_set_touchmove_callback("gameCanvas", 0, 1, on_touch);
    emscripten_set_keydown_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, 0, 1, on_key);

    ds_set_activity(0);
    net_set_java_vm(0);
    ds_sound_set_java_vm(0);
    net_set_data_path("/home/user");
    net_set_system_language("ru");

    /* Инициализируем графику (Canvas 2D вместо Vulkan/WebGPU — самый простой вариант) */
    ds_graphics_init(&web_amgr, NULL);
    ds_sound_init(&web_amgr);
    ds_sound_resume();
    init_done = 1;

    /* Та самая табличка в начале игры ^_^ */
    web_show_start_alert_once();
    start_game(0);
    emscripten_set_main_loop(do_frame, 0, 1);
    return 0;
}

/* =================== Canvas 2D бэкенд + остальные модули (single TU) === */
#include "platform/web/canvas_gfx_core.inc"
#include "engine/audio.c"
#include "engine/network.c"
#include "engine/runtime.c"
#include "game/game.c"
