#ifndef RINGBACK_ECHO_NATIVE_H
#define RINGBACK_ECHO_NATIVE_H

#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
void *ringback_echo_new(void);
int ringback_echo_process(void *, const int16_t *, const int16_t *, int16_t *);
void ringback_echo_free(void *);
#ifdef __cplusplus
}
#endif

#endif
