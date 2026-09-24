import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../main/process';
import type { POVMetadata, PovVideo, Preferences } from '../types';

export interface MediaProbe {
 duration: number; fps: number; hasAudio: boolean; width: number; height: number;
}
export async function probe(file:string,p:Preferences):Promise<MediaProbe>{
 const stat=await fs.stat(file);
 if(!stat.isFile()||stat.size===0)throw new Error('Video file is missing or empty.');
 const json=JSON.parse(await run(p.ffprobePath,['-v','error','-show_streams','-show_format','-of','json',file]));
 const video=json.streams?.find((s:any)=>s.codec_type==='video');
 if(!video)throw new Error('No video stream.');
 const [n,d]=String(video.avg_frame_rate??'0/0').split('/').map(Number);
 const duration=Number(json.format?.duration??video.duration),fps=n/d;
 if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(fps)||fps<=0)throw new Error('Invalid video duration or frame rate.');
 return {duration,fps,hasAudio:json.streams.some((s:any)=>s.codec_type==='audio'),width:Number(video.width),height:Number(video.height)};
}
export async function verifyDecodable(file:string,p:Preferences,signal?:AbortSignal){
 await run(p.ffmpegPath,['-v','error','-xerror','-err_detect','explode','-i',file,'-map','0:v:0','-map','0:a:0','-f','null','-'],signal);
}
export function validatePovMedia(metadata:MediaProbe,expectedSeconds:number,p:Preferences){
 if(!metadata.hasAudio)throw new Error('Muxed POV has no audio stream.');
 if(Math.abs(metadata.duration-expectedSeconds)>Math.max(.15,2/p.fps))throw new Error('Capture duration does not match the demo tick interval.');
 if(Math.abs(metadata.fps-p.fps)>.5)throw new Error('Capture frame rate does not match the requested FPS.');
 if(metadata.width!==(p.resolution===1080?1920:1280)||metadata.height!==p.resolution)throw new Error('Capture resolution does not match the requested size.');
}
export async function findFiles(dir:string):Promise<string[]>{
 const files:string[]=[];
 for(const e of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,e.name);files.push(...(e.isDirectory()?await findFiles(full):[full]));}
 return files;
}
export async function encodeCapture(
 captureDir:string,projectDir:string,playerId:string,startTick:number,endTick:number,
 tickRate:number,p:Preferences,signal?:AbortSignal,fileStem=`${playerId}_${startTick}_${endTick}`,
 onStatus?:(status:'encoding'|'verifying',message:string)=>void
):Promise<PovVideo>{
 const files=await findFiles(captureDir);
 const input=files.find(f=>/\.(mp4|avi|mov)$/i.test(f));
 const audio=files.find(f=>/\.wav$/i.test(f));
 if(!input)throw new Error('HLAE produced no video. Check capture logs and HLAE FFmpeg installation.');
 if(!audio)throw new Error('HLAE produced no game WAV. Silent captures fail verification.');
 const output=path.join(projectDir,'pov',fileStem+'.mp4');
 const proxy=path.join(projectDir,'proxies',fileStem+'.mp4');
 const pending=output+'.partial.mp4',pendingProxy=proxy+'.partial.mp4';
 await fs.mkdir(path.dirname(output),{recursive:true});
 await fs.mkdir(path.dirname(proxy),{recursive:true});
 const expected=(endTick-startTick)/tickRate;
 try{
  onStatus?.('encoding','Muxing native CS2 video and game WAV');
  await run(p.ffmpegPath,['-y','-i',input,'-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest',pending],signal);
  onStatus?.('verifying','Checking duration, resolution, audio and full decode');
  const metadata=await probe(pending,p);
  validatePovMedia(metadata,expected,p);
  await verifyDecodable(pending,p,signal);
  onStatus?.('encoding','Creating 360p / 15fps muted proxy');
  await createProxy(pending,pendingProxy,p,signal);
  const proxyInfo=await probe(pendingProxy,p);
  if(proxyInfo.height!==360||Math.abs(proxyInfo.fps-15)>.5)throw new Error('Proxy validation failed.');
  await fs.rename(pending,output);
  await fs.rename(pendingProxy,proxy);
  const video:PovVideo={playerId,steamId:playerId,path:output,proxyPath:proxy,videoStartTick:startTick,videoEndTick:endTick,tickRate,duration:metadata.duration,fps:metadata.fps,hasAudio:true,source:'hlae',syncVerified:true,revision:Date.now()};
  const sidecar:POVMetadata={playerId,steamId:playerId,startTick,endTick,tickRate,fps:metadata.fps,duration:metadata.duration,videoPath:output,proxyPath:proxy,hasAudio:true,source:'hlae'};
  await fs.writeFile(output+'.json',JSON.stringify(sidecar,null,2));
  return video;
 }finally{
  await fs.unlink(pending).catch(()=>{});
  await fs.unlink(pendingProxy).catch(()=>{});
 }
}
export async function createProxy(input:string,output:string,p:Preferences,signal?:AbortSignal){
 await run(p.ffmpegPath,['-y','-i',input,'-vf','scale=-2:360,fps=15','-an','-c:v','libx264','-preset','veryfast','-crf','27','-g','15','-movflags','+faststart',output],signal);
}
