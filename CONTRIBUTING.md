# Contributing

Keep infrastructure primitives in `src/` and factory behavior in
`example/agent-factory/`. Runtime must not import the example.

Run these checks before submitting a change:

```sh
npm ci
npm run check
npm run test:tofu
npm run test:package
npm --prefix example/agent-factory ci
npm --prefix example/agent-factory run check
```

OpenTofu contract tests require `tofu`; they use a synthetic Tart CLI.
Run `scripts/check-sast.sh` with Semgrep CE 1.136.0 for the security audit.
Describe the behavior changed, verification performed and remaining limits.
Never include credentials or private installation state.
