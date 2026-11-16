// Writes one HyperFrames composition per cut in shorts.json, with captions from
// captions.json, then renders each to out/<id>.mp4. Runs offline: no CDN scripts.
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const shorts=JSON.parse(readFileSync('shorts.json','utf8'));
const captions=JSON.parse(readFileSync('captions.json','utf8'));
const escape=text=>text.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const seconds=value=>Number(value.toFixed(3));
mkdirSync('out',{recursive:true});
for(const short of shorts){
  const duration=seconds(short.end-short.start);
  const project=join('hyperframes','build',short.id);
  mkdirSync(join(project,'assets'),{recursive:true});
  copyFileSync('source.mp4',join(project,'assets','source.mp4'));
  const lines=captions.filter(c=>c.start>=short.start&&c.start<short.end).map((c,i)=>
    `    <div id="cap${i}" class="clip cap" data-start="${seconds(c.start-short.start)}" data-duration="${seconds(Math.min(c.end,short.end)-c.start)}" data-track-index="3">${escape(c.text)}</div>`);
  writeFileSync(join(project,'hyperframes.json'),JSON.stringify({paths:{assets:'assets'}},null,2)+'\n');
  writeFileSync(join(project,'index.html'),`<!doctype html>
<html lang="en" data-resolution="portrait">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=1080, height=1920">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #0b0d12; }
      #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; font-family: "Liberation Sans", sans-serif; color: #fff; }
      .bg { position: absolute; inset: -80px; width: 1240px; height: 2080px; object-fit: cover; filter: blur(40px) brightness(0.45); }
      .fg { position: absolute; left: 0; top: 656px; width: 1080px; height: 608px; object-fit: cover; }
      .title { position: absolute; top: 220px; left: 60px; width: 960px; text-align: center; font-size: 60px; font-weight: 700; }
      .cap { position: absolute; top: 1400px; left: 60px; width: 960px; text-align: center; font-size: 84px; font-weight: 700; color: #ffd23f;
             paint-order: stroke fill; -webkit-text-stroke: 10px #000; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-no-timeline data-start="0" data-width="1080" data-height="1920" data-fps="30" data-duration="${duration}">
    <video id="bg" class="clip bg" src="assets/source.mp4" data-start="0" data-duration="${duration}" data-media-start="${short.start}" data-track-index="0" muted playsinline></video>
    <video id="fg" class="clip fg" src="assets/source.mp4" data-start="0" data-duration="${duration}" data-media-start="${short.start}" data-track-index="1" data-has-audio="true" data-volume="1" playsinline></video>
    <div id="title" class="clip title" data-start="0" data-duration="${duration}" data-track-index="2">${escape(short.title)}</div>
${lines.join('\n')}
    </div>
  </body>
</html>
`);
  console.log(`Rendering out/${short.id}.mp4: source ${short.start}-${short.end} s`);
  execFileSync('hyperframes',['render',project,'--output',join('out',short.id+'.mp4'),'--workers','1','--quiet'],{stdio:'inherit'});
}
