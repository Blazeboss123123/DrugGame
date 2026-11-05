import type { Services } from '../core/Services';
import { FAMILIES, ITEMS, QUALITY_NAMES } from '../products/Catalog';
import { iconFor } from './Icons';

/**
 * Hands-on packaging, Schedule I style: pick a product, drag portions from the pile into the open
 * baggie (1) or jar (5), seal it (pull the zip / twist the lid) and it slides onto the finished
 * stack. Inventory only changes when a package is sealed.
 */

const el = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

type Pack = 'baggie' | 'jar';
const PACK: Record<Pack, { out: string; per: number; label: string }> = {
  baggie: { out: 'pkg_bag', per: 1, label: 'Baggie · 1 unit' },
  jar: { out: 'pkg_jar', per: 5, label: 'Jar · 5 units' },
};

export function openPackagingBench(svc: Services) {
  const { overlay, body } = svc.ui.panels.shell('Packaging bench', 'Drag product into the package, then seal it', true);
  const inv = svc.inventory;
  let variant: string | null = null;
  let pack: Pack = inv.count('baggie') > 0 || inv.count('jar') === 0 ? 'baggie' : 'jar';
  let filled = 0;
  let sealing = false;
  let done = 0;

  const picker = el('div', 'pk-picker');
  const packTabs = el('div', 'pk-tabs');
  const scene = el('div', 'pk-scene');
  const pile = el('div', 'pk-pile');
  const pileCount = el('div', 'pk-count');
  const mat = el('div', 'pk-mat');
  const out = el('div', 'pk-out');
  const outCount = el('div', 'pk-count');
  const hint = el('p', 'pk-hint');
  const quick = el('button', 'btn small pk-quick', 'Quick pack the rest') as HTMLButtonElement;
  scene.append(el('div', 'pk-col', '<div class="eyebrow">Loose product</div>'), mat, el('div', 'pk-col', '<div class="eyebrow">Finished</div>'));
  (scene.children[0] as HTMLElement).append(pile, pileCount);
  (scene.children[2] as HTMLElement).append(out, outCount);
  body.append(picker, packTabs, scene, hint, quick);

  const stacks = () => {
    const seen = new Map<string, number>();
    for (const s of inv.slots) if (s && s.id === 'prod' && s.v) seen.set(s.v, (seen.get(s.v) ?? 0) + s.qty);
    return [...seen];
  };
  const loose = () => (variant ? inv.count('prod', variant) : 0);
  const packages = () => inv.count(pack);

  const renderPicker = () => {
    picker.innerHTML = '';
    const list = stacks();
    if (!list.length) {
      picker.innerHTML = '<p class="muted">No loose product in your backpack. Harvest plants or brew a batch first.</p>';
      variant = null;
      return;
    }
    if (!variant || !list.some(([v]) => v === variant)) variant = list[0][0];
    for (const [v, n] of list) {
      // Products from another player that this game hasn't learned yet still show (and pack) fine.
      const vv = svc.variants.byKey(v);
      const info = vv ? `${FAMILIES[vv.family]?.name ?? ''} · ${QUALITY_NAMES[vv.quality] ?? ''}` : 'Product';
      const b = el('button', `pk-prod${v === variant ? ' on' : ''}`, `<img src="${iconFor({ id: 'prod', v }, svc.variants)}" alt=""><span><strong>${vv?.name ?? 'Unknown product'}</strong><em>${info} · ${n} loose</em></span>`);
      b.onclick = () => {
        if (filled) return;
        variant = v;
        renderAll();
      };
      picker.appendChild(b);
    }
  };
  const renderTabs = () => {
    packTabs.innerHTML = '';
    for (const p of ['baggie', 'jar'] as Pack[]) {
      const b = el('button', `pk-tab${p === pack ? ' on' : ''}`, `${PACK[p].label} <span class="muted">(${inv.count(p)} left)</span>`);
      b.onclick = () => {
        if (filled) return;
        pack = p;
        renderAll();
      };
      packTabs.appendChild(b);
    }
  };
  const renderPile = () => {
    pile.innerHTML = '';
    const n = loose();
    const show = Math.min(n, 14);
    const img = variant ? iconFor({ id: 'prod', v: variant }, svc.variants) : '';
    for (let i = 0; i < show; i++) {
      const bud = el('img', 'pk-bud') as HTMLImageElement;
      bud.src = img;
      bud.draggable = false;
      bud.style.left = `${12 + ((i * 37) % 70)}%`;
      bud.style.top = `${8 + Math.floor(i / 3) * 15 + ((i * 13) % 9)}%`;
      bud.style.transform = `translate(-50%, 0) rotate(${(i * 47) % 360}deg)`;
      bud.addEventListener('pointerdown', (e) => startDrag(e, bud));
      pile.appendChild(bud);
    }
    pileCount.textContent = variant ? `${n} unit${n === 1 ? '' : 's'}` : '';
  };
  const renderPackage = () => {
    mat.innerHTML = '';
    const per = PACK[pack].per;
    if (!variant || packages() === 0) {
      mat.innerHTML = `<div class="pk-empty">${packages() === 0 ? `No ${pack === 'baggie' ? 'baggies' : 'jars'} left. Buy more at Kwik Corner or in the Market.` : ''}</div>`;
      return;
    }
    const pkg = el('div', `pk-pkg ${pack}${sealing ? ' sealing' : ''}`);
    pkg.innerHTML = pack === 'baggie' ? '<div class="pk-zip"><span class="pk-slider"></span></div><div class="pk-fill"></div>' : '<div class="pk-lid"></div><div class="pk-fill"></div>';
    const fill = pkg.querySelector('.pk-fill') as HTMLElement;
    const img = iconFor({ id: 'prod', v: variant }, svc.variants);
    for (let i = 0; i < filled; i++) {
      const b = el('img', 'pk-in') as HTMLImageElement;
      b.src = img;
      b.style.left = `${20 + ((i * 29) % 55)}%`;
      b.style.bottom = `${6 + i * (pack === 'jar' ? 13 : 0)}%`;
      fill.appendChild(b);
    }
    const meter = el('div', 'pk-meter', `${filled} / ${per}`);
    pkg.appendChild(meter);
    pkg.dataset.drop = '1';
    if (filled >= per && !sealing) {
      pkg.classList.add('ready');
      const seal = pkg.querySelector(pack === 'baggie' ? '.pk-zip' : '.pk-lid') as HTMLElement;
      seal.title = pack === 'baggie' ? 'Drag the zip across to seal' : 'Click to twist the lid on';
      if (pack === 'baggie') armZip(seal);
      else seal.onclick = () => sealIt();
    }
    mat.appendChild(pkg);
  };
  const renderOut = () => {
    out.innerHTML = '';
    const outId = PACK[pack].out;
    const n = variant ? inv.count(outId, variant) : 0;
    const img = variant ? iconFor({ id: outId, v: variant }, svc.variants) : '';
    for (let i = 0; i < Math.min(n, 12); i++) {
      const b = el('img', 'pk-done') as HTMLImageElement;
      b.src = img;
      b.style.left = `${10 + (i % 4) * 22}%`;
      b.style.bottom = `${4 + Math.floor(i / 4) * 18}%`;
      out.appendChild(b);
    }
    outCount.textContent = variant ? `${n} ${pack === 'baggie' ? 'baggies' : 'jars'}${done ? ` · ${done} this session` : ''}` : '';
  };
  const renderHint = () => {
    const per = PACK[pack].per;
    hint.textContent = !variant
      ? ''
      : packages() === 0
        ? 'You need packaging.'
        : filled < per
          ? loose() < per - filled
            ? `Not enough loose product for a full ${pack}.`
            : `Drag ${per - filled} more portion${per - filled === 1 ? '' : 's'} from the pile into the ${pack}.`
          : pack === 'baggie'
            ? 'Full! Drag the zip from left to right to seal it.'
            : 'Full! Click the lid to twist it on.';
    quick.hidden = !variant || packages() === 0 || loose() < per;
  };
  const renderAll = () => {
    renderPicker();
    renderTabs();
    renderPile();
    renderPackage();
    renderOut();
    renderHint();
  };

  // ---- dragging portions into the package
  let ghost: HTMLImageElement | null = null;
  const startDrag = (e: PointerEvent, bud: HTMLImageElement) => {
    if (sealing || filled >= PACK[pack].per || packages() === 0 || filled >= loose()) return;
    e.preventDefault();
    ghost = bud.cloneNode() as HTMLImageElement;
    ghost.className = 'pk-ghost';
    document.body.appendChild(ghost);
    bud.style.visibility = 'hidden';
    const move = (ev: PointerEvent) => {
      ghost!.style.left = `${ev.clientX}px`;
      ghost!.style.top = `${ev.clientY}px`;
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
      mat.querySelector('.pk-pkg')?.classList.toggle('hover', !!over);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost!.style.visibility = 'hidden';
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
      ghost!.remove();
      ghost = null;
      if (over) {
        filled++;
        svc.audio.play('pickup');
        renderPile();
        renderPackage();
        renderHint();
        const pkg = mat.querySelector('.pk-pkg');
        pkg?.classList.add('bump');
      } else bud.style.visibility = '';
    };
    move(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- sealing
  const armZip = (zip: HTMLElement) => {
    const slider = zip.querySelector('.pk-slider') as HTMLElement;
    zip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = zip.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        slider.style.left = `${t * 100}%`;
        zip.style.setProperty('--zip', `${t * 100}%`);
        if (t > 0.92) {
          cleanup();
          sealIt();
        }
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', cleanup);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', cleanup);
    });
  };
  const sealIt = () => {
    if (sealing || !variant) return;
    const { out: outId, per } = PACK[pack];
    if (inv.count(pack) < 1 || inv.count('prod', variant) < per) return;
    if (inv.space(outId, variant) < 1 && inv.count('prod', variant) > per) {
      hint.textContent = 'No room in your backpack for another package.';
      return;
    }
    sealing = true;
    inv.remove(pack, 1);
    inv.remove('prod', per, variant);
    inv.add(outId, 1, variant);
    svc.audio.play('place');
    svc.bus.emit('objective:signal', { id: 'package' });
    done++;
    const pkg = mat.querySelector('.pk-pkg') as HTMLElement | null;
    pkg?.classList.add('sealed');
    // Slide the sealed package over to the finished pile, then bring in a fresh one.
    setTimeout(() => pkg?.classList.add('fly'), 350);
    setTimeout(() => {
      sealing = false;
      filled = 0;
      renderAll();
      mat.querySelector('.pk-pkg')?.classList.add('enter');
      out.lastElementChild?.classList.add('arrive');
    }, 900);
  };

  quick.onclick = () => {
    if (!variant || sealing) return;
    const { out: outId, per } = PACK[pack];
    let n = 0;
    while (inv.count(pack) > 0 && inv.count('prod', variant) >= per && (inv.space(outId, variant) > 0 || inv.count('prod', variant) === per)) {
      inv.remove(pack, 1);
      inv.remove('prod', per, variant);
      inv.add(outId, 1, variant);
      n++;
    }
    if (n) {
      svc.audio.play('place');
      svc.bus.emit('objective:signal', { id: 'package' });
      done += n;
    }
    filled = 0;
    renderAll();
  };

  renderAll();
  svc.ui.present(overlay, () => ghost?.remove());
  void ITEMS;
}
