# Optional SWE-bench adapter

Factory owns task submission and retained candidate extraction. Runtime owns
native prediction/result conversion (D034). The evaluator runs separately on
consumer-provided infrastructure. `createSweBenchBenchmark` supplies its durable
factory lifecycle; the separate evaluator image must supply the native tooling.

```ts
const agent = factory.spawn(instance.instance_id, sweBenchAgentRequest(instance, "code"));
```

Only `repo`, `base_commit` and `problem_statement` enter the request. The adapter
does not copy the dataset's gold patch or test labels into the task.

After retaining the attempt, prepare its native prediction in the acceptance
callback:

```ts
const { evaluation, predictionsPath } = await prepareSweBenchCandidate({
  context, retained, instance, directory: newExportDirectory,
  dataset, split, datasetRevision, evaluatorRevision, model,
  baseBundle: { path: trustedBaseBundle, sha256: trustedBaseDigest },
});
```

The instance must match the submitted repository, commit and problem statement.
The exporter rehashes retained bundles, imports them into a fresh bare Git
repository, verifies commit/parent/tree identity and emits the full binary diff.
It does not check out or run agent-written files on the operator host.

Pass `predictionsPath` and `evaluation.runId` to the pinned SWE-bench evaluator.
The consumer must load the pinned dataset revision, allocate its evaluation
environment, retain the native per-instance report, and remove its resources.
Do not reuse another run's cached results. Runtime's `importSweBenchResult`
requires the run ID, prediction digest and evaluator/dataset revisions alongside
that report. It imports the evaluator's judgment; it does not independently
attest that the evaluator ran.

Verification: a real Git test applies the emitted patch to an independent base
checkout and compares its tree with the retained candidate, including binary
bytes, file mode changes and deletions. The runtime contract test also executes
the pinned upstream JSONL loader.

The native grading contract imports the unmodified upstream grader and checks
nine synthetic logs: resolved, unfixed, regression, skipped fix, skipped existing
test, missing fix, misleading success with nonzero exit, no tests, and environment
failure. The importer preserves each native report and rejects mismatched run,
prediction, evaluator, and dataset bindings. This is compatibility evidence, not
a benchmark score. The live evaluator control below proves a separate execution.

Reproduce from this source checkout with a clean upstream checkout at the pinned
revision and Python 3.12 in a dedicated virtual environment:

```sh
python3.12 -m venv /path/to/swe-venv
/path/to/swe-venv/bin/pip install /path/to/pinned-SWE-bench
node_modules/.bin/tsx scripts/verify-swe-grading.ts \
  /path/to/pinned-SWE-bench /path/to/swe-venv/bin/python /path/to/new-proof.json
```

The proof records native reports, synthetic logs, invocation bindings, Python
version and installed dependencies. The check runs no candidate or Docker
workload. The evaluator deployment must use a fresh result directory: upstream
`run_instance` returns an existing `report.json` without rerunning the task.

## Separate evaluator entry point

`evaluators/swe-bench/run.py` consumes an evaluator manifest, a trusted pinned
dataset Parquet file, a clean upstream checkout and a new output directory. The
manifest binds the exported `evaluation`, dataset name/split/revision/SHA-256,
submitted public task, immutable dataset image reference, architecture, explicit
emulation choice and a bounded timeout. The caller acquires the dataset from its
pinned source and supplies the expected hash; a self-declared revision alone is
not provenance.

Preflight rejects mismatched task, prediction, dataset and image identities,
duplicate instances, invalid execution policy and unpinned external image assets.
Only the supplied candidate patch reaches the native evaluator as its prediction.
Gold patches and grading scripts remain in this separate evaluator environment.

Execution requires a dedicated Linux VM with an empty Docker daemon and no agent
credentials. The native harness may add `SYS_ADMIN` to its test container, so its
Docker socket must never be the operator host's socket. The outer runtime-owned
VM supplies the resource and teardown boundary. Output directories cannot be
reused. `receipt.json` retains native judgment, prediction/dataset/evaluator
bindings, actual image identity, architecture, test-output hash and confirmed
container removal. The controller must retain these files and independently
confirm VM/runner removal before treating evaluation as settled.

`scripts/verify-swe-actions.ts` exercises this path through a fresh Tart VM and
the existing protected self-hosted verification workflow. It installs evaluator
dependencies in that disposable VM and retains their versions. This verification
driver currently targets the single-file `test` split of Verified; it is not the
general dataset loader. The reusable image profile is documented in
[`images/linux-arm64/README.md`](../images/linux-arm64/README.md#swe-bench-evaluator-profile).

## Optional controller plugin

Configure `createSweBenchBenchmark` once with the runtime infrastructure options,
a credential-free evaluator setup, pinned workflow, dataset artifact, model label,
policy revision, timeout, and three trusted resolvers: public instance, immutable
instance image, and baseline bundle. The evaluator image must contain Docker/CLI,
Python dependencies, the clean pinned checkout at `/opt/factory/swe-upstream`, and
its virtual environment at `/opt/factory/swe-python`. Emulation, when selected,
must already work in that image. Build the dedicated `swe-bench` image profile and
use its resulting immutable digest.

Attach it to the existing controller callbacks:

```ts
verify: async (context, retained) => {
  const verdict = await codeAcceptance.verify(context, retained);
  const benchmark = await benchmarks.evaluate(context, retained);
  return {
    accepted: verdict.accepted,
    evidence: { acceptance: verdict.evidence, benchmark },
  };
},
recoverVerification: async context => {
  await benchmarks.recover(context);
  await codeAcceptance.recoverVerification(context);
},
```

The benchmark's native outcome does not override normal code acceptance. A
completed evaluation returns `status: "completed"` and the native result;
cancelled/interrupted evaluations return no score. The plugin stores its snapshot
before deployment, uses a distinct evaluator attempt/run ID, and retains state
under `benchmark:`. Restart reconciles that same attempt instead of dispatching
again. Settlement requires confirmed VM/runner removal. Replays rehash retained
outputs and recheck report, image, dataset, prediction and execution bindings.
Changing setup, workflow, dataset, parent task or policy revision requires
recovery with the original configuration. Retrying an interrupted evaluation
requires a new parent attempt; the plugin never silently resets an old attempt.

## Verification

Local tests cover real Git patch extraction, identity binding, malformed inputs,
retained-result replay and interrupted evaluator recovery. The pinned native
loader/grader contract covers resolved, unfixed, regression, skipped and failed
environment cases.

Run live evaluation against the configured image and dataset before relying on
its results. Local contract tests do not establish a dataset-wide score.

Upstream contracts:
[prediction loader](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/utils.py),
[harness](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/run_evaluation.py).
