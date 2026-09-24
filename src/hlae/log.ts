import fs from 'node:fs/promises';
import path from 'node:path';
import type { RenderJob } from '../types';

export class RenderLog {
 private consoleText='';
 constructor(private directory:string,private job:RenderJob){}
 add(message:string){this.job.log.push(`${new Date().toISOString()} ${message}`);this.job.message=message;}
 appendConsole(text:string){this.consoleText+=text;if(this.consoleText.length>4_000_000)this.consoleText=this.consoleText.slice(-4_000_000);}
 get console(){return this.consoleText;}
 async save(){
  await fs.mkdir(this.directory,{recursive:true});
  await fs.writeFile(path.join(this.directory,'console.log'),this.consoleText);
  await fs.writeFile(path.join(this.directory,'render.log'),this.job.log.join('\n'));
 }
}
