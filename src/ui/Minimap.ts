import type { Services } from '../core/Services';
import { PROPERTIES } from '../properties/PropertyDefs';
import { SHOP } from '../properties/CornerShop';
import { CASINO } from '../properties/Casino';
import { FAMILIES } from '../products/Catalog';
import { NEIGHBOURHOODS } from '../npc/Neighbourhoods';
import { AVENUES, GRID, RIVER, ROAD, STREETS, WORLD_HALF, X_LINES, Z_LINES, bridgeSpan, districtAt, riverX } from '../world/CityPlan';

/** Pixels per metre in the pre-rendered city map. */
const PPM = 2;
const SIZE = WORLD_HALF * 2 * PPM;

const DISTRICT_COL: Record<string, string> = {
  downtown: '#4a4b4f',
  residential: '#38502e',
  commercial: '#42502f',
  industrial: '#4d4a43',
  outskirts: '#2f4528',
};

export type MarkerKind = 'home' | 'shop' | 'casino' | 'owned' | 'sale' | 'car' | 'request' | 'deal' | 'police' | 'player' | 'waypoint';

export interface Marker {
  kind: MarkerKind;
  x: number;
  z: number;
  label?: string;
  /** Keep on the edge of the minimap when out of range (deals, waypoint). */
  pin?: boolean;
}

const MARKER_COL: Record<MarkerKind, string> = {
  home: '#f2a23a',
  shop: '#2bb673',
  casino: '#ffcf3a',
  owned: '#f2a23a',
  sale: '#e0e0e0',
  car: '#9ad0ff',
  request: '#ffd23f',
  deal: '#3ddc84',
  police: '#4a7fff',
  player: '#ff7ad1',
  waypoint: '#ffffff',
};

export const MARKER_LEGEND: [MarkerKind, string][] = [
  ['request', 'Order request'],
  ['deal', 'Accepted deal'],
  ['home', 'Your places'],
  ['shop', 'Kwik Corner'],
  ['casino', 'Casino'],
  ['sale', 'For sale'],
  ['car', 'Your cars'],
  ['police', 'Police'],
  ['player', 'Players'],
  ['waypoint', 'Waypoint'],
];

/**
 * The city map, drawn once into a large canvas (districts, parks, river, buildings, roads and street
 * names), then cropped by the HUD minimap and the full-screen map.
 */
export class CityMap {
  readonly canvas: HTMLCanvasElement;

