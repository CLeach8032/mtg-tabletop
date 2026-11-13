// MTG VTT local server: serves the UI, holds the authoritative game state, talks to Scryfall/Archidekt.
'use strict';
const http=require('http'), fs=require('fs'), path=require('path');
const E=require('./engine');
const PORT=+process.env.PORT||8787;
const DIR=__dirname, DATA=path.join(DIR,'data'), PUB=path.join(DIR,'public');
fs.mkdirSync(path.join(DATA,'views'),{recursive:true});
const rd=(f,d)=>{ try{ return JSON.parse(fs.readFileSync(path.join(DATA,f),'utf8')); }catch{ return d; } };
const wr=(f,o)=>{ const p=path.join(DATA,f); fs.writeFileSync(p+'.tmp',typeof o==='string'?o:JSON.stringify(o)); fs.renameSync(p+'.tmp',p); };

let db=rd('cards.json',{});             // scryfall id -> slim card
let nameIdx=rd('names.json',{});        // lowercased name / set|cn -> scryfall id
let game=rd('game.json',null);
let setup=rd('setup.json',null) || { format:'commander', firstSeat:null, seats:[1,2,3,4].map(n=>({seat:n, enabled:true, name:['Connor','Jess','Theo','Mia'][n-1], controller:n===1?'Connor':['Jess','Theo','Mia'][n-2], deck:null})) };
let history=[];
let rulingsCache=rd('rulings.json',{});

