#!/bin/sh
# HyperFrames sample: generate the source clip, then build and render each cut.
set -eu
sh make-source.sh source.mp4
node hyperframes/build.mjs
