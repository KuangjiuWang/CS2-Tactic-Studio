import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
await import('./build.mjs');
const server=await createServer(); await server.listen();
const child=spawn(electron,['.'],{stdio:'inherit',env:{...process.env,VITE_DEV_SERVER_URL:'http://127.0.0.1:5173',ELECTRON_RUN_AS_NODE:undefined}});
child.on('exit',async()=>{await server.close();process.exit(0)});
