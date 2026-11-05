import './ui/styles.css';
import { Game } from './core/Game';

const root = document.getElementById('app')!;
const game = new Game(root);
(window as unknown as { __UE: ReturnType<Game['debugApi']> }).__UE = game.debugApi();

game.init().catch((err: unknown) => {
  console.error(err);
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  game.ui.showError(`The game failed to start.\n\n${msg}`);
});
