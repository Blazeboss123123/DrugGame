import type { Services } from '../core/Services';

/**
 * Casino games played with real cash: slot machines, blackjack against the dealer, and Double Up,
 * a three-step card ladder (colour x2, higher/lower x4, suit x8) where you can cash out between steps.
 */

const el = (tag: string, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const BETS = [10, 25, 50, 100, 250, 500, 1000];

// ------------------------------------------------------------------ shared: cards
export type Suit = '♠' | '♥' | '♦' | '♣';
export interface Card {
  rank: number; // 2..14 (11 J, 12 Q, 13 K, 14 A)
  suit: Suit;
}
const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];
const SUIT_NAMES: Record<Suit, string> = { '♠': 'Spades', '♥': 'Hearts', '♦': 'Diamonds', '♣': 'Clubs' };
const rankLabel = (r: number) => (r <= 10 ? String(r) : ['J', 'Q', 'K', 'A'][r - 11]);
export const isRed = (c: Card) => c.suit === '♥' || c.suit === '♦';

export function shoe(decks = 1): Card[] {
  const out: Card[] = [];
  for (let d = 0; d < decks; d++) for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) out.push({ rank, suit });
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cardEl(c: Card | null, delay = 0): HTMLElement {
  const e = el('div', `pcard${c ? (isRed(c) ? ' red' : '') : ' back'}`);
  if (c) e.innerHTML = `<span class="r">${rankLabel(c.rank)}</span><span class="s">${c.suit}</span><span class="r2">${rankLabel(c.rank)}${c.suit}</span>`;
  e.style.animationDelay = `${delay}ms`;
  return e;
}

/** Bet chooser: chips from $10 up to what you can afford. */
function betRow(svc: Services, get: () => number, set: (n: number) => void, onChange: () => void): HTMLElement {
  const row = el('div', 'chip-row');
  const render = () => {
    row.innerHTML = '';
    for (const b of BETS) {
      const chip = el('button', `chip-btn${get() === b ? ' on' : ''}`, money(b));
      (chip as HTMLButtonElement).disabled = b > svc.economy.cash;
      chip.onclick = () => {
        set(b);
        render();
        onChange();
      };
      row.appendChild(chip);
    }
  };
  render();
  return row;
}

function cashLine(svc: Services) {
  return `<span class="muted">Cash</span> <strong>${money(svc.economy.cash)}</strong>`;
}

// ------------------------------------------------------------------ slots
const SYMBOLS = [
  { s: '🍒', w: 30, pay: 5, name: 'Cherries' },
  { s: '🍋', w: 25, pay: 8, name: 'Lemons' },
  { s: '🔔', w: 18, pay: 15, name: 'Bells' },
  { s: '⭐', w: 12, pay: 30, name: 'Stars' },
  { s: '7️⃣', w: 8, pay: 80, name: 'Sevens' },
  { s: '💎', w: 4, pay: 250, name: 'Diamonds' },
];
const TOTAL_W = SYMBOLS.reduce((a, b) => a + b.w, 0);
const spinSymbol = () => {
  let r = Math.random() * TOTAL_W;
  return SYMBOLS.findIndex((x) => (r -= x.w) < 0);
};

/** Slot payout for three reels (indices into SYMBOLS), as a multiple of the bet. */
export function slotPayout(r: number[]): number {
  if (r[0] === r[1] && r[1] === r[2]) return SYMBOLS[r[0]].pay;
  if (r.filter((x) => x === 0).length === 2) return 2;
  return 0;
}

