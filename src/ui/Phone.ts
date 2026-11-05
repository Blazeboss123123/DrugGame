import type { Services } from '../core/Services';
import { ROLES, SHIFTS, type Role, type Shift } from '../employees/Employees';
import { DELIVERY_MINUTES } from '../economy/Market';
import { GANGS, GANG_IDS } from '../business/Rivals';
import { UPGRADES } from '../business/Upgrades';
import { EFFECTS, FAMILIES, INGREDIENTS, ITEMS, QUALITY_NAMES, unitValue } from '../products/Catalog';
import { PROPERTIES } from '../properties/PropertyDefs';
import { NEIGHBOURHOODS } from '../npc/Neighbourhoods';
import { SHOP } from '../properties/CornerShop';
import { PAINTS, VEHICLE_TYPES, type VehicleType } from '../vehicles/Vehicles';
import { DISTRICTS, GRID, WORLD_HALF, X_LINES, Z_LINES, districtAt, riverX, type District } from '../world/CityPlan';
import { iconFor } from './Icons';
import { effectChips } from './Panels';
import type { UI } from './UI';

type App = 'home' | 'messages' | 'thread' | 'market' | 'upgrades' | 'contacts' | 'products' | 'finance' | 'map' | 'staff' | 'properties' | 'vehicles' | 'turf' | 'online';

