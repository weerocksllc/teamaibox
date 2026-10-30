/* Offline regression tests linked against the actual patched ARM64 library.
 * Dedicated synthetic PIN and keys only. No receiver, network or files. */
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include "pairing.h"

#define CHECK(value) do { if (!(value)) return __LINE__; } while (0)

int main(void) {
    int result = 0;
    pairing_t *pairing = pairing_init_generate("", "", &result);
    CHECK(pairing && result >= 0);
    unsigned char first_pk[32], second_pk[32];
    pairing_get_public_key(pairing, first_pk);
    pairing_t *second = pairing_init_generate("", "", &result);
    CHECK(second && result >= 0);
    pairing_get_public_key(second, second_pk);
    CHECK(memcmp(first_pk, second_pk, sizeof(first_pk)) != 0);
    pairing_destroy(second);
    pairing_session_t *session = pairing_session_init(pairing);
    CHECK(session);
    unsigned char key[257] = {1}, proof[64] = {0}, epk[32] = {0}, tag[16] = {0};
    /* PIN-less setup cannot create authorization for pair-verify or media. */
    CHECK(pairing_session_media_authorized(session) == 0);
    CHECK(pairing_session_handshake(session, key, epk) < 0);
    pairing_session_set_setup_status(session);
    CHECK(pairing_session_handshake(session, key, epk) < 0);
    CHECK(pairing_session_media_authorized(session) == 0);
    unsigned char secret[32];
    memset(secret, 0x7f, sizeof(secret));
    CHECK(pairing_get_ecdh_secret_key(session, secret) == 0);
    for (unsigned int i = 0; i < sizeof(secret); ++i) CHECK(secret[i] == 0);
    /* Out-of-order step 2/3 must fail, not dereference a missing SRP state. */
    CHECK(srp_validate_proof(session, pairing, key, 256, proof, 20, 64) < 0);
    CHECK(srp_confirm_pair_setup(session, pairing, epk, tag) < 0);
    const char *salt = NULL, *server_pk = NULL;
    int salt_length = 0, pk_length = 0;
    CHECK(srp_new_user(session, pairing, "00:11:22:33:44:55", "1234",
                       &salt, &salt_length, &server_pk, &pk_length) == 0);
    CHECK(salt && salt_length == 16 && server_pk && pk_length > 0 && pk_length <= 256);
    free((void *)server_pk);
    CHECK(srp_confirm_pair_setup(session, pairing, epk, tag) < 0);
    CHECK(srp_validate_proof(session, pairing, key, 257, proof, 20, 64) < 0);
    CHECK(srp_validate_proof(session, pairing, key, 0, proof, 20, 64) < 0);
    CHECK(srp_validate_proof(session, pairing, key, 256, proof, 65, 64) < 0);
    CHECK(srp_validate_proof(session, pairing, key, 256, proof, 19, 64) < 0);
    CHECK(srp_validate_proof(session, pairing, key, 256, proof, 20, 19) < 0);
    /* A correctly sized but invalid proof cannot unlock step 3. */
    CHECK(srp_validate_proof(session, pairing, key, 256, proof, 20, 64) < 0);
    CHECK(srp_confirm_pair_setup(session, pairing, epk, tag) < 0);
    pairing_session_destroy(session);
    pairing_destroy(pairing);
    /* The actual SRP verifier must share its attempt budget across entirely
     * new pairing objects and connections, not merely a standalone helper. */
    for (unsigned int attempt = 0; attempt < 5; ++attempt) {
        pairing = pairing_init_generate("", "", &result);
        CHECK(pairing && result >= 0);
        session = pairing_session_init(pairing);
        CHECK(session);
        CHECK(srp_new_user(session, pairing, "00:11:22:33:44:55", "1234",
                          &salt, &salt_length, &server_pk, &pk_length) == 0);
        free((void *)server_pk);
        memset(proof, 0, sizeof(proof));
        int verified = srp_validate_proof(session, pairing, key, 256, proof, 20, 64);
        CHECK(verified == (attempt < 4 ? -1 : -3));
        CHECK(pairing_session_media_authorized(session) == 0);
        pairing_session_destroy(session);
        pairing_destroy(pairing);
    }
    return 0;
}
