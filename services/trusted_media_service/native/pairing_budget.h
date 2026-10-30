#ifndef TEAMAIBOX_PAIRING_BUDGET_H
#define TEAMAIBOX_PAIRING_BUDGET_H

#include <stdbool.h>
#include <stdint.h>
#include <pthread.h>
#include <time.h>

/* One Web casting session owns one receiver process. Share this budget across
 * every TCP/pairing session: reconnecting or changing the sender identifier
 * cannot create another PIN-guess budget. Count attempts before SRP work,
 * including in-flight attempts, so parallel requests cannot exceed five.
 * Counting successes too is deliberately conservative; a successful handshake
 * must never let another connection reset a running cooldown. */
typedef struct {
    pthread_mutex_t mutex;
    uint64_t last_observed_ms;
    uint64_t cooldown_until_ms;
    unsigned int attempts;
} teamaibox_pairing_budget_t;

#define TEAMAIBOX_PAIRING_BUDGET_INITIALIZER {PTHREAD_MUTEX_INITIALIZER, 0, 0, 0}

static inline bool teamaibox_pairing_budget_claim_at(teamaibox_pairing_budget_t *budget, uint64_t now_ms) {
    if (!budget || now_ms == 0 || now_ms > UINT64_MAX - 60000
        || pthread_mutex_lock(&budget->mutex) != 0) return false;
    bool allowed = false;
    if (now_ms < budget->last_observed_ms) goto done;
    budget->last_observed_ms = now_ms;
    if (budget->cooldown_until_ms && now_ms >= budget->cooldown_until_ms) {
        budget->cooldown_until_ms = 0;
        budget->attempts = 0;
    }
    if (budget->attempts >= 5) goto done;
    budget->attempts++;
    if (budget->attempts == 5) budget->cooldown_until_ms = now_ms + 60000;
    allowed = true;
done:
    pthread_mutex_unlock(&budget->mutex);
    return allowed;
}

static inline bool teamaibox_pairing_budget_claim(teamaibox_pairing_budget_t *budget) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0
        || (uint64_t)now.tv_sec > (UINT64_MAX - 999) / 1000) return false;
    return teamaibox_pairing_budget_claim_at(budget,
        (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000);
}

#endif