const APPS: { id: App; name: string; color: string; glyph: string }[] = [
  { id: 'messages', name: 'Messages', color: '#3fae6a', glyph: '✉' },
  { id: 'market', name: 'Market', color: '#d98a2b', glyph: '⛁' },
  { id: 'upgrades', name: 'Upgrades', color: '#3a8f5c', glyph: '▲' },
  { id: 'contacts', name: 'Customers', color: '#4a7fc1', glyph: '☺' },
  { id: 'products', name: 'Products', color: '#8a5cc2', glyph: '❖' },
  { id: 'staff', name: 'Staff', color: '#2f6b7a', glyph: '⚒' },
  { id: 'properties', name: 'Realty', color: '#b3261e', glyph: '⌂' },
  { id: 'vehicles', name: 'Cars', color: '#5a6068', glyph: '⛟' },
  { id: 'turf', name: 'Turf', color: '#7a2f9a', glyph: '⚑' },
  { id: 'finance', name: 'Finance', color: '#2f8f8a', glyph: '$' },
  { id: 'map', name: 'Map', color: '#c2553a', glyph: '⌖' },
  { id: 'online', name: 'Online', color: '#e0a030', glyph: '⇄' },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The in-game smartphone. */
export class Phone {
  private app: App = 'home';
  private thread = '';
  private screen!: HTMLElement;
  private cart = new Map<string, number>();
  private deliverTo = 'home';
  private paint = PAINTS[0];
  private timer = 0;
  private lastVersion = -1;
  private flash = '';
  unread = new Set<App>();

  constructor(
    private ui: UI,
    private svc: Services,
  ) {
    svc.bus.on('phone:notify', (n) => {
      this.unread.add(n.app as App);
      this.ui.hud.notify(n.text);
      this.svc.audio.play('ui');
    });
  }

  open(app: App = 'home') {
    this.app = app;
    const overlay = document.createElement('div');
    overlay.className = 'overlay phone-overlay';
    const phone = document.createElement('div');
    phone.className = 'phone';
    phone.innerHTML = '<div class="phone-notch"></div>';
    this.screen = document.createElement('div');
    this.screen.className = 'phone-screen';
    phone.appendChild(this.screen);
    const home = document.createElement('button');
    home.className = 'phone-home';
    home.setAttribute('aria-label', 'Home');
    home.onclick = () => this.go('home');
    phone.appendChild(home);
    overlay.appendChild(phone);
    overlay.addEventListener('click', (e) => e.target === overlay && this.ui.dismiss());
    this.svc.bus.emit('objective:signal', { id: 'phone' });
    this.render();
    this.timer = window.setInterval(() => {
      const live = ['home', 'market', 'map', 'staff', 'online'].includes(this.app);
      const msgChanged = (this.app === 'messages' || this.app === 'thread') && this.svc.customers.version !== this.lastVersion;
      if (live || msgChanged) {
        const st = this.screen.scrollTop;
        const focus = document.activeElement?.id;
        if (focus === 'chat-in' || focus === 'counter-in') return;
        this.render();
        this.screen.scrollTop = st;
      }
    }, 1000);
    this.ui.present(overlay, () => clearInterval(this.timer));
  }

  private go(app: App, thread = '') {
    this.app = app;
    this.thread = thread;
    this.unread.delete(app);
    this.flash = '';
    this.render();
    this.screen.scrollTop = app === 'thread' ? this.screen.scrollHeight : 0;
  }

  private header(title: string, back: App = 'home') {
    return `<div class="app-head"><button class="back" data-go="${back}">‹</button><h3>${title}</h3><span>$${this.svc.economy.cash.toLocaleString()}</span></div>${this.flash ? `<div class="flash">${esc(this.flash)}</div>` : ''}`;
  }

  private render() {
    const s = this.svc;
    const t = s.time;
    let html = `<div class="phone-status"><span>${t.label}</span><span>${s.net.online ? `● ${esc(s.net.room)} · ` : ''}${t.weekday} · Day ${t.day}</span></div>`;
    switch (this.app) {
      case 'home': {
        const deals = s.customers.deals.filter((d) => d.status === 'accepted');
        html += `<div class="phone-wall"><div class="wall-time">${t.label}</div><div class="wall-cash">$${s.economy.cash.toLocaleString()}</div>`;
        for (const d of deals.slice(0, 2)) html += `<div class="wall-card">Meet ${esc(s.customers.person(d.person).name)} · ${d.units} × ${FAMILIES[d.family].name} · ${esc(d.meet.name)}</div>`;
        if (s.market.pending.length) html += `<div class="wall-card">${s.market.pending.length} order(s) on the way</div>`;
        if (s.employees.list.length) html += `<div class="wall-card">${s.employees.list.length} staff · wages $${s.employees.dailyWages}/day</div>`;
        html += '</div><div class="app-grid">';
        const unreadMsgs = s.customers.unread;
        for (const a of APPS) {
          const badge = a.id === 'messages' ? unreadMsgs > 0 : this.unread.has(a.id);
          html += `<button class="app-icon" data-go="${a.id}"><span class="glyph" style="background:${a.color}">${a.glyph}${badge ? `<i class="badge">${a.id === 'messages' && unreadMsgs ? unreadMsgs : ''}</i>` : ''}</span>${a.name}</button>`;
        }
        html += '</div>';
        break;
      }
      case 'messages': {
        html += this.header('Messages');
        const threads = [...s.customers.threads.values()].sort((a, b) => b.updated - a.updated);
        if (!threads.length) html += '<p class="empty">No messages yet. Win customers with free samples and they will text you when they want to buy.</p>';
        for (const th of threads) {
          const last = th.msgs[th.msgs.length - 1];
          const open = th.msgs.some((m) => m.deal && s.customers.deals.find((d) => d.id === m.deal)?.status === 'offered');
          html += `<button class="thread-row" data-thread="${esc(th.key)}"><span class="avatar" style="background:${th.color}">${esc(th.name[0] ?? '?')}</span><span class="tr-text"><strong>${esc(th.name)}${open ? ' <em class="tag">Wants to buy</em>' : ''}</strong><span>${last ? esc((last.me ? 'You: ' : '') + last.text) : ''}</span></span>${th.unread ? `<i class="badge inline">${th.unread}</i>` : ''}</button>`;
        }
        this.lastVersion = s.customers.version;
        break;
      }
      case 'thread': {
        const th = s.customers.threads.get(this.thread);
        if (!th) return this.go('messages');
        th.unread = 0;
        this.lastVersion = s.customers.version;
        html += this.header(esc(th.name), 'messages');
        const prof = th.key.startsWith('c:') ? s.customers.profiles.get(Number(th.key.slice(2))) : undefined;
        if (prof) html += `<div class="thread-info">Likes ${effectChips(prof.likes)} · loyalty ${Math.round(prof.loyalty)} · wants ${s.customers.wantUnits(prof)} now</div>`;
        html += '<div class="bubbles">';
        for (const m of th.msgs) {
          const d = m.deal ? s.customers.deals.find((x) => x.id === m.deal) : undefined;
          let actions = '';
          if (d?.status === 'offered' && th.msgs[th.msgs.length - 1] === m)
            actions = `<div class="msg-actions"><button class="pbtn ok" data-accept="${d.id}">Accept $${d.price}</button><button class="pbtn" data-counter="${d.id}">Counter</button><button class="pbtn" data-decline="${d.id}">Decline</button></div><div class="counter-row" data-counter-row="${d.id}" hidden><span>$</span><input id="counter-in" type="number" value="${Math.round(d.price * 1.2)}"><button class="pbtn ok" data-send-counter="${d.id}">Send</button></div>`;
          else if (d && th.msgs[th.msgs.length - 1] === m && d.status !== 'offered') actions = `<div class="msg-state ${d.status}">${{ accepted: `Meet at ${esc(d.meet.name)}`, done: 'Completed', failed: 'Expired', declined: 'Declined', offered: '' }[d.status]}</div>`;
          html += `<div class="bubble ${m.me ? 'me' : 'them'}"><div>${esc(m.text)}</div><span>${m.at}</span>${actions}</div>`;
        }
        html += '</div>';
        break;
      }
      case 'market': {
        html += this.header('Market');
        const owned = s.properties.ownedList();
        html += `<div class="deliver"><span>Deliver to</span><select id="deliver-to">${owned.map((id) => `<option value="${id}" ${id === this.deliverTo ? 'selected' : ''}>${esc(s.properties.name(id))}</option>`).join('')}</select></div>`;
        const groups: [string, string[]][] = [
          ['Grow', ['seed_violet', 'seed_fern', 'seed_ember', 'soil', 'soil_rich', 'fertilizer', 'wateringcan']],
          ['Mixers', INGREDIENTS.map((i) => i.item)],
          ['Packaging', ['baggie', 'jar']],
          ['Dreamdust & Neon', ['moonsalt', 'starwater', 'resin']],
          ['Equipment (delivered as boxes; hold one and press E to place it)', ['pot', 'lamp', 'rack', 'storage', 'mixer', 'packager', 'kettle', 'press']],
          ['Gear', ['skateboard']],
        ];
        const total = [...this.cart].reduce((a, [id, q]) => a + ITEMS[id].price * q, 0);
        for (const [g, ids] of groups) {
          html += `<div class="mk-group"${g.startsWith('Equipment') ? ' id="mk-equip"' : ''}>${g}</div>`;
          for (const id of ids) {
            const d = ITEMS[id];
            const block = s.market.canBuy(id, this.deliverTo);
            const q = this.cart.get(id) ?? 0;
            html += `<div class="mk-row${block ? ' locked' : ''}"><img src="${iconFor({ id }, s.variants)}" alt=""><div class="mk-text"><strong>${d.name}</strong><span>${block ?? esc(d.desc)}</span></div><div class="mk-buy"><span class="price">$${d.price}</span>${block ? '' : `<div class="stepper"><button data-dec="${id}">−</button><span>${q}</span><button data-inc="${id}">+</button></div>`}</div></div>`;
          }
        }
        const pend = s.market.pending.map((p) => `#${p.id} → ${esc(s.properties.name(p.site))} in ${Math.max(0, Math.ceil(p.arrives - (t.day * 1440 + t.minutes)))} min`).join(' · ');
        html += `<div class="mk-foot"><div>${pend || `Delivered in ~${DELIVERY_MINUTES} min`}</div><button class="pbtn ok" data-order="1" ${total ? '' : 'disabled'}>Order · $${total}</button></div>`;
        break;
      }
      case 'upgrades': {
        html += this.header('Upgrades');
        html += '<p class="empty">Expand your operation. Equipment you order arrives in boxes at the delivery address; carry it in and press E to set it down anywhere in a workspace. The Kwik Corner shop on Ash Ave sells the same gear over the counter.</p>';
        for (const grp of ['Property', 'Production', 'Business'] as const) {
          html += `<div class="mk-group">${grp}</div>`;
          for (const u of UPGRADES.filter((x) => x.group === grp)) {
            const st = s.upgrades.status(u);
            const owned = s.upgrades.has(u.id);
            html += `<div class="contact upg-card${owned ? ' owned' : ''}${st && !owned ? ' locked' : ''}"><div class="contact-top"><strong>${esc(u.name)}</strong><span>${owned ? 'Owned' : `$${u.price.toLocaleString()}`}</span></div><p class="small">${esc(u.desc)}</p><div class="emp-actions">${owned ? '<span class="muted">Active</span>' : st ? `<span class="muted small">${esc(st)}</span>` : `<button class="pbtn ok" data-upgrade="${u.id}" ${s.economy.cash < u.price ? 'disabled' : ''}>Buy · $${u.price.toLocaleString()}</button>`}</div></div>`;
          }
        }
        html += '<div class="mk-group">Your workspaces</div>';
        for (const id of s.properties.ownedList()) {
          const site = s.production.sites.get(id);
          if (!site) continue;
          const kinds = ['pot', 'lamp', 'rack', 'storage', 'mixer', 'packager', 'kettle', 'press'].map((k) => [k, site.count(k)] as const).filter(([, n]) => n > 0);
          html += `<div class="contact"><div class="contact-top"><strong>${esc(s.properties.name(id))}</strong><span>${site.stations.length} placed</span></div><span class="muted small">${kinds.map(([k, n]) => `${n} × ${ITEMS[k].name}`).join(' · ') || 'Empty'}</span><div class="emp-actions"><button class="pbtn" data-orderfor="${id}">Order equipment here</button></div></div>`;
        }
        break;
      }
      case 'contacts': {
        html += this.header('Customers');
        const hoodOf = (idx: number) => s.customers.person(idx).hood ?? 99;
        const cs = s.customers.customers.sort((a, b) => hoodOf(a.idx) - hoodOf(b.idx) || b.loyalty - a.loyalty);
        html += `<p class="empty">${cs.length} customer${cs.length === 1 ? '' : 's'}, grouped by where they live. They hang around their own neighbourhood and want to meet there. Each one only wants so much at a time; their need refills over about a day.</p>`;
        let lastHood = -2;
        for (const c of cs) {
          const p = s.customers.person(c.idx);
          if ((p.hood ?? -1) !== lastHood) {
            lastHood = p.hood ?? -1;
            const h = p.hood !== null ? NEIGHBOURHOODS[p.hood] : null;
            html += `<div class="mk-group">${h ? `${esc(h.name)} <span class="muted small">${esc(h.blurb)}</span>` : 'Elsewhere'}</div>`;
          }
          html += `<div class="contact"><div class="contact-top"><strong>${esc(p.name)}</strong><span>${c.deals} deals · $${c.spent}</span></div><div class="dual"><span>Loyalty</span><div class="loyalty"><i style="width:${c.loyalty}%"></i></div><span>Wants</span><div class="loyalty need"><i style="width:${Math.round(c.need * 100)}%"></i></div></div><div class="chips">${effectChips(c.likes)}</div><span class="muted">Prefers ${FAMILIES[c.family].name} · budget ~$${c.budget} · up to ${c.appetite} units · lives in ${p.hood !== null ? NEIGHBOURHOODS[p.hood].name : DISTRICTS[districtAt(p.x, p.z)].name}</span></div>`;
        }
        break;
      }
      case 'products': {
        html += this.header('Product book');
        const vs = [...s.variants.variants.values()].sort((a, b) => unitValue(b) - unitValue(a));
        if (!vs.length) html += '<p class="empty">Nothing discovered yet. Harvest a plant to log your first product.</p>';
        for (const v of vs)
          html += `<div class="prod"><img src="${iconFor({ id: 'prod', v: v.key }, s.variants)}" alt=""><div><strong>${esc(v.name)}</strong> <span class="muted">${FAMILIES[v.family].name} · ${QUALITY_NAMES[v.quality]} · $${unitValue(v)}/unit</span><div class="chips">${effectChips(v.effects)}</div></div><button class="pbtn" data-rename="${v.key}">Rename</button></div>`;
        html += '<div class="mk-group">Mixers</div>';
        for (const i of INGREDIENTS) html += `<div class="mix-ref"><strong>${ITEMS[i.item].name}</strong> adds ${effectChips([i.adds])}<span class="muted">${Object.entries(i.transforms).map(([a, b]) => `${EFFECTS[a].name} → ${EFFECTS[b].name}`).join(' · ')}</span></div>`;
        break;
      }
      case 'staff': {
        html += this.header('Staff');
        const em = s.employees;
        em.refreshCandidates();
        html += `<p class="empty">Wages are paid at 07:00 each day ($${em.dailyWages}/day now). Staff work from their property's storage shelf, so keep it stocked or hire a Manager.</p>`;
        for (const e of em.list) {
          const site = s.properties.name(e.data.site);
          html += `<div class="contact"><div class="contact-top"><strong>${esc(e.data.name)}</strong><span>${ROLES[e.data.role].name} · skill ${e.data.skill}</span></div><span class="muted">${esc(site)} · ${SHIFTS[e.data.shift].name} · $${e.salary}/day · ${e.data.tasksToday} jobs today${e.data.role === 'dealer' ? ` · earned $${e.data.earned}` : ''}</span><div class="status-line">${esc(e.status)}</div>
            <div class="emp-actions"><select data-shift="${e.data.id}">${(Object.keys(SHIFTS) as Shift[]).map((k) => `<option value="${k}" ${k === e.data.shift ? 'selected' : ''}>${SHIFTS[k].name}</option>`).join('')}</select><select data-move="${e.data.id}">${s.properties.ownedList().map((id) => `<option value="${id}" ${id === e.data.site ? 'selected' : ''}>${esc(s.properties.name(id))}</option>`).join('')}</select><button class="pbtn" data-train="${e.data.id}">Train $${250 * e.data.skill}</button><button class="pbtn" data-fire="${e.data.id}">Fire</button></div></div>`;
        }
        // Chemist recipes per site.
        const sites = s.properties.ownedList().filter((id) => s.production.sites.get(id)?.has('mixer'));
        if (sites.length) {
          html += '<div class="mk-group">Chemist recipes</div>';
          for (const id of sites)
            html += `<div class="deliver"><span>${esc(s.properties.name(id))}</span><select data-recipe="${id}"><option value="">Whatever is in storage</option>${INGREDIENTS.map((i) => `<option value="${i.item}" ${em.recipes.get(id) === i.item ? 'selected' : ''}>${ITEMS[i.item].name} (adds ${EFFECTS[i.adds].name})</option>`).join('')}</select></div>`;
        }
        html += `<div class="mk-group">Job seekers today</div><div class="deliver"><span>Hire for</span><select id="hire-site">${s.properties.ownedList().map((id) => `<option value="${id}" ${id === this.deliverTo ? 'selected' : ''}>${esc(s.properties.name(id))} (${em.countAt(id)}/${s.properties.staffCap(id)})</option>`).join('')}</select></div>`;
        for (const c of em.candidates) {
          const r = ROLES[c.role as Role];
          const pay = Math.round(r.base * (0.8 + c.skill * 0.22));
          html += `<div class="contact"><div class="contact-top"><strong>${esc(c.name)}</strong><span>${r.name} · skill ${c.skill}</span></div><span class="muted">${r.desc}</span><div class="emp-actions"><span class="muted">$${pay}/day · signing fee $${Math.round(r.base * 2)}</span><button class="pbtn ok" data-hire="${c.id}">Hire</button></div></div>`;
        }
        break;
      }
      case 'properties': {
        html += this.header('Harlow Realty');
        html += `<div class="contact"><div class="contact-top"><strong>14 Larch Street</strong><span>Owned</span></div><span class="muted">Your house and garage · staff ${s.employees.countAt('home')}/${s.properties.staffCap('home')}</span></div>`;
        for (const p of PROPERTIES) {
          const own = s.properties.owns(p.id);
          html += `<div class="contact"><div class="contact-top"><strong>${esc(p.name)}</strong><span>${own ? 'Owned' : `$${p.price.toLocaleString()}`}</span></div><span class="muted">${DISTRICTS[p.district].name} · upkeep $${p.upkeep}/day · ${p.staff} staff · ${p.storage} storage</span><p class="small">${esc(p.desc)}</p><div class="emp-actions">${own ? `<span class="muted">Staff ${s.employees.countAt(p.id)}/${p.staff}</span>` : `<button class="pbtn ok" data-buyprop="${p.id}">Buy</button>`}<button class="pbtn" data-waypoint="${p.x},${p.z}">Show on map</button></div></div>`;
        }
        break;
      }
      case 'vehicles': {
        html += this.header('Cars');
        html += `<div class="paints">${PAINTS.map((c) => `<button class="paint${c === this.paint ? ' on' : ''}" data-paint="${c}" style="background:#${c.toString(16).padStart(6, '0')}" aria-label="Paint"></button>`).join('')}</div>`;
        for (const k of Object.keys(VEHICLE_TYPES) as VehicleType[]) {
          const d = VEHICLE_TYPES[k];
          const ok = s.vehicles.unlocked(k);
          html += `<div class="contact${ok ? '' : ' locked'}"><div class="contact-top"><strong>${d.name}</strong><span>$${d.price.toLocaleString()}</span></div><span class="muted">${esc(d.desc)} · top speed ${Math.round(d.top * 3.6)} km/h · ${d.trunk} trunk slots</span><div class="emp-actions">${ok ? `<button class="pbtn ok" data-buycar="${k}">Buy in this colour</button>` : `<span class="muted">Unlocks at $${d.unlock.toLocaleString()} lifetime sales</span>`}</div></div>`;
        }
        if (s.vehicles.list.length) {
          html += '<div class="mk-group">Your cars</div>';
          for (const v of s.vehicles.list) html += `<div class="contact"><div class="contact-top"><strong>${v.def.name}</strong><span>${Math.round(v.pos.distanceTo(s.player.position))} m away</span></div><div class="emp-actions"><button class="pbtn" data-respray="${v.n}">Respray ($200)</button><button class="pbtn" data-waypoint="${v.pos.x},${v.pos.z}">Show on map</button></div></div>`;
        }
        break;
      }
      case 'turf': {
        html += this.header('Turf');
        const r = s.rivals;
        html += '<p class="empty">Selling in a district grows your influence there and angers whoever runs it. Control a district (60%+) and customers there pay more.</p>';
        for (const d of ['residential', 'downtown', 'commercial', 'industrial', 'outskirts'] as District[]) {
          const inf = r.of(d);
          const dom = r.dominant(d);
          const bars = `<i style="width:${inf.player}%;background:#f2a23a"></i>${GANG_IDS.map((g) => `<i style="width:${inf[g]}%;background:${GANGS[g].css}"></i>`).join('')}`;
          const reason = r.canBuyout(d);
          html += `<div class="contact"><div class="contact-top"><strong>${DISTRICTS[d].name}</strong><span>You ${Math.round(inf.player)}%${dom.value > 1 ? ` · ${GANGS[dom.gang].name} ${Math.round(dom.value)}%` : ''}</span></div><div class="turf-bar">${bars}</div><span class="muted">Prices ×${r.priceMult(d).toFixed(2)}</span><div class="emp-actions">${reason ? `<span class="muted small">${esc(reason)}</span>` : `<button class="pbtn ok" data-buyout="${d}">Buy them out · $${r.buyoutCost(d).toLocaleString()}</button>`}</div></div>`;
        }
        html += '<div class="mk-group">Organisations</div>';
        for (const g of GANG_IDS) {
          const gang = GANGS[g];
          const h = Math.round(r.hostility[g]);
          html += `<div class="contact"><div class="contact-top"><strong style="color:${gang.css}">${gang.name}</strong><span>${esc(gang.leader)}</span></div><span class="muted">${esc(gang.blurb)}</span><div class="dual"><span>Hostility</span><div class="loyalty hostile"><i style="width:${h}%"></i></div></div><span class="muted small">${h >= 65 ? 'They will shake you down on sight.' : h >= 40 ? 'They are warning you off.' : 'Tolerating you, for now.'}</span><div class="emp-actions"><button class="pbtn" data-tribute="${g}" ${h < 5 ? 'disabled' : ''}>Pay tribute · $${r.tributeCost(g)}</button></div></div>`;
        }
        break;
      }
      case 'finance': {
        html += this.header('Finance');
        const e = s.economy;
        html += `<div class="fin-grid"><div><span>Cash</span><strong>$${e.cash.toLocaleString()}</strong></div><div><span>Lifetime sales</span><strong>$${e.lifetimeRevenue.toLocaleString()}</strong></div><div><span>Spent</span><strong>$${e.lifetimeExpenses.toLocaleString()}</strong></div><div><span>Units sold</span><strong>${e.unitsSold}</strong></div><div><span>Daily wages</span><strong>$${s.employees.dailyWages}</strong></div><div><span>Daily upkeep</span><strong>$${PROPERTIES.filter((p) => s.properties.owns(p.id)).reduce((a, p) => a + p.upkeep, 0)}</strong></div></div>`;
        const days = [...e.daily].slice(-7);
        const max = Math.max(1, ...days.map(([, d]) => Math.max(d.rev, d.exp)));
        html += '<div class="mk-group">Last days</div><div class="bars">';
        for (const [day, d] of days) html += `<div class="bar-col"><i class="rev" style="height:${(d.rev / max) * 100}%"></i><i class="exp" style="height:${(d.exp / max) * 100}%"></i><span>D${day}</span></div>`;
        html += '</div><div class="mk-group">Transactions</div>';
        for (const tx of e.ledger.slice(0, 30)) html += `<div class="tx"><span>${esc(tx.label)}<em>Day ${tx.day} ${tx.time}</em></span><strong class="${tx.amount >= 0 ? 'pos' : 'neg'}">${tx.amount >= 0 ? '+' : '−'}$${Math.abs(tx.amount)}</strong></div>`;
        break;
      }
      case 'map': {
        html += this.header('Map');
        html += '<canvas class="map" width="560" height="560"></canvas><div class="map-key"><span class="k home">Your places</span><span class="k you">You</span><span class="k deal">Deals</span><span class="k cop">Police</span><span class="k sale">For sale</span><span class="k shop">Shop</span><span class="k car">Cars</span><span class="k mate">Players</span></div>';
        break;
      }
      case 'online': {
        html += this.header('Online');
        const n = s.net;
        if (!n.online) html += `<p class="empty">Not connected. Open Multiplayer from the pause menu or title screen to join a room with friends.${n.error ? `<br><br>${esc(n.error)}` : ''}</p><div class="emp-actions pad"><button class="pbtn ok" data-mp="1">Multiplayer…</button></div>`;
        else {
          html += `<div class="contact"><div class="contact-top"><strong>Room ${esc(n.room)}</strong><span>${n.players.size + 1} player(s)</span></div><span class="muted">You are ${esc(n.name)}${n.isHost ? ' (host)' : ''}</span><p class="small">${n.isHost ? 'Everyone here is playing in your world: your equipment, plants and storage.' : "You're playing in the host's world. Your own equipment and plants are saved and come back when you leave, or if you become host."}</p></div>`;
          for (const p of n.players.values()) html += `<div class="contact"><div class="contact-top"><strong>${esc(p.name)}</strong><span>${p.state ? `${Math.round(p.pos.distanceTo(s.player.position))} m` : '…'}</span></div><div class="emp-actions"><button class="pbtn" data-trade="${p.id}">Trade</button></div></div>`;
          html += '<div class="mk-group">Chat</div><div class="bubbles">';
          for (const c of n.chat.slice(-30)) html += c.system ? `<div class="sysline">${esc(c.text)}</div>` : `<div class="bubble ${c.name === n.name ? 'me' : 'them'}"><strong>${esc(c.name)}</strong><div>${esc(c.text)}</div></div>`;
          html += `</div><div class="chat-row"><input id="chat-in" placeholder="Say something" maxlength="200"><button class="pbtn ok" data-chat="1">Send</button></div>`;
        }
        break;
      }
    }
    this.screen.innerHTML = html;
    this.bind();
    if (this.app === 'map') this.drawMap(this.screen.querySelector('canvas')!);
  }

  private say(text: string) {
    this.flash = text;
    this.render();
  }

  private bind() {
    const s = this.svc;
    const q = (sel: string) => this.screen.querySelectorAll<HTMLElement>(sel);
    const on = (sel: string, fn: (el: HTMLElement) => void) => q(sel).forEach((b) => (b.onclick = () => fn(b)));
    this.screen.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.stopPropagation()));
    on('[data-go]', (b) => this.go(b.dataset.go as App));
    on('[data-thread]', (b) => this.go('thread', b.dataset.thread!));
    on('[data-accept]', (b) => {
      s.customers.accept(Number(b.dataset.accept));
      this.render();
    });
    on('[data-decline]', (b) => {
      s.customers.decline(Number(b.dataset.decline));
      this.render();
    });
    on('[data-counter]', (b) => {
      const row = this.screen.querySelector<HTMLElement>(`[data-counter-row="${b.dataset.counter}"]`);
      if (row) row.hidden = false;
      this.screen.querySelector<HTMLInputElement>('#counter-in')?.focus();
    });
    on('[data-send-counter]', (b) => {
      const v = Math.round(Number(this.screen.querySelector<HTMLInputElement>('#counter-in')?.value) || 0);
      if (v > 0) s.customers.counterDeal(Number(b.dataset.sendCounter), v);
      this.render();
      this.screen.scrollTop = this.screen.scrollHeight;
    });
    on('[data-inc]', (b) => {
      const id = b.dataset.inc!;
      this.cart.set(id, Math.min(99, (this.cart.get(id) ?? 0) + 1));
      this.render();
    });
    on('[data-dec]', (b) => {
      const id = b.dataset.dec!;
      this.cart.set(id, Math.max(0, (this.cart.get(id) ?? 0) - 1));
      this.render();
    });
    const dt = this.screen.querySelector<HTMLSelectElement>('#deliver-to');
    if (dt) dt.onchange = () => ((this.deliverTo = dt.value), this.render());
    on('[data-order]', () => {
      const r = s.market.order(this.cart, this.deliverTo);
      if (r.ok) this.cart.clear();
      this.say(r.text);
    });
    on('[data-upgrade]', (b) => this.say(s.upgrades.buy(b.dataset.upgrade!)));
    on('[data-orderfor]', (b) => {
      this.deliverTo = b.dataset.orderfor!;
      this.go('market');
      this.screen.querySelector('#mk-equip')?.scrollIntoView();
    });
    on('[data-rename]', (b) => {
      this.ui.dismiss();
      this.ui.panels.discovery(b.dataset.rename!);
    });
    // Staff.
    on('[data-hire]', (b) => {
      const site = this.screen.querySelector<HTMLSelectElement>('#hire-site')?.value ?? 'home';
      this.say(s.employees.hire(Number(b.dataset.hire), site));
    });
    on('[data-fire]', (b) => this.say(s.employees.fire(Number(b.dataset.fire))));
    on('[data-train]', (b) => this.say(s.employees.train(Number(b.dataset.train))));
    q('[data-shift]').forEach((sel) => ((sel as HTMLSelectElement).onchange = () => s.employees.setShift(Number(sel.dataset.shift), (sel as HTMLSelectElement).value as Shift)));
    q('[data-move]').forEach((sel) => ((sel as HTMLSelectElement).onchange = () => this.say(s.employees.move(Number(sel.dataset.move), (sel as HTMLSelectElement).value))));
    q('[data-recipe]').forEach((sel) => ((sel as HTMLSelectElement).onchange = () => {
      const v = (sel as HTMLSelectElement).value;
      if (v) s.employees.recipes.set(sel.dataset.recipe!, v);
      else s.employees.recipes.delete(sel.dataset.recipe!);
    }));
    // Property, cars, turf.
    on('[data-buyprop]', (b) => this.say(s.properties.buy(b.dataset.buyprop!)));
    on('[data-waypoint]', (b) => {
      const [x, z] = b.dataset.waypoint!.split(',').map(Number);
      this.ui.hud.setWaypoint(x, z);
      this.go('map');
    });
    on('[data-paint]', (b) => {
      this.paint = Number(b.dataset.paint);
      this.render();
    });
    on('[data-buycar]', (b) => this.say(s.vehicles.buy(b.dataset.buycar as VehicleType, this.paint)));
    on('[data-respray]', (b) => {
      const v = s.vehicles.list.find((x) => x.n === Number(b.dataset.respray));
      if (v) this.say(s.vehicles.repaint(v, this.paint));
    });
    on('[data-buyout]', (b) => this.say(s.rivals.buyout(b.dataset.buyout as District)));
    on('[data-tribute]', (b) => this.say(s.rivals.payTribute(b.dataset.tribute as never)));
    // Online.
    on('[data-mp]', () => this.ui.panels.openMultiplayer(() => this.ui.dismiss()));
    on('[data-trade]', (b) => {
      const p = s.net.players.get(b.dataset.trade!);
      if (p) this.ui.panels.openTrade(p.id, p.name);
    });
    const chat = this.screen.querySelector<HTMLInputElement>('#chat-in');
    const send = () => {
      if (chat?.value.trim()) {
        s.net.say(chat.value);
        chat.value = '';
        setTimeout(() => this.render(), 150);
      }
    };
    on('[data-chat]', send);
    chat?.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  }

  private drawMap(c: HTMLCanvasElement) {
    const g = c.getContext('2d')!;
    const W = c.width;
    const k = W / (WORLD_HALF * 2);
    const X = (x: number) => (x + WORLD_HALF) * k;
    const s = this.svc;
    const colors: Record<string, string> = { downtown: '#5b5a57', residential: '#3f5a33', commercial: '#4d5a3a', industrial: '#57524a', outskirts: '#344a2c' };
    for (let y = 0; y < W; y += 8)
      for (let x = 0; x < W; x += 8) {
        g.fillStyle = colors[districtAt(x / k - WORLD_HALF, y / k - WORLD_HALF)];
        g.fillRect(x, y, 8, 8);
      }
    g.strokeStyle = '#2d5a6e';
    g.lineWidth = 9;
    g.beginPath();
    for (let z = -WORLD_HALF; z <= WORLD_HALF; z += 10) {
      if (z === -WORLD_HALF) g.moveTo(X(riverX(z)), X(z));
      else g.lineTo(X(riverX(z)), X(z));
    }
    g.stroke();
    g.fillStyle = '#2a2b2e';
    for (const b of s.world.content.buildings) g.fillRect(X(b.x - b.w / 2), X(b.z - b.d / 2), b.w * k, b.d * k);
    g.strokeStyle = '#a8a59c';
    g.lineWidth = 4;
    for (const x of X_LINES) {
      g.beginPath();
      g.moveTo(X(x), X(GRID.z0));
      g.lineTo(X(x), X(GRID.z1));
      g.stroke();
    }
    for (const z of Z_LINES) {
      g.beginPath();
      g.moveTo(X(GRID.x0), X(z));
      g.lineTo(X(GRID.x1), X(z));
      g.stroke();
    }
    const dot = (x: number, z: number, col: string, r = 6) => {
      g.beginPath();
      g.arc(X(x), X(z), r, 0, Math.PI * 2);
      g.fillStyle = col;
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 2;
      g.stroke();
    };
    const sq = (x: number, z: number, col: string) => {
      g.fillStyle = col;
      g.strokeStyle = '#111';
      g.lineWidth = 2;
      g.fillRect(X(x) - 7, X(z) - 7, 14, 14);
      g.strokeRect(X(x) - 7, X(z) - 7, 14, 14);
    };
    sq(-55, -95, '#f2a23a');
    // Kwik Corner: green diamond.
    g.save();
    g.translate(X(SHOP.x), X(SHOP.z));
    g.rotate(Math.PI / 4);
    g.fillStyle = '#2bb673';
    g.strokeStyle = '#111';
    g.lineWidth = 2;
    g.fillRect(-6, -6, 12, 12);
    g.strokeRect(-6, -6, 12, 12);
    g.restore();
    for (const p of PROPERTIES) sq(p.x, p.z, s.properties.owns(p.id) ? '#f2a23a' : '#e0e0e0');
    for (const v of s.vehicles.list) dot(v.pos.x, v.pos.z, '#9ad0ff', 5);
    for (const d of s.customers.deals) if (d.status === 'accepted') dot(d.meet.x, d.meet.z, '#3ddc84', 8);
    const pl = s.player.position;
    for (const p of s.customers.peds.people) if (p.police && Math.hypot(p.x - pl.x, p.z - pl.z) < 120) dot(p.x, p.z, '#4a7fff', 4);
    for (const p of s.net.players.values()) dot(p.pos.x, p.pos.z, '#ff7ad1', 6);
    const wp = this.ui.hud.waypoint;
    if (wp) {
      g.strokeStyle = '#fff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(X(wp.x), X(wp.z), 11, 0, Math.PI * 2);
      g.stroke();
    }
    g.save();
    g.translate(X(pl.x), X(pl.z));
    g.rotate(-s.player.yaw);
    g.beginPath();
    g.moveTo(0, -10);
    g.lineTo(7, 8);
    g.lineTo(-7, 8);
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    g.restore();
    c.onclick = (e) => {
      const r = c.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W / k - WORLD_HALF;
      const z = ((e.clientY - r.top) / r.height) * W / k - WORLD_HALF;
      this.ui.hud.setWaypoint(x, z);
      this.render();
    };
  }
}
