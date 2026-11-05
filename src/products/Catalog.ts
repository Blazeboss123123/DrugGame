/**
 * Data definitions for every item in the game, plus the product mixing rules.
 * Everything here is data-driven: add an entry and it shows up in shops, inventory and mixing.
 * All products are fictional game-world goods.
 */

export type ItemKind = 'seed' | 'supply' | 'ingredient' | 'product' | 'packaged' | 'packaging' | 'tool' | 'equipment';
export type Family = 'nightshade' | 'dreamdust' | 'neon';
export type Quality = 0 | 1 | 2;
export const QUALITY_NAMES = ['Standard', 'Fine', 'Premium'];
export const QUALITY_MULT = [1, 1.3, 1.65];

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  stack: number;
  /** Market price, or 0 if not sold. */
  price: number;
  color: string;
  shape: 'bag' | 'seed' | 'bottle' | 'leaf' | 'powder' | 'tablet' | 'jar' | 'baggie' | 'can' | 'box' | 'board' | 'crystal';
  desc: string;
  /** Unlock requirement shown in the Market. */
  unlock?: { lifetimeRevenue: number };
  family?: Family;
}

export interface EffectDef {
  id: string;
  name: string;
  mult: number;
  color: string;
}

export const EFFECTS: Record<string, EffectDef> = {
  calming: { id: 'calming', name: 'Calming', mult: 0.1, color: '#7fb8d6' },
  bright: { id: 'bright', name: 'Bright', mult: 0.15, color: '#f4e27a' },
  fizzy: { id: 'fizzy', name: 'Fizzy', mult: 0.18, color: '#9fe0c8' },
  minty: { id: 'minty', name: 'Minty', mult: 0.12, color: '#8fe3a8' },
  spicy: { id: 'spicy', name: 'Spicy', mult: 0.2, color: '#e8664a' },
  sweet: { id: 'sweet', name: 'Sweet', mult: 0.14, color: '#f2a6c8' },
  glowing: { id: 'glowing', name: 'Glowing', mult: 0.3, color: '#c6f25a' },
  electric: { id: 'electric', name: 'Electric', mult: 0.35, color: '#6fa8ff' },
  smoky: { id: 'smoky', name: 'Smoky', mult: 0.16, color: '#8a8580' },
  zesty: { id: 'zesty', name: 'Zesty', mult: 0.22, color: '#f5c542' },
  dreamy: { id: 'dreamy', name: 'Dreamy', mult: 0.3, color: '#b9a2f0' },
  shimmering: { id: 'shimmering', name: 'Shimmering', mult: 0.38, color: '#e4e9ff' },
  cosmic: { id: 'cosmic', name: 'Cosmic', mult: 0.45, color: '#7a5cf0' },
  gilded: { id: 'gilded', name: 'Gilded', mult: 0.5, color: '#e9b949' },
  foggy: { id: 'foggy', name: 'Foggy', mult: 0.06, color: '#a9b0b6' },
  jittery: { id: 'jittery', name: 'Jittery', mult: -0.12, color: '#d0d27a' },
  velvet: { id: 'velvet', name: 'Velvet', mult: 0.28, color: '#a8324a' },
};

/** Mixers: each adds its own effect and transforms effects already present. */
export interface IngredientDef {
  item: string;
  adds: string;
  transforms: Record<string, string>;
}

export const INGREDIENTS: IngredientDef[] = [
  { item: 'mint', adds: 'minty', transforms: { spicy: 'calming', foggy: 'bright' } },
  { item: 'cola', adds: 'fizzy', transforms: { calming: 'bright', sweet: 'zesty' } },
  { item: 'chili', adds: 'spicy', transforms: { minty: 'smoky', bright: 'electric' } },
  { item: 'sugar', adds: 'sweet', transforms: { fizzy: 'shimmering', spicy: 'zesty' } },
  { item: 'glowfluid', adds: 'glowing', transforms: { bright: 'shimmering', calming: 'dreamy' } },
  { item: 'iron', adds: 'electric', transforms: { glowing: 'cosmic', sweet: 'foggy' } },
  { item: 'lemon', adds: 'zesty', transforms: { smoky: 'bright', foggy: 'fizzy' } },
  { item: 'honey', adds: 'calming', transforms: { electric: 'gilded', jittery: 'calming', zesty: 'velvet' } },
  { item: 'charcoal', adds: 'smoky', transforms: { zesty: 'jittery', shimmering: 'foggy' } },
  { item: 'glitter', adds: 'shimmering', transforms: { dreamy: 'cosmic', glowing: 'gilded' } },
];

