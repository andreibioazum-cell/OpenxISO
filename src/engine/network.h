#ifndef NET_H
#define NET_H
#ifdef __ANDROID__
#include <jni.h>
#else
typedef struct _JavaVM JavaVM;     /* web/desktop: заглушка вместо <jni.h> */
#endif

#define NET_SLOTS 4
#define NET_OFFLINE 0
#define NET_CONNECTING 1
#define NET_PLAYING 3
#define NET_ERROR 4
#define NET_LOGIN_IDLE 0
#define NET_LOGIN_OK 2
#define NET_LOGIN_BAD_NICK 5
#define NET_LOGIN_WRONG_PASS 6
#define NET_LOGIN_BAD_PASS 7

/* Firebase endpoint, web key and room. config.inc and the background presence
 * check (presence.inc) both read these, so the job works in a cold process. */
#define NET_FIREBASE_URL "https://cubicbattleserver-19ae2-default-rtdb.firebaseio.com"
#define NET_FIREBASE_KEY "AIzaSyDJEqopxP5EqEoxP_ehO3jFXbNztu3DgVs"
#define NET_DEFAULT_ROOM "main"

/* Два секрета. Оба — 32 случайных символа [A-Za-z0-9]; в открытом виде их в
 * исходниках нет: куски закодированы (каждый байт xor 0x5a) и собираются в
 * рантайме функциями net_write_secret() и net_pass_suffix().
 *
 * NET_WRITE_SECRET — «пароль на запись». Правила firebase.rules.json принимают
 * запись только если в теле лежит поле "w" с этим же значением, поэтому скрипт,
 * у которого есть только ключ API и аккаунт, ничего не изменит. Значение лежит
 * в базе открыто, поэтому оно НЕ должно совпадать со вторым секретом.
 *
 * NET_PASS_SECRET — хвост пароля аккаунта (пароль игрока + этот хвост). Раньше
 * вместо него была строка "|cb4v1", которую легко угадать: зная её, любой мог
 * подобрать пароль к чужому нику. В базу он не попадает никогда.
 *
 * Менять оба сразу утилитой tools/rotate_db_secret.py: она генерирует новые
 * значения, переписывает эти макросы и firebase.rules.json. Вручную не править:
 * база и клиент должны оставаться одинаковыми. */
#define NET_SECRET_XOR 0x5a

#define NET_WRITE_SECRET_LEN 32
#define NET_WRITE_SECRET_0 "\030\027\033\062\040\061\150\154\063\055\014\020"
#define NET_WRITE_SECRET_1 "\033\021\151\021\052\012\042\065\034\031\040\061"
#define NET_WRITE_SECRET_2 "\056\152\142\034\026\152\022\071"

#define NET_PASS_SECRET_LEN 32
#define NET_PASS_SECRET_0 "\063\154\017\075\040\151\033\066\036\026\076\075"
#define NET_PASS_SECRET_1 "\022\020\154\063\017\054\061\027\025\055\024\062"
#define NET_PASS_SECRET_2 "\021\021\024\025\064\066\055\071"

#if defined(__ANDROID__)
void net_set_java_vm(JavaVM *vm);
#elif defined(__EMSCRIPTEN__)
void net_set_java_vm(void *vm);
#endif

void net_connect(const char *url, const char *room);
void net_disconnect(void);
void net_set_data_path(const char *path);
/* Язык телефона (ISO 639-1, например "ru"): по нему выбирается язык новой установки. */
void net_set_system_language(const char *code);

void net_set_firebase_key(const char *key);
void net_autologin(const char *url);
int net_presence_check(const char *data_dir);
double net_auth(const char *url, const char *nick, const char *pass);
void net_logout(void);
double net_login_status(void);
const char *net_login_nick(void);
const char *net_login_pass(void);

void net_publish(double x, double y, double angle, double hp, double alive);
void net_publish_punch(double x, double y, double dx, double dy, double punch);
void net_publish_snow(double x, double y, double dx, double dy, double snow);

void net_publish_turrets(double x1, double y1, double hp1, double x2, double y2, double hp2, double x3, double y3,
                         double hp3, double count);

void net_publish_dash(double x, double y, double dx, double dy, double dash);

void net_publish_grab(double x, double y, double dx, double dy, double grab);
void net_publish_universe(double x, double y, double counter);

void net_publish_thud(double counter);
void net_publish_block(double on);
void net_publish_codecracker_super(double on);
void net_set_class(double cls);
double net_status(void);
double net_slot(void);
double net_event(void);
void net_event_set(double mode);
double net_player_online(double slot);
double net_player_x(double slot);
double net_player_y(double slot);
double net_player_angle(double slot);
double net_player_hp(double slot);
double net_player_alive(double slot);
const char *net_player_nick(double slot);
double net_player_punch_x(double slot);
double net_player_punch_y(double slot);
double net_player_punch_dx(double slot);
double net_player_punch_dy(double slot);
double net_player_punch(double slot);
double net_player_snow_x(double slot);
double net_player_snow_y(double slot);
double net_player_snow_dx(double slot);
double net_player_snow_dy(double slot);
double net_player_snow(double slot);
double net_player_station_x(double slot);
double net_player_station_y(double slot);
double net_player_station_hp(double slot);
double net_player_station2_x(double slot);
double net_player_station2_y(double slot);
double net_player_station2_hp(double slot);
double net_player_station3_x(double slot);
double net_player_station3_y(double slot);
double net_player_station3_hp(double slot);

