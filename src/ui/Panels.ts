import type { Services } from '../core/Services';
import type { Profile } from '../business/Customers';
import { Container, type Stack } from '../inventory/Inventory';
import type { Person } from '../npc/Pedestrians';
import { EFFECTS, FAMILIES, INGREDIENTS, ITEMS, QUALITY_NAMES, VariantRegistry, mixEffects, unitValue, unitsOf, type Quality } from '../products/Catalog';
import type { DryingRack, Kettle, MixingStation, NeonPress } from '../production/Production';
import { hostedWorlds } from '../net/Worlds';
import { iconFor, stackName } from './Icons';
import { openPackagingBench } from './Packaging';
import type { UI } from './UI';
import { DISTRICTS } from '../world/CityPlan';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function effectChips(effects: string[]): string {
  return effects.map((e) => `<span class="chip" style="--c:${EFFECTS[e].color}">${EFFECTS[e].name}</span>`).join('');
}

export interface CheatAction {
  label: string;
  run: () => void | string | Promise<string>;
  keep?: boolean;
}

/** Full-screen panels: inventory and storage, production stations, customers, cheats. */
export class Panels {
  private drag: { from: Container; index: number; ghost: HTMLElement; half: boolean } | null = null;

  constructor(
    private ui: UI,
    private svc: Services,
  ) {}

  shell(title: string, eyebrow: string, wide = false): { overlay: HTMLElement; body: HTMLElement; close: () => void } {
    const overlay = el('div', 'overlay');
    const panel = el('div', `panel game-panel${wide ? ' wide' : ''}`);
    const head = el('div', 'panel-head');
    head.innerHTML = `<div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div>`;
    const x = el('button', 'btn icon-btn', 'Close');
    x.setAttribute('aria-label', 'Close');
    const close = () => this.ui.dismiss();
    x.addEventListener('click', close);
    head.appendChild(x);
    const body = el('div', 'panel-body');
    panel.append(head, body);
    overlay.appendChild(panel);
    overlay.addEventListener('keydown', (e) => e.code === 'Escape' && close());
    return { overlay, body, close };
  }

  // ------------------------------------------------------------------ inventory and storage
  openInventory(other?: Container, label?: string) {
    const { overlay, body } = this.shell(other ? (label ?? other.name) : 'Inventory', other ? 'Drag items between your backpack and storage' : 'Drag to rearrange · right-click splits a stack · shift-click moves', !!other);
    const wrap = el('div', 'inv-wrap');
    const inv = this.svc.inventory;
    const left = el('section');
    left.appendChild(el('div', 'section-label', 'Hotbar'));
    const hot = el('div', 'grid g8');
    left.appendChild(hot);
    left.appendChild(el('div', 'section-label', 'Backpack'));
    const pack = el('div', 'grid g8');
    left.appendChild(pack);
    wrap.appendChild(left);
    let otherGrid: HTMLElement | null = null;
    if (other) {
      const right = el('section');
      right.appendChild(el('div', 'section-label', label ?? other.name));
      otherGrid = el('div', 'grid g5');
      right.appendChild(otherGrid);
      wrap.appendChild(right);
    }
    const info = el('div', 'inv-info', '<span class="muted">Hover an item for details.</span>');
    const trash = el('div', 'trash', 'Drop here to discard');
    const foot = el('div', 'inv-foot');
    foot.append(info, trash);
    body.append(wrap, foot);

    const render = () => {
      this.fill(hot, inv, 0, 8, other, info);
      this.fill(pack, inv, 8, inv.slots.length, other, info);
      if (other && otherGrid) this.fill(otherGrid, other, 0, other.slots.length, inv, info);
    };
    trash.addEventListener('pointerup', () => {
      if (!this.drag) return;
      const s = this.drag.from.slots[this.drag.index];
      if (s) {
        this.drag.from.removeAt(this.drag.index, s.qty);
        this.svc.audio.play('thud');
      }
    });
    const offs = [inv.onChange(render), other?.onChange(render)];
    overlay.addEventListener('remove-panel', () => offs.forEach((f) => f?.()));
    render();
    this.ui.present(overlay, () => offs.forEach((f) => f?.()));
  }

