import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../main/process';
import type { PovVideo, Preferences } from '../types';
export async function probe(file:string,p:Preferences){const json=JSON.parse(await run(p.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',file]));const video=json.streams.find((s:any)=>s.codec_type==='video');if(!video)throw new Error('No decodable video stream.');const [n,d]=String(video.avg_frame_rate).split('/').map(Number);return {duration:Number(json.format.duration),fps:n/d,hasAudio:json.streams.some((s:any)=>s.codec_type==='audio')};}
export async function findFiles(dir:string):Promise<string[]>{let files:string[]=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,e.name);files.push(...(e.isDirectory()?await findFiles(full):[full]));}return files;}
export async function encodeCapture(captureDir:string,projectDir:string,playerId:string,startTick:number,endTick:number,tickRate:number,p:Preferences,signal?:AbortSignal):Promise<PovVideo>{
 const files=await findFiles(captureDir);const input=files.find(f=>/\.(mp4|avi|mov)$/i.test(f));const audio=files.find(f=>/\.wav$/i.test(f));
 if(!input)throw new Error('HLAE produced no video. Check generated logs and HLAE FFmpeg installation.');
 if(!audio)throw new Error('HLAE produced no game WAV. A silent capture cannot pass POV acceptance.');
 const token=`${playerId}_${startTick}_${endTick}_${Date.now()}`;
 const output=path.join(projectDir,'pov',token+'.mp4'),proxy=path.join(projectDir,'proxies',token+'.mp4');
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(path.dirname(proxy),{recursive:true});
 await run(p.ffmpegPath,['-y','-i',input,'-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest',output],signal);
 const metadata=await probe(output,p);if(!metadata.hasAudio)throw new Error('Muxed POV has no audio track.');
 const expected=(endTick-startTick)/tickRate;if(Math.abs(metadata.duration-expected)>.15)throw new Error(`Capture duration mismatch: ${metadata.duration.toFixed(3)}s vs ${expected.toFixed(3)}s. Synchronization not verified.`);
 await createProxy(output,proxy,p,signal);
 const video:PovVideo={playerId,steamId:playerId,path:output,proxyPath:proxy,videoStartTick:startTick,videoEndTick:endTick,tickRate,...metadata,source:'hlae',syncVerified:true};
 await fs.writeFile(output+'.json',JSON.stringify(video,null,2));return video;
}
export async function createProxy(input:string,output:string,p:Preferences,signal?:AbortSignal){await run(p.ffmpegPath,['-y','-i',input,'-vf','scale=-2:360,fps=15','-an','-c:v','libx264','-preset','veryfast','-crf','27','-g','15','-movflags','+faststart',output],signal);}
