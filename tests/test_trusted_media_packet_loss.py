"""One missing transport case; reuse the real bridge, not the passing test suite.

An outer runner changes ONLY this disposable SFU's network namespace. Test
messages contain counters, never media, PINs or authorization material.
"""
import json
import os
import unittest

from tests import test_trusted_media_production_bridge as bridge_test


@unittest.skipUnless(os.environ.get("TEAMAIBOX_TEST_PACKET_LOSS") == "1",
                     "requires isolated network-namespace impairment runner")
class PacketLossTest(unittest.TestCase):
    # Do not inherit or expose the passing test class to unittest discovery.
    def test_actual_packet_loss_recovers_decoded_media(self):
        phases = {}
        last_second = -1
        max_queued = {"video": 0, "audio": 0}

        def observe(elapsed, counts, snapshot, final=False):
            nonlocal last_second
            second = int(elapsed)
            for track, count in snapshot.get("queuedSamples", {}).items():
                max_queued[track] = max(max_queued.get(track, 0), count)
            for phase, at in (("impair", 8), ("restore", 23)):
                if phase not in phases and elapsed >= at:
                    phases[phase] = dict(counts)
                    print(json.dumps({"networkAction": phase, "elapsed": elapsed,
                                      "counts": counts}), flush=True)
            if second != last_second or final:
                last_second = second
                print(json.dumps({"transportSample": {"elapsed": round(elapsed, 3),
                      "counts": counts, "queued": snapshot.get("queuedSamples", {}),
                      "queueLimit": snapshot.get("maximumQueuedSamplesPerTrack")}}), flush=True)
            if final:
                self.assertEqual(set(phases), {"impair", "restore"})
                self.assertGreaterEqual(min(phases["impair"].values()), 10,
                                        "a real decoded baseline must precede impairment")
                for track in ("video", "audio"):
                    self.assertGreater(counts[track] - phases["restore"][track], 50,
                                       "actual decoded media must resume after impairment")
                    self.assertLessEqual(max_queued[track], snapshot["maximumQueuedSamplesPerTrack"])
                print(json.dumps({"packetLossRecovery": {
                    "before": phases["impair"], "atRestoration": phases["restore"],
                    "final": counts, "maximumQueueObserved": max_queued,
                    "decodedMediaRecovered": True,
                    "appleSenderAccepted": False, "browserAccepted": False,
                    "calibratedAvSyncAccepted": False}}), flush=True)

        bridge_test.ProductionBridgeMediaTest.run_bridge(
            self, video_only_first=False, impairment_observer=observe)

    def test_slow_viewer_does_not_stall_other_viewer(self):
        phases={}
        def observe(elapsed,counts,snapshot,final=False):
            slow=snapshot['secondCounts']
            for phase,at in (('impair',10),('restore',25)):
                if phase not in phases and elapsed>=at:
                    self.assertTrue(snapshot['slowViewerPorts'],'slow_viewer_udp_ports_required')
                    phases[phase]={'normal':dict(counts),'slow':dict(slow)}
                    print(json.dumps({'networkAction':phase,'elapsed':elapsed,
                                      'slowViewerPorts':snapshot['slowViewerPorts'],
                                      'counts':phases[phase]}),flush=True)
            if final:
                self.assertEqual(set(phases),{'impair','restore'})
                for track in ('video','audio'):
                    self.assertGreaterEqual(phases['impair']['slow'][track],10)
                    self.assertGreater(phases['restore']['normal'][track]-phases['impair']['normal'][track],100,
                                       'unconstrained viewer must keep decoding during throttling')
                    self.assertGreater(slow[track]-phases['restore']['slow'][track],50,
                                       'throttled viewer must resume after limit removal')
                print(json.dumps({'packetLossRecovery':{'before':phases['impair'],
                    'atRestoration':phases['restore'],'final':{'normal':counts,'slow':slow},
                    'decodedMediaRecovered':True,'unconstrainedViewerContinued':True,
                    'singlePublisherRendition':True,'appleSenderAccepted':False,
                    'browserAccepted':False,'calibratedAvSyncAccepted':False}}),flush=True)
        bridge_test.ProductionBridgeMediaTest.run_bridge(
            self,video_only_first=False,impairment_observer=observe,slow_viewer=True)


if __name__ == "__main__":
    unittest.main(defaultTest="PacketLossTest.test_actual_packet_loss_recovers_decoded_media")
