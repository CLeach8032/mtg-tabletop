// Public entry: starts the local app (127.0.0.1:8787, via server.js) plus a secret-protected
// listener on 127.0.0.1:8788 for the tunnel, serving the MCP endpoint and the web UI.
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = require('zod');
const app = require('./server.js');
const E = require('./engine.js');
const DATA=path.join(__dirname,'data'); const SECRET_FILE=path.join(DATA,'mcp-secret');
const PUBLIC_PORT=+(process.env.PORT||process.env.PUBLIC_PORT||8788); const PUBLIC_HOST=process.env.PORT?'0.0.0.0':'127.0.0.1';

let SECRET=(process.env.MCP_SECRET||'').trim();
if(!SECRET){ if(!fs.existsSync(SECRET_FILE)){ fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), {mode:0o600}); } fs.chmodSync(SECRET_FILE,0o600); SECRET=fs.readFileSync(SECRET_FILE,'utf8').trim(); }
if(SECRET.length<32) throw new Error('MCP_SECRET must be at least 32 characters.');
const safeEq=(a,b)=>{ const A=Buffer.from(String(a)), B=Buffer.from(String(b)); return A.length===B.length && crypto.timingSafeEqual(A,B); };
const readUrl=()=>{ if(process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/,''); try{ return fs.readFileSync(path.join(DATA,'public-base.txt'),'utf8').trim(); }catch{ return null; } };

const txt=o=>({content:[{type:'text',text: typeof o==='string'?o:JSON.stringify(o,null,2)}]});
const fail=e=>({content:[{type:'text',text:'Error: '+(e&&e.message||e)}],isError:true});
const wrap=fn=>async(args)=>{ try{ return txt(await fn(args||{})); }catch(e){ return fail(e); } };
const needGame=()=>{ const g=app.ctx.game; if(!g) throw new Error('No game in progress. Use start_game first.'); return g; };
const fmtKeys=Object.keys(E.FORMATS);

