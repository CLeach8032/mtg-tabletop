// MTG VTT game engine: pure state + actions. Seats are numbered 1-4 everywhere.
'use strict';
const crypto = require('crypto');

const PHASES = ['Untap','Upkeep','Draw','Main 1','Begin Combat','Declare Attackers','Declare Blockers','Combat Damage','End of Combat','Main 2','End Step','Cleanup'];
const FORMATS = {
  commander:   {label:'Commander (EDH)', life:40, cmd:true, cmdDmg:21, freeMull:true},
  brawl:       {label:'Brawl', life:25, lifeMulti:30, cmd:true, cmdDmg:0, freeMull:true},
  oathbreaker: {label:'Oathbreaker', life:20, cmd:true, cmdDmg:0, freeMull:true},
  pdh:         {label:'Pauper Commander (PDH)', life:30, cmd:true, cmdDmg:16, freeMull:true},
  standard:    {label:'Standard', life:20},
  pioneer:     {label:'Pioneer', life:20},
  modern:      {label:'Modern', life:20},
  legacy:      {label:'Legacy', life:20},
  vintage:     {label:'Vintage', life:20},
  pauper:      {label:'Pauper', life:20},
  historic:    {label:'Historic', life:20},
  timeless:    {label:'Timeless', life:20},
  premodern:   {label:'Premodern', life:20},
  freeform:    {label:'Casual / Freeform', life:20, cmd:true, cmdDmg:0},
};
const ZONES = ['library','hand','battlefield','graveyard','exile','command','sideboard'];
const PLAYER_COUNTERS = ['poison','energy','experience','rad','tickets'];

