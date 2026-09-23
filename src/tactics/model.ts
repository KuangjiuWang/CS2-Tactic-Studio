import type { Tactic, TacticStep, PlayerFrame, Utility } from '../types';
export function newTactic(map:string,team:string,demoPath:string):Tactic{return {id:crypto.randomUUID(),name:'Untitled execute',map,team,demoPath,steps:Array.from({length:4},(_,i)=>({index:i+1,tick:0,players:[],utility:[],annotations:[],captured:false}))};}
export function captureStep(old:TacticStep,tick:number,players:PlayerFrame[],utility:Utility[]):TacticStep{return {...old,tick,players:structuredClone(players),utility:structuredClone(utility),captured:true};}
