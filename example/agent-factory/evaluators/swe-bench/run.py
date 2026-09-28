"""Pinned native evaluator entry point for a dedicated, credential-free Linux VM.

The controller supplies a trusted dataset artifact separately from agent inputs.
This program never substitutes the dataset's gold patch for the prediction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

REVISION = "02e7a74ffd0b707aab73d203fe87bdc7c76afc8e"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def validate(manifest, dataset_bytes, rows):
    require(manifest.get("schemaVersion") == 1, "Invalid evaluator manifest")
    evaluation = manifest["evaluation"]
    inputs = evaluation["input"]
    artifact = manifest["datasetArtifact"]
    require(inputs["evaluatorRevision"] == REVISION, "Unsupported evaluator revision")
    require(re.fullmatch(r"[a-f0-9]{40}", inputs["datasetRevision"]), "Invalid dataset revision")
    require(artifact["revision"] == inputs["datasetRevision"] and
            artifact["dataset"] == inputs["dataset"] and artifact["split"] == inputs["split"],
            "Dataset binding mismatch")
    require(digest(dataset_bytes) == artifact["sha256"], "Dataset bytes changed")
    require(evaluation["runId"] == "runtime-" + digest(canonical(inputs).encode()), "Run binding mismatch")
    prediction = {"instance_id": inputs["instanceId"], "model_name_or_path": inputs["model"], "model_patch": inputs["patch"]}
    encoded = canonical(prediction) + "\n"
    require(encoded == evaluation["predictionsJsonl"] and digest(encoded.encode()) == evaluation["predictionsSha256"],
            "Prediction binding mismatch")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", inputs["instanceId"]), "Invalid instance identifier")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,199}", inputs["model"]) and
            ".." not in inputs["model"], "Invalid model identifier")
    require(isinstance(inputs["patch"], str) and len(inputs["patch"].encode()) <= 4 * 1024 * 1024 and
            "\0" not in inputs["patch"], "Invalid prediction patch")
    matches = [row for row in rows if row["instance_id"] == inputs["instanceId"]]
    require(len(matches) == 1, "Dataset instance must be unique")
    instance = matches[0]
    require(all(instance[key] == manifest["task"][key] for key in ("repo", "base_commit", "problem_statement")),
            "Dataset task differs from submitted task")
    source_image = instance["image"].split("@")[0]
    source_image = source_image.rsplit("/", 1)[0] + "/" + source_image.rsplit("/", 1)[1].split(":")[0]
    require(re.fullmatch(re.escape(source_image) + r"@sha256:[a-f0-9]{64}", manifest["image"]),
            "Evaluator image must pin the dataset image repository")
    require(manifest["architecture"] in ("amd64", "arm64") and type(manifest["allowEmulation"]) is bool,
            "Invalid architecture policy")
    require(type(manifest["timeoutSeconds"]) is int and 1 <= manifest["timeoutSeconds"] <= 3600,
            "Invalid evaluation timeout")
    require(not instance.get("image_assets"), "Unpinned external image assets are unsupported")
    return instance, prediction


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("upstream", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    require(args.dataset.stat().st_size <= 128 * 1024 * 1024, "Dataset exceeds size limit")
    data = args.dataset.read_bytes()
    require(len(data) <= 128 * 1024 * 1024, "Dataset exceeds size limit")
    import pyarrow.parquet as parquet
    import pyarrow as arrow
    instance, prediction = validate(manifest, data, parquet.read_table(arrow.BufferReader(data)).to_pylist())
    upstream = args.upstream.resolve(strict=True)
    def git(*command):
        return subprocess.check_output(["git", "-C", str(upstream), *command], text=True).strip()
    require(git("rev-parse", "HEAD") == REVISION and not git("status", "--porcelain", "--untracked-files=all"),
            "Evaluator checkout must match the clean pinned revision")
    if args.validate_only:
        print(json.dumps({"validated": True, "instanceId": instance["instance_id"], "modelCalls": 0}))
        return
    require(sys.platform == "linux" and os.getuid() == 0 and Path("/run/factory-evaluator").is_file(),
            "Evaluation requires the dedicated VM entry point")
    output = args.output.resolve()
    output.mkdir(mode=0o700)  # Existing output is never eligible for cached grading.
    os.chdir(output)
    sys.path.insert(0, str(upstream))
    import docker
    from swebench.harness.run_evaluation import run_instance
    from swebench.harness.utils import make_test_spec
    client = docker.DockerClient(base_url="unix:///var/run/docker.sock", timeout=120)
    require(not client.containers.list(all=True), "Evaluator Docker daemon is not empty")
    host_architecture = client.info()["Architecture"]
    architecture = {"aarch64": "arm64", "x86_64": "amd64"}.get(host_architecture, host_architecture)
    require(architecture == manifest["architecture"] or manifest["allowEmulation"], "Image requires explicit emulation")
    image = client.images.pull(manifest["image"], platform="linux/" + manifest["architecture"])
    require(image.attrs["Architecture"] == manifest["architecture"], "Image architecture differs from manifest")
    # Use the pulled immutable reference; never the dataset's mutable tag.
    spec = make_test_spec({**instance, "image": manifest["image"]})
    evaluation = manifest["evaluation"]
    result = run_instance(spec, prediction, client, evaluation["runId"], timeout=manifest["timeoutSeconds"])
    require(not client.containers.list(all=True), "Native evaluator container cleanup is unconfirmed")
    require(result is not None and result[0] == instance["instance_id"], "Native evaluator produced no report")
    log_dir = output / "logs" / "evaluation" / evaluation["runId"] / prediction["model_name_or_path"].replace("/", "__") / instance["instance_id"]
    report = json.loads((log_dir / "report.json").read_text())
    require(report == result[1], "Retained native report differs from evaluator result")
    receipt = {"runId": evaluation["runId"], "predictionsSha256": evaluation["predictionsSha256"],
               "evaluatorRevision": REVISION, "datasetRevision": evaluation["input"]["datasetRevision"],
               "datasetSha256": digest(data), "image": manifest["image"], "imageId": image.id,
               "architecture": manifest["architecture"], "hostArchitecture": architecture,
               "containerRemoved": True, "report": report,
               "testOutputSha256": digest((log_dir / "test_output.txt").read_bytes())}
    with (output / "receipt.json").open("x") as stream:
        json.dump(receipt, stream, sort_keys=True)
    client.close()


if __name__ == "__main__":
    main()