// ---------- Scryfall (rate limited ~9 req/s) ----------
const UA={'User-Agent':'ConnorMTGVTT/1.0 (personal tabletop)','Accept':'application/json'};
let nextSlot=0;
async function sf(url, init={}){
  const now=Date.now(); const at=Math.max(now,nextSlot); nextSlot=at+110; if(at>now) await new Promise(r=>setTimeout(r,at-now));
  const r=await fetch(url,{...init,headers:{...UA,...(init.headers||{})}});
  if(r.status===429){ await new Promise(r=>setTimeout(r,1500)); return sf(url,init); }
  return r;
}
function slim(c){
  const faces=(c.card_faces||[]).map(f=>({name:f.name,mana_cost:f.mana_cost||'',type_line:f.type_line||'',oracle_text:f.oracle_text||'',power:f.power,toughness:f.toughness,loyalty:f.loyalty,defense:f.defense,image:f.image_uris?f.image_uris.normal:null}));
  const img=c.image_uris?c.image_uris.normal:(faces[0]&&faces[0].image)||null;
  return { id:c.id, oracle_id:c.oracle_id, name:c.name, layout:c.layout, mana_cost:c.mana_cost!==undefined?c.mana_cost:(faces[0]?faces[0].mana_cost:''), cmc:c.cmc,
    type_line:c.type_line||faces.map(f=>f.type_line).join(' // '), oracle_text:c.oracle_text!==undefined?c.oracle_text:faces.map(f=>`${f.name}: ${f.oracle_text}`).join('\n//\n'),
    power:c.power, toughness:c.toughness, loyalty:c.loyalty, colors:c.colors, color_identity:c.color_identity, keywords:c.keywords,
    image:img, faces: faces.length?faces:null, rulings_uri:c.rulings_uri, scryfall_uri:c.scryfall_uri, set:c.set, cn:c.collector_number,
    tokens:(c.all_parts||[]).filter(p=>p.component==='token'||(p.component==='combo_piece'&&/Emblem|Token/.test(p.type_line||''))).filter(p=>p.id!==c.id).map(p=>({id:p.id,name:p.name,type:p.type_line})) };
}
function remember(c){ const s=slim(c); db[s.id]=s; nameIdx[E.norm(s.name)]=s.id; if(s.faces) nameIdx[E.norm(s.faces[0].name)]=nameIdx[E.norm(s.faces[0].name)]||s.id; if(s.set&&s.cn) nameIdx[`${s.set}|${s.cn}`.toLowerCase()]=s.id; return s; }
function saveDb(){ wr('cards.json',db); wr('names.json',nameIdx); }
async function collection(idents){ // returns map key->id
  const out={}; const notFound=[];
  for(let i=0;i<idents.length;i+=75){
    const batch=idents.slice(i,i+75);
    const r=await sf('https://api.scryfall.com/cards/collection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifiers:batch.map(b=>b.ident)})});
    const j=await r.json(); if(!r.ok) throw new Error('Scryfall: '+(j.details||r.status));
    const cards=(j.data||[]).map(remember);
    for(const b of batch){ const id=b.ident;
      const hit=cards.find(c=> id.id? c.id===id.id : id.set? (c.set===id.set.toLowerCase() && String(c.cn).toLowerCase()===String(id.collector_number).toLowerCase()) : (E.norm(c.name)===E.norm(id.name) || (c.faces&&c.faces.some(f=>E.norm(f.name)===E.norm(id.name))) || E.norm(c.name).split(' // ')[0]===E.norm(id.name).split(' // ')[0]));
      if(hit) out[b.key]=hit.id; else notFound.push(b); }
  }
  return {out, notFound};
}
async function fuzzy(name){ const r=await sf('https://api.scryfall.com/cards/named?fuzzy='+encodeURIComponent(name)); if(!r.ok) return null; return remember(await r.json()); }

// ---------- deck parsing ----------
function parseDeckText(text){
  const entries=[]; let section='main'; let sawBlank=false; let nonEmpty=0;
  for(let raw of String(text).split(/\r?\n/)){
    let line=raw.trim();
    if(!line){ if(nonEmpty) sawBlank=true; continue; }
    if(/^\/\//.test(line)) line=line.replace(/^\/\/\s*/,'');
    const hdr=line.toLowerCase().replace(/[:\s]+$/,'').replace(/\s*\(\d+\)$/,'');
    if(/^(commanders?|commander zone|command zone|oathbreaker|signature spell)$/.test(hdr)){ section='commander'; continue; }
    if(/^(deck|main|maindeck|main deck|mainboard|library|creatures?|lands?|instants?|sorcer(y|ies)|artifacts?|enchantments?|planeswalkers?|spells|other|battles?)$/.test(hdr)){ section='main'; continue; }
    if(/^(sideboard|side ?board|sb)$/.test(hdr)){ section='sideboard'; continue; }
    if(/^(companion)$/.test(hdr)){ section='companion'; continue; }
    if(/^(maybeboard|maybe|considering|tokens?)$/.test(hdr)){ section='skip'; continue; }
    if(/^about$|^name /i.test(line)) continue;
    let sec=section;
    if(/^SB:\s*/i.test(line)){ sec='sideboard'; line=line.replace(/^SB:\s*/i,''); }
    if(/\*CMDR\*|\[commander[^\]]*\]|\{commander\}/i.test(line)) sec='commander';
    if(/\[(maybeboard|considering)[^\]]*\]/i.test(line)) sec='skip';
    if(/\[sideboard[^\]]*\]/i.test(line)) sec='sideboard';
    line=line.replace(/\[[^\]]*\]/g,'').replace(/\*[A-Z]+\*/g,'').replace(/\^[^^]*\^/g,'').replace(/\s+#.*$/,'').trim();
    let m=line.match(/^(\d+)\s*x?\s+(.+)$/i); let qty=1, rest=line; if(m){ qty=+m[1]; rest=m[2]; }
    let set=null, cn=null; m=rest.match(/^(.+?)\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([A-Za-z0-9\-★\u2605]+))?\s*$/); if(m){ rest=m[1]; set=m[2].toLowerCase(); cn=m[3]||null; }
    rest=rest.replace(/\s+\/\/?\s+/,' // ').trim(); if(!rest) continue;
    nonEmpty++;
    if(sec==='skip') continue;
    entries.push({qty, name:rest, set, cn, section:sec==='companion'?'sideboard':sec, companion:sec==='companion'});
  }
  return entries;
}
async function resolveEntries(entries){
  const idents=[]; const keyFor=e=> e.sid?('id:'+e.sid): (e.set&&e.cn?`${e.set}|${e.cn}`:'n:'+E.norm(e.name));
  for(const e of entries){ const k=keyFor(e); e.key=k;
    if(e.sid && db[e.sid]) { e.id=e.sid; continue; }
    if(!e.sid && e.set&&e.cn&&nameIdx[`${e.set}|${e.cn}`]) { e.id=nameIdx[`${e.set}|${e.cn}`]; continue; }
    if(!e.sid && !(e.set&&e.cn) && nameIdx[E.norm(e.name)] && db[nameIdx[E.norm(e.name)]]) { e.id=nameIdx[E.norm(e.name)]; continue; }
    if(!idents.find(x=>x.key===k)) idents.push({key:k, ident: e.sid?{id:e.sid}: (e.set&&e.cn?{set:e.set,collector_number:e.cn}:{name:e.name}), name:e.name});
  }
  let {out, notFound}=await collection(idents);
  // retry not-found printings by plain name, then front face, then fuzzy
  if(notFound.length){ const retry=notFound.map(b=>({key:b.key, ident:{name:b.name}, name:b.name})); const r2=await collection(retry); Object.assign(out,r2.out); notFound=r2.notFound; }
  if(notFound.length){ const retry=notFound.filter(b=>b.name.includes(' // ')).map(b=>({key:b.key, ident:{name:b.name.split(' // ')[0]}, name:b.name})); if(retry.length){ const r3=await collection(retry); Object.assign(out,r3.out); notFound=notFound.filter(b=>!r3.out[b.key]); } }
  const still=[]; for(const b of notFound){ const c=await fuzzy(b.name); if(c) out[b.key]=c.id; else still.push(b.name); }
  for(const e of entries) if(!e.id && out[e.key]) e.id=out[e.key];
  saveDb();
  return still;
}
function buildDeck(entries, name, source){
  const deck={name:name||'Deck', source, main:[], commander:[], sideboard:[], missing:[], count:0};
  const add=(arr,id,qty)=>{ const x=arr.find(a=>a.id===id); if(x) x.qty+=qty; else arr.push({id,qty}); };
  for(const e of entries){ if(!e.id){ deck.missing.push(e.name); continue; }
    if(e.section==='commander') for(let i=0;i<e.qty;i++) deck.commander.push(e.id);
    else if(e.section==='sideboard') add(deck.sideboard,e.id,e.qty); else add(deck.main,e.id,e.qty); }
  deck.count=deck.main.reduce((s,x)=>s+x.qty,0)+deck.commander.length;
  deck.preview={commander:deck.commander.map(id=>db[id]&&db[id].name), main:deck.main.slice(0,400).map(x=>`${x.qty} ${db[x.id].name}`), sideboard:deck.sideboard.map(x=>`${x.qty} ${db[x.id].name}`)};
  return deck;
}
async function importArchidekt(url){
  const m=String(url).match(/archidekt\.com\/(?:api\/)?decks\/(\d+)/i)||String(url).match(/^(\d+)$/); if(!m) throw new Error('That does not look like an Archidekt deck link (https://archidekt.com/decks/<number>/...).');
  const r=await fetch(`https://archidekt.com/api/decks/${m[1]}/`,{headers:{'User-Agent':'Mozilla/5.0 (ConnorMTGVTT)','Accept':'application/json'}});
  if(!r.ok) throw new Error(`Archidekt returned ${r.status} (is the deck private?).`);
  const j=await r.json();
  const cats={}; for(const c of j.categories||[]) cats[c.name]=c.includedInDeck;
  const entries=[];
  for(const c of j.cards||[]){
    if(c.deletedAt) continue; const catsOf=c.categories||[];
    let section='main';
    if(catsOf.some(x=>/^commander$/i.test(x))) section='commander';
    else if(catsOf.some(x=>/^sideboard$/i.test(x))) section='sideboard';
    else if(catsOf.some(x=>/^maybeboard$/i.test(x)) || (catsOf.length && catsOf.every(x=>cats[x]===false))) continue;
    if(c.companion) section='sideboard';
    const card=c.card||{}; const oname=(card.oracleCard||{}).name||card.displayName||'?';
    entries.push({qty:c.quantity||1, name:oname, sid:card.uid||null, set:null, cn:null, section});
  }
  const missing=await resolveEntries(entries);
  const deck=buildDeck(entries, j.name, 'archidekt:'+m[1]); deck.missing=deck.missing.concat(missing.filter(x=>!deck.missing.includes(x)));
  return deck;
}

