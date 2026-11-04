# Contributing

Keep infrastructure and execution adapters in `src/` and application orchestration in
`example/software-factory/`. Runtime must not import the example.

Run these checks before submitting a change:

```sh
npm ci
npm run check
npm run build
npm --prefix example/software-factory ci
npm --prefix example/software-factory run check
npm --prefix example/software-factory run test:package
```

Run `scripts/check-sast.sh` with Semgrep CE 1.136.0 for the security audit.
Run `python3 -I scripts/test-sast.py` to verify the scanner regression rules.
The audit includes first-party tests and fails on findings or scan errors.
Run `python3 -I scripts/check-dependencies.py` with OSV-Scanner 2.7.0 to
check npm and Go dependencies, including nested test modules, for known vulnerabilities.
Run `python3 -I scripts/test-dependencies.py` to verify vulnerable dependencies fail.
The dependency check queries OSV and fails on findings, scan errors or missing manifests.
Describe the behavior changed, verification performed and remaining limits.
Never include credentials or private installation state.
