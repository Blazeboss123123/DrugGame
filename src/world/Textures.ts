import * as THREE from 'three';
import { Rng } from '../core/math';

/** All surface textures are painted procedurally on canvases, so the game ships with no image assets. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, rng: Rng, light: string, dark: string, size = 1.5) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rng.chance(0.5) ? light : dark;
    ctx.globalAlpha = rng.range(0.04, 0.16);
    const s = rng.range(0.5, size);
    ctx.fillRect(rng.range(0, w), rng.range(0, h), s, s);
  }
  ctx.globalAlpha = 1;
}

export type FacadeStyle = 'glass' | 'concrete' | 'brick' | 'stucco' | 'siding' | 'corrugated' | 'shop' | 'barn';

/** Bay size in metres for each facade style. Facade textures contain a 4 x 4 grid of bays. */
export const BAY: Record<FacadeStyle, { w: number; h: number }> = {
  glass: { w: 3, h: 3.6 },
  concrete: { w: 3, h: 3.5 },
  brick: { w: 3, h: 3.2 },
  stucco: { w: 3, h: 3.2 },
  siding: { w: 3, h: 3 },
  corrugated: { w: 4, h: 4 },
  shop: { w: 4, h: 4.2 },
  barn: { w: 4, h: 4 },
};

export interface FacadeTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  /** Green = roughness, blue = metalness. Windows are smooth and mirror-like so they reflect the sky. */
  orm: THREE.CanvasTexture;
}