// ---------- persistence / views ----------
function persist(){
  wr('setup.json',setup);
  if(!game) return; wr('game.json',game);
  for(const s of Object.keys(game.seats)){ wr(`views/seat-${s}.txt`, E.textView(game,db,+s)); wr(`views/seat-${s}.json`, E.view(game,db,+s,{logN:60})); }
}
function runActions(seat, body){
  if(!game) throw new Error('No game in progress. Start one in the app first.');
  const host=!!body.host;
  let items=[];
  if(body.actions) items=body.actions.map(a=>typeof a==='string'?{line:a}:{action:a});
  else if(body.action) items=[{action:body.action}];
  else if(body.text) items=E.parseText(body.text);
  if(!items.length) throw new Error('No actions given.');
  const results=[];
  for(const it of items){
    const label=it.line||(it.action&&it.action.__line)||JSON.stringify(it.action);
    try{
      let a=it.action||E.parseLine(it.line); if(!a) continue;
      if(String(a.type).toLowerCase()==='help'){ results.push({ok:true,line:label,msg:E.HELP}); continue; }
      if(a.type==='token' && !a.id && !a.custom) throw new Error('__token__');
      history.push(JSON.stringify(game)); if(history.length>60) history.shift();
      const msgs=E.apply(game,db,seat,a,{host});
      game.v++; game.n++;
      results.push({ok:true,line:label,msg:msgs.join(' ')});
    }catch(e){ results.push({ok:false,line:label,error:e.message}); }
  }
  persist();
  return results;
}
async function prepTokens(seat, body){ // resolve token names via Scryfall before applying
  const items = body.text? E.parseText(body.text).map(x=>{ try{ return {line:x.line, action:E.parseLine(x.line)}; }catch(e){ return {line:x.line, err:e.message}; } }) : null;
  if(!items) { if(body.action && body.action.type==='token' && !body.action.custom) body.action=await resolveToken(body.action);
    if(body.actions) for(let i=0;i<body.actions.length;i++){ let a=body.actions[i]; if(typeof a==='string'){ try{ a=E.parseLine(a); }catch(e){ continue; } body.actions[i]=a; } if(a && a.type==='token' && !a.custom) body.actions[i]=await resolveToken(a); }
    return body; }
  const acts=[]; const pre=[];
  for(const it of items){ if(it.err){ pre.push({ok:false,line:it.line,error:it.err}); continue; } if(!it.action) continue;
    if(it.action.type==='help'||it.line.trim().toLowerCase()==='help'){ pre.push({ok:true,line:'help',msg:E.HELP}); continue; }
    if(it.action.type==='token'){ try{ it.action=await resolveToken(it.action); }catch(e){ pre.push({ok:false,line:it.line,error:e.message}); continue; } }
    acts.push({...it.action,__line:it.line}); }
  return {actions:acts, host:body.host, pre};
}
async function resolveToken(a){
  if(a.id){ if(!db[a.id]){ const r=await sf('https://api.scryfall.com/cards/'+encodeURIComponent(a.id)); if(!r.ok) throw new Error('Token not found on Scryfall.'); remember(await r.json()); saveDb(); } return a; }
  const name=String(a.name||'').trim(); if(!name) throw new Error('Token name missing.');
  const pt=name.match(/^(\d+)\/(\d+)\s+(.+)$/);
  const q=pt? `t:token power=${pt[1]} toughness=${pt[2]} name:"${pt[3]}"` : `t:token !"${name}"`;
  let r=await sf('https://api.scryfall.com/cards/search?unique=cards&q='+encodeURIComponent(q));
  let j=r.ok?await r.json():null;
  if(!j||!j.data||!j.data.length){ r=await sf('https://api.scryfall.com/cards/search?unique=cards&q='+encodeURIComponent(`t:token ${pt?pt[3]:name}`)); j=r.ok?await r.json():null; }
  if(j&&j.data&&j.data.length){ const want=E.norm(pt?pt[3]:name); const score=c=>(E.norm(c.name)===want?4:0)+(!c.name.includes('//')?2:0)+(E.norm(c.name).includes(want)?1:0); const best=j.data.slice().sort((x,y)=>score(y)-score(x))[0]; const c=remember(best); saveDb(); return {...a,id:c.id}; }
  // custom token fallback
  return {...a, custom:{name:(pt?pt[3]:name), type:'Token Creature', power:pt?pt[1]:undefined, toughness:pt?pt[2]:undefined, text:''}};
}

