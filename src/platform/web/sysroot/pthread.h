#ifndef CB_WEB_PTHREAD_SHIM_H
#define CB_WEB_PTHREAD_SHIM_H
/* Однопоточный WASM: pthread-примитивы — no-op, не нужен -s USE_PTHREADS. */
#include <time.h>
typedef int pthread_mutex_t;
typedef unsigned long pthread_t;
#define PTHREAD_MUTEX_INITIALIZER 0
typedef struct { int _cb4_dummy; } pthread_attr_t;
static inline int pthread_mutex_lock(pthread_mutex_t *m){(void)m;return 0;}
static inline int pthread_mutex_unlock(pthread_mutex_t *m){(void)m;return 0;}
static inline int pthread_create(pthread_t *t,const pthread_attr_t*a,void*(*fn)(void*),void*arg){
    (void)a; if(t)*t=0;
    if(fn) fn(arg);
    return 0;
}
static inline int pthread_detach(pthread_t t){(void)t;return 0;}
#endif
