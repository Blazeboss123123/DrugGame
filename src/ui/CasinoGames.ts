import type { Services } from '../core/Services';
import { FRONTS } from '../economy/Economy';

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

/** Session results per visit, so the table can show how you're doing. */
const bjSession = { hands: 0, won: 0, net: 0, streak: 0 };

interface BjHand {
  cards: Card[];
  stake: number;
  done: boolean;
  doubled: boolean;
  fromSplit: boolean;
}

/**
 * Blackjack against the house dealer.
 * Money flow: your bet leaves your cash when the cards are dealt (it sits "on the table"). A win pays
 * the stake back PLUS the same again in profit (1:1), a natural blackjack pays 3:2 profit, a five-card
 * hand of 21 or under wins automatically, and a push hands the stake back. Winning rounds in a row
 * build a hot streak that adds a bonus on top of the profit.
 */
export function openBlackjack(svc: Services) {
  const { overlay, body } = svc.ui.panels.shell('Blackjack', 'Wins pay 1:1 profit · blackjack 3:2 · five-card charlie · hot streak bonus', true);
  let bet = svc.economy.cash >= 50 ? 50 : 10;
  let hands: BjHand[] = [];
  let active = 0;
  let dealer: Card[] = [];
  let phase: 'bet' | 'play' | 'done' = 'bet';

  const top = el('div', 'casino-top');
  const ledger = el('div', 'bj-ledger');
  const table = el('div', 'bj-table');
  const dLabel = el('div', 'hand-label');
  const dealerRow = el('div', 'hand');
  const handsWrap = el('div', 'bj-hands');
  const pot = el('div', 'bj-pot');
  table.append(dLabel, dealerRow, pot, handsWrap);
  const result = el('div', 'bj-result');
  const actions = el('div', 'btn-row');
  const betLabel = el('div', 'eyebrow', 'Bet');
  const bets = betRow(svc, () => bet, (n) => (bet = n), () => render());
  const rules = el(
    'p',
    'bj-rules muted',
    'Win → stake back <b>+ equal profit</b> · Blackjack → <b>+1.5×</b> · 5 cards ≤ 21 → auto win · Push → stake back · Hot streak: <b>+10% profit</b> per win in a row (max +50%)',
  );
  const draw = () => {
    if (bjShoe.length < 20) bjShoe = shoe(6);
    return bjShoe.pop()!;
  };
  const onTable = () => hands.reduce((a, h) => a + h.stake, 0);
  const streakBonus = () => Math.min(0.5, bjSession.streak * 0.1);

  const chips = (amount: number) => {
    // A little chip stack sized by the amount on the table.
    const n = Math.max(1, Math.min(10, Math.round(Math.log2(amount / 5 + 1) * 1.6)));
    let html = '';
    for (let i = 0; i < n; i++) html += `<i style="bottom:${i * 4}px"></i>`;
    return `<span class="bj-chips">${html}</span>`;
  };

  const render = () => {
    const stake = phase === 'play' ? onTable() : 0;
    top.innerHTML = cashLine(svc) + (stake ? ` <span class="muted">· on the table</span> <strong>${money(stake)}</strong>` : '');
    ledger.innerHTML =
      `<span>Hands <b>${bjSession.hands}</b></span><span>Won <b>${bjSession.won}</b></span>` +
      `<span>Session <b class="${bjSession.net > 0 ? 'up' : bjSession.net < 0 ? 'down' : ''}">${bjSession.net >= 0 ? '+' : '−'}${money(Math.abs(bjSession.net))}</b></span>` +
      `<span class="${bjSession.streak ? 'hot' : ''}">Streak <b>${bjSession.streak}${bjSession.streak ? ` · +${Math.round(streakBonus() * 100)}%` : ''}</b></span>`;
    const hideHole = phase === 'play';
    dealerRow.innerHTML = '';
    dealer.forEach((c, i) => dealerRow.appendChild(cardEl(i === 1 && hideHole ? null : c, i * 120)));
    const dv = handValue(hideHole ? dealer.slice(0, 1) : dealer);
    dLabel.textContent = dealer.length ? `Dealer · ${dv.total}${hideHole ? ' + ?' : ''}` : 'Dealer';
    pot.innerHTML = stake ? `${chips(stake)}<span>${money(stake)}</span>` : '';
    handsWrap.innerHTML = '';
    hands.forEach((h, i) => {
      const box = el('div', `bj-hand${phase === 'play' && i === active && hands.length > 1 ? ' active' : ''}`);
      const v = handValue(h.cards);
      box.appendChild(el('div', 'hand-label', `${hands.length > 1 ? `Hand ${i + 1}` : 'You'} · ${v.total}${v.soft && v.total < 21 ? ' (soft)' : ''}${h.doubled ? ' · doubled' : ''}`));
      const row = el('div', 'hand');
      h.cards.forEach((c, j) => row.appendChild(cardEl(c, j * 120)));
      box.appendChild(row);
      handsWrap.appendChild(box);
    });
    if (!hands.length) handsWrap.appendChild(el('div', 'hand-label', 'You'));

    actions.innerHTML = '';
    const btn = (label: string, fn: () => void, primary = false, disabled = false) => {
      const b = el('button', `btn${primary ? ' primary' : ''}`, label) as HTMLButtonElement;
      b.disabled = disabled;
      b.onclick = fn;
      actions.appendChild(b);
    };
    betLabel.hidden = bets.hidden = phase === 'play';
    if (phase === 'play') {
      const h = hands[active];
      const two = h.cards.length === 2;
      btn('Hit', hit, true);
      btn('Stand', stand);
      btn(`Double (+${money(h.stake)})`, double, false, !two || svc.economy.cash < h.stake);
      const canSplit = two && hands.length === 1 && cardValue(h.cards[0]) === cardValue(h.cards[1]);
      if (canSplit) btn(`Split (+${money(h.stake)})`, split, false, svc.economy.cash < h.stake);
    } else {
      btn(phase === 'done' ? `Deal again · ${money(bet)}` : `Deal · ${money(bet)}`, deal, true, svc.economy.cash < bet);
    }
  };

  const showResult = (lines: string[], net: number, paid: number, risked: number) => {
    const cls = net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
    const head = net > 0 ? `+${money(net)} profit` : net < 0 ? `−${money(-net)}` : 'Even · stake back';
    result.className = `bj-result ${cls}`;
    result.innerHTML =
      `<div class="bj-big">${head}</div>` +
      `<div class="bj-lines">${lines.map((l) => `<div>${l}</div>`).join('')}</div>` +
      `<div class="bj-math">Bet ${money(risked)} · paid back ${money(paid)} · cash now <b>${money(svc.economy.cash)}</b></div>`;
    if (net > 0) {
      const f = el('div', 'bj-float', `+${money(net)}`);
      table.appendChild(f);
      setTimeout(() => f.remove(), 1400);
    }
  };

  /** Settle every hand against the dealer and pay out in one go. */
  const settle = (dealerNatural = false) => {
    phase = 'done';
    const live = hands.some((h) => handValue(h.cards).total <= 21);
    if (live && !dealerNatural) while (handValue(dealer).total < 17) dealer.push(draw());
    const dv = handValue(dealer).total;
    const dNat = dealer.length === 2 && dv === 21;
    const bonus = streakBonus();
    let paid = 0;
    let risked = 0;
    const lines: string[] = [];
    hands.forEach((h, i) => {
      const pv = handValue(h.cards).total;
      const tag = hands.length > 1 ? `Hand ${i + 1}: ` : '';
      const natural = !h.fromSplit && h.cards.length === 2 && pv === 21;
      risked += h.stake;
      let profit = 0;
      let back = 0;
      if (pv > 21) {
        lines.push(`${tag}bust with ${pv} · lost ${money(h.stake)}`);
      } else if (natural && !dNat) {
        profit = h.stake * 1.5;
        back = h.stake;
        lines.push(`${tag}<b>Blackjack!</b> pays 3:2`);
      } else if (natural && dNat) {
        back = h.stake;
        lines.push(`${tag}both blackjack · push`);
      } else if (dNat) {
        lines.push(`${tag}dealer blackjack · lost ${money(h.stake)}`);
      } else if (h.cards.length >= 5) {
        profit = h.stake;
        back = h.stake;
        lines.push(`${tag}five-card charlie (${pv}) · automatic win`);
      } else if (dv > 21) {
        profit = h.stake;
        back = h.stake;
        lines.push(`${tag}dealer busts with ${dv} · you win`);
      } else if (pv > dv) {
        profit = h.stake;
        back = h.stake;
        lines.push(`${tag}${pv} beats ${dv} · you win`);
      } else if (pv === dv) {
        back = h.stake;
        lines.push(`${tag}push at ${pv} · stake back`);
      } else {
        lines.push(`${tag}dealer's ${dv} beats ${pv} · lost ${money(h.stake)}`);
      }
      if (profit > 0) {
        if (bonus > 0) {
          const extra = Math.round(profit * bonus);
          lines.push(`${tag}hot streak bonus +${money(extra)}`);
          profit += extra;
        }
      }
      paid += back + profit;
    });
    paid = Math.round(paid);
    if (paid > 0) svc.economy.earn(paid, 'Blackjack payout', false);
    const net = paid - risked;
    bjSession.hands++;
    bjSession.net += net;
    if (net > 0) {
      bjSession.won++;
      bjSession.streak++;
      svc.audio.play('pickup');
    } else if (net < 0) bjSession.streak = 0;
    hands.forEach((h) => (h.done = true));
    render();
    showResult(lines, net, paid, risked);
  };

  const nextHand = () => {
    while (active < hands.length && hands[active].done) active++;
    if (active >= hands.length) settle();
    else render();
  };

  const deal = () => {
    if (!svc.economy.spend(bet, 'Blackjack bet')) return;
    hands = [{ cards: [draw(), draw()], stake: bet, done: false, doubled: false, fromSplit: false }];
    active = 0;
    dealer = [draw(), draw()];
    phase = 'play';
    result.className = 'bj-result';
    result.innerHTML = '';
    svc.audio.play('paper');
    const pv = handValue(hands[0].cards).total;
    const dv = handValue(dealer).total;
    if (pv === 21 || dv === 21) return settle(true);
    render();
  };
  const hit = () => {
    const h = hands[active];
    h.cards.push(draw());
    svc.audio.play('paper');
    const v = handValue(h.cards).total;
    if (v >= 21 || h.cards.length >= 5) h.done = true;
    nextHand();
  };
  const stand = () => {
    hands[active].done = true;
    nextHand();
  };
  const double = () => {
    const h = hands[active];
    if (!svc.economy.spend(h.stake, 'Blackjack double')) return;
    h.stake *= 2;
    h.doubled = true;
    h.cards.push(draw());
    svc.audio.play('paper');
    h.done = true;
    nextHand();
  };
  const split = () => {
    const h = hands[0];
    if (!svc.economy.spend(h.stake, 'Blackjack split')) return;
    const second: BjHand = { cards: [h.cards.pop()!, draw()], stake: h.stake, done: false, doubled: false, fromSplit: true };
    h.cards.push(draw());
    h.fromSplit = true;
    hands.push(second);
    svc.audio.play('paper');
    // Split aces get one card each.
    if (h.cards[0].rank === 14) {
      h.done = true;
      second.done = true;
    }
    for (const x of hands) if (handValue(x.cards).total === 21) x.done = true;
    nextHand();
  };

  body.append(top, ledger, betLabel, bets, table, result, actions, rules);
  render();
  svc.ui.present(overlay, () => {
    // Walking away mid-hand forfeits the stake, like a real table.
    if (phase === 'play' && onTable()) svc.ui.toast(`You left the table and forfeited ${money(onTable())}.`, 'warn');
    else if (bjSession.net !== 0) svc.ui.toast(`Blackjack session: ${bjSession.net > 0 ? '+' : '−'}${money(Math.abs(bjSession.net))}`, bjSession.net > 0 ? 'good' : 'info');
  });
}

