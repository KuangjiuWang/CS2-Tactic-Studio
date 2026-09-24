import { describe,it,expect } from 'vitest';
import { mockProject } from '../src/demo/mock';
import { rosterForTeam,teamSideAtTick } from '../src/demo/team';
import { validatePovMedia } from '../src/video/encode';
import { planHLAEJobs } from '../src/hlae/manager';

describe('POV roster and halftime',()=>{
 it('keeps the same five SteamIDs while their T/CT side flips',()=>{
  const {match}=mockProject();
  const ids=rosterForTeam(match,'2').map(player=>player.id);
  match.rounds[0].teamASide=2;
  match.rounds.push({...match.rounds[0],number:2,startTick:7681,endTick:15000,teamASide:3});
  expect(teamSideAtTick(match,'2',1000)).toBe(2);
  expect(teamSideAtTick(match,'2',8000)).toBe(3);
  expect(rosterForTeam(match,'2').map(player=>player.id)).toEqual(ids);
  expect(teamSideAtTick(match,'3',8000)).toBe(2);
 });
 it('plans five aligned MP4s by roster identity, not current side',()=>{
  const {match,project}=mockProject();
  match.players.forEach((player,index)=>{player.id=String(76561198000000000+index);player.steamId=player.id;});
  match.teams[0].playerIds=match.players.slice(0,5).map(player=>player.id);
  match.teams[1].playerIds=match.players.slice(5).map(player=>player.id);
  match.rounds[0].teamASide=2;
  match.rounds.push({...match.rounds[0],number:2,startTick:7681,endTick:15000,teamASide:3});
  match.endTick=15000;project.mock=false;project.directory='D:/test';project.demoPath='D:/match.dem';
  const jobs=planHLAEJobs(project,match,8000,8640);
  expect(jobs.map(job=>job.outputPath.replace(/\\/g,'/').split('/').at(-1))).toEqual(['player1.mp4','player2.mp4','player3.mp4','player4.mp4','player5.mp4']);
  expect(jobs.map(job=>job.steamId)).toEqual(match.teams[0].playerIds);
  expect(jobs.every(job=>job.startTick===8000&&job.endTick===8640)).toBe(true);
 });
});
describe('strict native capture checks',()=>{
 const preferences={...mockProject().project.preferences,resolution:720 as const,fps:60 as const};
 const valid={duration:10,fps:60,hasAudio:true,width:1280,height:720};
 it('requires audio, expected duration, requested FPS and size',()=>{
  expect(()=>validatePovMedia(valid,10,preferences)).not.toThrow();
  expect(()=>validatePovMedia({...valid,hasAudio:false},10,preferences)).toThrow(/audio/);
  expect(()=>validatePovMedia({...valid,duration:8},10,preferences)).toThrow(/duration/);
  expect(()=>validatePovMedia({...valid,fps:30},10,preferences)).toThrow(/frame rate/);
  expect(()=>validatePovMedia({...valid,width:640},10,preferences)).toThrow(/resolution/);
 });
});
