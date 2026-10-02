# Contributing

Keep runtime and pipeline code in `src/` and factory behavior in
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
Describe the behavior changed, verification performed and remaining limits.
Never include credentials or private installation state.
