import fs from 'node:fs/promises';
const names=['de_dust2','de_mirage','de_inferno','de_ancient','de_anubis','de_nuke','de_nuke_lower','de_overpass','de_vertigo','de_vertigo_lower','de_train'];
await fs.mkdir('public/maps',{recursive:true});
await Promise.all(names.map(async name=>{const r=await fetch(`https://raw.githubusercontent.com/akiver/cs-demo-manager/main/static/images/maps/cs2/radars/${name}.png`);if(!r.ok)throw new Error(`${name}: ${r.status}`);await fs.writeFile(`public/maps/${name}.png`,Buffer.from(await r.arrayBuffer()));console.log(name);}));
