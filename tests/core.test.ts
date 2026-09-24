import { describe,it,expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { worldToRadar,radarToWorld,sectionFor } from '../src/maps/coordinates';
import { maps } from '../src/maps/catalog';
import { tickToVideoTime,videoTimeToTick,coversTick } from '../src/video/clock';
import { ReplayIndex } from '../src/demo/replay';
import { mockProject } from '../src/demo/mock';
import { captureStep,newTactic } from '../src/tactics/model';
import { loadProject,saveProjectData,atomicJson,within } from '../src/main/projects';
import { generateCapture } from '../src/hlae/generator';
describe('world / radar coordinates',()=>{
 it('maps official origin and scale without hand adjusted offsets',()=>{expect(worldToRadar(maps.de_dust2,-2476,3239)).toEqual([0,0]);expect(worldToRadar(maps.de_dust2,-2476+4.4*1024,3239-4.4*1024)).toEqual([1,1]);});
 it('round trips rotated and multi-floor overviews',()=>{const m={...maps.de_nuke,rotation:90};const r=worldToRadar(m,543,-781,-520);const p=radarToWorld(m,...r);expect(p[0]).toBeCloseTo(543);expect(p[1]).toBeCloseTo(-781);expect(sectionFor(m,-520)?.name).toBe('Lower');expect(sectionFor(m,-400)?.name).toBe('Upper');});
});
describe('canonical tick synchronization',()=>{
 it('switches differently trimmed POVs without changing the tick',()=>{const a={videoStartTick:1000,tickRate:64},b={videoStartTick:500,tickRate:64};const tick=videoTimeToTick(83.417,a);expect(videoTimeToTick(tickToVideoTime(tick,b),b)).toBe(tick);expect(Math.abs(tickToVideoTime(tick,a)-83.417)).toBeLessThan(1/64);});
 it('does not pretend an out-of-range video is synchronized',()=>{expect(coversTick(500,{videoStartTick:600,videoEndTick:700})).toBe(false);expect(coversTick(700,{videoStartTick:600,videoEndTick:700})).toBe(false);});
});
describe('replay sampling',()=>{
 it('interpolates positions but holds death/discontinuity state',()=>{const {match,frames}=mockProject();const a={...frames[0].players[0],x:0,y:0,yaw:179},b={...a,x:100,yaw:-179};const index=new ReplayIndex(match,[{tick:0,players:[a]},{tick:8,players:[b]}]);expect(index.frame(4)[0].x).toBe(50);expect(index.frame(4)[0].yaw).toBe(180);b.alive=false;expect(index.frame(4)[0].x).toBe(0);});
 it('filters grenade lifetime and samples routes by interval',()=>{const data=mockProject(),index=new ReplayIndex(data.match,data.frames);expect(index.utility(7000)).toHaveLength(0);expect(index.paths(0,80,['mock-0']).get('mock-0')).toHaveLength(11);});
});
describe('local project persistence',()=>{
 it('reopens all four structured steps without aliasing the live frame',async()=>{const data=mockProject();const tactic=newTactic('de_dust2','2','');tactic.steps[0]=captureStep(tactic.steps[0],160,data.frames[20].players,data.match.utility);tactic.steps[0].annotations=[{id:'a',kind:'arrow',color:'#fff',points:[[.1,.2],[.3,.4]]}];tactic.steps[0].players[0].x=999;expect(data.frames[20].players[0].x).not.toBe(999);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tactic-test-'));data.project.directory=directory;data.project.tactics=[tactic];await atomicJson(path.join(directory,'match.json'),data.match);await atomicJson(path.join(directory,'frames.json'),data.frames);await saveProjectData(data.project);const opened=await loadProject(path.join(directory,'project.json'));expect(opened.project.tactics[0].steps).toEqual(tactic.steps);expect(opened.project.tactics[0].steps).toHaveLength(4);});
 it('rejects traversing project data paths',()=>{expect(()=>within('D:/project','../secret')).toThrow();});
});
describe('Source2 capture generation',()=>{
 it('records native screen, audio and exact tick scheduling with no view reconstruction',()=>{const {project}=mockProject();const g=generateCapture({demoPath:'D:/demo.dem',directory:'D:/project/generated/job',steamId:'76561199141109937',startTick:8000,endTick:9000,tickRate:64,preferences:{...project.preferences,hlaePath:'D:/tools/HLAE.exe',cs2Path:'D:/CS2/cs2.exe'}});expect(g.cfg).toContain('mirv_streams record startMovieWav 1');expect(g.cfg).toContain('mirv_streams record screen enabled 1');expect(g.script).toContain('spec_mode 1');expect(g.script).toContain('getEntityFromSplitScreenPlayer');expect(g.script).toContain('view.mode!==2');expect(g.script).toContain('addAtTick 8000');expect(g.script).toContain('getSteamId');expect(g.args.at(-1)).toContain('-insecure');expect(g.script).not.toContain('getRenderEyeOrigin');});
 it('rejects command injection in file paths',()=>{const {project}=mockProject();expect(()=>generateCapture({demoPath:'D:/a";quit.dem',directory:'D:/project',steamId:'76561199141109937',startTick:1,endTick:5,tickRate:64,preferences:project.preferences})).toThrow();});
 it('emits syntactically valid Source2 JS',()=>{const {project}=mockProject();const generated=generateCapture({demoPath:'D:/demo.dem',directory:'D:/project',steamId:'76561199141109937',startTick:8000,endTick:9000,tickRate:64,preferences:project.preferences});expect(()=>new Function(generated.script)).not.toThrow();});
});
