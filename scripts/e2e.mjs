// Desktop integration smoke test: launches our own app, verifies IPC and Chromium
// without automating unrelated user applications or requiring a running CS2.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
await fs.mkdir('artifacts',{recursive:true});
const userDataDir=await fs.mkdtemp(path.join(os.tmpdir(),'tacticlab-e2e-userdata-'));
const env={...process.env,TACTICLAB_TEST_USER_DATA:userDataDir};delete env.ELECTRON_RUN_AS_NODE;
const packaged=process.argv.includes('--packaged');
const app=await electron.launch(packaged?{executablePath:path.resolve('release/win-unpacked/Tactic Lab.exe'),args:[],env}:{args:['.'],env});
try{
 const window=await app.firstWindow();await window.waitForLoadState('domcontentloaded');
 const errors=[];window.on('pageerror',e=>errors.push(String(e)));
 const result=await window.evaluate(async()=>({title:document.title,bridge:typeof globalThis.desktop?.openProject,canvas:!!document.querySelector('canvas'),node:typeof globalThis.require,tools:await globalThis.desktop.detect(),steps:[...document.querySelectorAll('.toolbar-steps button')].map(b=>b.textContent.trim()),nav:[...document.querySelectorAll('.side-navigation button')].map(b=>b.textContent.trim())}));
 assert.equal(result.title,'Tactic Lab');assert.equal(result.bridge,'function');assert.equal(result.node,'undefined');assert.equal(result.canvas,true);assert.equal(result.steps.length,4);assert.equal(result.nav.length,2);
 let loaded=null,imported=null;
 const demoPath=process.env.TACTICLAB_TEST_DEMO;
 if(demoPath){
  loaded=await window.evaluate(async projectFile=>{const data=await globalThis.desktop.openProject(projectFile);return {map:data.match.map,players:data.match.players.length,rounds:data.match.rounds.length,frames:data.frames.length,steps:data.project.tactics[0].steps.length};},path.resolve('artifacts/integration/project.json'));
  assert.equal(loaded.steps,4);assert.equal(loaded.players,10);
  imported=await window.evaluate(async demo=>{const data=await globalThis.desktop.importDemo(demo);return {directory:data.project.directory,rounds:data.match.rounds.length,teamSizes:data.match.teams.map(t=>t.playerIds.length)};},demoPath);
  assert.deepEqual(imported.teamSizes,[5,5]);
 }
 await window.screenshot({path:'artifacts/app.png'});assert.deepEqual(errors,[]);
 await fs.writeFile(packaged?'artifacts/packaged-smoke.json':'artifacts/electron-smoke.json',JSON.stringify({packaged,bridge:true,contextIsolation:true,nodeIntegration:false,canvas:true,steps:4,realDemoProjectLoaded:loaded,realDemoImported:imported,errors},null,2));console.log(imported?'PASS: Electron launch, secure preload, canvas, real project and demo import.':'PASS: Electron launch, secure preload, canvas and four tactical steps.');
}finally{const child=app.process(),pid=child?.pid;await app.close().catch(()=>undefined);if(pid&&child?.exitCode===null){try{execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});}catch{/* process already exited */}await new Promise(resolve=>setTimeout(resolve,300));}if(userDataDir.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(userDataDir).startsWith('tacticlab-e2e-userdata-'))await fs.rm(userDataDir,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