export function openSlots(svc: Services, machine: number) {
  const { overlay, body } = svc.ui.panels.shell(`Slot machine ${machine + 1}`, 'Three of a kind pays · two cherries pays 2x');
  let bet = Math.min(25, Math.max(10, svc.economy.cash >= 25 ? 25 : 10));
  let spinning = false;
  let auto = false;
  const top = el('div', 'casino-top', cashLine(svc));
  const reels = el('div', 'reels');
  const cells = [0, 1, 2].map(() => {
    const c = el('div', 'reel', SYMBOLS[spinSymbol()].s);
    reels.appendChild(c);
    return c;
  });
  const result = el('p', 'result casino-result', 'Pick a bet and pull the lever.');
  const spin = el('button', 'btn primary big-btn', 'Spin') as HTMLButtonElement;
  const autoBtn = el('button', 'btn', 'Auto spin ×10') as HTMLButtonElement;
  const pays = el('div', 'paytable', SYMBOLS.map((x) => `<span>${x.s}${x.s}${x.s} <b>${x.pay}x</b></span>`).join('') + '<span>🍒🍒 <b>2x</b></span>');
  const bets = betRow(svc, () => bet, (n) => (bet = n), () => undefined);
  const refresh = () => {
    top.innerHTML = cashLine(svc);
    spin.disabled = spinning || svc.economy.cash < bet;
    autoBtn.disabled = spinning || svc.economy.cash < bet;
  };
  const doSpin = () =>
    new Promise<void>((resolve) => {
      if (spinning || !svc.economy.spend(bet, `Slots: machine ${machine + 1}`)) return resolve();
      spinning = true;
      refresh();
      svc.audio.play('roller');
      const final = [spinSymbol(), spinSymbol(), spinSymbol()];
      cells.forEach((c) => c.classList.add('spinning'));
      let tick = 0;
      const timer = setInterval(() => {
        tick++;
        cells.forEach((c, i) => {
          if (tick < 10 + i * 6) c.textContent = SYMBOLS[spinSymbol()].s;
          else if (c.classList.contains('spinning')) {
            c.textContent = SYMBOLS[final[i]].s;
            c.classList.remove('spinning');
            c.classList.add('landed');
            setTimeout(() => c.classList.remove('landed'), 300);
            svc.audio.play('switch');
          }
        });
        if (tick >= 10 + 2 * 6) {
          clearInterval(timer);
          const mult = slotPayout(final);
          if (mult > 0) {
            const win = bet * mult;
            svc.economy.earn(win, `Slots win (${mult}x)`, false);
            result.textContent = mult >= 30 ? `JACKPOT! ${money(win)} (${mult}x)` : `You win ${money(win)} (${mult}x)`;
            result.className = `result casino-result good${mult >= 30 ? ' jackpot' : ''}`;
            reels.classList.add('win');
            setTimeout(() => reels.classList.remove('win'), 900);
          } else {
            result.textContent = 'No win.';
            result.className = 'result casino-result bad';
          }
          spinning = false;
          refresh();
          resolve();
        }
      }, 70);
    });
  spin.onclick = () => void doSpin();
  autoBtn.onclick = async () => {
    auto = true;
    for (let i = 0; i < 10 && auto && svc.economy.cash >= bet && overlay.isConnected; i++) {
      await doSpin();
      await new Promise((r) => setTimeout(r, 350));
    }
    auto = false;
  };
  const row = el('div', 'btn-row');
  row.append(spin, autoBtn);
  body.append(top, el('div', 'eyebrow', 'Bet'), bets, el('div', 'slot-frame'), result, row, pays);
  body.querySelector('.slot-frame')!.appendChild(reels);
  overlay.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      void doSpin();
    }
  });
  refresh();
  svc.ui.present(overlay, () => (auto = false));
}

// ------------------------------------------------------------------ blackjack
export function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 14) {
      aces++;
      total += 11;
    } else total += Math.min(10, c.rank);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

let bjShoe: Card[] = [];

