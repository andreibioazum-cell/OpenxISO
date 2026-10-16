#include "engine/runtime.h"
#include <stdarg.h>
#include <stdio.h>
#ifdef __EMSCRIPTEN__
/* Однопоточный WASM: pthread/android/nanosleep даём в собственном <pthread.h>,
 * который лежит в src/platform/web/sysroot и подкладывается через -I в сборке.
 * Так не нужен -s USE_PTHREADS и liblog. */
#include <pthread.h>
#include <math.h>
#else
#include <pthread.h>
#include <math.h>
#endif
#include <time.h>
#define DS_ERROR_MESSAGE_SIZE 1024
#define DS_CONSOLE_MAX 256
#define DS_CONSOLE_LINE_MAX 192
static char ds_console_buf[DS_CONSOLE_MAX][DS_CONSOLE_LINE_MAX];
static int ds_console_type_buf[DS_CONSOLE_MAX];
static int ds_console_head = 0;
static int ds_console_count = 0;
static pthread_mutex_t ds_console_lock = PTHREAD_MUTEX_INITIALIZER;
static void console_lock(void) {
    pthread_mutex_lock(&ds_console_lock);
}
static void console_unlock(void) {
    pthread_mutex_unlock(&ds_console_lock);
}
#define DS_CONSOLE_READ_SLOTS 8
static char ds_console_read[DS_CONSOLE_READ_SLOTS][DS_CONSOLE_LINE_MAX];
static int ds_console_read_pos = 0;
static void console_add(const char *line, int is_error) {
    if (!line)
        return;
    char tmp[DS_CONSOLE_LINE_MAX];
    size_t n = strlen(line);
    size_t w = 0;
    for (size_t i = 0; i < n && w + 1 < sizeof(tmp); i++) {
        char c = line[i];
        tmp[w++] = (c == '\n' || c == '\r') ? ' ' : c;
    }
    tmp[w] = '\0';
    console_lock();
    snprintf(ds_console_buf[ds_console_head], DS_CONSOLE_LINE_MAX, "%s", tmp);
    ds_console_type_buf[ds_console_head] = is_error ? 1 : 0;
    ds_console_head = (ds_console_head + 1) % DS_CONSOLE_MAX;
    if (ds_console_count < DS_CONSOLE_MAX)
        ds_console_count++;
    console_unlock();
}
int console_count(void) {
    return ds_console_count;
}
int console_type(int index) {
    int t = 0;
    console_lock();
    if (index >= 0 && index < ds_console_count) {
        int pos = (ds_console_head - ds_console_count + index) % DS_CONSOLE_MAX;
        if (pos < 0)
            pos += DS_CONSOLE_MAX;
        t = ds_console_type_buf[pos];
    }
    console_unlock();
    return t;
}
const char *console_line(int index) {
    console_lock();
    char *slot = ds_console_read[ds_console_read_pos];
    ds_console_read_pos = (ds_console_read_pos + 1) % DS_CONSOLE_READ_SLOTS;
    if (index >= 0 && index < ds_console_count) {
        int pos = (ds_console_head - ds_console_count + index) % DS_CONSOLE_MAX;
        if (pos < 0)
            pos += DS_CONSOLE_MAX;
        snprintf(slot, DS_CONSOLE_LINE_MAX, "%s", ds_console_buf[pos]);
    } else {
        slot[0] = '\0';
    }
    console_unlock();
    return slot;
}
Joy joy = {0};
int screen_w = 0;
int screen_h = 0;
double dt = 0.0;
int mouse_clicked = 0;
double ds_mouse_x = 0.0;
double ds_mouse_y = 0.0;
static jmp_buf ds_error_jump;
static int ds_error_handler_active = 0;
static int ds_has_error = 0;
static int ds_restart_requested = 0;
static char ds_last_error[DS_ERROR_MESSAGE_SIZE] = {0};
typedef struct DSStringNode DSStringNode;
struct DSStringNode {
    DSStringNode *next;
    char *string;
    unsigned long gen;
};
static DSStringNode *ds_strings = NULL;
/* Номер текущего кадра: по нему строки, которые уже отрисованы, находятся и
 * освобождаются. */
