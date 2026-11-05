import type { Services } from '../core/Services';
import { DISTRICTS, type District } from '../world/CityPlan';

/**
 * Rival organisations and territory. Each district splits its influence between the player, the
 * three gangs and nobody. Selling in a district takes influence from whoever holds it and makes them
 * hostile; influence changes prices and demand, and hostile gangs send people to shake you down.
 */

export type GangId = 'copperheads' | 'velvet' | 'ridge';
export type Org = GangId | 'player';

export interface GangDef {
  id: GangId;
  name: string;
  leader: string;
  color: number;
  css: string;
  turf: District[];
  blurb: string;
}

export const GANGS: Record<GangId, GangDef> = {
  copperheads: {
    id: 'copperheads',
    name: 'The Copperheads',
    leader: 'Rusty Kane',
    color: 0xc8642a,
    css: '#c8642a',
    turf: ['industrial'],
    blurb: 'Dock workers turned suppliers. They run the Ironworks yards and hate outsiders.',
  },
  velvet: {
    id: 'velvet',
    name: 'Velvet Syndicate',
    leader: 'Simone Vale',
    color: 0x7a2f9a,
    css: '#9a4fc0',
    turf: ['commercial', 'downtown'],
    blurb: 'Polished, patient and well connected. They own Market Row and most of Meridian.',
  },
  ridge: {
    id: 'ridge',
    name: 'Ridge Runners',
    leader: 'Dale Hollis',
    color: 0x3f7a3a,
    css: '#5aa04f',
    turf: ['outskirts', 'residential'],
    blurb: 'Back-country growers from Cedar Ridge who supply the suburbs.',
  },
};

export const GANG_IDS = Object.keys(GANGS) as GangId[];
const DISTRICT_IDS: District[] = ['residential', 'downtown', 'commercial', 'industrial', 'outskirts'];
const BASE: Record<District, Partial<Record<Org, number>>> = {
  residential: { ridge: 35, player: 5 },
  downtown: { velvet: 45, copperheads: 10 },
  commercial: { velvet: 60 },
  industrial: { copperheads: 70 },
  outskirts: { ridge: 55 },
};

export class Rivals {
  readonly influence = new Map<District, Record<Org, number>>();
  readonly hostility: Record<GangId, number> = { copperheads: 0, velvet: 0, ridge: 0 };
  /** Districts the player bought out (milestone flags). */
  readonly controlled = new Set<District>();
  private warned: Record<GangId, number> = { copperheads: 0, velvet: 0, ridge: 0 };
  private lastDay = 0;

  constructor(private svc: Services) {
    for (const d of DISTRICT_IDS) this.influence.set(d, { player: 0, copperheads: 0, velvet: 0, ridge: 0, ...BASE[d] } as Record<Org, number>);
  }

  of(d: District): Record<Org, number> {
    return this.influence.get(d)!;
  }

  /** Strongest gang in a district (and its influence). */
  dominant(d: District): { gang: GangId; value: number } {
    const inf = this.of(d);
    let best: GangId = GANG_IDS[0];
    for (const g of GANG_IDS) if (inf[g] > inf[best]) best = g;
    return { gang: best, value: inf[best] };
  }

  /** Price multiplier customers apply in this district. */
  priceMult(d: District): number {
    const inf = this.of(d);
    return 0.82 + (inf.player / 100) * 0.38 - (this.dominant(d).value / 100) * 0.08;
  }

  /** Chance a stranger turns you down because they're loyal to the local gang. */
  loyalToGang(d: District): number {
    const dom = this.dominant(d);
    const inf = this.of(d);
    return dom.value > inf.player ? (dom.value - inf.player) / 100 * 0.45 : 0;
  }

  /** A sale happened in district `d`. `seenBy` is a gang whose member watched it. */
  recordSale(d: District, units: number, seenBy?: GangId) {
    const inf = this.of(d);
    const gain = Math.min(6, units * 0.5);
    const total = GANG_IDS.reduce((s, g) => s + inf[g], 0);
    const neutral = 100 - total - inf.player;
    // Take from neutral first, then from gangs in proportion to their share.
    let need = gain;
    const fromNeutral = Math.min(need, neutral);
    need -= fromNeutral;
    if (need > 0 && total > 0) for (const g of GANG_IDS) inf[g] = Math.max(0, inf[g] - (need * inf[g]) / total);
    inf.player = Math.min(100, inf.player + gain);
    for (const g of GANG_IDS) {
      if (!GANGS[g].turf.includes(d) && g !== seenBy) continue;
      this.hostility[g] = Math.min(100, this.hostility[g] + units * (GANGS[g].turf.includes(d) ? 0.9 : 0.3) + (g === seenBy ? 12 : 0));
      this.checkWarnings(g);
    }
    this.checkMilestones(d);
  }

