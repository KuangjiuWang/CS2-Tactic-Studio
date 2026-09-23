import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './process';
import { defaultPreferences } from '../demo/mock';
export async function exists(p:string){try{return (await fs.stat(p)).isFile();}catch{return false;}}
export async function detectPreferences(root:string,outputDirectory=path.join(root,'projects')){
 const prefs={...defaultPreferences,outputDirectory};
 const libraries=['C:/Program Files (x86)/Steam','D:/Steam','D:/SteamLibrary','C:/Steam'];
 try{const reg=await run('reg',['query','HKCU\\Software\\Valve\\Steam','/v','SteamPath']);const value=reg.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1].trim();if(value)libraries.unshift(value);}catch{}
 for(const steam of [...libraries]){try{const content=await fs.readFile(path.join(steam,'steamapps/libraryfolders.vdf'),'utf8');for(const m of content.matchAll(/"path"\s+"([^"]+)"/g))libraries.push(m[1].replace(/\\\\/g,'\\'));}catch{}}
 for(const base of libraries){const file=path.join(base,'steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe');if(await exists(file)){prefs.cs2Path=file;break;}}
 const hlae=path.join(root,'tools/hlae/HLAE.exe');if(await exists(hlae))prefs.hlaePath=hlae;
 for(const name of ['ffmpeg','ffprobe'] as const){const local=path.join(root,`tools/ffmpeg/${name}.exe`);let file=await exists(local)?local:'';if(!file){try{file=(await run('where',[`${name}.exe`])).trim().split(/\r?\n/)[0];}catch{}}prefs[`${name}Path`]=file;}
 return prefs;
}
