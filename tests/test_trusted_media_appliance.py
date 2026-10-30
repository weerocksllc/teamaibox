import threading
import unittest
from unittest.mock import Mock

from services.trusted_media_runtime.appliance import ApplianceMediaService


class ApplianceOwnerTest(unittest.TestCase):
    def test_runtime_construction_failure_closes_already_bound_gateways(self):
        gateways=[Mock(),Mock(),Mock()]
        def failed(_): raise ValueError("component startup failed")
        with self.assertRaises(ValueError):
            ApplianceMediaService(None,runtime_factory=failed,gateways_factory=lambda _:gateways)
        for gateway in gateways:
            gateway.server_close.assert_called_once()
            gateway.serve_forever.assert_not_called()

    def test_stop_cleans_runtime_before_gateway_and_is_idempotent(self):
        events=[]
        runtime=Mock()
        runtime.close.side_effect=lambda:events.append("runtime")
        gateway=Mock()
        gateway.server_close.side_effect=lambda:events.append("gateway")
        owner=ApplianceMediaService(None,runtime_factory=lambda _:runtime,gateways_factory=lambda _:[gateway])
        owner.close();owner.close()
        self.assertEqual(events,["runtime","gateway"])
        self.assertTrue(owner._closed)

    def test_uncertain_runtime_cleanup_does_not_destroy_control_gateway(self):
        runtime,gateway=Mock(),Mock()
        runtime.close.side_effect=[RuntimeError("pending"),None]
        owner=ApplianceMediaService(None,runtime_factory=lambda _:runtime,gateways_factory=lambda _:[gateway])
        with self.assertRaises(RuntimeError): owner.close()
        gateway.server_close.assert_not_called()
        self.assertFalse(owner._closed)
        owner.close()
        self.assertTrue(owner._closed)
        gateway.server_close.assert_called_once()

    def test_serve_starts_only_gateway_loops_and_runtime_then_owns_their_exit(self):
        stop=threading.Event()
        runtime,gateway=Mock(),Mock()
        runtime.serve.side_effect=lambda event:self.assertIs(event,stop)
        owner=ApplianceMediaService(None,runtime_factory=lambda _:runtime,gateways_factory=lambda _:[gateway])
        owner.serve(stop)
        gateway.serve_forever.assert_called_once()
        gateway.shutdown.assert_called_once()
        self.assertTrue(owner._closed)
        self.assertFalse(owner.threads[0].is_alive())


if __name__ == "__main__": unittest.main()
