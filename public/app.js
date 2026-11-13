'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BOTS=['Connor','Jess','Mia','Theo','Nate','Lucas','Rowan','Luna','Alex','Lex','Arjhan','Gordon','Remy','Eugene','Echo','Other bot'];
let S=null, SETUP=null, me=+(localStorage.getItem('mtgSeat')||0), lastV=-1, cardsById={}, selectMode=null, zoneOpen=null, forceSetup=false;

async function api(path, body){ const r=await fetch(path, body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}); const ct=r.headers.get('content-type')||''; const j=ct.includes('json')?await r.json():await r.text(); if(!r.ok) throw new Error(j.error||j||r.status); return j; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.style.display='block'; clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none',4500); }
async function act(seat, action, opts={}){
  try{ const body={seat, host:true}; if(typeof action==='string') body.text=action; else body.action=action;
    const r=await api('api/act',body); const bad=r.results.filter(x=>!x.ok); if(bad.length) toast(bad.map(b=>b.error).join(' | '));
    const help=r.results.find(x=>x.ok&&x.line==='help'); if(help) showModal(`<h3>Action format</h3><pre style="white-space:pre-wrap">${esc(help.msg)}</pre>`);
    await refresh(true); return r; }catch(e){ toast(e.message); }
}
async function refresh(force){
  try{ const st=await api('api/state?seat='+(me||1)); 
    if(st.noGame){ S=null; SETUP=st.setup; if(lastV!=='setup'){ lastV='setup'; renderSetup(); } return; }
    SETUP=st.setup;
    if(!me || !st.seats[me]){ const c=Object.values(st.seats).find(s=>s.controller==='Connor')||Object.values(st.seats)[0]; me=c.seat; localStorage.setItem('mtgSeat',me); return refresh(true); }
    if(forceSetup){ return; }
    if(!force && st.v===lastV) return; lastV=st.v; S=st; Object.assign(cardsById, st.cardData); render();
  }catch(e){ console.error(e); }
}
setInterval(()=>refresh(false),1200);

// ---------------- setup screen ----------------
function renderSetup(){
  $('#game').classList.add('hidden'); const el=$('#setup'); el.classList.remove('hidden');
  const st=SETUP; const fmts=Object.entries(st.formats).map(([k,v])=>`<option value="${k}" ${k===st.format?'selected':''}>${esc(v)}</option>`).join('');
  el.innerHTML=`<h1>🃏 Connor's Magic Tabletop</h1><div class="mut">Load up to 4 decks, give each bot a seat, pick a format, and start. ${S||forceSetup?'<button id="backgame">← Back to current game</button>':''}</div>
  <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap"><b>Format</b><select id="fmt">${fmts}</select>
  <b>Goes first</b><select id="first"><option value="">Random</option>${st.seats.map(s=>`<option value="${s.seat}" ${st.firstSeat==s.seat?'selected':''}>Seat ${s.seat}</option>`).join('')}</select>
  <button class="pri" id="startbtn">▶ Start game</button><a href="/README.md" target="_blank" class="small mut">README / bot instructions</a></div>
  <div class="seatgrid">${st.seats.map(seatCard).join('')}</div>`;
  if($('#backgame')) $('#backgame').onclick=()=>{ forceSetup=false; lastV=-1; refresh(true); };
  $('#fmt').onchange=e=>api('api/setup',{format:e.target.value});
  $('#first').onchange=e=>api('api/setup',{firstSeat:e.target.value?+e.target.value:null});
  $('#startbtn').onclick=async()=>{ if(S && !confirm('End the current game and start a new one?')) return; try{ if(S) await api('api/endgame',{}); await api('api/start',{format:$('#fmt').value}); forceSetup=false; lastV=-1; me=0; await refresh(true); }catch(e){ toast(e.message); } };
  for(const s of st.seats){ const q=k=>el.querySelector(`[data-seat="${s.seat}"] ${k}`);
    q('.en').onchange=e=>saveSeat(s.seat,{enabled:e.target.checked},true);
    q('.nm').onchange=e=>saveSeat(s.seat,{name:e.target.value});
    q('.ct').onchange=e=>{ const v=e.target.value; const upd={controller:v}; const nm=q('.nm'); if(v!=='Other bot' && (!nm.value || BOTS.includes(nm.value))) { upd.name=v; } saveSeat(s.seat,upd,true); };
    q('.loadtxt').onclick=()=>loadDeck(s.seat,{text:q('textarea').value, name:q('.dname').value||undefined});
    q('.loadurl').onclick=()=>loadDeck(s.seat,{url:q('.url').value});
    q('.sample').onclick=()=>{ q('textarea').value=SAMPLE[s.seat%SAMPLE.length]; };
    if(q('.clr')) q('.clr').onclick=()=>saveSeat(s.seat,{clearDeck:true},true);
  }
}
function seatCard(s){
  const d=s.deck;
  return `<div class="seatcard ${s.enabled?'':'off'}" data-seat="${s.seat}">
   <div class="row"><label><input type="checkbox" class="en" ${s.enabled?'checked':''}> <b>Seat ${s.seat}</b></label>
   <select class="ct">${BOTS.map(b=>`<option ${b===s.controller?'selected':''}>${b}</option>`).join('')}</select>
   <input class="nm" value="${esc(s.name)}" placeholder="Seat name" style="width:110px"></div>
   <div class="row"><input class="url" placeholder="Archidekt link (archidekt.com/decks/…)" style="flex:1"><button class="loadurl">Import link</button></div>
   <textarea placeholder="…or paste a list:&#10;Commander&#10;1 Krenko, Mob Boss&#10;&#10;Deck&#10;1 Sol Ring&#10;30 Mountain&#10;&#10;Sideboard&#10;2 Negate"></textarea>
   <div class="row"><input class="dname" placeholder="Deck name (optional)" style="flex:1"><button class="sample">Sample</button><button class="loadtxt pri">Import text</button></div>
   <div class="status small"></div>
   ${d?`<div class="deckinfo"><b class="ok">✔ ${esc(d.name)}</b> — ${d.count} cards${d.commander.length?` · Commander: ${esc(d.commander.join(', '))}`:''}${d.sideboard.length?` · Sideboard ${d.sideboard.length}`:''} <button class="clr" style="font-size:10px;padding:0 5px">remove</button>
     ${d.missing.length?`<div class="err">Not found on Scryfall: ${esc(d.missing.join(', '))}</div>`:''}<div class="mut">${esc(d.main.slice(0,60).join(' · '))}${d.main.length>60?' …':''}</div></div>`:'<div class="deckinfo mut">No deck loaded</div>'}
  </div>`;
}
async function saveSeat(seat, upd, rerender){ try{ SETUP=await api('api/setup',{seats:[{seat,...upd}]}); if(rerender) renderSetup(); }catch(e){ toast(e.message); } }
async function loadDeck(seat, body){ const st=document.querySelector(`[data-seat="${seat}"] .status`); st.textContent='Loading cards from Scryfall…'; try{ await api('api/deck',{seat,...body}); SETUP=await api('api/setup'); renderSetup(); }catch(e){ st.innerHTML=`<span class="err">${esc(e.message)}</span>`; } }
const SAMPLE=[`Commander\n1 Krenko, Mob Boss\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Goblin Chieftain\n1 Goblin Matron\n1 Skirk Prospector\n1 Lightning Bolt\n1 Chaos Warp\n1 Goblin Instigator\n1 Beetleback Chief\n1 Mogg War Marshal\n1 Siege-Gang Commander\n1 Purphoros, God of the Forge\n1 Impact Tremors\n1 Shared Animosity\n1 Hellrider\n1 Legion Warboss\n1 Goblin Rabblemaster\n1 Krenko, Tin Street Kingpin\n1 Thrill of Possibility\n1 Faithless Looting\n1 Mind Stone\n1 Fellwar Stone\n1 Evolving Wilds\n31 Mountain`,
`Commander\n1 Atraxa, Grand Unifier\n\nDeck\n4 Llanowar Elves\n4 Lightning Bolt\n1 Delver of Secrets\n1 Brazen Borrower\n1 Fire // Ice\n1 Evolving Wilds\n1 Sol Ring\n10 Forest\n8 Island\n4 Mountain\n\nSideboard\n2 Negate`,
`Deck\n4 Delver of Secrets\n4 Brainstorm\n4 Ponder\n4 Lightning Bolt\n4 Counterspell\n4 Dragon's Rage Channeler\n4 Murktide Regent\n4 Expressive Iteration\n4 Consider\n4 Fiery Confluence\n4 Scalding Tarn\n4 Steam Vents\n6 Island\n6 Mountain\n\nSideboard\n3 Pyroblast\n2 Hydroblast`,
`Commander\n1 Esika, God of the Tree // The Prismatic Bridge\n\nDeck\n1 Agadeem's Awakening // Agadeem, the Undercrypt\n1 Kazandu Mammoth // Kazandu Valley\n1 Valki, God of Lies // Tibalt, Cosmic Impostor\n1 Birds of Paradise\n1 Sol Ring\n1 Cultivate\n1 Kodama's Reach\n1 Rampant Growth\n1 Llanowar Elves\n1 Elvish Mystic\n1 Command Tower\n1 Exotic Orchard\n20 Forest\n6 Plains\n6 Swamp`];

