from __future__ import annotations

import socket
import threading
import unittest

from tools.network_stream_benchmark import run_client, run_server


class NetworkStreamBenchmarkTests(unittest.TestCase):
    def test_bounded_loopback_upload_and_download(self) -> None:
        reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
        reservation.close()

        server_result: list[dict[str, object]] = []
        errors: list[BaseException] = []

        def serve() -> None:
            try:
                server_result.extend(run_server("127.0.0.1", port, 2, 5.0))
            except BaseException as error:  # captured and asserted in the test thread
                errors.append(error)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        client_result = run_client("127.0.0.1", port, 2 * 1024 * 1024, 5.0)
        thread.join(5.0)

        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual([item["direction"] for item in client_result], ["download", "upload"])
        self.assertEqual(len(server_result), 2)
        self.assertTrue(all(item["bytes"] == 2 * 1024 * 1024 for item in client_result))


if __name__ == "__main__":
    unittest.main()

