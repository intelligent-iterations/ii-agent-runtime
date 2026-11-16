# Render video projects in an offline worker

Coding agents now write video code: Remotion documents
[generating Remotion code with LLMs and agent skills](https://www.remotion.dev/docs/ai/),
and HyperFrames compositions are plain HTML an agent can author. Rendering that
code on your own machine gives it your files, your network and whatever else your
user can reach. Remotion's own answer for on-demand rendering is a sandbox in which
["each render spawns an ephemeral Linux VM"](https://www.remotion.dev/docs/vercel-sandbox),
and people rendering in Docker hit
[memory-limit problems](https://github.com/remotion-dev/remotion/issues/10909)
they have to tune by hand.

This utility renders a prepared **HyperFrames, Remotion or MoviePy** project in a
disposable Docker worker with **no network**, **explicit CPU, memory, disk and time
limits**, and **only the files you select**. It then destroys that worker, including
anything the project left running, and checks the exported MP4s in a second, fresh
worker that never runs project code. You get the videos, their hashes and a record
of the run and its cleanup.

It makes no model calls and no editing decisions. It demonstrates one II Agent
Runtime capability: bounded, offline execution of untrusted code, with cleanup you
can verify.

## Install

You need Node 22.16 or later and Docker: Docker Desktop or Colima on macOS, or Docker
Engine on Linux. Allow about 4 GB of disk for the images. Clone this repository,
install the runtime at its root, then install the example:

```sh
git clone https://github.com/intelligent-iterations/ii-agent-runtime.git
cd ii-agent-runtime
npm ci                  # installs and builds the runtime
cd example/video-editing
npm ci
```

On macOS, keep the checkout under your home directory: Docker Desktop and Colima
share only that folder with their Linux VM by default.

## See it work

```sh
npm run demo
```

This renders the bundled sample with MoviePy. The first run builds two images: the
MoviePy renderer from [`images/Dockerfile`](images/Dockerfile) and the trusted
coordinator from [`coordinator/Dockerfile`](coordinator/Dockerfile). Building the
renderer from scratch took 2 minutes on an Apple M4 with a fast connection. One
editor and the coordinator take about 2.3 GB of disk, and all three editors about
3.7 GB, because the images share their base. Later runs reuse them. Output of a
first run on macOS with Colima, with Docker's build output left out:

```text
> video-editing-example@0.1.0 demo
> tsx src/demo.ts

Building the moviepy renderer image video-editing-moviepy:1b2a600fa9c6 (first run only; several minutes)...
Building the coordinator image video-editing-coordinator:95ef19bda39b (first run only)...
Rendering sample with moviepy in an offline worker (2 CPUs, 4096 MiB, 1800s limit)...
{"runId":"4edce127-12db-4deb-bd7e-3a6b3b885b5e","editor":"moviepy","status":"passed","cleanup":"confirmed","output":"moviepy-20261116-002544","videos":2}
Rendered 2 portrait shorts with moviepy; validation passed and cleanup was confirmed (run 4edce127-12db-4deb-bd7e-3a6b3b885b5e).
  results/moviepy-20261116-002544/videos/short-1.mp4
  results/moviepy-20261116-002544/videos/short-2.mp4
Run record: results/moviepy-20261116-002544/run.json
```

Open the two MP4s. Each is a 6-second, 1080×1920 short with audio, cut from the
sample's source clip, framed over a darkened copy of itself, with a title and
captions burned in. The same sample has a project for each editor:

```sh
npm run demo -- --editor remotion
npm run demo -- --editor hyperframes
```

The sample in [`sample/`](sample/) is small enough to read in a minute:

- `make-source.sh` generates a 16-second source clip with FFmpeg inside the worker:
  a background cycling through the colours, the source timecode and a tone. It is
  identical on every run; nothing is downloaded and no third-party footage is used.
  The timecode shows which part of the source each short used.
- `shorts.json` lists the cuts; `captions.json` holds the captions, timed against
  the source.
- `moviepy/`, `remotion/` and `hyperframes/` each read those two files and write
  `out/short-1.mp4` and `out/short-2.mp4`.

## Use it on your own project

Copy the config and point it at your project:

```sh
cp config.example.json config.json
```

Edit `config.json`. Relative paths are resolved from the folder that holds
`config.json`; `~` is not expanded. On macOS, the config, the project and the output
folder must all be under your home directory (or in a folder you added to Docker's
file sharing and listed in `DOCKER_SHARED_DIRS`, separated by colons).

- `editor`: `moviepy`, `remotion` or `hyperframes`. It selects the renderer image
  (see below). A plain FFmpeg or shell project works with any of them.
- `project`: the folder holding your source video and project files.
- `inputs`: the files and folders inside `project` that the worker receives, listed
  by name (`.` is not accepted). Hidden files, common key files and symbolic links
  are never copied.
- `command`: the executable and its arguments, run from the project root, for example
  `["python3", "render.py"]`.
- `expectedVideos` (1 to 32): how many MP4s your command writes to `out/`.
- `output`: a new folder for the results. Existing folders are never overwritten,
  and a failed run keeps its folder for diagnosis, so choose a new name or delete
  the old folder before you retry.
- The worker's limits, enforced rather than hints: `cpu` (1 to 4), `memoryMiB`
  (256 to 8192), `diskGiB` (1 to 80), `timeoutSeconds` (240 to 7200), `maxInputMiB` (1 to 480)
  and `maxOutputMiB` (1 to 240).
- `image` (optional): leave it out to use the image built from `images/Dockerfile`,
  or set your own image by digest (`repository@sha256:...`). Use only images you
  trust; a digest pins content but doesn't establish trust.

Then run:

```sh
npm run demo -- --config config.json
```

Your command must create `out/` under the project root (for example with
`mkdir -p out`) and write exactly `expectedVideos` MP4s into it. Each must be
portrait (taller than wide, for example 1080×1920), have an audio stream (silence is
fine) and last at most 180 seconds. If one doesn't, the run names the video and the
check it failed.

The worker has no network, so it can't download packages, fonts or browsers: they
must be in the image. All three images are Debian 13 with Node 22, Python 3.13,
FFmpeg 7.1, Chromium and the Liberation and Noto Color Emoji fonts. Each adds its
editor:

| `editor` | Adds |
| --- | --- |
| `moviepy` | MoviePy 2.2.1, in a Python virtual environment on `PATH` |
| `remotion` | Remotion 4.0.542 and React 19.2.0 in `/opt/remotion`; `remotion` is on `PATH` |
| `hyperframes` | the HyperFrames 0.8.181 CLI |

To add what your project needs, edit the matching stage of `images/Dockerfile`;
`npm run demo` rebuilds it when the file changes. Telemetry is turned off in the
images (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`), and the worker has no network
in any case.

Each editor's sample shows its working setup offline: Remotion renders with the
image's system Chromium (`--browser-executable=/usr/bin/chromium`) and links the
image's packages into the project at render time; HyperFrames compositions are
marked `data-no-timeline` because GSAP isn't loaded from a CDN.

## Verify

A successful run prints the run ID and the video paths. The output folder holds:

- `videos/`: the MP4s, extracted from `videos.tar`.
- `videos.tar`: the delivered archive. Its SHA-256 is in `run.json`.
- `run.json`: the run ID, input file hashes, limits, runtime checkpoints, each
  video's dimensions, duration, audio stream, full-decode result and hash, and the
  cleanup outcome.
- `command.log`: the first 1 MiB of your command's output; empty if it prints
  nothing.
- `runtime-state/`: the runtime's private state. It is empty once cleanup succeeds
  and is kept for recovery if cleanup fails.

How a run is checked: after your command exits, the runner collects candidate MP4
bytes and destroys the renderer, including any process the project left running.
The coordinator accepts only uniquely named regular MP4s with safe file names,
enforces the count and size limits, hashes each file and rebuilds the archive
without the project's metadata. A fresh offline worker receives only those MP4s and
checks portrait dimensions, an audio stream, the duration and a full FFmpeg decode,
using isolated Python imports. Its results must match the coordinator's hashes.
Before extracting the archive, the launcher also requires a successful coordinator
exit, confirmed cleanup, and an archive size and SHA-256 matching `run.json`.
These are compatibility checks, not quality scores: watch the videos before you
publish them.

To see that boundary hold against a hostile project, run the bundled one. It renders
one valid short, then plants a `json.py` that would fake a passing validation, forges
a proof file, and leaves a background process rewriting its output:

```sh
npm run demo -- --config test/live/hostile/config.json
```

It passes with exactly one video, `short.mp4`: the forged files are not exported, the
validator isn't fooled and the background process is gone with its worker. Delete
`test/live/hostile/results` before running it again.

The tests need no Docker:

```sh
npm run check          # types and all tests
npm run test:demo      # the runner and npm run demo with Docker intercepted
npm run test:package   # a copy outside the repository with the packed runtime
```

`test:package` runs twice: once on a copy installed from the packed runtime, then
again from inside that installed copy, so you see two success lines.

They cover hostile archives, isolated Python imports, input traversal and size
limits, deadlines, cancellation, export validation, cleanup and the demo's Docker
commands. They don't establish Docker isolation; the live runs below do.

## Verified runs

Verified on November 16, 2026 (UTC) on a Mac mini (Apple M4) with macOS 26.5.1,
Colima 0.10.1, Docker Engine 29.2.1 and Node 22.22.0. No model was used: this
example makes no model calls. Each first run of an editor included building its
image.

| Command | Run ID | Total time | Render | Result |
| --- | --- | --- | --- | --- |
| `npm run demo` | `4edce127-12db-4deb-bd7e-3a6b3b885b5e` | 2 min 2 s, with both image builds | 1 min 38 s | 2 shorts |
| `npm run demo -- --editor hyperframes` | `7803831f-2c69-4e2b-953b-08602a2d4549` | 2 min 13 s, with the image build | 1 min 52 s | 2 shorts |
| `npm run demo -- --editor remotion` | `e814edfa-cea5-4d2c-b816-b91be0e8b292` | 3 min 35 s, with the image build | 2 min 59 s | 2 shorts |
| `npm run demo -- --config test/live/hostile/config.json` | `db78f043-b931-4287-b16d-c510cad24db0` | 47 s | 41 s | 1 short |

Every sample short was 1080×1920 and 6 seconds long, with audio, and passed the full
decode. Each run provisioned the renderer and then a fresh validator, cleaned up
both, and reported cleanup as confirmed. The hostile run delivered only
`short.mp4`; its planted `json.py`, forged `proof.json` and archive, and the file its
background process kept writing were not exported. Hashes, limits, inputs and
checkpoints for all four runs are in [proof/runs-20261116.json](proof/runs-20261116.json).

Earlier runs on the same machine found two bugs, now fixed: the MoviePy and Remotion
images dropped `/usr/sbin` from `PATH`, so the disk helper couldn't find
`mkfs.ext4`; and a coordinator running as root failed the runtime's owner check for
its private state on macOS shared folders, so it now runs as you. A fresh-eyes test,
following only this README from a new clone with an empty home folder, then found
the gaps fixed in this revision, including a hostile-project config that was
missing from the repository.

The hardened launcher was also verified on Linux x86_64 with Docker Engine 29.1.3
on November 16, 2026. All four commands succeeded with cleanup confirmed:

| Project | Run ID | Result |
| --- | --- | --- |
| MoviePy sample | `60c5fcf6-497a-49ef-adb4-91bcdac2d975` | 2 shorts |
| Remotion sample | `162fba5a-6b4e-4442-8f6d-71996bf314a7` | 2 shorts |
| HyperFrames sample | `b084f016-a513-4994-837f-38eed4059538` | 2 shorts |
| Hostile project | `e80faf2e-f12c-4027-ba2e-c645f82dec0d` | 1 short |

[Linux run evidence](proof/linux-runs-20261116.json) records the sample hashes and
worker checkpoints, plus the hostile launcher's result. The copied-package check
also passed with an empty home and no repository dependency. The outer automation
wrapper reported an error after the commands succeeded, so these are live render
results, not a green CI run. Docker Desktop has not been verified.

## Editor licenses

The image recipes install each editor from its own registry; this repository doesn't
redistribute them.

- **MoviePy:** [MIT](https://github.com/Zulko/moviepy/blob/master/LICENCE.txt).
- **HyperFrames:** [Apache 2.0](https://github.com/heygen-com/hyperframes).
- **Remotion:** the [Remotion License](https://www.remotion.dev/docs/license). It is
  free for individuals and companies of up to three people; larger companies need a
  [company license](https://www.remotion.dev/docs/license/pricing) to use Remotion.
  Check it before you use the Remotion image at work.

## Limits

- Docker is the only placement demonstrated. On macOS the runs go through Docker's
  Linux VM, so the renderer images are Linux images.
- Project inputs are limited to 480 MiB, 2,048 regular files, 4,096 visited entries
  (including excluded ones), 32 directory levels and 30 seconds of staging. Files
  that change while being staged are rejected. Exported media is limited to 240 MiB.
- Excluding hidden and common key files is not secret detection: select only the
  inputs the render needs and never put credentials in the command or project.
- The coordinator holds your Docker socket and runs your images, so it must be
  trusted. Don't give that socket to a project or an agent. The disk helper runs with
  elevated capabilities and loop devices; Docker must allow that, and the runtime
  stops with a named error if it can't.
- Rendering and validation run one after the other, within one overall deadline.
- Ctrl-C cancels the render and cleans up. If the process or machine is killed
  instead, cleanup can't run; keep `runtime-state/` for recovery. A run whose cleanup
  failed is reported as failed.
- Images are tagged by the hash of what they're built from, so editing a Dockerfile
  or the example leaves the previous image in Docker. Remove old ones with
  `docker image ls 'video-editing-*'` and `docker image rm`.
- No retries, uploads, posting or paid services are used.
