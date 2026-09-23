import { create } from 'zustand';
import type { LoadedProject, Match, Project, Tactic, Drawing, RenderJob, Preferences, TacticStep } from '../types';
import { ReplayIndex } from '../demo/replay';
import { mockProject } from '../demo/mock';
import { newTactic,captureStep } from '../tactics/model';
let replay:ReplayIndex;export const getReplay=()=>replay;
interface State {
 project:Project;match:Match;currentTick:number;playing:boolean;playbackRate:number;selectedPlayer:string;selectedRound:number;viewMode:'pov'|'tactical';volume:number;
 activeStep:number;activeTactic:number;editing:boolean;tool:string;color:string;showPaths:boolean;pathFrom:number;pathTo:number;floor:number;selectedObject:string|null;
 history:Tactic[];future:Tactic[];jobs:RenderJob[];error:string;busy:string;dirty:boolean;
 load:(data:LoadedProject)=>void;seek:(tick:number)=>void;selectPlayer:(id:string)=>void;set:(data:Partial<State>)=>void;
 patchProject:(patch:Partial<Project>)=>void;preferences:(p:Preferences)=>void;
 changeStep:(i:number)=>void;capture:()=>void;editStep:(fn:(s:TacticStep)=>TacticStep)=>void;addDrawing:(d:Drawing)=>void;undo:()=>void;redo:()=>void;
}
const mock=mockProject();replay=new ReplayIndex(mock.match,mock.frames);mock.project.tactics=[newTactic(mock.match.map,'2','')];
export const useStore=create<State>((set,get)=>({
 project:mock.project,match:mock.match,currentTick:1600,playing:false,playbackRate:1,selectedPlayer:mock.match.players[0].id,selectedRound:1,viewMode:'tactical',volume:.7,
 activeStep:0,activeTactic:0,editing:false,tool:'pointer',color:'#f5bf55',showPaths:false,pathFrom:0,pathTo:1,floor:0,selectedObject:null,history:[],future:[],jobs:[],error:'',busy:'',dirty:false,
 set:patch=>set(patch),
 load:({project,match,frames})=>{replay=new ReplayIndex(match,frames);if(!project.tactics.length)project={...project,tactics:[newTactic(match.map,project.selectedTeam,project.demoPath)]};set({project,match,currentTick:match.startTick,playing:false,selectedPlayer:match.teams.find(t=>t.id===project.selectedTeam)?.playerIds[0]??match.players[0].id,selectedRound:1,activeStep:0,activeTactic:0,history:[],future:[],editing:false,dirty:false,jobs:[],error:'',busy:'',floor:0});},
 seek:tick=>{const m=get().match;const value=Math.round(Math.max(m.startTick,Math.min(m.endTick,tick)));set({currentTick:value,selectedRound:[...m.rounds].reverse().find(r=>r.startTick<=value)?.number??1});},
 selectPlayer:id=>set({selectedPlayer:id,viewMode:'pov',editing:false}),
 patchProject:patch=>set(s=>({project:{...s.project,...patch},dirty:true})),
 preferences:p=>set(s=>({project:{...s.project,preferences:p},dirty:true})),
 changeStep:i=>{const s=get(),step=s.project.tactics[s.activeTactic].steps[i];set({activeStep:i,playing:false,editing:step.captured,selectedObject:null});if(step.captured)get().seek(step.tick);},
 capture:()=>{const s=get();get().editStep(old=>captureStep(old,s.currentTick,replay.frame(s.currentTick),replay.utility(s.currentTick)));set({editing:true,playing:false});},
 editStep:fn=>{const s=get(),old=s.project.tactics[s.activeTactic];const tactic={...old,steps:old.steps.map((step,i)=>i===s.activeStep?fn(step):step)};set({project:{...s.project,tactics:s.project.tactics.map((t,i)=>i===s.activeTactic?tactic:t)},history:[...s.history.slice(-79),structuredClone(old)],future:[],dirty:true});},
 addDrawing:d=>get().editStep(s=>({...s,annotations:[...s.annotations,d]})),
 undo:()=>{const s=get(),t=s.history.at(-1);if(t)set({project:{...s.project,tactics:s.project.tactics.map((v,i)=>i===s.activeTactic?t:v)},history:s.history.slice(0,-1),future:[...s.future,s.project.tactics[s.activeTactic]],dirty:true});},
 redo:()=>{const s=get(),t=s.future.at(-1);if(t)set({project:{...s.project,tactics:s.project.tactics.map((v,i)=>i===s.activeTactic?t:v)},future:s.future.slice(0,-1),history:[...s.history,s.project.tactics[s.activeTactic]],dirty:true});}
}));
