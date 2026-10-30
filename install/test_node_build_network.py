"""Network recovery must stay inside Node dependency-build stages."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NodeBuildNetworkTests(unittest.TestCase):
    def test_pnpm_bootstrap_allows_slow_connections_only_during_build(self):
        recipes = [p for p in (ROOT / 'deploy').rglob('*Dockerfile*')
                   if p.is_file() and 'npm install --global' in p.read_text()]
        self.assertEqual(len(recipes), 5)
        for path in recipes:
            with self.subTest(recipe=str(path.relative_to(ROOT))):
                content = path.read_text()
                stages = re.split(r'(?m)^FROM ', content)[1:]
                for stage in stages:
                    if 'npm install --global' in stage:
                        option = 'ARG NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000'
                        self.assertIn(option, stage)
                        self.assertLess(stage.index(option), stage.index('npm install --global'))
                    else:
                        self.assertNotIn('NODE_OPTIONS', stage)
                self.assertNotIn('ENV NODE_OPTIONS', content)
                self.assertNotIn('NODE_TLS_REJECT_UNAUTHORIZED', content)
                self.assertNotIn('strict-ssl=false', content)
                self.assertNotIn('registry.npmmirror', content)


if __name__ == '__main__':
    unittest.main()
