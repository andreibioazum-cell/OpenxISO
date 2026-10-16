#include "engine/network.h"
#include "engine/runtime.h"
#include <math.h>
#include <stdint.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __EMSCRIPTEN__
/* pthread/android-log shims лежат в src/platform/web/sysroot. */
#include <pthread.h>
#else
#include <pthread.h>
#include <unistd.h>
#endif
#include <android/log.h>
#define LOG(...)                                                                                                       \
    do {                                                                                                               \
        __android_log_print(ANDROID_LOG_INFO, "CubicBattleNet", __VA_ARGS__);                                            \
        ds_console_log(0, __VA_ARGS__);                                                                                \
    } while (0)
#define LOGERR(...)                                                                                                    \
    do {                                                                                                               \
        __android_log_print(ANDROID_LOG_ERROR, "CubicBattleNet", __VA_ARGS__);                                           \
        ds_console_log(1, __VA_ARGS__);                                                                                \
    } while (0)
#define URL 512
#define BODY 1024
#define RESP 4096
#define CHAT_RESP 8192
#define WRITE_TICK 60
#define READ_TICK 60
#define CHAT_TICK 1000
#define EVENT_TICK 500

#define BANNER_TICK 1000
#define BANNER_COLOR_MAX 16

#define HEARTBEAT_TICK 2500

#define CHAT_PRUNE_TICK 5000
#define TIMEOUT 4000
#define STALE 6000
#define CHAT_MAX 32
#define CHAT_TEXT_MAX 96
#define LOGIN_NICK_MAX 16
#define SESSION_FILE "auth.dat"
#define PROGRESS_FILE "progress.dat"
#define ACHIEVEMENTS_FILE "achievements.dat"
#define BANS_FILE "bans.dat"
#define BAN_MAX 64
#define BAN_TICK 2000
#define BAN_WAIT 2500
#define BAN_KICK_TICK 2000

#define FB_URL_MAX 2048
#define FB_ID_MAX 1100
#define FB_REFRESH_MAX 512
typedef pthread_mutex_t DSMutex;
#define DS_MUTEX_INIT PTHREAD_MUTEX_INITIALIZER
#define ds_mutex_lock(m) pthread_mutex_lock(&(m))
#define ds_mutex_unlock(m) pthread_mutex_unlock(&(m))
typedef pthread_t DSThread;
static DSThread ds_thread_start(void *(*fn)(void *), void *arg) {
    pthread_t t;
    if (pthread_create(&t, NULL, fn, arg) != 0)
        return (pthread_t)0;
    return t;
}
static void ds_thread_detach(DSThread t) {
    if (t)
        pthread_detach(t);
}

typedef struct {
    double x, y, a, hp, alive;
    double punch_x, punch_y, punch_dx, punch_dy, punch;
    double snow_x, snow_y, snow_dx, snow_dy, snow;
    double station_x, station_y, station_hp, station;
    double station2_x, station2_y, station2_hp;
    double station3_x, station3_y, station3_hp;
    double dash_x, dash_y, dash_dx, dash_dy, dash;

    double grab_x, grab_y, grab_dx, grab_dy, grab;
    double universe_x, universe_y, universe;
    double thud;
    double block;
    double ccu;
    double cls, level, skin;
    int online;
    char nick[24];
} Actor;
typedef struct {
    char key[28];
    char uid[24];
    char nick[24];
    char text[CHAT_TEXT_MAX];
    int valid;
} ChatMsg;
static int chat_keep = 20;
static struct {
    DSThread thread, rthread;
    DSMutex lock;
    JavaVM *vm;
    int run, started, slot, status;

    unsigned gen;
    int self_banned;
    char base[256], room[48], uid[24];
    Actor me;
    unsigned long seq, count;
    Actor players[NET_SLOTS];
    ChatMsg chats[CHAT_MAX];
    int chat_count;
    int event;
    char banner_text[CHAT_TEXT_MAX];
    char banner_color[BANNER_COLOR_MAX];
    long long banner_ts;
} net = {.lock = DS_MUTEX_INIT};

typedef struct {
    DSMutex lock;
    char nick[BAN_MAX][LOGIN_NICK_MAX + 1];
    int count, synced;
    long long synced_at;
} BanList;
static BanList banlist = {.lock = DS_MUTEX_INIT};
static void ban_lock(void) {
    ds_mutex_lock(banlist.lock);
}
static void ban_unlock(void) {
    ds_mutex_unlock(banlist.lock);
}

static volatile sig_atomic_t net_fast = 0;

