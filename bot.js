#!/usr/bin/env node
// Bot helper for the MTG VTT. Usage:
//   node /workspace/mtg-vtt/bot.js view <seat>            -> your seat's view (hidden info stays hidden)
//   node /workspace/mtg-vtt/bot.js view <seat> --json     -> same, as JSON
//   node /workspace/mtg-vtt/bot.js act <seat> "<actions>"  -> submit actions (one per line or separated by ;)
//   node /workspace/mtg-vtt/bot.js help                   -> action format
const base=process.env.MTG_VTT||'http://localhost:8787';
const [cmd,seat,...rest]=process.argv.slice(2);
(async()=>{
  try{
    if(!cmd||cmd==='help'){ console.log(await (await fetch(base+'/api/help')).text()); return; }
    if(cmd==='view'){ const json=rest.includes('--json'); const r=await fetch(`${base}/api/view?seat=${seat}${json?'&format=json':''}`); console.log(await r.text()); return; }
    if(cmd==='act'){ let text=rest.join(' '); if(!text||text==='-') text=require('fs').readFileSync(0,'utf8');
      const r=await fetch(base+'/api/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seat:+seat,text})}); const j=await r.json();
      if(j.error){ console.log('ERROR: '+j.error); process.exit(1); }
      for(const x of j.results) console.log((x.ok?'OK   ':'FAIL ')+x.line+(x.ok?(x.msg?'  -> '+x.msg:''):'  -> '+x.error)); return; }
    console.log('Unknown command. Use: view <seat> | act <seat> "<actions>" | help');
  }catch(e){ console.log('Could not reach the MTG VTT server at '+base+'. Start it with: bash /workspace/mtg-vtt/start.sh'); process.exit(1); }
})();
