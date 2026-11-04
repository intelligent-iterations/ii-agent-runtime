#!/usr/bin/env python3
"""Scan tracked dependency manifests with OSV-Scanner; fail closed on missing coverage."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

VERSION = '2.7.0'


def scan(root, report):
    version = subprocess.check_output(['osv-scanner', '--version'], text=True)
    if f'osv-scanner version: {VERSION}' not in version.splitlines():
        raise ValueError(f'OSV-Scanner {VERSION} is required')
    tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'], text=True)
    expected = {str((root / name).resolve()) for name in tracked.split('\0')
                if Path(name).name in ('package-lock.json', 'go.mod')}
    if not expected:
        raise ValueError('No tracked npm or Go dependency manifests found')
    result = subprocess.run([
        'osv-scanner', 'scan', 'source', '--recursive', '--no-resolve',
        '--no-call-analysis=go', '--all-vulns', '--all-packages',
        '--format', 'json', '--output-file', str(report), str(root),
    ])
    if result.returncode:
        if result.returncode == 1 and report.is_file():
            data = json.loads(report.read_text())
            for item in data['results']:
                for package in item['packages']:
                    for vulnerability in package.get('vulnerabilities', []):
                        print(f"{item['source']['path']}: {vulnerability['id']}", file=sys.stderr)
        raise ValueError(f'OSV-Scanner failed (status {result.returncode})')
    data = json.loads(report.read_text())
    results = data['results']
    covered = {str(Path(item['source']['path']).resolve()) for item in results if item['packages']}
    missing = expected - covered
    if missing:
        raise ValueError(f'Dependency manifests were not scanned: {sorted(missing)}')
    if any(p.get('vulnerabilities') for item in results for p in item['packages']):
        raise ValueError('OSV report contains vulnerabilities')
    count = sum(len(item['packages']) for item in results)
    print(f'OSV-Scanner {VERSION}: {len(expected)} manifests, {count} package entries, 0 vulnerabilities')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='dependency-scan-') as directory:
        scan(args.root.resolve(), (args.report or Path(directory) / 'osv.json').resolve())


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f'Dependency check: {error}', file=sys.stderr)
        sys.exit(1)
