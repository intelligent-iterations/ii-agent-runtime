#!/bin/sh
# Generates the sample's 16-second 16:9 source clip with FFmpeg: a background whose
# colour cycles through the spectrum, an on-screen source timecode and a tone that
# changes every two seconds. Deterministic, with no download and no third-party
# footage. Replace it with your own video.
set -eu
target=${1:-source.mp4}
[ -f "$target" ] && exit 0
font=/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf
ffmpeg -hide_banner -loglevel error -nostdin \
  -f lavfi -i "color=c=0x2563eb:size=1280x720:rate=30:duration=16" \
  -f lavfi -i "aevalsrc=0.2*sin(2*PI*(220+55*mod(floor(t/2)\,4))*t):s=48000:d=16" \
  -vf "hue=H=2*PI*t/16:s=1.3,drawtext=fontfile=$font:text='source %{pts\:hms}':fontsize=64:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=(h-text_h)/2" \
  -c:v libx264 -preset veryfast -crf 23 -g 30 -keyint_min 30 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 128k -shortest "$target"
