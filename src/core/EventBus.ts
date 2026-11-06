import type { District } from '../world/CityPlan';

/** Every event that crosses module boundaries is declared here, so systems stay decoupled but typed. */
export interface GameEvents {
  toast: { text: string; kind?: 'info' | 'good' | 'warn' };
  'district:enter': { district: District };
  'objective:signal': { id: ObjectiveSignal; amount?: number };
  'objectives:changed': Record<string, never>;
  'player:jump': Record<string, never>;
  'player:footstep': { surface: Surface; sprint: boolean };
  'player:land': { speed: number };
  'interior:change': { inside: boolean };
  'time:slept': { day: number };
  'money:changed': { cash: number; delta: number };
  'police:state': { state: 'clear' | 'chase' | 'search'; officer?: string };
  'phone:notify': { app: string; text: string };
  'player:took': { effects: string[] };
  'player:jailed': { hours: number; text: string };
}

export type Surface = 'grass' | 'concrete' | 'wood' | 'metal' | 'dirt';

export type ObjectiveSignal =
  | 'walked'
  | 'sprinted'
  | 'jumped'
  | 'mail'
  | 'enterHouse'
  | 'light'
  | 'placeItem'
  | 'computer'
  | 'district'
  | 'sleep'
  | 'phone'
  | 'order'
  | 'drop'
  | 'collect'
  | 'plant'
  | 'water'
  | 'harvest'
  | 'mix'
  | 'package'
  | 'sample'
  | 'sale'
  | 'cash';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<any>>>();

  on<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }
}
