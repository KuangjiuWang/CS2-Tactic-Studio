import { build } from 'esbuild';
await build({entryPoints:{'main/index':'src/main/index.ts','preload/index':'src/preload/index.ts','demo/worker':'src/demo/worker.ts'},bundle:true,platform:'node',target:'node22',format:'cjs',outdir:'dist',outExtension:{'.js':'.cjs'},external:['electron','@laihoe/demoparser2'],sourcemap:true});