const cardValue = (c: Card) => (c.rank >= 11 && c.rank <= 13 ? 10 : c.rank === 14 ? 11 : c.rank);

// ------------------------------------------------------------------ cashier (laundering) & ATM
/**
 * The casino cage: hand over dirty cash for chips, cash the chips out as a "winnings" cheque that
 * clears into your bank an hour later. The house keeps a cut and won't take more than its limit a day.
 */
export function openCashier(svc: Services) {
  const { overlay, body } = svc.ui.panels.shell('Cashier', 'Cash for chips, chips for a cheque · the house keeps 15%', true);
  const front = FRONTS.find((f) => f.id === 'casino')!;
  const eco = svc.economy;
  const top = el('div', 'casino-top');
  const wash = el('div', 'cash-wash');
  const res = el('p', 'result');
  const amounts = el('div', 'chip-row');
  const atm = el('div', 'chip-row');
  const now = () => svc.time.day * 1440 + svc.time.minutes;
  let amount = 500;
  const render = () => {
    const room = eco.washRoom(front, svc.time.day);
    top.innerHTML = `<span class="muted">Cash</span> <strong>${money(eco.cash)}</strong> <span class="muted">· Bank 💳</span> <strong>${money(eco.bank)}</strong> <span class="muted">· the cage takes ${money(room)} more today</span>`;
    amounts.innerHTML = '';
    for (const a of [100, 250, 500, 1000, 2500]) {
      const b = el('button', `chip-btn${a === amount ? ' on' : ''}`, money(a)) as HTMLButtonElement;
      b.disabled = a > eco.cash || a > room;
      b.onclick = () => {
        amount = a;
        render();
      };
      amounts.appendChild(b);
    }
    wash.innerHTML = eco.washing.length
      ? eco.washing.map((w) => `<div>${money(w.amount)} via ${w.via} · clears in ${Math.max(0, Math.ceil(w.ready - now()))} min</div>`).join('')
      : '<div class="muted">Nothing clearing right now.</div>';
    go.textContent = `Launder ${money(amount)} → ${money(Math.round(amount * (1 - front.fee)))} to your bank`;
    go.disabled = amount > eco.cash || amount > room;
    atm.innerHTML = '';
    for (const a of [100, 500, 1000]) {
      const b = el('button', 'chip-btn', `Withdraw ${money(a)}`) as HTMLButtonElement;
      b.disabled = a > eco.bank;
      b.onclick = () => {
        eco.withdraw(a);
        res.className = 'result good';
        res.textContent = `ATM: ${money(a)} out of your bank as cash.`;
        render();
      };
      atm.appendChild(b);
    }
  };
  const go = el('button', 'btn primary') as HTMLButtonElement;
  go.onclick = () => {
    const r = eco.launder(front, amount, now(), svc.time.day);
    res.className = `result ${r.ok ? 'good' : 'bad'}`;
    res.textContent = r.text;
    if (r.ok) svc.audio.play('paper');
    render();
  };
  body.append(
    top,
    el('p', 'muted', 'Your card only spends clean money in the bank. Dirty cash from deals has to be laundered first: buy chips here and cash them out as a winnings cheque. Clean money lands in your bank about an hour later. For bigger amounts and a smaller cut, buy a front business from the Finance app on your phone.'),
    el('div', 'eyebrow', 'Launder'),
    amounts,
    go,
    res,
    el('div', 'eyebrow', 'Clearing'),
    wash,
    el('div', 'eyebrow', 'ATM (bank → cash)'),
    atm,
  );
  render();
  svc.ui.present(overlay);
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
