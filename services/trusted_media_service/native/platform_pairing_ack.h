#ifndef TEAMAIBOX_PLATFORM_PAIRING_ACK_H
#define TEAMAIBOX_PLATFORM_PAIRING_ACK_H

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <poll.h>
#include <time.h>

/* Supervisor-owned anonymous socketpair only. No pathname, network address,
 * PIN, token or fallback. Call only after the native SRP/GCM proof succeeds.
 * The supervisor sends ACK1 only after Platform accepts that exact session. */
static inline int64_t teamaibox_ack_clock_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static inline bool teamaibox_ack_transfer(int fd, unsigned char *buffer,
        size_t length, bool sending, int64_t deadline) {
    size_t offset = 0;
    while (offset < length) {
        int64_t now = teamaibox_ack_clock_ms();
        if (now < 0 || now >= deadline) return false;
        struct pollfd ready = {fd, sending ? POLLOUT : POLLIN, 0};
        int result = poll(&ready, 1, (int)(deadline - now));
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0 || (ready.revents & (POLLERR | POLLNVAL))) return false;
        int flags = MSG_DONTWAIT;
#ifdef MSG_NOSIGNAL
        if (sending) flags |= MSG_NOSIGNAL;
#endif
        ssize_t count = sending ? send(fd, buffer + offset, length - offset, flags)
            : recv(fd, buffer + offset, length - offset, flags);
        if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (count <= 0) return false;
        offset += (size_t)count;
    }
    return true;
}

static inline bool teamaibox_ack_anonymous_address(int fd, bool peer) {
    struct sockaddr_un address;
    socklen_t length = sizeof(address);
    memset(&address, 0, sizeof(address));
    int result = peer ? getpeername(fd, (struct sockaddr *)&address, &length)
        : getsockname(fd, (struct sockaddr *)&address, &length);
    if (result != 0 || address.sun_family != AF_UNIX || length > sizeof(address)
        || length < offsetof(struct sockaddr_un, sun_path)) return false;
    /* Darwin pads an unnamed address; Linux returns only the family. A named
     * pathname or abstract socket must not masquerade as our socketpair. */
    for (size_t i = offsetof(struct sockaddr_un, sun_path); i < length; ++i)
        if (((unsigned char *)&address)[i] != 0) return false;
    return true;
}

static inline bool teamaibox_platform_pairing_ack(int fd, const unsigned char key[32]) {
    int type = 0;
    socklen_t type_length = sizeof(type);
    if (!key || getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_length) != 0
        || type != SOCK_STREAM || !teamaibox_ack_anonymous_address(fd, true)
        || !teamaibox_ack_anonymous_address(fd, false)) return false;
#ifdef SO_NOSIGPIPE
    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) != 0) return false;
#endif
    int64_t now = teamaibox_ack_clock_ms();
    if (now < 0) return false;
    unsigned char request[36] = {'T','A','P','1'};
    unsigned char response[4] = {0};
    memcpy(request + 4, key, 32);
    bool allowed = teamaibox_ack_transfer(fd, request, sizeof(request), true, now + 7000)
        && teamaibox_ack_transfer(fd, response, sizeof(response), false, now + 7000)
        && memcmp(response, "ACK1", sizeof(response)) == 0;
    volatile unsigned char *wipe = request;
    for (size_t i = 0; i < sizeof(request); ++i) wipe[i] = 0;
    /* Poison a failed channel: a late ACK cannot authorize the next source. */
    if (!allowed) shutdown(fd, SHUT_RDWR);
    return allowed;
}
#endif