// ---------------- game rendering ----------------
const seatName=n=>S.seats[n]?S.seats[n].name:'Seat '+n;
function cardImg(c){
  if(!c || c.name==='Face-down card' || (!c.id && !c.custom)) return `<div class="cback">${c&&c.faceDown?'Face-down':'MTG'}</div>`;
  if(c.custom) return `<div class="ctext"><b>${esc(c.custom.name)}</b>${esc(c.custom.type||'')}<br>${c.custom.power!==undefined?esc(c.custom.power+'/'+c.custom.toughness):''}</div>`;
  const d=cardsById[c.id]; if(!d) return `<div class="ctext"><b>${esc(c.name)}</b></div>`;
  const f=d.faces&&d.faces[c.faceIndex||0]; const img=(f&&f.image)||d.image;
  return img?`<img loading="lazy" src="${esc(img)}" alt="${esc(c.name)}">`:`<div class="ctext"><b>${esc(c.name)}</b>${esc(c.type||'')}<br>${esc((f||d).oracle_text||'')}</div>`;
}
function cardEl(c, extra=''){
  const badges=[]; if(c.attacking) badges.push(`<span class="badge atk">⚔ ${esc(seatName(c.attacking))}</span>`); if(c.blocking) badges.push(`<span class="badge" style="background:#8a6a10">🛡 blocking</span>`);
  for(const [k,v] of Object.entries(c.counters||{})) badges.push(`<span class="badge">${v}× ${esc(k)}</span>`);
  if(c.isCommander) badges.push(`<span class="badge cmd">CMDR${c.zone==='command'&&c.tax?' tax '+c.tax:''}</span>`); if(c.token) badges.push(`<span class="badge tok">${c.copy?'copy':'token'}</span>`); if(c.revealed&&c.zone==='hand') badges.push(`<span class="badge">revealed</span>`); if(c.note) badges.push(`<span class="badge">📝 ${esc(c.note)}</span>`);
  const cnt=c.counters||{}; const showPT=c.pt && c.zone==='battlefield' && (cnt['+1/+1']||cnt['-1/-1']||/Creature|Vehicle/.test(c.type||'')); 
  return `<div class="card ${c.tapped?'tapped':''} ${c.attacking?'attacking':''} ${c.blocking?'blocking':''} ${selectMode&&selectMode.sel.includes(c.iid)?'sel':''} ${extra}" data-iid="${c.iid}" draggable="true">${cardImg(c)}<div class="badges">${badges.join('')}</div>${showPT?`<div class="ptb">${esc(c.pt)}</div>`:''}${c.loyalty&&c.zone==='battlefield'?`<div class="ptb">◆${esc((cnt.loyalty!==undefined?cnt.loyalty:c.loyalty))}</div>`:''}</div>`;
}
const isLand=c=>/\bLand\b/.test(c.type||'')&&!/Creature/.test(c.type||'');
function battlefield(s){
  const bf=s.zones.battlefield; const creatures=bf.filter(c=>/Creature/.test(c.type||'')||c.name==='Face-down card'), lands=bf.filter(isLand), other=bf.filter(c=>!creatures.includes(c)&&!lands.includes(c));
  return `<div class="bf" data-drop="battlefield" data-seat="${s.seat}"><div class="cardsrow">${creatures.map(c=>cardEl(c)).join('')}</div><div class="cardsrow">${other.map(c=>cardEl(c)).join('')}</div><div class="cardsrow">${lands.map(c=>cardEl(c)).join('')}</div>${bf.length?'':'<div class="mut small">Battlefield empty</div>'}</div>`;
}
function pstrip(s){
  const ctr=Object.entries(s.counters||{}).map(([k,v])=>`<span class="pc" data-pc="${k}" data-seat="${s.seat}" title="Click +1, right-click −1">${k==='poison'?'☠':k==='energy'?'⚡':k==='experience'?'★':k==='rad'?'☢':'•'} ${esc(k)} ${v}</span>`).join('');
  const cd=Object.entries(s.cmdDamage||{}).map(([k,v])=>`<span class="pc" data-cmdd="${s.seat}" title="Commander damage taken">⚔ ${esc(k.split(' (')[0])}: ${v}</span>`).join('');
  return `<div class="pstrip"><span class="pname">${esc(s.name)}</span><span class="ctrl">seat ${s.seat}${s.controller&&s.controller!==s.name?' · '+esc(s.controller):''}${S.activeSeat===s.seat?' · 🟢 active':''}${s.lost?' · <span class="err">lost</span>':''}${S.stage==='mulligan'?(s.kept?' · kept':' · deciding'+(s.mulligans?` (mull ${s.mulligans})`:'')):''}</span>
   <span class="life"><button data-life="-5" data-seat="${s.seat}">−5</button><button data-life="-1" data-seat="${s.seat}">−1</button><b title="Life">${s.life}</b><button data-life="1" data-seat="${s.seat}">+1</button><button data-life="5" data-seat="${s.seat}">+5</button></span>
   ${ctr}${cd}<span class="pc" data-addpc="${s.seat}" title="Poison / energy / experience / commander damage">＋ counters</span></div>`;
}
function piles(s, mine){
  const z=s.zones; const p=(zone,label,n)=>`<span class="pile" data-pile="${zone}" data-seat="${s.seat}" data-drop="${zone}">${label} <b>${n}</b></span>`;
  return `<div class="piles">${p('library','📚 Library',s.libraryCount)}${mine?'':`<span class="pile" data-pile="hand" data-seat="${s.seat}">✋ Hand <b>${s.handCount}</b></span>`}${p('graveyard','🪦 Graveyard',z.graveyard.length)}${p('exile','🌀 Exile',z.exile.length)}${S.commanderFormat||z.command.length?p('command','👑 Command',z.command.length):''}${mine&&s.sideboardCount?p('sideboard','🗂 Sideboard',s.sideboardCount):''}</div>`;
}
function render(){
  $('#setup').classList.add('hidden'); $('#game').classList.remove('hidden');
  const my=S.seats[me];
  // top bar
  $('#topbar').innerHTML=`<span class="title">🃏 MTG</span><span class="mut">${esc(S.formatLabel)}</span><span class="sep"></span>
   <span>Turn <b>${S.turn}</b> · ${S.activeSeat?`<b>${esc(seatName(S.activeSeat))}</b>`:'Mulligans'}</span>
   <span class="phases">${S.phases.map(p=>`<span class="phase ${p===S.phase?'on':''}" data-phase="${esc(p)}">${esc(p)}</span>`).join('')}</span>
   <button id="bnext" class="pri" title="Next phase">Next ▸</button><button id="bpass" title="End turn">End turn ⏭</button><span class="sep"></span>
   <button data-roll="6">🎲 d6</button><button data-roll="20">d20</button><button id="bdie">dX</button><button id="bcoin">🪙 Coin</button><span class="sep"></span>
   <button id="btok">＋ Token</button><button id="bcomb" title="Apply combat damage from unblocked attackers">⚔ Combat dmg</button><button id="bundo">↶ Undo</button><button id="brelay" class="pri">🤖 Bot relay</button><button id="bset">⚙</button><button id="bnew">New game</button>
   <span class="mut small">You: <select id="meSel">${Object.values(S.seats).map(s=>`<option value="${s.seat}" ${s.seat===me?'selected':''}>${esc(s.name)} (seat ${s.seat})</option>`).join('')}</select></span>`;
  // opponents
  const opps=Object.values(S.seats).filter(s=>s.seat!==me);
  $('#opps').style.gridTemplateColumns=`repeat(${Math.max(1,opps.length)},minmax(0,1fr))`;
  $('#opps').innerHTML=opps.map(s=>`<div class="board opp ${S.activeSeat===s.seat?'active':''} ${s.lost?'lost':''}">${pstrip(s)}${piles(s,false)}
     <div class="handcount" title="Hand (hidden)">${Array.from({length:Math.min(s.handCount,12)}).map(()=>'<div class="card"><div class="cback"></div></div>').join('')}${s.zones.hand.length?`<span class="small" style="margin-left:20px">Revealed: </span>${s.zones.hand.map(c=>cardEl(c)).join('')}`:''}</div>
     ${s.zones.command.length?`<div class="cardsrow" style="margin-top:4px">${s.zones.command.map(c=>cardEl(c)).join('')}</div>`:''}${battlefield(s)}</div>`).join('');
  // center: banners, stack, peek
  let center='';
  if(S.stage==='mulligan'){ const free=(S.commanderFormat&&Object.keys(S.seats).length>2)?1:0; const need=Math.max(0,my.mulligans-free);
    center+=`<div class="banner">${my.kept?'<b>You kept.</b> Waiting on: '+esc(Object.values(S.seats).filter(s=>!s.kept).map(s=>s.name).join(', ')):`<b>Opening hand:</b> ${my.mulligans?`mulligans ${my.mulligans}${need?` — when you keep, pick ${need} card(s) to put on the bottom`:' (free mulligan)'}`:'keep or mulligan?'} <button id="bmull">Mulligan</button><button id="bkeep" class="pri">Keep${need?` (choose ${need})`:''}</button>`}
      <button id="bkeepbots">Keep for all bots</button><button id="bstartnow">Start now</button></div>`; }
  if(selectMode) center+=`<div class="banner"><b>${esc(selectMode.label)}</b> (${selectMode.sel.length}/${selectMode.n}) <button id="selok" class="pri">Confirm</button><button id="selcancel">Cancel</button></div>`;
  center+=`<div class="panel" id="stackp" data-drop="stack"><h4>STACK ${S.stack.length?`(${S.stack.length}) <button id="bresolve" style="font-size:11px">Resolve top</button>`:''}</h4><div class="cardsrow">${S.stack.map(c=>cardEl(c)).join('')||'<span class="mut small">empty</span>'}</div></div>`;
  if(my.peek&&my.peek.length) center+=`<div class="panel"><h4>Top of your library (click a card for options) <button id="bpeekdone" style="font-size:11px">Done</button></h4><div class="cardsrow">${my.peek.map(c=>`<div><div class="small mut">#${c.pos}</div>${cardEl(c,'peek')}</div>`).join('')}</div></div>`;
  $('#center').innerHTML=center;
  // mine
  $('#mine').innerHTML=`<div class="board ${S.activeSeat===me?'active':''}">${pstrip(my)}${piles(my,true)}${my.zones.command.length?`<div class="cardsrow" style="margin:4px 0">${my.zones.command.map(c=>cardEl(c)).join('')}</div>`:''}${battlefield(my)}</div>`;
  $('#handbar').className='hand'; $('#handbar').dataset.drop='hand'; $('#handbar').dataset.seat=me;
  $('#handbar').innerHTML=`<div class="small mut">Your hand (${my.zones.hand.length}) — click for options, double-click to play, drag onto the battlefield/piles</div><div class="cardsrow">${my.zones.hand.map(c=>cardEl(c)).join('')}</div>`;
  // log
  const lg=$('#log'); const atBottom=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-30;
  lg.innerHTML=S.log.map(e=>`<div class="${e.vis?'priv':e.seat?'':'sys'}">${esc(e.text)}</div>`).join(''); if(atBottom) lg.scrollTop=lg.scrollHeight;
  bindGame();
  if(zoneOpen) openZone(zoneOpen.seat, zoneOpen.zone, true);
}
function allCards(){ const out={}; for(const s of Object.values(S.seats)){ for(const z of Object.values(s.zones)) for(const c of z) out[c.iid]=c; for(const c of (Array.isArray(s.peek)?s.peek:[])) out[c.iid]=c; } for(const c of S.stack) out[c.iid]=c; if(zoneOpen&&zoneOpen.cards) for(const c of zoneOpen.cards) out[c.iid]=c; return out; }
const actor=c=>c.zone==='battlefield'||c.zone==='stack'?c.controller:c.owner;

