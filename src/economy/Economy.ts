import type { EventBus } from '../core/EventBus';

export interface Txn {
  day: number;
  time: string;
  label: string;
  amount: number;
}

/** Anything costing this much or more (each) is too big to pay in cash: it goes on the card. */
export const CARD_MIN = 250;

/**
 * A front that turns dirty cash into clean bank money: a cut, a daily limit and a wait.
 * The casino cashier is always available (in person, while it's open); the rest you buy.
 */
export interface FrontDef {
  id: string;
  name: string;
  /** Bought with cash (0 = always available). */
  price: number;
  /** Cut kept by the front (0.15 = 15%). */
  fee: number;
  /** Most cash it can take per game day. */
  daily: number;
  /** Game minutes before the clean money reaches your bank. */
  minutes: number;
  desc: string;
  unlock?: number;
}

export const FRONTS: FrontDef[] = [
  { id: 'casino', name: 'Lucky 7 Casino cashier', price: 0, fee: 0.15, daily: 2500, minutes: 60, desc: 'Buy chips with cash, cash out as a winnings cheque. In person at the casino cashier, 20:00–04:00.' },
  { id: 'laundromat', name: 'Suds & Bubbles Laundromat', price: 6000, fee: 0.1, daily: 6000, minutes: 8 * 60, desc: 'A coin laundry that suddenly does very well. Takes cash from your phone; clean money lands in about 8 hours.' },
  { id: 'carwash', name: 'Sparkle Car Wash', price: 20000, fee: 0.07, daily: 20000, minutes: 8 * 60, desc: 'Big, boring and cash-only. The best rate in town.', unlock: 10000 },
];

export interface Washing {
  amount: number;
  ready: number;
  via: string;
}

/** The single place money changes hands. Everything that earns or spends goes through here. */
export class Economy {
  /** Dirty cash in your pocket (deals, the casino floor, trades). */
  cash = 0;
  /** Clean money in the bank: what your card spends. */
  bank = 0;
  /** Cash going through a front, on its way to the bank. */
  readonly washing: Washing[] = [];
  /** Fronts you own. */
  readonly fronts = new Set<string>();
  /** Cash put through each front today (limits reset every game day). */
  private washed: Record<string, number> = {};
  private washDay = 0;
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

  /** `daily` = false for money just moving between your pocket and the bank (not earned or spent). */
  private log(label: string, amount: number, card = false, daily = true) {
    const c = this.clock();
    this.ledger.unshift({ day: c.day, time: c.label, label, amount });
    if (this.ledger.length > 200) this.ledger.pop();
    if (daily) {
      const d = this.daily.get(c.day) ?? { rev: 0, exp: 0 };
      if (amount > 0) d.rev += amount;
      else d.exp -= amount;
      this.daily.set(c.day, d);
    }
    this.bus.emit('money:changed', { cash: this.cash, delta: amount, bank: this.bank, card });
  }

  /** Pays from the bank with your card. False if there isn't enough clean money. */
  payCard(amount: number, label: string): boolean {
    const a = Math.round(amount);
    if (a > this.bank) return false;
    this.bank -= a;
    this.lifetimeExpenses += a;
    this.log(`💳 ${label}`, -a, true);
    return true;
  }

  /** Big-ticket purchases need the card; small ones are paid in cash. */
  needsCard(unitPrice: number) {
    return unitPrice >= CARD_MIN;
  }

  /** Why you can't pay this by card, or null. */
  cardShort(amount: number): string | null {
    return amount > this.bank ? `Card declined: that's $${Math.round(amount).toLocaleString()} and your bank has $${this.bank.toLocaleString()}. Launder some cash first (Finance app).` : null;
  }

  /** Withdraw clean money as cash (ATM). */
  withdraw(amount: number): boolean {
    const a = Math.round(amount);
    if (a <= 0 || a > this.bank) return false;
    this.bank -= a;
    this.cash += a;
    this.log('ATM withdrawal (bank → cash)', a, true, false);
    return true;
  }

  /** How much more cash a front can take today. */
  washRoom(front: FrontDef, day: number): number {
    if (day !== this.washDay) {
      this.washDay = day;
      this.washed = {};
    }
    return Math.max(0, front.daily - (this.washed[front.id] ?? 0));
  }

