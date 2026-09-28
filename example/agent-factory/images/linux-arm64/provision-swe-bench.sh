#!/usr/bin/env bash
# Runs only in the newly created credential-free image builder.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends docker.io docker-cli qemu-user-static binfmt-support
systemctl start docker
systemctl restart systemd-binfmt
grep -q '^flags:.*F' /proc/sys/fs/binfmt_misc/qemu-x86_64
git init /opt/factory/swe-upstream
git -C /opt/factory/swe-upstream remote add origin https://github.com/SWE-bench/SWE-bench.git
git -C /opt/factory/swe-upstream fetch --depth=1 origin 02e7a74ffd0b707aab73d203fe87bdc7c76afc8e
git -C /opt/factory/swe-upstream checkout --detach FETCH_HEAD
python3 -m venv /opt/factory/swe-python
/opt/factory/swe-python/bin/pip install --only-binary=:all: -r /opt/factory/swe-bench-requirements.lock setuptools==80.9.0 wheel==0.45.1
/opt/factory/swe-python/bin/pip install --no-deps --no-build-isolation /opt/factory/swe-upstream
/opt/factory/swe-python/bin/python -I -c 'from swebench.harness.run_evaluation import run_instance; from swebench.harness.grading import get_eval_report'
/opt/factory/swe-python/bin/pip check
docker version
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache/pip
