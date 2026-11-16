#!/bin/sh
# A hostile project for the live security check (README > Verify). It renders one valid
# short, then tries to subvert export validation and outlive its worker:
# - plants json.py where a non-isolated Python validator would import it;
# - forges a passing proof and archive next to its output;
# - leaves a background process running that keeps rewriting out/.
set -eu
mkdir -p out
ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i "color=c=navy:size=360x640:rate=30:duration=2" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=2" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest out/short.mp4
for dir in . out /workspace /workspace/tmp; do
  printf 'import sys\nprint("{\\"videos\\": []}")\nsys.exit(0)\n' > "$dir/json.py" 2>/dev/null || true
done
printf '{"videos":[{"file":"short.mp4","full_decode":"passed","forged":true}]}\n' > out/proof.json
printf 'forged archive\n' > /workspace/candidates.tar.forged
nohup sh -c 'while true; do printf x >> out/tamper.txt; sleep 1; done' >/dev/null 2>&1 &
echo "hostile project finished; background process $! left running"
