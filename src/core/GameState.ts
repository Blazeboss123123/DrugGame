import type { District } from '../world/CityPlan';
import type { EventBus, ObjectiveSignal } from './EventBus';

export interface Objective {
  id: string;
  text: string;
  hint: string;
  /** Optional live progress label, e.g. "2/5". */
  progress?: () => string;
}

const SIGNAL_TO_OBJECTIVE: Partial<Record<ObjectiveSignal, string>> = {
  mail: 'mail',
  order: 'order',
  drop: 'drop',
  collect: 'collect',
  plant: 'plant',
  water: 'water',
  harvest: 'harvest',
  mix: 'mix',
  package: 'package',
  sample: 'sample',
  sale: 'sale',
};

/** Tutorial objectives and exploration stats. Money lives in Economy, items in Inventory. */
export class GameState {
  readonly propertyName = '14 Larch Street';
  readonly done = new Set<string>();
  readonly districts = new Set<District>();
  walked = 0;
  revenue = 0;

  readonly objectives: Objective[] = [
    { id: 'walk', text: 'Get your bearings: walk around', hint: 'W A S D to move, mouse to look.', progress: () => `${Math.min(15, Math.floor(this.walked))}/15 m` },
    { id: 'mail', text: 'Check the mailbox outside 14 Larch Street', hint: 'Look at the blue mailbox by the path and press E.' },
    { id: 'order', text: 'Order soil and buy seeds in the Market app', hint: 'Press M, open Market. Soil is delivered to your porch; seeds come from Hoover, your supplier: pay him and he hides them somewhere in town.' },
    { id: 'collect', text: 'Collect your delivery from the porch box', hint: 'Deliveries arrive in the crate on your porch. Press E on it and take the items.' },
    { id: 'drop', text: 'Find the dead drop and pick up your seeds', hint: 'Hoover texts you when they’re stashed. The search area is marked on your map (N): look for a small paper bag.' },
    { id: 'plant', text: 'Fill a grow pot with soil and plant a seed', hint: 'Grow pots are in the garage. Select soil in your hotbar, press E on a pot, then do the same with a seed.' },
    { id: 'water', text: 'Water the plant', hint: 'Select the watering can (hotbar) and press E on the pot.' },
    { id: 'harvest', text: 'Harvest the Nightshade when it is ready', hint: 'Plants grow over a few hours of game time. Sleep, or keep them watered and wait.' },
    { id: 'mix', text: 'Create a new variant at the mixing station', hint: 'Mixers like Mint or Cola change a product’s effects and value.' },
    { id: 'package', text: 'Package product at the packaging bench', hint: 'Customers only buy packaged product. Baggies hold 1 unit.' },
    { id: 'sample', text: 'Win your first customer with a free sample', hint: 'Walk up to someone, press E and choose Give sample.' },
    { id: 'sale', text: 'Complete a sale or an accepted deal', hint: 'Sell to a customer directly, or accept a deal in Messages and meet them.' },
    { id: 'cash', text: 'Earn $2,000 in sales to unlock the Dreamdust kettle', hint: 'Better effects and quality sell for more.', progress: () => `$${this.revenue.toLocaleString()}/$2,000` },
  ];

  constructor(private bus: EventBus) {
    bus.on('objective:signal', (s) => this.signal(s.id, s.amount));
    bus.on('district:enter', (d) => this.districts.add(d.district));
  }

  current(): Objective | null {
    return this.objectives.find((o) => !this.done.has(o.id)) ?? null;
  }

  complete(id: string, quiet = false): void {
    if (this.done.has(id)) return;
    this.done.add(id);
    const o = this.objectives.find((x) => x.id === id);
    if (o && !quiet) this.bus.emit('toast', { text: `Done: ${o.text}`, kind: 'good' });
    if (this.done.size === this.objectives.length && !quiet)
      this.bus.emit('toast', { text: 'Tutorial complete. Build the empire.', kind: 'good' });
    this.bus.emit('objectives:changed', {});
  }

  skipCurrent(): void {
    const c = this.current();
    if (c) this.complete(c.id);
  }

  completeAll(): void {
    for (const o of this.objectives) this.complete(o.id, true);
    this.bus.emit('toast', { text: 'Tutorial skipped.', kind: 'info' });
  }

  private signal(id: ObjectiveSignal, amount = 0): void {
    if (id === 'walked') {
      this.walked += amount;
      if (this.walked >= 15) this.complete('walk');
      return;
    }
    if (id === 'cash') {
      this.revenue = amount;
      if (amount >= 2000) this.complete('cash');
      this.bus.emit('objectives:changed', {});
      return;
    }
    const obj = SIGNAL_TO_OBJECTIVE[id];
    if (obj) this.complete(obj);
  }

  toJSON() {
    return { done: [...this.done], districts: [...this.districts], walked: this.walked, revenue: this.revenue };
  }

  load(d: ReturnType<GameState['toJSON']> | undefined) {
    if (!d) return;
    this.done.clear();
    d.done.forEach((x) => this.done.add(x));
    d.districts.forEach((x) => this.districts.add(x));
    this.walked = d.walked;
    this.revenue = d.revenue;
    this.bus.emit('objectives:changed', {});
  }
}