function buildMcp(){
  const s=new McpServer({name:'mtg-tabletop',version:'1.0.0'},{instructions:'Magic: The Gathering virtual tabletop for Connor and his bots. Flow: get_setup -> import_deck per seat -> configure_seats (names/bots/format) -> start_game -> each player uses get_seat_view(seat) and act(seat, commands). Hidden info: only request the view of the seat you are playing. Call action_help for the command grammar.'});
  s.registerTool('get_setup',{title:'Get setup',description:'Show the 4 seats (enabled, name, controller/bot), loaded decks, the chosen format, available formats, and whether a game is running.',inputSchema:{}},
    wrap(async()=>({...app.api.publicSetup(), gameInProgress:!!app.ctx.game})));
  s.registerTool('import_deck',{title:'Import deck',description:'Load a deck into a seat (1-4) from pasted text ("1 Card Name" lines; Commander/Deck/Sideboard sections, SB:, (SET) 123, *CMDR* supported) or from a public Archidekt deck link. Cards are resolved on Scryfall.',
    inputSchema:{seat:z.number().int().min(1).max(4),text:z.string().optional().describe('Decklist text'),archidekt_url:z.string().optional().describe('https://archidekt.com/decks/<id>/...'),name:z.string().optional()}},
    wrap(async a=>{ if(a.archidekt_url) return app.api.importDeckUrl(a.seat,a.archidekt_url); if(a.text) return app.api.importDeckText(a.seat,a.text,a.name); throw new Error('Give text or archidekt_url.'); }));
  s.registerTool('configure_seats',{title:'Assign seats / format',description:'Assign seats to Connor or bots, rename seats, enable/disable seats, remove decks, choose the format and who goes first. Takes effect for the next start_game.',
    inputSchema:{format:z.enum(fmtKeys).optional(),first_seat:z.number().int().min(1).max(4).nullable().optional().describe('null = random'),
      seats:z.array(z.object({seat:z.number().int().min(1).max(4),enabled:z.boolean().optional(),name:z.string().optional(),controller:z.string().optional().describe('Connor, Jess, Mia, Theo, Nate, ...'),clear_deck:z.boolean().optional()})).optional()}},
    wrap(async a=>{ const b={}; if(a.format) b.format=a.format; if(a.first_seat!==undefined) b.firstSeat=a.first_seat; if(a.seats) b.seats=a.seats.map(x=>({seat:x.seat,enabled:x.enabled,name:x.name,controller:x.controller,clearDeck:x.clear_deck})); return app.api.configure(b); }));
  s.registerTool('start_game',{title:'Start / new game',description:'Start a new game with the loaded decks (ends any current game). Shuffles libraries and deals 7 to everyone; then each seat must "keep" or "mulligan" via act.',
    inputSchema:{format:z.enum(fmtKeys).optional()}},
    wrap(async a=>{ const g=app.api.startGame(a.format); return `Started ${E.FORMATS[g.format].label} with seats ${Object.values(g.seats).map(x=>x.seat+' '+x.name).join(', ')}. ${g.seats[g.firstSeat].name} goes first. Everyone has 7 cards; each seat should act "keep" or "mulligan".`; }));
  s.registerTool('end_game',{title:'End game',description:'End the current game (saved to data/last-game.json).',inputSchema:{}},wrap(async()=>{ app.api.endGame(); return 'Game ended.'; }));
  s.registerTool('get_seat_view',{title:'Get seat view',description:"A seat's view of the game: its own hand and peeked cards, plus everyone's public zones. Other hands and libraries stay hidden. Use only for the seat you are playing.",
    inputSchema:{seat:z.number().int().min(1).max(4),format:z.enum(['text','json']).optional()}, annotations:{readOnlyHint:true}},
    wrap(async a=>{ const g=needGame(); if(!g.seats[a.seat]) throw new Error(`Seat ${a.seat} is not in this game.`); return a.format==='json'? E.view(g,app.ctx.db,a.seat,{logN:60}) : E.textView(g,app.ctx.db,a.seat); }));
  s.registerTool('act',{title:'Act for a seat',description:'Submit one or more actions for a seat, one per line or separated by ";". Examples: "play Forest", "cast Lightning Bolt targeting seat 2", "attack Grizzly Bears -> Connor", "token Treasure x2", "counter c12 +1/+1 1", "combat damage", "keep bottom c3, c9", "pass". Call action_help for the full grammar.',
    inputSchema:{seat:z.number().int().min(1).max(4),commands:z.string()}},
    wrap(async a=>{ needGame(); const r=await app.api.runPrepared(a.seat,{text:a.commands}); return r.map(x=>(x.ok?'OK   ':'FAIL ')+x.line+(x.ok?(x.msg?' -> '+x.msg:''):' -> '+x.error)).join('\n'); }));
  s.registerTool('action_help',{title:'Action grammar',description:'The full action command list for act.',inputSchema:{},annotations:{readOnlyHint:true}},wrap(async()=>E.HELP));
  s.registerTool('game_log',{title:'Game log',description:'Recent game log lines. Pass seat to also include that seat\'s private lines (e.g. what it drew).',
    inputSchema:{seat:z.number().int().min(1).max(4).optional(),limit:z.number().int().min(1).max(500).optional()},annotations:{readOnlyHint:true}},
    wrap(async a=>{ const g=needGame(); const lim=a.limit||40; return g.log.filter(e=>e.vis===null||e.vis===undefined||(a.seat&&e.vis===a.seat)).slice(-lim).map(e=>e.text).join('\n'); }));
  s.registerTool('undo',{title:'Undo',description:'Undo the last action (up to 60 back).',inputSchema:{}},wrap(async()=>{ needGame(); app.api.undo(); return 'Undone.'; }));
  s.registerTool('card_lookup',{title:'Card lookup',description:'Look up a card on Scryfall by name (fuzzy): oracle text, type, mana cost, P/T, faces, image link, and optionally rulings.',
    inputSchema:{name:z.string(),rulings:z.boolean().optional()},annotations:{readOnlyHint:true}},
    wrap(async a=>{ const c=await app.api.cardLookup(a.name); if(!c) throw new Error('Card not found on Scryfall.'); const out={name:c.name,mana_cost:c.mana_cost,type_line:c.type_line,oracle_text:c.oracle_text,power:c.power,toughness:c.toughness,loyalty:c.loyalty,faces:c.faces,image:c.image,scryfall:c.scryfall_uri,tokens:c.tokens}; if(a.rulings) out.rulings=await app.api.rulingsFor(c.id); return out; }));
  s.registerTool('card_rulings',{title:'Card rulings',description:'Official rulings for a card by name, from Scryfall.',inputSchema:{name:z.string()},annotations:{readOnlyHint:true}},
    wrap(async a=>{ const c=await app.api.cardLookup(a.name); if(!c) throw new Error('Card not found.'); const r=await app.api.rulingsFor(c.id); return {card:c.name,rulings:r.length?r:'No rulings.'}; }));
  s.registerTool('search_tokens',{title:'Search tokens',description:'Search Scryfall tokens (e.g. "Treasure", "2/2 Zombie"). To create one in game use act with "token <name> xN".',inputSchema:{query:z.string()},annotations:{readOnlyHint:true}},
    wrap(async a=>(await app.api.tokenSearch(a.query)).slice(0,15).map(t=>`${t.name} ${t.pt} — ${t.type}${t.text?': '+t.text:''}`).join('\n')||'No tokens found.'));
  s.registerTool('get_ui_link',{title:'Web UI link',description:'The link to the visual tabletop web page (shows Connor\'s hand and every battlefield).',inputSchema:{},annotations:{readOnlyHint:true}},
    wrap(async()=>{ const b=readUrl(); return b?`${b}/s/${SECRET}/`:'Public URL not available yet; on the box use http://localhost:8787'; }));
  return s;
}

