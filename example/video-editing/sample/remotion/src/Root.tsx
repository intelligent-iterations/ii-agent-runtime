import {Composition} from 'remotion';
import shorts from '../../shorts.json';
import captions from '../../captions.json';
import {Short, FPS} from './Short';

// One composition per cut in shorts.json, with the captions that start inside it.
export const Root = () => (
  <>
    {shorts.map(short => (
      <Composition
        key={short.id}
        id={short.id}
        component={Short}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={Math.round((short.end - short.start) * FPS)}
        defaultProps={{
          start: short.start,
          end: short.end,
          title: short.title,
          captions: captions.filter(c => c.start >= short.start && c.start < short.end),
        }}
      />
    ))}
  </>
);
