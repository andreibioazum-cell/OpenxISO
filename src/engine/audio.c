/* Загрузка и воспроизведение звука. */
#ifdef __EMSCRIPTEN__
#include "platform/web/audio_web.inc"
#else
#include "engine/audio/decode_mixer.inc"
#include "engine/audio/playback.inc"
#include "platform/android/audio_output.inc"
#endif
