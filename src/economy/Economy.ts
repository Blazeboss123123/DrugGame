import type { EventBus } from '../core/EventBus';

export interface Txn {
  day: number;
  time: string;
  label: string;
  amount: number;
}

/** The single place money changes hands. Everything that earns or spends goes through here. */
export class Economy {
  cash = 0;
  lifetimeRevenue = 0;
  lifetimeExpenses = 0;
  unitsSold = 0;
  readonly ledger: Txn[] = [];
  /** Revenue per game day, for the finance chart. */
  readonly daily = new Map<number, { rev: number; exp: number }>();

  constructor(
    private bus: EventBus,
    private clock: () => { day: number; label: string },
  ) {}

  private log(label: string, amount: number) {
    const c = this.clock();
    this.ledger.unshift({ day: c.day, time: c.label, label, amount });
    if (this.ledger.length > 200) this.ledger.pop();
    const d = this.daily.get(c.day) ?? { rev: 0, exp: 0 };
    if (amount > 0) d.rev += amount;
    else d.exp -= amount;
    this.daily.set(c.day, d);
    this.bus.emit('money:changed', { cash: this.cash, delta: amount });
  }

  /** Income from sales counts toward lifetime revenue (which unlocks new stock). */
  earn(amount: number, label: string, sale = true, units = 0): void {
    const a = Math.round(amount);
    this.cash += a;
    if (sale) {
      this.lifetimeRevenue += a;
      this.unitsSold += units;
    }
    this.log(label, a);
  }

  spend(amount: number, label: string): boolean {
    const a = Math.round(amount);
    if (a > this.cash) return false;
    this.cash -= a;
    this.lifetimeExpenses += a;
    this.log(label, -a);
    return true;
  }

  /** Fines can take you to zero but never below. */
  forfeit(amount: number, label: string): number {
    const a = Math.min(this.cash, Math.round(amount));
    this.cash -= a;
    this.lifetimeExpenses += a;
    this.log(label, -a);
    return a;
  }

  toJSON() {
    return { cash: this.cash, rev: this.lifetimeRevenue, exp: this.lifetimeExpenses, units: this.unitsSold, ledger: this.ledger.slice(0, 60), daily: [...this.daily] };
  }

  load(d: ReturnType<Economy['toJSON']> | undefined) {
    if (!d) return;
    this.cash = d.cash;
    this.lifetimeRevenue = d.rev;
    this.lifetimeExpenses = d.exp;
    this.unitsSold = d.units;
    this.ledger.length = 0;
    this.ledger.push(...d.ledger);
    this.daily.clear();
    for (const [k, v] of d.daily) this.daily.set(k, v);
    this.bus.emit('money:changed', { cash: this.cash, delta: 0 });
  }
}