  /**
   * Puts cash through a front: it leaves your pocket now and the clean amount (after the front's cut)
   * reaches your bank after a while. Returns a message.
   */
  launder(front: FrontDef, amount: number, now: number, day: number): { ok: boolean; text: string } {
    const a = Math.round(amount);
    if (front.price > 0 && !this.fronts.has(front.id)) return { ok: false, text: `You don't own ${front.name}.` };
    if (a <= 0) return { ok: false, text: 'Choose an amount.' };
    if (a > this.cash) return { ok: false, text: `You only have $${this.cash.toLocaleString()} in cash.` };
    const room = this.washRoom(front, day);
    if (a > room) return { ok: false, text: room ? `${front.name} can only take another $${room.toLocaleString()} today.` : `${front.name} has taken all it can today. Try tomorrow.` };
    const clean = Math.round(a * (1 - front.fee));
    this.cash -= a;
    this.washed[front.id] = (this.washed[front.id] ?? 0) + a;
    this.washing.push({ amount: clean, ready: now + front.minutes, via: front.name });
    this.log(`Laundering via ${front.name}`, -a, false, false);
    const h = Math.floor(front.minutes / 60);
    return { ok: true, text: `$${a.toLocaleString()} in. $${clean.toLocaleString()} clean (after a ${Math.round(front.fee * 100)}% cut) reaches your bank in ${h ? `${h} hour${h === 1 ? '' : 's'}` : `${front.minutes} minutes`}.` };
  }

  /** Clean money whose time has come lands in the bank. Returns what arrived. */
  advanceWash(now: number): Washing[] {
    const done = this.washing.filter((w) => now >= w.ready);
    if (!done.length) return done;
    for (const w of done) {
      this.washing.splice(this.washing.indexOf(w), 1);
      this.bank += w.amount;
      this.log(`Clean money from ${w.via}`, w.amount, true, false);
    }
    return done;
  }

  /** Cheat: every dollar gone, cash, bank and anything still being laundered. Returns the total lost. */
  wipe(label: string): number {
    const lost = this.cash + this.bank + this.washing.reduce((a, w) => a + w.amount, 0);
    this.forfeit(this.cash, label);
    this.bank = 0;
    this.washing.length = 0;
    this.bus.emit('money:changed', { cash: this.cash, delta: 0, bank: 0 });
    return lost;
  }

  /** Cheat: clean money straight into the bank. */
  deposit(amount: number, label: string) {
    this.bank += Math.round(amount);
    this.log(label, Math.round(amount), true, false);
  }

  /** Buy a front business (with cash). */
  buyFront(id: string): string {
    const f = FRONTS.find((x) => x.id === id);
    if (!f || !f.price) return 'Unknown business.';
    if (this.fronts.has(id)) return 'You already own it.';
    if (f.unlock && this.lifetimeRevenue < f.unlock) return `Unlocks at $${f.unlock.toLocaleString()} lifetime sales.`;
    if (!this.spend(f.price, `Bought ${f.name}`)) return `You need $${f.price.toLocaleString()} in cash.`;
    this.fronts.add(id);
    return `You own ${f.name}. Put cash through it from the Finance app.`;
  }

  /** Bills (upkeep) come out of the bank first, then cash. */
  bill(amount: number, label: string): void {
    const a = Math.round(amount);
    const fromBank = Math.min(this.bank, a);
    if (fromBank > 0) {
      this.bank -= fromBank;
      this.lifetimeExpenses += fromBank;
      this.log(`💳 ${label}`, -fromBank, true);
    }
    if (a > fromBank) this.forfeit(a - fromBank, label);
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
    return { cash: this.cash, bank: this.bank, washing: this.washing, fronts: [...this.fronts], washed: this.washed, washDay: this.washDay, rev: this.lifetimeRevenue, exp: this.lifetimeExpenses, units: this.unitsSold, ledger: this.ledger.slice(0, 60), daily: [...this.daily] };
  }

  load(d: (Partial<ReturnType<Economy['toJSON']>> & Pick<ReturnType<Economy['toJSON']>, 'cash' | 'rev' | 'exp' | 'units' | 'ledger' | 'daily'>) | undefined) {
    if (!d) return;
    this.cash = d.cash;
    this.bank = d.bank ?? 0;
    this.washing.length = 0;
    this.washing.push(...(d.washing ?? []));
    this.fronts.clear();
    for (const f of d.fronts ?? []) this.fronts.add(f);
    this.washed = d.washed ?? {};
    this.washDay = d.washDay ?? 0;
    this.lifetimeRevenue = d.rev;
    this.lifetimeExpenses = d.exp;
    this.unitsSold = d.units;
    this.ledger.length = 0;
    this.ledger.push(...d.ledger);
    this.daily.clear();
    for (const [k, v] of d.daily) this.daily.set(k, v);
    this.bus.emit('money:changed', { cash: this.cash, delta: 0, bank: this.bank });
  }
}
