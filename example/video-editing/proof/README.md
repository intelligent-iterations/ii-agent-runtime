# Live run evidence

[`runs-20261116.json`](runs-20261116.json) records four live runs on macOS with
Colima: `npm run demo` with each editor and the hostile project in
`test/live/hostile/`. For each run it lists the run ID, the command and limits, the
renderer image digest, the hash of every input file, the runtime checkpoints of both
workers, and each delivered video's dimensions, duration, audio stream, full-decode
result and SHA-256.

The record is derived from each run's `run.json`. Absolute paths and the Docker
daemon's identifier are left out; logs and `runtime-state/` stayed on the machine
that ran them. The README's "Verified runs" section summarizes the same runs.

What this does not establish: Docker Desktop or Linux behaviour, render quality or
engagement, or that a digest-pinned image is trustworthy.

[`linux-runs-20261116.json`](linux-runs-20261116.json) separately records Linux
renders through the hardened launcher. Its sample records retain media hashes and
worker checkpoints; its hostile-project entry comes from the launcher's result.
The render commands and copied-package checks succeeded, while the outer
automation wrapper reported an error. These records do not establish green CI.