function bindGame(){
  const T=$('#topbar');
  T.querySelectorAll('[data-phase]').forEach(b=>b.onclick=()=>act(S.activeSeat||me,{type:'phase',phase:b.dataset.phase}));
  $('#bnext').onclick=()=>act(S.activeSeat||me,{type:'next'}); $('#bpass').onclick=()=>act(S.activeSeat||me,{type:'pass'});
  T.querySelectorAll('[data-roll]').forEach(b=>b.onclick=()=>act(me,{type:'roll',sides:+b.dataset.roll}));
  $('#bdie').onclick=()=>{ const v=prompt('Roll what? e.g. d12, 2d6','d12'); if(v) act(me,'roll '+v.replace(/^roll\s*/,'')); };
  $('#bcoin').onclick=()=>act(me,{type:'flip'}); $('#btok').onclick=()=>tokenModal(me); $('#bcomb').onclick=()=>act(S.activeSeat||me,{type:'combatdamage'});
  $('#bundo').onclick=async()=>{ try{ await api('api/undo',{}); await refresh(true); }catch(e){ toast(e.message); } };
  $('#brelay').onclick=relayModal; $('#bset').onclick=settingsModal; $('#bnew').onclick=()=>{ forceSetup=true; renderSetup(); };
  $('#meSel').onchange=e=>{ if(S.seats[+e.target.value].controller!=='Connor' && !confirm('Switch to another seat? You will see that seat\'s hidden hand. Only do this if you are playing that seat yourself.')){ e.target.value=me; return; } me=+e.target.value; localStorage.setItem('mtgSeat',me); lastV=-1; refresh(true); };
  if($('#bmull')) $('#bmull').onclick=()=>act(me,{type:'mulligan'});
  if($('#bkeep')) $('#bkeep').onclick=()=>{ const my=S.seats[me]; const free=(S.commanderFormat&&Object.keys(S.seats).length>2)?1:0; const need=Math.max(0,my.mulligans-free); if(!need) return act(me,{type:'keep'}); selectMode={n:need,sel:[],label:`Pick ${need} card(s) from your hand to put on the bottom`,zone:'hand',done:sel=>act(me,{type:'keep',bottom:sel})}; render(); };
  if($('#bkeepbots')) $('#bkeepbots').onclick=async()=>{ for(const s of Object.values(S.seats)) if(s.seat!==me && !s.kept) await act(s.seat,{type:'keep'}); };
  if($('#bstartnow')) $('#bstartnow').onclick=()=>act(me,{type:'startnow'});
  if($('#selok')) $('#selok').onclick=()=>{ const m=selectMode; if(m.sel.length!==m.n) return toast(`Pick exactly ${m.n}.`); selectMode=null; m.done(m.sel); };
  if($('#selcancel')) $('#selcancel').onclick=()=>{ selectMode=null; render(); };
  if($('#bresolve')) $('#bresolve').onclick=()=>{ const top=S.stack[S.stack.length-1]; act(top.controller,{type:'resolve'}); };
  if($('#bpeekdone')) $('#bpeekdone').onclick=()=>act(me,{type:'done'});
  document.querySelectorAll('[data-life]').forEach(b=>b.onclick=()=>act(+b.dataset.seat,{type:'life',target:+b.dataset.seat,amount:+b.dataset.life}));
  document.querySelectorAll('[data-pc]').forEach(b=>{ b.onclick=()=>act(+b.dataset.seat,{type:'playercounter',target:+b.dataset.seat,kind:b.dataset.pc,amount:1}); b.oncontextmenu=e=>{e.preventDefault(); act(+b.dataset.seat,{type:'playercounter',target:+b.dataset.seat,kind:b.dataset.pc,amount:-1});}; });
  document.querySelectorAll('[data-addpc],[data-cmdd]').forEach(b=>b.onclick=()=>countersModal(+(b.dataset.addpc||b.dataset.cmdd)));
  document.querySelectorAll('[data-pile]').forEach(b=>b.onclick=e=>pileMenu(e,+b.dataset.seat,b.dataset.pile));
  const all=allCards();
  document.querySelectorAll('#game .card[data-iid]').forEach(el=>{ const c=all[el.dataset.iid]; if(!c) return;
    el.onmouseenter=()=>preview(c);
    el.onclick=e=>{ e.stopPropagation(); if(selectMode){ if(c.zone!==selectMode.zone) return; const i=selectMode.sel.indexOf(c.iid); if(i>=0) selectMode.sel.splice(i,1); else if(selectMode.sel.length<selectMode.n) selectMode.sel.push(c.iid); render(); return; } cardMenu(e,c); };
    el.oncontextmenu=e=>{ e.preventDefault(); cardMenu(e,c); };
    el.ondblclick=e=>{ e.stopPropagation(); hideMenu(); if(c.zone==='battlefield') act(actor(c),{type:c.tapped?'untap':'tap',card:c.iid}); else if(c.zone==='hand'&&c.owner===me) act(me,{type:'play',card:c.iid}); else if(c.zone==='stack') act(c.controller,{type:'resolve',card:c.iid}); else zoom(c); };
    el.ondragstart=e=>{ e.dataTransfer.setData('text/plain',c.iid); };
  });
  document.querySelectorAll('[data-drop]').forEach(z=>{
    z.ondragover=e=>{ e.preventDefault(); z.classList.add('drop'); }; z.ondragleave=()=>z.classList.remove('drop');
    z.ondrop=e=>{ e.preventDefault(); z.classList.remove('drop'); const iid=e.dataTransfer.getData('text/plain'); const c=allCards()[iid]; if(!c) return; const to=z.dataset.drop; if(c.zone===to && to!=='battlefield') return;
      if(to==='battlefield' && c.zone==='battlefield'){ const ts=+z.dataset.seat; if(ts!==c.controller) act(c.controller,{type:'control',card:iid,target:ts}); return; }
      if(to==='battlefield' && c.zone==='hand') return act(actor(c),{type:'play',card:iid});
      act(actor(c),{type:'move',card:iid,to,toPlayer:z.dataset.seat?+z.dataset.seat:undefined}); };
  });
}
document.addEventListener('click',e=>{ if(!e.target.closest('#menu')) hideMenu(); });
function preview(c){ const d=c.id&&cardsById[c.id]; const f=d&&d.faces&&d.faces[c.faceIndex||0]; const img=d&&((f&&f.image)||d.image); $('#preview').innerHTML=img?`<img src="${esc(img)}">`:`<div class="ph">${esc(c.name||'Hidden card')}</div>`; }