static unsigned long ds_string_gen = 0;
static void platform_log(int is_error, const char *format, va_list args) {
#ifdef __EMSCRIPTEN__
    vfprintf(is_error ? stderr : stdout, format, args);
    fprintf(is_error ? stderr : stdout, "\n");
#else
    __android_log_vprint(is_error ? ANDROID_LOG_ERROR : ANDROID_LOG_INFO, "CubicBattle", format, args);
#endif
}
void ds_log(const char *format, ...) {
    char tmp[DS_CONSOLE_LINE_MAX];
    va_list args;
    va_start(args, format);
    platform_log(0, format, args);
    va_end(args);
    va_start(args, format);
    vsnprintf(tmp, sizeof(tmp), format, args);
    va_end(args);
    console_add(tmp, 0);
}
void ds_log_err(const char *format, ...) {
    char tmp[DS_CONSOLE_LINE_MAX];
    va_list args;
    va_start(args, format);
    platform_log(1, format, args);
    va_end(args);
    va_start(args, format);
    vsnprintf(tmp, sizeof(tmp), format, args);
    va_end(args);
    console_add(tmp, 1);
}
void ds_console_log(int is_error, const char *format, ...) {
    char tmp[DS_CONSOLE_LINE_MAX];
    va_list args;
    va_start(args, format);
    platform_log(is_error, format, args);
    va_end(args);
    va_start(args, format);
    vsnprintf(tmp, sizeof(tmp), format, args);
    va_end(args);
    console_add(tmp, is_error ? 1 : 0);
}
void ds_runtime_error(const char *format, ...) {
    char tmp[DS_CONSOLE_LINE_MAX];
    va_list args, copy;
    va_start(args, format);
    va_copy(copy, args);
    vsnprintf(ds_last_error, sizeof(ds_last_error), format, copy);
    va_end(copy);
    platform_log(1, format, args);
    va_end(args);
    va_start(args, format);
    vsnprintf(tmp, sizeof(tmp), format, args);
    va_end(args);
    console_add(tmp, 1);
    ds_has_error = 1;
    if (ds_error_handler_active)
        longjmp(ds_error_jump, 1);
}
int ds_call_protected(DSProtectedFunction function, void *userdata, const char *label) {
    int jumped;
    if (!function) {
        if (label && *label)
            ds_runtime_error("cannot call an empty game hook '%s'", label);
        else
            ds_runtime_error("cannot call an empty game hook");
        return 0;
    }
    if (ds_error_handler_active) {
        function(userdata);
        return !ds_has_error;
    }
    ds_error_handler_active = 1;
    jumped = setjmp(ds_error_jump);
    if (jumped == 0) {
        /* Каждый хук начинается с чистого листа: ошибка, поднятая где-то вне
         * него (например в фоновом потоке), не должна ронять здоровый кадр и
         * отправлять игрока из боя в лобби. */
        ds_clear_runtime_error();
        function(userdata);
        ds_error_handler_active = 0;
        return !ds_has_error;
    }
    ds_error_handler_active = 0;
    if (label && *label && ds_last_error[0] == '\0') {
        snprintf(ds_last_error, sizeof(ds_last_error), "game hook '%s' failed", label);
    }
    return 0;
}
const char *ds_runtime_error_message(void) {
    return ds_last_error[0] ? ds_last_error : "unknown CubicBattle runtime error";
}
int ds_game_has_error(void) {
    return ds_has_error;
}
void ds_clear_runtime_error(void) {
    ds_has_error = 0;
    ds_last_error[0] = '\0';
}
void ds_request_game_restart(void) {
    ds_restart_requested = 1;
}
int ds_game_restart_requested(void) {
    return ds_restart_requested;
}
void ds_clear_game_restart(void) {
    ds_restart_requested = 0;
}
static char *ds_strdup(const char *s) {
    if (!s)
        s = "";
    size_t n = strlen(s) + 1;
    char *c = (char *)malloc(n);
    if (c)
        memcpy(c, s, n);
    return c;
}
/* Пустая строка на случай, когда под строку не нашлось памяти: одна
 * недописная цифра в HUD не имеет права обрушить весь бой. */
