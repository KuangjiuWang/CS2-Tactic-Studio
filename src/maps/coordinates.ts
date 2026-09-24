import type { MapOverview } from '../types';
export function worldToRadar(map:MapOverview,x:number,y:number,_z=0):[number,number]{
  let u=(x-map.pos_x)/(map.scale*1024),v=(map.pos_y-y)/(map.scale*1024);
  if(map.rotation){const a=map.rotation*Math.PI/180,dx=u-.5,dy=v-.5;u=.5+dx*Math.cos(a)-dy*Math.sin(a);v=.5+dx*Math.sin(a)+dy*Math.cos(a);}
  return [u,v];
}
export function radarToWorld(map:MapOverview,u:number,v:number):[number,number]{
  if(map.rotation){const a=-map.rotation*Math.PI/180,dx=u-.5,dy=v-.5;u=.5+dx*Math.cos(a)-dy*Math.sin(a);v=.5+dx*Math.sin(a)+dy*Math.cos(a);}
  return [map.pos_x+u*map.scale*1024,map.pos_y-v*map.scale*1024];
}
export function sectionFor(map:MapOverview,z:number){return map.sections?.find(s=>z>=s.minZ&&z<s.maxZ);}
