import type * as THREE from 'three';
import type { AudioManager } from '../audio/AudioManager';
import type { Customers } from '../business/Customers';
import type { Rivals } from '../business/Rivals';
import type { Upgrades } from '../business/Upgrades';
import type { Employees } from '../employees/Employees';
import type { Properties } from '../properties/Properties';
import type { Vehicles } from '../vehicles/Vehicles';
import type { Net } from '../net/Net';
import type { Settings } from './Settings';
import type { Substances } from '../player/Substances';
import type { Economy } from '../economy/Economy';
import type { Market } from '../economy/Market';
import type { InteractionSystem } from '../interaction/InteractionSystem';
import type { Container, Stack } from '../inventory/Inventory';
import type { Physics } from '../physics/Physics';
import type { PlayerController } from '../player/PlayerController';
import type { VariantRegistry } from '../products/Catalog';
import type { Production } from '../production/Production';
import type { UI } from '../ui/UI';
import type { World } from '../world/World';
import type { EventBus } from './EventBus';
import type { GameState } from './GameState';
import type { TimeOfDay } from './TimeOfDay';

/** Shared handles every system can reach. Filled in during boot, before the first frame runs. */
export interface Services {
  scene: THREE.Scene;
  bus: EventBus;
  physics: Physics;
  audio: AudioManager;
  time: TimeOfDay;
  state: GameState;
  ui: UI;
  player: PlayerController;
  interaction: InteractionSystem;
  inventory: Container;
  hotbar: { selected: number };
  economy: Economy;
  market: Market;
  variants: VariantRegistry;
  production: Production;
  customers: Customers;
  world: World;
  rivals: Rivals;
  upgrades: Upgrades;
  employees: Employees;
  properties: Properties;
  vehicles: Vehicles;
  net: Net;
  settings: Settings;
  substances: Substances;
  /** The stack in the selected hotbar slot. */
  held(): Stack | null;
}
