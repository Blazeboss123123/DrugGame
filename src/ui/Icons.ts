import type { Stack } from '../inventory/Inventory';
import { EFFECTS, FAMILIES, ITEMS, type VariantRegistry } from '../products/Catalog';

const cache = new Map<string, string>();

/** Colour for a stack: products take the colour of their strongest effect. */
export function stackColor(s: { id: string; v?: string }, variants: VariantRegistry): string {
  const v = variants.byKey(s.v);
  if (v) {
    const top = [...v.effects].sort((a, b) => EFFECTS[b].mult - EFFECTS[a].mult)[0];
    return top ? EFFECTS[top].color : FAMILIES[v.family].color;
  }
  return ITEMS[s.id]?.color ?? '#888';
}

/** Small painted icon for an item, cached as a data URL. */
export function iconFor(s: { id: string; v?: string }, variants: VariantRegistry): string {
  const def = ITEMS[s.id];
  const v = variants.byKey(s.v);
  const color = stackColor(s, variants);
  const shape = v && def.kind === 'product' ? (v.family === 'nightshade' ? 'leaf' : v.family === 'dreamdust' ? 'powder' : 'tablet') : def.shape;
  const key = `${s.id}|${color}|${shape}|${v?.family ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  const outline = 'rgba(0,0,0,0.55)';
  g.lineWidth = 2.5;
  const fill = (path: () => void, col: string) => {
    g.beginPath();
    path();
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = outline;
    g.stroke();
  };
  switch (shape) {
    case 'bag':
      fill(() => {
        g.moveTo(16, 14);
        g.lineTo(48, 14);
        g.lineTo(52, 54);
        g.lineTo(12, 54);
        g.closePath();
      }, color);
      g.fillStyle = 'rgba(255,255,255,0.75)';
      g.fillRect(20, 28, 24, 12);
      break;
    case 'seed':
      fill(() => g.roundRect(14, 10, 36, 46, 4), '#efe6d2');
      fill(() => g.ellipse(32, 34, 9, 13, 0.3, 0, Math.PI * 2), color);
      break;
    case 'bottle':
      fill(() => {
        g.moveTo(27, 8);
        g.lineTo(37, 8);
        g.lineTo(37, 20);
        g.lineTo(46, 28);
        g.lineTo(46, 56);
        g.lineTo(18, 56);
        g.lineTo(18, 28);
        g.lineTo(27, 20);
        g.closePath();
      }, color);
      break;
    case 'leaf':
      for (const [x, y, r] of [
        [24, 36, 13],
        [40, 34, 12],
        [32, 24, 12],
      ])
        fill(() => g.arc(x, y, r, 0, Math.PI * 2), color);
      break;
    case 'powder':
      fill(() => {
        g.moveTo(8, 52);
        g.quadraticCurveTo(32, 6, 56, 52);
        g.closePath();
      }, color);
      break;
    case 'tablet':
      for (const [x, y] of [
        [22, 24],
        [42, 26],
        [30, 42],
      ])
        fill(() => g.arc(x, y, 10, 0, Math.PI * 2), color);
      break;
    case 'crystal':
      fill(() => {
        g.moveTo(32, 6);
        g.lineTo(50, 26);
        g.lineTo(40, 58);
        g.lineTo(24, 58);
        g.lineTo(14, 26);
        g.closePath();
      }, color);
      break;
    case 'jar':
      fill(() => g.roundRect(16, 18, 32, 40, 6), 'rgba(200,225,235,0.55)');
      if (v) fill(() => g.roundRect(20, 30, 24, 24, 4), color);
      fill(() => g.roundRect(14, 10, 36, 10, 3), '#c23a2a');
      break;
    case 'baggie':
      fill(() => g.roundRect(12, 12, 40, 42, 3), 'rgba(225,238,242,0.6)');
      g.fillStyle = '#9aa';
      g.fillRect(12, 18, 40, 3);
      if (v) fill(() => g.ellipse(32, 38, 12, 9, 0, 0, Math.PI * 2), color);
      break;
    case 'can':
      fill(() => g.roundRect(14, 22, 30, 32, 5), color);
      fill(() => {
        g.moveTo(44, 30);
        g.lineTo(58, 16);
        g.lineTo(60, 20);
        g.lineTo(46, 36);
        g.closePath();
      }, color);
      g.strokeStyle = outline;
      g.beginPath();
      g.arc(29, 22, 10, Math.PI, 0);
      g.stroke();
      break;
    case 'board':
      fill(() => g.roundRect(6, 24, 52, 14, 7), color);
      fill(() => g.arc(16, 44, 5, 0, Math.PI * 2), '#ddd');
      fill(() => g.arc(48, 44, 5, 0, Math.PI * 2), '#ddd');
      break;
    default:
      fill(() => g.roundRect(12, 16, 40, 36, 4), color);
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.fillRect(12, 30, 40, 4);
  }
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

export function stackName(s: Stack | { id: string; v?: string }, variants: VariantRegistry): string {
  const def = ITEMS[s.id];
  const v = variants.byKey(s.v);
  if (!v) return def?.name ?? s.id;
  if (def.kind === 'product') return v.name;
  return `${v.name} (${def.id === 'pkg_jar' ? 'jar' : 'baggie'})`;
}
