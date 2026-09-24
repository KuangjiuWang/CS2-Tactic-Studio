import { describe,it,expect } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/main/process';
import { probe,validatePovMedia,verifyDecodable } from '../src/video/encode';
import { mockProject } from '../src/demo/mock';

const ffmpeg=path.resolve('tools/ffmpeg/ffmpeg.exe');
const ffprobe=path.resolve('tools/ffmpeg/ffprobe.exe');
describe('FFmpeg media gate (test fixture only, never published as POV)',()=>{
 it.skipIf(!existsSync(ffmpeg)||!existsSync(ffprobe))('accepts decodable video with audio and rejects a silent copy',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tactic-pov-test-'));
  const withAudio=path.join(directory,'fixture-with-audio.mp4');
  const silent=path.join(directory,'fixture-no-audio.mp4');
  const preferences={...mockProject().project.preferences,ffmpegPath:ffmpeg,ffprobePath:ffprobe,resolution:720 as const,fps:60 as const};
  try{
   await run(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=c=black:s=1280x720:r=60:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',withAudio]);
   const valid=await probe(withAudio,preferences);
   expect(()=>validatePovMedia(valid,1,preferences)).not.toThrow();
   await verifyDecodable(withAudio,preferences);
   await run(ffmpeg,['-y','-v','error','-i',withAudio,'-an','-c:v','copy',silent]);
   const withoutAudio=await probe(silent,preferences);
   expect(()=>validatePovMedia(withoutAudio,1,preferences)).toThrow(/audio/);
  }finally{
   await fs.unlink(withAudio).catch(()=>{});
   await fs.unlink(silent).catch(()=>{});
   await fs.rmdir(directory).catch(()=>{});
  }
 });
});