static char ds_empty_string[1] = {0};
static char *ds_track_string(char *s) {
    DSStringNode *node;
    if (!s) {
        ds_console_log(1, "runtime: no memory for a string");
        return ds_empty_string;
    }
    node = (DSStringNode *)malloc(sizeof(*node));
    if (!node) {
        ds_console_log(1, "runtime: no memory to track a string");
        free(s);
        return ds_empty_string;
    }
    node->string = s;
    node->gen = ds_string_gen;
    node->next = ds_strings;
    ds_strings = node;
    return s;
}
/* Вызывается раз в кадр, до игровых хуков. Все строки, построенные за кадр,
 * нужны только внутри него: текст копируется в буфер команд, а сетевые вызовы
 * забирают своё сразу. Историю держим в один кадр, чтобы ничего не повисло, и
 * освобождаем всё, что старше, - иначе пул растёт весь сеанс и под бой память
 * кончается, из-за чего игра перезапускается и выбрасывает в лобби. */
void ds_string_pool_tick(void) {
    DSStringNode **link = &ds_strings;
    ds_string_gen = ds_string_gen + 1;
    while (*link) {
        DSStringNode *node = *link;
        if (node->gen + 2 <= ds_string_gen) {
            *link = node->next;
            free(node->string);
            free(node);
        } else {
            link = &node->next;
        }
    }
}
char *ds_num_to_string(double number) {
    char buf[96];
    if (snprintf(buf, sizeof(buf), "%g", number) < 0)
        return NULL;
    return ds_track_string(ds_strdup(buf));
}
void ds_string_pool_reset(void) {
    DSStringNode *node = ds_strings;
    while (node) {
        DSStringNode *next = node->next;
        free(node->string);
        free(node);
        node = next;
    }
    ds_strings = NULL;
}
char *ds_concat(const char *left, const char *right) {
    size_t la = left ? strlen(left) : 0, lb = right ? strlen(right) : 0;
    char *out = (char *)malloc(la + lb + 1);
    if (!out)
        return ds_track_string(ds_strdup(""));
    if (la)
        memcpy(out, left, la);
    if (lb)
        memcpy(out + la, right, lb);
    out[la + lb] = '\0';
    return ds_track_string(out);
}
struct DSArray {
    double *data;
    size_t len, cap;
};
DSArray *arr_new(void) {
    DSArray *a = (DSArray *)calloc(1, sizeof(*a));
    if (!a) {
        ds_runtime_error("arr_new OOM");
        return NULL;
    }
    a->cap = 8;
    a->data = (double *)malloc(a->cap * sizeof(double));
    if (!a->data) {
        free(a);
        ds_runtime_error("arr_new OOM");
        return NULL;
    }
    return a;
}
void arr_push(DSArray *a, double v) {
    if (!a)
        return;
    if (a->len >= a->cap) {
        if (a->cap > SIZE_MAX / (2 * sizeof(double))) {
            ds_runtime_error("arr_push capacity overflow");
            return;
        }
        size_t nc = a->cap * 2;
        if (nc < 8)
            nc = 8;
        double *nd = (double *)realloc(a->data, nc * sizeof(double));
        if (!nd) {
            ds_runtime_error("arr_push OOM");
            return;
        }
        a->data = nd;
        a->cap = nc;
    }
    a->data[a->len++] = v;
}
double arr_get(DSArray *a, double idx) {
    if (!a)
        return 0;
    long i = (long)idx;
    if (i < 0 || (size_t)i >= a->len)
        return 0;
    return a->data[i];
}
void arr_set(DSArray *a, double idx, double v) {
    if (!a)
        return;
    long i = (long)idx;
    if (i < 0)
        return;
    if ((size_t)i >= a->len) {
        while (a->len <= (size_t)i) {
            size_t old_len = a->len;
            arr_push(a, 0);
            if (a->len == old_len)
                return;
        }
    }
    a->data[i] = v;
}
double arr_len(DSArray *a) {
    return a ? (double)a->len : 0;
}
void arr_clear(DSArray *a) {
    if (a)
        a->len = 0;
}
void arr_free(DSArray *a) {
    if (!a)
        return;
    free(a->data);
    free(a);
}