// ---------------- menus ----------------
function hideMenu(){ $('#menu').classList.add('hidden'); }
function showMenu(e, title, items){
  const m=$('#menu'); m.innerHTML=`<div class="hd">${esc(title)}</div>`+items.filter(Boolean).map((it,i)=>`<div class="it" data-i="${i}">${esc(it[0])}</div>`).join('');
  const list=items.filter(Boolean); m.querySelectorAll('.it').forEach(d=>d.onclick=ev=>{ ev.stopPropagation(); const it=list[+d.dataset.i]; if(Array.isArray(it[1])) showMenu(e,it[0],it[1]); else { hideMenu(); it[1](); } });
  m.classList.remove('hidden'); const x=Math.min(e.clientX, innerWidth-220), y=Math.min(e.clientY, innerHeight-m.offsetHeight-10); m.style.left=x+'px'; m.style.top=Math.max(5,y)+'px';
}
const seatsList=()=>Object.values(S.seats);
function moveItems(c){ const a=actor(c); const mv=(to,extra={})=>()=>act(a,{type:'move',card:c.iid,to,...extra});
  return [ c.zone!=='hand'&&['To hand',mv('hand')], c.zone!=='battlefield'&&['To battlefield',mv('battlefield')], c.zone!=='battlefield'&&['To battlefield tapped',mv('battlefield',{tapped:true})], c.zone!=='graveyard'&&['To graveyard',mv('graveyard')], c.zone!=='exile'&&['Exile',mv('exile')],
    ['Library: top',mv('library',{position:'top'})], ['Library: bottom',mv('library',{position:'bottom'})], ['Library: shuffle in',mv('library',{position:'shuffle'})], c.zone!=='command'&&['To command zone',mv('command')], c.zone!=='stack'&&['To stack',mv('stack')] ]; }
