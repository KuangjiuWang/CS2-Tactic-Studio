import { useEffect,useRef,useState } from 'react';
import { getReplay,useStore } from './store';
import { maps } from '../maps/catalog';
import { radarToWorld,worldToRadar } from '../maps/coordinates';
import type { Drawing,PlayerFrame } from '../types';
import { useTranslation } from 'react-i18next';
const utilityLabels:Record<string,string>={smoke:'S',flash:'F',he:'HE',molotov:'M',decoy:'D',c4:'C4'};
function drawObject(ctx:CanvasRenderingContext2D,d:Drawing,size:number,selected=false,noteLabel='Note'){
 const points=d.points.map(([x,y])=>[x*size,y*size]);if(!points.length)return;
 const [x,y]=points[0],[ex,ey]=points.at(-1)!;ctx.strokeStyle=d.color;ctx.fillStyle=d.color;ctx.lineWidth=selected?3.5:2;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash(selected?[5,3]:[]);ctx.beginPath();
 if(d.kind==='rectangle')ctx.strokeRect(x,y,ex-x,ey-y);
 else if(d.kind==='circle'){ctx.ellipse((x+ex)/2,(y+ey)/2,Math.max(1,Math.abs(ex-x)/2),Math.max(1,Math.abs(ey-y)/2),0,0,Math.PI*2);ctx.stroke();}
 else if(d.kind==='text'){ctx.font='600 14px Segoe UI';ctx.fillStyle='#0b111b';ctx.fillRect(x-5,y-18,ctx.measureText(d.text??noteLabel).width+14,26);ctx.fillStyle=d.color;ctx.fillText(d.text??noteLabel,x,y);}
 else if(utilityLabels[d.kind]){const radius=d.kind==='smoke'?24:15;ctx.globalAlpha=.23;ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.stroke();ctx.font='bold 10px Segoe UI';ctx.textAlign='center';ctx.fillText(utilityLabels[d.kind],x,y+4);ctx.textAlign='left';}
 else {ctx.moveTo(x,y);points.slice(1).forEach(([u,v])=>ctx.lineTo(u,v));ctx.stroke();if(d.kind==='arrow'){const a=Math.atan2(ey-y,ex-x);ctx.beginPath();ctx.moveTo(ex,ey);ctx.lineTo(ex-13*Math.cos(a-.4),ey-13*Math.sin(a-.4));ctx.moveTo(ex,ey);ctx.lineTo(ex-13*Math.cos(a+.4),ey-13*Math.sin(a+.4));ctx.stroke();}}
 ctx.setLineDash([]);
}
export function Radar(){
 const {t}=useTranslation();
 const ref=useRef<HTMLCanvasElement>(null),host=useRef<HTMLDivElement>(null);const draft=useRef<Drawing|null>(null);const drag=useRef<{id:string;start:[number,number];original:Drawing}|null>(null);const playerDrag=useRef<{id:string;frame:PlayerFrame}|null>(null);
 const project=useStore(s=>s.project),mapName=useStore(s=>s.match.map),floor=useStore(s=>s.floor);const map=project.customMap??maps[mapName];const [imageError,setImageError]=useState(false);const [note,setNote]=useState<{position:[number,number];value:string}|null>(null);
 const pathCache=useRef<{key:string;value:Map<string,PlayerFrame[]>}>({key:'',value:new Map()});
 useEffect(()=>{
  if(!map)return;let alive=true;const img=new Image();setImageError(false);const src=map.sections?.[floor]?.image??map.image;img.src=/^[A-Za-z]:[\\/]/.test(src)?window.desktop.mediaUrl(src):src;img.onerror=()=>{if(alive)setImageError(true)};
  let handle=0;const canvas=ref.current!,ctx=canvas.getContext('2d')!;
  const render=()=>{if(!alive)return;const rect=host.current!.getBoundingClientRect();const size=Math.min(rect.width,rect.height),dpr=window.devicePixelRatio||1;if(canvas.width!==Math.round(size*dpr)){canvas.width=Math.round(size*dpr);canvas.height=Math.round(size*dpr);canvas.style.width=canvas.style.height=`${size}px`;}
   ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,size,size);ctx.fillStyle='#0c1015';ctx.fillRect(0,0,size,size);
   if(img.complete&&img.naturalWidth){ctx.globalAlpha=.82;ctx.drawImage(img,0,0,size,size);ctx.globalAlpha=1;}
   const s=useStore.getState(),step=s.project.tactics[s.activeTactic].steps[s.activeStep];const players=s.editing&&step.captured?step.players:getReplay().frame(s.currentTick);const utilities=s.editing&&step.captured?step.utility:getReplay().utility(s.currentTick);
   const section=map.sections?.[s.floor];const onFloor=(z:number)=>!section||(z>=section.minZ&&z<section.maxZ);
   if(s.showPaths){const steps=s.project.tactics[s.activeTactic].steps,a=steps[s.pathFrom],b=steps[s.pathTo];const ids=s.match.teams.find(t=>t.id===s.project.selectedTeam)?.playerIds??[];const key=`${s.project.directory}:${a.tick}:${b.tick}:${ids.join(',')}`;if(pathCache.current.key!==key)pathCache.current={key,value:getReplay().paths(Math.min(a.tick,b.tick),Math.max(a.tick,b.tick),ids)};
    for(const points of pathCache.current.value.values()){ctx.beginPath();ctx.strokeStyle='#b8c99890';ctx.lineWidth=1.8;let first=true;for(const p of points){if(!onFloor(p.z)){first=true;continue;}const [u,v]=worldToRadar(map,p.x,p.y,p.z);if(first){ctx.moveTo(u*size,v*size);first=false;}else ctx.lineTo(u*size,v*size);}ctx.stroke();}}
   for(const g of utilities){if(!onFloor(g.z))continue;const [u,v]=worldToRadar(map,g.x,g.y,g.z),radius=(g.kind==='smoke'?144:g.kind==='molotov'?115:40)/(map.scale*1024)*size;const colors:Record<string,string>={smoke:'#b6d5d9',flash:'#faf8b2',he:'#fc876a',molotov:'#ff8a4d',decoy:'#af9bec',c4:'#ff6367'};ctx.fillStyle=colors[g.kind];ctx.globalAlpha=.25;ctx.beginPath();ctx.arc(u*size,v*size,Math.max(7,radius),0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle=colors[g.kind]+'90';ctx.lineWidth=1;ctx.stroke();ctx.fillStyle=colors[g.kind];ctx.font='bold 9px Segoe UI';ctx.textAlign='center';ctx.fillText(utilityLabels[g.kind],u*size,v*size+3);}
   for(let p of players){if(playerDrag.current?.id===p.id)p=playerDrag.current.frame;const [u,v]=worldToRadar(map,p.x,p.y,p.z),x=u*size,y=v*size;ctx.globalAlpha=p.alive?(onFloor(p.z)?1:.25):.35;const color=p.side===3?'#79c5ff':'#edc76a';ctx.fillStyle=p.alive?color:'#89929f';ctx.strokeStyle='#101820';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();ctx.stroke();if(p.alive){const a=(-p.yaw+map.rotation)*Math.PI/180;ctx.beginPath();ctx.moveTo(x+10*Math.cos(a-.4),y+10*Math.sin(a-.4));ctx.lineTo(x+21*Math.cos(a),y+21*Math.sin(a));ctx.lineTo(x+10*Math.cos(a+.4),y+10*Math.sin(a+.4));ctx.fill();}else{ctx.fillStyle='#10151d';ctx.font='bold 11px sans-serif';ctx.fillText('×',x,y+4);}
    ctx.fillStyle='#10151d';ctx.textAlign='center';ctx.font='bold 9px Segoe UI';ctx.fillText(String((s.match.teams.find(t=>t.id===s.project.selectedTeam)?.playerIds.indexOf(p.id)??-1)+1||''),x,y+3);const name=s.match.players.find(v=>v.id===p.id)?.name??'';ctx.font='10px Segoe UI';const width=ctx.measureText(name).width;ctx.fillStyle='#10151ddd';ctx.fillRect(x-width/2-4,y+11,width+8,15);ctx.fillStyle=color;ctx.fillText(name,x,y+22);if(p.hasBomb){ctx.fillStyle='#ff7a68';ctx.fillRect(x+8,y-12,6,8);}ctx.globalAlpha=1;
   }
   ctx.textAlign='left';for(const d of step.annotations){const view=drag.current?.id===d.id?draft.current??d:d;drawObject(ctx,view,size,s.selectedObject===d.id,t('tactics.note'));}if(draft.current&&!drag.current)drawObject(ctx,draft.current,size,false,t('tactics.note'));
   handle=requestAnimationFrame(render);
  };render();return()=>{alive=false;cancelAnimationFrame(handle)};
 },[map,floor]);
 const point=(e:React.PointerEvent):[number,number]=>{const r=ref.current!.getBoundingClientRect();return [(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height];};
 const down=(e:React.PointerEvent)=>{if(!map)return;const s=useStore.getState(),pos=point(e),step=s.project.tactics[s.activeTactic].steps[s.activeStep];ref.current?.setPointerCapture(e.pointerId);
  if(s.tool==='pointer'||s.tool==='eraser'){
   const target=[...step.annotations].reverse().find(d=>{const xs=d.points.map(p=>p[0]),ys=d.points.map(p=>p[1]);return pos[0]>=Math.min(...xs)-.02&&pos[0]<=Math.max(...xs)+.02&&pos[1]>=Math.min(...ys)-.025&&pos[1]<=Math.max(...ys)+.025;});
   if(target){if(s.tool==='eraser')s.editStep(v=>({...v,annotations:v.annotations.filter(d=>d.id!==target.id)}));else{drag.current={id:target.id,start:pos,original:structuredClone(target)};s.set({selectedObject:target.id});}return;}
   s.set({selectedObject:null});if(s.tool==='pointer'&&s.editing){const p=step.players.find(p=>{const [x,y]=worldToRadar(map,p.x,p.y,p.z);return Math.hypot(x-pos[0],y-pos[1])<.025;});if(p){playerDrag.current={id:p.id,frame:{...p}};}}return;
  }
  if(s.tool==='text'){setNote({position:pos,value:''});return;}
  draft.current={id:crypto.randomUUID(),kind:s.tool as Drawing['kind'],color:s.color,points:[pos]};
 };
 const move=(e:React.PointerEvent)=>{const p=point(e);if(playerDrag.current&&map){const [x,y]=radarToWorld(map,...p);playerDrag.current.frame={...playerDrag.current.frame,x,y};return;}if(drag.current){const {original,start}=drag.current;draft.current={...original,points:original.points.map(([x,y])=>[x+p[0]-start[0],y+p[1]-start[1]])};return;}if(draft.current){if(draft.current.kind==='pen')draft.current.points.push(p);else draft.current.points=[draft.current.points[0],p];}};
 const up=()=>{const s=useStore.getState();if(playerDrag.current){const frame=playerDrag.current.frame;s.editStep(v=>({...v,players:v.players.map(p=>p.id===frame.id?frame:p)}));playerDrag.current=null;}if(draft.current){const d=draft.current;if(drag.current)s.editStep(v=>({...v,annotations:v.annotations.map(o=>o.id===d.id?d:o)}));else s.addDrawing(d);}draft.current=null;drag.current=null;};
 if(!map)return <div className="empty"><h2>{t('tactics.unsupported',{map:mapName})}</h2><p>{t('tactics.overviewHint')}</p></div>;
 return <div className="radar-host" ref={host}><canvas aria-label={t('tactics.map')} ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{draft.current=null;drag.current=null;playerDrag.current=null;}} onWheel={e=>{if(!e.shiftKey)return;const s=useStore.getState();if(!s.editing)return;const rect=ref.current!.getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width,y=(e.clientY-rect.top)/rect.height;s.editStep(step=>({...step,players:step.players.map(p=>{const [u,v]=worldToRadar(map,p.x,p.y,p.z);return Math.hypot(u-x,v-y)<.03?{...p,yaw:p.yaw+Math.sign(e.deltaY)*10}:p;})}));}}/>{imageError&&<div className="map-error">{t('tactics.radarMissing')}</div>}{note&&<form className="note-editor" onSubmit={e=>{e.preventDefault();if(note.value.trim())useStore.getState().addDrawing({id:crypto.randomUUID(),kind:'text',color:useStore.getState().color,points:[note.position],text:note.value});setNote(null);}}><input aria-label={t('tactics.noteText')} autoFocus value={note.value} placeholder={t('tactics.writeNote')} onChange={e=>setNote({...note,value:e.target.value})}/><button type="submit">{t('tactics.addNote')}</button><button type="button" onClick={()=>setNote(null)}>{t('tactics.cancel')}</button></form>}</div>;
}
