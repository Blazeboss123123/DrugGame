/** Multiplayer worlds you've hosted (each is its own game, saved apart from your single-player slots). */

export interface HostedWorld {
  wid: string;
  name: string;
  code: string;
  day: number;
  cash: number;
  savedAt: number;
  /** Set when the world is your own saved game (hosted from that slot). */
  slot?: number;
}

/** Worlds you've hosted, so you can carry on with one later (newest first). */
export function hostedWorlds(): HostedWorld[] {
  try {
    return (JSON.parse(localStorage.getItem('ue.hostedWorlds') || '[]') as HostedWorld[]).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export function rememberHostedWorld(w: HostedWorld) {
  try {
    const list = hostedWorlds().filter((x) => x.wid !== w.wid);
    list.unshift(w);
    localStorage.setItem('ue.hostedWorlds', JSON.stringify(list.slice(0, 12)));
  } catch {
    /* storage unavailable */
  }
}

