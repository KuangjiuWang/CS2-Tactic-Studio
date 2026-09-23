import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { detectPreferences } from './detect';
import { atomicJson, loadProject, saveProjectData } from './projects';
import { RenderManager } from '../hlae/manager';
import { createProxy, probe } from '../video/encode';
import type { Project, Match, MapOverview, PovVideo } from '../types';
protocol.registerSchemesAsPrivileged([{scheme:'tactic-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,bypassCSP:false}}]);
let win:BrowserWindow;const roots=new Set<string>();const manager=new RenderManager();let parsing=false;
const root=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'../..');
const detected=()=>detectPreferences(root,app.isPackaged?path.join(app.getPath('documents'),'Tactic Lab'):path.join(root,'projects'));
const progress=(message:string)=>win?.webContents.send('progress',message);
const authorize=(project:Project)=>{roots.add(path.resolve(project.directory).toLowerCase());for(const v of project.pov){roots.add(path.dirname(path.resolve(v.path)).toLowerCase());roots.add(path.dirname(path.resolve(v.proxyPath)).toLowerCase());}};
function assertProject(project:Project){if(!roots.has(path.resolve(project.directory).toLowerCase()))throw new Error('Open or save a project folder first.');}
const pick=async(kind:string)=>{const extensions=kind==='demo'?['dem']:kind==='video'?['mp4','mov','mkv']:kind==='overview'?['json']:['exe'];const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:kind,extensions}]});return r.canceled?null:r.filePaths[0];};
app.whenReady().then(async()=>{
 protocol.handle('tactic-media',async request=>{try{const file=decodeURIComponent(new URL(request.url).pathname.slice(1));const real=(await fs.realpath(file)).toLowerCase();if(![...roots].some(base=>real===base||real.startsWith(base+path.sep)))return new Response('Forbidden',{status:403});return net.fetch(pathToFileURL(file).href,{headers:request.headers});}catch{return new Response('Media not found',{status:404});}});
 win=new BrowserWindow({width:1500,height:970,minWidth:1050,minHeight:700,backgroundColor:'#0c1015',title:'Tactic Lab',webPreferences:{preload:path.join(__dirname,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.setMenuBarVisibility(false);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(url!==win.webContents.getURL())e.preventDefault();});
 const handle=(channel:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(channel,(e,...args)=>{if(e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame)throw new Error('Invalid IPC sender.');return fn(...args);});
 handle('detect',detected);handle('pick-file',pick);
 handle('pick-directory',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
 handle('import-demo',async(given?:string)=>{
  if(parsing||manager.active)throw new Error('Wait for the current parsing/render operation.');const file=given??await pick('demo');if(!file)return null;
  parsing=true;try{const preferences=await detected();const base=preferences.outputDirectory;const directory=path.join(base,`${path.basename(file,'.dem')}-${Date.now()}`);await fs.mkdir(directory,{recursive:true});
   const match=await new Promise<Match>((resolve,reject)=>{const child=fork(path.join(__dirname,'../demo/worker.cjs'),[file,directory],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe','ipc']});let resolved=false;let error='';child.stderr?.on('data',d=>error+=d);child.on('message',(m:any)=>{if(m.type==='progress')progress(m.message);if(m.type==='done'){resolved=true;resolve(m.match);}if(m.type==='error')reject(new Error(m.message));});child.on('error',reject);child.on('exit',code=>{if(!resolved)reject(new Error(error||`Parser exited ${code}`));});});
   const project:Project={version:1,name:path.basename(file,'.dem'),directory,demoPath:file,matchDataPath:'match.json',selectedTeam:match.teams[0]?.id??'',pov:[],tactics:[],preferences:{...preferences,demoPath:file},mock:false};
   await saveProjectData(project);authorize(project);return await loadProject(path.join(directory,'project.json'));
  }finally{parsing=false;}
 });
 handle('open-project',async(given?:string)=>{let file=given;if(!file){const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Tactic Lab project.json',extensions:['json']}]});if(r.canceled)return null;file=r.filePaths[0];}const loaded=await loadProject(file);authorize(loaded.project);return loaded;});
 handle('save-project',async(project:Project,mockData?:{match:Match;frames:unknown[]})=>{
  if(manager.active)throw new Error('Recording is active. Project is saved automatically after each POV; save tactics when the queue finishes.');
  if(!project.directory){const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});if(r.canceled)return null;project.directory=r.filePaths[0];try{await fs.access(path.join(project.directory,'project.json'));throw new Error('This folder already contains a project. Open it or choose a new folder.');}catch(e:any){if(e.code!=='ENOENT')throw e;}roots.add(path.resolve(project.directory).toLowerCase());}
  assertProject(project);if(project.mock&&mockData){await atomicJson(path.join(project.directory,'match.json'),mockData.match);await atomicJson(path.join(project.directory,'frames.json'),mockData.frames);}
  await saveProjectData(project);authorize(project);return project;
 });
 handle('render',async(project:Project,match:Match,start:number,end:number)=>{assertProject(project);if(!Number.isInteger(start)||!Number.isInteger(end)||start<match.startTick||end>match.endTick||end<=start)throw new Error('Recording range is outside the demo.');await saveProjectData(project);await manager.start(project,match,start,end,u=>win?.webContents.send('render-update',u));});
 handle('cancel-render',()=>manager.cancel());
 handle('import-video',async(project:Project,playerId:string,start:number)=>{assertProject(project);if(!project.pov||!/^\d{17}$/.test(playerId)||!Number.isInteger(start))throw new Error('Select a real demo player and a start tick.');const file=await pick('video');if(!file)return null;const metadata=await probe(file,project.preferences);if(!metadata.hasAudio)throw new Error('Video has no audio track.');const match:Match=JSON.parse(await fs.readFile(path.join(project.directory,'match.json'),'utf8'));const name=playerId+'_'+Date.now()+'.mp4';const output=path.join(project.directory,'pov',name);const proxy=path.join(project.directory,'proxies',name);await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(path.dirname(proxy),{recursive:true});await fs.copyFile(file,output);await createProxy(output,proxy,project.preferences);const video:PovVideo={playerId,steamId:playerId,path:output,proxyPath:proxy,videoStartTick:start,videoEndTick:start+Math.round(metadata.duration*match.tickRate),tickRate:match.tickRate,...metadata,source:'imported',syncVerified:false};authorize({...project,pov:[...project.pov,video]});return video;});
 handle('import-overview',async()=>{const file=await pick('overview');if(!file)return null;const map=JSON.parse(await fs.readFile(file,'utf8')) as MapOverview;if(!map.name||!map.image||![map.pos_x,map.pos_y,map.scale,map.rotation??0].every(Number.isFinite)||map.scale<=0)throw new Error('Overview requires name, image, pos_x, pos_y, scale, rotation.');map.rotation??=0;map.image=path.resolve(path.dirname(file),map.image);for(const s of map.sections??[])s.image=path.resolve(path.dirname(file),s.image);roots.add(path.dirname(file).toLowerCase());return map;});
 if(process.env.VITE_DEV_SERVER_URL)await win.loadURL(process.env.VITE_DEV_SERVER_URL);else await win.loadFile(path.join(__dirname,'../renderer/index.html'));
});
app.on('window-all-closed',()=>{manager.cancel();app.quit();});
