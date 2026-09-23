import { build } from 'esbuild';
import { spawn } from 'node:child_process';
await build({entryPoints:['scripts/integration.ts'],bundle:true,platform:'node',format:'esm',outfile:'artifacts/integration.mjs',external:['@laihoe/demoparser2']});
const child=spawn(process.execPath,['artifacts/integration.mjs',...process.argv.slice(2)],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));