// ---------- shared API helpers (used by HTTP + MCP) ----------
async function importDeckText(seat,text,name){ const t=setup.seats.find(x=>x.seat===+seat); if(!t) throw new Error('Seat must be 1-4.'); const entries=parseDeckText(text||''); if(!entries.length) throw new Error('No cards found in that text.'); const missing=await resolveEntries(entries); const deck=buildDeck(entries,name||'Pasted deck','text'); deck.missing=[...new Set(deck.missing.concat(missing))]; t.deck=deck; persist(); return deckSummary(deck); }
async function importDeckUrl(seat,url){ const t=setup.seats.find(x=>x.seat===+seat); if(!t) throw new Error('Seat must be 1-4.'); const deck=await importArchidekt(url); t.deck=deck; persist(); return deckSummary(deck); }
function configure(b){ if(b.format){ if(!E.FORMATS[b.format]) throw new Error('Unknown format. Options: '+Object.keys(E.FORMATS).join(', ')); setup.format=b.format; } if('firstSeat' in b) setup.firstSeat=b.firstSeat||null;
  if(b.seats) for(const s of b.seats){ const t=setup.seats.find(x=>x.seat===+s.seat); if(!t) continue; for(const k of ['enabled','name','controller']) if(s[k]!==undefined) t[k]=s[k]; if(s.clearDeck) t.deck=null; }
  persist(); return publicSetup(); }