  private checkWarnings(g: GangId) {
    const h = this.hostility[g];
    const gang = GANGS[g];
    if (h >= 40 && this.warned[g] < 1) {
      this.warned[g] = 1;
      this.svc.customers.post(`gang:${g}`, gang.leader, `Word is you're moving product on our streets. ${gang.name} don't share. Back off, or pay your respects.`);
    } else if (h >= 70 && this.warned[g] < 2) {
      this.warned[g] = 2;
      this.svc.customers.post(`gang:${g}`, gang.leader, `Last warning. My people know your face now. Open the Turf app and pay up, or they'll come collect.`);
    }
  }

  private checkMilestones(d: District) {
    const inf = this.of(d);
    if (inf.player >= 60 && !this.controlled.has(d)) {
      this.controlled.add(d);
      this.svc.ui.toast(`You now control ${DISTRICTS[d].name}. Customers there pay more.`, 'good');
      this.svc.bus.emit('phone:notify', { app: 'turf', text: `Territory milestone: ${DISTRICTS[d].name} is yours (${this.controlled.size}/5 districts).` });
    }
  }

  canShakedown(g: GangId) {
    return this.hostility[g] >= 65;
  }

  tributeCost(g: GangId) {
    return Math.round((300 + this.hostility[g] * 25) / 10) * 10;
  }

  payTribute(g: GangId): string {
    if (this.hostility[g] < 5) return `${GANGS[g].name} have no quarrel with you.`;
    const cost = this.tributeCost(g);
    if (!this.svc.economy.spend(cost, `Tribute to ${GANGS[g].name}`)) return `You need $${cost}.`;
    this.hostility[g] = Math.max(0, this.hostility[g] - 45);
    this.warned[g] = this.hostility[g] >= 40 ? 1 : 0;
    this.svc.customers.post(`gang:${g}`, GANGS[g].leader, `Respect received. We'll look the other way, for now.`);
    return `Paid $${cost}. ${GANGS[g].name} are calmer.`;
  }

  buyoutCost(d: District) {
    return Math.round((2500 + this.dominant(d).value * 120) / 100) * 100;
  }

  canBuyout(d: District): string | null {
    const inf = this.of(d);
    const dom = this.dominant(d);
    if (dom.value < 5) return 'No gang holds this district.';
    if (inf.player < 30) return 'You need at least 30% influence here first. Sell more in this district.';
    if (inf.player < dom.value * 0.6) return `${GANGS[dom.gang].name} are still too strong here.`;
    return null;
  }

  /** Negotiate a gang out of a district for cash. */
  buyout(d: District): string {
    const reason = this.canBuyout(d);
    if (reason) return reason;
    const dom = this.dominant(d);
    const cost = this.buyoutCost(d);
    if (!this.svc.economy.spend(cost, `Bought out ${GANGS[dom.gang].name} in ${DISTRICTS[d].name}`)) return `You need $${cost}.`;
    const inf = this.of(d);
    inf.player = Math.min(100, inf.player + inf[dom.gang] * 0.75);
    inf[dom.gang] = Math.round(inf[dom.gang] * 0.25);
    this.hostility[dom.gang] = Math.max(0, this.hostility[dom.gang] - 25);
    this.svc.customers.post(`gang:${dom.gang}`, GANGS[dom.gang].leader, `Fine. ${DISTRICTS[d].name} is yours. Don't make me regret it.`);
    this.checkMilestones(d);
    return `Deal done. ${GANGS[dom.gang].name} pulled most of their people out of ${DISTRICTS[d].name}.`;
  }

  /** Called every game minute batch. Daily: gangs push back and tempers cool. */
  advance() {
    const day = this.svc.time.day;
    if (this.lastDay === 0) this.lastDay = day;
    if (day === this.lastDay) return;
    this.lastDay = day;
    for (const d of DISTRICT_IDS) {
      const inf = this.of(d);
      for (const g of GANG_IDS) {
        const base = BASE[d][g] ?? 0;
        if (base > 0 && inf[g] < base && inf.player < 60) {
          const regrow = Math.min(4, base - inf[g]);
          inf[g] += regrow;
          inf.player = Math.max(0, inf.player - regrow * 0.5);
        }
      }
      // Normalise if anything overflowed.
      const sum = inf.player + GANG_IDS.reduce((s, g) => s + inf[g], 0);
      if (sum > 100) for (const k of Object.keys(inf) as Org[]) inf[k] = (inf[k] * 100) / sum;
    }
    for (const g of GANG_IDS) {
      this.hostility[g] = Math.max(0, this.hostility[g] - 8);
      if (this.hostility[g] < 35) this.warned[g] = 0;
    }
  }

  /** Called after a gang member shook the player down. */
  settled(g: GangId) {
    this.hostility[g] = Math.max(0, this.hostility[g] - 30);
  }

  toJSON() {
    return { inf: [...this.influence], host: this.hostility, ctrl: [...this.controlled], warned: this.warned, lastDay: this.lastDay };
  }

  load(d: ReturnType<Rivals['toJSON']> | undefined) {
    if (!d) return;
    for (const [k, v] of d.inf) this.influence.set(k, v);
    Object.assign(this.hostility, d.host);
    this.controlled.clear();
    d.ctrl.forEach((c) => this.controlled.add(c));
    Object.assign(this.warned, d.warned);
    this.lastDay = d.lastDay;
  }
}
