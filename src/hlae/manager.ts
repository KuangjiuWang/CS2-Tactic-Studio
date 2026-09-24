import fs from 'node:fs/promises';
import path from 'node:path';
import { HLAEConfigGenerator } from './generator';
import { hasHlaeHookWarning } from './diagnostics';
import { HLAEProcessController } from './process';
import { RenderLog } from './log';
import { encodeCapture, findFiles } from '../video/encode';
import { exists } from '../main/detect';
import { run } from '../main/process';
import { saveProjectData } from '../main/projects';
import { rosterForTeam, teamSideAtTick } from '../demo/team';
import type { HLAERenderJob, Project, Match, RenderJob, RenderUpdate } from '../types';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function marker(log:string,name:string):Record<string,any>|null{
 const match=log.match(new RegExp(`${name} (\\{[^\\r\\n]+\\})`));
 return match?JSON.parse(match[1]):null;
}
async function waitForCaptureFlush(directory:string,signal:AbortSignal){
 let previous='',stable=0;
 const deadline=Date.now()+20_000;
 while(Date.now()<deadline){
  if(signal.aborted)throw new Error('Cancelled');
  let files:string[]=[];
  try{files=await findFiles(directory);}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const video=files.find(file=>/\.(mp4|avi|mov)$/i.test(file));
  const audio=files.find(file=>/\.wav$/i.test(file));
  if(video&&audio){
   const v=await fs.stat(video),a=await fs.stat(audio);
   const signature=`${video}:${v.size}|${audio}:${a.size}`;
   stable=v.size>0&&a.size>0&&signature===previous?stable+1:0;
   previous=signature;
   if(stable>=3)return;
  }
  await sleep(500);
 }
 throw new Error('HLAE recordEnd fired, but video and game WAV were not flushed within 20 seconds.');
}
export function planHLAEJobs(project:Project,match:Match,startTick:number,endTick:number):HLAERenderJob[]{
 if(project.mock)throw new Error('Mock projects cannot render real POVs.');
 if(!Number.isInteger(startTick)||!Number.isInteger(endTick)||startTick<match.startTick||endTick>match.endTick||endTick<=startTick)throw new Error('Invalid demo tick range.');
 const team=match.teams.find(value=>value.id===project.selectedTeam);
 if(!team||team.playerIds.length!==5)throw new Error('Select one complete five-player team.');
 const players=rosterForTeam(match,team.id);
 if(players.length!==5||players.some(player=>player.id!==player.steamId||!/^\d{17}$/.test(player.steamId)))throw new Error('Team contains an invalid Steam64 player.');
 const startRound=[...match.rounds].reverse().find(round=>round.startTick<=startTick);
 if(startRound){const alreadyDead=match.events.find(event=>event.type==='player_death'&&event.tick>=startRound.startTick&&event.tick<startTick&&players.some(player=>player.id===event.targetId));if(alreadyDead)throw new Error('A selected player is already dead at the start tick; choose an earlier tick for five in-eye POVs.');}
 return players.map((player,index)=>({
  demoPath:project.demoPath,playerId:player.id,steamId:player.steamId,playerName:player.name,
  startTick,endTick,outputPath:path.join(project.directory,'pov',`player${index+1}.mp4`),
  resolution:project.preferences.resolution,fps:project.preferences.fps
 }));
}

