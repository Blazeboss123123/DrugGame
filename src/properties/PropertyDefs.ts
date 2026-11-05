import type { District } from '../world/CityPlan';

/** Purchasable properties. Plain data so the city generator can reserve their plots. */

export type PropertyKind = 'house' | 'laundromat' | 'warehouse' | 'barn';

export interface PropertyDef {
  id: string;
  name: string;
  kind: PropertyKind;
  district: District;
  price: number;
  /** Daily running cost once owned. */
  upkeep: number;
  /** Building centre and footprint (x width, z depth). Front door faces +z. */
  x: number;
  z: number;
  w: number;
  d: number;
  staff: number;
  storage: number;
  desc: string;
  /** Equipment included when you buy it. */
  includes: [string, number][];
}

export const PROPERTIES: PropertyDef[] = [
  {
    id: 'laundromat',
    name: 'Suds & Sons Laundromat',
    kind: 'laundromat',
    district: 'commercial',
    price: 6000,
    upkeep: 60,
    x: 187.5,
    z: 52,
    w: 14,
    d: 12,
    staff: 3,
    storage: 24,
    desc: 'A tired laundromat on Market Row with a back room nobody asks about. Room for 4 pots, a mixer, a packager and a kettle.',
    includes: [
      ['pot', 2],
      ['mixer', 1],
      ['packager', 1],
    ],
  },
  {
    id: 'barn',
    name: 'Cedar Ridge Barn',
    kind: 'barn',
    district: 'outskirts',
    price: 12000,
    upkeep: 80,
    x: 344,
    z: -112,
    w: 20,
    d: 14,
    staff: 4,
    storage: 30,
    desc: 'An old barn out on the ridge, well away from patrols. Room for 10 grow pots plus a mixer, packager and kettle.',
    includes: [
      ['pot', 6],
      ['packager', 1],
    ],
  },
  {
    id: 'warehouse',
    name: 'Ironworks Unit 4',
    kind: 'warehouse',
    district: 'industrial',
    price: 22000,
    upkeep: 150,
    x: 187.5,
    z: 192,
    w: 24,
    d: 18,
    staff: 6,
    storage: 40,
    desc: 'A big empty warehouse in the Ironworks yards. 12 pots, two mixing lines, two packagers, two kettles and two presses.',
    includes: [
      ['pot', 4],
      ['mixer', 1],
      ['packager', 1],
    ],
  },
];

/** Whole city blocks the generator must leave empty for these buildings. */
export const PROPERTY_LOTS = [
  { x0: 160, z0: 10, x1: 215, z1: 65 },
  { x0: 160, z0: 160, x1: 215, z1: 215 },
  { x0: 318, z0: -134, x1: 370, z1: -94 },
];
