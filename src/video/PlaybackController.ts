import { useStore } from '../renderer/store';
import { coversTick,tickToVideoTime,videoTimeToTick } from './clock';
import type { PovVideo } from '../types';
export class PlaybackController {
 private videos=new Map<string,{element:HTMLVideoElement;metadata:PovVideo}>();
 private proxies=new Map<string,{element:HTMLVideoElement;metadata:PovVideo}>();
 private raf=0;private last=0;private fractionalTick=0;private frameHandle=0;private main?:HTMLVideoElement;private switching=false;private generation=0;
 register(id:string,element:HTMLVideoElement,metadata:PovVideo,proxy=false){const map=proxy?this.proxies:this.videos;map.set(id,{element,metadata});element.muted=proxy;if(!proxy)element.dataset.synced='false';const ready=()=>this.sync(true);element.addEventListener('loadedmetadata',ready);this.sync(true);return()=>{element.removeEventListener('loadedmetadata',ready);element.pause();map.delete(id);};}
 start(){const unsub=useStore.subscribe((s,old)=>{if(s.selectedPlayer!==old.selectedPlayer||s.viewMode!==old.viewMode||s.playing!==old.playing||s.playbackRate!==old.playbackRate||s.volume!==old.volume||s.project!==old.project)this.sync(s.selectedPlayer!==old.selectedPlayer||s.viewMode!==old.viewMode);});
 const loop=(now:number)=>{const dt=this.last?Math.min((now-this.last)/1000,.1):0;this.last=now;const s=useStore.getState();
  const active=s.viewMode==='pov'?this.videos.get(s.selectedPlayer):undefined;
  const useClock=s.viewMode==='tactical'||!active||!coversTick(s.currentTick,active.metadata);
  if(s.playing&&useClock){this.fractionalTick+=dt*s.match.tickRate*s.playbackRate;const ticks=Math.floor(this.fractionalTick);if(ticks){s.seek(s.currentTick+ticks);this.fractionalTick-=ticks;}}
  if(s.playing&&active&&coversTick(s.currentTick,active.metadata)&&active.element.readyState>=1&&!active.element.seeking&&active.element.dataset.synced!=='true')this.sync(true);
  if(s.playing&&s.currentTick>=s.match.endTick)s.set({playing:false});
  this.syncProxies();this.raf=requestAnimationFrame(loop);};this.raf=requestAnimationFrame(loop);return()=>{unsub();cancelAnimationFrame(this.raf);this.stopFrame();for(const v of this.videos.values())v.element.pause();};}
 seek(tick:number){const s=useStore.getState();s.seek(tick);this.fractionalTick=0;this.sync(true);}
 private stopFrame(){if(this.main&&this.frameHandle)this.main.cancelVideoFrameCallback(this.frameHandle);this.frameHandle=0;}
 sync(force=false){const s=useStore.getState();this.stopFrame();const active=s.viewMode==='pov'?this.videos.get(s.selectedPlayer):undefined;
  for(const [id,v] of this.videos){if(!active||id!==s.selectedPlayer){v.element.pause();v.element.muted=true;}}
  if(!active){this.main=undefined;return;}
  const {element:v,metadata:m}=active;this.main=v;v.playbackRate=s.playbackRate;v.volume=s.volume;v.muted=false;
  if(!coversTick(s.currentTick,m)){v.dataset.synced='false';v.pause();return;}
  const wanted=tickToVideoTime(s.currentTick,m);const generation=++this.generation;
  const ready=()=>{if(generation!==this.generation)return;this.switching=false;v.dataset.synced='true';if(useStore.getState().playing){v.play().then(()=>this.watch(v,m)).catch(e=>{useStore.getState().set({playing:false,error:`POV playback failed: ${e.message}`});});}else v.pause();};
  if(v.readyState<1){v.dataset.synced='false';return;}
  if(force||Math.abs(v.currentTime-wanted)>.1){this.switching=true;v.dataset.synced='false';v.pause();if(Math.abs(v.currentTime-wanted)<.001){ready();}else{v.addEventListener('seeked',ready,{once:true});v.currentTime=Math.max(0,wanted);}}else ready();
 }
 private watch(v:HTMLVideoElement,m:PovVideo){this.stopFrame();const frame=(_:number,meta:VideoFrameCallbackMetadata)=>{const s=useStore.getState();if(this.main!==v||s.viewMode!=='pov'||!s.playing)return;if(!this.switching&&!v.seeking){const tick=videoTimeToTick(meta.mediaTime,m);s.seek(tick);if(tick>=m.videoEndTick-1)s.set({playing:false});}this.frameHandle=v.requestVideoFrameCallback(frame);};this.frameHandle=v.requestVideoFrameCallback(frame);}
 private syncProxies(){const s=useStore.getState();for(const {element:v,metadata:m} of this.proxies.values()){v.muted=true;v.playbackRate=s.playbackRate;if(v.readyState>=1&&coversTick(s.currentTick,m)){const t=tickToVideoTime(s.currentTick,m);if(!v.seeking&&Math.abs(v.currentTime-t)>.09)v.currentTime=t;if(s.playing&&v.paused)v.play().catch(()=>{});if(!s.playing&&!v.paused)v.pause();}else v.pause();}}
}
export const playback=new PlaybackController();
