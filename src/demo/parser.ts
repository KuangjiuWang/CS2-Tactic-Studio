import * as parser from '@laihoe/demoparser2';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Match, ReplayFrame, Round, Utility, UtilityKind } from '../types';
type Row = Record<string, any>;
export async function parseDemo(file:string,output:string,progress=(_s:string)=>{}) {
  progress('Reading demo header and players');
  const header=parser.parseHeader(file) as Row;
  if(!String(header.demo_file_stamp).startsWith('PBDEMS2'))throw new Error('Only CS2 / PBDEMS2 demos are supported.');
  const info=parser.parsePlayerInfo(file) as Row[];
  const names=['round_start','round_end','round_freeze_end','player_death','bomb_pickup','bomb_dropped','bomb_planted','bomb_defused','bomb_exploded','smokegrenade_detonate','smokegrenade_expired','flashbang_detonate','hegrenade_detonate','inferno_startburn','inferno_expire','decoy_started','decoy_expired'];
  progress('Parsing rounds, kills, C4 and utility events');
  const available=new Set<string>(parser.listGameEvents(file) as string[]);
  const raw=parser.parseEvents(file,names.filter(n=>available.has(n)||n==='round_start'||n==='round_end'),['X','Y','Z']) as Row[];
  raw.sort((a,b)=>a.tick-b.tick);
  const starts=new Map<number,Row>();
  for(const e of raw)if(e.event_name==='round_start')starts.set(e.round,e);
  const unique=[...starts.values()].sort((a,b)=>a.tick-b.tick);
  const lastEvent=raw.at(-1)?.tick??0;
  const rounds:Round[]=unique.map((e,i)=>{const next=unique[i+1]?.tick??lastEvent+1;const end=raw.find(v=>v.event_name==='round_end'&&v.tick>e.tick&&v.tick<next);return {number:i+1,startTick:e.tick,freezeEndTick:raw.find(v=>v.event_name==='round_freeze_end'&&v.tick>=e.tick&&v.tick<next)?.tick??e.tick,endTick:end?.tick??next-1,winner:end?.winner==='CT'?3:end?.winner==='T'?2:undefined,score:[0,0]};});
  if(!rounds.length)throw new Error('No playable rounds found. The demo may be incomplete.');
  const startTick=rounds[0].startTick,endTick=rounds.at(-1)!.endTick;
  const probeTick=rounds[0].freezeEndTick+64;
  const probes=parser.parseTicks(file,['game_time'],[probeTick,probeTick+64]) as Row[];
  const t1=probes.find(p=>p.tick===probeTick)?.game_time,t2=probes.find(p=>p.tick===probeTick+64)?.game_time;
  const measured=64/(t2-t1);const tickRate=Number.isFinite(measured)&&measured>10&&measured<256?Math.round(measured):64;
  const warnings:string[]=[];if(!Number.isFinite(measured))warnings.push('Tick rate could not be measured; CS2 default 64 used.');
  const sampleInterval=4; // 16 samples / second, interpolated at display refresh rate.
  const wanted=Array.from({length:Math.floor((endTick-startTick)/sampleInterval)+1},(_,i)=>startTick+i*sampleInterval);
  const props=['X','Y','Z','yaw','health','armor_value','is_alive','team_num','active_weapon_name','inventory'];
  progress(`Sampling positions (${wanted.length.toLocaleString()} frames)`);
  const rows=parser.parseTicks(file,props,wanted) as Row[];
  const grouped=new Map<number,ReplayFrame>();
  for(const row of rows){if(!row.steamid||!Number.isFinite(row.X)||!Number.isFinite(row.Y))continue;let f=grouped.get(row.tick);if(!f){f={tick:row.tick,players:[]};grouped.set(row.tick,f);}f.players.push({id:String(row.steamid),x:row.X,y:row.Y,z:row.Z??0,yaw:row.yaw??0,health:row.health??0,armor:row.armor_value??0,alive:!!row.is_alive,side:row.team_num??0,weapon:row.active_weapon_name??'',hasBomb:(row.inventory??[]).some((s:string)=>s.includes('C4'))});}
  const frames=[...grouped.values()].sort((a,b)=>a.tick-b.tick);
  if(!frames.length)throw new Error('No player position data in this demo.');
  // Use a live first-round sample, not parsePlayerInfo's end-of-match side (halftime swaps).
  const initial=frames.find(f=>f.tick>=rounds[0].freezeEndTick)??frames[0];
  const players=info.filter(p=>initial.players.some(v=>v.id===String(p.steamid)&&[2,3].includes(v.side))).map(p=>({id:String(p.steamid),steamId:String(p.steamid),name:String(p.name),teamId:String(initial.players.find(v=>v.id===String(p.steamid))!.side)}));
  const teams=[2,3].map(side=>({id:String(side),name:side===2?'Team A':'Team B',playerIds:players.filter(p=>p.teamId===String(side)).map(p=>p.id)}));
  const score:[number,number]=[0,0];
  for(const round of rounds){round.score=[...score];const f=frames.find(v=>v.tick>=round.freezeEndTick&&v.tick<=round.endTick);const sideA=f?.players.find(p=>teams[0].playerIds.includes(p.id))?.side;if(sideA===2||sideA===3)round.teamASide=sideA;if(round.winner){if(round.winner===sideA)score[0]++;else score[1]++;}}
  const utility:Utility[]=[];
  const kinds:Record<string,[UtilityKind,string,number]>={smokegrenade_detonate:['smoke','smokegrenade_expired',22],flashbang_detonate:['flash','',.6],hegrenade_detonate:['he','',.8],inferno_startburn:['molotov','inferno_expire',7],decoy_started:['decoy','decoy_expired',15]};
  for(const e of raw){const k=kinds[e.event_name];if(k){const expire=raw.find(x=>x.event_name===k[1]&&x.entityid===e.entityid&&x.tick>e.tick);utility.push({id:`${e.event_name}-${e.tick}-${e.entityid??utility.length}`,kind:k[0],x:e.x??e.user_X,y:e.y??e.user_Y,z:e.z??e.user_Z??0,startTick:e.tick,endTick:expire?.tick??e.tick+k[2]*tickRate,playerId:e.user_steamid});}if(e.event_name==='bomb_planted'||e.event_name==='bomb_dropped'){const end=raw.find(x=>x.tick>e.tick&&['bomb_pickup','bomb_defused','bomb_exploded','round_start'].includes(x.event_name));utility.push({id:`c4-${e.tick}`,kind:'c4',x:e.user_X,y:e.user_Y,z:e.user_Z??0,startTick:e.tick,endTick:end?.tick??endTick});}}
  const match:Match={version:1,map:String(header.map_name),tickRate,startTick,endTick,sampleInterval,players,teams,rounds,events:raw.filter(e=>e.tick>=startTick).map(e=>({tick:e.tick,type:e.event_name,playerId:e.attacker_steamid??e.user_steamid,targetId:e.event_name==='player_death'?e.user_steamid:undefined,x:e.x??e.user_X,y:e.y??e.user_Y,z:e.z??e.user_Z})),utility:utility.filter(g=>Number.isFinite(g.x)&&Number.isFinite(g.y)),framesFile:'frames.json',warnings};
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'match.json'),JSON.stringify(match));
  await fs.writeFile(path.join(output,'frames.json'),JSON.stringify(frames));
  progress(`Ready: ${match.map}, ${players.length} players, ${rounds.length} rounds`);
  return match;
}
