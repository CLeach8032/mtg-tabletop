# Connor's MTG Virtual Tabletop

A Magic: The Gathering tabletop for Connor plus up to 3 bots. Card images, oracle text, and rulings come from Scryfall. Decks can be pasted as text or imported from an Archidekt link.

## Start / open
- Start the server: `bash /workspace/mtg-vtt/start.sh`. It's safe to run more than once.
- Open **http://localhost:8787** in the browser on the shared computer (the box).
- All state is saved in `data/`: `game.json`, `setup.json`, and a cache of Scryfall cards. Restarting the server keeps the game where it was.

## Setup screen
- Every seat (1–4) has an on/off box, a controller (Connor or a bot name), and a name you can edit.
- To load a deck, paste a list or an Archidekt link.
  - Pasted text: standard `1 Card Name` lines. These are all understood: `Commander` / `Deck` / `Sideboard` / `Companion` headers, `SB:` prefixes, `(SET) 123` printings, `*CMDR*`, and Archidekt's `[Commander{top}]` tags. Maybeboard lines are skipped.
  - Archidekt links: the deck has to be public. Commander, Sideboard, and Maybeboard categories are respected.
- Choose the format: Commander 40, Brawl 25/30, Oathbreaker 20, PDH 30, or Standard / Pioneer / Modern / Legacy / Vintage / Pauper / Historic / Timeless / Premodern / Casual at 20. The format sets starting life, whether there's a command zone, the commander-damage limit (21 in Commander, 16 in PDH), and the free first mulligan in multiplayer.

## Playing (UI)
- **Layout:** opponents sit at the top. Each shows life, counters, a hidden hand count, piles, the command zone, and the battlefield. You're at the bottom, your hand is below that, and the log and a hover preview are on the right.
- **Clicking a card** opens a menu. What's in it depends on where the card is:
  - Any card: zoom with rulings.
  - Battlefield: tap/untap, attack, block, counters, P/T changes, transform, face-down, copy, make its tokens, give control, notes, move.
  - Hand: play, cast, discard, reveal, move.
  - Stack: resolve or counter.
  - Command zone: cast your commander. Tax is tracked.
- **Double-click:** tap/untap on the battlefield, play from your hand, resolve on the stack.
- **Drag** cards onto the battlefield, your hand, piles, or the stack.
- **Piles:** click the library to draw, search (auto-shuffles), scry/look, mill, shuffle, or reveal the top card. Graveyard, exile, command, and sideboard each open a viewer.
- **Top bar:** phase tracker (click a phase to jump to it), Next ▸, End turn, d6/d20/dX, coin, + Token (Scryfall search plus the tokens your cards make), ⚔ Combat dmg, Undo, 🤖 Bot relay, ⚙ settings, New game.
- **Automatic rules:**
  - Libraries shuffle at game start, on mulligans, after searches, after any card is taken from below the top, after "shuffle into library," and when a resolving instant or sorcery says "shuffle" (not "may shuffle").
  - Untap and draw happen automatically. In a 2-player game, the first player skips their first draw.
  - Commanders go to the command zone instead of the graveyard or exile. You can turn this off.
  - Combat damage covers unblocked attackers, trample overflow, infect, toxic, lifelink, and commander damage.
  - A loss is flagged at 0 life, 10 poison, or the commander-damage limit.
- **Mulligans** use the London rule. On Keep you choose which cards go to the bottom. "Keep for all bots" and "Start now" are there to keep things moving.
- **Command line** (bottom): type any action from the list below for your own seat.

## Bots: seeing their seat and making moves
Each bot gets only **its own seat's view**: its hand, any cards it's looking at on top of its library, and everyone's public cards. Other players' hands and every library stay hidden, and so do private log lines.

**Option A, relay through chat:** click 🤖 Bot relay, pick the bot's seat, choose "Get view to send," copy it, and paste it into that bot's chat. Paste the bot's reply into "Paste the bot's moves," then click Apply.

**Option B, bots run commands themselves** (they share this computer):
```
node /workspace/mtg-vtt/bot.js view 2              # seat 2's text view (add --json for JSON)
node /workspace/mtg-vtt/bot.js act 2 "play Forest; cast Llanowar Elves; pass"
node /workspace/mtg-vtt/bot.js help                # full action list
```
Each seat's view is also written after every change to `data/views/seat-N.txt` (and `.json`).
Bots should only read their own `seat-N` view. `data/game.json` holds the full hidden state, and reading it is cheating.

### Action format
Write one action per line, or separate them with `;`. Name a card ("Llanowar Elves") or use its id ("c42"). Name a player by seat number, by name, or as "me".
```
draw [n] | mulligan | keep | keep bottom <card>, <card>
play <card> [tapped]        cast <card> [targeting <text>]       resolve | counter spell
tap <card>[, <card>] | untap <card> | untap all
attack <card>[, <card>] -> <player> | block <my card> -> <attacker> | combat damage
damage <player> <n> [from <card>] | life [player] +N/-N/=N | gain N | lose N
poison|energy|experience|rad [player] +N
counter <card> <kind> <+N/-N>  (e.g. counter Grizzly Bears +1/+1 2)   pump <card> +2/+2
token <name> [xN] [tapped] (e.g. token Treasure x2, token 2/2 Zombie) | copy <card>
move <card> [from <zone>] to <zone> [top|bottom|shuffle] [tapped]
discard | destroy | sacrifice | exile | bounce | reanimate <card> | return <card> to hand
search <card> [to hand|battlefield] [tapped]   (auto-shuffles)
mill [player] <n> | scry <n> | look <n> | surveil <n> -> top <card> | bottom <card> | done
reveal <card> | reveal hand | shuffle | transform <card> | facedown/faceup <card>
gain control <card> | note <card>: text | next | phase <name> | pass | roll d20 | flip coin | say <text> | concede
```
JSON works too: `{"type":"attack","card":"c12","target":2}`. Only the active player can use `next`, `phase`, or `pass`. Bots can't touch other players' hands or libraries. They *can* move other players' battlefield cards, which is how removal works.

## Limits
- This tabletop doesn't enforce the rules. It tracks state, and players apply effects themselves. It doesn't check mana, timing, or legality, and when blocked creatures fight, the players resolve that damage. Undo keeps the last 60 actions.
- It runs on the box at localhost:8787. To open it from another device, it would need a tunnel or a hosted copy.

## MCP connector (for Grok Bot)
- `bash start.sh` starts a supervisor (`supervise.sh`). It runs `mcp-server.js`, which serves the local app on 127.0.0.1:8787. It also opens a second listener on 127.0.0.1:8788 that needs the secret, and it tries to open a Cloudflare quick tunnel to that listener.
- The secret lives in `data/mcp-secret` (chmod 600). There are two ways to authenticate:
  - Put the secret in the path: `/s/<SECRET>/mcp` for MCP and `/s/<SECRET>/` for the web UI.
  - Send `Authorization: Bearer <SECRET>` and call `/mcp`.
- The current public URL is written to `data/connector-url.txt` (chmod 600), but only after the tunnel has been verified to work. Quick-tunnel URLs change every time it restarts.
- Tools:
  - Setup and decks: get_setup, import_deck, configure_seats
  - Game: start_game, end_game, get_seat_view, act, game_log, undo
  - Help and lookups: action_help, card_lookup, card_rulings, search_tokens, get_ui_link
- Transport: stateless Streamable HTTP over POST, with JSON responses.