static unsigned long claim_seen_seq[NET_SLOTS];
static long long claim_seen_at[NET_SLOTS];
static char claim_seen_uid[NET_SLOTS][24];
static unsigned long rp_lseq[NET_SLOTS];
static long long rp_lch[NET_SLOTS];
static long long rp_kicked[NET_SLOTS];
static char s_chat_text_ret[CHAT_TEXT_MAX];
static char s_chat_uid_ret[24];
static char s_nick_ret[24];
static char s_lg_nick_ret[24];
static char s_lg_pass_ret[64];
static char s_ban_target_ret[32];
static char s_banner_text_ret[CHAT_TEXT_MAX];
static char s_banner_color_ret[BANNER_COLOR_MAX];
static char s_text_cmd_text_ret[CHAT_TEXT_MAX];
static char s_text_cmd_color_ret[BANNER_COLOR_MAX];
static long long now_ms(void);
static void lock(void);
static void unlock(void);

typedef struct {
    DSMutex lock;
    int status;
    char session_nick[LOGIN_NICK_MAX + 1];
    char session_pass[64];
    char path[256];
} Login;
static Login lg = {.lock = DS_MUTEX_INIT};
static void lg_lock(void) {
    ds_mutex_lock(lg.lock);
}
static void lg_unlock(void) {
    ds_mutex_unlock(lg.lock);
}

typedef struct {
    DSMutex lock;
    int loaded, cups, candies, cls, azum, santa, ebuc, level, levels_unlocked;
    int ordinary_level, ordinary_levels_unlocked;
    int azum_level, azum_levels_unlocked;
    int santa_level, santa_levels_unlocked;
    int ebuc_level, ebuc_levels_unlocked;
    int bp_level, azum_skin;

    int astra, astra_level, astra_levels_unlocked;
} Progress;
static Progress pg = {.lock = DS_MUTEX_INIT};
#define LEVEL_MAX 3
#define BP_MAX 5
#define SKIN_MAX 1

#define SKIN_FLAGS_MAX 3

#define SKIN_OF_CLASS(flags, cls) (((cls) == 3) ? (((flags) >> 1) & 1) : (((cls) == 4 || (cls) == 6) ? 0 : ((flags) & 1)))
static int pending_cls = 0;
static int pending_level = 0;

static int pending_skin = 0;
static void pg_lock(void) {
    ds_mutex_lock(pg.lock);
}
static void pg_unlock(void) {
    ds_mutex_unlock(pg.lock);
}
static void data_file_path(char *path, size_t cap, const char *name) {
    lg_lock();
    if (lg.path[0])
        snprintf(path, cap, "%s/%s", lg.path, name);
    else
        snprintf(path, cap, "%s", name);
    lg_unlock();
}
static int clamp_level_value(int value) {
    if (value < 0)
        return 0;
    if (value > LEVEL_MAX)
        return LEVEL_MAX;
    return value;
}
static int clamp_levels_unlocked(int value) {
    if (value < 0)
        return 0;
    if (value > LEVEL_MAX)
        return LEVEL_MAX;
    return value;
}
static void normalize_level_pair(int *level, int *unlocked) {
    *unlocked = clamp_levels_unlocked(*unlocked);
    *level = clamp_level_value(*level);
    if (*level > *unlocked)
        *level = 0;
}

static void file_write_atomic(const char *path, const char *text) {
    char tmp[400];
    FILE *f;
    size_t n = strlen(text);
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    f = fopen(tmp, "w");
    if (f && (n == 0 || fwrite(text, 1, n, f) == n)) {
        fclose(f);
        rename(tmp, path);
        return;
    }
    if (f)
        fclose(f);
    remove(tmp);
}

static void progress_write(int cups, int candies, int cls, int azum, int santa, int ebuc, int level,
                           int levels_unlocked, int ordinary_level, int ordinary_levels_unlocked, int azum_level,
                           int azum_levels_unlocked, int santa_level, int santa_levels_unlocked, int ebuc_level,
                           int ebuc_levels_unlocked, int bp_level, int azum_skin, int astra, int astra_level,
                           int astra_levels_unlocked);
static void progress_read(void);

typedef struct {
    char plain[URL];
    char url[FB_URL_MAX];
    char body[BODY * 2];
    int progress;
} HttpJob;
static int fb_enabled(void);
static void fb_url(char *dst, size_t cap, const char *url);
static int fb_ensure_token(void);
static int fb_refresh_token_now(void);
static int net_log_ok(void);
static int http(const char *method, const char *url, const char *body, char *out, size_t cap);
static void *http_delete_job(void *arg);
static void room_slot_delete_async(int slot);
static void sleep_ms(int ms);

#define PROGRESS_DIRTY_FILE "progress.dirty"
static void cloud_dirty_set(int on) {
    char path[320];
    data_file_path(path, sizeof(path), PROGRESS_DIRTY_FILE);
    if (on)
        file_write_atomic(path, "1\n");
    else
        remove(path);
}
static int cloud_dirty_get(void) {
    char path[320];
    FILE *f;
    data_file_path(path, sizeof(path), PROGRESS_DIRTY_FILE);
    f = fopen(path, "r");
    if (!f)
        return 0;
    fclose(f);
    return 1;
}
