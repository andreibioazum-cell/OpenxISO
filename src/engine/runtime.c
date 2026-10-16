/* Базовые функции игрового рантайма. */
#include "engine/runtime/core.inc"
#include "engine/runtime/values.inc"
#ifdef __EMSCRIPTEN__
#include "platform/web/keyboard_web.inc"
#include "platform/web/notice_web.inc"
#else
#include "platform/android/keyboard.inc"
#include "platform/android/alpha_notice.inc"
#include "platform/android/bye_notice.inc"
#endif
