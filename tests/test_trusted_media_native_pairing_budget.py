"""Offline native concurrency/cooldown checks, not Apple sender acceptance."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("cc"), "native C compiler is required")
class PairingBudgetTest(unittest.TestCase):
    def test_budget_is_process_shared_and_clock_bounded(self):
        source = r'''
#include "pairing_budget.h"
#include <stdatomic.h>
#define CHECK(x) do { if (!(x)) return __LINE__; } while (0)
static teamaibox_pairing_budget_t budget = TEAMAIBOX_PAIRING_BUDGET_INITIALIZER;
static atomic_int allowed;
static void *attempt(void *unused) {
    (void)unused;
    if (teamaibox_pairing_budget_claim_at(&budget, 1000)) atomic_fetch_add(&allowed, 1);
    return NULL;
}
int main(void) {
    CHECK(!teamaibox_pairing_budget_claim_at(NULL, 1000));
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, 0));
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, UINT64_MAX));
    pthread_t clients[64];
    for (int i=0; i<64; ++i) CHECK(pthread_create(&clients[i], NULL, attempt, NULL) == 0);
    for (int i=0; i<64; ++i) CHECK(pthread_join(clients[i], NULL) == 0);
    CHECK(atomic_load(&allowed) == 5);
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, 999));
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, 60999));
    CHECK(teamaibox_pairing_budget_claim_at(&budget, 61000));
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, 61000 - 1));
    for (int i=0; i<4; ++i) CHECK(teamaibox_pairing_budget_claim_at(&budget, 61000));
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, 61000));
    CHECK(!teamaibox_pairing_budget_claim_at(&budget, 120999));
    CHECK(teamaibox_pairing_budget_claim_at(&budget, 121000));
    CHECK(pthread_mutex_destroy(&budget.mutex) == 0);
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix="teamaibox-pairing-budget-") as directory:
            executable = Path(directory) / "probe"
            built = subprocess.run([shutil.which("cc"), "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
                "-I", str(ROOT / "services/trusted_media_service/native"), "-x", "c", "-", "-o", str(executable)],
                input=source.encode(), capture_output=True, timeout=30)
            self.assertEqual(built.returncode, 0, built.stderr.decode())
            result = subprocess.run([str(executable)], capture_output=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"", b""))


if __name__ == "__main__":
    unittest.main()
