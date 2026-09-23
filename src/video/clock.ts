import type { PovVideo } from '../types';
export const tickToVideoTime=(tick:number,v:Pick<PovVideo,'videoStartTick'|'tickRate'>)=>(tick-v.videoStartTick)/v.tickRate;
export const videoTimeToTick=(time:number,v:Pick<PovVideo,'videoStartTick'|'tickRate'>)=>v.videoStartTick+Math.round(time*v.tickRate);
export const coversTick=(tick:number,v:Pick<PovVideo,'videoStartTick'|'videoEndTick'>)=>tick>=v.videoStartTick&&tick<v.videoEndTick;
