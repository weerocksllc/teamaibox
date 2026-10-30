"""Own the private media control and SFU gateways as one appliance service.

    Configuration is supplied on private tmpfs by the deployment controller.
    Booting the service never advertises an AirPlay receiver. Platform must
    still admit a user session against the protected office resource budget.
"""
import os
import signal
import sys
import threading
import time

from .main import ProtectedInputs, ConfigurationError, assemble
from .sfu_gateway import assemble_gateways


class ApplianceMediaService:
    def __init__(self, inputs, *, runtime_factory=assemble, gateways_factory=assemble_gateways):
        self.runtime = None
        self.gateways, self.threads = [], []
        self._closed = False
        try:
            # Bind all listeners before starting any serve loop. Partial
            # configuration/port conflicts cannot leave an exposed sibling.
            self.gateways = gateways_factory(inputs)
            self.runtime = runtime_factory(inputs)
        except Exception:
            self.close()
            raise

    def serve(self, stop):
        if self._closed or self.threads:
            raise ConfigurationError()
        try:
            for gateway in self.gateways:
                thread = threading.Thread(target=gateway.serve_forever, kwargs={"poll_interval":0.1}, daemon=True)
                thread.start()
                self.threads.append(thread)
            self.runtime.serve(stop)
        finally:
            self.close()

    def close(self):
        if self._closed:
            return
        # Keep the SFU control hop alive until receiver/room cleanup completes.
        # A failed cleanup retains ownership and may be retried by main().
        if self.runtime is not None:
            self.runtime.close()
        for gateway in self.gateways:
            gateway.server_close()
        for gateway, thread in zip(self.gateways, self.threads):
            gateway.shutdown()
            thread.join(timeout=2)
            if thread.is_alive():
                raise RuntimeError("cast_gateway_shutdown_pending")
        self._closed = True


def main():
    owner = None
    try:
        if len(sys.argv) != 1 or os.geteuid() == 0 or os.environ.get("UXPLAYRC"):
            raise ConfigurationError()
        stop = threading.Event()
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: stop.set())
        with ProtectedInputs() as inputs:
            owner = ApplianceMediaService(inputs)
        owner.serve(stop)
        return 0
    except Exception:
        print("cast_appliance_service_unavailable", file=sys.stderr)
        return 1
    finally:
        if owner is not None:
            deadline = time.monotonic()+10
            while not owner._closed:
                try:
                    owner.close()
                except Exception:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.2)


if __name__ == "__main__": sys.exit(main())
