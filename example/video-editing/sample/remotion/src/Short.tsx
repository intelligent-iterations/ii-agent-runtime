import {AbsoluteFill, OffthreadVideo, Sequence, staticFile} from 'remotion';

export const FPS = 30;
type Caption = {text: string; start: number; end: number};
type Props = {start: number; end: number; title: string; captions: Caption[]};

const text = {position: 'absolute', left: 60, width: 960, textAlign: 'center', fontWeight: 700} as const;

// The cut framed 9:16 over a blurred, darkened copy of itself, with title and captions.
export const Short = ({start, end, title, captions}: Props) => {
  const source = staticFile('source.mp4');
  const from = Math.round(start * FPS);
  return (
    <AbsoluteFill style={{backgroundColor: '#0b0d12', fontFamily: '"Liberation Sans", sans-serif'}}>
      <AbsoluteFill style={{filter: 'blur(40px) brightness(0.45)', transform: 'scale(1.1)'}}>
        <OffthreadVideo src={source} trimBefore={from} muted style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>
      <div style={{position: 'absolute', left: 0, top: 656, width: 1080, height: 608}}>
        <OffthreadVideo src={source} trimBefore={from} style={{width: '100%', height: '100%'}} />
      </div>
      <div style={{...text, top: 220, fontSize: 60, color: '#fff'}}>{title}</div>
      {captions.map(caption => (
        <Sequence key={caption.start} from={Math.round((caption.start - start) * FPS)}
          durationInFrames={Math.round((Math.min(caption.end, end) - caption.start) * FPS)}>
          <div style={{...text, top: 1400, fontSize: 84, color: '#ffd23f', WebkitTextStroke: '10px #000', paintOrder: 'stroke fill'}}>
            {caption.text}
          </div>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