function cardMenu(e, c){
  if(c.name==='Face-down card' && c.controller!==me) return showMenu(e,'Face-down card',[['Tap / untap',()=>act(c.controller,{type:c.tapped?'untap':'tap',card:c.iid})],['Move…',moveItems(c)]]);
  const a=actor(c); const d=c.id&&cardsById[c.id]; const items=[['🔍 Zoom & rulings',()=>zoom(c)]];
  if(c.zone==='battlefield'){
    items.push([c.tapped?'Untap':'Tap',()=>act(a,{type:c.tapped?'untap':'tap',card:c.iid})]);
    items.push(['⚔ Attack…',seatsList().filter(s=>s.seat!==c.controller).map(s=>[s.name,()=>act(a,{type:'attack',card:c.iid,target:s.seat})])]);
    const attackers=Object.values(allCards()).filter(x=>x.zone==='battlefield'&&x.attacking&&x.controller!==c.controller);
    if(attackers.length) items.push(['🛡 Block…',attackers.map(x=>[`${x.name} (${seatName(x.controller)})`,()=>act(a,{type:'block',card:c.iid,attacker:x.iid})])]);
    if(c.attacking) items.push(['Remove from combat',()=>act(a,{type:'unattack',card:c.iid})]);
    items.push(['Counters…',[['+1/+1',()=>act(a,{type:'counter',card:c.iid,kind:'+1/+1',amount:1})],['−1/−1',()=>act(a,{type:'counter',card:c.iid,kind:'-1/-1',amount:1})],['Remove a +1/+1',()=>act(a,{type:'counter',card:c.iid,kind:'+1/+1',amount:-1})],['Loyalty +1',()=>act(a,{type:'counter',card:c.iid,kind:'loyalty',amount:1})],['Loyalty −1',()=>act(a,{type:'counter',card:c.iid,kind:'loyalty',amount:-1})],
      ['Other counter…',()=>{ const k=prompt('Counter kind (charge, lore, shield, stun, oil, time, …)','charge'); if(!k) return; const n=prompt('Amount (negative removes)','1'); if(n) act(a,{type:'counter',card:c.iid,kind:k.toLowerCase(),amount:+n}); }],
      ...Object.keys(c.counters||{}).map(k=>[`Remove all ${k}`,()=>act(a,{type:'counter',card:c.iid,kind:k,amount:-c.counters[k]})])]]);
    items.push(['P/T modifier…',()=>{ const v=prompt('Modifier like +2/+2 (0/0 clears)','+1/+1'); const m=v&&v.match(/([+-]?\d+)\/([+-]?\d+)/); if(m) act(a,{type:'pt',card:c.iid,power:+m[1],toughness:+m[2]}); }]);
    if(d&&d.faces&&d.faces.length>1) items.push(['↻ Transform / flip',()=>act(a,{type:'transform',card:c.iid})]);
    if(d&&d.tokens&&d.tokens.length) items.push(['Make its token…',d.tokens.map(t=>[t.name,()=>act(a,{type:'token',id:t.id,count:1})])]);
    items.push([c.faceDown?'Turn face up':'Turn face down',()=>act(a,{type:c.faceDown?'faceup':'facedown',card:c.iid})]);
    items.push(['Copy (token)',()=>act(a,{type:'copy',card:c.iid})]);
    items.push(['Give control to…',seatsList().filter(s=>s.seat!==c.controller).map(s=>[s.name,()=>act(a,{type:'control',card:c.iid,target:s.seat})])]);
    items.push(['Note…',()=>{ const t=prompt('Note on this card (blank clears)',c.note||''); if(t!==null) act(a,{type:'note',card:c.iid,text:t}); }]);
    items.push(['Move…',moveItems(c)]);
  } else if(c.zone==='hand'){
    items.push(['▶ Play (battlefield / stack)',()=>act(a,{type:'play',card:c.iid})],['Cast to stack',()=>act(a,{type:'cast',card:c.iid})],['Play tapped',()=>act(a,{type:'play',card:c.iid,tapped:true})],
      d&&d.faces&&d.faces.length>1&&['Play back face',()=>act(a,{type:'play',card:c.iid,face:1})],
      ['Play face down',()=>act(a,{type:'move',card:c.iid,to:'battlefield',faceDown:true})],['Discard',()=>act(a,{type:'move',card:c.iid,to:'graveyard'})],['Reveal',()=>act(a,{type:'reveal',card:c.iid})],['Move…',moveItems(c)]);
  } else if(c.zone==='stack'){
    items.push(['Resolve',()=>act(c.controller,{type:'resolve',card:c.iid})],['Counter it',()=>act(c.controller,{type:'counterspell',card:c.iid})],['Copy spell',()=>act(me,{type:'copy',card:c.iid})],['Move…',moveItems(c)]);
  } else if(c.zone==='command'){
    items.push(['▶ Cast commander',()=>act(a,{type:'play',card:c.iid})],['Cast to stack',()=>act(a,{type:'cast',card:c.iid})],['Move…',moveItems(c)]);
  } else if(c.zone==='library'){
    items.push(['Top',()=>act(a,{type:'top',card:c.iid})],['Bottom',()=>act(a,{type:'bottom',card:c.iid})],['To hand',()=>act(a,{type:'move',card:c.iid,to:'hand'})],['To graveyard',()=>act(a,{type:'move',card:c.iid,to:'graveyard'})],['To battlefield',()=>act(a,{type:'move',card:c.iid,to:'battlefield'})],['Exile',()=>act(a,{type:'move',card:c.iid,to:'exile'})],['Play / cast',()=>act(a,{type:'play',card:c.iid,from:'library'})]);
  } else { items.push(['Cast / play from here',()=>act(a,{type:'play',card:c.iid,from:c.zone})],...moveItems(c)); }
  showMenu(e, c.name, items);
}
function pileMenu(e, seat, zone){
  const mine=seat===me; const s=S.seats[seat];
  if(zone==='library'){
    const items=[['Draw 1',()=>act(seat,{type:'draw',n:1})],['Draw X…',()=>{ const n=prompt('Draw how many?','2'); if(n) act(seat,{type:'draw',n:+n}); }],
      mine&&['🔎 Search library (shuffles after)',()=>openZone(seat,'library')],['Scry / look at top X…',()=>{ const n=prompt('Look at how many?','1'); if(n) act(seat,{type:'scry',n:+n}); }],
      ['Mill X…',()=>{ const n=prompt('Mill how many?','1'); if(n) act(seat,{type:'mill',n:+n,target:seat}); }],['Shuffle',()=>act(seat,{type:'shuffle'})],['Reveal top card',()=>act(seat,{type:'reveal',card:'top'})],
      ['Add a card by name…',async()=>{ const n=prompt('Card name (fetched from Scryfall) to add to '+s.name+"'s hand"); if(n){ try{ await api('api/addcard',{seat,name:n,zone:'hand'}); refresh(true);}catch(er){toast(er.message);} } }]];
    if(!mine) items.splice(0,2); // only draw for your own seat from the UI
    return showMenu(e, s.name+"'s library", items);
  }
  if(zone==='hand' && !mine) return showMenu(e, s.name+"'s hand", [['Reveal hand (bot shows it)',()=>act(seat,{type:'reveal',card:'hand'})]]);
  if(zone==='graveyard') return showMenu(e, s.name+"'s graveyard", [['View',()=>openZone(seat,zone)],mine&&['Shuffle graveyard into library',()=>act(seat,{type:'shufflegraveyard'})]]);
  openZone(seat, zone);
}
async function openZone(seat, zone, rerender){
  const s=S.seats[seat]; let cards=s.zones[zone]||[];
  if(zone==='library'){ const st=await api(`api/state?seat=${me}&library=1`); cards=st.seats[me].zones.library||[]; Object.assign(cardsById,st.cardData); }
  zoneOpen={seat,zone,cards};
  const body=`<h3>${esc(s.name)} — ${esc(zone)} (${cards.length})</h3>${zone==='library'?'<div class="mut small">Taking any card except the top one shuffles the library automatically. <button id="zshuf">Close &amp; shuffle</button></div>':''}
    <div class="zgrid" style="margin-top:8px">${cards.map(c=>`<div class="zitem">${cardEl(c)}<div class="small">${esc(c.name)}</div></div>`).join('')||'<span class="mut">Empty</span>'}</div>`;
  showModal(body, ()=>{ zoneOpen=null; });
  if($('#zshuf')) $('#zshuf').onclick=()=>{ closeModal(); act(seat,{type:'shuffle'}); };
  const all=Object.fromEntries(cards.map(c=>[c.iid,c]));
  document.querySelectorAll('#modalbody .card[data-iid]').forEach(el=>{ const c=all[el.dataset.iid]; el.onmouseenter=()=>preview(c); el.onclick=e=>{ e.stopPropagation(); cardMenu(e,c); }; });
}
function showModal(html, onclose){ $('#modalbody').innerHTML=html; $('#modal').classList.remove('hidden'); $('#modal')._onclose=onclose; }
function closeModal(){ $('#modal').classList.add('hidden'); const f=$('#modal')._onclose; $('#modal')._onclose=null; if(f) f(); }
$('#modalclose').onclick=closeModal; $('#modal').onclick=e=>{ if(e.target.id==='modal') closeModal(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ hideMenu(); if(!$('#modal').classList.contains('hidden')) closeModal(); } });

