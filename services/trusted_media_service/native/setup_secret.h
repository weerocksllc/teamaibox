#ifndef TEAMAIBOX_SETUP_SECRET_H
#define TEAMAIBOX_SETUP_SECRET_H
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* SETUP's IV and FairPlay key are fixed-size binary plist fields. Reject
 * absent, wrong-type, short and oversized fields before any memory access. */
static int teamaibox_copy_setup_secret(void *destination, size_t expected,
                                       const void *source, uint64_t received) {
    if (!destination || !source || (expected != 16 && expected != 72) || received != expected) return 0;
    memcpy(destination, source, expected);
    return 1;
}
#endif
