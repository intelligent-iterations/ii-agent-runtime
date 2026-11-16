#!/bin/sh
# Remotion sample: generate the source clip, then render one composition per cut.
# Packages come from the renderer image; Remotion uses its system Chromium offline.
set -eu
mkdir -p remotion/public out
sh make-source.sh remotion/public/source.mp4
cd remotion
ln -sfn /opt/remotion/node_modules node_modules
for id in $(node -p "require('../shorts.json').map(s => s.id).join(' ')"); do
  echo "Rendering out/$id.mp4"
  remotion render src/index.ts "$id" "../out/$id.mp4" --public-dir=public \
    --browser-executable=/usr/bin/chromium --concurrency=2 --bundle-cache=false --log=error
done