export function openBlackjack(svc: Services) {
  const { overlay, body } = svc.ui.panels.shell('Blackjack', 'Dealer stands on all 17s · blackjack pays 3 to 2', true);
  let bet = svc.economy.cash >= 50 ? 50 : 10;
  let player: Card[] = [];
  let dealer: Card[] = [];
  let stake = 0;
  let phase: 'bet' | 'play' | 'done' = 'bet';
  const top = el('div', 'casino-top', cashLine(svc));
  const table = el('div', 'bj-table');
  const dealerRow = el('div', 'hand');
  const playerRow = el('div', 'hand');
  const dLabel = el('div', 'hand-label');
  const pLabel = el('div', 'hand-label');
  table.append(dLabel, dealerRow, pLabel, playerRow);
  const result = el('p', 'result casino-result');
  const actions = el('div', 'btn-row');
  const betLabel = el('div', 'eyebrow', 'Bet');
  const bets = betRow(svc, () => bet, (n) => (bet = n), () => render());
  const draw = () => {
    if (bjShoe.length < 15) bjShoe = shoe(6);
    return bjShoe.pop()!;
  };
  const render = () => {
    top.innerHTML = cashLine(svc) + (stake ? ` <span class="muted">· on the table</span> <strong>${money(stake)}</strong>` : '');
    const hideHole = phase === 'play';
    dealerRow.innerHTML = '';
    dealer.forEach((c, i) => dealerRow.appendChild(cardEl(i === 1 && hideHole ? null : c, i * 120)));
    playerRow.innerHTML = '';
    player.forEach((c, i) => playerRow.appendChild(cardEl(c, i * 120)));
    const pv = handValue(player);
    const dv = handValue(hideHole ? dealer.slice(0, 1) : dealer);
    dLabel.textContent = dealer.length ? `Dealer · ${dv.total}${hideHole ? ' + ?' : ''}` : 'Dealer';
    pLabel.textContent = player.length ? `You · ${pv.total}${pv.soft && pv.total < 21 ? ' (soft)' : ''}` : 'You';
    actions.innerHTML = '';
    const btn = (label: string, fn: () => void, primary = false, disabled = false) => {
      const b = el('button', `btn${primary ? ' primary' : ''}`, label) as HTMLButtonElement;
      b.disabled = disabled;
      b.onclick = fn;
      actions.appendChild(b);
    };
    betLabel.hidden = bets.hidden = phase === 'play';
    if (phase === 'play') {
      btn('Hit', hit, true);
      btn('Stand', stand);
      btn(`Double (${money(stake)})`, double, false, player.length !== 2 || svc.economy.cash < stake);
    } else btn(phase === 'done' ? `Deal again · ${money(bet)}` : `Deal · ${money(bet)}`, deal, true, svc.economy.cash < bet);
  };
  const finish = (text: string, payout: number, kind: 'good' | 'bad' | 'info') => {
    phase = 'done';
    if (payout > 0) svc.economy.earn(payout, 'Blackjack', false);
    result.textContent = text;
    result.className = `result casino-result ${kind}`;
    stake = 0;
    render();
  };
  const deal = () => {
    if (!svc.economy.spend(bet, 'Blackjack bet')) return;
    stake = bet;
    player = [draw(), draw()];
    dealer = [draw(), draw()];
    phase = 'play';
    result.textContent = '';
    svc.audio.play('paper');
    const pv = handValue(player).total;
    const dv = handValue(dealer).total;
    if (pv === 21 || dv === 21) {
      phase = 'done';
      if (pv === 21 && dv === 21) return finish('Both blackjack. Push, bet returned.', stake, 'info');
      if (pv === 21) return finish(`Blackjack! You win ${money(stake * 1.5)}.`, stake * 2.5, 'good');
      return finish('Dealer has blackjack.', 0, 'bad');
    }
    render();
  };
  const hit = () => {
    player.push(draw());
    svc.audio.play('paper');
    const v = handValue(player).total;
    if (v > 21) return finish(`Bust with ${v}. You lose ${money(stake)}.`, 0, 'bad');
    if (v === 21) return stand();
    render();
  };
  const double = () => {
    if (!svc.economy.spend(stake, 'Blackjack double')) return;
    stake *= 2;
    player.push(draw());
    const v = handValue(player).total;
    if (v > 21) return finish(`Doubled and bust with ${v}. You lose ${money(stake)}.`, 0, 'bad');
    stand();
  };
  const stand = () => {
    phase = 'done';
    // Dealer plays out: hits to 16, stands on all 17s.
    while (handValue(dealer).total < 17) dealer.push(draw());
    const pv = handValue(player).total;
    const dv = handValue(dealer).total;
    if (dv > 21) finish(`Dealer busts with ${dv}. You win ${money(stake)}.`, stake * 2, 'good');
    else if (pv > dv) finish(`${pv} beats ${dv}. You win ${money(stake)}.`, stake * 2, 'good');
    else if (pv === dv) finish(`Push at ${pv}. Bet returned.`, stake, 'info');
    else finish(`Dealer's ${dv} beats your ${pv}. You lose ${money(stake)}.`, 0, 'bad');
  };
  body.append(top, betLabel, bets, table, result, actions);
  render();
  svc.ui.present(overlay, () => {
    // Walking away mid-hand forfeits the stake, like a real table.
    if (phase === 'play' && stake) svc.ui.toast(`You left the table and forfeited ${money(stake)}.`, 'warn');
  });
}

