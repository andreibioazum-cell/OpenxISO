#ifndef CB_NOTICE_WEB_INC
#define CB_NOTICE_WEB_INC
/* Web notice hooks: only ds_set_activity stub + start-page alert.
 * alpha_notice_show and bye_notice_show are provided as stubs in network_web.inc. */
#include "platform/web/js_bridge.inc"
static int web_start_alert_shown = 0;
void ds_set_activity(void *a) { (void)a; }
void web_show_start_alert_once(void) {
    if (web_start_alert_shown) return;
    web_start_alert_shown = 1;
    js_alert("это та табличка в начале игры ^_^");
}
#endif
