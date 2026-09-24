import { contextBridge,ipcRenderer } from 'electron';
import type { DesktopApi } from '../types';
const listen=(channel:string,fn:(value:any)=>void)=>{const handler=(_:unknown,value:unknown)=>fn(value);ipcRenderer.on(channel,handler);return ()=>ipcRenderer.removeListener(channel,handler);};
const api:DesktopApi={
 setDirty:dirty=>ipcRenderer.send('dirty-state',dirty),detect:()=>ipcRenderer.invoke('detect'),pickFile:kind=>ipcRenderer.invoke('pick-file',kind),pickDirectory:()=>ipcRenderer.invoke('pick-directory'),
 importDemo:path=>ipcRenderer.invoke('import-demo',path),openProject:path=>ipcRenderer.invoke('open-project',path),saveProject:(p,data)=>ipcRenderer.invoke('save-project',p,data),
 render:(p,m,s,e)=>ipcRenderer.invoke('render',p,m,s,e),cancelRender:()=>ipcRenderer.invoke('cancel-render'),importVideo:(p,id,start)=>ipcRenderer.invoke('import-video',p,id,start),
 onRender:fn=>listen('render-update',fn),onProgress:fn=>listen('progress',fn),mediaUrl:path=>'tactic-media://local/'+encodeURIComponent(path),importOverview:()=>ipcRenderer.invoke('import-overview'),
 getLanguage:()=>ipcRenderer.invoke('get-language'),setLanguage:language=>ipcRenderer.invoke('set-language',language),getPlaybookLibrary:()=>ipcRenderer.invoke('library-list'),
 createPlaybookFolder:(name,parent)=>ipcRenderer.invoke('folder-create',name,parent),renamePlaybookFolder:(id,name)=>ipcRenderer.invoke('folder-rename',id,name),
 movePlaybookFolder:(id,parent)=>ipcRenderer.invoke('folder-move',id,parent),deletePlaybookFolder:id=>ipcRenderer.invoke('folder-delete',id),
 createLibraryTactic:input=>ipcRenderer.invoke('tactic-create',input),updateLibraryTactic:(id,patch)=>ipcRenderer.invoke('tactic-update',id,patch),
 moveLibraryTactic:(id,folder)=>ipcRenderer.invoke('tactic-move',id,folder),deleteLibraryTactic:id=>ipcRenderer.invoke('tactic-delete',id),
 duplicateLibraryTactic:(id,folder)=>ipcRenderer.invoke('tactic-duplicate',id,folder),importTacticFile:folder=>ipcRenderer.invoke('tactic-import-file',folder),
 importTacticBytes:(bytes,name,folder)=>ipcRenderer.invoke('tactic-import-bytes',bytes,name,folder),exportTactic:(id,options)=>ipcRenderer.invoke('tactic-export',id,options),exportPlaybookFolder:id=>ipcRenderer.invoke('folder-export',id),
 getShareStatus:()=>ipcRenderer.invoke('share-status'),shareTactic:(id,mode)=>ipcRenderer.invoke('tactic-share',id,mode),
 previewSharedTactic:url=>ipcRenderer.invoke('share-preview',url),importSharedTactic:(id,folder)=>ipcRenderer.invoke('share-import',id,folder),
 revokeTacticShare:id=>ipcRenderer.invoke('share-revoke',id),copyText:text=>ipcRenderer.invoke('copy-text',text),openExternal:url=>ipcRenderer.invoke('open-external',url)
};
contextBridge.exposeInMainWorld('desktop',api);