// ------------------------------------------------------------------ double up
export function openDoubleUp(svc: Services) {
  const { overlay, body } = svc.ui.panels.shell('Double Up', 'Colour x2 · higher or lower x4 · suit x8 · cash out any time', true);
  let bet = svc.economy.cash >= 50 ? 50 : 10;
  let stake = 0;
  let step = 0; // 0 = not playing, 1 colour, 2 higher/lower, 3 suit
  let deck: Card[] = [];
  let shown: Card | null = null;
  let last: Card | null = null;
  const top = el('div', 'casino-top', cashLine(svc));
  const ladder = el('div', 'ladder');
  const stage = el('div', 'du-stage');
  const result = el('p', 'result casino-result');
  const actions = el('div', 'btn-row');
  const betLabel = el('div', 'eyebrow', 'Stake');
  const bets = betRow(svc, () => bet, (n) => (bet = n), () => render());
  const pot = () => stake * 2 ** Math.max(0, step - 1);
  const STEPS = [
    { m: 2, q: 'Red or black?', odds: '1 in 2' },
    { m: 4, q: 'Higher or lower?', odds: 'about 1 in 2 · ties lose' },
    { m: 8, q: 'Which suit?', odds: '1 in 4' },
  ];
  const render = () => {
    top.innerHTML = cashLine(svc) + (stake ? ` <span class="muted">· pot</span> <strong>${money(pot())}</strong>` : '');
    ladder.innerHTML = STEPS.map((s, i) => `<div class="rung${step === i + 1 ? ' current' : step > i + 1 ? ' won' : ''}"><b>${s.m}x</b><span>${s.q}</span><em>${s.odds}</em><strong>${stake ? money(stake * s.m) : ''}</strong></div>`).join('');
    stage.innerHTML = '';
    if (shown) stage.appendChild(cardEl(shown));
    if (last) stage.appendChild(cardEl(last, 100));
    if (step > 0 && !last) stage.appendChild(cardEl(null));
    actions.innerHTML = '';
    const btn = (label: string, fn: () => void, cls = '') => {
      const b = el('button', `btn ${cls}`, label) as HTMLButtonElement;
      b.onclick = fn;
      actions.appendChild(b);
      return b;
    };
    betLabel.hidden = bets.hidden = step > 0;
    if (step === 0) {
      const b = btn(`Start with ${money(bet)}`, start, 'primary');
      b.disabled = svc.economy.cash < bet;
    } else if (step === 1) {
      btn('Red ♥♦', () => guess((c) => isRed(c)), 'red-btn');
      btn('Black ♠♣', () => guess((c) => !isRed(c)), 'black-btn');
    } else if (step === 2) {
      btn(`Higher than ${rankLabel(shown!.rank)}`, () => guess((c) => c.rank > shown!.rank), 'primary');
      btn(`Lower than ${rankLabel(shown!.rank)}`, () => guess((c) => c.rank < shown!.rank));
    } else if (step === 3) {
      for (const s of SUITS) btn(`${s} ${SUIT_NAMES[s]}`, () => guess((c) => c.suit === s), s === '♥' || s === '♦' ? 'red-btn' : 'black-btn');
    }
    if (step > 1) btn(`Cash out ${money(pot())}`, cashOut, 'ok-btn');
  };
  const start = () => {
    if (!svc.economy.spend(bet, 'Double Up stake')) return;
    stake = bet;
    step = 1;
    deck = shoe(1);
    shown = null;
    last = null;
    result.textContent = 'Red or black? Win to double your stake.';
    result.className = 'result casino-result info';
    render();
  };
  const guess = (test: (c: Card) => boolean) => {
    const c = deck.pop()!;
    last = c;
    svc.audio.play('paper');
    if (!test(c)) {
      result.textContent = `${rankLabel(c.rank)}${c.suit}. Lost ${money(pot())}.`;
      result.className = 'result casino-result bad';
      step = 0;
      stake = 0;
      shown = null;
      render();
      return;
    }
    step++;
    if (step > 3) {
      const win = stake * 8;
      svc.economy.earn(win, 'Double Up 8x', false);
      result.textContent = `${rankLabel(c.rank)}${c.suit}! Suit called. You win ${money(win)} (8x)!`;
      result.className = 'result casino-result good jackpot';
      step = 0;
      stake = 0;
      shown = null;
      render();
      return;
    }
    result.textContent = `${rankLabel(c.rank)}${c.suit}. Pot is now ${money(pot())}. ${step === 2 ? 'Higher or lower than this card?' : 'Name the suit of the next card for 8x.'}`;
    result.className = 'result casino-result good';
    // The card you just won with becomes the reference for higher/lower.
    shown = c;
    last = null;
    render();
  };
  const cashOut = () => {
    const win = pot();
    svc.economy.earn(win, `Double Up cash-out (${2 ** (step - 1)}x)`, false);
    result.textContent = `Cashed out ${money(win)}.`;
    result.className = 'result casino-result good';
    step = 0;
    stake = 0;
    shown = null;
    last = null;
    render();
  };
  body.append(top, betLabel, bets, ladder, stage, result, actions);
  render();
  svc.ui.present(overlay, () => {
    // Leaving with a pot cashes it out rather than losing it.
    if (step > 1) cashOut();
    else if (step === 1 && stake) svc.economy.earn(stake, 'Double Up stake returned', false);
  });
}
