#ifndef CB_NETWORK_WEB_INC
#define CB_NETWORK_WEB_INC
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
void alpha_notice_show(double a0){(void)a0;}
void bye_notice_show(const char*a0){(void)a0;}
double net_auth(const char*a0, const char*a1, const char*a2){(void)a0;(void)a1;(void)a2;return 0.0;}
void net_autologin(const char*a0){(void)a0;}
void net_ban_set(const char*a0, double a1){(void)a0;(void)a1;}
double net_banned(){return 0.0;}
void net_banner_clear(){}
const char* net_banner_color(){return "";}
void net_banner_send(const char*a0, const char*a1){(void)a0;(void)a1;}
const char* net_banner_text(){return "";}
double net_banner_ts(){return 0.0;}
void net_change_password(const char*a0, const char*a1){(void)a0;(void)a1;}
double net_change_password_status(){return 0.0;}
const char* net_chat_ban_target(const char*a0){(void)a0;return "";}
double net_chat_count(){return 0.0;}
double net_chat_is_ban(const char*a0){(void)a0;return 0.0;}
double net_chat_is_text_cmd(const char*a0){(void)a0;return 0.0;}
double net_chat_is_unban(const char*a0){(void)a0;return 0.0;}
const char* net_chat_key(double a0){(void)a0;return "";}
void net_chat_send(const char*a0){(void)a0;}
const char* net_chat_text(double a0){(void)a0;return "";}
const char* net_chat_text_cmd_color(const char*a0){(void)a0;return "";}
const char* net_chat_text_cmd_text(const char*a0){(void)a0;return "";}
void net_chat_trim(double a0){(void)a0;}
const char* net_chat_uid(double a0){(void)a0;return "";}
const char* net_chat_unban_target(const char*a0){(void)a0;return "";}
void net_connect(const char*a0, const char*a1){(void)a0;(void)a1;}
void net_delete_account(const char*a0){(void)a0;}
double net_delete_account_status(){return 0.0;}
void net_disconnect(){}
double net_event(){return 0.0;}
void net_event_set(double a0){(void)a0;}
double net_is_banned(const char*a0){(void)a0;return 0.0;}
double net_leaderboard_count(){return 0.0;}
double net_leaderboard_cups(double a0){(void)a0;return 0.0;}
void net_leaderboard_fetch(const char*a0){(void)a0;}
const char* net_leaderboard_nick(double a0){(void)a0;return "";}
double net_leaderboard_status(){return 0.0;}
double net_load_achievement_flags(){return 0.0;}
double net_load_astra(){return 0.0;}
double net_load_astra_level(){return 0.0;}
double net_load_astra_levels_unlocked(){return 0.0;}
double net_load_azum(){return 0.0;}
double net_load_azum_level(){return 0.0;}
double net_load_azum_levels_unlocked(){return 0.0;}
double net_load_azum_revives(){return 0.0;}
double net_load_azum_skin(){return 0.0;}
double net_load_bp_level(){return 0.0;}
double net_load_candies(){return 0.0;}
double net_load_class(){return 0.0;}
double net_load_cups(){return 0.0;}
double net_load_ebuc(){return 0.0;}
double net_load_ebuc_level(){return 0.0;}
double net_load_ebuc_levels_unlocked(){return 0.0;}
double net_load_hitboxes(){return 0.0;}
double net_load_language(){return 0.0;}
double net_load_level(){return 0.0;}
double net_load_levels_unlocked(){return 0.0;}
double net_load_music_volume(){return 0.0;}
double net_load_new_theme(){return 0.0;}
double net_load_ordinary_level(){return 0.0;}
double net_load_ordinary_levels_unlocked(){return 0.0;}
double net_load_santa(){return 0.0;}
double net_load_santa_level(){return 0.0;}
double net_load_santa_levels_unlocked(){return 0.0;}
double net_load_winter_theme(){return 0.0;}
const char* net_login_nick(){return "";}
const char* net_login_pass(){return "";}
double net_login_status(){return 0.0;}
void net_logout(){}
void net_mark_achievement_flag(double a0){(void)a0;}
void net_pd_consent_upload(){}
double net_player_alive(double a0){(void)a0;return 0.0;}
double net_player_angle(double a0){(void)a0;return 0.0;}
double net_player_block(double a0){(void)a0;return 0.0;}
double net_player_class(double a0){(void)a0;return 0.0;}
double net_player_codecracker_super(double a0){(void)a0;return 0.0;}
double net_player_dash(double a0){(void)a0;return 0.0;}
double net_player_dash_x(double a0){(void)a0;return 0.0;}
double net_player_dash_y(double a0){(void)a0;return 0.0;}
double net_player_grab(double a0){(void)a0;return 0.0;}
double net_player_grab_dx(double a0){(void)a0;return 0.0;}
double net_player_grab_dy(double a0){(void)a0;return 0.0;}
double net_player_grab_x(double a0){(void)a0;return 0.0;}
double net_player_grab_y(double a0){(void)a0;return 0.0;}
double net_player_hp(double a0){(void)a0;return 0.0;}
double net_player_level(double a0){(void)a0;return 0.0;}
const char* net_player_nick(double a0){(void)a0;return "";}
double net_player_online(double a0){(void)a0;return 0.0;}
double net_player_punch(double a0){(void)a0;return 0.0;}
double net_player_punch_dx(double a0){(void)a0;return 0.0;}
double net_player_punch_dy(double a0){(void)a0;return 0.0;}
double net_player_punch_x(double a0){(void)a0;return 0.0;}
double net_player_punch_y(double a0){(void)a0;return 0.0;}
double net_player_skin(double a0){(void)a0;return 0.0;}
double net_player_snow(double a0){(void)a0;return 0.0;}
double net_player_snow_dx(double a0){(void)a0;return 0.0;}
double net_player_snow_dy(double a0){(void)a0;return 0.0;}
double net_player_snow_x(double a0){(void)a0;return 0.0;}
double net_player_snow_y(double a0){(void)a0;return 0.0;}
double net_player_station2_hp(double a0){(void)a0;return 0.0;}
double net_player_station2_x(double a0){(void)a0;return 0.0;}
double net_player_station2_y(double a0){(void)a0;return 0.0;}
double net_player_station3_hp(double a0){(void)a0;return 0.0;}
double net_player_station3_x(double a0){(void)a0;return 0.0;}
double net_player_station3_y(double a0){(void)a0;return 0.0;}
double net_player_station_hp(double a0){(void)a0;return 0.0;}
double net_player_station_x(double a0){(void)a0;return 0.0;}
double net_player_station_y(double a0){(void)a0;return 0.0;}
double net_player_thud(double a0){(void)a0;return 0.0;}
double net_player_universe(double a0){(void)a0;return 0.0;}
double net_player_universe_x(double a0){(void)a0;return 0.0;}
double net_player_universe_y(double a0){(void)a0;return 0.0;}
double net_player_x(double a0){(void)a0;return 0.0;}
double net_player_y(double a0){(void)a0;return 0.0;}
int net_presence_check(const char*a0){(void)a0;return 0;}
void net_promo_2027_mark_used(){}
double net_promo_2027_used(){return 0.0;}
void net_publish(double a0, double a1, double a2, double a3, double a4){(void)a0;(void)a1;(void)a2;(void)a3;(void)a4;}
void net_publish_block(double a0){(void)a0;}
void net_publish_codecracker_super(double a0){(void)a0;}
void net_publish_dash(double a0, double a1, double a2, double a3, double a4){(void)a0;(void)a1;(void)a2;(void)a3;(void)a4;}
void net_publish_grab(double a0, double a1, double a2, double a3, double a4){(void)a0;(void)a1;(void)a2;(void)a3;(void)a4;}
void net_publish_punch(double a0, double a1, double a2, double a3, double a4){(void)a0;(void)a1;(void)a2;(void)a3;(void)a4;}
void net_publish_snow(double a0, double a1, double a2, double a3, double a4){(void)a0;(void)a1;(void)a2;(void)a3;(void)a4;}
void net_publish_thud(double a0){(void)a0;}
void net_publish_turrets(double a0, double a1, double a2, double a3, double a4, double a5, double a6, double a7, double a8, double a9){(void)a0;(void)a1;(void)a2;(void)a3;(void)a4;(void)a5;(void)a6;(void)a7;(void)a8;(void)a9;}
void net_publish_universe(double a0, double a1, double a2){(void)a0;(void)a1;(void)a2;}
void net_save_astra(double a0, double a1, double a2){(void)a0;(void)a1;(void)a2;}
void net_save_azum_revives(double a0){(void)a0;}
void net_save_music_volume(double a0){(void)a0;}
void net_save_new_theme(double a0){(void)a0;}
static void net_save_progress_all_dummy(double first,...){(void)first;}
#define net_save_progress_all(...) net_save_progress_all_dummy(0.0,##__VA_ARGS__)
void net_save_settings(double a0, double a1){(void)a0;(void)a1;}
void net_save_winter_theme(double a0){(void)a0;}
void net_set_class(double a0){(void)a0;}
void net_set_data_path(const char*a0){(void)a0;}
void net_set_firebase_key(const char*a0){(void)a0;}
void net_set_java_vm(void*a0){(void)a0;}
void net_set_level(double a0){(void)a0;}
void net_set_skin(double a0){(void)a0;}
void net_set_system_language(const char*a0){(void)a0;}
double net_slot(){return 0.0;}
double net_status(){return 0.0;}
double settings_legal_ts(){return 0.0;}
void settings_mark_legal(){}
double settings_pd_consent_version(){return 0.0;}
void settings_set_pd_consent(double a0){(void)a0;}

#endif
