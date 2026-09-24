import { app, BrowserWindow, ipcMain, dialog, protocol, net, clipboard, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { detectPreferences } from './detect';
import { atomicJson, loadProject, saveProjectData } from './projects';
import { RenderManager } from '../hlae/manager';
import { createProxy, probe } from '../video/encode';
import { PlaybookDatabase } from './playbook-db';
import { exportTacticArchive, parseTacticArchive } from './tactic-archive';
import { SupabaseShareProvider } from './share-provider';
import { createShareArchive } from './share-archive';
import dotenv from 'dotenv';
import type { ExportTacticOptions, LibraryTacticInput, Project, Match, MapOverview, PovVideo } from '../types';
if (process.env.TACTICLAB_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.TACTICLAB_TEST_USER_DATA));
protocol.registerSchemesAsPrivileged([{scheme:'tactic-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,bypassCSP:false}}]);
let win:BrowserWindow;const roots=new Set<string>();const manager=new RenderManager();let parsing=false;let dirty=false;let libraryDb:PlaybookDatabase;let shareProvider:SupabaseShareProvider;
const pendingShares=new Map<string,{parsed:ReturnType<typeof parseTacticArchive>;expires:number}>();
const root=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'../..');
const detected=()=>detectPreferences(root,app.isPackaged?path.join(app.getPath('documents'),'Tactic Lab'):path.join(root,'projects'));
const progress=(message:string)=>win?.webContents.send('progress',message);
const authorize=(project:Project)=>{roots.add(path.resolve(project.directory).toLowerCase());for(const v of project.pov){roots.add(path.dirname(path.resolve(v.path)).toLowerCase());roots.add(path.dirname(path.resolve(v.proxyPath)).toLowerCase());}};
const mediaRoot=()=>path.join(app.getPath('userData'),'library-media');
const validId=(id:string)=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
const authorizedFile=(file:string)=>{const full=path.resolve(file).toLowerCase();return [...roots].some(base=>full===base||full.startsWith(base+path.sep));};
async function authorizedRegularFile(file:string){const real=await fs.realpath(file);if(!authorizedFile(real))throw new Error('Media path is outside authorized project folders.');const stat=await fs.stat(real);if(!stat.isFile())throw new Error('Expected a regular media file.');return real;}
async function persistArchive(parsed:ReturnType<typeof parseTacticArchive>){
 const root=mediaRoot(),directory=path.join(root,parsed.tactic.id);await fs.mkdir(directory,{recursive:true});
 try{
  for(const [index,video] of parsed.tactic.videos.entries()){
   const proxy=parsed.proxyFiles.find(file=>file.playerId===video.playerId),full=parsed.fullFiles.find(file=>file.playerId===video.playerId);
   if(proxy){const target=path.join(directory,`player${index+1}_proxy.mp4`);await fs.writeFile(target,proxy.bytes,{flag:'wx'});video.proxyPath=target;}
   if(full){const target=path.join(directory,`player${index+1}_full.mp4`);await fs.writeFile(target,full.bytes,{flag:'wx'});video.fullPath=target;}
  }
  if(parsed.thumbnail){const target=path.join(directory,'thumbnail.webp');await fs.writeFile(target,parsed.thumbnail,{flag:'wx'});parsed.tactic.thumbnailPath=target;}
  roots.add(path.resolve(root).toLowerCase());
  return libraryDb.saveTactic(parsed.tactic);
 }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}
async function saveLibraryTactic(input:LibraryTacticInput){
 if(!validId(input.id))throw new Error('Invalid tactic identifier.');
 const previous=libraryDb.getLibrary().tactics.find(t=>t.id===input.id);
 const directory=path.join(mediaRoot(),input.id);await fs.mkdir(directory,{recursive:true});
 try{
  const videos=[];
  for(const [index,video] of input.videos.entries()){
   const value={...video};
   if(video.proxyPath){const source=await authorizedRegularFile(video.proxyPath),stat=await fs.stat(source);if(stat.size>120*1024*1024)throw new Error('POV proxy is invalid or exceeds the library limit.');const target=path.join(directory,`player${index+1}_proxy.mp4`);if(path.resolve(target).toLowerCase()!==path.resolve(source).toLowerCase())await fs.copyFile(source,target);value.proxyPath=target;}
   if(video.fullPath){const wasStored=previous?.videos.find(item=>item.playerId===video.playerId)?.fullPath===video.fullPath;if(!wasStored)value.fullPath=await authorizedRegularFile(video.fullPath);}
   videos.push(value);
  }
  let thumbnailPath=input.thumbnailPath??null;
  if(thumbnailPath){const wasStored=previous?.thumbnailPath===thumbnailPath;const source=wasStored?thumbnailPath:await authorizedRegularFile(thumbnailPath);const data=await fs.readFile(source);if(data.subarray(0,4).toString('ascii')!=='RIFF'||data.subarray(8,12).toString('ascii')!=='WEBP')throw new Error('Tactic thumbnail must be WebP.');const target=path.join(directory,'thumbnail.webp');if(path.resolve(target).toLowerCase()!==path.resolve(source).toLowerCase())await fs.copyFile(source,target);thumbnailPath=target;}
  roots.add(path.resolve(mediaRoot()).toLowerCase());
  return libraryDb.saveTactic({...input,thumbnailPath,videos});
 }catch(error){if(!libraryDb.getLibrary().tactics.some(t=>t.id===input.id))await fs.rm(directory,{recursive:true,force:true});throw error;}
}
function assertProject(project:Project){if(!roots.has(path.resolve(project.directory).toLowerCase()))throw new Error('Open or save a project folder first.');}
const pick=async(kind:string)=>{const extensions=kind==='demo'?['dem']:kind==='video'?['mp4','mov','mkv']:kind==='overview'?['json']:['exe'];const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:kind,extensions}]});return r.canceled?null:r.filePaths[0];};
app.whenReady().then(async()=>{
 dotenv.config({path:path.resolve(process.cwd(),'.env')});
 await fs.mkdir(app.getPath('userData'),{recursive:true});
 libraryDb=new PlaybookDatabase(path.join(app.getPath('userData'),'tactics.db'));
 roots.add(path.resolve(mediaRoot()).toLowerCase());
 shareProvider=new SupabaseShareProvider();
 protocol.handle('tactic-media',async request=>{try{const file=decodeURIComponent(new URL(request.url).pathname.slice(1));const real=(await fs.realpath(file)).toLowerCase();if(![...roots].some(base=>real===base||real.startsWith(base+path.sep)))return new Response('Forbidden',{status:403});return net.fetch(pathToFileURL(file).href,{headers:request.headers});}catch{return new Response('Media not found',{status:404});}});
 win=new BrowserWindow({width:1500,height:970,minWidth:1050,minHeight:700,backgroundColor:'#0c1015',title:'Tactic Lab',webPreferences:{preload:path.join(__dirname,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 ipcMain.on('dirty-state',(event,value)=>{if(event.sender===win.webContents)dirty=value===true;});
 win.on('close',event=>{
  if(!dirty)return;
  const choice=dialog.showMessageBoxSync(win,{type:'warning',title:'Unsaved changes',message:'This project has unsaved changes.',detail:'Save the project before closing, or discard the changes.',buttons:['Keep editing','Discard changes and close'],defaultId:0,cancelId:0,noLink:true});
  if(choice===0)event.preventDefault();
 });
 win.setMenuBarVisibility(false);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(url!==win.webContents.getURL())e.preventDefault();});
 const handle=(channel:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(channel,(e,...args)=>{if(e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame)throw new Error('Invalid IPC sender.');return fn(...args);});
 handle('detect',detected);handle('pick-file',pick);
 handle('pick-directory',async()=>{const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0];});
 handle('import-demo',async(given?:string)=>{
  if(parsing||manager.active)throw new Error('Wait for the current parsing/render operation.');const file=given??await pick('demo');if(!file)return null;
  parsing=true;try{const preferences=await detected();const base=preferences.outputDirectory;const directory=path.join(base,`${path.basename(file,'.dem')}-${Date.now()}`);await fs.mkdir(directory,{recursive:true});
   const match=await new Promise<Match>((resolve,reject)=>{const child=fork(path.join(__dirname,'../demo/worker.cjs'),[file,directory],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe','ipc']});let resolved=false;let error='';child.stderr?.on('data',d=>error+=d);child.on('message',(m:any)=>{if(m.type==='progress')progress(m.message);if(m.type==='done'){resolved=true;resolve(m.match);}if(m.type==='error')reject(new Error(m.message));});child.on('error',reject);child.on('exit',code=>{if(!resolved)reject(new Error(error||`Parser exited ${code}`));});});
   const project:Project={version:1,name:path.basename(file,'.dem'),directory,demoPath:file,matchDataPath:'match.json',selectedTeam:match.teams[0]?.id??'',pov:[],tactics:[],preferences:{...preferences,demoPath:file},mock:false};
    await saveProjectData(project);libraryDb.saveProject(project);authorize(project);return await loadProject(path.join(directory,'project.json'));
  }finally{parsing=false;}
 });
 handle('open-project',async(given?:string)=>{let file=given;if(!file){const r=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Tactic Lab project.json',extensions:['json']}]});if(r.canceled)return null;file=r.filePaths[0];}const loaded=await loadProject(file);libraryDb.saveProject(loaded.project);authorize(loaded.project);return loaded;});
 handle('save-project',async(project:Project,mockData?:{match:Match;frames:unknown[]})=>{
  if(manager.active)throw new Error('Recording is active. Project is saved automatically after each POV; save tactics when the queue finishes.');
  if(!project.directory){const r=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});if(r.canceled)return null;project.directory=r.filePaths[0];try{await fs.access(path.join(project.directory,'project.json'));throw new Error('This folder already contains a project. Open it or choose a new folder.');}catch(e:any){if(e.code!=='ENOENT')throw e;}roots.add(path.resolve(project.directory).toLowerCase());}
  assertProject(project);if(project.mock&&mockData){await atomicJson(path.join(project.directory,'match.json'),mockData.match);await atomicJson(path.join(project.directory,'frames.json'),mockData.frames);}
  await saveProjectData(project);libraryDb.saveProject(project);authorize(project);return project;
 });
 handle('render',async(project:Project,match:Match,start:number,end:number)=>{assertProject(project);if(!Number.isInteger(start)||!Number.isInteger(end)||start<match.startTick||end>match.endTick||end<=start)throw new Error('Recording range is outside the demo.');await saveProjectData(project);await manager.start(project,match,start,end,u=>win?.webContents.send('render-update',u));});
 handle('cancel-render',()=>manager.cancel());
 handle('import-video',async(project:Project,playerId:string,start:number)=>{assertProject(project);if(!project.pov||!/^\d{17}$/.test(playerId)||!Number.isInteger(start))throw new Error('Select a real demo player and a start tick.');const file=await pick('video');if(!file)return null;const metadata=await probe(file,project.preferences);if(!metadata.hasAudio)throw new Error('Video has no audio track.');const match:Match=JSON.parse(await fs.readFile(path.join(project.directory,'match.json'),'utf8'));const name=playerId+'_'+Date.now()+'.mp4';const output=path.join(project.directory,'pov',name);const proxy=path.join(project.directory,'proxies',name);await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(path.dirname(proxy),{recursive:true});await fs.copyFile(file,output);await createProxy(output,proxy,project.preferences);const video:PovVideo={playerId,steamId:playerId,path:output,proxyPath:proxy,videoStartTick:start,videoEndTick:start+Math.round(metadata.duration*match.tickRate),tickRate:match.tickRate,...metadata,source:'imported',syncVerified:false};authorize({...project,pov:[...project.pov,video]});return video;});
 handle('import-overview',async()=>{const file=await pick('overview');if(!file)return null;const map=JSON.parse(await fs.readFile(file,'utf8')) as MapOverview;if(!map.name||!map.image||![map.pos_x,map.pos_y,map.scale,map.rotation??0].every(Number.isFinite)||map.scale<=0)throw new Error('Overview requires name, image, pos_x, pos_y, scale, rotation.');map.rotation??=0;map.image=path.resolve(path.dirname(file),map.image);for(const s of map.sections??[])s.image=path.resolve(path.dirname(file),s.image);roots.add(path.dirname(file).toLowerCase());return map;});
 handle('get-language',()=>libraryDb.getSetting('language'));
 handle('set-language',(language:string)=>{if(!['zh-CN','en-US'].includes(language))throw new Error('Unsupported language.');libraryDb.setSetting('language',language);});
 handle('library-list',()=>libraryDb.getLibrary());
 handle('folder-create',(name:string,parentId?:string|null)=>libraryDb.createFolder(name,parentId??null));
 handle('folder-rename',(id:string,name:string)=>{if(!validId(id))throw new Error('Invalid folder identifier.');libraryDb.renameFolder(id,name);});
 handle('folder-move',(id:string,parentId:string|null)=>{if(!validId(id)||(parentId!==null&&!validId(parentId)))throw new Error('Invalid folder identifier.');libraryDb.moveFolder(id,parentId);});
 handle('folder-delete',(id:string)=>{if(!validId(id))throw new Error('Invalid folder identifier.');libraryDb.deleteFolder(id);});
 handle('tactic-create',(input:LibraryTacticInput)=>saveLibraryTactic(input));
 handle('tactic-update',(id:string,patch:Partial<LibraryTacticInput>)=>{
  if(!validId(id))throw new Error('Invalid tactic identifier.');const existing=libraryDb.getLibrary().tactics.find(t=>t.id===id);if(!existing)throw new Error('Tactic not found.');
  return saveLibraryTactic({...existing,...patch,id});
 });
 handle('tactic-move',(id:string,folderId:string|null)=>{if(!validId(id)||(folderId!==null&&!validId(folderId)))throw new Error('Invalid tactic identifier.');libraryDb.moveTactic(id,folderId);});
 handle('tactic-delete',async(id:string)=>{if(!validId(id))throw new Error('Invalid tactic identifier.');libraryDb.deleteTactic(id);await fs.rm(path.join(mediaRoot(),id),{recursive:true,force:true});});
 handle('tactic-duplicate',async(id:string,folderId?:string|null)=>{
  if(!validId(id)||(folderId!=null&&!validId(folderId)))throw new Error('Invalid tactic identifier.');const duplicate=libraryDb.duplicateTactic(id,folderId),directory=path.join(mediaRoot(),duplicate.id);await fs.mkdir(directory,{recursive:true});
  try{for(const [index,video] of duplicate.videos.entries())if(video.proxyPath){const source=await authorizedRegularFile(video.proxyPath),target=path.join(directory,`player${index+1}_proxy.mp4`);await fs.copyFile(source,target);video.proxyPath=target;}
   if(duplicate.thumbnailPath){const source=await authorizedRegularFile(duplicate.thumbnailPath),target=path.join(directory,'thumbnail.webp');await fs.copyFile(source,target);duplicate.thumbnailPath=target;}
   roots.add(path.resolve(mediaRoot()).toLowerCase());return libraryDb.saveTactic(duplicate);
  }catch(error){libraryDb.deleteTactic(duplicate.id);await fs.rm(directory,{recursive:true,force:true});throw error;}
 });
 handle('tactic-import-file',async(folderId?:string|null)=>{
  const selection=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Tactic Library Package',extensions:['cstactic']}]});if(selection.canceled||!selection.filePaths[0])return null;const file=selection.filePaths[0];
  if(path.extname(file).toLowerCase()!=='.cstactic')throw new Error('Choose a .cstactic archive.');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>128*1024*1024)throw new Error('Archive exceeds the 128 MiB limit.');
  return await persistArchive(parseTacticArchive(new Uint8Array(await fs.readFile(file)),folderId??null));
 });
 handle('tactic-import-bytes',async(bytes:Uint8Array,_name:string,folderId?:string|null)=>{
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>128*1024*1024)throw new Error('Invalid or oversized .cstactic data.');
  return await persistArchive(parseTacticArchive(bytes,folderId??null));
 });
 handle('tactic-export',async(id:string,options:ExportTacticOptions)=>{
  if(!validId(id))throw new Error('Invalid tactic identifier.');const tactic=libraryDb.getLibrary().tactics.find(t=>t.id===id);if(!tactic)throw new Error('Tactic not found.');
  const checked={includeTacticalData:options?.includeTacticalData===true,includeAnnotations:options?.includeAnnotations===true,includeSteps:options?.includeSteps===true,includeThumbnail:options?.includeThumbnail===true,includeProxyVideos:options?.includeProxyVideos===true,includeFullQuality:options?.includeFullQuality===true};
  const result=await dialog.showSaveDialog(win,{defaultPath:`${tactic.name.replace(/[<>:"/\\|?*]/g,'_')}.cstactic`,filters:[{name:'Tactic Library Package',extensions:['cstactic']}]});if(result.canceled||!result.filePath)return null;
  await fs.writeFile(result.filePath,await exportTacticArchive(tactic,checked));return result.filePath;
 });
 handle('folder-export',async(id:string)=>{
  if(!validId(id))throw new Error('Invalid folder identifier.');const library=libraryDb.getLibrary(),folder=library.folders.find(item=>item.id===id);if(!folder)throw new Error('Folder not found.');
  const descendants=new Set<string>([id]);let changed=true;while(changed){changed=false;for(const item of library.folders)if(item.parentId&&descendants.has(item.parentId)&&!descendants.has(item.id)){descendants.add(item.id);changed=true;}}
  const tactics=library.tactics.filter(item=>item.folderId!==null&&descendants.has(item.folderId));if(!tactics.length)return 0;
  const chosen=await dialog.showOpenDialog(win,{properties:['openDirectory','createDirectory']});if(chosen.canceled||!chosen.filePaths[0])return 0;
  for(const tactic of tactics){const safeName=tactic.name.replace(/[<>:"/\\|?*]/g,'_').slice(0,80);const archive=await exportTacticArchive(tactic,{includeTacticalData:true,includeAnnotations:true,includeSteps:true,includeThumbnail:true,includeProxyVideos:true,includeFullQuality:false});await fs.writeFile(path.join(chosen.filePaths[0],`${safeName}-${tactic.id.slice(0,8)}.cstactic`),archive);}
  return tactics.length;
 });
 handle('share-status',()=>shareProvider.status());
 handle('tactic-share',async(id:string,mode:'none'|'optimized'|'full')=>{
  if(!validId(id)||!['none','optimized','full'].includes(mode))throw new Error('Invalid share request.');
  if(!shareProvider.status().configured)throw new Error('Online sharing is not configured. Export a .cstactic file instead.');
  const tactic=libraryDb.getLibrary().tactics.find(item=>item.id===id);if(!tactic)throw new Error('Tactic not found.');
  const prefs=await detected(),archive=await createShareArchive(tactic,mode,prefs.ffmpegPath,prefs.ffprobePath);
  const previous=libraryDb.getShare(id),{result,record}=await shareProvider.uploadTactic(archive,id);
  libraryDb.saveShare({id:crypto.randomUUID(),tacticId:id,shareToken:record.shareToken,providerData:{ownerToken:record.ownerToken},createdAt:new Date().toISOString(),expiresAt:record.expiresAt,serverUrl:result.shareUrl});
  if(previous)await shareProvider.deleteShare({shareToken:previous.shareToken,ownerToken:String(previous.providerData.ownerToken??''),expiresAt:previous.expiresAt}).catch(()=>undefined);
  return result;
 });
 handle('share-preview',async(url:string)=>{
  const bytes=await shareProvider.getTactic(url),parsed=parseTacticArchive(bytes,null),previewId=crypto.randomUUID();
  while(pendingShares.size>=3)pendingShares.delete(pendingShares.keys().next().value!);
  pendingShares.set(previewId,{parsed,expires:Date.now()+15*60_000});
  for(const [key,value] of pendingShares)if(value.expires<Date.now())pendingShares.delete(key);
  const tactic=parsed.tactic;return {previewId,name:tactic.name,description:tactic.description,map:tactic.map,side:tactic.side,roundNumber:tactic.roundNumber,stepCount:tactic.steps.filter(step=>step.captured).length,povCount:parsed.proxyFiles.length+parsed.fullFiles.length,duration:tactic.startTick!==null&&tactic.endTick!==null?(tactic.endTick-tactic.startTick)/tactic.tickRate:null};
 });
 handle('share-import',async(previewId:string,folderId?:string|null)=>{
  const pending=pendingShares.get(previewId);if(!pending||pending.expires<Date.now()){pendingShares.delete(previewId);throw new Error('Share preview expired. Please fetch the link again.');}
  pending.parsed.tactic.folderId=folderId??null;const imported=await persistArchive(pending.parsed);pendingShares.delete(previewId);return imported;
 });
 handle('share-revoke',async(id:string)=>{
  if(!validId(id))throw new Error('Invalid tactic identifier.');const record=libraryDb.getShare(id);if(!record)throw new Error('No active share link for this tactic.');
  await shareProvider.deleteShare({shareToken:record.shareToken,ownerToken:String(record.providerData.ownerToken??''),expiresAt:record.expiresAt});libraryDb.deleteShare(id);
 });
 handle('copy-text',(value:string)=>{if(typeof value!=='string'||value.length>4096)throw new Error('Invalid clipboard text.');clipboard.writeText(value);});
 handle('open-external',async(value:string)=>{const url=new URL(value);if(url.protocol!=='https:'&&url.hostname!=='localhost'&&url.hostname!=='127.0.0.1')throw new Error('Only HTTPS links may be opened.');await shell.openExternal(url.href);});
 if(process.env.VITE_DEV_SERVER_URL)await win.loadURL(process.env.VITE_DEV_SERVER_URL);else await win.loadFile(path.join(__dirname,'../renderer/index.html'));
});
app.on('window-all-closed',()=>{manager.cancel();libraryDb?.close();app.quit();});
