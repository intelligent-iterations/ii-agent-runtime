"""Shared driver for real pinned provider plugins against local compute API emulators."""

import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
COMPILE = """import {readFileSync} from 'node:fs';
import {compileDeployment,writeDeployment} from './dist/deployment/index.js';
writeDeployment(process.argv[2],compileDeployment(JSON.parse(readFileSync(process.argv[1],'utf8'))));"""
OPERATE = """import {planDeployment,applyDeployment} from './dist/deployment/index.js';
import {execFileSync} from 'node:child_process';
const options={directory:process.argv[1],environment:process.env,process:async request => {
try { return execFileSync(request.command,request.args,{cwd:request.cwd,env:request.env,encoding:'utf8',timeout:request.timeoutMs,maxBuffer:request.maxOutputBytes}); }
catch(error) { console.error(String(error.stdout),String(error.stderr)); throw error; }
}};
const receipt=await planDeployment(options,process.argv[2]);
console.log(JSON.stringify(await applyDeployment(options,receipt.planDigest)));"""


class Deployment:
    def __init__(self, provider, emulator):
        self.parent = pathlib.Path(
            tempfile.mkdtemp(prefix="ii-" + provider + "-emulation-")
        )
        self.work = self.parent / "deployment"
        self.environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.parent),
            "CHECKPOINT_DISABLE": "1",
        }
        self.result = {
            "provider": provider,
            "emulator": emulator,
            "runtimeRevision": os.environ.get("II_RUNTIME_REVISION")
            or subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip(),
            "status": "failed",
            "scope": "compute-api",
            "guestExecution": "not-tested",
            "iam": "not-tested",
        }

    def prepare(self, declaration, local_name, overrides):
        source = self.parent / "declaration.json"
        source.write_text(json.dumps(declaration))
        subprocess.run(
            ["node", "--input-type=module", "-e", COMPILE, str(source), str(self.work)],
            cwd=ROOT,
            check=True,
        )
        path = self.work / "main.tf.json"
        document = json.loads(path.read_text())
        self.result["plugin"] = document["terraform"]["required_providers"][local_name]
        # Only endpoint and synthetic credential settings change. Generated resources remain intact.
        document["provider"][local_name].update(overrides)
        path.write_text(json.dumps(document, indent=2))
        cache = os.environ.get("II_PROVIDER_VALIDATION_CACHE")
        if cache:
            (self.work / ".terraform").symlink_to(pathlib.Path(cache) / ".terraform")
            shutil.copyfile(
                pathlib.Path(cache) / ".terraform.lock.hcl",
                self.work / ".terraform.lock.hcl",
            )

    def operate(self, intent, denied=None):
        process = subprocess.Popen(
            ["node", "--input-type=module", "-e", OPERATE, str(self.work), intent],
            cwd=ROOT,
            env=self.environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=240)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = process.communicate()
            (self.parent / (intent + ".log")).write_text(stdout + stderr)
            raise RuntimeError("Provider operation timed out; process group terminated")
        run = subprocess.CompletedProcess(
            process.args, process.returncode, stdout, stderr
        )
        (self.parent / (("denied-" if denied else "") + intent + ".log")).write_text(
            run.stdout + run.stderr
        )
        if denied:
            if run.returncode == 0 or denied not in run.stderr:
                raise AssertionError(run.stdout + run.stderr)
            return None
        if run.returncode:
            raise RuntimeError(run.stdout + run.stderr)
        print(run.stdout.strip(), flush=True)
        return json.loads(run.stdout)

    def assert_empty_state(self):
        assert not json.loads((self.work / "terraform.tfstate").read_text()).get(
            "resources", []
        )

    def record(self):
        (self.parent / "result.json").write_text(
            json.dumps(self.result, indent=2) + "\n"
        )
        print(json.dumps(self.result, indent=2), flush=True)
        print("Evidence:", self.parent, flush=True)