function rint(n){ return crypto.randomInt(n); }
function shuffleArr(a){ for(let i=a.length-1;i>0;i--){const j=rint(i+1);[a[i],a[j]]=[a[j],a[i]];} return a; }
const clone = o => JSON.parse(JSON.stringify(o));
const norm = s => String(s||'').toLowerCase().replace(/[’']/g,"'").replace(/\s+/g,' ').trim();

// ---------- card helpers ----------
function face(g, db, c){ const d=db[c.id]||{}; if(d.faces&&d.faces.length&&d.faces[c.faceIndex||0]) return {...d, ...d.faces[c.faceIndex||0], image:(d.faces[c.faceIndex||0].image||d.image)}; return d; }
function cname(g, db, c){ if(!c) return '?'; if(c.custom) return c.custom.name; const f=face(g,db,c); return f.name||(db[c.id]||{}).name||'?'; }
function ctype(g, db, c){ if(c.custom) return c.custom.type||'Token'; return face(g,db,c).type_line||''; }
function ctext(g, db, c){ if(c.custom) return c.custom.text||''; return face(g,db,c).oracle_text||''; }
function isPermanentType(t){ return /\b(Land|Creature|Artifact|Enchantment|Planeswalker|Battle)\b/.test(t) && !/\b(Instant|Sorcery)\b/.test(t.split('//')[0]); }
function basePT(g, db, c){ if(c.custom) return [c.custom.power, c.custom.toughness]; const f=face(g,db,c); return [f.power, f.toughness]; }
function ptOf(g, db, c){
  const [p,t]=basePT(g,db,c); if(p===undefined||p===null) return null;
  const plus=(c.counters['+1/+1']||0)-(c.counters['-1/-1']||0);
  const num=x=>{const n=parseInt(x,10); return isNaN(n)?0:n;};
  return [num(p)+plus+(c.ptMod?c.ptMod[0]:0), num(t)+plus+(c.ptMod?c.ptMod[1]:0)];
}
function displayName(g,db,c,viewer){ if(c.faceDown && viewer!==c.controller) return 'Face-down card'; return cname(g,db,c); }

// ---------- game creation ----------
function newGame(setup, db){
  const fmtKey = FORMATS[setup.format] ? setup.format : 'commander';
  const fmt = FORMATS[fmtKey];
  const active = setup.seats.filter(s=>s.enabled && s.deck && s.deck.main && (s.deck.main.length||s.deck.commander.length));
  if(active.length<1) throw new Error('Load at least one deck first.');
  const life = (fmt.lifeMulti && active.length>2) ? fmt.lifeMulti : fmt.life;
  const g = { v:1, n:1, created:new Date().toISOString(), format:fmtKey, stage:'mulligan', turn:0, activeSeat:null, phase:'Mulligan',
    startingLife:life, autoDraw:true, autoUntap:true, commanderRedirect:true,
    seats:{}, cards:{}, stack:[], log:[], nextId:1, cmdCasts:{}, firstSeat:null, shuffledAt:{}, dice:[] };
  for(const s of setup.seats){
    if(!active.includes(s)) continue;
    const seat = { seat:s.seat, name:s.name||('Seat '+s.seat), controller:s.controller||'bot', life, counters:{}, cmdDamage:{}, mulligans:0, kept:false, lost:false, conceded:false, deckName:s.deck.name||'', peek:[], zones:{} };
    for(const z of ZONES) seat.zones[z]=[];
    g.seats[s.seat]=seat;
    const mk=(id,zone,extra)=>{ const iid='c'+(g.nextId++); g.cards[iid]={iid,id,owner:s.seat,controller:s.seat,seat:s.seat,zone,tapped:false,faceDown:false,faceIndex:0,counters:{},attacking:null,blocking:null,revealed:false,token:false,isCommander:false,...(extra||{})}; seat.zones[zone].push(iid); return iid; };
    for(const e of s.deck.main) for(let i=0;i<e.qty;i++) mk(e.id,'library');
    for(const id of (s.deck.commander||[])){ if(fmt.cmd) mk(id,'command',{isCommander:true}); else mk(id,'library'); }
    for(const e of (s.deck.sideboard||[])) for(let i=0;i<e.qty;i++) mk(e.id,'sideboard');
    shuffleArr(seat.zones.library);
  }
  const seatNos = Object.keys(g.seats).map(Number).sort((a,b)=>a-b);
  g.firstSeat = setup.firstSeat && g.seats[setup.firstSeat] ? Number(setup.firstSeat) : seatNos[rint(seatNos.length)];
  log(g, null, `New ${fmt.label} game. Starting life ${life}. Libraries shuffled.`);
  for(const n of seatNos){ drawCards(g, db, n, 7, true); }
  log(g, null, `Everyone draws 7. ${g.seats[g.firstSeat].name} (seat ${g.firstSeat}) will go first. Mulligan or keep.`);
  return g;
}

function log(g, seat, text, vis){ g.log.push({n:g.log.length+1, t:new Date().toISOString(), seat, text, vis: vis===undefined?null:vis}); if(g.log.length>2000) g.log.splice(0,g.log.length-2000); }

// ---------- zone movement ----------
function removeFromZone(g, c){
  if(c.zone==='stack'){ g.stack = g.stack.filter(x=>x!==c.iid); return; }
  const s=g.seats[c.seat]; if(!s) return; const arr=s.zones[c.zone]; const i=arr.indexOf(c.iid); if(i>=0) arr.splice(i,1);
  if(c.zone==='library'){ for(const st of Object.values(g.seats)) st.peek=st.peek.filter(x=>x!==c.iid); }
}
function moveCard(g, db, c, toZone, opts={}){
  const fmt=FORMATS[g.format];
  const from=c.zone, fromSeat=c.seat;
  if(c.isCommander && g.commanderRedirect && fmt.cmd && (toZone==='graveyard'||toZone==='exile') && !opts.noRedirect){ toZone='command'; opts.redirected=true; }
  // tokens cease to exist outside battlefield/stack
  if(c.token && from==='battlefield' && toZone!=='battlefield' && toZone!=='stack'){
    removeFromZone(g,c); delete g.cards[c.iid]; return {gone:true, from, to:toZone};
  }
  removeFromZone(g,c);
  if(toZone!=='battlefield'){ c.tapped=false; c.counters={}; c.attacking=null; c.blocking=null; c.ptMod=null; c.faceDown=!!opts.faceDown; if(!opts.keepFace) c.faceIndex=0; c.controller=c.owner; }
  if(from==='battlefield' && toZone==='battlefield'){ /* control change */ }
  c.revealed=false;
  if(toZone==='stack'){ c.zone='stack'; c.seat=c.controller; g.stack.push(c.iid); }
  else {
    let seatNo = toZone==='battlefield' ? (opts.toSeat||c.controller) : c.owner;
    if(toZone==='battlefield'){ c.controller=seatNo; if(opts.tapped) c.tapped=true; if(opts.faceDown) c.faceDown=true; c.enteredTurn=g.turn; }
    const arr=g.seats[seatNo].zones[toZone];
    if(toZone==='library'){
      if(opts.position==='bottom') arr.push(c.iid);
      else if(typeof opts.position==='number') arr.splice(Math.max(0,Math.min(arr.length,opts.position)),0,c.iid);
      else arr.unshift(c.iid);
    } else arr.push(c.iid);
    c.zone=toZone; c.seat=seatNo;
    if(toZone==='library' && opts.position==='shuffle') shuffleLibrary(g, seatNo, 'card shuffled into library');
  }
  return {from, fromSeat, to:toZone, redirected:opts.redirected};
}
function shuffleLibrary(g, seatNo, why){ const s=g.seats[seatNo]; shuffleArr(s.zones.library); s.peek=[]; g.shuffledAt[seatNo]=g.n; log(g, seatNo, `${s.name}'s library was shuffled${why?' ('+why+')':''}.`); }
function drawCards(g, db, seatNo, n, quiet){
  const s=g.seats[seatNo]; let drawn=[];
  for(let i=0;i<n;i++){ const iid=s.zones.library[0]; if(!iid){ log(g, seatNo, `${s.name} tried to draw from an empty library!`); break; } const c=g.cards[iid]; moveCard(g,db,c,'hand'); drawn.push(iid); }
  if(!quiet && drawn.length){ log(g, seatNo, `${s.name} draws ${drawn.length} card${drawn.length>1?'s':''}.`); log(g, seatNo, `You drew: ${drawn.map(i=>cname(g,db,g.cards[i])).join(', ')}`, seatNo); }
  return drawn;
}

// ---------- reference resolution ----------
function findPlayer(g, ref, me){
  if(ref===undefined||ref===null||ref==='') return me;
  if(typeof ref==='number') return g.seats[ref]?ref:null;
  const r=norm(ref).replace(/^(seat|player|p)\s*/,'');
  if(r==='me'||r==='self'||r==='myself'||r==='you') return me;
  if(/^\d+$/.test(r)) return g.seats[+r]?+r:null;
  for(const s of Object.values(g.seats)) if(norm(s.name)===r) return s.seat;
  for(const s of Object.values(g.seats)) if(norm(s.name).startsWith(r)) return s.seat;
  return null;
}
function zoneList(g, seatNo, zone){ return zone==='stack'? g.stack : (g.seats[seatNo]?g.seats[seatNo].zones[zone]:[]); }
// find card by iid or name. zones: array of [seat|'any', zone]
function findCard(g, db, me, ref, searchOrder, host){
  if(!ref) throw new Error('No card given.');
  ref=String(ref).trim().replace(/^\[|\]$/g,'');
  const pub=['battlefield','graveyard','exile','command','stack'];
  const allowed=c=>{ if(host) return true; if(pub.includes(c.zone)) return true; return c.seat===me; };
  if(/^c\d+$/i.test(ref)){ const c=g.cards[ref.toLowerCase()]; if(!c) throw new Error(`No card ${ref}.`); if(!allowed(c)) throw new Error(`Card ${ref} is in a hidden zone you can't access.`); if(!searchOrder.some(([s,z])=>z===c.zone && (s==='any'||s===c.seat))) throw new Error(`${cname(g,db,c)} [${c.iid}] is in ${c.zone==='stack'?'the stack':g.seats[c.seat].name+"'s "+c.zone}, not where this action looks (${[...new Set(searchOrder.map(x=>x[1]))].join('/')}).`); return c; }
  const r=norm(ref);
  const matches=(c,loose)=>{ const n=norm(cname(g,db,c)); const full=norm((db[c.id]||{}).name||n); if(n===r||full===r||full.split(' // ').includes(r)) return true; return loose && (n.startsWith(r)||full.includes(r)); };
  for(const loose of [false,true]){
    for(const [s,z] of searchOrder){
      const seats = s==='any'? Object.keys(g.seats).map(Number).sort((a,b)=>(a===me?-1:b===me?1:a-b)) : [s];
      for(const sn of seats){ const list=zoneList(g,sn,z).slice(); if(z==='stack') list.reverse(); for(const iid of list){ const c=g.cards[iid]; if(c && matches(c,loose) && allowed(c)) return c; } }
    }
  }
  throw new Error(`Couldn't find "${ref}" in ${[...new Set(searchOrder.map(x=>x[1]))].join('/')}.`);
}
function splitCards(g, db, me, str, order, host){
  try { return [findCard(g,db,me,str,order,host)]; } catch(e) {
    const parts=String(str).split(/\s*(?:,|;|\band\b)\s*/).filter(Boolean); if(parts.length<2) throw e;
    return parts.map(p=>findCard(g,db,me,p,order,host));
  }
}

// ---------- actions ----------
const ZONE_ALIASES={gy:'graveyard',grave:'graveyard',graveyard:'graveyard',yard:'graveyard',bf:'battlefield',battlefield:'battlefield',field:'battlefield',play:'battlefield',board:'battlefield',hand:'hand',library:'library',lib:'library',deck:'library',exile:'exile',exiled:'exile',command:'command','command zone':'command',cz:'command',stack:'stack',sideboard:'sideboard',sb:'sideboard'};
function zoneName(z){ const k=norm(z).replace(/^the\s+/,''); return ZONE_ALIASES[k]||null; }

function powerStr(g,db,c){ const pt=ptOf(g,db,c); return pt?` ${pt[0]}/${pt[1]}`:''; }
function checkLoss(g, seatNo){
  const s=g.seats[seatNo], fmt=FORMATS[g.format]; const msgs=[];
  if(s.life<=0) msgs.push(`life is ${s.life}`);
  if((s.counters.poison||0)>=10) msgs.push(`${s.counters.poison} poison counters`);
  if(fmt.cmdDmg) for(const [k,v] of Object.entries(s.cmdDamage)) if(v>=fmt.cmdDmg) msgs.push(`${v} commander damage from ${k}`);
  if(msgs.length && !s.lost){ s.lost=true; log(g,null,`⚠ ${s.name} has lost the game (${msgs.join(', ')}).`); }
  if(!msgs.length && s.lost && !s.conceded) s.lost=false;
}

function apply(g, db, me, a, opts={}){
  const host=!!opts.host;
  if(!g.seats[me]) throw new Error(`Seat ${me} is not in this game.`);
  const S=g.seats[me], N=S.name;
  const fmt=FORMATS[g.format];
  const own=[[me,'hand'],[me,'battlefield'],[me,'command'],[me,'graveyard'],[me,'exile'],[me,'stack']];
  const type=String(a.type||'').toLowerCase();
  const out=[];
  if(['next','phase','pass'].includes(type) && !host && g.stage==='play' && g.activeSeat!==me) throw new Error(`It's ${g.seats[g.activeSeat].name}'s turn (seat ${g.activeSeat}); only the active player can advance the phase or pass.`);
  const say=t=>{ log(g,me,t); out.push(t); };
  switch(type){
    case 'draw': drawCards(g,db,me,Math.max(1,parseInt(a.n||1,10))); out.push(`Drew ${a.n||1}.`); break;
    case 'play': case 'cast': {
      const fz=a.from?zoneName(a.from):null; const c=findCard(g,db,me,a.card,fz?[[me,fz]]:[[me,'hand'],[me,'command'],[me,'graveyard'],[me,'exile']],host);
      const t=ctype(g,db,c); const fromCmd=c.zone==='command';
      if(fromCmd && c.isCommander){ g.cmdCasts[c.iid]=(g.cmdCasts[c.iid]||0)+1; }
      const tax = fromCmd&&c.isCommander ? ` (commander tax paid: {${2*((g.cmdCasts[c.iid]||1)-1)}})` : '';
      if(a.face!==undefined) c.faceIndex=+a.face;
      const fromLib=c.zone==='library' && zoneList(g,me,'library')[0]!==c.iid;
      if(type==='play' && /\bLand\b/.test(t)){ moveCard(g,db,c,'battlefield',{tapped:a.tapped,keepFace:true}); say(`${N} plays ${cname(g,db,c)}${a.tapped?' tapped':''}.`); }
      else if(type==='play' && isPermanentType(t)){ moveCard(g,db,c,'battlefield',{tapped:a.tapped,keepFace:true,faceDown:a.faceDown}); say(`${N} casts ${cname(g,db,c)}${tax} — it enters the battlefield${a.tapped?' tapped':''}.`); }
      else { moveCard(g,db,c,'stack',{keepFace:true}); c.castShuffleMark=g.shuffledAt[me]||0; say(`${N} casts ${cname(g,db,c)}${tax}${a.target?' targeting '+a.target:''} — on the stack.`); }
      if(fromLib) shuffleLibrary(g,me,'card taken from library');
      break; }
    case 'resolve': {
      const iid=a.card? findCard(g,db,me,a.card,[[ 'any','stack']],true).iid : g.stack[g.stack.length-1];
      if(!iid) throw new Error('The stack is empty.');
      const c=g.cards[iid]; const t=ctype(g,db,c); const name=cname(g,db,c);
      if(c.copy){ removeFromZone(g,c); delete g.cards[iid]; say(`${name} (copy) resolves.`); break; }
      if(isPermanentType(t)){ moveCard(g,db,c,'battlefield',{keepFace:true}); say(`${name} resolves and enters the battlefield under ${g.seats[c.controller].name}'s control.`); }
      else { const ctl=c.controller; moveCard(g,db,c, a.to?zoneName(a.to)||'graveyard':'graveyard'); say(`${name} resolves.`);
        const txt=ctext(g,db,{...c}); if(/shuffle/i.test(txt) && !/may shuffle/i.test(txt) && (g.shuffledAt[ctl]||0) <= (c.castShuffleMark||0)) shuffleLibrary(g,ctl,`${name} says shuffle`); }
      break; }
    case 'counterspell': case 'fizzle': { const c=a.card?findCard(g,db,me,a.card,[['any','stack']],true):g.cards[g.stack[g.stack.length-1]]; if(!c) throw new Error('Stack empty.'); moveCard(g,db,c,'graveyard'); say(`${cname(g,db,c)} is countered.`); break; }
    case 'tap': case 'untap': {
      if(type==='untap' && (a.all || norm(a.card)==='all')){ for(const iid of S.zones.battlefield) g.cards[iid].tapped=false; say(`${N} untaps all permanents.`); break; }
      const cs=splitCards(g,db,me,a.card,[[me,'battlefield'],['any','battlefield']],host);
      for(const c of cs) c.tapped=(type==='tap');
      say(`${N} ${type}s ${cs.map(c=>displayName(g,db,c)).join(', ')}.`); break; }
    case 'attack': {
      const tgt=findPlayer(g,a.target,null); if(!tgt) throw new Error(`Unknown attack target "${a.target}". Use a seat number or name.`);
      const cs=splitCards(g,db,me,a.card,[[me,'battlefield']],host);
      for(const c of cs){ c.attacking=tgt; if(!/vigilance/i.test(ctext(g,db,c))) c.tapped=true; c.blockedBy=[]; }
      if(g.phase!=='Declare Attackers' && g.stage==='play' && g.activeSeat===me) g.phase='Declare Attackers';
      say(`${N} attacks ${g.seats[tgt].name} with ${cs.map(c=>cname(g,db,c)+powerStr(g,db,c)).join(', ')}.`); break; }
    case 'unattack': { const cs=splitCards(g,db,me,a.card,[[me,'battlefield']],host); for(const c of cs){c.attacking=null;c.tapped=false;} say(`${N} removes ${cs.map(c=>cname(g,db,c)).join(', ')} from combat.`); break; }
    case 'block': {
      const b=findCard(g,db,me,a.card,[[me,'battlefield']],host);
      const att=findCard(g,db,me,a.attacker,[['any','battlefield']],true);
      if(att.attacking===null||att.attacking===undefined) throw new Error(`${cname(g,db,att)} isn't attacking.`);
      b.blocking=att.iid; att.blockedBy=(att.blockedBy||[]).concat(b.iid);
      say(`${N} blocks ${cname(g,db,att)}${powerStr(g,db,att)} with ${cname(g,db,b)}${powerStr(g,db,b)}.`); break; }
    case 'combatdamage': {
      const lines=[];
      for(const c of Object.values(g.cards)){
        if(c.zone!=='battlefield' || !c.attacking) continue;
        const pt=ptOf(g,db,c); const p=pt?Math.max(0,pt[0]):0; const tgt=g.seats[c.attacking]; if(!tgt) continue;
        const txt=ctext(g,db,c);
        if(c.blockedBy && c.blockedBy.length){ const bl=c.blockedBy.map(i=>g.cards[i]).filter(Boolean); lines.push(`${cname(g,db,c)} (${pt?pt.join('/'):'?'}) is blocked by ${bl.map(b=>cname(g,db,b)+powerStr(g,db,b)).join(', ')} — resolve creature damage manually.`);
          if(/trample/i.test(txt)){ const tough=bl.reduce((s,b)=>s+Math.max(0,(ptOf(g,db,b)||[0,0])[1]),0); const ex=p-tough; if(ex>0){ tgt.life-=ex; lines.push(`Trample: ${ex} damage tramples over to ${tgt.name}.`);} }
          continue; }
        if(p<=0) continue;
        if(/\binfect\b/i.test(txt)){ tgt.counters.poison=(tgt.counters.poison||0)+p; lines.push(`${cname(g,db,c)} deals ${p} infect damage to ${tgt.name} (poison now ${tgt.counters.poison}).`); }
        else { tgt.life-=p; lines.push(`${cname(g,db,c)} deals ${p} damage to ${tgt.name} (life ${tgt.life}).`); }
        const tox=txt.match(/toxic (\d+)/i); if(tox){ tgt.counters.poison=(tgt.counters.poison||0)+(+tox[1]); lines.push(`Toxic: ${tgt.name} gets ${tox[1]} poison.`); }
        if(c.isCommander && fmt.cmdDmg){ const key=cname(g,db,c)+' ('+g.seats[c.owner].name+')'; tgt.cmdDamage[key]=(tgt.cmdDamage[key]||0)+p; lines.push(`Commander damage from ${cname(g,db,c)} to ${tgt.name}: ${tgt.cmdDamage[key]}.`); }
        if(/lifelink/i.test(txt)){ g.seats[c.controller].life+=p; lines.push(`Lifelink: ${g.seats[c.controller].name} gains ${p}.`); }
      }
      if(!lines.length) lines.push('No combat damage dealt.');
      for(const l of lines) say(l);
      for(const s of Object.values(g.seats)) checkLoss(g,s.seat);
      if(g.stage==='play') g.phase='Combat Damage';
      break; }
    case 'damage': case 'life': case 'setlife': {
      const tgt=findPlayer(g,a.target,me); if(!tgt) throw new Error(`Unknown player "${a.target}".`);
      const T=g.seats[tgt];
      if(type==='setlife'){ T.life=parseInt(a.amount,10); say(`${T.name}'s life is set to ${T.life}.`); }
      else if(type==='damage'){ const n=Math.abs(parseInt(a.amount,10)); T.life-=n; let src='';
        if(a.source){ const sc=findCard(g,db,me,a.source,[[me,'battlefield'],[me,'stack'],['any','battlefield'],['any','stack'],[me,'graveyard'],[me,'command']],host); src=' from '+cname(g,db,sc);
          if(a.commander || (sc.isCommander && a.combat)){ const key=cname(g,db,sc)+' ('+g.seats[sc.owner].name+')'; T.cmdDamage[key]=(T.cmdDamage[key]||0)+n; }
          if(/lifelink/i.test(ctext(g,db,sc))) { g.seats[sc.controller].life+=n; say(`Lifelink: ${g.seats[sc.controller].name} gains ${n}.`); } }
        say(`${T.name} takes ${n} damage${src} (life ${T.life}).`); }
      else { const n=parseInt(a.amount,10); T.life+=n; say(`${T.name} ${n>=0?'gains':'loses'} ${Math.abs(n)} life (life ${T.life}).`); }
      checkLoss(g,tgt); break; }
    case 'cmddamage': { const tgt=findPlayer(g,a.target,me); const T=g.seats[tgt]; const key=a.from; T.cmdDamage[key]=Math.max(0,(T.cmdDamage[key]||0)+parseInt(a.amount,10)); if(!T.cmdDamage[key]) delete T.cmdDamage[key]; say(`${T.name} commander damage from ${key}: ${T.cmdDamage[key]||0}.`); checkLoss(g,tgt); break; }
    case 'playercounter': {
      const tgt=findPlayer(g,a.target,me); if(!tgt) throw new Error(`Unknown player "${a.target}".`); const T=g.seats[tgt]; const k=norm(a.kind);
      T.counters[k]=Math.max(0,(T.counters[k]||0)+parseInt(a.amount,10)); if(!T.counters[k]) delete T.counters[k];
      say(`${T.name} now has ${T.counters[k]||0} ${k} counter${(T.counters[k]||0)===1?'':'s'}.`); checkLoss(g,tgt); break; }
    case 'counter': {
      const cs=splitCards(g,db,me,a.card,[[me,'battlefield'],['any','battlefield']],host); const k=a.kind||'+1/+1'; const n=parseInt(a.amount===undefined?1:a.amount,10);
      for(const c of cs){ c.counters[k]=(c.counters[k]||0)+n;
        if(c.counters['+1/+1']&&c.counters['-1/-1']){ const m=Math.min(c.counters['+1/+1'],c.counters['-1/-1']); c.counters['+1/+1']-=m; c.counters['-1/-1']-=m; }
        for(const kk of Object.keys(c.counters)) if(c.counters[kk]<=0) delete c.counters[kk]; }
      say(`${cs.map(c=>cname(g,db,c)).join(', ')}: ${n>=0?'+':''}${n} ${k} counter${Math.abs(n)===1?'':'s'}.`); break; }
    case 'pt': { const c=findCard(g,db,me,a.card,[[me,'battlefield'],['any','battlefield']],host); c.ptMod=[parseInt(a.power||0,10),parseInt(a.toughness||0,10)]; if(!c.ptMod[0]&&!c.ptMod[1]) c.ptMod=null; say(`${cname(g,db,c)} gets a P/T modifier of ${a.power>=0?'+':''}${a.power||0}/${a.toughness>=0?'+':''}${a.toughness||0} (now${powerStr(g,db,c)}).`); break; }
    case 'token': {
      const n=Math.max(1,Math.min(50,parseInt(a.count||1,10)));
      if(!a.id && !a.custom) throw new Error('Token not resolved.');
      const made=[];
      for(let i=0;i<n;i++){ const iid='c'+(g.nextId++); g.cards[iid]={iid,id:a.id||null,custom:a.custom||null,owner:me,controller:me,seat:me,zone:'battlefield',tapped:!!a.tapped,faceDown:false,faceIndex:0,counters:{},attacking:null,blocking:null,revealed:false,token:true,isCommander:false,enteredTurn:g.turn}; S.zones.battlefield.push(iid); made.push(iid); }
      say(`${N} creates ${n} ${cname(g,db,g.cards[made[0]])} token${n>1?'s':''}${a.tapped?' (tapped)':''}.`); break; }
    case 'copy': { const src=findCard(g,db,me,a.card,[['any','battlefield'],['any','stack']],true); const iid='c'+(g.nextId++); const c={...clone(src),iid,owner:me,controller:me,token:true,isCommander:false,counters:{},tapped:false,attacking:null,blocking:null};
      if(src.zone==='stack'){ c.copy=true; c.zone='stack'; c.seat=me; g.stack.push(iid);} else { c.zone='battlefield'; c.seat=me; S.zones.battlefield.push(iid); }
      g.cards[iid]=c; say(`${N} creates a copy of ${cname(g,db,src)}.`); break; }
    case 'move': {
      const to=zoneName(a.to); if(!to) throw new Error(`Unknown zone "${a.to}". Zones: hand, library, battlefield, graveyard, exile, command, stack, sideboard.`);
      let order=own.concat([[me,'library'],[me,'sideboard'],['any','battlefield'],['any','stack'],['any','graveyard'],['any','exile']]);
      if(a.from){ const fz=zoneName(a.from); if(!fz) throw new Error(`Unknown zone "${a.from}".`); order=[[me,fz],['any',fz]]; }
      const cs=splitCards(g,db,me,a.card,order,host);
      const pos=a.position||(to==='library'?'top':undefined);
      for(const c of cs){
        const wasLib=c.zone==='library'; const wasTop=wasLib && (zoneList(g,c.seat,'library')[0]===c.iid || g.seats[c.seat].peek.includes(c.iid));
        const libSeat=c.seat; const nm=(c.zone==='hand'||c.zone==='library')&&to!=='battlefield'&&to!=='graveyard'&&to!=='exile'&&to!=='stack'&&!c.revealed ? 'a card' : cname(g,db,c);
        const fromZ=c.zone;
        const toSeat = to==='battlefield' ? (findPlayer(g,a.toPlayer,null) || (c.zone==='battlefield'?c.controller:me)) : undefined;
        const r=moveCard(g,db,c,to,{position:pos,tapped:a.tapped,faceDown:a.faceDown,toSeat});
        const posTxt = to==='library' ? (pos==='bottom'?' (bottom)':pos==='shuffle'?' (shuffled in)':' (top)') : '';
        say(`${N} moves ${nm} from ${fromZ} to ${r.redirected?'command zone (commander redirect)':(r.gone?to+' — token ceases to exist':to)}${posTxt}${a.tapped?' tapped':''}.`);
        if(nm==='a card') log(g,me,`(private) That card was ${cname(g,db,c)}.`,me);
        if(wasLib && !wasTop && !a.noShuffle) shuffleLibrary(g,libSeat,'searched library');
      }
      break; }
    case 'search': {
      const c=findCard(g,db,me,a.card,[[me,'library']],host);
      const to=zoneName(a.to||'hand')||'hand';
      moveCard(g,db,c,to,{tapped:a.tapped});
      if(to==='hand' && !a.reveal){ say(`${N} searches their library and puts a card into their hand.`); log(g,me,`(private) You found ${cname(g,db,c)}.`,me); }
      else say(`${N} searches their library for ${cname(g,db,c)} and puts it onto the ${to==='battlefield'?'battlefield':to}${a.tapped?' tapped':''}.`);
      shuffleLibrary(g,me,'after search'); break; }
    case 'mill': { const n=parseInt(a.n||1,10); const tgt=findPlayer(g,a.target,me); const T=g.seats[tgt]; const names=[]; for(let i=0;i<n && T.zones.library.length;i++){ const c=g.cards[T.zones.library[0]]; moveCard(g,db,c,'graveyard'); names.push(cname(g,db,c)); } say(`${T.name} mills ${names.length}: ${names.join(', ')||'nothing'}.`); break; }
    case 'look': case 'scry': case 'surveil': { const n=parseInt(a.n||1,10); S.peek=S.zones.library.slice(0,n); say(`${N} ${type==='look'?'looks at':type+'s'} the top ${S.peek.length} card${S.peek.length===1?'':'s'} of their library.`); log(g,me,`(private) Top of library: ${S.peek.map((i,k)=>`${k+1}. ${cname(g,db,g.cards[i])} [${i}]`).join(', ')}`,me); out.push('Peek: '+S.peek.map(i=>cname(g,db,g.cards[i])+' ['+i+']').join(', ')); break; }
    case 'top': case 'bottom': {
      const cs=splitCards(g,db,me,a.card,[[me,'library'],[me,'hand']],host);
      for(const c of cs){ const keep=S.peek.slice(); if(c.zone==='library'){ removeFromZone(g,c); } else moveCard(g,db,c,'library'); 
        // removeFromZone cleared peek; restore others
        S.peek=keep.filter(x=>x!==c.iid);
        const arr=S.zones.library; const i=arr.indexOf(c.iid); if(i>=0) arr.splice(i,1);
        if(type==='top') arr.unshift(c.iid); else arr.push(c.iid); c.zone='library'; c.seat=me; }
      say(`${N} puts ${cs.length} card${cs.length>1?'s':''} on the ${type} of their library.`); break; }
    case 'done': S.peek=[]; out.push('Stopped looking at library.'); break;
    case 'reveal': {
      if(norm(a.card)==='hand'){ for(const iid of S.zones.hand) g.cards[iid].revealed=true; say(`${N} reveals their hand: ${S.zones.hand.map(i=>cname(g,db,g.cards[i])).join(', ')||'(empty)'}.`); break; }
      if(norm(a.card)==='top'){ const c=g.cards[S.zones.library[0]]; if(c) say(`${N} reveals the top card of their library: ${cname(g,db,c)}.`); break; }
      const c=findCard(g,db,me,a.card,[[me,'hand'],[me,'library'],[me,'battlefield']],host); c.revealed=true; say(`${N} reveals ${cname(g,db,c)}.`); break; }
    case 'shuffle': { const tgt=findPlayer(g,a.target,me); shuffleLibrary(g,tgt,a.why||'shuffle'); out.push('Shuffled.'); break; }
    case 'shufflegraveyard': { for(const iid of S.zones.graveyard.slice()) moveCard(g,db,g.cards[iid],'library'); shuffleLibrary(g,me,'graveyard shuffled into library'); break; }
    case 'mulligan': {
      if(S.kept) throw new Error('You already kept your hand.');
      for(const iid of S.zones.hand.slice()) moveCard(g,db,g.cards[iid],'library');
      shuffleLibrary(g,me,'mulligan'); S.mulligans++; drawCards(g,db,me,7,true);
      const free=fmt.freeMull&&Object.keys(g.seats).length>2?1:0; const toBottom=Math.max(0,S.mulligans-free);
      say(`${N} mulligans (mulligan #${S.mulligans}). They draw 7 and will put ${toBottom} on the bottom when they keep.`);
      log(g,me,`(private) New hand: ${S.zones.hand.map(i=>cname(g,db,g.cards[i])).join(', ')}`,me); break; }
    case 'keep': {
      if(S.kept) throw new Error('Already kept.');
      const free=fmt.freeMull&&Object.keys(g.seats).length>2?1:0; const need=Math.max(0,S.mulligans-free);
      let bottoms=[]; if(need){ if(!a.bottom) throw new Error(`Choose ${need} card(s) to put on the bottom: keep bottom <card>, <card>`);
        const refs=Array.isArray(a.bottom)?a.bottom:String(a.bottom).split(/\s*[,;]\s*/).filter(Boolean);
        if(refs.length!==need) throw new Error(`You must bottom exactly ${need} card(s).`);
        for(const r of refs){ const c=findCard(g,db,me,r,[[me,'hand']],host); if(bottoms.includes(c)) throw new Error('Same card twice.'); bottoms.push(c);} }
      for(const c of bottoms) moveCard(g,db,c,'library',{position:'bottom'});
      S.kept=true; say(`${N} keeps ${S.zones.hand.length} cards${need?` (put ${need} on the bottom)`:''}.`);
      if(Object.values(g.seats).every(s=>s.kept||s.conceded)) startPlay(g,db);
      break; }
    case 'startnow': if(g.stage==='mulligan'){ for(const s of Object.values(g.seats)) s.kept=true; startPlay(g,db); out.push('Game started.'); } break;
    case 'next': nextPhase(g,db); out.push('Phase: '+g.phase); break;
    case 'phase': { const p=PHASES.find(x=>norm(x)===norm(a.phase))||PHASES.find(x=>norm(x).startsWith(norm(a.phase))); if(!p) throw new Error('Unknown phase. Phases: '+PHASES.join(', ')); enterPhase(g,db,p); out.push('Phase: '+p); break; }
    case 'pass': passTurn(g,db); out.push(`Turn ${g.turn}: ${g.seats[g.activeSeat].name}.`); break;
    case 'roll': { const sides=Math.max(2,parseInt(a.sides||6,10)); const k=Math.max(1,Math.min(20,parseInt(a.count||1,10))); const rolls=[]; for(let i=0;i<k;i++) rolls.push(rint(sides)+1); say(`${N} rolls ${k}d${sides}: ${rolls.join(', ')}${k>1?' (total '+rolls.reduce((x,y)=>x+y,0)+')':''}.`); break; }
    case 'flip': case 'coin': say(`${N} flips a coin: ${rint(2)?'Heads':'Tails'}.`); break;
    case 'say': say(`${N}: "${String(a.text||'').slice(0,500)}"`); break;
    case 'transform': { const c=findCard(g,db,me,a.card,[[me,'battlefield'],['any','battlefield'],[me,'hand'],[me,'stack']],host); const d=db[c.id]||{}; if(!d.faces||d.faces.length<2) throw new Error(`${cname(g,db,c)} has no other face.`); const before=cname(g,db,c); c.faceIndex=((c.faceIndex||0)+1)%d.faces.length; say(`${before} transforms into ${cname(g,db,c)}.`); break; }
    case 'facedown': case 'faceup': { const c=findCard(g,db,me,a.card,[[me,'battlefield']],host); c.faceDown=(type==='facedown'); say(type==='facedown'?`${N} turns a permanent face down.`:`${N} turns ${cname(g,db,c)} face up.`); break; }
    case 'control': { const c=findCard(g,db,me,a.card,[['any','battlefield']],true); const to=findPlayer(g,a.target,me); removeFromZone(g,c); c.controller=to; c.seat=to; g.seats[to].zones.battlefield.push(c.iid); say(`${g.seats[to].name} gains control of ${cname(g,db,c)}.`); break; }
    case 'concede': S.conceded=true; S.lost=true; say(`${N} concedes.`); if(g.activeSeat===me && g.stage==='play') passTurn(g,db); break;
    case 'note': { const c=findCard(g,db,me,a.card,[[me,'battlefield'],['any','battlefield']],host); c.note=String(a.text||'').slice(0,80); say(`Note on ${cname(g,db,c)}: ${c.note||'(cleared)'}`); break; }
    case 'settings': { for(const k of ['autoDraw','autoUntap','commanderRedirect']) if(a[k]!==undefined) g[k]=!!a[k]; out.push('Settings updated.'); break; }
    default: throw new Error(`Unknown action "${a.type}". Send "help" for the action list.`);
  }
  return out;
}

function startPlay(g, db){ g.stage='play'; g.turn=1; g.activeSeat=g.firstSeat; log(g,null,`All hands kept. Turn 1 — ${g.seats[g.activeSeat].name}.`); enterPhase(g,db,'Untap'); nextPhase(g,db); }
function livingSeats(g){ return Object.values(g.seats).filter(s=>!s.conceded).map(s=>s.seat).sort((a,b)=>a-b); }
function enterPhase(g, db, p){
  g.phase=p; const s=g.seats[g.activeSeat]; if(!s) return;
  if(p==='Untap' && g.autoUntap){ for(const iid of s.zones.battlefield){ const c=g.cards[iid]; if(!c.noUntap) c.tapped=false; } log(g,s.seat,`${s.name} untaps.`); }
  if(p==='Draw' && g.autoDraw){ const skip = g.turn===1 && g.activeSeat===g.firstSeat && Object.keys(g.seats).length===2; if(skip) log(g,null,`${s.name} skips the first draw (2-player rule).`); else drawCards(g,db,s.seat,1); }
  if(p==='End of Combat'||p==='Cleanup'){ for(const c of Object.values(g.cards)){ c.attacking=null; c.blocking=null; c.blockedBy=[]; } }
  if(p==='Cleanup'){ if(s.zones.hand.length>7) log(g,s.seat,`${s.name} has ${s.zones.hand.length} cards in hand — discard down to 7 (unless no max hand size).`); for(const c of Object.values(g.cards)) if(c.ptMod && c.ptModEOT) c.ptMod=null; }
  if(p!=='Untap') log(g,null,`— ${p} (${s.name}) —`);
}
function nextPhase(g, db){ if(g.stage!=='play') return; const i=PHASES.indexOf(g.phase); if(i<0||i===PHASES.length-1) return passTurn(g,db); enterPhase(g,db,PHASES[i+1]); }
function passTurn(g, db){
  const live=livingSeats(g); if(!live.length) return;
  for(const c of Object.values(g.cards)) if(c.zone==='hand') c.revealed=false;
  if(g.stage!=='play'){ startPlay(g,db); return; }
  for(const c of Object.values(g.cards)){ c.attacking=null; c.blocking=null; c.blockedBy=[]; }
  let idx=live.indexOf(g.activeSeat); const nxt=live[(idx+1)%live.length];
  g.turn++; g.activeSeat=nxt; log(g,null,`=== Turn ${g.turn}: ${g.seats[nxt].name} ===`);
  enterPhase(g,db,'Untap'); enterPhase(g,db,'Upkeep');
}

// ---------- text action parser ----------
function parseLine(line){
  let s=line.trim().replace(/^[-*•]\s*/,'').replace(/\.$/,''); if(!s) return null;
  if(s.startsWith('{')) return JSON.parse(s);
  let m; const L=s.toLowerCase();
  const word=L.split(/\s+/)[0]; const rest=s.slice(word.length).trim();
  if(/^(draw|draws)$/.test(word)) return {type:'draw', n:parseInt(rest,10)||1};
  if(/^(cast|casts|play|plays)$/.test(word) && / from (?:my |the )?(\w+)/i.test(rest)){ m=rest.match(/^(.*?)\s+from\s+(?:my\s+|the\s+)?(\w+)(.*)$/i); return {type:/^play/.test(word)?'play':'cast', card:m[1], from:m[2], tapped:/tapped/i.test(m[3])}; }
  if(/^(play|plays|land)$/.test(word)){ const t=/\s+tapped$/i.test(rest); return {type:'play', card:rest.replace(/\s+tapped$/i,''), tapped:t}; }
  if(/^(cast|casts)$/.test(word)){ m=rest.match(/^(.*?)\s+(?:targeting|target|on|at)\s+(.+)$/i); return m?{type:'cast',card:m[1],target:m[2]}:{type:'cast',card:rest}; }
  if(word==='resolve') return {type:'resolve', card:rest||undefined};
  if(word==='counter' && /^(spell|the spell|top)?$/i.test(rest)) return {type:'counterspell'};
  if(word==='tap') return {type:'tap', card:rest};
  if(word==='untap') return {type:'untap', card:rest||'all', all:!rest||/^all$/i.test(rest)};
  if(/^(attack|attacks)$/.test(word)){ m=rest.match(/^(.*?)\s*(?:->|=>|→|\bat\b|\bvs\.?\b|\btargeting\b)\s*(.+)$/i); if(!m) throw new Error('Format: attack <card>[, <card>] -> <player>'); return {type:'attack', card:m[1].replace(/^with\s+/i,''), target:m[2]}; }
  if(/^(block|blocks)$/.test(word)){ m=rest.match(/^(.*?)\s*(?:->|=>|→|\bblocks?\b|\bon\b)\s*(.+)$/i); if(!m) throw new Error('Format: block <my creature> -> <attacking creature>'); return {type:'block', card:m[1].replace(/^with\s+/i,''), attacker:m[2]}; }
  if(/^combat( damage)?$/.test(L) || L==='damage step') return {type:'combatdamage'};
  if(word==='damage'||word==='deal'){ m=rest.match(/^(?:to\s+)?(.+?)\s+(\d+)(?:\s+from\s+(.+?))?(\s+commander)?$/i)||rest.match(/^(\d+)\s+(?:damage\s+)?to\s+(.+?)(?:\s+from\s+(.+?))?(\s+commander)?$/i); if(!m) throw new Error('Format: damage <player> <n> [from <card>]');
    if(/^\d+$/.test(m[1])) return {type:'damage', target:m[2], amount:+m[1], source:m[3], commander:!!m[4]}; return {type:'damage', target:m[1], amount:+m[2], source:m[3], commander:!!m[4]}; }
  if(word==='life'){ m=rest.match(/^(?:(.+?)\s+)?([+-]?\d+|=\s*\d+)$/); if(!m) throw new Error('Format: life [player] +N / -N / =N'); if(m[2].startsWith('=')) return {type:'setlife',target:m[1],amount:+m[2].replace(/[=\s]/g,'')}; return {type:'life', target:m[1], amount:+m[2]}; }
  if(/^(gain|gains|lose|loses)$/.test(word)){ m=rest.match(/(\d+)/); const n=m?+m[1]:1; return {type:'life', amount:/^gain/.test(word)?n:-n}; }
  if(/^(poison|energy|experience|rad|tickets)$/.test(word)){ m=rest.match(/^(?:(.+?)\s+)?([+-]?\d+)$/); return {type:'playercounter', kind:word, target:m?m[1]:undefined, amount:m?+m[2]:1}; }
  if(word==='counter'||word==='counters'){ m=rest.match(/^(.*?)\s+([+-]\d+\/[+-]\d+|[a-z][a-z ]*?)\s+([+-]?\d+)$/i); if(!m) throw new Error('Format: counter <card> <kind> <+N|-N>  e.g. counter Grizzly Bears +1/+1 2'); return {type:'counter', card:m[1], kind:m[2].toLowerCase(), amount:+m[3]}; }
  if(word==='pt'||word==='pump'){ m=rest.match(/^(.*?)\s+([+-]?\d+)\/([+-]?\d+)$/); if(!m) throw new Error('Format: pump <card> +2/+2'); return {type:'pt', card:m[1], power:+m[2], toughness:+m[3]}; }
  if(word==='token'||word==='tokens'||word==='create'){ let r=rest.replace(/\s+tokens?$/i,''); let t=false; if(/\s+tapped/i.test(r)){t=true;r=r.replace(/\s+tapped/i,'');} let count=1; m=r.match(/^(\d+)\s+(.+)$/)||r.match(/^(.+?)\s+x\s*(\d+)$/i); if(m){ if(/^\d+$/.test(m[1])){count=+m[1];r=m[2];} else {r=m[1];count=+m[2];} } return {type:'token', name:r, count, tapped:t}; }
  if(word==='copy') return {type:'copy', card:rest};
  if(word==='move'){ m=rest.match(/^(.*?)(?:\s+from\s+(.+?))?\s+to\s+(?:the\s+)?(.+?)(?:\s+(top|bottom|shuffle|shuffled))?(?:\s+(tapped))?(?:\s+(?:of|under)\s+(.+))?$/i); if(!m) throw new Error('Format: move <card> [from <zone>] to <zone> [top|bottom]'); let pos=m[4]?m[4].toLowerCase().replace('shuffled','shuffle'):undefined; let to=m[3]; const pm=to.match(/^(top|bottom)\s+of\s+(?:my\s+|the\s+)?(library)$/i); if(pm){pos=pm[1].toLowerCase(); to='library';} to=to.replace(/^(my|your)\s+/i,''); return {type:'move', card:m[1], from:m[2], to, position:pos, tapped:!!m[5], toPlayer:m[6]}; }
  const simple={discard:['hand','graveyard'],discards:['hand','graveyard'],destroy:['battlefield','graveyard'],destroys:['battlefield','graveyard'],sacrifice:['battlefield','graveyard'],sac:['battlefield','graveyard'],exile:[null,'exile'],exiles:[null,'exile'],bounce:['battlefield','hand'],return:[null,'hand'],reanimate:['graveyard','battlefield'],kill:['battlefield','graveyard']};
  if(simple[word]){ let r=rest; let to=simple[word][1]; m=r.match(/^(.*?)\s+to\s+(?:the\s+|my\s+)?(\w+)$/i); if(m&&zoneName(m[2])){r=m[1];to=zoneName(m[2]);} return {type:'move', card:r, from:simple[word][0]||undefined, to}; }
  if(/^(search|tutor|fetch)$/.test(word)){ let r=rest.replace(/^(?:my\s+library\s+)?for\s+/i,''); let t=/\s+tapped$/i.test(r); r=r.replace(/\s+tapped$/i,''); m=r.match(/^(.*?)\s+(?:to|onto|into)\s+(?:the\s+|my\s+)?(\w+)$/i); return m?{type:'search',card:m[1],to:m[2],tapped:t}:{type:'search',card:r,tapped:t}; }
  if(word==='mill') { m=rest.match(/^(?:(.+?)\s+)?(\d+)$/); return {type:'mill', n:m?+m[2]:1, target:m?m[1]:undefined}; }
  if(/^(scry|look|surveil|peek)$/.test(word)) return {type:word==='peek'?'look':word, n:parseInt(rest,10)||1};
  if(word==='top'||word==='bottom') return {type:word, card:rest};
  if(word==='done') return {type:'done'};
  if(word==='reveal') return {type:'reveal', card:rest||'hand'};
  if(word==='shuffle') return /graveyard/i.test(rest)?{type:'shufflegraveyard'}:{type:'shuffle'};
  if(/^(mulligan|mull|mulls)$/.test(word)) return {type:'mulligan'};
  if(word==='keep'){ m=rest.match(/^(?:hand)?\s*(?:,?\s*bottom:?\s*)(.+)$/i); return {type:'keep', bottom:m?m[1]:undefined}; }
  if(L==='next'||L==='next phase'||L==='next step') return {type:'next'};
  if(word==='phase'||word==='go') return {type:'phase', phase:rest.replace(/^to\s+/i,'')};
  if(/^(pass|end turn|end my turn|pass turn)$/.test(L)) return {type:'pass'};
  if(word==='roll'){ m=rest.match(/^(\d*)d(\d+)$/i); return {type:'roll', count:m&&m[1]?+m[1]:1, sides:m?+m[2]:6}; }
  if(L==='flip'||L==='flip coin'||L==='coin'||L==='flip a coin') return {type:'flip'};
  if(/^(transform|flip)$/.test(word)) return {type:'transform', card:rest};
  if(word==='facedown'||L.startsWith('face down')) return {type:'facedown', card:rest.replace(/^down\s+/i,'')};
  if(word==='faceup'||L.startsWith('face up')) return {type:'faceup', card:rest.replace(/^up\s+/i,'')};
  if(word==='say'||word==='chat'||word==='note:') return {type:'say', text:rest};
  if(word==='steal'||L.startsWith('gain control')){ const r=rest.replace(/^control\s+(of\s+)?/i,''); return {type:'control', card:r}; }
  if(word==='concede') return {type:'concede'};
  if(word==='note'){ m=rest.match(/^(.*?)\s*:\s*(.*)$/); return {type:'note', card:m?m[1]:rest, text:m?m[2]:''}; }
  if(word==='unattack') return {type:'unattack', card:rest};
  throw new Error(`Didn't understand "${line}". Send "help" for the action list.`);
}
function parseText(text){ return String(text).split(/\n|;(?![^{]*})/).map(x=>x.trim()).filter(x=>x && !x.startsWith('#')).map(l=>({line:l})); }

// ---------- views ----------
function cardView(g, db, c, viewer, host){
  const hidden = c.faceDown && viewer!==c.controller && !host;
  const d = c.custom ? null : db[c.id];
  const v={iid:c.iid, owner:c.owner, controller:c.controller, zone:c.zone, tapped:c.tapped, counters:c.counters, attacking:c.attacking, blocking:c.blocking, blockedBy:c.blockedBy||[], token:c.token, isCommander:c.isCommander, faceDown:c.faceDown, revealed:c.revealed, note:c.note||null, copy:!!c.copy};
  if(hidden){ v.name='Face-down card'; return v; }
  v.id=c.id; v.faceIndex=c.faceIndex||0; v.name=cname(g,db,c); v.type=ctype(g,db,c); const pt=ptOf(g,db,c); if(pt) v.pt=pt.join('/'); const f=c.custom?c.custom:face(g,db,c); if(f.loyalty) v.loyalty=f.loyalty;
  if(c.custom) v.custom=c.custom; if(c.isCommander) v.tax=2*(g.cmdCasts[c.iid]||0);
  return v;
}
function view(g, db, viewer, opts={}){
  const host=!!opts.host; const fmt=FORMATS[g.format];
  const used=new Set(); const cv=c=>{ const v=cardView(g,db,c,viewer,host); if(v.id) used.add(v.id); if(v.custom===undefined && c.custom) {} return v; };
  const seats={};
  for(const s of Object.values(g.seats)){
    const mine = s.seat===viewer;
    const z={};
    for(const zn of ['battlefield','graveyard','exile','command']) z[zn]=s.zones[zn].map(i=>cv(g.cards[i]));
    z.hand = mine ? s.zones.hand.map(i=>cv(g.cards[i])) : s.zones.hand.map(i=>g.cards[i]).filter(c=>c.revealed).map(cv);
    if(mine) z.sideboard=s.zones.sideboard.map(i=>cv(g.cards[i]));
    if(mine && opts.fullLibrary) z.library=s.zones.library.map(i=>cv(g.cards[i]));
    seats[s.seat]={seat:s.seat,name:s.name,controller:s.controller,deckName:s.deckName,life:s.life,counters:s.counters,cmdDamage:s.cmdDamage,mulligans:s.mulligans,kept:s.kept,lost:s.lost,conceded:s.conceded,
      handCount:s.zones.hand.length, libraryCount:s.zones.library.length, sideboardCount:s.zones.sideboard.length, zones:z,
      peek: mine ? s.peek.map(i=>({...cv(g.cards[i]), pos:s.zones.library.indexOf(i)+1})) : (s.peek.length?{count:s.peek.length}:[]) };
  }
  const cardData={}; for(const id of used){ const d=db[id]; if(d) cardData[id]={name:d.name,mana_cost:d.mana_cost,type_line:d.type_line,oracle_text:d.oracle_text,power:d.power,toughness:d.toughness,loyalty:d.loyalty,image:d.image,faces:d.faces,layout:d.layout,tokens:d.tokens,scryfall_uri:d.scryfall_uri,set:d.set,cn:d.cn}; }
  return { v:g.v, viewer, format:g.format, formatLabel:fmt.label, cmdDmgLimit:fmt.cmdDmg||0, commanderFormat:!!fmt.cmd, stage:g.stage, turn:g.turn, activeSeat:g.activeSeat, firstSeat:g.firstSeat, phase:g.phase, phases:PHASES,
    startingLife:g.startingLife, settings:{autoDraw:g.autoDraw,autoUntap:g.autoUntap,commanderRedirect:g.commanderRedirect}, seats, stack:g.stack.map(i=>cv(g.cards[i])),
    log:g.log.filter(e=>e.vis===null||e.vis===undefined||e.vis===viewer).slice(-(opts.logN||250)), cardData };
}

function textView(g, db, viewer){
  const V=view(g,db,viewer); const fmt=FORMATS[g.format]; const me=V.seats[viewer]; if(!me) return `Seat ${viewer} is not in this game.`;
  const cd=V.cardData;
  const full=c=>{ if(c.name==='Face-down card') return `[${c.iid}] Face-down card`; const d=c.id?cd[c.id]:null; const f=d&&d.faces&&d.faces.length?d.faces[c.faceIndex||0]:d;
    const mana=(f&&f.mana_cost)||(d&&d.mana_cost)||''; const txt=c.custom?(c.custom.text||''):((f&&f.oracle_text)||''); const tags=[];
    if(c.tapped) tags.push('TAPPED'); if(c.attacking) tags.push('ATTACKING seat '+c.attacking); if(c.blocking) tags.push('BLOCKING '+c.blocking); if(c.token) tags.push('token'); if(c.isCommander) tags.push('COMMANDER'+(c.zone==='command'?`, tax {${c.tax}}`:'')); if(c.faceDown) tags.push('face-down');
    const cnt=Object.entries(c.counters||{}).map(([k,v])=>`${v}x ${k}`).join(', '); if(cnt) tags.push('counters: '+cnt); if(c.note) tags.push('note: '+c.note);
    const isBasic=/^Basic Land/.test(c.type||'');
    return `[${c.iid}] ${c.name}${mana?' '+mana:''} — ${c.type||''}${c.pt?' '+c.pt:''}${c.loyalty?' (loyalty '+c.loyalty+')':''}${tags.length?' {'+tags.join('; ')+'}':''}${txt&&!isBasic?'\n      '+txt.replace(/\n/g,' / '):''}`; };
  const brief=c=>{ const tags=[]; if(c.tapped) tags.push('T'); if(c.attacking) tags.push('attacking seat '+c.attacking); const cnt=Object.entries(c.counters||{}).map(([k,v])=>`${v}x${k}`).join(','); if(cnt) tags.push(cnt); return `[${c.iid}] ${c.name}${c.pt?' '+c.pt:''}${tags.length?' ('+tags.join('; ')+')':''}`; };
  const counters=s=>{ const p=Object.entries(s.counters||{}).map(([k,v])=>`${k} ${v}`); const cdm=Object.entries(s.cmdDamage||{}).map(([k,v])=>`cmd dmg from ${k}: ${v}`); return p.concat(cdm).join(', '); };
  const L=[];
  L.push(`=== MTG VTT — view for SEAT ${viewer} (${me.name}) ===`);
  L.push(`Format: ${V.formatLabel} | Turn ${V.turn} | Active: ${V.activeSeat?('seat '+V.activeSeat+' '+V.seats[V.activeSeat].name):'(mulligans)'} | Phase: ${V.phase}${V.activeSeat===viewer?'  <-- YOUR TURN':''}`);
  if(V.stage==='mulligan') L.push(me.kept?'You kept. Waiting for others to keep.':`MULLIGAN STAGE: reply "keep" or "mulligan" (mulligans so far: ${me.mulligans}${me.mulligans?'; when keeping, use "keep bottom <card>, <card>" for the cards to bottom':''}).`);
  L.push('');
  L.push(`YOU: ${me.name} | Life ${me.life}${counters(me)?' | '+counters(me):''} | Library ${me.libraryCount} | Hand ${me.handCount}${me.lost?' | (LOST)':''}`);
  L.push(`Your hand (${me.zones.hand.length}):`); for(const c of me.zones.hand) L.push('  '+full(c));
  if(me.peek.length){ L.push(`You are looking at the top of your library (use "top <card>" / "bottom <card>" / "done"):`); for(const c of me.peek) L.push(`  #${c.pos} `+full(c)); }
  L.push(`Your battlefield (${me.zones.battlefield.length}):`); for(const c of me.zones.battlefield) L.push('  '+full(c));
  if(me.zones.command.length){ L.push('Your command zone:'); for(const c of me.zones.command) L.push('  '+full(c)); }
  L.push(`Your graveyard (${me.zones.graveyard.length}): ${me.zones.graveyard.map(c=>`[${c.iid}] ${c.name}`).join(', ')||'-'}`);
  L.push(`Your exile (${me.zones.exile.length}): ${me.zones.exile.map(c=>`[${c.iid}] ${c.name}`).join(', ')||'-'}`);
  L.push('');
  for(const s of Object.values(V.seats)){ if(s.seat===viewer) continue;
    L.push(`OPPONENT seat ${s.seat}: ${s.name} | Life ${s.life}${counters(s)?' | '+counters(s):''} | Hand ${s.handCount} (hidden) | Library ${s.libraryCount}${s.lost?' | (LOST)':''}${V.stage==='mulligan'?(s.kept?' | kept':' | deciding'):''}`);
    if(s.zones.hand.length) L.push('  Revealed from hand: '+s.zones.hand.map(c=>c.name).join(', '));
    const nonland=s.zones.battlefield.filter(c=>!/\bLand\b/.test(c.type||'')), lands=s.zones.battlefield.filter(c=>/\bLand\b/.test(c.type||''));
    L.push(`  Battlefield (${s.zones.battlefield.length}):`); for(const c of nonland) L.push('    '+full(c)); if(lands.length) L.push('    Lands: '+lands.map(brief).join(', '));
    if(s.zones.command.length) L.push('  Command zone: '+s.zones.command.map(c=>`[${c.iid}] ${c.name}${c.isCommander?' (tax {'+c.tax+'})':''}`).join(', '));
    L.push(`  Graveyard (${s.zones.graveyard.length}): ${s.zones.graveyard.map(c=>c.name).join(', ')||'-'}`);
    if(s.zones.exile.length) L.push(`  Exile: ${s.zones.exile.map(c=>c.name).join(', ')}`);
  }
  L.push(''); L.push(`STACK (top last): ${V.stack.length?V.stack.map(c=>full(c)+' (controller seat '+c.controller+')').join('\n  '):'empty'}`);
  L.push(''); L.push('Recent log:'); for(const e of V.log.slice(-15)) L.push('  '+e.text);
  L.push(''); L.push(`Reply with your actions, one per line, e.g.: "play Forest", "cast Lightning Bolt targeting seat 1", "attack Grizzly Bears -> seat 1", "tap c12", "next", "pass". Card names or [ids] both work. Full list: node /workspace/mtg-vtt/bot.js help`);
  return L.join('\n');
}

const HELP = `MTG VTT action format — one action per line (or separated by ";"). Cards can be named ("Llanowar Elves") or given by id ("c42").
Players: seat number ("seat 2" or "2"), name ("Jess"), or "me".
  draw [n]                         | mulligan | keep | keep bottom <card>, <card>
  play <card> [tapped]             (land/permanent from hand or command zone straight to battlefield; instants/sorceries go to the stack)
  cast <card> [targeting <text>]   (put on the stack)          | resolve [card]   (resolve top of stack) | counter spell
  tap <card>[, <card>] | untap <card> | untap all
  attack <card>[, <card>] -> <player>   | block <my card> -> <attacking card> | combat damage   (applies unblocked damage, infect, lifelink, commander dmg)
  damage <player> <n> [from <card>] [commander]  | life [player] +N / -N / =N  | gain 3 | lose 2
  poison|energy|experience|rad [player] +N/-N
  counter <card> <kind> <+N/-N>    e.g. counter Grizzly Bears +1/+1 2 ; counter Liliana loyalty -3
  pump <card> +2/+2                (P/T modifier; set back with pump <card> 0/0)
  token <name> [xN] [tapped]       e.g. token Goblin x3 ; token Treasure  | copy <card>
  move <card> [from <zone>] to <zone> [top|bottom|shuffle] [tapped]   zones: hand library battlefield graveyard exile command stack sideboard
  discard <card> | destroy <card> | sacrifice <card> | exile <card> | bounce <card> | return <card> to hand | reanimate <card>
  search <card> [to hand|battlefield|graveyard] [tapped]    (auto-shuffles library)
  mill [player] <n> | scry <n> | look <n> | surveil <n> then: top <card> | bottom <card> | move <card> to graveyard | done
  reveal <card> | reveal hand | reveal top | shuffle | shuffle graveyard
  transform <card> (double-faced) | facedown <card> | faceup <card> | gain control <card> | note <card>: <text>
  next (phase) | phase <name> | pass (end turn) | roll d20 | roll 2d6 | flip coin | say <text> | concede
JSON works too: {"type":"attack","card":"c12","target":2}`;

module.exports = { PHASES, FORMATS, newGame, apply, parseLine, parseText, view, textView, HELP, clone, findPlayer, norm, cname };
