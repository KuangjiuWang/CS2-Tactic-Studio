import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { run } from '../main/process';

export class HLAEProcessController {
 private child?:ChildProcess;
 private gamePid?:number;
 private offset=0;
 private launchError?:Error;
 private exitCode?:number|null;
 private lastGameCheck=0;
 constructor(private hlaePath:string,private cs2Path:string,private consoleLog:string){}
 get launchedGame(){return this.gamePid!==undefined;}
 async launch(args:string[]){
  try{this.offset=(await fs.stat(this.consoleLog)).size;}catch{this.offset=0;}
  this.child=spawn(this.hlaePath,args,{cwd:path.dirname(this.cs2Path),windowsHide:true});
  this.child.on('error',error=>{this.launchError=error;});
  this.child.on('exit',code=>{this.exitCode=code;});
 }
 async poll():Promise<{gameStarted:boolean;log:string}>{
  if(this.launchError)throw this.launchError;
  let gameStarted=false;
  if(!this.gamePid){
   const list=await run('tasklist',['/FI','IMAGENAME eq cs2.exe','/FO','CSV','/NH']);
   const match=list.match(/"cs2\.exe","(\d+)"/i);
   if(match){this.gamePid=Number(match[1]);gameStarted=true;}
   else if(this.exitCode!==undefined)throw new Error(`HLAE launcher exited before CS2 started (${this.exitCode}).`);
  }
  let log='';
  try{
   const file=await fs.open(this.consoleLog,'r');
   try{
    const size=(await file.stat()).size;
    if(size<this.offset)this.offset=0;
    const bytes=Buffer.alloc(Math.min(size-this.offset,2_000_000));
    if(bytes.length){await file.read(bytes,0,bytes.length,this.offset);this.offset+=bytes.length;log=bytes.toString('utf8');}
   }finally{await file.close();}
  }catch(e:any){if(e.code!=='ENOENT')throw e;}
  if(this.gamePid&&Date.now()-this.lastGameCheck>2000){
   this.lastGameCheck=Date.now();
   const list=await run('tasklist',['/V','/FI',`PID eq ${this.gamePid}`,'/FO','CSV','/NH']);
   if(/Error - AfxHookSource2/i.test(list))throw new Error('HLAE / CS2 version incompatibility: AfxHookSource2 displayed an address error before recording.');
   if(!/"cs2\.exe"/i.test(list)&&!log.includes('TL_RECORD_END'))throw new Error('CS2 exited before HLAE reported recording end.');
  }
  return {gameStarted,log};
 }
 async close(){
  if(this.gamePid){
   await run('taskkill',['/PID',String(this.gamePid),'/T','/F']).catch(()=>{});
   this.gamePid=undefined;
  }
  this.child?.kill();
 }
}