export const FAMILIES: Record<Family, { name: string; base: number; color: string; desc: string }> = {
  nightshade: { name: 'Nightshade', base: 32, color: '#6d4f9e', desc: 'A fictional herbal product grown from seed in pots.' },
  dreamdust: { name: 'Dreamdust', base: 68, color: '#d8d0f2', desc: 'A fictional shimmering powder brewed in a kettle.' },
  neon: { name: 'Neon', base: 48, color: '#39e0c2', desc: 'Fictional collectible synthetic tablets pressed from resin.' },
};

export const ITEMS: Record<string, ItemDef> = {};
const def = (d: ItemDef) => (ITEMS[d.id] = d);

// Seeds and growing supplies.
def({ id: 'seed_violet', name: 'Violet Hush seed', kind: 'seed', stack: 10, price: 30, color: '#6d4f9e', shape: 'seed', desc: 'Grows Nightshade with a Calming effect.', family: 'nightshade' });
def({ id: 'seed_fern', name: 'Blue Fern seed', kind: 'seed', stack: 10, price: 45, color: '#3f7fbf', shape: 'seed', desc: 'Grows Nightshade with a Bright effect.', family: 'nightshade' });
def({ id: 'seed_ember', name: 'Ember Tip seed', kind: 'seed', stack: 10, price: 70, color: '#d0603a', shape: 'seed', desc: 'Grows Nightshade with a Spicy effect.', family: 'nightshade', unlock: { lifetimeRevenue: 1500 } });
def({ id: 'soil', name: 'Potting soil', kind: 'supply', stack: 10, price: 15, color: '#6b4a2b', shape: 'bag', desc: 'One bag fills one grow pot for one harvest.' });
def({ id: 'soil_rich', name: 'Rich soil', kind: 'supply', stack: 10, price: 40, color: '#3b2a1a', shape: 'bag', desc: 'Premium soil. Harvests come out one quality tier higher.' });
def({ id: 'fertilizer', name: 'Fertilizer', kind: 'supply', stack: 10, price: 25, color: '#7fb04a', shape: 'bottle', desc: 'Add to a growing plant for a bigger yield.' });
def({ id: 'wateringcan', name: 'Watering can', kind: 'tool', stack: 1, price: 20, color: '#4f87b8', shape: 'can', desc: 'Select it and use it on a grow pot to water the plant.' });
// Dreamdust and Neon inputs.
def({ id: 'moonsalt', name: 'Moonsalt', kind: 'supply', stack: 10, price: 60, color: '#e6e3f5', shape: 'crystal', desc: 'Dreamdust base. One batch in the kettle makes 8 units.', unlock: { lifetimeRevenue: 2000 } });
def({ id: 'starwater', name: 'Starwater', kind: 'supply', stack: 10, price: 35, color: '#8fb8ff', shape: 'bottle', desc: 'Kettle liquid. One per Dreamdust batch.', unlock: { lifetimeRevenue: 2000 } });
def({ id: 'resin', name: 'Neon resin', kind: 'supply', stack: 10, price: 70, color: '#39e0c2', shape: 'box', desc: 'Pressed into 10 Neon tablets.', unlock: { lifetimeRevenue: 5000 } });
// Mixers.
def({ id: 'mint', name: 'Mint leaf', kind: 'ingredient', stack: 20, price: 4, color: '#5fc27a', shape: 'leaf', desc: 'Adds Minty.' });
def({ id: 'cola', name: 'Cola syrup', kind: 'ingredient', stack: 20, price: 5, color: '#5a2e1e', shape: 'bottle', desc: 'Adds Fizzy.' });
def({ id: 'chili', name: 'Chili flakes', kind: 'ingredient', stack: 20, price: 6, color: '#c8402a', shape: 'powder', desc: 'Adds Spicy.' });
def({ id: 'sugar', name: 'Sugar cube', kind: 'ingredient', stack: 20, price: 3, color: '#f4f1ea', shape: 'box', desc: 'Adds Sweet.' });
def({ id: 'glowfluid', name: 'Glow fluid', kind: 'ingredient', stack: 20, price: 10, color: '#c6f25a', shape: 'bottle', desc: 'Adds Glowing.' });
def({ id: 'iron', name: 'Iron filings', kind: 'ingredient', stack: 20, price: 7, color: '#6d7378', shape: 'powder', desc: 'Adds Electric.' });
def({ id: 'lemon', name: 'Lemon zest', kind: 'ingredient', stack: 20, price: 5, color: '#f2d43a', shape: 'leaf', desc: 'Adds Zesty.' });
def({ id: 'honey', name: 'Honey', kind: 'ingredient', stack: 20, price: 8, color: '#e3a92b', shape: 'jar', desc: 'Adds Calming.' });
def({ id: 'charcoal', name: 'Charcoal', kind: 'ingredient', stack: 20, price: 4, color: '#2a2a2a', shape: 'box', desc: 'Adds Smoky.' });
def({ id: 'glitter', name: 'Stardust glitter', kind: 'ingredient', stack: 20, price: 14, color: '#d9dcff', shape: 'powder', desc: 'Adds Shimmering.', unlock: { lifetimeRevenue: 800 } });
// Packaging.
def({ id: 'baggie', name: 'Baggie', kind: 'packaging', stack: 40, price: 1, color: '#d9e6ea', shape: 'baggie', desc: 'Holds 1 unit of product.' });
def({ id: 'jar', name: 'Jar', kind: 'packaging', stack: 20, price: 3, color: '#b8d4dc', shape: 'jar', desc: 'Holds 5 units of product.', unlock: { lifetimeRevenue: 1000 } });
// Products (meta: variant key) and packaged products.
def({ id: 'prod', name: 'Product', kind: 'product', stack: 40, price: 0, color: '#6d4f9e', shape: 'leaf', desc: 'Loose product. Package it before selling.' });
def({ id: 'pkg_bag', name: 'Baggie', kind: 'packaged', stack: 20, price: 0, color: '#6d4f9e', shape: 'baggie', desc: '1 unit, ready to sell.' });
def({ id: 'pkg_jar', name: 'Jar', kind: 'packaged', stack: 10, price: 0, color: '#6d4f9e', shape: 'jar', desc: '5 units, ready to sell.' });
// Equipment and gear (installed in the garage / given to the player).
def({ id: 'pot', name: 'Grow pot', kind: 'equipment', stack: 1, price: 120, color: '#a4553a', shape: 'box', desc: 'An extra grow pot, installed at the delivery property.' });
def({ id: 'mixer', name: 'Mixing station', kind: 'equipment', stack: 1, price: 650, color: '#2f6b7a', shape: 'box', desc: 'Another mixing station for the delivery property.' });
def({ id: 'packager', name: 'Packaging bench', kind: 'equipment', stack: 1, price: 400, color: '#8a6a4a', shape: 'box', desc: 'Another packaging bench for the delivery property.' });
def({ id: 'kettle', name: 'Dreamdust kettle', kind: 'equipment', stack: 1, price: 900, color: '#3d4a57', shape: 'box', desc: 'Brews Moonsalt and Starwater into Dreamdust.', unlock: { lifetimeRevenue: 2000 } });
def({ id: 'press', name: 'Neon press', kind: 'equipment', stack: 1, price: 1600, color: '#2f6b7a', shape: 'box', desc: 'Presses resin into Neon tablets.', unlock: { lifetimeRevenue: 5000 } });
def({ id: 'skateboard', name: 'Skateboard', kind: 'tool', stack: 1, price: 75, color: '#c23a2a', shape: 'board', desc: 'Press R to hop on and off. Push with W, brake with S.' });

