#!/usr/bin/env python3
"""Exercise the real dependency gate against the original vulnerable Go versions."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECK = Path(__file__).with_name('check-dependencies.py')


class DependencyTests(unittest.TestCase):
    def test_nested_vulnerable_go_module_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = root / 'test' / 'emulator'
            module.mkdir(parents=True)
            (module / 'go.mod').write_text('module example.com/emulator\n\ngo 1.26.10\n\n'
                                         'require (\n golang.org/x/net v0.57.0\n'
                                         ' golang.org/x/text v0.40.0\n)\n')
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            report = root / 'report.json'
            result = subprocess.run([sys.executable, '-I', str(CHECK), '--root', str(root),
                                     '--report', str(report)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            findings = {v['id'] for item in json.loads(report.read_text())['results']
                        for package in item['packages'] for v in package.get('vulnerabilities', [])}
            self.assertTrue({f'GO-2026-{n}' for n in (6603, 6610, 6611, 6612, 6617, 6629, 6860, 6866)}
                            <= findings, findings)
            for finding in findings:
                self.assertIn(finding, result.stderr)


if __name__ == '__main__':
    unittest.main()
