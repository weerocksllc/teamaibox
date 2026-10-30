#ifndef TEAMAIBOX_PAIRED_PEER_H
#define TEAMAIBOX_PAIRED_PEER_H

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <pthread.h>

/* A process-local, single-source public-key binding. Only a completed SRP/GCM
 * proof may call approve. A later TCP connection must prove possession of
 * this same key; an alternate sender must start a new authorized Web session. */
typedef struct {
    pthread_mutex_t mutex;
    bool approved;
    unsigned char key[32];
} teamaibox_paired_peer_t;

static inline bool teamaibox_paired_peer_init(teamaibox_paired_peer_t *peer) {
    if (!peer) return false;
    peer->approved = false;
    memset(peer->key, 0, sizeof(peer->key));
    return pthread_mutex_init(&peer->mutex, NULL) == 0;
}

static inline bool teamaibox_peer_keys_equal(const unsigned char *left, const unsigned char *right) {
    unsigned int difference = 0;
    for (unsigned int i = 0; i < 32; ++i) difference |= left[i] ^ right[i];
    return difference == 0;
}

static inline bool teamaibox_paired_peer_allows(teamaibox_paired_peer_t *peer, const unsigned char *key) {
    if (!peer || !key || pthread_mutex_lock(&peer->mutex) != 0) return false;
    bool allowed = peer->approved && teamaibox_peer_keys_equal(peer->key, key);
    pthread_mutex_unlock(&peer->mutex);
    return allowed;
}

static inline bool teamaibox_paired_peer_approve(teamaibox_paired_peer_t *peer, const unsigned char *key) {
    if (!peer || !key || pthread_mutex_lock(&peer->mutex) != 0) return false;
    bool allowed = !peer->approved || teamaibox_peer_keys_equal(peer->key, key);
    if (allowed && !peer->approved) {
        memcpy(peer->key, key, sizeof(peer->key));
        peer->approved = true;
    }
    pthread_mutex_unlock(&peer->mutex);
    return allowed;
}

static inline void teamaibox_paired_peer_destroy(teamaibox_paired_peer_t *peer) {
    if (!peer) return;
    peer->approved = false;
    volatile unsigned char *wipe = peer->key;
    for (unsigned int i = 0; i < sizeof(peer->key); ++i) wipe[i] = 0;
    pthread_mutex_destroy(&peer->mutex);
}

#endif