function endGame(){ if(game) wr('last-game.json',game); game=null; try{ fs.unlinkSync(path.join(DATA,'game.json')); }catch{} try{ for(const f of fs.readdirSync(path.join(DATA,'views'))) fs.unlinkSync(path.join(DATA,'views',f)); }catch{} persist(); }
function startGame(format){ if(format) configure({format}); if(game) endGame(); history=[]; game=E.newGame(setup,db); persist(); return game; }
function undo(){ if(!history.length) throw new Error('Nothing to undo.'); game=JSON.parse(history.pop()); game.v=Date.now()%1e9; game.log.push({n:game.log.length+1,t:new Date().toISOString(),seat:null,text:'↶ Last action undone.',vis:null}); persist(); }
async function runPrepared(seat, body){ const prepared=await prepTokens(+seat,body); const pre=prepared.pre||[]; let results=pre; if((prepared.actions&&prepared.actions.length)||prepared.action) results=pre.concat(runActions(+seat,prepared)); return results; }
async function rulingsFor(id){ if(rulingsCache[id]) return rulingsCache[id]; const r=await sf(`https://api.scryfall.com/cards/${encodeURIComponent(id)}/rulings`); const j=await r.json(); const out=(j.data||[]).map(x=>({date:x.published_at,text:x.comment})); rulingsCache[id]=out; wr('rulings.json',rulingsCache); return out; }
async function cardLookup(name){ const id=nameIdx[E.norm(name)]; let c=id&&db[id]; if(!c){ c=await fuzzy(name); saveDb(); } return c; }
async function tokenSearch(qq){ const ptm=qq.match(/^(\d+)\/(\d+)\s*(.*)$/); const nq=ptm?`power=${ptm[1]} toughness=${ptm[2]} ${ptm[3]?'name:'+JSON.stringify(ptm[3]):''}`:(qq?'name:'+JSON.stringify(qq):'');
  let r=await sf('https://api.scryfall.com/cards/search?unique=cards&order=released&dir=desc&q='+encodeURIComponent('t:token '+nq)); if(!r.ok) r=await sf('https://api.scryfall.com/cards/search?unique=cards&q='+encodeURIComponent('t:token '+qq)); if(!r.ok) return []; const j=await r.json();
  const data=(j.data||[]).sort((a,b)=>(E.norm(b.name)===E.norm(qq))-(E.norm(a.name)===E.norm(qq))); const out=data.slice(0,40).map(c=>{ const s=remember(c); return {id:s.id,name:s.name,type:s.type_line,pt:s.power!==undefined?`${s.power}/${s.toughness}`:'',text:s.oracle_text,image:s.image}; }); saveDb(); return out; }

