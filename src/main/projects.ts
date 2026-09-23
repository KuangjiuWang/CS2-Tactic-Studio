import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LoadedProject, Project } from '../types';
const finite=z.number().finite();
const projectSchema=z.object({version:z.literal(1),name:z.string(),demoPath:z.string(),matchDataPath:z.string(),selectedTeam:z.string(),pov:z.array(z.object({playerId:z.string(),path:z.string(),proxyPath:z.string(),videoStartTick:finite,videoEndTick:finite,tickRate:finite.positive()}).passthrough()),tactics:z.array(z.object({id:z.string(),name:z.string(),steps:z.array(z.object({index:z.number().int().min(1).max(4),tick:finite,players:z.array(z.unknown()),utility:z.array(z.unknown()),annotations:z.array(z.unknown()),captured:z.boolean()})).length(4)}).passthrough()),preferences:z.object({cs2Path:z.string(),hlaePath:z.string(),ffmpegPath:z.string(),ffprobePath:z.string(),resolution:z.union([z.literal(720),z.literal(1080)]),fps:z.union([z.literal(30),z.literal(60)]),jobTimeoutMinutes:finite.min(1).max(240)}).passthrough(),mock:z.boolean()}).passthrough();
export async function atomicJson(file:string,data:unknown){const tmp=file+`.${crypto.randomUUID()}.tmp`;await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
export function within(base:string,relative:string){const file=path.resolve(base,relative);if(file!==path.resolve(base)&&!file.toLowerCase().startsWith(path.resolve(base).toLowerCase()+path.sep))throw new Error('Project data path escapes its folder.');return file;}
export async function loadProject(file:string):Promise<LoadedProject>{
 const directory=path.dirname(file);const raw=JSON.parse(await fs.readFile(file,'utf8'));projectSchema.parse(raw);const project:Project={...raw,directory};
 const match=JSON.parse(await fs.readFile(within(directory,project.matchDataPath),'utf8'));
 if(match.version!==1||!Array.isArray(match.players)||!Array.isArray(match.rounds)||!Number.isFinite(match.tickRate)||match.tickRate<=0)throw new Error('Invalid match.json.');
 const frames=JSON.parse(await fs.readFile(within(directory,match.framesFile),'utf8'));
 if(!Array.isArray(frames)||!frames.length)throw new Error('No replay frames found.');
 for(const video of project.pov){if(!path.isAbsolute(video.path))video.path=within(directory,video.path);if(!path.isAbsolute(video.proxyPath))video.proxyPath=within(directory,video.proxyPath);}
 return {project,match,frames};
}
export async function saveProjectData(project:Project){
 projectSchema.parse(project);await fs.mkdir(project.directory,{recursive:true});await fs.mkdir(path.join(project.directory,'tactics'),{recursive:true});
 for(const t of project.tactics)await atomicJson(path.join(project.directory,'tactics',`${t.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`),t);
 const disk={...project,pov:project.pov.map(v=>({...v,path:path.relative(project.directory,v.path),proxyPath:path.relative(project.directory,v.proxyPath)}))};
 await atomicJson(path.join(project.directory,'project.json'),disk);
}