function readBody(req){ return new Promise((ok,bad)=>{ let d=''; req.on('data',c=>{ d+=c; if(d.length>5e6) req.destroy(); }); req.on('end',()=>{ try{ ok(d?JSON.parse(d):undefined); }catch(e){ bad(e); } }); }); }
async function handleMcp(req,res){
  if(req.method!=='POST'){ res.writeHead(405,{'Content-Type':'application/json','Allow':'POST'}); return res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed (stateless server; use POST).'},id:null})); }
  const server=buildMcp(); const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true});
  res.on('close',()=>{ transport.close(); server.close(); });
  try{ await server.connect(transport); const body=await readBody(req); await transport.handleRequest(req,res,body); }
  catch(e){ if(!res.headersSent){ res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32700,message:'Bad request: '+e.message},id:null})); } }
}
const pub=http.createServer(async (req,res)=>{
  const u=new URL(req.url,'http://x'); let p=u.pathname;
  if(p==='/healthz'){ res.writeHead(200,{'Content-Type':'text/plain'}); return res.end('ok'); }
  const auth=req.headers['authorization']||''; const bearerOk=auth.startsWith('Bearer ') && safeEq(auth.slice(7).trim(),SECRET);
  const m=p.match(/^\/s\/([^/]+)(\/.*)?$/); let ok=bearerOk;
  if(m){ if(!safeEq(decodeURIComponent(m[1]),SECRET)){ res.writeHead(404); return res.end('Not found'); } ok=true; if(!m[2]){ res.writeHead(302,{Location:p+'/'}); return res.end(); } p=m[2]; }
  if(!ok){ res.writeHead(401,{'Content-Type':'text/plain','WWW-Authenticate':'Bearer'}); return res.end('Unauthorized'); }
  if(p==='/mcp'||p==='/mcp/') return handleMcp(req,res);
  req.url=p+(u.search||''); return app.handler(req,res);
});
pub.listen(PUBLIC_PORT,PUBLIC_HOST,()=>console.log(`MTG VTT public (secret-protected) listener on ${PUBLIC_HOST}:${PUBLIC_PORT}`));
