#!/usr/bin/env python3
"""Exercise the real local rule and test-directory targeting with Semgrep CE."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RULE = 'dot-only-regexp-escaping'


class SecurityRegression(unittest.TestCase):
    def scan(self, source, expected_findings):
        with tempfile.TemporaryDirectory(prefix='sast-regression-') as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / '.semgrepignore', root / '.semgrepignore')
            target = Path('test/providers/tools/workflow-gcp.test.ts')
            (root / target).parent.mkdir(parents=True)
            (root / target).write_text(source)
            env = dict(os.environ, SEMGREP_SEND_METRICS='off', SEMGREP_ENABLE_VERSION_CHECK='0')
            env.pop('SEMGREP_APP_TOKEN', None)
            result = subprocess.run([
                'semgrep', 'scan', '--config', str(ROOT / 'scripts/semgrep'),
                '--error', '--strict', '--json', '--metrics=off', '--disable-version-check', '.',
            ], cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1 if expected_findings else 0, result.stderr + result.stdout)
            report = json.loads(result.stdout)
            self.assertEqual(report['errors'], [], report)
            self.assertIn(str(target), report['paths']['scanned'], report)
            self.assertEqual(len(report['results']), expected_findings, report)
            for finding in report['results']:
                self.assertTrue(finding['check_id'].endswith(RULE), finding)
                self.assertEqual(finding['path'], str(target), finding)

    def test_original_alert_fails(self):
        self.scan(r"assert.match(check.summary, new RegExp(`requests ${account.replace(/[.]/g, '\\.')}`));", 1)

    def test_equivalent_escaping_fails(self):
        self.scan(r"new RegExp(account.replace(/\./g, '\\.'));", 1)
        self.scan(r"new RegExp(account.replaceAll('.', '\\.'));", 1)

    def test_literal_assertion_passes(self):
        self.scan('assert.ok(check.summary.includes(`requests ${account}`));', 0)

    def test_complete_escape_passes(self):
        self.scan(r"new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));", 0)

    def test_ordinary_replacement_passes(self):
        self.scan("account.replace(/[.]/g, '-');", 0)


if __name__ == '__main__':
    unittest.main()