export class HLAERenderQueue {
 private abort?:AbortController;
 private jobs:RenderJob[]=[];
 get active(){return !!this.abort;}
 cancel(){this.abort?.abort();}
 async start(project:Project,match:Match,startTick:number,endTick:number,emit:(update:RenderUpdate)=>void){
  if(this.active)throw new Error('A render queue is already running.');
  const renderJobs=planHLAEJobs(project,match,startTick,endTick);
  const preferences=project.preferences;
  const hlaeRoot=path.dirname(preferences.hlaePath);
  for(const [label,file] of [
   ['CS2',preferences.cs2Path],['HLAE',preferences.hlaePath],['FFmpeg',preferences.ffmpegPath],
   ['FFprobe',preferences.ffprobePath],['Demo',project.demoPath],
   ['AfxHookSource2',path.join(hlaeRoot,'x64/AfxHookSource2.dll')],
   ['HLAE FFmpeg',path.join(hlaeRoot,'ffmpeg/bin/ffmpeg.exe')],
   ['Spectator lock snippet',path.join(hlaeRoot,'resources/AfxHookSource2/snippets/mirv_script_spec_lock.js')]
  ])if(!file||!await exists(file))throw new Error(`${label} missing: ${file||'(not set)'}`);
  const existing=await run('tasklist',['/FI','IMAGENAME eq cs2.exe','/FO','CSV','/NH']);
  if(/"cs2\.exe"/i.test(existing))throw new Error('Close the existing CS2 process before isolated demo recording.');
  this.abort=new AbortController();
  this.jobs=renderJobs.map(input=>({id:crypto.randomUUID(),playerId:input.playerId,name:input.playerName,status:'waiting',elapsed:0,message:'Waiting',log:[]}));
  const signal=this.abort.signal;
  emit({jobs:structuredClone(this.jobs)});
  try{
   for(let index=0;index<renderJobs.length;index++){
    const input=renderJobs[index],job=this.jobs[index];
    if(signal.aborted){job.status='cancelled';job.message='Cancelled';emit({jobs:structuredClone(this.jobs)});continue;}
    await this.runOne(input,job,index,project,match,signal,emit);
   }
  }finally{this.abort=undefined;emit({jobs:structuredClone(this.jobs)});}
 }
 private async runOne(input:HLAERenderJob,job:RenderJob,index:number,project:Project,match:Match,signal:AbortSignal,emit:(update:RenderUpdate)=>void){
  const began=Date.now();
  const directory=path.join(project.directory,'generated',job.id);
  await fs.mkdir(directory,{recursive:true});
  const record=new RenderLog(directory,job);
  const update=(status:RenderJob['status'],message:string)=>{
   job.status=status;job.elapsed=(Date.now()-began)/1000;record.add(message);emit({jobs:structuredClone(this.jobs)});
  };
  const p=project.preferences,game=path.resolve(path.dirname(p.cs2Path),'../../csgo');
  const consoleLog=path.join(game,'console.log');
  const cfgName=`tacticlab_${job.id}`,cfgPath=path.join(game,'cfg',cfgName+'.cfg');
  const controller=new HLAEProcessController(p.hlaePath,p.cs2Path,consoleLog);
  let wroteCfg=false;
  try{
   const side=teamSideAtTick(match,project.selectedTeam,input.startTick);
   update('launching',`Launching CS2 for ${input.playerName} (${index+1}/5, ${side===2?'T':side===3?'CT':'side unknown'})`);
   const capture=HLAEConfigGenerator.generate({demoPath:input.demoPath,directory,steamId:input.steamId,startTick:input.startTick,endTick:input.endTick,tickRate:match.tickRate,preferences:p});
   await fs.writeFile(path.join(directory,'capture.cfg'),capture.cfg);
   await fs.writeFile(path.join(directory,'capture.js'),capture.script);
   await fs.writeFile(cfgPath,capture.cfg,{flag:'wx'});wroteCfg=true;
   const args=[...capture.args];
   args[args.length-1]=args.at(-1)!.replace(/\+exec .+$/,`+exec ${cfgName}`);
   await fs.writeFile(path.join(directory,'launch.json'),JSON.stringify({exe:p.hlaePath,args,input},null,2));
   record.add(`Command: ${p.hlaePath} ${args.join(' ')}`);
   await controller.launch(args);
   let started:number|undefined,ended:number|undefined,takeFolder='',targetSteamId='';
   const deadline=Date.now()+p.jobTimeoutMinutes*60_000;
   let hookWarningReported=false;
   while(Date.now()<deadline){
    if(signal.aborted)throw new Error('Cancelled');
    const poll=await controller.poll();
    if(poll.gameStarted)update('loading','Loading demo');
    record.appendConsole(poll.log);
    const log=record.console;
    if(!hookWarningReported&&(poll.hookWarning||hasHlaeHookWarning(log))){
     hookWarningReported=true;
     update('loading','HLAE reported an unresolved engine signature; continuing to verify demo load, exact player lock, and recording markers.');
    }
    const failure=log.match(/TL_ERROR[^\r\n]*|AFXERROR[^\r\n]*|Error loading[^\r\n]*capture\.js[^\r\n]*/i);
    if(failure)throw new Error(failure[0]);
    const target=marker(log,'TL_TARGET');
    if(target){targetSteamId=String(target.steamId);if(targetSteamId!==input.steamId||target.mode!==2)throw new Error('Actual in-eye spectator target does not match this render job.');}
    const start=marker(log,'TL_RECORD_START');
    if(start&&started===undefined){
     started=Number(start.tick);takeFolder=String(start.takeFolder??'');
     update('recording',`Recording native CS2 POV from tick ${started}`);
    }
    const end=marker(log,'TL_RECORD_END');
    if(end){ended=Number(end.tick);update('recording',`Recording stopped at tick ${ended}`);break;}
    await sleep(500);
    job.elapsed=(Date.now()-began)/1000;
    emit({jobs:structuredClone(this.jobs)});
   }
   if(!targetSteamId||started===undefined||ended===undefined)throw new Error('No verified HLAE spectator/recording completion before timeout.');
   if(Math.abs(started-input.startTick)>1||Math.abs(ended-input.endTick)>1)throw new Error(`Tick mismatch: requested ${input.startTick}–${input.endTick}, recorded ${started}–${ended}.`);
   const captureDir=takeFolder?(path.isAbsolute(takeFolder)?takeFolder:path.resolve(path.dirname(p.cs2Path),takeFolder)):path.join(directory,'capture');
   update('verifying','Waiting for HLAE video and game WAV to flush');
   await waitForCaptureFlush(captureDir,signal);
   await controller.close();
   const video=await encodeCapture(captureDir,project.directory,input.playerId,started,ended,match.tickRate,p,signal,`player${index+1}`,(status,message)=>update(status,message));
   if(video.path!==input.outputPath)throw new Error('POV output path mismatch.');
   project.pov=project.pov.filter(v=>v.playerId!==video.playerId).concat(video);
   await saveProjectData(project);
   update('completed','Complete — audio, duration and full decode verified');
   emit({jobs:structuredClone(this.jobs),video});
  }catch(error){
   const message=String(error);
   if(message.includes('version incompatibility'))this.cancel();
   update(signal.aborted&&!message.includes('version incompatibility')?'cancelled':'failed',message);
  }finally{
   await controller.close();
   if(wroteCfg)await fs.unlink(cfgPath).catch(()=>{});
   await record.save();
  }
 }
}
export class RenderManager extends HLAERenderQueue {}