export const unitsOf = (itemId: string) => (itemId === 'pkg_jar' ? 5 : itemId === 'pkg_bag' || itemId === 'prod' ? 1 : 0);

// ------------------------------------------------------------------ product variants

export interface Variant {
  key: string;
  family: Family;
  effects: string[];
  quality: Quality;
  name: string;
  discovered: number; // game day
}

/** All discovered variants, keyed by family + sorted effects + quality. */
export class VariantRegistry {
  readonly variants = new Map<string, Variant>();
  /** Custom names the player gave to effect combinations (shared across qualities). */
  readonly names = new Map<string, string>();

  static comboKey(family: Family, effects: string[]) {
    return `${family}:${[...effects].sort().join('+')}`;
  }

  static key(family: Family, effects: string[], quality: Quality) {
    return `${VariantRegistry.comboKey(family, effects)}@${quality}`;
  }

  /** Returns the variant, registering it if new. `isNew` reports a first-time discovery. */
  get(family: Family, effects: string[], quality: Quality, day: number): { variant: Variant; isNew: boolean } {
    const key = VariantRegistry.key(family, effects, quality);
    const existing = this.variants.get(key);
    if (existing) return { variant: existing, isNew: false };
    const combo = VariantRegistry.comboKey(family, effects);
    const comboKnown = [...this.variants.values()].some((v) => VariantRegistry.comboKey(v.family, v.effects) === combo);
    const v: Variant = { key, family, effects: [...effects], quality, name: this.names.get(combo) ?? autoName(family, effects), discovered: day };
    this.variants.set(key, v);
    return { variant: v, isNew: !comboKnown };
  }