// ---------------- zoom ----------------
async function zoom(c){
  const d=c.id&&cardsById[c.id]; if(!d){ showModal(`<h3>${esc(c.name)}</h3>${c.custom?esc(c.custom.type||''):''}`); return; }
  const faces=d.faces&&d.faces.length?d.faces:[d]; const imgs=d.faces&&d.faces.some(f=>f.image)?d.faces.map(f=>f.image):[d.image];
  showModal(`<div class="zoom"><div>${imgs.filter(Boolean).map(i=>`<img src="${esc(i)}">`).join('<br>')}</div><div class="txt">${faces.map(f=>`<h3 style="margin:0">${esc(f.name)} <span class="mut">${esc(f.mana_cost||'')}</span></h3><div class="mut">${esc(f.type_line||'')}${f.power!==undefined&&f.power!==null?' — '+esc(f.power+'/'+f.toughness):''}${f.loyalty?' — Loyalty '+esc(f.loyalty):''}</div><p>${esc(f.oracle_text||'')}</p>`).join('<hr>')}
    <a href="${esc(d.scryfall_uri||'#')}" target="_blank">Open on Scryfall</a><h4>Rulings</h4><div id="rulings" class="mut">Loading…</div></div></div>`);
  try{ const r=await api('api/rulings?id='+encodeURIComponent(c.id)); $('#rulings').innerHTML=r.length?r.map(x=>`<div class="ruling"><b>${esc(x.date)}</b> ${esc(x.text)}</div>`).join(''):'No rulings for this card.'; }catch(e){ if($('#rulings')) $('#rulings').textContent='Could not load rulings.'; }
}

