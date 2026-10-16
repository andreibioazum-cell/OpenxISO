/* Клавиатура — JS-аналог (вместо Java/JNI). */
#ifndef CB_KEYBOARD_WEB_INC
#define CB_KEYBOARD_WEB_INC
#include "platform/web/js_bridge.inc"
#define KB_BUF_WEB 384
static char kb_text_web[KB_BUF_WEB] = {0};
static int kb_visible_web = 0;
static int kb_uses_editor_web = 1;
void keyboard_show(void) { js_kb_show(); kb_visible_web = 1; kb_uses_editor_web = 1; }
void keyboard_hide(void) { js_kb_hide(); kb_visible_web = 0; }
void keyboard_get_text_to(char *dst, size_t cap) { js_kb_gettext(dst, (int)cap); }
void keyboard_clear(void) { js_kb_clear(); kb_text_web[0] = 0; }
int keyboard_visible(void) { return js_kb_visible(); }
int keyboard_enter_pressed(void) { return js_kb_enter(); }
int keyboard_uses_editor(void) { return kb_uses_editor_web; }
void keyboard_type(const char *text) { js_kb_type(text); }
void keyboard_backspace(void) { js_kb_backspace(); }
int keyboard_handle_key(int keycode, int action, int meta) { (void)keycode; (void)action; (void)meta; return 0; }
#endif