  private fill(grid: HTMLElement, c: Container, from: number, to: number, target: Container | undefined, info: HTMLElement) {
    grid.innerHTML = '';
    for (let i = from; i < to; i++) {
      const s = c.slots[i];
      const slot = el('div', 'slot');
      if (c === this.svc.inventory && i < 8) {
        slot.appendChild(el('span', 'slot-key', String(i < 4 ? i + 1 : i + 2)));
        if (i === this.svc.hotbar.selected) slot.classList.add('selected');
      }
      if (s) {
        const img = el('img');
        img.src = iconFor(s, this.svc.variants);
        img.alt = '';
        img.draggable = false;
        slot.appendChild(img);
        if (s.qty > 1) slot.appendChild(el('span', 'qty', String(s.qty)));
        slot.addEventListener('pointerenter', () => (info.innerHTML = this.describe(s)));
      }
      slot.addEventListener('pointerdown', (e) => {
        if (!s) return;
        if (e.button === 2) return;
        if (e.shiftKey && target) {
          Container.quickMove(c, i, target);
          this.svc.audio.play('ui');
          return;
        }
        const ghost = el('img', 'drag-ghost');
        ghost.src = iconFor(s, this.svc.variants);
        document.body.appendChild(ghost);
        const move = (ev: PointerEvent) => {
          ghost.style.left = `${ev.clientX - 22}px`;
          ghost.style.top = `${ev.clientY - 22}px`;
        };
        move(e);
        this.drag = { from: c, index: i, ghost, half: false };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setTimeout(() => {
            ghost.remove();
            this.drag = null;
          }, 0);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      slot.addEventListener('pointerup', () => {
        if (!this.drag) return;
        Container.move(this.drag.from, this.drag.index, c, i);
        this.svc.audio.play('ui');
      });
      slot.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!s || s.qty < 2) return;
        const empty = c.slots.findIndex((x, k) => !x && (c !== this.svc.inventory || k >= 0));
        if (empty < 0) return;
        Container.move(c, i, c, empty, Math.floor(s.qty / 2));
      });
      grid.appendChild(slot);
    }
  }

  describe(s: Stack): string {
    const def = ITEMS[s.id];
    const v = this.svc.variants.byKey(s.v);
    let html = `<strong>${esc(stackName(s, this.svc.variants))}</strong> <span class="muted">× ${s.qty}</span><br>`;
    if (v) {
      const units = unitsOf(s.id);
      html += `<span class="muted">${FAMILIES[v.family].name} · ${QUALITY_NAMES[v.quality]} · $${unitValue(v)}/unit${units > 1 ? ` · ${units} units each` : ''}</span><div class="chips">${effectChips(v.effects)}</div>`;
      if (def.kind === 'product') html += '<span class="muted">Loose product. Package it before selling.</span>';
    } else html += `<span class="muted">${esc(def.desc)}</span>`;
    return html;
  }

  // ------------------------------------------------------------------ mixing station
  openMixer(station: MixingStation) {
    const { overlay, body, close } = this.shell('Mixing station', 'Combine product with a mixer to change its effects');
    const inv = this.svc.inventory;
    let prodSlot = -1;
    let ingId = '';
    const lists = el('div', 'two-col');
    const prodList = el('div', 'pick-list');
    const ingList = el('div', 'pick-list');
    const preview = el('div', 'preview');
    const qtyRow = el('div', 'qty-row');
    const go = el('button', 'btn primary', 'Mix');
    go.disabled = true;
    lists.append(this.labelled('Product (loose)', prodList), this.labelled('Mixer', ingList));
    body.append(lists, preview, qtyRow, go);
    let qty = 1;
    const maxQty = () => {
      const s = inv.slots[prodSlot];
      return s ? Math.min(10, s.qty, inv.count(ingId)) : 0;
    };
    const render = () => {
      prodList.innerHTML = '';
      inv.slots.forEach((s, i) => {
        if (!s || s.id !== 'prod') return;
        prodList.appendChild(this.pickRow(s, i === prodSlot, () => {
          prodSlot = i;
          render();
        }));
      });
      if (!prodList.children.length) prodList.innerHTML = '<p class="muted">No loose product in your inventory. Harvest or brew something first.</p>';
      ingList.innerHTML = '';
      for (const ing of INGREDIENTS) {
        const n = inv.count(ing.item);
        if (!n) continue;
        ingList.appendChild(this.pickRow({ id: ing.item, qty: n }, ing.item === ingId, () => {
          ingId = ing.item;
          render();
        }, `adds ${EFFECTS[ing.adds].name}`));
      }
      if (!ingList.children.length) ingList.innerHTML = '<p class="muted">No mixers. Order some from the Market app.</p>';
      const s = inv.slots[prodSlot];
      const v = this.svc.variants.byKey(s?.v);
      qty = Math.max(1, Math.min(qty, maxQty()));
      if (v && ingId) {
        const next = mixEffects(v.effects, ingId);
        const key = VariantRegistry.comboKey(v.family, next);
        const known = [...this.svc.variants.variants.values()].find((x) => VariantRegistry.comboKey(x.family, x.effects) === key);
        const value = unitValue({ ...v, effects: next });
        preview.innerHTML = `<div class="mix-line"><div>${effectChips(v.effects)}</div><span class="arrow">+ ${ITEMS[ingId].name} →</span><div>${known ? effectChips(next) : '<span class="chip unknown">Unknown combination</span>'}</div></div>
          <p class="muted">${known ? `${esc(known.name)} · $${value}/unit (was $${unitValue(v)})` : 'Mix it to discover the result.'} · takes ${qty * 2} game minutes</p>`;
      } else preview.innerHTML = '<p class="muted">Pick a product and a mixer. Each unit uses one mixer.</p>';
      qtyRow.innerHTML = '';
      const m = maxQty();
      if (m > 0) {
        const dec = el('button', 'btn small', '−');
        const inc = el('button', 'btn small', '+');
        const lab = el('span', 'qty-lab', `${qty} of ${m} units`);
        dec.onclick = () => {
          qty = Math.max(1, qty - 1);
          render();
        };
        inc.onclick = () => {
          qty = Math.min(m, qty + 1);
          render();
        };
        const all = el('button', 'btn small', 'Max');
        all.onclick = () => {
          qty = m;
          render();
        };
        qtyRow.append(dec, lab, inc, all);
      }
      go.disabled = !(v && ingId && m > 0);
    };
    go.addEventListener('click', () => {
      const s = inv.slots[prodSlot];
      const v = this.svc.variants.byKey(s?.v);
      if (!s || !v || !ingId) return;
      const n = Math.min(qty, maxQty());
      if (!inv.remove(ingId, n)) return;
      inv.removeAt(prodSlot, n);
      const next = mixEffects(v.effects, ingId);
      const { variant, isNew } = this.svc.variants.get(v.family, next, v.quality, this.svc.time.day);
      const mins = n * (this.svc.upgrades.has('mixer2') ? 1 : 2);
      station.start({ remaining: mins, total: mins, output: { id: 'prod', qty: n, v: variant.key }, label: `${n} × ${variant.name}` });
      this.svc.bus.emit('objective:signal', { id: 'mix' });
      close();
      if (isNew) this.discovery(variant.key);
      else this.ui.toast(`Mixing ${n} × ${variant.name}.`, 'info');
    });
    render();
    this.ui.present(overlay);
  }

  /** New variant: celebrate and let the player name it. */
  discovery(key: string) {
    const v = this.svc.variants.byKey(key)!;
    const { overlay, body, close } = this.shell('New product discovered', FAMILIES[v.family].name);
    body.innerHTML = `<div class="discovery"><img src="${iconFor({ id: 'prod', v: key }, this.svc.variants)}" alt=""><div><div class="chips">${effectChips(v.effects)}</div><p class="muted">${QUALITY_NAMES[v.quality]} · worth about $${unitValue(v)} per unit</p></div></div>`;
    const row = el('div', 'name-row');
    const input = el('input');
    input.id = 'variant-name';
    input.maxLength = 28;
    input.value = v.name;
    const save = el('button', 'btn primary', 'Name it');
    save.onclick = () => {
      const name = input.value.trim();
      if (name) this.svc.variants.rename(key, name);
      close();
      this.ui.toast(`${name || v.name} added to your product book.`, 'good');
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') save.click();
    });
    row.append(input, save);
    body.appendChild(row);
    this.svc.audio.play('ui');
    this.ui.present(overlay);
    setTimeout(() => input.select(), 50);
  }

  // ------------------------------------------------------------------ packaging
  openPackager() {
    openPackagingBench(this.svc);
  }

  // ------------------------------------------------------------------ kettle and press
  openKettle(k: Kettle) {
    const { overlay, body, close } = this.shell('Dreamdust kettle', 'Moonsalt + Starwater → 8 Dreamdust');
    const inv = this.svc.inventory;
    const salt = inv.count('moonsalt');
    const water = inv.count('starwater');
    const glitter = inv.count('glitter');
    body.innerHTML = `<p>You have <strong>${salt}</strong> Moonsalt and <strong>${water}</strong> Starwater. A batch takes 60 game minutes.</p><p class="muted">Add Stardust glitter (${glitter}) for a Fine batch.</p>`;
    const row = el('div', 'btn-row');
    for (const fine of [false, true]) {
      const b = el('button', fine ? 'btn' : 'btn primary', fine ? 'Brew Fine batch (+1 glitter)' : 'Brew batch');
      b.disabled = salt < 1 || water < 1 || (fine && glitter < 1);
      b.onclick = () => {
        if (!inv.remove('moonsalt', 1)) return;
        if (!inv.remove('starwater', 1)) {
          inv.add('moonsalt', 1);
          return;
        }
        if (fine) inv.remove('glitter', 1);
        const q = (fine ? 1 : 0) as Quality;
        const { variant } = this.svc.variants.get('dreamdust', ['dreamy'], q, this.svc.time.day);
        const qty = this.svc.upgrades.has('kettle2') ? 12 : 8;
        k.start({ remaining: 60, total: 60, output: { id: 'prod', qty, v: variant.key }, label: `${qty} × ${variant.name}` });
        close();
        this.ui.toast('The kettle is brewing.', 'info');
      };
      row.appendChild(b);
    }
    body.appendChild(row);
    this.ui.present(overlay);
  }

  openPress(p: NeonPress) {
    const { overlay, body, close } = this.shell('Neon press', 'Neon resin → 10 Neon tablets');
    const inv = this.svc.inventory;
    const resin = inv.count('resin');
    body.innerHTML = `<p>You have <strong>${resin}</strong> Neon resin. A pressing takes 30 game minutes.</p>`;
    const b = el('button', 'btn primary', 'Press tablets');
    b.disabled = resin < 1;
    b.onclick = () => {
      if (!inv.remove('resin', 1)) return;
      const { variant } = this.svc.variants.get('neon', ['glowing'], 0, this.svc.time.day);
      p.start({ remaining: 30, total: 30, output: { id: 'prod', qty: 10, v: variant.key }, label: `10 × ${variant.name}` });
      close();
    };
    body.appendChild(b);
    this.ui.present(overlay);
  }

  openRack(r: DryingRack) {
    const { overlay, body, close } = this.shell('Drying rack', 'Up to 20 units · 2 hours · +1 quality tier');
    const inv = this.svc.inventory;
    const choices: { i: number; s: Stack; q: Quality; name: string }[] = [];
    inv.slots.forEach((s, i) => {
      if (!s || s.id !== 'prod') return;
      const v = this.svc.variants.byKey(s.v);
      if (!v || v.quality >= 2) return;
      choices.push({ i, s, q: v.quality, name: v.name });
    });
    if (!choices.length) {
      body.innerHTML = '<p>Bring loose product (Standard or Fine quality) in your backpack. Drying raises it one tier: Standard → Fine → Premium. Packaged product can\u2019t be dried.</p>';
      this.ui.present(overlay);
      return;
    }
    body.innerHTML = '<p>Choose a batch to hang. It stays on the rack until you collect it.</p>';
    const list = el('div', 'shop-list');
    for (const c of choices) {
      const qty = Math.min(20, c.s.qty);
      const row = el('div', 'shop-row');
      row.innerHTML = `<div><strong>${esc(c.name)}</strong><div class="muted">${QUALITY_NAMES[c.q]} → ${QUALITY_NAMES[c.q + 1]} · ${c.s.qty} in backpack</div></div>`;
      const b = el('button', 'btn primary', `Dry ${qty}`);
      b.onclick = () => {
        const v = this.svc.variants.byKey(c.s.v)!;
        if (!inv.remove('prod', qty, c.s.v)) return;
        const { variant } = this.svc.variants.get(v.family, v.effects, (v.quality + 1) as Quality, this.svc.time.day);
        r.start({ remaining: 120, total: 120, output: { id: 'prod', qty, v: variant.key }, label: `${qty} \u00d7 ${variant.name} (${QUALITY_NAMES[variant.quality]})` });
        this.svc.audio.play('place');
        close();
        this.ui.toast('Hung up to dry. Ready in 2 hours.', 'info');
      };
      row.appendChild(b);
      list.appendChild(row);
    }
    body.appendChild(list);
    this.ui.present(overlay);
  }

  /** The corner shop counter: equipment and packaging bought over the counter, straight into the backpack. */
  openShop(markup: number) {
    const { overlay, body } = this.shell('Kwik Corner', 'Mixers, gear and supplies · pay at the counter, carry it home', true);
    const out = el('p', 'result');
    const list = el('div', 'shop-list');
    const render = () => {
      list.innerHTML = '';
      // Mixers are only sold here (not on the phone), so they come first.
      const order = ['ingredient', 'supply', 'packaging', 'equipment'];
      const items = Object.values(ITEMS).filter((d) => d.price > 0 && order.includes(d.kind));
      items.sort((a, b) => (a.kind === b.kind ? a.price - b.price : order.indexOf(a.kind) - order.indexOf(b.kind)));
      for (const d of items) {
        const price = Math.round(d.price * markup);
        const locked = !this.svc.market.unlocked(d.id);
        const row = el('div', `shop-row${locked ? ' locked' : ''}`);
        const card = this.svc.economy.needsCard(price);
        row.innerHTML = `<div class="shop-icon"><img src="${iconFor({ id: d.id }, this.svc.variants)}" alt=""></div><div class="shop-info"><strong>${esc(d.name)}</strong> <span class="muted">${card ? '💳 card only · ' : ''}$${price}</span><div class="muted small">${esc(locked ? `Unlocks at $${d.unlock!.lifetimeRevenue.toLocaleString()} lifetime sales` : d.desc)}</div></div>`;
        const btns = el('div', 'btn-row tight');
        for (const n of d.stack >= 5 ? [1, 5] : [1]) {
          const b = el('button', 'btn small', `Buy ${n}`);
          b.disabled = locked || (card ? this.svc.economy.bank : this.svc.economy.cash) < price * n;
          b.onclick = () => {
            const r = this.svc.market.buyNow(d.id, n, markup);
            out.textContent = r.text;
            out.className = `result ${r.ok ? 'good' : 'bad'}`;
            render();
          };
          btns.appendChild(b);
        }
        row.appendChild(btns);
        list.appendChild(row);
      }
    };
    render();
    const note = el('p', 'muted', `The only place in town that sells mixers and brewing supplies. Gear costs ${Math.round((markup - 1) * 100)}% more than phone orders, but there\u2019s no wait. Equipment goes in your backpack \u2014 hold it in your hotbar and press E inside a property to place it.`);
    body.append(note, out, list);
    this.ui.present(overlay);
  }

  // ------------------------------------------------------------------ people
  openPerson(p: Person, prof: Profile) {
    const c = this.svc.customers;
    const want = c.wantUnits(prof);
    const { overlay, body, close } = this.shell(p.name, prof.unlocked ? `Customer · loyalty ${Math.round(prof.loyalty)}` : 'Stranger');
    const info = el('div', 'person-line');
    if (prof.unlocked) {
      info.innerHTML = `Likes ${effectChips(prof.likes)} · prefers ${FAMILIES[prof.family].name} · budget about $${prof.budget}<div class="need"><span>Wants right now</span><div class="need-bar"><i style="width:${Math.round(prof.need * 100)}%"></i></div><strong>${want ? `up to ${want} unit${want === 1 ? '' : 's'}` : 'nothing (still satisfied)'}</strong></div>`;
    } else info.textContent = `"${['Can I help you?', 'Do I know you?', 'Yeah?', 'What\u2019s up?'][p.index % 4]}"`;
    body.appendChild(info);
    const stacks = c.packagedStacks();
    if (!stacks.length) {
      body.appendChild(el('p', 'muted', 'You have no packaged product to offer. Package something at a packaging bench.'));
      this.ui.present(overlay);
      return;
    }
    let slot = stacks[0].slot;
    const list = el('div', 'pick-list');
    const action = el('div', 'offer');
    const log = el('div', 'haggle-log');
    body.append(this.labelled('Your packaged product', list), action, log);
    const line = (text: string, who: 'me' | 'them' | 'sys') => {
      const d = el('div', `hl ${who}`);
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };
    let haggle: import('../business/Customers').Haggle | null = null;
    const renderList = () => {
      list.innerHTML = '';
      for (const s of c.packagedStacks()) {
        const v = s.variant;
        const extra = prof.unlocked ? `${c.matches(prof, v)}/3 liked effects · fair ~$${Math.round(c.willingness(prof, v) * unitsOf(s.stack.id))} each` : `$${unitValue(v)}/unit`;
        list.appendChild(this.pickRow(s.stack, s.slot === slot, () => {
          if (haggle && !haggle.over) return;
          slot = s.slot;
          haggle = null;
          renderList();
          renderAction();
        }, extra));
      }
    };
    const renderAction = () => {
      action.innerHTML = '';
      const st = this.svc.inventory.slots[slot];
      if (!st) return;
      if (!prof.unlocked) {
        const b = el('button', 'btn primary', 'Give a free sample');
        b.onclick = () => {
          line(c.giveSample(p, slot), 'sys');
          this.svc.audio.play('pickup');
          renderList();
          if (prof.unlocked) setTimeout(() => this.openPerson(p, prof), 1600);
        };
        action.appendChild(b);
        action.appendChild(el('span', 'muted', 'Strangers try one unit. If they like it they become customers. Products with effects they like work best.'));
        return;
      }
      const v = this.svc.variants.byKey(st.v)!;
      const per = unitsOf(st.id);
      const maxQty = Math.max(1, Math.min(st.qty, Math.floor(c.wantUnits(prof) / per)));
      let qty = Math.min(maxQty, haggle?.qty ?? 1);
      const fair = () => Math.round(c.willingness(prof, v) * per * qty);
      let ask = haggle ? Math.max(haggle.counter + 5, Math.round(fair() * 1.1)) : Math.round(fair() * 1.15);
      const lab = el('span', 'qty-lab');
      const priceIn = el('input');
      priceIn.type = 'number';
      priceIn.id = 'offer-price';
      priceIn.min = '1';
      priceIn.addEventListener('keydown', (e) => e.stopPropagation());
      priceIn.addEventListener('input', () => (ask = Math.max(1, Math.round(Number(priceIn.value) || 0))));
      const upd = () => {
        lab.textContent = `${qty} × (${qty * per} units)`;
        priceIn.value = String(ask);
      };
      const dec = el('button', 'btn small', '−');
      const inc = el('button', 'btn small', '+');
      const locked = !!haggle && !haggle.over;
      dec.disabled = inc.disabled = locked;
      dec.onclick = () => {
        qty = Math.max(1, qty - 1);
        ask = Math.round(fair() * 1.15);
        upd();
      };
      inc.onclick = () => {
        qty = Math.min(maxQty, qty + 1);
        ask = Math.round(fair() * 1.15);
        upd();
      };
      upd();
      const offer = el('button', 'btn primary', haggle && !haggle.over ? 'Counter' : 'Offer');
      offer.onclick = () => {
        if (!haggle || haggle.over) {
          const h = c.startHaggle(p, slot, qty);
          if (typeof h === 'string') {
            line(h, 'sys');
            return;
          }
          haggle = h;
        }
        line(`You: "${qty * per} for $${ask}."`, 'me');
        const r = c.offer(haggle, ask);
        respond(r);
      };
      const priceWrap = el('label', 'price', '$');
      priceWrap.appendChild(priceIn);
      action.append(dec, lab, inc, priceWrap, offer);
      if (haggle && !haggle.over) {
        const take = el('button', 'btn', `Accept $${haggle.counter}`);
        take.onclick = () => respond(c.acceptCounter(haggle!));
        const walk = el('button', 'btn', 'Walk away');
        walk.onclick = () => {
          haggle!.over = true;
          line('You walked away.', 'sys');
          renderAction();
        };
        action.append(take, walk);
        const pips = el('span', 'patience', `Patience ${'●'.repeat(haggle.patience)}${'○'.repeat(Math.max(0, 3 - haggle.patience))}`);
        action.appendChild(pips);
      }
    };
    const respond = (r: import('../business/Customers').HaggleResult) => {
      line(r.text, r.kind === 'accept' ? 'them good' as 'them' : r.kind === 'walk' ? 'them bad' as 'them' : 'them');
      if (r.kind === 'accept') {
        haggle = null;
        renderList();
        setTimeout(close, 1400);
        return;
      }
      if (r.kind === 'walk') haggle = null;
      renderList();
      renderAction();
    };
    renderList();
    renderAction();
    if (prof.unlocked && want <= 0) line(`${p.name}: "I'm still good from last time. Ask me again tomorrow."`, 'them');
    this.ui.present(overlay);
  }

  // ------------------------------------------------------------------ properties
  openPropertySale(def: import('../properties/PropertyDefs').PropertyDef) {
    const { overlay, body, close } = this.shell(def.name, `For sale · ${DISTRICTS[def.district].name}`);
    const own = this.svc.properties.owns(def.id);
    body.innerHTML = `<p>${def.desc}</p><div class="fact-grid"><div><span>Price</span><strong>$${def.price.toLocaleString()}</strong></div><div><span>Running cost</span><strong>$${def.upkeep}/day</strong></div><div><span>Staff</span><strong>${def.staff}</strong></div><div><span>Storage</span><strong>${def.storage} slots</strong></div></div><p class="muted">Includes ${def.includes.map(([k, n]) => `${n} × ${ITEMS[k]?.name ?? k}`).join(', ')}. Buy more equipment in the Market and choose this property as the delivery address.</p>`;
    const row = el('div', 'btn-row');
    const buy = el('button', 'btn primary', own ? 'Owned' : `Buy for $${def.price.toLocaleString()}`);
    buy.disabled = own;
    const out = el('p', 'result');
    buy.onclick = () => {
      const r = this.svc.properties.buy(def.id);
      out.textContent = r;
      out.className = `result ${this.svc.properties.owns(def.id) ? 'good' : 'bad'}`;
      if (this.svc.properties.owns(def.id)) {
        buy.disabled = true;
        buy.textContent = 'Owned';
        setTimeout(close, 1500);
      }
    };
    row.appendChild(buy);
    body.append(row, out);
    this.ui.present(overlay);
  }

  // ------------------------------------------------------------------ multiplayer trades
  openTrade(to: string, name: string) {
    const { overlay, body, close } = this.shell(`Trade with ${name}`, 'Pick items and cash to give. They can accept or decline.');
    const inv = this.svc.inventory;
    const chosen = new Map<number, number>();
    const grid = el('div', 'pick-list');
    const cashIn = el('input');
    cashIn.type = 'number';
    cashIn.id = 'trade-cash';
    cashIn.min = '0';
    cashIn.value = '0';
    cashIn.addEventListener('keydown', (e) => e.stopPropagation());
    const render = () => {
      grid.innerHTML = '';
      inv.slots.forEach((s, i) => {
        if (!s) return;
        const q = chosen.get(i) ?? 0;
        const row = this.pickRow(s, q > 0, () => {
          chosen.set(i, q >= s.qty ? 0 : q + Math.max(1, Math.ceil(s.qty / 4)));
          if ((chosen.get(i) ?? 0) > s.qty) chosen.set(i, s.qty);
          render();
        }, q ? `Giving ${q} of ${s.qty} (click for more, past max to clear)` : 'Click to add');
        grid.appendChild(row);
      });
      if (!grid.children.length) grid.innerHTML = '<p class="muted">Your inventory is empty.</p>';
    };
    const cashWrap = el('label', 'price', 'Cash $');
    cashWrap.appendChild(cashIn);
    const send = el('button', 'btn primary', 'Send offer');
    const out = el('p', 'result');
    send.onclick = () => {
      const slots = [...chosen].filter(([, q]) => q > 0).map(([slot, qty]) => ({ slot, qty }));
      const cash = Math.max(0, Math.round(Number(cashIn.value) || 0));
      if (!slots.length && !cash) {
        out.textContent = 'Choose something to give.';
        return;
      }
      out.textContent = this.svc.net.offerTrade(to, slots, cash);
      setTimeout(close, 900);
    };
    body.append(this.labelled('Your items', grid), cashWrap, send, out);
    render();
    this.ui.present(overlay);
  }

  openTradeOffer(o: import('../net/Net').TradeOffer) {
    const { overlay, body, close } = this.shell(`${o.name} offers you`, 'Multiplayer trade');
    const list = el('div', 'pick-list');
    for (const it of o.items) list.appendChild(this.pickRow(it, false, () => {}));
    if (o.cash) list.appendChild(el('p', undefined, `<strong>$${o.cash.toLocaleString()}</strong> cash`));
    const row = el('div', 'btn-row');
    const yes = el('button', 'btn primary', 'Accept');
    const no = el('button', 'btn', 'Decline');
    yes.onclick = () => {
      this.ui.toast(this.svc.net.answerTrade(o.tid, true), 'good');
      close();
    };
    no.onclick = () => {
      this.svc.net.answerTrade(o.tid, false);
      close();
    };
    row.append(yes, no);
    body.append(list, row);
    this.svc.audio.play('ui');
    this.ui.present(overlay, () => {
      // Closing without answering declines.
      if (this.svc.net.offers.some((x) => x.tid === o.tid)) this.svc.net.answerTrade(o.tid, false);
    });
  }

  openMultiplayer(onDone: () => void) {
    const net = this.svc.net;
    const { overlay, body } = this.shell('Multiplayer', 'Join a world that is running right now, or host your own', true);
    const saved = (() => {
      try {
        return JSON.parse(localStorage.getItem('ue.mp') || '{}') as { name?: string; room?: string; url?: string; outfit?: string; world?: string; public?: boolean };
      } catch {
        return {};
      }
    })();
    const remember = (extra: Record<string, unknown>) => {
      try {
        localStorage.setItem('ue.mp', JSON.stringify({ ...saved, name: name.value, url: url.value, outfit: sel.value, ...extra }));
      } catch {
        /* ignore */
      }
    };
    const field = (parent: HTMLElement, id: string, label: string, value: string, max = 20) => {
      const row = el('div', 'setting');
      const lab = el('label', undefined, label);
      lab.htmlFor = id;
      const input = el('input') as HTMLInputElement;
      input.id = id;
      input.value = value;
      input.maxLength = max;
      input.className = 'text-in';
      input.addEventListener('keydown', (e) => e.stopPropagation());
      row.append(lab, input);
      parent.appendChild(row);
      return input;
    };

    // You: name and character.
    const me = el('div', 'mp-me');
    const name = field(me, 'mp-name', 'Your name', saved.name ?? `Player${Math.floor(Math.random() * 90 + 10)}`);
    const outfitRow = el('div', 'setting');
    outfitRow.appendChild(el('label', undefined, 'Character'));
    const sel = el('select') as HTMLSelectElement;
    for (const o of ['Casual_Hoodie', 'Casual_2', 'Beach', 'Farmer', 'Punk', 'Suit', 'Worker', 'Adventurer']) {
      const op = el('option', undefined, o.replace('_', ' ')) as HTMLOptionElement;
      op.value = o;
      sel.appendChild(op);
    }
    sel.value = saved.outfit ?? 'Casual_Hoodie';
    outfitRow.appendChild(sel);
    me.appendChild(outfitRow);

    const out = el('p', 'result');
    const join = async (code: string, opts: import('../net/Net').JoinOpts = {}) => {
      out.className = 'result';
      out.textContent = `Connecting to ${opts.world ?? code}…`;
      remember({ room: code, world: opts.world ?? saved.world, public: opts.public ?? saved.public });
      const err = await net.connect(url.value.trim(), code, name.value, sel.value as import('../npc/Characters').Outfit, opts);
      if (err) {
        out.className = 'result bad';
        out.textContent = /claude\.ai|artifact/.test(location.host) || location.protocol === 'about:' ? `${err} Multiplayer needs the game server: open the game from your Render site.` : err;
        return;
      }
      out.className = 'result good';
      out.textContent = `Joined ${net.world}.`;
      setTimeout(onDone, 600);
    };

    // Tabs: browse running worlds, host your own, join by code.
    const tabs = el('div', 'mp-tabs');
    const pane = el('div', 'mp-pane');
    const tab = (id: string, label: string) => {
      const b = el('button', 'mp-tab', label);
      b.dataset.tab = id;
      b.onclick = () => show(id);
      tabs.appendChild(b);
    };
    tab('browse', 'Browse worlds');
    tab('host', 'Host a world');
    tab('code', 'Join with a code');
    let refresh = 0;
    const show = (id: string) => {
      clearInterval(refresh);
      tabs.querySelectorAll<HTMLElement>('.mp-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
      pane.innerHTML = '';
      if (id === 'browse') {
        const list = el('div', 'mp-list', '<p class="muted">Looking for worlds…</p>');
        const head = el('div', 'mp-browse-head');
        const count = el('span', 'muted');
        const again = el('button', 'btn small', 'Refresh');
        head.append(count, again);
        pane.append(head, list);
        const load = async () => {
          const r = await net.listRooms(url.value.trim());
          if (!list.isConnected) return;
          if ('error' in r) {
            count.textContent = '';
            list.innerHTML = `<p class="muted">${r.error} ${/claude\.ai|artifact/.test(location.host) ? 'This preview page can\u2019t go online: open the game from your Render site.' : 'Check the server address under Advanced.'}</p>`;
            return;
          }
          count.textContent = `${r.rooms.length} public world${r.rooms.length === 1 ? '' : 's'} · ${r.online} player${r.online === 1 ? '' : 's'} online`;
          list.innerHTML = '';
          if (!r.rooms.length) list.innerHTML = '<p class="muted">No public worlds running right now. Host one and your friends will see it here.</p>';
          for (const w of r.rooms) {
            const h = Math.floor(w.minutes / 60);
            const mm = String(Math.floor(w.minutes % 60)).padStart(2, '0');
            const mine = net.online && net.room === w.code;
            const row = el(
              'div',
              'mp-world',
              `<div class="mp-world-main"><strong>${escapeHtml(w.name)}</strong><span class="muted small">${w.waiting ? '<b class="mp-wait">Host reconnecting</b> · ' : `Hosted by ${escapeHtml(w.host)} · `}Day ${w.day}, ${String(h).padStart(2, '0')}:${mm} · code ${w.code}</span><span class="mp-names">${w.names.map((n) => `<i>${escapeHtml(n)}</i>`).join('')}</span></div><div class="mp-world-side"><span class="mp-count${w.players >= w.max ? ' full' : ''}">${w.players}/${w.max}</span></div>`,
            );
            const b = el('button', `btn ${mine ? '' : 'primary'}`, mine ? 'You\u2019re here' : w.players >= w.max ? 'Full' : 'Join') as HTMLButtonElement;
            b.disabled = mine || w.players >= w.max;
            b.onclick = () => void join(w.code, { world: w.name, role: 'join' });
            row.querySelector('.mp-world-side')!.appendChild(b);
            list.appendChild(row);
          }
        };
        again.onclick = () => void load();
        void load();
        refresh = window.setInterval(() => void load(), 4000);
      } else if (id === 'host') {
        // Every world is its own game: its own money, backpacks, equipment and progress for everyone.
        const pubRow = el('label', 'mp-check');
        const pub = el('input') as HTMLInputElement;
        pub.type = 'checkbox';
        pub.checked = saved.public !== false;
        pubRow.append(pub, el('span', undefined, 'List it publicly so anyone can find and join it'));
        const fresh = el('div', 'mp-new');
        fresh.appendChild(el('div', 'section-label', 'New world'));
        const world = field(fresh, 'mp-world', 'World name', `${name.value}'s world`, 32);
        const code = Math.random().toString(36).slice(2, 6).toUpperCase();
        fresh.appendChild(pubRow);
        fresh.appendChild(el('p', 'muted', `Everyone starts from scratch here: new money, empty backpacks, a bare house. Your single-player save isn't touched. Friends can join from the browser or with the code <strong>${code}</strong>.`));
        const go = el('button', 'btn primary', 'Start a new world') as HTMLButtonElement;
        go.id = 'mp-host-new';
        go.onclick = () => void join(code, { world: world.value.trim() || `${name.value}'s world`, public: pub.checked, wid: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, role: 'host' });
        fresh.appendChild(go);
        pane.appendChild(fresh);
        // Your own saved game, hosted as it is (friends join you in it with their own money and backpacks).
        const own = el('div', 'mp-list');
        pane.appendChild(own);
        void this.ui.hostableGames().then((games) => {
          if (!games.length || !own.isConnected) return;
          own.appendChild(el('div', 'section-label', 'Host your own game'));
          for (const gm of games) {
            const prev = hostedWorlds().find((w) => w.wid === gm.wid);
            const label = prev?.name ?? `${name.value}'s game`;
            const row = el(
              'div',
              'mp-world',
              `<div class="mp-world-main"><strong>${gm.current ? 'Your current game' : `Save slot ${gm.slot}`}</strong><span class="muted small">Day ${gm.day} · $${gm.cash.toLocaleString()} · slot ${gm.slot}${prev ? ` · code ${escapeHtml(prev.code)}` : ''}</span></div><div class="mp-world-side"></div>`,
            );
            const b = el('button', 'btn primary', 'Host this game') as HTMLButtonElement;
            b.onclick = () => void join(prev?.code ?? code, { world: world.value.trim() && world.value.trim() !== `${name.value}'s world` ? world.value.trim() : label, public: pub.checked, wid: gm.wid, slot: gm.slot, role: 'host' });
            row.querySelector('.mp-world-side')!.appendChild(b);
            own.appendChild(row);
          }
          own.appendChild(el('p', 'muted', 'Everything you’ve built is there; your progress keeps saving to that slot. If you lose connection, the world waits for you to come back.'));
        });
        const mine = hostedWorlds().filter((w) => w.slot === undefined);
        if (mine.length) {
          const cont = el('div', 'mp-list');
          pane.appendChild(el('div', 'section-label', 'Carry on with a world you hosted'));
          for (const w of mine) {
            const row = el(
              'div',
              'mp-world',
              `<div class="mp-world-main"><strong>${escapeHtml(w.name)}</strong><span class="muted small">Day ${w.day} · your cash there $${w.cash.toLocaleString()} · code ${escapeHtml(w.code)} · last played ${new Date(w.savedAt).toLocaleDateString()}</span></div><div class="mp-world-side"></div>`,
            );
            const b = el('button', 'btn', 'Host again') as HTMLButtonElement;
            b.onclick = () => void join(w.code, { world: w.name, public: pub.checked, wid: w.wid, role: 'host' });
            row.querySelector('.mp-world-side')!.appendChild(b);
            cont.appendChild(row);
          }
          pane.appendChild(cont);
          pane.appendChild(el('p', 'muted', 'Friends who played there before get their own money and backpack from that world back.'));
        }
      } else {
        const code = field(pane, 'mp-room', 'World code', saved.room ?? '', 12);
        code.style.textTransform = 'uppercase';
        const go = el('button', 'btn primary', 'Join') as HTMLButtonElement;
        go.onclick = () => code.value.trim() && void join(code.value.trim().toUpperCase(), { wid: `code-${code.value.trim().toUpperCase()}` });
        code.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
        pane.append(go, el('p', 'muted', 'Private worlds don\u2019t show in the browser: ask the host for their code. If nobody is using that code yet, you start a new world with it. Every world keeps its own money and progress for you.'));
      }
    };

    // Advanced: server address (defaults to the server the game was loaded from).
    const adv = el('details', 'mp-adv');
    adv.appendChild(el('summary', undefined, 'Advanced'));
    const url = field(adv, 'mp-url', 'Server', saved.url && !/localhost/.test(saved.url) ? saved.url : net.defaultUrl(), 120);

    const status = el('div', 'mp-status');
    if (net.online) {
      status.innerHTML = `Connected to <strong>${escapeHtml(net.world)}</strong> (code ${net.room}) · ${net.players.size + 1} player(s)${net.isHost ? ' · you are the host' : ''}`;
      const leave = el('button', 'btn small', 'Leave');
      leave.onclick = () => {
        net.disconnect();
        status.textContent = 'Left the world. Your progress there is saved, and your own game is back.';
      };
      status.appendChild(leave);
    }
    body.append(me, status, tabs, pane, out, adv);
    show('browse');
    this.ui.present(overlay, () => clearInterval(refresh));
  }

  // ------------------------------------------------------------------ cheats
  openCheats(sections: { title: string; items: CheatAction[] }[]) {
    const { overlay, body, close } = this.shell('Cheats', 'Press 7, 8, 5 to open this · the host can turn cheats off in Settings', true);
    const out = el('pre', 'cheat-out');
    for (const sec of sections) {
      body.appendChild(el('div', 'section-label', sec.title));
      const g = el('div', 'cheat-grid');
      for (const it of sec.items) {
        const b = el('button', 'btn', esc(it.label));
        b.onclick = async () => {
          this.svc.audio.play('ui');
          const r = await it.run();
          if (it.keep) out.textContent = typeof r === 'string' ? r : 'Done.';
          else {
            close();
            if (typeof r === 'string') this.ui.toast(r, 'info');
          }
        };
        g.appendChild(b);
      }
      body.appendChild(g);
    }
    body.appendChild(out);
    this.ui.present(overlay);
  }

  // ------------------------------------------------------------------ helpers
  private labelled(title: string, child: HTMLElement) {
    const w = el('div');
    w.appendChild(el('div', 'section-label', title));
    w.appendChild(child);
    return w;
  }

  private pickRow(s: Stack, selected: boolean, onPick: () => void, extra?: string): HTMLElement {
    const b = el('button', `pick${selected ? ' selected' : ''}`);
    const v = this.svc.variants.byKey(s.v);
    b.innerHTML = `<img src="${iconFor(s, this.svc.variants)}" alt=""><span class="pick-text"><strong>${esc(stackName(s, this.svc.variants))}</strong> <span class="muted">× ${s.qty}</span>${v ? `<span class="chips">${effectChips(v.effects)}</span>` : ''}${extra ? `<span class="muted">${esc(extra)}</span>` : ''}</span>`;
    b.onclick = onPick;
    return b;
  }
}