// ---------------- tokens ----------------
function tokenModal(seat){
  const rel=[]; const my=S.seats[seat]; for(const c of [...my.zones.battlefield,...my.zones.hand,...my.zones.command]){ const d=c.id&&cardsById[c.id]; if(d&&d.tokens) for(const t of d.tokens) if(!rel.find(x=>x.id===t.id)) rel.push(t); }
  showModal(`<h3>Create token</h3><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">For <select id="tseat">${seatsList().map(s=>`<option value="${s.seat}" ${s.seat===seat?'selected':''}>${esc(s.name)}</option>`).join('')}</select> Count <input id="tcount" type="number" value="1" min="1" max="50" style="width:60px"><label><input type="checkbox" id="ttapped"> tapped</label></div>
   ${rel.length?`<div style="margin:8px 0"><b>Tokens your cards make:</b> ${rel.map(t=>`<button data-tid="${t.id}">${esc(t.name)}</button>`).join(' ')}</div>`:''}
   <div style="display:flex;gap:6px;margin:8px 0"><input id="tq" placeholder="Search Scryfall tokens: Treasure, Goblin, 2/2 Zombie, Food, Clue…" style="flex:1"><button id="tgo" class="pri">Search</button></div>
   <div class="mut small">Or quick-make by name (e.g. "3/3 Beast"): <button id="tname">Make by name</button></div><div id="tres" class="zgrid" style="margin-top:8px"></div>`);
  const mk=(id,name)=>{ const s=+$('#tseat').value, n=+$('#tcount').value||1, t=$('#ttapped').checked; closeModal(); act(s, id?{type:'token',id,count:n,tapped:t}:{type:'token',name,count:n,tapped:t}); };
  document.querySelectorAll('[data-tid]').forEach(b=>b.onclick=()=>mk(b.dataset.tid));
  $('#tname').onclick=()=>{ const q=$('#tq').value.trim(); if(q) mk(null,q); };
  const go=async()=>{ $('#tres').innerHTML='<span class="mut">Searching…</span>'; try{ const r=await api('api/tokens?q='+encodeURIComponent($('#tq').value)); $('#tres').innerHTML=r.map(t=>`<div class="zitem" data-tok="${t.id}" style="cursor:pointer" title="${esc(t.text||'')}">${t.image?`<img src="${esc(t.image)}" style="width:100%;border-radius:6px">`:''}<div class="small">${esc(t.name)} ${esc(t.pt)}</div></div>`).join('')||'<span class="mut">No tokens found.</span>'; document.querySelectorAll('[data-tok]').forEach(x=>x.onclick=()=>mk(x.dataset.tok)); }catch(e){ $('#tres').textContent=e.message; } };
  $('#tgo').onclick=go; $('#tq').onkeydown=e=>{ if(e.key==='Enter') go(); }; $('#tq').focus();
}

