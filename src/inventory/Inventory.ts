import { ITEMS } from '../products/Catalog';

/** One slot's contents. `v` is the product variant key for products and packaged products. */
export interface Stack {
  id: string;
  qty: number;
  v?: string;
}

export const sameKind = (a: Stack | { id: string; v?: string }, b: Stack | { id: string; v?: string }) => a.id === b.id && (a.v ?? '') === (b.v ?? '');
export const stackLimit = (id: string) => ITEMS[id]?.stack ?? 1;

/**
 * A fixed-size grid of item stacks. Every change goes through these methods, which keep stack
 * limits and quantities consistent (no duplication, no negative counts).
 */
export class Container {
  readonly slots: (Stack | null)[];
  private listeners = new Set<() => void>();

  constructor(
    readonly name: string,
    size: number,
  ) {
    this.slots = new Array(size).fill(null);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.listeners.forEach((f) => f());
  }

  /** How many of this item could still fit. */
  space(id: string, v?: string): number {
    const lim = stackLimit(id);
    let s = 0;
    for (const st of this.slots) {
      if (!st) s += lim;
      else if (sameKind(st, { id, v })) s += lim - st.qty;
    }
    return s;
  }

  /** Adds items, filling existing stacks first. Returns the quantity that did not fit. */
  add(id: string, qty: number, v?: string, notify = true): number {
    const lim = stackLimit(id);
    let left = qty;
    for (const st of this.slots) {
      if (left <= 0) break;
      if (st && sameKind(st, { id, v }) && st.qty < lim) {
        const n = Math.min(lim - st.qty, left);
        st.qty += n;
        left -= n;
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (!this.slots[i]) {
        const n = Math.min(lim, left);
        this.slots[i] = { id, qty: n, v };
        left -= n;
      }
    }
    if (notify && left !== qty) this.changed();
    return left;
  }

  count(id: string, v?: string): number {
    let n = 0;
    for (const st of this.slots) if (st && st.id === id && (v === undefined || (st.v ?? '') === v)) n += st.qty;
    return n;
  }

  /** Removes exactly `qty` or nothing at all. */
  remove(id: string, qty: number, v?: string): boolean {
    if (this.count(id, v) < qty) return false;
    let left = qty;
    for (let i = this.slots.length - 1; i >= 0 && left > 0; i--) {
      const st = this.slots[i];
      if (st && st.id === id && (v === undefined || (st.v ?? '') === v)) {
        const n = Math.min(st.qty, left);
        st.qty -= n;
        left -= n;
        if (st.qty <= 0) this.slots[i] = null;
      }
    }
    this.changed();
    return true;
  }

  removeAt(i: number, qty: number): Stack | null {
    const st = this.slots[i];
    if (!st || qty <= 0) return null;
    const n = Math.min(qty, st.qty);
    st.qty -= n;
    const out = { id: st.id, qty: n, v: st.v };
    if (st.qty <= 0) this.slots[i] = null;
    this.changed();
    return out;
  }

  /**
   * Moves a stack (or part of it) between slots, possibly across containers: merges into a matching
   * stack, otherwise swaps with whatever is in the target slot.
   */
  static move(from: Container, fi: number, to: Container, ti: number, qty?: number): void {
    const src = from.slots[fi];
    if (!src || (from === to && fi === ti)) return;
    const n = Math.min(qty ?? src.qty, src.qty);
    const dst = to.slots[ti];
    if (!dst) {
      if (n === src.qty) {
        to.slots[ti] = src;
        from.slots[fi] = null;
      } else {
        to.slots[ti] = { id: src.id, qty: n, v: src.v };
        src.qty -= n;
      }
    } else if (sameKind(dst, src)) {
      const m = Math.min(stackLimit(src.id) - dst.qty, n);
      dst.qty += m;
      src.qty -= m;
      if (src.qty <= 0) from.slots[fi] = null;
    } else if (n === src.qty) {
      to.slots[ti] = src;
      from.slots[fi] = dst;
    }
    from.changed();
    if (to !== from) to.changed();
  }

  /** Moves a whole stack into the first place it fits in `to`. */
  static quickMove(from: Container, fi: number, to: Container): void {
    const src = from.slots[fi];
    if (!src) return;
    const left = to.add(src.id, src.qty, src.v);
    if (left === src.qty) return;
    if (left <= 0) from.slots[fi] = null;
    else src.qty = left;
    from.changed();
  }

  clear(): void {
    this.slots.fill(null);
    this.changed();
  }

  toJSON(): (Stack | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  load(data: (Stack | null)[] | undefined): void {
    this.slots.fill(null);
    data?.forEach((s, i) => {
      if (i < this.slots.length && s && ITEMS[s.id] && s.qty > 0) this.slots[i] = { id: s.id, qty: Math.min(s.qty, stackLimit(s.id)), v: s.v };
    });
    this.changed();
  }
}
