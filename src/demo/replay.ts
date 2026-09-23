import type { Match, PlayerFrame, ReplayFrame } from '../types';
// Large samples live outside React/Zustand. Binary search provides O(log n) seeking.
export class ReplayIndex {
  constructor(public match: Match, public frames: ReplayFrame[]) {}
  frame(tick: number): PlayerFrame[] {
    if (!this.frames.length) return [];
    let lo=0,hi=this.frames.length-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(this.frames[mid].tick<=tick)lo=mid;else hi=mid-1;}
    const a=this.frames[lo], b=this.frames[lo+1];
    if(!b || b.tick-a.tick>this.match.tickRate || tick<a.tick)return a.players;
    const t=Math.max(0,Math.min(1,(tick-a.tick)/(b.tick-a.tick)));
    return a.players.map(p=>{const q=b.players.find(v=>v.id===p.id);if(!q||!p.alive||!q.alive||Math.hypot(q.x-p.x,q.y-p.y)>300)return p;
      const yaw=p.yaw+(((q.yaw-p.yaw+540)%360)-180)*t;
      return {...p,x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t,z:p.z+(q.z-p.z)*t,yaw};});
  }
  paths(start: number,end: number, ids: string[]) {
    const result=new Map<string,PlayerFrame[]>();ids.forEach(id=>result.set(id,[]));
    for(const f of this.frames){if(f.tick<start)continue;if(f.tick>end)break;for(const p of f.players)if(p.alive)result.get(p.id)?.push(p);}
    return result;
  }
  utility(tick:number){return this.match.utility.filter(g=>g.startTick<=tick&&g.endTick>tick);}
}
