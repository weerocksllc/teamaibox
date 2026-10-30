#include "platform_pairing_ack.h"
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)

static int exchange(bool accept) {
    int fds[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) {
        close(fds[0]);
        unsigned char request[36] = {0};
        bool received = teamaibox_ack_transfer(fds[1], request, sizeof(request), false,
            teamaibox_ack_clock_ms() + 1000);
        unsigned char response[4] = {'A','C','K','1'};
        if (!accept) response[0] = 'X';
        bool sent = received && memcmp(request, "TAP1", 4) == 0
            && request[4] == 7
            && teamaibox_ack_transfer(fds[1], response, sizeof(response), true,
                teamaibox_ack_clock_ms() + 1000);
        close(fds[1]);
        _exit(sent ? 0 : 2);
    }
    close(fds[1]);
    unsigned char key[32] = {7};
    bool approved = teamaibox_platform_pairing_ack(fds[0], key);
    close(fds[0]);
    int status = 0;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    CHECK(approved == accept);
    return 0;
}

int main(void) {
    CHECK(exchange(true) == 0);
    CHECK(exchange(false) == 0);
    unsigned char key[32] = {7};
    CHECK(!teamaibox_platform_pairing_ack(-1, key));
    int fds[2];
    CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, fds) == 0);
    close(fds[1]);
    CHECK(!teamaibox_platform_pairing_ack(fds[0], key));
    close(fds[0]);
    return 0;
}
