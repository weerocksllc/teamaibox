"""Launch owned children from one service-lifetime thread, never a request.

Linux PR_SET_PDEATHSIG follows the *creating thread*. A native child forked
by a short-lived HTTP handler is therefore killed when that request returns,
even though the Python service is still alive. Keep the creator alive for the
service lifetime, without weakening either trampoline's parent-death guard.

Callers still validate fixed package-owned commands and own explicit stop,
wait and descriptor cleanup. This is not an HTTP command execution API.
"""
from concurrent.futures import ThreadPoolExecutor
import subprocess


# Starts lazily on the first launch. Never shut it down at session/request end;
# Python joins its worker on service exit, and an abrupt service death still
# triggers each child's existing PR_SET_PDEATHSIG guard.
_launcher = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cast-child-parent")


def spawn_service_child(*args, **kwargs):
    return _launcher.submit(subprocess.Popen, *args, **kwargs).result()