// ---------------- player counters / commander damage ----------------
function countersModal(seat){
  const s=S.seats[seat]; const cmdrs=[]; for(const o of seatsList()) for(const z of ['command','battlefield','graveyard','exile']) for(const c of o.zones[z]) if(c.isCommander) cmdrs.push(`${c.name} (${o.name})`);
  for(const k of Object.keys(s.cmdDamage||{})) if(!cmdrs.includes(k)) cmdrs.push(k);
  const kinds=['poison','energy','experience','rad','tickets'];
  showModal(`<h3>${esc(s.name)} — counters</h3><table class="cmdtbl">${kinds.map(k=>`<tr><td>${k}</td><td><button data-k="${k}" data-d="-1">−</button> <b>${(s.counters||{})[k]||0}</b> <button data-k="${k}" data-d="1">+</button></td></tr>`).join('')}</table>
   ${cmdrs.length?`<h4>Commander damage taken${S.cmdDmgLimit?` (lose at ${S.cmdDmgLimit})`:''}</h4><table class="cmdtbl">${cmdrs.filter(k=>!k.endsWith('('+s.name+')')).map(k=>`<tr><td>${esc(k)}</td><td><button data-c="${esc(k)}" data-d="-1">−</button> <b>${(s.cmdDamage||{})[k]||0}</b> <button data-c="${esc(k)}" data-d="1">+</button></td></tr>`).join('')}</table>`:''}`);
  document.querySelectorAll('#modalbody [data-k]').forEach(b=>b.onclick=async()=>{ await act(seat,{type:'playercounter',target:seat,kind:b.dataset.k,amount:+b.dataset.d}); countersModal(seat); });
  document.querySelectorAll('#modalbody [data-c]').forEach(b=>b.onclick=async()=>{ await act(seat,{type:'cmddamage',target:seat,from:b.dataset.c,amount:+b.dataset.d}); countersModal(seat); });
}
function settingsModal(){
  const st=S.settings; showModal(`<h3>Settings</h3><label><input type="checkbox" id="s1" ${st.autoUntap?'checked':''}> Auto-untap at the start of each turn</label><br><label><input type="checkbox" id="s2" ${st.autoDraw?'checked':''}> Auto-draw in the draw step</label><br><label><input type="checkbox" id="s3" ${st.commanderRedirect?'checked':''}> Commanders go to the command zone instead of graveyard/exile</label><br><br><button id="ssave" class="pri">Save</button>`);
  $('#ssave').onclick=()=>{ act(me,{type:'settings',autoUntap:$('#s1').checked,autoDraw:$('#s2').checked,commanderRedirect:$('#s3').checked}); closeModal(); };
}

// ---------------- bot relay ----------------
function relayModal(){
  const bots=seatsList().filter(s=>s.seat!==me);
  showModal(`<h3>🤖 Bot relay</h3><div class="mut small">Bots see only their own seat's view (their hand, plus everyone's public cards). Copy a bot's view into its chat, then paste its reply below. Bots that can use the shared computer can also run <code>node /workspace/mtg-vtt/bot.js view &lt;seat&gt;</code> and <code>node /workspace/mtg-vtt/bot.js act &lt;seat&gt; "…"</code> themselves.</div>
   <div style="margin:8px 0">Seat: <select id="rseat">${bots.map(s=>`<option value="${s.seat}" ${S.activeSeat===s.seat?'selected':''}>${esc(s.name)} (seat ${s.seat})</option>`).join('')}</select> <button id="rview" class="pri">Get view to send</button> <button id="rcopy">Copy</button></div>
   <textarea id="rtext" style="height:220px" readonly placeholder="The selected bot's view will appear here."></textarea>
   <h4>Paste the bot's moves (one per line)</h4><textarea id="rmove" style="height:110px" placeholder="play Forest&#10;cast Llanowar Elves&#10;attack Grizzly Bears -> Connor&#10;pass"></textarea>
   <div style="margin-top:6px"><button id="rapply" class="pri">Apply moves as this bot</button> <button id="rhelp">Action list</button></div><div id="rres" class="small" style="margin-top:6px"></div>`, null);
  const load=async()=>{ $('#rtext').value=await api('api/view?seat='+$('#rseat').value); };
  $('#rview').onclick=load; $('#rseat').onchange=load; if(bots.length) load();
  $('#rcopy').onclick=async()=>{ const t=$('#rtext'); t.select(); try{ await navigator.clipboard.writeText(t.value); toast('Copied!'); }catch{ document.execCommand('copy'); } };
  $('#rhelp').onclick=async()=>{ $('#rres').innerHTML=`<pre style="white-space:pre-wrap">${esc(await api('api/help'))}</pre>`; };
  $('#rapply').onclick=async()=>{ const seat=+$('#rseat').value; try{ const r=await api('api/act',{seat,text:$('#rmove').value}); $('#rres').innerHTML=r.results.map(x=>`<div class="${x.ok?'ok':'err'}">${x.ok?'✔':'✘'} ${esc(x.line)} ${esc(x.ok?(x.line==='help'?'':x.msg||''):x.error)}</div>`).join(''); if(r.results.every(x=>x.ok)) $('#rmove').value=''; await refresh(true); load(); }catch(e){ $('#rres').innerHTML=`<span class="err">${esc(e.message)}</span>`; } };
}

// ---------------- command line ----------------
const runCmd=()=>{ const v=$('#cmdinput').value.trim(); if(!v) return; $('#cmdinput').value=''; if(v.toLowerCase()==='help'){ api('api/help').then(h=>showModal(`<h3>Action format</h3><pre style="white-space:pre-wrap">${esc(h)}</pre>`)); return; } act(me,v); };
$('#cmdgo').onclick=runCmd; $('#cmdinput').onkeydown=e=>{ if(e.key==='Enter') runCmd(); };
refresh(true);