  constructor(private svc: Services) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = SIZE;
    this.draw();
  }

  static px(v: number) {
    return (v + WORLD_HALF) * PPM;
  }

  private draw() {
    const g = this.canvas.getContext('2d')!;
    const X = CityMap.px;
    const content = this.svc.world.content;
    // Ground by district.
    const cell = 8;
    for (let y = 0; y < SIZE; y += cell)
      for (let x = 0; x < SIZE; x += cell) {
        g.fillStyle = DISTRICT_COL[districtAt(x / PPM - WORLD_HALF, y / PPM - WORLD_HALF)];
        g.fillRect(x, y, cell, cell);
      }
    g.fillStyle = '#4b6b38';
    for (const p of content.parks) g.fillRect(X(p.x0), X(p.z0), (p.x1 - p.x0) * PPM, (p.z1 - p.z0) * PPM);
    // River.
    g.strokeStyle = '#2f6b88';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = RIVER.waterHalf * 2 * PPM;
    g.beginPath();
    for (let z = -WORLD_HALF; z <= WORLD_HALF; z += 8) {
      if (z === -WORLD_HALF) g.moveTo(X(riverX(z)), X(z));
      else g.lineTo(X(riverX(z)), X(z));
    }
    g.stroke();
    // Parking lots.
    g.fillStyle = '#55565a';
    for (const l of content.lots) g.fillRect(X(l.x0), X(l.z0), (l.x1 - l.x0) * PPM, (l.z1 - l.z0) * PPM);
    // Roads: pavement, then asphalt, then a faint centre line.
    g.lineCap = 'butt';
    const roads = (w: number, col: string) => {
      g.strokeStyle = col;
      g.lineWidth = w * PPM;
      g.beginPath();
      for (const x of X_LINES) {
        g.moveTo(X(x), X(GRID.z0 - ROAD.sidewalkHalf));
        g.lineTo(X(x), X(GRID.z1 + ROAD.sidewalkHalf));
      }
      for (const z of Z_LINES) {
        g.moveTo(X(GRID.x0 - ROAD.sidewalkHalf), X(z));
        g.lineTo(X(GRID.x1 + ROAD.sidewalkHalf), X(z));
      }
      g.stroke();
    };
    roads(ROAD.sidewalkHalf * 2, '#8d8a83');
    roads(ROAD.asphaltHalf * 2, '#27282b');
    g.setLineDash([6, 8]);
    roads(0.6, 'rgba(224,172,60,0.55)');
    g.setLineDash([]);
    // Bridges get a lighter deck so they read over the water.
    g.fillStyle = '#6d6b66';
    for (const z of Z_LINES) {
      const sp = bridgeSpan(z);
      g.fillRect(X(sp.xa), X(z - ROAD.sidewalkHalf), (sp.xb - sp.xa) * PPM, ROAD.sidewalkHalf * 2 * PPM);
      g.fillStyle = '#27282b';
      g.fillRect(X(sp.xa), X(z - ROAD.asphaltHalf), (sp.xb - sp.xa) * PPM, ROAD.asphaltHalf * 2 * PPM);
      g.fillStyle = '#6d6b66';
    }
    // Buildings with a soft drop shadow.
    for (const b of content.buildings) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(X(b.x - b.w / 2) + 3, X(b.z - b.d / 2) + 3, b.w * PPM, b.d * PPM);
      g.fillStyle = b.height > 20 ? '#8a8f99' : '#9b958a';
      g.fillRect(X(b.x - b.w / 2), X(b.z - b.d / 2), b.w * PPM, b.d * PPM);
    }
    const house = this.svc.world.starter.origin;
    g.fillStyle = '#c98a3a';
    g.fillRect(X(house.x - 6), X(house.z - 5), 12 * PPM, 10 * PPM);
    g.fillStyle = '#5e8f6a';
    g.fillRect(X(SHOP.x - SHOP.w / 2), X(SHOP.z - SHOP.d / 2), SHOP.w * PPM, SHOP.d * PPM);
    g.fillStyle = '#6a3a7a';
    g.fillRect(X(CASINO.x - CASINO.w / 2), X(CASINO.z - CASINO.d / 2), CASINO.w * PPM, CASINO.d * PPM);
    g.fillStyle = '#a49b8c';
    for (const p of PROPERTIES) g.fillRect(X(p.x - p.w / 2), X(p.z - p.d / 2), p.w * PPM, p.d * PPM);
    // Neighbourhoods: soft outline and a big name, so it's clear where each customer lives.
    for (const h of NEIGHBOURHOODS) {
      g.strokeStyle = 'rgba(242,162,58,0.35)';
      g.lineWidth = 3;
      g.setLineDash([14, 10]);
      g.strokeRect(X(h.x0) + 4, X(h.z0) + 4, (h.x1 - h.x0) * PPM - 8, (h.z1 - h.z0) * PPM - 8);
      g.setLineDash([]);
      g.save();
      g.font = '800 34px "Big Shoulders Display", Impact, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(10,12,14,0.55)';
      g.fillStyle = 'rgba(242,214,160,0.75)';
      const cx = X((h.x0 + h.x1) / 2);
      const cy = X((h.z0 + h.z1) / 2) - 40;
      g.strokeText(h.name.toUpperCase(), cx, cy);
      g.fillText(h.name.toUpperCase(), cx, cy);
      g.restore();
    }
    // Street names along every block of every road, upright on avenues rotated.
    g.font = `700 ${11}px Archivo, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const label = (text: string, x: number, y: number, rot: number) => {
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(10,12,14,0.9)';
      g.strokeText(text, 0, 0);
      g.fillStyle = '#f2ead8';
      g.fillText(text, 0, 0);
      g.restore();
    };
    X_LINES.forEach((x, i) => {
      for (let k = 0; k < Z_LINES.length - 1; k++) label(AVENUES[i], X(x), X((Z_LINES[k] + Z_LINES[k + 1]) / 2), -Math.PI / 2);
    });
    Z_LINES.forEach((z, j) => {
      for (let k = 0; k < X_LINES.length - 1; k++) {
        const mx = (X_LINES[k] + X_LINES[k + 1]) / 2;
        const sp = bridgeSpan(z);
        if (mx > sp.xa - 10 && mx < sp.xb + 10) continue;
        label(STREETS[j], X(mx), X(z), 0);
      }
    });
  }
}

/** Everything worth showing on a map right now. */
export function currentMarkers(svc: Services, waypoint: { x: number; z: number } | null): Marker[] {
  const m: Marker[] = [];
  const h = svc.world.starter.origin;
  m.push({ kind: 'home', x: h.x, z: h.z, label: '14 Larch Street' });
  m.push({ kind: 'shop', x: SHOP.x, z: SHOP.z, label: 'Kwik Corner' });
  m.push({ kind: 'casino', x: CASINO.x, z: CASINO.z, label: 'Lucky 7 Casino' });
  for (const p of PROPERTIES) m.push({ kind: svc.properties.owns(p.id) ? 'owned' : 'sale', x: p.x, z: p.z, label: svc.properties.owns(p.id) ? p.name : `${p.name} · for sale` });
  for (const v of svc.vehicles.list) m.push({ kind: 'car', x: v.pos.x, z: v.pos.z, label: v.def.name });
  const pl = svc.player.position;
  for (const p of svc.customers.peds?.people ?? []) if (p.police && Math.hypot(p.x - pl.x, p.z - pl.z) < 120) m.push({ kind: 'police', x: p.x, z: p.z });
  for (const p of svc.net.players.values()) m.push({ kind: 'player', x: p.pos.x, z: p.pos.z, label: p.name });
  for (const d of svc.customers.deals) {
    if (d.status !== 'offered' && d.status !== 'accepted') continue;
    const who = svc.customers.person(d.person).name;
    m.push({
      kind: d.status === 'offered' ? 'request' : 'deal',
      x: d.meet.x,
      z: d.meet.z,
      pin: true,
      label: `${who} · ${d.units} × ${FAMILIES[d.family].name} · $${d.price} · ${d.meet.name}${d.status === 'offered' ? ' (reply in Messages)' : ''}`,
    });
  }
  if (waypoint) m.push({ kind: 'waypoint', x: waypoint.x, z: waypoint.z, pin: true, label: 'Waypoint' });
  return m;
}

/** Draws one marker at canvas position (x, y). */
export function drawMarker(g: CanvasRenderingContext2D, mk: Marker, x: number, y: number, s = 1, t = 0) {
  const col = MARKER_COL[mk.kind];
  g.lineWidth = 2 * s;
  g.strokeStyle = '#111';
  g.fillStyle = col;
  switch (mk.kind) {
    case 'home':
    case 'owned':
    case 'sale':
      g.fillRect(x - 6 * s, y - 6 * s, 12 * s, 12 * s);
      g.strokeRect(x - 6 * s, y - 6 * s, 12 * s, 12 * s);
      break;
    case 'shop':
      g.save();
      g.translate(x, y);
      g.rotate(Math.PI / 4);
      g.fillRect(-5.5 * s, -5.5 * s, 11 * s, 11 * s);
      g.strokeRect(-5.5 * s, -5.5 * s, 11 * s, 11 * s);
      g.restore();
      break;
    case 'request':
    case 'deal': {
      // Pulsing ring, then a $ badge.
      const pulse = (t * 1.4) % 1;
      g.beginPath();
      g.arc(x, y, (9 + pulse * 10) * s, 0, Math.PI * 2);
      g.strokeStyle = col;
      g.globalAlpha = 1 - pulse;
      g.stroke();
      g.globalAlpha = 1;
      g.beginPath();
      g.arc(x, y, 8 * s, 0, Math.PI * 2);
      g.fillStyle = col;
      g.fill();
      g.strokeStyle = '#111';
      g.stroke();
      g.fillStyle = '#111';
      g.font = `800 ${11 * s}px Archivo, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(mk.kind === 'request' ? '!' : '$', x, y + 0.5 * s);
      break;
    }
    case 'casino':
      g.beginPath();
      g.arc(x, y, 8 * s, 0, Math.PI * 2);
      g.fillStyle = '#1a1220';
      g.fill();
      g.strokeStyle = col;
      g.stroke();
      g.fillStyle = col;
      g.font = `800 ${11 * s}px Archivo, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('7', x, y + 0.5 * s);
      break;
    case 'waypoint':
      g.beginPath();
      g.arc(x, y, 7 * s, 0, Math.PI * 2);
      g.strokeStyle = '#fff';
      g.lineWidth = 3 * s;
      g.stroke();
      break;
    default:
      g.beginPath();
      g.arc(x, y, (mk.kind === 'police' ? 4 : 5) * s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
  }
}

/** The player's arrow, pointing along `heading` (0 = north/up, clockwise). */
export function drawPlayer(g: CanvasRenderingContext2D, x: number, y: number, heading: number, s = 1) {
  g.save();
  g.translate(x, y);
  g.rotate(heading);
  g.beginPath();
  g.moveTo(0, -10 * s);
  g.lineTo(7 * s, 8 * s);
  g.lineTo(0, 4 * s);
  g.lineTo(-7 * s, 8 * s);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = 2 * s;
  g.strokeStyle = '#111';
  g.stroke();
  g.restore();
}

/**
 * HUD minimap: a north-up circular window onto the city map around the player, with live markers.
 * Order requests and deals stay pinned to the rim when they're out of range. Click it (or press N)
 * for the full-screen map.
 */
export class Minimap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private map: CityMap | null = null;
  private timer = 0;
  private t = 0;
  /** Metres from the centre to the rim. */
  radius = 85;

  constructor(
    parent: HTMLElement,
    private svc: Services,
    private getWaypoint: () => { x: number; z: number } | null,
    onOpen: () => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.title = 'Open the map (N)';
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    const hint = document.createElement('span');
    hint.className = 'minimap-key';
    hint.textContent = 'N';
    const north = document.createElement('span');
    north.className = 'minimap-north';
    north.textContent = 'N';
    this.el.append(north, hint);
    this.el.addEventListener('click', onOpen);
    parent.appendChild(this.el);
    this.g = this.canvas.getContext('2d')!;
  }

  get cityMap(): CityMap {
    if (!this.map) this.map = new CityMap(this.svc);
    return this.map;
  }

  update(dt: number, heading: number) {
    this.t += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 20;
    const css = this.el.clientWidth || 200;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(css * dpr);
    if (this.canvas.width !== W) this.canvas.width = this.canvas.height = W;
    const g = this.g;
    const pl = this.svc.vehicles.driving?.pos ?? this.svc.player.position;
    const scale = W / (this.radius * 2); // canvas px per metre
    const cx = W / 2;
    g.save();
    g.clearRect(0, 0, W, W);
    g.beginPath();
    g.arc(cx, cx, cx - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#1b2a1a';
    g.fillRect(0, 0, W, W);
    const src = this.radius * 2 * PPM;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.cityMap.canvas, CityMap.px(pl.x) - src / 2, CityMap.px(pl.z) - src / 2, src, src, 0, 0, W, W);
    const s = dpr * 0.95;
    const rim = cx - 12 * dpr;
    for (const mk of currentMarkers(this.svc, this.getWaypoint())) {
      let x = cx + (mk.x - pl.x) * scale;
      let y = cx + (mk.z - pl.z) * scale;
      const dx = x - cx;
      const dy = y - cx;
      const d = Math.hypot(dx, dy);
      if (d > rim) {
        if (!mk.pin) continue;
        x = cx + (dx / d) * rim;
        y = cx + (dy / d) * rim;
      }
      drawMarker(g, mk, x, y, s, this.t);
    }
    drawPlayer(g, cx, cx, heading, dpr);
    g.restore();
    // Rim.
    g.beginPath();
    g.arc(cx, cx, cx - 1.5 * dpr, 0, Math.PI * 2);
    g.lineWidth = 3 * dpr;
    g.strokeStyle = 'rgba(14,17,21,0.9)';
    g.stroke();
  }
}

/**
 * Full-screen city map: drag to pan, scroll to zoom, click to drop a waypoint (right-click clears it).
 * Lists every open order request and deal with a button to route to it.
 */
export function openWorldMap(svc: Services, map: CityMap, ui: { present: (el: HTMLElement, onClose?: () => void) => void; dismiss: () => void; hud: { waypoint: { x: number; z: number } | null; setWaypoint: (x: number, z: number) => void }; toast: (t: string, k?: 'info' | 'good' | 'warn') => void }, heading: () => number) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay worldmap-overlay';
  overlay.innerHTML = `
    <div class="worldmap">
      <div class="wm-head"><div><div class="eyebrow">Harlow</div><h2>City map</h2></div><div class="wm-tip">Drag to pan · scroll to zoom · click to set a waypoint · right-click clears it</div><button class="btn icon-btn wm-close" aria-label="Close">Close</button></div>
      <div class="wm-body"><div class="wm-canvas"><canvas></canvas><div class="wm-hover" hidden></div></div><aside class="wm-side"><div class="wm-list"></div><div class="wm-legend"></div></aside></div>
    </div>`;
  const canvas = overlay.querySelector('canvas') as HTMLCanvasElement;
  const g = canvas.getContext('2d')!;
  const hover = overlay.querySelector('.wm-hover') as HTMLElement;
  const list = overlay.querySelector('.wm-list') as HTMLElement;
  const legend = overlay.querySelector('.wm-legend') as HTMLElement;
  const pl = svc.player.position;
  const view = { x: pl.x, z: pl.z, zoom: 1.6 }; // zoom = canvas px per metre (before DPR)
  let t = 0;
  let dragging: { x: number; y: number; vx: number; vz: number; moved: boolean } | null = null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  // Legend swatches drawn with the same marker painter.
  legend.innerHTML = MARKER_LEGEND.map(([k, label]) => `<div class="wm-key"><canvas width="${40 * dpr}" height="${40 * dpr}" data-k="${k}"></canvas><span>${label}</span></div>`).join('');
  legend.querySelectorAll<HTMLCanvasElement>('canvas').forEach((c) => drawMarker(c.getContext('2d')!, { kind: c.dataset.k as MarkerKind, x: 0, z: 0 }, c.width / 2, c.height / 2, dpr * 1.1, 0.05));

  const toWorld = (px: number, py: number) => {
    const r = canvas.getBoundingClientRect();
    return { x: view.x + (px - r.left - r.width / 2) / view.zoom, z: view.z + (py - r.top - r.height / 2) / view.zoom };
  };

  const renderList = () => {
    const deals = svc.customers.deals.filter((d) => d.status === 'offered' || d.status === 'accepted');
    list.innerHTML = `<div class="eyebrow">Orders</div>${
      deals.length
        ? deals
            .map((d) => {
              const dist = Math.round(Math.hypot(d.meet.x - pl.x, d.meet.z - pl.z));
              return `<div class="wm-order ${d.status}"><strong>${svc.customers.person(d.person).name}</strong> <span class="muted">${d.status === 'offered' ? 'requested' : 'accepted'}</span><br>${d.units} × ${FAMILIES[d.family].name} · $${d.price}<br><span class="muted">${d.meet.name} · ${dist} m</span><button class="pbtn" data-go="${d.meet.x},${d.meet.z}">Set waypoint</button></div>`;
            })
            .join('')
        : '<p class="muted small">No order requests right now. Customers text you when they want to buy.</p>'
    }`;
    list.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
      (b.onclick = () => {
        const [x, z] = b.dataset.go!.split(',').map(Number);
        ui.hud.setWaypoint(x, z);
        view.x = x;
        view.z = z;
        ui.toast('Waypoint set.', 'good');
      }),
    );
  };

  const draw = () => {
    const box = canvas.parentElement!.getBoundingClientRect();
    const W = Math.round(box.width * dpr);
    const H = Math.round(box.height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const z = view.zoom * dpr;
    g.fillStyle = '#18241a';
    g.fillRect(0, 0, W, H);
    const sw = W / z;
    const sh = H / z;
    g.imageSmoothingEnabled = view.zoom < PPM * 1.5;
    g.drawImage(map.canvas, CityMap.px(view.x - sw / 2), CityMap.px(view.z - sh / 2), sw * PPM, sh * PPM, 0, 0, W, H);
    const P = (x: number, zz: number): [number, number] => [W / 2 + (x - view.x) * z, H / 2 + (zz - view.z) * z];
    for (const mk of currentMarkers(svc, ui.hud.waypoint)) {
      const [x, y] = P(mk.x, mk.z);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      drawMarker(g, mk, x, y, dpr * 1.1, t);
    }
    const me = svc.vehicles.driving?.pos ?? pl;
    const [px, py] = P(me.x, me.z);
    drawPlayer(g, px, py, heading(), dpr * 1.2);
  };

  const timer = window.setInterval(() => {
    t += 1 / 30;
    draw();
  }, 1000 / 30);
  const listTimer = window.setInterval(renderList, 1000);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    view.zoom = Math.min(6, Math.max(0.35, view.zoom * (e.deltaY > 0 ? 0.85 : 1.18)));
    const after = toWorld(e.clientX, e.clientY);
    view.x += before.x - after.x;
    view.z += before.z - after.z;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = { x: e.clientX, y: e.clientY, vx: view.x, vz: view.z, moved: false };
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragging.moved = true;
      view.x = dragging.vx - dx / view.zoom;
      view.z = dragging.vz - dy / view.zoom;
    }
    const r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      hover.hidden = true;
      return;
    }
    // Tooltip for the nearest marker under the cursor.
    const w = toWorld(e.clientX, e.clientY);
    const near = currentMarkers(svc, ui.hud.waypoint)
      .filter((m) => m.label)
      .map((m) => ({ m, d: Math.hypot(m.x - w.x, m.z - w.z) * view.zoom }))
      .sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 14) {
      hover.hidden = false;
      hover.textContent = near.m.label!;
      hover.style.left = `${e.clientX - r.left + 14}px`;
      hover.style.top = `${e.clientY - r.top + 10}px`;
    } else hover.hidden = true;
  });
  const up = (e: MouseEvent) => {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    if (!moved && e.target === canvas) {
      const w = toWorld(e.clientX, e.clientY);
      ui.hud.setWaypoint(w.x, w.z);
      ui.toast('Waypoint set. Follow the arrow at the top of the screen.', 'info');
    }
  };
  window.addEventListener('mouseup', up);
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ui.hud.waypoint = null;
  });
  overlay.querySelector('.wm-close')!.addEventListener('click', () => ui.dismiss());
  overlay.addEventListener('keydown', (e) => (e.code === 'Escape' || e.code === 'KeyN') && ui.dismiss());
  renderList();
  ui.present(overlay, () => {
    clearInterval(timer);
    clearInterval(listTimer);
    window.removeEventListener('mouseup', up);
  });
  requestAnimationFrame(draw);
}