double net_player_grab_x(double slot);
double net_player_grab_y(double slot);
double net_player_grab_dx(double slot);
double net_player_grab_dy(double slot);
double net_player_grab(double slot);
double net_player_universe_x(double slot);
double net_player_universe_y(double slot);
double net_player_universe(double slot);

double net_player_thud(double slot);
double net_player_block(double slot);
double net_player_codecracker_super(double slot);
double net_player_dash(double slot);
double net_player_dash_x(double slot);
double net_player_dash_y(double slot);
double net_player_class(double slot);
double net_player_level(double slot);
void net_set_level(double level);

void net_set_skin(double skin);
double net_player_skin(double slot);

double net_load_cups(void);
double net_load_candies(void);
double net_load_class(void);
double net_load_azum(void);
double net_load_santa(void);
double net_load_ebuc(void);
double net_load_level(void);
double net_load_levels_unlocked(void);
double net_load_ordinary_level(void);
double net_load_ordinary_levels_unlocked(void);
double net_load_azum_level(void);
double net_load_azum_levels_unlocked(void);
double net_load_santa_level(void);
double net_load_santa_levels_unlocked(void);
double net_load_ebuc_level(void);
double net_load_ebuc_levels_unlocked(void);

double net_load_bp_level(void);
double net_load_azum_skin(void);

double net_load_astra(void);
double net_load_astra_level(void);
double net_load_astra_levels_unlocked(void);
void net_save_astra(double owned, double level, double levels_unlocked);
void net_save_progress_all(double cups, double candies, double cls, double azum, double santa, double ebuc,
                           double level, double levels_unlocked, double ordinary_level, double ordinary_levels_unlocked,
                           double azum_level, double azum_levels_unlocked, double santa_level,
                           double santa_levels_unlocked, double ebuc_level, double ebuc_levels_unlocked,
                           double bp_level, double azum_skin);

#define ACH_FLAG_ALL_CHARACTERS (1u << 3)
double net_load_achievement_flags(void);
void net_mark_achievement_flag(double flag);

double net_load_azum_revives(void);
void net_save_azum_revives(double revives);

double net_promo_2027_used(void);
void net_promo_2027_mark_used(void);


void net_leaderboard_fetch(const char *url);
double net_leaderboard_status(void);
double net_leaderboard_count(void);
const char *net_leaderboard_nick(double idx);
double net_leaderboard_cups(double idx);

double net_load_language(void);
double net_load_hitboxes(void);
void net_save_settings(double language, double hitboxes);
double net_load_music_volume(void);
void net_save_music_volume(double volume);
double net_load_winter_theme(void);
void net_save_winter_theme(double on);
double net_load_new_theme(void);
void net_save_new_theme(double on);

void settings_mark_legal(void);
double settings_legal_ts(void);
/* Согласие на обработку персональных данных (152-ФЗ): version 0 — отзыв. */
void settings_set_pd_consent(double version);
double settings_pd_consent_version(void);
void net_pd_consent_upload(void);
/* Удалить аккаунт, облачный профиль и данные на устройстве; нужен пароль
 * аккаунта. Статус: 0 — ничего, 1 — идёт, 2 — удалено, 3 — ошибка сети,
 * 4 — неверный пароль (результат отдаётся один раз). */
void net_delete_account(const char *password);
double net_delete_account_status(void);
/* Сменить пароль аккаунта. Статус: 0 — ничего, 1 — идёт, 2 — изменён,
 * 3 — ошибка сети, 4 — неверный текущий пароль, 5 — новый пароль не подходит,
 * 6 — не выполнен вход (результат отдаётся один раз). */
void net_change_password(const char *old_pass, const char *new_pass);
double net_change_password_status(void);

double net_banned(void);
double net_is_banned(const char *nick);
void net_ban_set(const char *nick, double banned);
double net_chat_is_ban(const char *msg);
double net_chat_is_unban(const char *msg);
const char *net_chat_ban_target(const char *msg);
const char *net_chat_unban_target(const char *msg);

double net_chat_is_text_cmd(const char *msg);
const char *net_chat_text_cmd_text(const char *msg);
const char *net_chat_text_cmd_color(const char *msg);
void net_banner_send(const char *text, const char *color);
void net_banner_clear(void);
double net_banner_ts(void);
const char *net_banner_text(void);
const char *net_banner_color(void);

void net_chat_send(const char *text);
void net_chat_trim(double keep);
double net_chat_count(void);
const char *net_chat_text(double idx);
const char *net_chat_uid(double idx);

const char *net_chat_key(double idx);

#endif