  byKey(key: string | undefined): Variant | undefined {
    return key ? this.variants.get(key) : undefined;
  }

  rename(key: string, name: string) {
    const v = this.variants.get(key);
    if (!v) return;
    const combo = VariantRegistry.comboKey(v.family, v.effects);
    this.names.set(combo, name);
    for (const o of this.variants.values()) if (VariantRegistry.comboKey(o.family, o.effects) === combo) o.name = name;
  }
}

const ADJ: Record<string, string> = {
  calming: 'Hush',
  bright: 'Dawn',
  fizzy: 'Pop',
  minty: 'Frost',
  spicy: 'Ember',
  sweet: 'Candy',
  glowing: 'Lantern',
  electric: 'Volt',
  smoky: 'Ash',
  zesty: 'Citrus',
  dreamy: 'Lull',
  shimmering: 'Prism',
  cosmic: 'Nova',
  gilded: 'Crown',
  foggy: 'Haze',
  jittery: 'Static',
  velvet: 'Velvet',
};
const NOUN: Record<Family, string[]> = {
  nightshade: ['Bloom', 'Leaf', 'Root', 'Bud'],
  dreamdust: ['Dust', 'Drift', 'Veil', 'Sugar'],
  neon: ['Chip', 'Pixel', 'Spark', 'Coin'],
};

export function autoName(family: Family, effects: string[]): string {
  if (!effects.length) return FAMILIES[family].name;
  const top = [...effects].sort((a, b) => EFFECTS[b].mult - EFFECTS[a].mult);
  const n = NOUN[family][(effects.length + top[0].length) % 4];
  return top.length > 1 ? `${ADJ[top[0]]} ${ADJ[top[1]]} ${n}` : `${ADJ[top[0]]} ${n}`;
}

/** Applies a mixer to an effect list: transforms existing effects, then adds the mixer's own. */
export function mixEffects(effects: string[], ingredientItem: string): string[] {
  const ing = INGREDIENTS.find((i) => i.item === ingredientItem);
  if (!ing) return effects;
  const out: string[] = [];
  for (const e of effects) {
    const t = ing.transforms[e] ?? e;
    if (!out.includes(t)) out.push(t);
  }
  if (!out.includes(ing.adds) && out.length < 8) out.push(ing.adds);
  return out;
}

export function unitValue(v: Variant): number {
  const sum = v.effects.reduce((s, e) => s + (EFFECTS[e]?.mult ?? 0), 0);
  return Math.round(FAMILIES[v.family].base * (1 + sum) * QUALITY_MULT[v.quality]);
}

export const STRAIN_EFFECT: Record<string, string> = { seed_violet: 'calming', seed_fern: 'bright', seed_ember: 'spicy' };
