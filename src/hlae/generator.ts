import path from 'node:path';
import type { Preferences } from '../types';
export interface CaptureSpec { demoPath:string; directory:string; steamId:string; startTick:number; endTick:number; tickRate:number; preferences:Preferences }
export function consolePath(p:string){if(/[";\r\n]/.test(p))throw new Error('Paths may not contain quotes, semicolons or newlines.');return p.replace(/\\/g,'/');}
export class HLAEConfigGenerator {
 static generate(spec:CaptureSpec){
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
 // CS2 in-eye is spec_mode 1. Follow the stable SteamID, not T/CT side:
 // players switch sides at halftime, but the requested POV does not.
 const script=`"use strict";
(() => {
 const id='tactic-lab-capture'; let armed=false, index=0, finished=false, startRequested=false;
 let startTick=null; let endTick=null; let takeFolder='';
 const observed=()=>{
  const local=mirv.getEntityFromSplitScreenPlayer(0);if(!local)return null;
  const pawn=mirv.getEntityFromIndex(mirv.getHandleEntryIndex(local.getPlayerPawnHandle()));if(!pawn)return null;
  const target=mirv.getEntityFromIndex(mirv.getHandleEntryIndex(pawn.getObserverTargetHandle()));if(!target||!target.isPlayerPawn())return null;
  const controller=mirv.getEntityFromIndex(mirv.getHandleEntryIndex(target.getPlayerControllerHandle()));if(!controller)return null;
  return {steamId:String(controller.getSteamId()),mode:pawn.getObserverMode()};
 };
 const findPlayer=()=>{for(let i=1;i<=1024;i++){const entity=mirv.getEntityFromIndex(i);if(entity&&entity.isPlayerController()&&String(entity.getSteamId())===${JSON.stringify(spec.steamId)})return i;}return 0;};
 mirv.events.recordStart.on(id, e => { startTick=mirv.getDemoTick(); takeFolder=e.takeFolder; mirv.message('TL_RECORD_START '+JSON.stringify({tick:startTick,takeFolder})+'\\n'); });
 mirv.events.recordEnd.on(id, () => { endTick=mirv.getDemoTick(); mirv.message('TL_RECORD_END '+JSON.stringify({tick:endTick,startTick,takeFolder})+'\\n'); });
 const startCommand=new AdvancedfxConCommand(() => { const target=mirv.getEntityFromIndex(index),view=observed(); if(!target || !target.isPlayerController() || String(target.getSteamId())!==${JSON.stringify(spec.steamId)} || !view || view.steamId!==${JSON.stringify(spec.steamId)} || view.mode!==2) {mirv.message('TL_ERROR actual in-eye spectator target mismatch '+JSON.stringify(view)+'\\n');return;} startRequested=true; mirv.message('TL_TARGET '+JSON.stringify({index,steamId:view.steamId,mode:view.mode,tick:mirv.getDemoTick()})+'\\n'); mirv.exec('mirv_streams record start'); });
 startCommand.register('tl_record_start','');
 const endCommand=new AdvancedfxConCommand(() => {if(finished)return;finished=true;mirv.exec('mirv_streams record end; demo_pause');});
 endCommand.register('tl_record_end','');
 mirv.events.clientFrameStageNotify.on(id,e=>{
  if(e.isBefore||!mirv.isPlayingDemo())return;
  const tick=mirv.getDemoTick(); if(tick===undefined)return;
  if(!armed && tick>0){
   index=findPlayer();
   if(!index)return;
   armed=true;mirv.message('TL_PLAYER '+index+' '+${JSON.stringify(spec.steamId)}+'\\n');
   mirv.exec('spec_mode 1; mirv_script_spec_lock '+index+'; mirv_cmd clear; mirv_cmd addAtTick ${startTick} "tl_record_start"; mirv_cmd addAtTick ${endTick} "tl_record_end"; mirv_skip tick to ${Math.max(0,startTick-Math.round(spec.tickRate*3))}; demo_resume');
  }
  if(armed&&!finished){const target=mirv.getEntityFromIndex(index);if(!target||!target.isPlayerController()||String(target.getSteamId())!==${JSON.stringify(spec.steamId)}){const replacement=findPlayer();if(replacement){index=replacement;mirv.exec('mirv_script_spec_lock '+index+'; spec_mode 1');mirv.message('TL_RELOCK '+index+'\\n');}else if(startRequested){finished=true;mirv.message('TL_ERROR target controller disappeared during recording\\n');mirv.exec('mirv_streams record end; demo_pause');}}}
  if(armed && !startRequested && tick>${startTick+spec.tickRate}){mirv.message('TL_ERROR missed start tick\\n');finished=true;mirv.exec('demo_pause');}
 });
 globalThis.tacticLab={startCommand,endCommand};
})();`;
 const cmdLine=`-insecure -steam -console -condebug -novid -nojoy -windowed -w ${p.resolution===1080?1920:1280} -h ${p.resolution} +exec "${consolePath(path.join(spec.directory,'capture.cfg'))}"`;
 const args=['-customLoader','-noGui','-autoStart','-programPath',p.cs2Path,'-hookDllPath',path.join(path.dirname(p.hlaePath),'x64/AfxHookSource2.dll'),'-cmdLine',cmdLine];
 return {cfg,script,args};
 }
}
export const generateCapture=(spec:CaptureSpec)=>HLAEConfigGenerator.generate(spec);
