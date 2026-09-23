import path from 'node:path';
import type { Preferences } from '../types';
export interface CaptureSpec { demoPath:string; directory:string; steamId:string; startTick:number; endTick:number; tickRate:number; preferences:Preferences }
export function consolePath(p:string){if(/[";\r\n]/.test(p))throw new Error('Paths may not contain quotes, semicolons or newlines.');return p.replace(/\\/g,'/');}
export function generateCapture(spec:CaptureSpec){
 const {preferences:p,startTick,endTick}=spec;
 if(!/^\d{17}$/.test(spec.steamId))throw new Error('A real Steam64 ID is required.');
 if(!Number.isInteger(startTick)||endTick<=startTick)throw new Error('Invalid recording tick range.');
 const cfg=[
  '// Source2 only. Reviewed against AdvancedFX 2.192.2 documentation.',
  'mirv_streams record screen enabled 1',`mirv_streams record fps ${p.fps}`,
  `mirv_streams record name "${consolePath(path.join(spec.directory,'capture'))}"`,
  'mirv_streams settings edit afxDefault settings afxFfmpeg',
  'mirv_streams record startMovieWav 1',
  'volume 1','demo_timescale 1',
  `mirv_script_load "${consolePath(path.join(path.dirname(p.hlaePath),'resources/AfxHookSource2/snippets/mirv_script_spec_lock.js'))}"`,
  `mirv_script_load "${consolePath(path.join(spec.directory,'capture.js'))}"`,
  `playdemo "${consolePath(spec.demoPath)}"`
 ].join('\n');
 // Source2 in-eye mode is 2 (not Source1 mode 4). Resolve controller index by SteamID.
 // The official view snippet is intentionally unnecessary: native in-eye preserves viewmodel/HUD.
 const script=`"use strict";
(() => {
 const id='tactic-lab-capture'; let armed=false, index=0, finished=false, startRequested=false;
 let startTick=null; let endTick=null; let takeFolder='';
 mirv.events.recordStart.on(id, e => { startTick=mirv.getDemoTick(); takeFolder=e.takeFolder; mirv.message('TL_RECORD_START '+JSON.stringify({tick:startTick,takeFolder})+'\\n'); });
 mirv.events.recordEnd.on(id, () => { endTick=mirv.getDemoTick(); mirv.message('TL_RECORD_END '+JSON.stringify({tick:endTick,startTick,takeFolder})+'\\n'); });
 const startCommand=new AdvancedfxConCommand(() => { if(!index) {mirv.message('TL_ERROR player not found\\n');return;} startRequested=true; mirv.exec('spec_mode 2; mirv_streams record start'); });
 startCommand.register('tl_record_start','');
 const endCommand=new AdvancedfxConCommand(() => {if(finished)return;finished=true;mirv.exec('mirv_streams record end; demo_pause');});
 endCommand.register('tl_record_end','');
 mirv.events.clientFrameStageNotify.on(id,e=>{
  if(e.isBefore||!mirv.isPlayingDemo())return;
  const tick=mirv.getDemoTick(); if(tick===undefined)return;
  if(!armed && tick>0){
   for(let i=1;i<=64;i++){const ent=mirv.getEntityFromIndex(i); if(ent && ent.isPlayerController() && String(ent.getSteamId())===${JSON.stringify(spec.steamId)}){index=i;break;}}
   if(!index)return;
   armed=true;mirv.message('TL_PLAYER '+index+' '+${JSON.stringify(spec.steamId)}+'\\n');
   mirv.exec('mirv_script_spec_lock '+index+'; spec_mode 2; mirv_cmd clear; mirv_cmd addAtTick ${startTick} "tl_record_start"; mirv_cmd addAtTick ${endTick} "tl_record_end"; mirv_skip tick to ${Math.max(0,startTick-Math.round(spec.tickRate*3))}; demo_resume');
  }
  if(armed && !startRequested && tick>${startTick+spec.tickRate}){mirv.message('TL_ERROR missed start tick\\n');finished=true;mirv.exec('demo_pause');}
 });
 globalThis.tacticLab={startCommand,endCommand};
})();`;
 const cmdLine=`-insecure -steam -console -condebug -novid -nojoy -windowed -w ${p.resolution===1080?1920:1280} -h ${p.resolution} +exec "${consolePath(path.join(spec.directory,'capture.cfg'))}"`;
 const args=['-customLoader','-noGui','-autoStart','-programPath',p.cs2Path,'-hookDllPath',path.join(path.dirname(p.hlaePath),'x64/AfxHookSource2.dll'),'-cmdLine',cmdLine];
 return {cfg,script,args};
}
