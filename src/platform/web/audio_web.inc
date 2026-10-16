/* Аудио на вебе: простая заглушка (без звука, чтобы не тянуть OpenSL/AAudio). */
#ifndef CB_AUDIO_WEB_INC
#define CB_AUDIO_WEB_INC
int ds_sound_init(AAssetManager *assets) { (void)assets; return 1; }
void ds_sound_shutdown(void) {}
void ds_sound_suspend(void) {}
void ds_sound_pause(void) {}
void ds_sound_resume(void) {}
void ds_sound_set_java_vm(void *vm) { (void)vm; }
int snd_load(const char *name) { (void)name; return 1; }
int snd_play(const char *name) { (void)name; return 1; }
int snd_loop(const char *name) { (void)name; return 1; }
void snd_stop(const char *name) { (void)name; }
int snd_playing(const char *name) { (void)name; return 0; }
void snd_volume(const char *name, double volume) { (void)name; (void)volume; }
#endif
