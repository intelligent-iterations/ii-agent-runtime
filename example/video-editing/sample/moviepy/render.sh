#!/bin/sh
# MoviePy sample: generate the source clip, then cut, frame and caption each short.
set -eu
sh make-source.sh source.mp4
python3 moviepy/render.py
