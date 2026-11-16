"""MoviePy sample: cut each entry in shorts.json from source.mp4, frame it 9:16
over a darkened copy of itself and burn in its title and captions."""
import json
from pathlib import Path
from moviepy import CompositeVideoClip, TextClip, VideoFileClip, vfx

WIDTH, HEIGHT, FPS = 1080, 1920, 30
FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
shorts = json.loads(Path('shorts.json').read_text())
captions = json.loads(Path('captions.json').read_text())
source = VideoFileClip('source.mp4')
Path('out').mkdir(exist_ok=True)

def text(value, size, color, top, start, duration):
    return (TextClip(font=FONT, text=value, font_size=size, color=color, stroke_color='black', stroke_width=6,
                     method='caption', size=(WIDTH - 120, None), text_align='center', margin=(0, 12))
            .with_position(('center', top)).with_start(start).with_duration(duration))

for short in shorts:
    clip = source.subclipped(short['start'], short['end'])
    duration = clip.duration
    background = (clip.without_audio().resized(height=HEIGHT).cropped(x_center=clip.w * HEIGHT / clip.h / 2, width=WIDTH)
                  .with_effects([vfx.MultiplyColor(0.4)]))
    foreground = clip.resized(width=WIDTH).with_position(('center', 656))
    layers = [background, foreground, text(short['title'], 60, 'white', 220, 0, duration)]
    for caption in captions:
        if short['start'] <= caption['start'] < short['end']:
            begin = caption['start'] - short['start']
            layers.append(text(caption['text'], 84, '#FFD23F', 1400, begin, min(caption['end'], short['end']) - caption['start']))
    video = CompositeVideoClip(layers, size=(WIDTH, HEIGHT)).with_duration(duration)
    print(f"Rendering out/{short['id']}.mp4: source {short['start']}-{short['end']} s", flush=True)
    video.write_videofile(f"out/{short['id']}.mp4", fps=FPS, codec='libx264', audio_codec='aac', preset='veryfast',
                          threads=2, temp_audiofile_path='/workspace/tmp' if Path('/workspace/tmp').is_dir() else '.', logger=None)
