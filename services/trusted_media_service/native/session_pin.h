#ifndef TEAMAIBOX_SESSION_PIN_H
#define TEAMAIBOX_SESSION_PIN_H

#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// Only a supervisor-owned anonymous pipe may deliver the session PIN. No
// argv/environment/config-file secret, inherited receiver choice, or fallback.
static inline bool teamaibox_read_session_pin(int fd, uint16_t *result) {
    unsigned char bytes[6] = {0};
    size_t count = 0;
    bool ended = false;
    struct timespec start, now;
    struct stat descriptor;
    if (result == NULL) return false;
    *result = 0;
    if (fstat(fd, &descriptor) != 0 || !S_ISFIFO(descriptor.st_mode)
        || clock_gettime(CLOCK_MONOTONIC, &start) != 0) return false;
    while (count < sizeof(bytes)) {
        if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) break;
        long elapsed = (now.tv_sec - start.tv_sec) * 1000
            + (now.tv_nsec - start.tv_nsec) / 1000000;
        if (elapsed >= 3000) break;
        struct pollfd ready = {fd, POLLIN, 0};
        int status = poll(&ready, 1, (int)(3000 - elapsed));
        if (status < 0 && errno == EINTR) continue;
        if (status <= 0 || (ready.revents & (POLLERR | POLLNVAL))) break;
        ssize_t received = read(fd, bytes + count, sizeof(bytes) - count);
        if (received < 0 && errno == EINTR) continue;
        if (received == 0) { ended = true; break; }
        if (received < 0) break;
        count += (size_t)received;
    }
    bool valid = ended && count == 5 && bytes[0] >= '1' && bytes[0] <= '9' && bytes[4] == '\n';
    uint16_t value = 0;
    for (size_t i = 0; i < 4; ++i) {
        valid = valid && bytes[i] >= '0' && bytes[i] <= '9';
        value = (uint16_t)(value * 10 + (bytes[i] >= '0' && bytes[i] <= '9' ? bytes[i] - '0' : 0));
    }
    volatile unsigned char *wipe = bytes;
    for (size_t i = 0; i < sizeof(bytes); ++i) wipe[i] = 0;
    if (valid) *result = value;
    return valid;
}
#endif
