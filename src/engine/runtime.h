#ifndef RUNTIME_H
#define RUNTIME_H
#include <math.h>
#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#ifdef __EMSCRIPTEN__
/* Веб/WASM сборка: Android NDK нет; AAssetManager и ANativeWindow — пустые структуры-заглушки. */
struct AAssetManager { int dummy; };
typedef struct AAssetManager AAssetManager;
struct ANativeWindow { int dummy; };
typedef struct ANativeWindow ANativeWindow;
#else
#include <android/asset_manager.h>
#include <android/log.h>
#include <android/native_window.h>
#endif
typedef struct Buffer {
    uint32_t *pixels;
    int width;
    int height;
    int stride;
} Buffer;
extern int screen_w, screen_h;
extern double dt;
extern int mouse_clicked;
extern double ds_mouse_x, ds_mouse_y;
typedef struct {
    float x, y, dx, dy, ox, oy, r;
} Joy;
extern Joy joy;
void ds_log(const char *format, ...);
void ds_log_err(const char *format, ...);
void ds_console_log(int is_error, const char *format, ...);
typedef void (*DSProtectedFunction)(void *userdata);
int ds_call_protected(DSProtectedFunction function, void *userdata, const char *label);
void ds_runtime_error(const char *format, ...);
const char *ds_runtime_error_message(void);
int ds_game_has_error(void);
void ds_clear_runtime_error(void);
void ds_request_game_restart(void);
int ds_game_restart_requested(void);
void ds_clear_game_restart(void);
char *ds_concat(const char *left, const char *right);
char *ds_num_to_string(double number);
void ds_string_pool_reset(void);
void ds_string_pool_tick(void);
int console_count(void);
const char *console_line(int index);
int console_type(int index);
typedef struct DSArray DSArray;
DSArray *arr_new(void);
void arr_push(DSArray *a, double v);
double arr_get(DSArray *a, double idx);
void arr_set(DSArray *a, double idx, double v);
double arr_len(DSArray *a);
void arr_clear(DSArray *a);
void arr_free(DSArray *a);
double clamp(double v, double lo, double hi);
double lerp(double a, double b, double t);
double dist(double x1, double y1, double x2, double y2);

double ds_mod(double a, double b);
double str_len(const char *s);
int str_eq(const char *a, const char *b);
double str_index_of(const char *hay, const char *needle);
int str_starts_with(const char *s, const char *pref);
const char *str_sub(const char *s, double start, double len);
const char *str_trim(const char *s);
const char *str_upper(const char *s);
void ds_set_activity(void *activity);
void alpha_notice_show(double russian);
void bye_notice_show(const char *text);
void keyboard_show(void);
void keyboard_hide(void);
void keyboard_get_text_to(char *dst, size_t cap);
void keyboard_clear(void);
int keyboard_visible(void);
int keyboard_enter_pressed(void);
int keyboard_handle_key(int keycode, int action, int meta);
int keyboard_uses_editor(void);
void keyboard_type(const char *text);
void keyboard_backspace(void);
void rect(float x, float y, float w, float h, uint32_t color);
void roundrect(float x, float y, float w, float h, float r, uint32_t color);
/* C++-implemented glossy vertical gradient drawn as per-scanline strips
 * clipped to the rounded silhouette (src/game/cpp/ui_fx.cpp). */
void cb_button_gradient(float x, float y, float w, float h, float r, uint32_t color);

void rect_rot(float x, float y, float w, float h, float angle, uint32_t color);
void circle(float x, float y, float r, uint32_t color);
void ring(float x, float y, float r, float t, uint32_t color);
void line(float x1, float y1, float x2, float y2, float thickness, uint32_t color);
void ds_set_asset_manager(AAssetManager *assets);
void ds_release_assets(void);
int png_load(const char *name);
int tex_ready(const char *name);
void tex(float x, float y, const char *name, float angle, float scale);
void tex_tint(float x, float y, const char *name, float angle, float scale, uint32_t color);
void tex_alpha(float x, float y, const char *name, float angle, float scale, double alpha);
void tex_round(float x, float y, const char *name, float scale, float radius);

/* Grayscale filter for the whole frame (1 = black and white, 0 = normal) and
 * a small decaying screen shake (amplitude in pixels, duration in seconds). */
void ds_gfx_gray(double on);
void ds_gfx_shake(double amp, double seconds);

int snd_load(const char *name);
int snd_play(const char *name);

int snd_loop(const char *name);
void snd_stop(const char *name);
int snd_playing(const char *name);
void snd_volume(const char *name, double volume);
int ds_sound_init(AAssetManager *assets);
void ds_sound_shutdown(void);

void ds_sound_suspend(void);
void ds_sound_pause(void);
void ds_sound_resume(void);
void ds_sound_set_java_vm(void *vm);

#define DS_FONT_ASSET "fonts/ComicRelief-Regular.ttf"
#define DS_FONT_PIXEL_HEIGHT 32
void text(const char *string, float x, float y, uint32_t color);
void text_scaled(const char *string, float x, float y, uint32_t color, float scale);

int text_ink_width(const char *string);
int text_ink_height(const char *string);
int text_ink_top(const char *string);

void ds_graphics_report_frame_interval(double seconds);
int ds_graphics_pixel_scale(void);

int ds_graphics_init(AAssetManager *assets, ANativeWindow *window);
int ds_graphics_begin_frame(Buffer *buffer);
void ds_graphics_end_frame(void);
void ds_graphics_cancel_frame(void);

void ds_graphics_window_lost(void);
void ds_graphics_shutdown(void);
void ds_graphics_error_screen(const char *message);

const char *ds_graphics_failure(void);
int ds_graphics_show_failure(ANativeWindow *window, int attempts);
#endif
