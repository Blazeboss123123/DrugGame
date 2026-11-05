import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Door, LightSwitch, Pickup, RollerDoor } from '../interaction/Objects';
import { RAPIER } from '../physics/Physics';
import { STARTER } from '../world/CityGenerator';
import { Z_LINES, bridgeSpan, riverX } from '../world/CityPlan';

export interface SelfTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SelfTestReport {
  pass: boolean;
  passed: number;
  failed: number;
  results: SelfTestResult[];
  ms: number;
}

/**
 * Automated gameplay checks that run inside the real game: physics vs terrain agreement, landing on
 * every kind of surface, walls, doors, stairs, bridges, lights and carrying objects.
 * Run from the console with `await __UE.selfTest()`.
 */
export async function runSelfTest(game: Game): Promise<SelfTestReport> {
  const t0 = performance.now();
  const results: SelfTestResult[] = [];
  const { player, physics, world, interaction, input } = game;
  const hm = world.hm;
  const prevMode = game.mode;
  game.mode = 'playing';
  const dt = 1 / 60;
  const sim = async (seconds: number, axis = { forward: 0, right: 0, sprint: false, jump: false }) => {
    input.override = axis;
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) {
      game.tick(dt);
      if (i % 120 === 119) await new Promise((r) => setTimeout(r, 0));
    }
    input.override = null;
  };
  const record = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const rescues0 = player.rescues;
  const origin = world.starter.origin;

  // 1. Heightfield collider matches the rendered terrain.
  {
    let maxErr = 0;
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const x = -400 + ((i * 137.5) % 800);
      const z = -400 + ((i * 251.3) % 800);
      const h = hm.get(x, z);
      const ray = new RAPIER.Ray({ x, y: h + 60, z }, { x: 0, y: -1, z: 0 });
      const hit = physics.world.castRay(ray, 200, true, undefined, undefined, undefined, undefined, (c) => !!physics.infoOf(c)?.terrain);
      if (!hit) continue;
      const toi = (hit as unknown as { timeOfImpact?: number; toi?: number }).timeOfImpact ?? (hit as unknown as { toi: number }).toi;
      maxErr = Math.max(maxErr, Math.abs(h + 60 - toi - h));
      checked++;
    }
    record('Terrain collider matches visible ground', checked > 50 && maxErr < 0.2, `${checked} samples, max error ${maxErr.toFixed(3)} m`);
  }

  // 2. Landing on different surfaces.
  const span = bridgeSpan(Z_LINES[3]);
  const deckMid = (hm.get(span.xa, Z_LINES[3]) + hm.get(span.xb, Z_LINES[3])) / 2 + 0.06;
  const plazaTop = hm.get(37.5, -37.5) + 2.4;
  const drops: [string, number, number, number][] = [
    ['spawn sidewalk', world.starter.spawn.x, world.starter.spawn.z, world.starter.spawn.y],
    ['downtown road', 0, -37, hm.get(0, -37) + 0.06],
    ['steep residential street', -150, -260, hm.get(-150, -260) + 0.06],
    ['bridge deck', (span.xa + span.xb) / 2, Z_LINES[3], deckMid],
    ['plaza platform', 37.5, -27, plazaTop],
    ['outskirts ridge', -430, -420, hm.get(-430, -420)],
    ['industrial road', 75, 262, hm.get(75, 262) + 0.06],
  ];
  for (const [name, x, z, expected] of drops) {
    player.teleport(x, expected + 3, z, 0);
    await sim(2.2);
    const err = player.position.y - expected;
    record(`Lands on ${name}`, player.grounded && Math.abs(err) < 0.35, `grounded=${player.grounded}, offset ${err.toFixed(2)} m`);
  }

  // 3. Walking along a hilly road follows the surface.
  {
    const x = 0;
    const z = -160;
    player.teleport(x, hm.get(x, z) + 0.2, z, 0);
    await sim(0.3);
    let maxGap = 0;
    input.override = { forward: 1, right: 0, sprint: true, jump: false };
    for (let i = 0; i < 360; i++) {
      game.tick(dt);
      if (player.grounded) maxGap = Math.max(maxGap, Math.abs(player.position.y - hm.get(player.position.x, player.position.z) - 0.06));
    }
    input.override = null;
    const dist = Math.abs(player.position.z - z);
    record('Sprints along a hilly avenue', dist > 30 && maxGap < 0.4, `travelled ${dist.toFixed(1)} m, max surface gap ${maxGap.toFixed(2)} m`);
  }

  // 4. Solid walls.
  {
    player.teleport(origin.x + 7, hm.get(origin.x + 7, origin.z) + 0.1, origin.z, Math.PI / 2);
    await sim(2.5, { forward: 1, right: 0, sprint: true, jump: false });
    const lx = player.position.x - origin.x;
    record('House wall blocks the player', lx > 6.3, `stopped at local x ${lx.toFixed(2)} (wall face 6.1)`);
  }

  // 5. Front door: blocks when closed, opens with E, lets the player in.
  {
    const door = interaction.items.find((i) => i.id === 'front-door') as Door;
    player.teleport(origin.x - 2.55, origin.y - 0.02, origin.z + 6.2, 0);
    await sim(0.2);
    await sim(1.5, { forward: 1, right: 0, sprint: false, jump: false });
    const lzClosed = player.position.z - origin.z;
    const blocked = lzClosed > 5.2;
    player.pitch = -0.15;
    await sim(0.1);
    const targeted = interaction.current?.id;
    input.press('KeyE');
    await sim(1.2);
    const opened = door.isOpen;
    await sim(2.0, { forward: 1, right: 0, sprint: false, jump: false });
    const inside = world.starter.contains(player.position);
    record('Closed front door blocks the way', blocked, `stopped at local z ${lzClosed.toFixed(2)}`);
    record('Looking at the door targets it', targeted === 'front-door', `targeted: ${targeted ?? 'nothing'}`);
    record('E opens the door and the player walks in', opened && inside, `open=${opened}, inside=${inside}`);
    player.pitch = 0;
  }

  // 6. Light switch.
  {
    const sw = interaction.items.find((i) => i.id === 'switch-front room') as LightSwitch;
    const circuit = world.starter.circuits[0];
    const before = circuit.on;
    sw.interact();
    const after = circuit.on;
    if (after) sw.interact(); // leave it how it was
    record('Light switch toggles the room light', before !== after, `before=${before}, after=${after}`);
    if (!before && circuit.on) sw.interact();
  }

  // 7. Carry and place an object.
  {
    const box = interaction.pickups.find((p) => p.id === 'box-1') as Pickup;
    const n0 = interaction.pickups.length;
    player.teleport(origin.x + 4, origin.y + 0.01, origin.z + 2.6, 0);
    await sim(0.3);
    interaction.pickUp(box);
    await sim(0.5, { forward: 0, right: 1, sprint: false, jump: false });
    const carrying = interaction.carrying === box;
    player.pitch = -0.9;
    await sim(0.1);
    const placed = interaction.place();
    await sim(1.5);
    const y = box.body.translation().y;
    const resting = Math.abs(y - (origin.y + box.half.y)) < 0.15;
    player.pitch = 0;
    record('Picks up a box and carries it', carrying, `carrying=${carrying}`);
    record('Sets the box down on the floor', placed && resting && interaction.pickups.length === n0 && !interaction.carrying, `placed=${placed}, y offset ${(y - origin.y - box.half.y).toFixed(2)} m, items ${interaction.pickups.length}/${n0}`);
  }

  // 8. Garage roller door.
  {
    const roller = interaction.items.find((i) => i.id === 'garage-door') as RollerDoor;
    player.teleport(origin.x + 4, origin.y, origin.z + 9, 0);
    roller.interact();
    await sim(2.5);
    const open = roller.isOpen;
    await sim(2.6, { forward: 1, right: 0, sprint: false, jump: false });
    const inGarage = player.position.z - origin.z < 4.5 && player.position.y > origin.y - 0.1;
    record('Garage door opens and the ramp leads inside', open && inGarage, `open=${open}, local z ${(player.position.z - origin.z).toFixed(2)}, y offset ${(player.position.y - origin.y).toFixed(2)}`);
  }

  // 9. Plaza stairs.
  {
    const sx = 37.5;
    const sz = -37.5 + 20 + 11 * 0.42 + 1.5;
    player.teleport(sx, hm.get(sx, sz) + 0.25, sz, 0);
    await sim(0.3);
    await sim(4, { forward: 1, right: 0, sprint: false, jump: false });
    record('Climbs the plaza staircase', player.position.y > plazaTop - 0.1, `reached ${(player.position.y - (plazaTop - 2.4)).toFixed(2)} m of 2.40 m`);
  }

  // 10. Cross a bridge end to end without falling.
  {
    const z0 = Z_LINES[2];
    const sp = bridgeSpan(z0);
    const x = sp.xa - 8;
    player.teleport(x, hm.get(x, z0) + 0.3, z0, -Math.PI / 2);
    await sim(0.3);
    let lowest = Infinity;
    input.override = { forward: 1, right: 0, sprint: true, jump: false };
    for (let i = 0; i < 60 * 14 && player.position.x < sp.xb + 6; i++) {
      game.tick(dt);
      if (player.position.x > sp.xa + 2 && player.position.x < sp.xb - 2) {
        const t = (player.position.x - sp.xa) / (sp.xb - sp.xa);
        const deck = hm.get(sp.xa, z0) + (hm.get(sp.xb, z0) - hm.get(sp.xa, z0)) * t;
        lowest = Math.min(lowest, player.position.y - deck);
      }
    }
    input.override = null;
    record('Crosses the river bridge on the deck', player.position.x > sp.xb && lowest > -0.5, `reached x ${player.position.x.toFixed(1)} (far bank ${sp.xb.toFixed(1)}), lowest ${lowest.toFixed(2)} m vs deck; river at ${riverX(z0).toFixed(0)}`);
  }

  // 11. Grow loop: soil, seed, water, grow, harvest.
  {
    const inv = game.inventory;
    const pot = game.production.pots[0];
    inv.add('soil', 1);
    inv.add('seed_violet', 1);
    const sel = (id: string) => (game.hotbar.selected = inv.slots.findIndex((s, i) => i < 8 && s?.id === id));
    sel('soil');
    const soilOk = game.hotbar.selected >= 0;
    pot.interact();
    sel('seed_violet');
    pot.interact();
    sel('wateringcan');
    pot.interact();
    const watered = pot.water === 1;
    game.production.advance(60);
    const grew = pot.growth > 0.15;
    pot.growNow();
    const before = inv.count('prod');
    pot.interact();
    const harvested = inv.count('prod') - before;
    record('Grow pot: soil, seed, water, growth, harvest', soilOk && watered && grew && harvested === 8, `watered=${watered}, grew=${grew}, harvested ${harvested} units`);
  }

  // 12. Mixing changes effects and value; job completes and is collected.
  {
    const inv = game.inventory;
    const slot = inv.slots.findIndex((s) => s?.id === 'prod');
    const v = game.variants.byKey(inv.slots[slot]?.v)!;
    const mixer = game.production.find<import('../production/Production').MixingStation>('mixer')!;
    const next = (await import('../products/Catalog')).mixEffects(v.effects, 'cola');
    const { variant } = game.variants.get(v.family, next, v.quality, 1);
    inv.removeAt(slot, 4);
    mixer.start({ remaining: 8, total: 8, output: { id: 'prod', qty: 4, v: variant.key }, label: 'self-test batch' });
    game.production.advance(9);
    const ready = !!mixer.output;
    mixer.interact();
    const got = inv.count('prod', variant.key);
    const { unitValue } = await import('../products/Catalog');
    record('Mixing Calming + Cola gives Bright + Fizzy and more value', next.includes('bright') && next.includes('fizzy') && unitValue(variant) > unitValue(v) && ready && got === 4, `effects ${next.join('+')}, $${unitValue(v)} → $${unitValue(variant)}, collected ${got}`);
  }

  // 13. Haggling: a fair offer is accepted, an outrageous one is refused, and demand runs out.
  {
    const inv = game.inventory;
    const prodSlot = inv.slots.findIndex((s) => s?.id === 'prod');
    const vk = inv.slots[prodSlot]!.v;
    inv.add('pkg_bag', 12, vk);
    const c = game.customers;
    const person = c.peds.people.find((p) => p.kind === 'civ')!;
    const prof = c.profiles.get(person.index)!;
    const saved = { ...prof };
    prof.unlocked = true;
    prof.need = 1;
    prof.appetite = 4;
    prof.budget = 5000;
    const slot = () => inv.slots.findIndex((s) => s?.id === 'pkg_bag');
    const v = game.variants.byKey(vk)!;
    const tooMany = c.startHaggle(person, slot(), 6);
    const h = c.startHaggle(person, slot(), 2);
    const okH = typeof h !== 'string';
    let counterSeen = false;
    let sold = false;
    if (okH) {
      const r1 = c.offer(h, Math.round(h.max * 1.25));
      counterSeen = r1.kind === 'counter';
      const r2 = r1.kind === 'counter' ? c.acceptCounter(h) : r1;
      sold = r2.kind === 'accept';
    }
    const left = c.wantUnits(prof);
    const h2 = c.startHaggle(person, slot(), 2);
    const h3 = typeof h2 !== 'string' ? c.offer(h2, Math.round(h2.max * 0.8)) : null;
    const after = c.wantUnits(prof);
    const h4 = c.startHaggle(person, slot(), 1);
    record('Customer refuses more than they want', typeof tooMany === 'string', String(tooMany).slice(0, 60));
    record('Haggling: high ask gets a counter, accepting it sells', counterSeen && sold, `counter=${counterSeen}, sold=${sold}`);
    record('Demand runs out after buying their fill', left === 2 && h3?.kind === 'accept' && after === 0 && typeof h4 === 'string', `left ${left} → ${after}; next ask: ${String(h4).slice(0, 40)}`);
    Object.assign(prof, saved);
    void v;
    c.clearHeat();
  }

  // 13b. Text haggling: a counter within the ceiling is accepted.
  {
    const c = game.customers;
    const prof = [...c.profiles.values()][3];
    const wasUnlocked = prof.unlocked;
    prof.unlocked = true;
    prof.need = 1;
    const n0 = c.deals.length;
    c.forceDeal();
    const d = c.deals[0];
    const made = c.deals.length > n0;
    const r = made ? c.counterDeal(d.id, Math.round(d.ceiling * 0.98)) : 'none';
    record('Counter-offer by text within their limit is accepted', made && r === 'accepted' && d.status === 'accepted', `result ${r}, price $${d?.price}`);
    if (d) {
      d.status = 'failed';
      c.peds.release(c.person(d.person));
    }
    prof.unlocked = wasUnlocked;
  }

  // 13c. Properties, staff and production off-site.
  {
    const cash0 = game.economy.cash;
    game.economy.earn(50000, 'Self-test', false);
    const msg = game.properties.buy('laundromat');
    const site = game.production.sites.get('laundromat')!;
    const owned = game.properties.owns('laundromat') && site.pots.length === 2 && site.has('mixer');
    game.employees.refreshCandidates(true);
    const cand = game.employees.candidates.find((x) => x.role === 'botanist')!;
    const hired = game.employees.hire(cand.id, 'laundromat');
    const emp = game.employees.list.find((e) => e.data.id === cand.id)!;
    emp.data.shift = 'all';
    site.storage.add('soil', 2);
    site.storage.add('seed_violet', 2);
    // Let them walk and work for a while.
    for (let i = 0; i < 60 * 40; i++) {
      game.employees.advance(0.5);
      game.employees.frame(1 / 30);
      if (site.pots.every((p) => p.seed)) break;
    }
    const planted = site.pots.filter((p) => p.seed).length;
    record('Buying a property installs its equipment', owned, msg);
    record('A hired botanist walks over and plants pots', !!emp && planted === 2, `${hired}; planted ${planted}/2, status "${emp?.status}"`);
    game.employees.fire(cand.id);
    game.properties.owned.delete('laundromat');
    game.economy.cash = cash0;
  }

  // 13d. Vehicles drive, collide and let you out.
  {
    const p0 = world.starter.spawn;
    const v = game.vehicles.spawn('hatch', 0x8f2b2b, p0.x + 10, -78.4, 0);
    game.vehicles.enter(v);
    const x0 = v.pos.x;
    input.override = { forward: 1, right: 0, sprint: false, jump: false };
    for (let i = 0; i < 180; i++) game.tick(dt);
    input.override = null;
    const moved = v.pos.x - x0;
    const ground = hm.get(v.pos.x, v.pos.z);
    for (let i = 0; i < 240 && Math.abs(v.speed) > 0.5; i++) {
      input.override = { forward: -1, right: 0, sprint: false, jump: false };
      game.tick(dt);
    }
    input.override = null;
    const out = game.vehicles.exit();
    record('Car accelerates along the road and stays on the ground', moved > 15 && Math.abs(v.pos.y - ground - 0.06) < 0.8, `moved ${moved.toFixed(1)} m, height above road ${(v.pos.y - ground).toFixed(2)} m`);
    record('Getting out puts you beside the car', out && !game.player.hidden && game.player.position.distanceTo(v.pos) < 3.5, `distance ${game.player.position.distanceTo(v.pos).toFixed(2)} m`);
    game.vehicles.list.splice(game.vehicles.list.indexOf(v), 1);
    game.scene.remove(v.group);
    v.body.setTranslation({ x: 0, y: -900, z: 0 }, true);
  }

  // 13e. Territory: selling in gang turf raises influence and hostility.
  {
    const r = game.rivals;
    const before = { inf: r.of('industrial').player, host: r.hostility.copperheads };
    r.recordSale('industrial', 6);
    const after = { inf: r.of('industrial').player, host: r.hostility.copperheads };
    record('Selling on gang turf shifts influence and angers them', after.inf > before.inf && after.host > before.host, `influence ${before.inf.toFixed(1)} → ${after.inf.toFixed(1)}, hostility ${before.host.toFixed(0)} → ${after.host.toFixed(0)}`);
    r.of('industrial').player = before.inf;
    r.hostility.copperheads = before.host;
  }

  // 13f. The walk from the spawn point up to the front door has no unclimbable slope.
  {
    const sp = world.starter.spawn;
    let worst = 0;
    const steps = 40;
    const zEnd = origin.z + 7.4;
    for (let i = 0; i < steps; i++) {
      const za = sp.z + ((zEnd - sp.z) * i) / steps;
      const zb = sp.z + ((zEnd - sp.z) * (i + 1)) / steps;
      const ang = (Math.atan2(Math.abs(hm.get(sp.x, zb) - hm.get(sp.x, za)), Math.abs(zb - za)) * 180) / Math.PI;
      worst = Math.max(worst, ang);
    }
    record('Path from the spawn to the front steps is walkable', worst < 40, `steepest stretch ${worst.toFixed(1)}° (limit 55°)`);
  }

  // 13g. Free placement: equipment fits in the garage, not in unconverted rooms; drying racks raise quality.
  {
    const site = game.production.home;
    let spot: [number, number] | null = null;
    for (let x = 2.6; x < 5.6 && !spot; x += 0.3) for (let z = -3.8; z < 3.8 && !spot; z += 0.3) if (!site.canPlace('rack', x, z, 0)) spot = [x, z];
    record('A drying rack can be placed somewhere in the garage', !!spot, spot ? `free spot at (${spot[0].toFixed(1)}, ${spot[1].toFixed(1)})` : 'garage is full');
    if (!game.upgrades.has('home_front')) {
      const why = site.canPlace('pot', -1.5, 2.0, 0);
      record('Unconverted front room refuses equipment', why !== null, why ?? 'placement was allowed');
    }
    if (spot) {
      const rack = site.place('rack', spot[0], spot[1], 0) as import('../production/Production').DryingRack;
      const { variant } = game.variants.get('nightshade', ['calming'], 0, game.time.day);
      rack.start({ remaining: 120, total: 120, output: { id: 'prod', qty: 5, v: game.variants.get('nightshade', ['calming'], 1, game.time.day).variant.key }, label: 'self-test batch' });
      rack.advance(121);
      const out = rack.output ? game.variants.byKey(rack.output.v) : undefined;
      record('Drying rack finishes after two hours with a better tier', !!out && out.quality === variant.quality + 1, out ? `${variant.name} → ${out.name} (${out.quality})` : 'no output');
      site.remove(rack);
    }
  }

  // 13h. Corner shop sells equipment straight into the backpack.
  {
    const inv = game.inventory;
    const cash0 = game.economy.cash;
    game.economy.earn(500, 'Self-test float', false);
    const n0 = inv.count('pot');
    const r = game.market.buyNow('pot', 1, 1.15);
    const ok = r.ok && inv.count('pot') === n0 + 1;
    record('Kwik Corner sells a grow pot over the counter', ok, r.text);
    if (r.ok) inv.remove('pot', 1);
    game.economy.cash = cash0;
    record('Kwik Corner exists across the street', !!world.shop && world.shop.door !== undefined, world.shop ? 'built' : 'missing');
  }

  // 14. Inventory transfers never duplicate items.
  {
    const { Container } = await import('../inventory/Inventory');
    const a = new Container('a', 4);
    const b = new Container('b', 4);
    a.add('mint', 15);
    Container.move(a, 0, b, 0, 7);
    Container.move(b, 0, a, 0);
    Container.quickMove(a, 0, b);
    const total = a.count('mint') + b.count('mint');
    record('Moving and splitting stacks keeps totals exact', total === 15, `total ${total}/15`);
  }

  // 15. Never needed the fall-through safety net.
  record('No fall-through rescues', player.rescues === rescues0, `${player.rescues - rescues0} rescues`);

  // Restore.
  const sp = world.starter.spawn;
  player.teleport(sp.x, sp.y, sp.z, sp.yaw);
  game.mode = prevMode;
  void STARTER;
  void THREE;
  const failed = results.filter((r) => !r.pass).length;
  return { pass: failed === 0, passed: results.length - failed, failed, results, ms: Math.round(performance.now() - t0) };
}