export function facadeTexture(style: FacadeStyle, seed: number): FacadeTextures {
  const S = 512;
  const B = S / 4;
  const rng = new Rng(seed);
  const [c, g] = canvas(S, S);
  const [ec, eg] = canvas(S, S);
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, S, S);
  const [oc, og] = canvas(S, S);
  const baseRough = style === 'corrugated' ? 'rgb(255,150,120)' : style === 'glass' ? 'rgb(255,120,60)' : 'rgb(255,235,0)';
  og.fillStyle = baseRough;
  og.fillRect(0, 0, S, S);
  const glassORM = (x: number, y: number, w: number, h: number) => {
    og.fillStyle = 'rgb(255,18,190)';
    og.fillRect(x, y, w, h);
  };
  const lit = () => rng.chance(style === 'glass' ? 0.3 : 0.42);
  const warm = () => rng.pick(['#ffd79a', '#ffe2b0', '#fff1d6', '#ffcf8a', '#d8e6ff']);

  const windowAt = (bx: number, by: number, x: number, y: number, w: number, h: number, glass: string, frame: string) => {
    const px = bx * B + x;
    const py = by * B + y;
    g.fillStyle = frame;
    g.fillRect(px - 3, py - 3, w + 6, h + 6);
    const grad = g.createLinearGradient(px, py, px + w, py + h);
    grad.addColorStop(0, glass);
    grad.addColorStop(1, shade(glass, -0.25));
    g.fillStyle = grad;
    g.fillRect(px, py, w, h);
    glassORM(px, py, w, h);
    // Sky reflection streak.
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.moveTo(px, py + h * 0.7);
    g.lineTo(px + w * 0.45, py);
    g.lineTo(px + w * 0.65, py);
    g.lineTo(px, py + h);
    g.fill();
    if (lit()) {
      eg.fillStyle = warm();
      eg.fillRect(px, py, w, h);
      // Curtain/blinds variation.
      if (rng.chance(0.4)) {
        eg.fillStyle = 'rgba(0,0,0,0.55)';
        eg.fillRect(px, py, w, h * rng.range(0.2, 0.6));
      }
    }
  };

  switch (style) {
    case 'glass': {
      g.fillStyle = '#3e4a57';
      g.fillRect(0, 0, S, S);
      for (let by = 0; by < 4; by++)
        for (let bx = 0; bx < 4; bx++) windowAt(bx, by, 6, 10, B - 12, B - 26, rng.pick(['#5d7590', '#58708a', '#647d96', '#4f6680']), '#2a323b');
      g.fillStyle = '#9aa3ad';
      for (let by = 0; by < 4; by++) g.fillRect(0, by * B + B - 12, S, 6);
      break;
    }
    case 'concrete': {
      g.fillStyle = '#a7a39b';
      g.fillRect(0, 0, S, S);
      speckle(g, S, S, 5000, rng, '#fff', '#000', 2);
      for (let by = 0; by < 4; by++)
        for (let bx = 0; bx < 4; bx++) windowAt(bx, by, 10, 30, B - 20, 60, rng.pick(['#4a5866', '#53616e']), '#6f6b64');
      break;
    }
    case 'brick': {
      g.fillStyle = '#8a4a36';
      g.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 8) {
        const off = (y / 8) % 2 ? 0 : 9;
        for (let x = -18; x < S; x += 18) {
          g.fillStyle = shade(rng.pick(['#8f4c37', '#7e4230', '#9a5640', '#874633']), rng.range(-0.08, 0.08));
          g.fillRect(x + off, y, 16, 6);
        }
      }
      for (let by = 0; by < 4; by++)
        for (let bx = 0; bx < 4; bx++) {
          windowAt(bx, by, 34, 26, 60, 72, '#4c5a68', '#e8e2d6');
          g.fillStyle = '#d6cfc2';
          g.fillRect(bx * B + 28, by * B + 100, 72, 6);
        }
      break;
    }
    case 'stucco': {
      g.fillStyle = '#d4c6ad';
      g.fillRect(0, 0, S, S);
      speckle(g, S, S, 6000, rng, '#fff', '#5a4a30', 2);
      for (let by = 0; by < 4; by++)
        for (let bx = 0; bx < 4; bx++) windowAt(bx, by, 36, 28, 56, 70, '#4b5966', '#f4efe6');
      break;
    }
    case 'siding': {
      g.fillStyle = '#e9e6df';
      g.fillRect(0, 0, S, S);
      for (let y = 0; y < S; y += 10) {
        g.fillStyle = 'rgba(0,0,0,0.13)';
        g.fillRect(0, y + 8, S, 2);
        g.fillStyle = 'rgba(255,255,255,0.25)';
        g.fillRect(0, y, S, 1);
      }
      for (let by = 0; by < 4; by++)
        for (let bx = 0; bx < 4; bx++) {
          if ((bx + by) % 3 === 2) continue;
          windowAt(bx, by, 38, 30, 52, 64, '#55626f', '#fbfaf6');
          g.fillStyle = '#4a5560';
          g.fillRect(bx * B + 24, by * B + 27, 10, 70);
          g.fillRect(bx * B + 94, by * B + 27, 10, 70);
        }
      break;
    }
    case 'corrugated': {
      g.fillStyle = '#8d9496';
      g.fillRect(0, 0, S, S);
      for (let x = 0; x < S; x += 8) {
        const grad = g.createLinearGradient(x, 0, x + 8, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.18)');
        grad.addColorStop(0.5, 'rgba(0,0,0,0.12)');
        grad.addColorStop(1, 'rgba(255,255,255,0.18)');
        g.fillStyle = grad;
        g.fillRect(x, 0, 8, S);
      }
      speckle(g, S, S, 3000, rng, '#c8a27a', '#30302c', 3);
      // Rust streaks.
      for (let i = 0; i < 18; i++) {
        g.fillStyle = 'rgba(120,70,40,0.12)';
        g.fillRect(rng.range(0, S), rng.range(0, S), rng.range(2, 6), rng.range(30, 140));
      }
      for (let bx = 0; bx < 4; bx++) {
        g.fillStyle = '#4b5258';
        g.fillRect(bx * B + 10, 12, B - 20, 18);
        if (lit()) {
          eg.fillStyle = '#ffe9c2';
          eg.fillRect(bx * B + 10, 12, B - 20, 18);
        }
      }
      break;
    }
    case 'shop': {
      g.fillStyle = '#3b3631';
      g.fillRect(0, 0, S, S);
      for (let by = 0; by < 4; by++)
        for (let bx = 0; bx < 4; bx++) {
          const px = bx * B;
          const py = by * B;
          const awn = rng.pick(['#7b2f2a', '#2f5446', '#2c3d5e', '#6b5226', '#4b4b4b']);
          g.fillStyle = awn;
          g.fillRect(px, py + 4, B, 18);
          g.fillStyle = 'rgba(255,255,255,0.25)';
          for (let x = 0; x < B; x += 16) g.fillRect(px + x, py + 4, 8, 18);
          const grad = g.createLinearGradient(px, py + 30, px, py + B);
          grad.addColorStop(0, '#5a6b78');
          grad.addColorStop(1, '#2d3a44');
          g.fillStyle = grad;
          g.fillRect(px + 6, py + 30, B - 12, B - 40);
          glassORM(px + 6, py + 30, B - 12, B - 40);
          g.fillStyle = '#1f1c19';
          g.fillRect(px + 6, py + 64, B - 12, 3);
          eg.fillStyle = rng.chance(0.75) ? '#ffe3b5' : '#000';
          eg.fillRect(px + 6, py + 30, B - 12, B - 40);
        }
      break;
    }
    case 'barn': {
      g.fillStyle = '#7d2c22';
      g.fillRect(0, 0, S, S);
      for (let x = 0; x < S; x += 16) {
        g.fillStyle = shade('#7d2c22', rng.range(-0.12, 0.1));
        g.fillRect(x, 0, 15, S);
      }
      speckle(g, S, S, 4000, rng, '#fff', '#000', 2);
      break;
    }
  }
  const orm = tex(oc, false);
  return { map: tex(c), emissive: tex(ec), orm };
}

