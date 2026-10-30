import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DrawingResidencyCompanionTests(unittest.TestCase):
    def test_node_agent_orders_dependent_around_worker(self):
        source = (ROOT / "services/node-agent/internal/docker/engine.go").read_text(encoding="utf-8")
        drain = source.index("for _, dependent := range target.DependentContainers")
        worker_stop = source.index("r.stopContainer(ctx, target.ContainerName", drain)
        worker_start = source.index("r.startExclusiveContainer(ctx, target.ContainerName", worker_stop)
        dependent_restore = source.index("for _, dependent := range target.DependentContainers", worker_start)
        self.assertLess(drain, worker_stop)
        self.assertLess(worker_start, dependent_restore)

    def test_dependent_stop_leaves_worker_budget_inside_command_deadline(self):
        source = (ROOT / "services/node-agent/internal/docker/engine.go").read_text(encoding="utf-8")
        self.assertIn("const exclusiveDependentStopGraceSeconds = 5", source)
        self.assertIn("dependent.ContainerName, exclusiveDependentStopGraceSeconds", source)

if __name__ == "__main__":
    unittest.main()
