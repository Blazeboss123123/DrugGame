import type { Services } from '../core/Services';

/** One-off investments bought from the phone's Upgrades app. */
export interface UpgradeDef {
  id: string;
  name: string;
  price: number;
  desc: string;
  group: 'Property' | 'Production' | 'Business';
  needs?: string;
  unlock?: number;
}

export const UPGRADES: UpgradeDef[] = [
  { id: 'home_back', name: 'Convert the back room', price: 1500, group: 'Property', desc: 'Clear out the wardrobe and clutter so you can place equipment in the back room. The bed, desk and computer stay.' },
  { id: 'home_front', name: 'Convert the front room', price: 2500, group: 'Property', needs: 'home_back', desc: 'Move the sofa, TV and dining table out. The whole living room becomes production space. The kitchen stays.' },
  { id: 'shelves', name: 'Heavy-duty shelving', price: 700, group: 'Property', desc: '+10 slots on every property storage shelf and +6 on storage racks you place later.' },
  { id: 'mixer2', name: 'Turbo mixers', price: 900, group: 'Production', unlock: 300, desc: 'Every mixing station works twice as fast.' },
  { id: 'yield', name: 'Hydroponic trays', price: 1200, group: 'Production', unlock: 800, desc: '+4 units from every harvest.' },
  { id: 'fastgrow', name: 'Grow tent kits', price: 1800, group: 'Production', unlock: 1500, desc: 'Plants grow 35% faster (stacks with grow lamps).' },
  { id: 'kettle2', name: 'Pressure kettles', price: 1500, group: 'Production', unlock: 2000, desc: 'Each Dreamdust batch makes 12 units instead of 8.' },
  { id: 'dealer', name: 'Better dealer terms', price: 2000, group: 'Business', unlock: 3000, desc: 'Dealers keep 12% of their sales instead of 20%.' },
  { id: 'burner', name: 'Burner phones', price: 1000, group: 'Business', unlock: 1000, desc: 'Customers text deal requests about 40% more often.' },
];

export class Upgrades {
  readonly owned = new Set<string>();
  constructor(private svc: Services) {}

  has(id: string) {
    return this.owned.has(id);
  }

  status(u: UpgradeDef): string | null {
    if (this.has(u.id)) return 'Owned';
    if (u.needs && !this.has(u.needs)) return `Needs "${UPGRADES.find((x) => x.id === u.needs)?.name}" first`;
    if (u.unlock && this.svc.economy.lifetimeRevenue < u.unlock) return `Unlocks at $${u.unlock.toLocaleString()} lifetime sales`;
    return null;
  }

  buy(id: string): string {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return 'Unknown upgrade.';
    const reason = this.status(u);
    if (reason) return reason;
    if (!this.svc.economy.spend(u.price, `Upgrade: ${u.name}`)) return `You need $${u.price.toLocaleString()}.`;
    this.owned.add(id);
    this.apply(id);
    this.svc.audio.play('ui');
    return `${u.name} done.`;
  }

  /** Immediate effects of an upgrade (also re-applied after loading). */
  private apply(id: string) {
    if (id === 'shelves') for (const site of this.svc.production.sites.values()) site.grow(10);
    if (id === 'home_back') this.svc.world.starter.convertRoom('back');
    if (id === 'home_front') this.svc.world.starter.convertRoom('front');
  }

  toJSON() {
    return [...this.owned];
  }

  /** Load before production so shelf sizes and converted rooms are in place. */
  load(d: string[] | undefined) {
    if (!d) return;
    for (const id of d) {
      if (this.owned.has(id)) continue;
      this.owned.add(id);
      this.apply(id);
    }
  }
}