function shade(hex: string, amt: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amt)));
  return '#' + c.getHexString();
}

export function roofFlatTexture(): THREE.CanvasTexture {
  const rng = new Rng(4);
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#6f6c66';
  g.fillRect(0, 0, 256, 256);
  speckle(g, 256, 256, 9000, rng, '#d0ccc2', '#222', 2.5);
  return tex(c);
}

export function shingleTexture(): THREE.CanvasTexture {
  const rng = new Rng(5);
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#3d3936';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 16) {
    const off = (y / 16) % 2 ? 0 : 12;
    for (let x = -24; x < 256; x += 24) {
      g.fillStyle = shade('#45403c', rng.range(-0.06, 0.06));
      g.fillRect(x + off + 1, y + 1, 22, 14);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x + off, y + 13, 24, 3);
    }
  }
  return tex(c);
}

export function asphaltTexture(markings: 'road' | 'plain'): THREE.CanvasTexture {
  const rng = new Rng(markings === 'road' ? 7 : 8);
  const W = 256;
  const H = 512;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#3a3b3d';
  g.fillRect(0, 0, W, H);
  speckle(g, W, H, 14000, rng, '#9a9a96', '#111', 2);
  // Patches and cracks.
  for (let i = 0; i < 6; i++) {
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(rng.range(0, W), rng.range(0, H), rng.range(20, 80), rng.range(20, 120));
  }
  if (markings === 'road') {
    g.fillStyle = '#d8d4c8';
    g.fillRect(6, 0, 4, H);
    g.fillRect(W - 10, 0, 4, H);
    g.fillStyle = '#d9a63a';
    for (let y = 0; y < H; y += 128) g.fillRect(W / 2 - 3, y + 20, 6, 60);
  }
  return tex(c);
}

export function intersectionTexture(zebra: boolean): THREE.CanvasTexture {
  const rng = new Rng(zebra ? 9 : 10);
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#3a3b3d';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, 22000, rng, '#9a9a96', '#111', 2);
  if (zebra) {
    // Zebra crossings across each approach (texture spans 14 m; crossings sit 4.5..6.5 m from centre).
    g.fillStyle = 'rgba(222,218,206,0.92)';
    const m = S / 14;
    const inner = (14 / 2 - 2.6) * m;
    for (let k = 0; k < 9; k++) {
      const t = (2.5 + k) * m;
      if (t > S - 2.5 * m) break;
      g.fillRect(t, 6, m * 0.5, inner - 8);
      g.fillRect(t, S - inner + 2, m * 0.5, inner - 8);
      g.fillRect(6, t, inner - 8, m * 0.5);
      g.fillRect(S - inner + 2, t, inner - 8, m * 0.5);
    }
  }
  return tex(c);
}

export function sidewalkTexture(): THREE.CanvasTexture {
  const rng = new Rng(11);
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#a39f97';
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, 9000, rng, '#fff', '#333', 2);
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, 0, 3, S);
  return tex(c);
}

export function noiseTexture(seed: number, base: string, light: string, dark: string, n = 20000, size = 3): THREE.CanvasTexture {
  const rng = new Rng(seed);
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  speckle(g, S, S, n, rng, light, dark, size);
  return tex(c);
}

