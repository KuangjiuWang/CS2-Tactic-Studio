import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateCapture } from './generator';
import { encodeCapture } from '../video/encode';
import { exists } from '../main/detect';
import { run } from '../main/process';
import type { Project, Match, RenderJob, RenderUpdate } from '../types';
export class RenderManager {
 private abort?:AbortController;
 private jobs:RenderJob[]=[];
 get active(){return !!this.abort;}
 cancel(){this.abort?.abort();}
 async start(project:Project,match:Match,startTick:number,endTick:number,emit:(u:RenderUpdate)=>void){
  if(this.active)throw new Error('A render queue is already running.');
  if(project.mock)throw new Error('Mock projects cannot render real POVs. Open a .dem first.');
  const p=project.preferences;
  for(const [label,file] of [['CS2',p.cs2Path],['HLAE',p.hlaePath],['FFmpeg',p.ffmpegPath],['FFprobe',p.ffprobePath],['Demo',project.demoPath],['AfxHookSource2',path.join(path.dirname(p.hlaePath),'x64/AfxHookSource2.dll')],['HLAE FFmpeg',path.join(path.dirname(p.hlaePath),'ffmpeg/bin/ffmpeg.exe')]])if(!file||!await exists(file))throw new Error(`${label} missing. Configure Preferences: ${file||'(not set)'}`);
  const running=await run('tasklist',['/FI','IMAGENAME eq cs2.exe','/FO','CSV','/NH']);if(/"cs2\.exe"/i.test(running))throw new Error('CS2 is already running. Close it before starting isolated demo recording.');
  const players=match.players.filter(v=>match.teams.find(t=>t.id===project.selectedTeam)?.playerIds.includes(v.id)).slice(0,5);
  if(players.length!==5)throw new Error(`Selected team has ${players.length} players; five are required.`);
  this.abort=new AbortController();const signal=this.abort.signal;
  this.jobs=players.map(v=>({id:crypto.randomUUID(),playerId:v.id,name:v.name,status:'queued',elapsed:0,message:'Waiting',log:[]}));
  emit({jobs:structuredClone(this.jobs)});
  try{for(const job of this.jobs){
    if(signal.aborted){job.status='cancelled';continue;}
    const began=Date.now();const dir=path.join(project.directory,'generated',job.id);await fs.mkdir(dir,{recursive:true});
    const update=(message:string,status=job.status)=>{job.status=status;job.elapsed=(Date.now()-began)/1000;job.message=message;job.log.push(`${new Date().toISOString()} ${message}`);emit({jobs:structuredClone(this.jobs)});};
    let cfgPath='';let cs2Pid:number|undefined;let processChild:ReturnType<typeof spawn>|undefined;let log='';
    try{
      update(`Job started · ${job.name}`,'starting');
      const capture=generateCapture({demoPath:project.demoPath,directory:dir,steamId:job.playerId,startTick,endTick,tickRate:match.tickRate,preferences:p});
      await fs.writeFile(path.join(dir,'capture.cfg'),capture.cfg);await fs.writeFile(path.join(dir,'capture.js'),capture.script);
      const game=path.resolve(path.dirname(p.cs2Path),'../../csgo');
      const cfgName=`tacticlab_${job.id}`;cfgPath=path.join(game,'cfg',cfgName+'.cfg');await fs.writeFile(cfgPath,capture.cfg,{flag:'wx'});
      const args=[...capture.args];args[args.length-1]=args.at(-1)!.replace(/\+exec .+$/,`+exec ${cfgName}`);
      await fs.writeFile(path.join(dir,'launch.json'),JSON.stringify({exe:p.hlaePath,args},null,2));update(`Command: ${p.hlaePath} ${args.join(' ')}`);
      const consoleLog=path.join(game,'console.log');let offset=0;try{offset=(await fs.stat(consoleLog)).size;}catch{}
      processChild=spawn(p.hlaePath,args,{cwd:path.dirname(p.cs2Path),windowsHide:true});let launchError:Error|undefined;processChild.on('error',e=>{launchError=e;});
      let start:number|undefined,end:number|undefined,takeFolder='',recorded=false;
      const deadline=Date.now()+p.jobTimeoutMinutes*60000;
      while(Date.now()<deadline){
        if(signal.aborted)throw new Error('Cancelled');if(launchError)throw launchError;
        if(!cs2Pid){const list=await run('tasklist',['/FI','IMAGENAME eq cs2.exe','/FO','CSV','/NH']);const pid=list.match(/"cs2\.exe","(\d+)"/i);if(pid){cs2Pid=Number(pid[1]);update('CS2 launched');}}
        try{const f=await fs.open(consoleLog,'r');try{const st=await f.stat();if(st.size<offset)offset=0;const b=Buffer.alloc(st.size-offset);await f.read(b,0,b.length,offset);offset=st.size;log+=b.toString('utf8');}finally{await f.close();}}catch{}
        const s=log.match(/TL_RECORD_START (\{[^\r\n]+\})/);if(s&&!recorded){const record=JSON.parse(s[1]);start=record.tick;takeFolder=record.takeFolder;recorded=true;update(`Recording started at tick ${start}`,'recording');}
        const e=log.match(/TL_RECORD_END (\{[^\r\n]+\})/);if(e){end=JSON.parse(e[1]).tick;update(`Recording stopped at tick ${end}`);break;}
        if(/Could not find address for pattern/.test(log)&&!recorded){this.abort?.abort();throw new Error('HLAE / CS2 version incompatibility: Source2 hook signature not found. Install a compatible HLAE build. See generated console.log. No POV was produced.');}
        if(/TL_ERROR|AFXERROR|Error loading.*capture\.js/.test(log))throw new Error(log.slice(-5000));
        await new Promise(r=>setTimeout(r,500));job.elapsed=(Date.now()-began)/1000;emit({jobs:structuredClone(this.jobs)});
      }
      await fs.writeFile(path.join(dir,'console.log'),log);
      if(start===undefined||end===undefined)throw new Error('No completed HLAE recording before timeout. See generated console.log.');
      if(Math.abs(start-startTick)>1||Math.abs(end-endTick)>1)throw new Error(`Tick mismatch: requested ${startTick}–${endTick}, recorded ${start}–${end}.`);
      // Capture is stopped and flushed before shutting down this queue's game process.
      if(cs2Pid){await run('taskkill',['/PID',String(cs2Pid),'/T','/F']).catch(()=>{});cs2Pid=undefined;}
      update('FFmpeg: muxing game audio and generating 360p proxy','encoding');
      const captureDir=takeFolder&&path.isAbsolute(takeFolder)?takeFolder:path.join(dir,'capture');
      const video=await encodeCapture(captureDir,project.directory,job.playerId,start,end,match.tickRate,p,signal);
      project.pov=project.pov.filter(v=>v.playerId!==video.playerId).concat(video);
      await fs.writeFile(path.join(project.directory,'project.json'),JSON.stringify(project,null,2));
      update('Completed — video and game audio verified','completed');emit({jobs:structuredClone(this.jobs),video});
    }catch(e){update(String(e),String(e).includes('version incompatibility')?'failed':signal.aborted?'cancelled':'failed');}
    finally{
      if(cs2Pid)await run('taskkill',['/PID',String(cs2Pid),'/T','/F']).catch(()=>{});
      processChild?.kill();if(cfgPath)await fs.unlink(cfgPath).catch(()=>{});
      await fs.writeFile(path.join(dir,'console.log'),log);await fs.writeFile(path.join(dir,'render.log'),job.log.join('\n'));
    }
  }}finally{this.abort=undefined;emit({jobs:structuredClone(this.jobs)});}
 }
}