// ---------- HTTP ----------
function send(res,code,obj,type){ const body=typeof obj==='string'?obj:JSON.stringify(obj); res.writeHead(code,{'Content-Type':type||(typeof obj==='string'?'text/plain; charset=utf-8':'application/json'),'Cache-Control':'no-store'}); res.end(body); }
function body(req){ return new Promise((ok,bad)=>{ let d=''; req.on('data',c=>{ d+=c; if(d.length>5e6) req.destroy(); }); req.on('end',()=>{ try{ ok(d?JSON.parse(d):{}); }catch(e){ bad(new Error('Bad JSON')); } }); }); }
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.md':'text/plain; charset=utf-8'};
const handler=async (req,res)=>{
  const u=new URL(req.url,'http://x'); const p=u.pathname; const q=Object.fromEntries(u.searchParams);
  try{
    if(p==='/api/state'){ if(!game) return send(res,200,{noGame:true,setup:publicSetup()}); const seat=+q.seat||1; return send(res,200,{...E.view(game,db,seat,{host:false,fullLibrary:q.library==='1'}),setup:publicSetup()}); }
    if(p==='/api/view'){ if(!game) return send(res,404,'No game in progress.'); const seat=+q.seat; if(!game.seats[seat]) return send(res,404,`Seat ${seat} is not in this game.`); return q.format==='json'?send(res,200,E.view(game,db,seat,{logN:60})):send(res,200,E.textView(game,db,seat)); }
    if(p==='/api/help') return send(res,200,E.HELP);
    if(p==='/api/act' && req.method==='POST'){ const b=await body(req); const seat=+b.seat; let prepared=await prepTokens(seat,b); const pre=prepared.pre||[]; let results=pre; if((prepared.actions&&prepared.actions.length)||prepared.action) results=pre.concat(runActions(seat,prepared)); return send(res,200,{results,v:game?game.v:0}); }
    if(p==='/api/undo' && req.method==='POST'){ if(!history.length) return send(res,400,{error:'Nothing to undo.'}); game=JSON.parse(history.pop()); game.v=Date.now()%1e9; E.apply; game.log.push({n:game.log.length+1,t:new Date().toISOString(),seat:null,text:'↶ Last action undone.',vis:null}); persist(); return send(res,200,{ok:true}); }
    if(p==='/api/setup' && req.method==='GET') return send(res,200,publicSetup());
    if(p==='/api/setup' && req.method==='POST'){ const b=await body(req); if(b.format) setup.format=b.format; if('firstSeat' in b) setup.firstSeat=b.firstSeat||null;
      if(b.seats) for(const s of b.seats){ const t=setup.seats.find(x=>x.seat===s.seat); if(!t) continue; for(const k of ['enabled','name','controller']) if(k in s) t[k]=s[k]; if(s.clearDeck) t.deck=null; }
      persist(); return send(res,200,publicSetup()); }
    if(p==='/api/deck' && req.method==='POST'){ const b=await body(req); const t=setup.seats.find(x=>x.seat===+b.seat); if(!t) throw new Error('Bad seat');
      let deck; if(b.url) deck=await importArchidekt(b.url); else { const entries=parseDeckText(b.text||''); if(!entries.length) throw new Error('No cards found in that text.'); const missing=await resolveEntries(entries); deck=buildDeck(entries,b.name||'Pasted deck','text'); deck.missing=[...new Set(deck.missing.concat(missing))]; }
      t.deck=deck; persist(); return send(res,200,{ok:true,seat:t.seat,deck:deckSummary(deck)}); }
    if(p==='/api/start' && req.method==='POST'){ const b=await body(req); if(b.format) setup.format=b.format; history=[]; game=E.newGame(setup,db); persist(); return send(res,200,{ok:true}); }
    if(p==='/api/endgame' && req.method==='POST'){ if(game) wr('last-game.json',game); game=null; try{ fs.unlinkSync(path.join(DATA,'game.json')); }catch{} try{ for(const f of fs.readdirSync(path.join(DATA,'views'))) fs.unlinkSync(path.join(DATA,'views',f)); }catch{} persist(); return send(res,200,{ok:true}); }
    if(p==='/api/rulings'){ const id=q.id; if(rulingsCache[id]) return send(res,200,rulingsCache[id]); const r=await sf(`https://api.scryfall.com/cards/${encodeURIComponent(id)}/rulings`); const j=await r.json(); const out=(j.data||[]).map(x=>({date:x.published_at,text:x.comment,source:x.source})); rulingsCache[id]=out; wr('rulings.json',rulingsCache); return send(res,200,out); }
    if(p==='/api/tokens'){ const qq=(q.q||'').trim(); const ptm=qq.match(/^(\d+)\/(\d+)\s*(.*)$/); const nq=ptm?`power=${ptm[1]} toughness=${ptm[2]} ${ptm[3]?'name:'+JSON.stringify(ptm[3]):''}`:(qq?'name:'+JSON.stringify(qq):'');
      let r=await sf('https://api.scryfall.com/cards/search?unique=cards&order=released&dir=desc&q='+encodeURIComponent('t:token '+nq)); if(!r.ok) r=await sf('https://api.scryfall.com/cards/search?unique=cards&q='+encodeURIComponent('t:token '+qq)); if(!r.ok) return send(res,200,[]); const j=await r.json();
      const data=(j.data||[]).sort((a,b)=>(E.norm(b.name)===E.norm(qq))-(E.norm(a.name)===E.norm(qq))); const out=data.slice(0,40).map(c=>{ const s=remember(c); return {id:s.id,name:s.name,type:s.type_line,pt:s.power!==undefined?`${s.power}/${s.toughness}`:'',text:s.oracle_text,image:s.image}; }); saveDb(); return send(res,200,out); }
    if(p==='/api/carddata'){ const ids=String(q.ids||'').split(',').filter(Boolean); const out={}; for(const id of ids) if(db[id]) out[id]=db[id]; return send(res,200,out); }
    if(p==='/api/addcard' && req.method==='POST'){ const b=await body(req); const c=await fuzzy(b.name); if(!c) throw new Error('Card not found on Scryfall.'); saveDb(); const seat=+b.seat; const S=game.seats[seat]; const iid='c'+(game.nextId++); game.cards[iid]={iid,id:c.id,owner:seat,controller:seat,seat,zone:b.zone||'hand',tapped:false,faceDown:false,faceIndex:0,counters:{},attacking:null,blocking:null,revealed:false,token:false,isCommander:false}; S.zones[b.zone||'hand'].push(iid); game.log.push({n:game.log.length+1,t:new Date().toISOString(),seat,text:`${S.name} adds ${c.name} to ${b.zone||'hand'} (manual).`,vis:null}); game.v++; persist(); return send(res,200,{ok:true}); }
    // static
    let f=p==='/'?'/index.html':p; if(f==='/README.md'||f==='/README') return send(res,200,fs.readFileSync(path.join(DIR,'README.md'),'utf8'),MIME['.md']);
    const fp=path.join(PUB,path.normalize(f).replace(/^(\.\.[\/\\])+/,'')); if(!fp.startsWith(PUB)||!fs.existsSync(fp)) return send(res,404,'Not found');
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream','Cache-Control':'no-store'}); fs.createReadStream(fp).pipe(res);
  }catch(e){ send(res,400,{error:e.message}); }
};
const server=http.createServer(handler);
function deckSummary(d){ if(!d) return null; return {name:d.name,source:d.source,count:d.count,commander:d.preview.commander,main:d.preview.main,sideboard:d.preview.sideboard,missing:d.missing}; }
function publicSetup(){ return {format:setup.format, firstSeat:setup.firstSeat, formats:Object.fromEntries(Object.entries(E.FORMATS).map(([k,v])=>[k,v.label])), seats:setup.seats.map(s=>({seat:s.seat,enabled:s.enabled,name:s.name,controller:s.controller,deck:deckSummary(s.deck)}))}; }
if(!process.env.MTG_NO_LOCAL) server.listen(PORT,'127.0.0.1',()=>console.log(`MTG VTT running on http://localhost:${PORT}`));

module.exports={handler,ctx:{get game(){return game;},get db(){return db;},get setup(){return setup;},get history(){return history;}},api:{importDeckText,importDeckUrl,configure,startGame,endGame,undo,runPrepared,rulingsFor,cardLookup,tokenSearch,publicSetup,deckSummary}};
