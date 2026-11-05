/**
 * Where people live. Customers belong to one neighbourhood: they hang around its streets, and when
 * they text for a deal they want to meet on a corner there. Almost everyone lives within a few
 * blocks of 14 Larch Street, so the business stays compact; a few live out by the other properties.
 */
export interface Neighbourhood {
  id: string;
  name: string;
  /** Street-grid bounds (block edges on the road centre lines). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Share of civilians who live here. */
  weight: number;
  blurb: string;
}

export const NEIGHBOURHOODS: Neighbourhood[] = [
  { id: 'maple', name: 'Maple Hill', x0: -150, x1: 0, z0: -225, z1: -75, weight: 30, blurb: 'Your street. Quiet houses, nosy neighbours.' },
  { id: 'ash', name: 'Ash Row', x0: -150, x1: 0, z0: -75, z1: 75, weight: 22, blurb: 'Round the corner from Kwik Corner.' },
  { id: 'meridian', name: 'Meridian', x0: 0, x1: 150, z0: -75, z1: 75, weight: 24, blurb: 'Downtown offices and the plaza.' },
  { id: 'bell', name: 'Bell Park', x0: 0, x1: 150, z0: -225, z1: -75, weight: 14, blurb: 'Leafy blocks east of Central Ave.' },
  { id: 'market', name: 'Market Row', x0: 150, x1: 300, z0: -75, z1: 150, weight: 6, blurb: 'Shops near the laundromat.' },
  { id: 'ironworks', name: 'Ironworks', x0: 75, x1: 225, z0: 150, z1: 300, weight: 4, blurb: 'Yards and units by the warehouse.' },
];

/** The compact core where police patrol (all four home neighbourhoods). */
export const CORE = { x0: -150, x1: 150, z0: -225, z1: 75 };

export function inHood(h: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number, pad = 7): boolean {
  return x >= h.x0 - pad && x <= h.x1 + pad && z >= h.z0 - pad && z <= h.z1 + pad;
}

export function hoodAt(x: number, z: number): Neighbourhood | null {
  return NEIGHBOURHOODS.find((h) => inHood(h, x, z, 0)) ?? null;
}
