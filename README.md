# Underworld Empire

A first-person open-world business simulator for the browser (Three.js + Rapier + TypeScript + Vite).
You start in a rented house on Larch Street in the fictional city of Harlow, grow and mix fictional
products in your garage, win customers, take deals and stay out of sight of the police.

## Run it

```bash
npm install
npm run dev        # single player, http://localhost:5173
npm run serve      # builds, then runs the multiplayer server on http://localhost:8080
```

## Multiplayer

`server/server.mjs` has no dependencies: it serves the built game and relays players over WebSockets.
Open the game from the server's address, press **Multiplayer**, pick a name and a room code, and send
friends the same address and code. On a local network they can use `http://<your-ip>:8080`.

Deploy to Render like any Node web service (a `render.yaml` is included): build command
`npm install --include=dev && npm run build`, start command `npm start`. Friends then just open the
Render URL. The hosted Claude preview can't open network connections, so multiplayer only works from
the server.

What's shared: the streets, everyone's position and car, chat (T), item and cash trades (look at a
player and press E), and the host's clock. Each player runs their own business, customers and save.

`node tools/build-standalone.mjs ./node_modules/.bin/esbuild` builds a single HTML file that loads
Three.js and Rapier from jsDelivr (used for the hosted artifact build). It expects the MegaKit assets
next to it in `assets/megakit/`.

## Controls

| Key | Action |
|---|---|
| W A S D / Shift / Space | Move / sprint / jump |
| Mouse | Look (click the view to capture the mouse) |
| E | Interact, using the item in your hand |
| Tab | Inventory (drag, right-click to split, shift-click to move) |
| M | Phone |
| 1-4, 6-9, mouse wheel | Select hotbar slot |
| R | Hop on / off the skateboard |
| E (at a car) | Drive; aim at the back to open the trunk. E again to get out |
| T | Chat in multiplayer |
| G | Drop a carried object |
| 5 | Cheats: teleports, money, items, time, skip objectives, self-test |
| Esc | Pause (save, settings) |

## The loop

1. Mailbox: $400 to start.
2. Phone → Market: order seeds, soil, mixers, baggies. Deliveries arrive in the porch crate.
3. Garage: fill a grow pot with soil, plant a seed, water it, harvest Nightshade.
4. Mixing station: each mixer adds an effect and transforms existing ones (data in `src/products/Catalog.ts`). New combinations are discoveries you can name.
5. Packaging bench: baggies (1 unit) or jars (5 units).
6. Give strangers a free sample. If they like it they become customers with preferences, budgets and loyalty.
7. Customers text deal requests (Messages). Accept, meet them, hand over the goods. You can also sell face to face at a price you set.
8. Lifetime sales unlock new stock: jars, glitter, Ember Tip seeds, the Dreamdust kettle ($2,000) and the Neon press ($5,000).
9. Police patrol the sidewalks. They chase you if they see a handoff or catch you out after the 11pm curfew; being caught with product means confiscation and a fine.

## Code layout

```
src/core        Game loop, events, state, input, settings, time
src/world       City plan, terrain, roads, buildings, props, MegaKit loader
src/player      First-person controller (incl. skateboard), held-item view model
src/interaction Raycast interaction, doors, switches, carryable objects
src/inventory   Item containers (stack-safe moves, no duplication)
src/products    Item, effect and mixer definitions; variant registry
src/production  Grow pots, mixing station, packaging bench, kettle, press, storage
src/economy     Central cash ledger and the supplier market
src/business    Customers, deals, sales, police heat
src/npc         Pedestrians and police officers
src/ui          HUD, phone, panels, menus
src/save        IndexedDB saves (versioned)
src/debug       In-game automated self-test (cheats → Diagnostics)
```

## Expansion

- **Customers** each want only so much at a time; their need refills over about a day. Haggle in
  person (offer, get countered, accept or walk) or counter deal texts in Messages.
- **Properties**: Suds & Sons Laundromat ($6,000), Cedar Ridge Barn ($12,000), Ironworks Unit 4
  ($22,000). For-sale signs out front, locked until you buy; running costs daily. Order equipment
  and supplies to any property from the Market.
- **Staff** (Staff app): Botanist, Chemist, Packager, Dealer, Manager. They walk around their
  property and work its stations from the storage shelf. Shifts, training, daily wages, they quit if
  unpaid.
- **Cars** (Cars app): hatchback, van, coupe; pick a colour; trunks for moving stock.
- **Turf**: Copperheads (Ironworks), Velvet Syndicate (Market Row, Meridian), Ridge Runners
  (Cedar Ridge, Maple Hill). Sales move influence; hostile gangs shake you down. Pay tribute or buy
  them out of a district.

## Graphics

- **Surfaces**: HD tiling colour, normal and roughness maps for grass, dirt, rock, asphalt, paving
  and bark, plus leaf, needle and flower textures. All original, generated by
  `python3 tools/gen-textures.py` into `public/assets/tex/`.
- **Terrain**: one shader blends grass, dirt, rock and river mud by slope, district and noise, with
  normal mapping, height-aware transitions and anti-tiling.
- **Grass**: GPU-instanced tufts and wild flowers around the camera (High and Ultra), coloured from
  the ground texture, swaying in the wind and pushed aside as you walk through.
- **Trees**: stylised pines and leaf-card broadleaf trees in several seeded variants, swaying in the wind.
- **Light**: physical sky with a deeper zenith, sun shadows (4096 px on Ultra), sky reflections,
  bloom and colour grading. Graphics: Low / High / Ultra in Settings.

## Credits

City buildings, street props and property textures: Downtown City MegaKit by Quaternius (CC0).
Characters and animations: Ultimate Modular Men by Quaternius (CC0). https://quaternius.com