export function woodFloorTexture(): THREE.CanvasTexture {
  const rng = new Rng(12);
  const [c, g] = canvas(512, 512);
  for (let y = 0; y < 512; y += 32) {
    let x = -rng.range(0, 200);
    while (x < 512) {
      const len = rng.range(140, 260);
      g.fillStyle = shade(rng.pick(['#8a5f3c', '#93673f', '#7f5634', '#9b7048']), rng.range(-0.05, 0.05));
      g.fillRect(x, y, len, 32);
      g.fillStyle = 'rgba(0,0,0,0.08)';
      for (let k = 0; k < 6; k++) g.fillRect(x, y + rng.range(2, 30), len, 1);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x, y, 2, 32);
      x += len;
    }
    g.fillStyle = 'rgba(0,0,0,0.4)';
    g.fillRect(0, y + 31, 512, 1);
  }
  return tex(c);
}

export function plasterTexture(hex: string, seed: number): THREE.CanvasTexture {
  return noiseTexture(seed, hex, '#ffffff', '#3a3226', 6000, 2);
}

export function stoneTexture(): THREE.CanvasTexture {
  const rng = new Rng(13);
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#7a7368';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 32) {
    const off = (y / 32) % 2 ? 0 : 32;
    for (let x = -64; x < 256; x += 64) {
      g.fillStyle = shade('#8b8376', rng.range(-0.08, 0.08));
      g.fillRect(x + off + 2, y + 2, 60, 28);
    }
  }
  speckle(g, 256, 256, 5000, rng, '#fff', '#000', 2);
  return tex(c);
}

export function chainLinkTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(200,205,208,1)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(64, 64);
  g.moveTo(64, 0);
  g.lineTo(0, 64);
  g.moveTo(-32, 32);
  g.lineTo(32, -32);
  g.stroke();
  return tex(c);
}

export const SHOP_NAMES = [
  "DINO'S PIZZA",
  'BEAN THERE',
  'HARLOW HARDWARE',
  'LUCKY STAR DINER',
  'QUIK MART',
  'PHO REAL',
  'SECOND SPIN',
  'GLOW NAILS',
  'PAWN KINGS',
  'CORNER DELI',
  'IRON GYM',
  'BAYVIEW PHARMACY',
  'GOLDEN DRAGON',
  'TECH FIX',
  'MARIGOLD FLOWERS',
  'ROXY CINEMA',
];

/** 16 shop signs stacked vertically in one texture; sign i occupies v in [i/16, (i+1)/16]. */
export function signAtlas(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const W = 512;
  const RH = 80;
  const [c, g] = canvas(W, RH * 16);
  const [ec, eg] = canvas(W, RH * 16);
  const palette = [
    ['#1d2a3a', '#f2c14e'],
    ['#7b2f2a', '#f7efe1'],
    ['#2f5446', '#f0e6c8'],
    ['#efe6d2', '#2a2622'],
    ['#2a2622', '#ff8a5b'],
    ['#3b2d52', '#9fe3d0'],
  ];
  SHOP_NAMES.forEach((name, i) => {
    const [bg, fg] = palette[i % palette.length];
    const y = (15 - i) * RH; // canvas y is flipped relative to UV v
    g.fillStyle = bg;
    g.fillRect(0, y, W, RH);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    g.fillRect(0, y + 4, W, 2);
    g.fillRect(0, y + RH - 6, W, 2);
    g.font = '800 48px "Big Shoulders Display", "Arial Narrow", Impact, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = fg;
    g.fillText(name, W / 2, y + RH / 2 + 2, W - 30);
    eg.fillStyle = '#000';
    eg.fillRect(0, y, W, RH);
    eg.font = g.font;
    eg.textAlign = 'center';
    eg.textBaseline = 'middle';
    eg.fillStyle = fg;
    eg.fillText(name, W / 2, y + RH / 2 + 2, W - 30);
  });
  const map = tex(c, true, false);
  const emissive = tex(ec, true, false);
  return { map, emissive };
}

export function letterTexture(text: string, bg: string, fg: string, w = 256, h = 64): THREE.CanvasTexture {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = `700 ${Math.floor(h * 0.5)}px "Big Shoulders Display", "Arial Narrow", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2, w - 10);
  return tex(c, true, false);
}
