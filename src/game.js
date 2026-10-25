// Mesa de Texas Hold'em No-Limit (até 8 jogadores)
const crypto = require('crypto');
const { bestHand, compare } = require('./hand');

const MAX_SEATS = 8;
const BETTING = ['preflop', 'flop', 'turn', 'river'];
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ec407a'];

function newDeck() {
  const d = [];
  for (const r of '23456789TJQKA') for (const s of 'shdc') d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function clampInt(v, min, max, def) {
  let n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = def;
  return Math.max(min, Math.min(max, n));
}

class Table {
  constructor(id, opts = {}) {
    this.id = id;
    this.smallBlind = clampInt(opts.smallBlind, 1, 100000, 10);
    this.bigBlind = clampInt(opts.bigBlind, this.smallBlind, 200000, this.smallBlind * 2);
    this.startStack = clampInt(opts.startStack, this.bigBlind * 10, 100000000, Math.max(1000, this.bigBlind * 50));
    this.turnTime = clampInt(opts.turnTime, 10, 120, 25) * 1000;

    this.seats = new Array(MAX_SEATS).fill(null);
    this.viewers = new Map(); // socket.id -> socket
    this.stage = 'waiting';
    this.handNo = 0;
    this.dealer = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.deck = [];
    this.board = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.turn = -1;
    this.turnDeadline = 0;
    this.turnTimer = null;
    this.flowTimer = null;
    this.result = null;
    this.reveal = false;
    this.lastActivity = Date.now();
  }

  // ---------- utilidades ----------
  schedule(fn, ms) {
    clearTimeout(this.flowTimer);
    this.flowTimer = setTimeout(() => { this.flowTimer = null; fn(); }, ms);
  }
  clearTurnTimer() { clearTimeout(this.turnTimer); this.turnTimer = null; }
  nextSeat(from, pred) {
    for (let k = 1; k <= MAX_SEATS; k++) {
      const i = (from + k + MAX_SEATS) % MAX_SEATS;
      if (this.seats[i] && pred(this.seats[i], i)) return i;
    }
    return -1;
  }
  liveSeats() {
    const out = [];
    this.seats.forEach((p, i) => { if (p && p.inHand && !p.folded) out.push(i); });
    return out;
  }
  eligible() {
    const out = [];
    this.seats.forEach((p, i) => {
      if (p && p.chips > 0 && p.connected && !p.sitOut && !p.leaving) out.push(i);
    });
    return out;
  }
  seatOf(socketId) { return this.seats.findIndex(p => p && p.socketId === socketId); }
  playerCount() { return this.seats.filter(Boolean).length; }

  emitEvt(e) { for (const s of this.viewers.values()) s.emit('evt', e); }
  broadcast() {
    this.lastActivity = Date.now();
    for (const s of this.viewers.values()) s.emit('state', this.stateFor(s.id));
  }

  // ---------- entrada/saída ----------
  join(socket, name, token) {
    this.viewers.set(socket.id, socket);
    let idx = this.seats.findIndex(p => p && p.token === token);
    if (idx >= 0) {
      const p = this.seats[idx];
      if (p.socketId !== socket.id) {
        const old = this.viewers.get(p.socketId);
        if (old) { this.viewers.delete(old.id); old.emit('kicked', 'Você entrou em outra aba.'); }
      }
      p.socketId = socket.id;
      p.connected = true;
      p.name = name;
      clearTimeout(p.dcTimer);
      if (this.turn === idx) this.setTurn(idx, true);
    } else {
      idx = this.seats.findIndex(p => !p);
      if (idx >= 0) this.seatPlayer(idx, socket, name, token);
    }
    this.broadcast();
    this.maybeStart();
    return idx;
  }

  sit(socket, seat, name, token) {
    seat = clampInt(seat, 0, MAX_SEATS - 1, 0);
    if (this.seatOf(socket.id) >= 0 || this.seats[seat]) return 'Lugar ocupado';
    this.seatPlayer(seat, socket, name, token);
    this.emitEvt({ t: 'sys', msg: `${name} sentou na mesa` });
    this.broadcast();
    this.maybeStart();
    return null;
  }

  seatPlayer(idx, socket, name, token) {
    this.seats[idx] = {
      token, socketId: socket.id, name,
      chips: this.startStack, bet: 0, total: 0, cards: [],
      folded: false, allIn: false, acted: false, inHand: false,
      connected: true, sitOut: false, leaving: false,
      color: COLORS[idx], lastAction: '', timeouts: 0, rebuys: 0, dcTimer: null
    };
  }

  leave(socket) {
    const idx = this.seatOf(socket.id);
    if (idx >= 0) this.removePlayer(idx);
    this.viewers.delete(socket.id);
    this.broadcast();
  }

  disconnect(socket) {
    this.viewers.delete(socket.id);
    const idx = this.seatOf(socket.id);
    if (idx < 0) return;
    const p = this.seats[idx];
    p.connected = false;
    if (this.turn === idx) this.setTurn(idx, true);
    p.dcTimer = setTimeout(() => {
      if (this.seats[idx] === p && !p.connected) { this.removePlayer(idx); this.broadcast(); }
    }, 60000);
    this.broadcast();
  }

  removePlayer(idx) {
    const p = this.seats[idx];
    if (!p) return;
    clearTimeout(p.dcTimer);
    if (BETTING.includes(this.stage) && p.inHand && !p.folded) {
      if (this.turn === idx) {
        this.act(idx, 'fold');
      } else {
        p.folded = true;
        p.lastAction = 'Fold';
        this.emitEvt({ t: 'action', seat: idx, action: 'fold' });
        const live = this.liveSeats();
        if (live.length === 1) this.finishByFold(live[0]);
      }
    }
    this.emitEvt({ t: 'sys', msg: `${p.name} saiu da mesa` });
    if (p.inHand && this.stage !== 'waiting') p.leaving = true; // mantém até o fim da mão (contribuições ao pote)
    else this.seats[idx] = null;
  }

  rebuy(socket) {
    const idx = this.seatOf(socket.id);
    if (idx < 0) return 'Você não está sentado';
    const p = this.seats[idx];
    if (p.chips > 0) return 'Você ainda tem fichas';
    if (p.inHand && BETTING.includes(this.stage)) return 'Aguarde o fim da mão';
    p.chips = this.startStack;
    p.rebuys++;
    this.emitEvt({ t: 'sys', msg: `${p.name} recomprou ${this.startStack} fichas` });
    this.broadcast();
    this.maybeStart();
    return null;
  }

  toggleSitOut(socket) {
    const idx = this.seatOf(socket.id);
    if (idx < 0) return;
    const p = this.seats[idx];
    p.sitOut = !p.sitOut;
    p.timeouts = 0;
    this.broadcast();
    this.maybeStart();
  }

  // ---------- fluxo da mão ----------
  maybeStart() {
    if (this.stage === 'waiting' && !this.flowTimer && this.eligible().length >= 2) {
      this.schedule(() => this.startHand(), 2500);
    }
  }

  startHand() {
    this.clearTurnTimer();
    this.seats.forEach((p, i) => { if (p && p.leaving) this.seats[i] = null; });

    const active = this.eligible();
    this.board = [];
    this.pot = 0;
    this.result = null;
    this.reveal = false;
    this.turn = -1;
    this.currentBet = 0;
    for (const p of this.seats) {
      if (!p) continue;
      Object.assign(p, { cards: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, inHand: false, lastAction: '', best: null });
    }
    if (active.length < 2) {
      this.stage = 'waiting';
      this.broadcast();
      return;
    }

    this.handNo++;
    this.deck = newDeck();
    for (const i of active) this.seats[i].inHand = true;
    const inHand = p => p.inHand;

    this.dealer = this.nextSeat(this.dealer, inHand);
    if (active.length === 2) {
      this.sbSeat = this.dealer;
      this.bbSeat = this.nextSeat(this.dealer, inHand);
    } else {
      this.sbSeat = this.nextSeat(this.dealer, inHand);
      this.bbSeat = this.nextSeat(this.sbSeat, inHand);
    }

    this.stage = 'preflop';
    this.emitEvt({ t: 'newHand', handNo: this.handNo, dealer: this.dealer });

    this.put(this.seats[this.sbSeat], this.smallBlind);
    this.seats[this.sbSeat].lastAction = 'SB';
    this.put(this.seats[this.bbSeat], this.bigBlind);
    this.seats[this.bbSeat].lastAction = 'BB';
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    // distribui 2 cartas começando à esquerda do dealer
    const order = [];
    let s = this.dealer;
    for (let k = 0; k < active.length; k++) { s = this.nextSeat(s, inHand); order.push(s); }
    for (let r = 0; r < 2; r++) for (const i of order) this.seats[i].cards.push(this.deck.pop());

    this.broadcast();
    const dealTime = order.length * 2 * 140 + 600;
    this.schedule(() => this.advance(this.bbSeat), dealTime);
  }

  put(p, amt) {
    amt = Math.max(0, Math.min(amt, p.chips));
    p.chips -= amt;
    p.bet += amt;
    p.total += amt;
    if (p.chips === 0) p.allIn = true;
    return amt;
  }

  setTurn(seat, keepIfSame = false) {
    this.clearTurnTimer();
    const p = this.seats[seat];
    const time = p.connected && !p.sitOut ? this.turnTime : 2500;
    if (!(keepIfSame && this.turn === seat && p.connected)) {
      this.turnDeadline = Date.now() + time;
    }
    const isNew = this.turn !== seat;
    this.turn = seat;
    const ms = Math.max(0, this.turnDeadline - Date.now());
    this.turnTimer = setTimeout(() => {
      if (this.turn !== seat || !this.seats[seat]) return;
      const pl = this.seats[seat];
      if (pl.connected) {
        pl.timeouts++;
        if (pl.timeouts >= 3) { pl.sitOut = true; this.emitEvt({ t: 'sys', msg: `${pl.name} está ausente` }); }
      }
      const toCall = this.currentBet - pl.bet;
      this.act(seat, toCall > 0 ? 'fold' : 'check', 0, true);
    }, ms);
    if (isNew) this.emitEvt({ t: 'turn', seat });
  }

  actBySocket(socketId, action, amount) {
    const idx = this.seatOf(socketId);
    if (idx < 0) return 'Você não está sentado';
    return this.act(idx, action, amount);
  }

  act(seat, action, amount, auto = false) {
    if (!BETTING.includes(this.stage) || seat !== this.turn) return 'Não é sua vez';
    const p = this.seats[seat];
    if (!p || p.folded || p.allIn) return 'Ação inválida';
    if (!auto) p.timeouts = 0;
    const toCall = this.currentBet - p.bet;
    let evAmount = 0;

    if (action === 'call' && toCall <= 0) action = 'check';
    if (action === 'raise') {
      const to = Math.floor(Number(amount));
      if (!Number.isFinite(to) || to <= 0) return 'Valor inválido';
      if (to >= p.bet + p.chips) action = 'allin';
      else if (toCall >= p.chips) return 'Você só pode pagar ou ir all-in';
      else if (to < this.currentBet + this.minRaise) return `Aumento mínimo: ${this.currentBet + this.minRaise}`;
      else amount = to;
    }

    switch (action) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        break;
      case 'check':
        if (toCall > 0) return 'Não é possível dar check';
        p.lastAction = 'Check';
        break;
      case 'call':
        evAmount = this.put(p, toCall);
        p.lastAction = p.allIn ? 'All-in' : 'Call';
        if (p.allIn) action = 'allin';
        break;
      case 'raise': {
        const wasBet = this.currentBet === 0;
        this.minRaise = amount - this.currentBet;
        this.currentBet = amount;
        evAmount = this.put(p, amount - p.bet);
        this.reopen(seat);
        p.lastAction = wasBet ? 'Bet' : 'Raise';
        break;
      }
      case 'allin': {
        const to = p.bet + p.chips;
        if (to > this.currentBet) {
          const inc = to - this.currentBet;
          if (inc >= this.minRaise) { this.minRaise = inc; this.reopen(seat); }
          this.currentBet = to;
        }
        evAmount = this.put(p, p.chips);
        p.lastAction = 'All-in';
        break;
      }
      default:
        return 'Ação desconhecida';
    }

    p.acted = true;
    this.clearTurnTimer();
    this.emitEvt({ t: 'action', seat, action, amount: evAmount, to: p.bet });
    this.advance(seat);
    return null;
  }

  reopen(seat) {
    this.seats.forEach((q, i) => { if (q && i !== seat && q.inHand && !q.folded && !q.allIn) q.acted = false; });
  }

  advance(from) {
    if (!BETTING.includes(this.stage)) return;
    const live = this.liveSeats();
    if (live.length === 1) return this.finishByFold(live[0]);
    const canAct = live.filter(i => !this.seats[i].allIn);
    const needs = p => p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet);
    const pending = canAct.filter(i => needs(this.seats[i]));
    let done = pending.length === 0;
    if (!done && canAct.length === 1 && this.seats[canAct[0]].bet >= this.currentBet) done = true;

    if (!done) {
      this.setTurn(this.nextSeat(from, needs));
      this.broadcast();
      return;
    }
    this.endRound(canAct.length);
  }

  collectBets() {
    let sum = 0;
    for (const p of this.seats) {
      if (!p) continue;
      sum += p.bet;
      p.bet = 0;
      p.acted = false;
    }
    this.pot += sum;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    if (sum > 0) this.emitEvt({ t: 'collect' });
    return sum > 0;
  }

  endRound(canActCount) {
    this.clearTurnTimer();
    this.turn = -1;
    const hadBets = this.collectBets();
    const wait = hadBets ? 750 : 300;
    if (this.stage === 'river') {
      this.broadcast();
      this.schedule(() => this.showdown(), wait);
    } else if (canActCount <= 1) {
      // todos all-in: mostra as cartas e corre o board
      this.reveal = true;
      this.emitEvt({ t: 'reveal' });
      this.broadcast();
      this.schedule(() => this.runout(), wait + 900);
    } else {
      this.broadcast();
      this.schedule(() => {
        this.dealStreet();
        this.broadcast();
        this.schedule(() => this.advance(this.dealer), 700);
      }, wait);
    }
  }

  dealStreet() {
    const next = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.stage];
    if (!next) return;
    this.stage = next;
    this.deck.pop(); // burn
    const n = next === 'flop' ? 3 : 1;
    const cards = [];
    for (let i = 0; i < n; i++) cards.push(this.deck.pop());
    this.board.push(...cards);
    for (const p of this.seats) if (p && p.inHand && !p.folded && !p.allIn) p.lastAction = '';
    this.emitEvt({ t: 'board', stage: next, cards });
  }

  runout() {
    if (this.stage === 'river') return this.showdown();
    this.dealStreet();
    this.broadcast();
    this.schedule(() => this.runout(), 1500);
  }

  computePots() {
    const live = this.liveSeats();
    const levels = [...new Set(live.map(i => this.seats[i].total))].filter(v => v > 0).sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      for (const p of this.seats) {
        if (!p || !p.inHand) continue;
        amount += Math.max(0, Math.min(p.total, lvl) - prev);
      }
      const eligible = live.filter(i => this.seats[i].total >= lvl);
      pots.push({ amount, eligible });
      prev = lvl;
    }
    let leftover = 0;
    for (const p of this.seats) if (p && p.inHand) leftover += Math.max(0, p.total - prev);
    if (leftover && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  showdown() {
    this.clearTurnTimer();
    this.turn = -1;
    this.stage = 'showdown';
    const live = this.liveSeats();
    this.reveal = live.length > 1;
    for (const i of live) {
      const p = this.seats[i];
      p.best = bestHand([...p.cards, ...this.board]);
    }
    const pots = this.computePots();
    const won = {};
    pots.forEach((pot, potIdx) => {
      if (!pot.amount || !pot.eligible.length) return;
      let bestScore = null, winners = [];
      for (const i of pot.eligible) {
        const sc = this.seats[i].best.score;
        const c = bestScore ? compare(sc, bestScore) : 1;
        if (c > 0) { bestScore = sc; winners = [i]; }
        else if (c === 0) winners.push(i);
      }
      // ordena a partir da esquerda do dealer (fica com a ficha ímpar)
      winners.sort((a, b) => ((a - this.dealer + 8) % 8) - ((b - this.dealer + 8) % 8));
      const share = Math.floor(pot.amount / winners.length);
      let rem = pot.amount - share * winners.length;
      for (const w of winners) {
        const amt = share + (rem-- > 0 ? 1 : 0);
        won[w] = won[w] || { seat: w, amount: 0, pots: [] };
        won[w].amount += amt;
        won[w].pots.push(potIdx);
      }
    });
    const winners = Object.values(won).map(w => {
      const p = this.seats[w.seat];
      p.chips += w.amount;
      return { seat: w.seat, amount: w.amount, hand: p.best.name, best: p.best.cards, name: p.name };
    });
    this.pot = 0;
    this.result = { winners, showdown: true };
    this.emitEvt({ t: 'win', winners, showdown: true });
    this.broadcast();
    this.schedule(() => this.startHand(), 6500);
  }

  finishByFold(winner) {
    this.clearTurnTimer();
    this.turn = -1;
    this.collectBets();
    this.stage = 'showdown';
    this.broadcast();
    this.schedule(() => {
      const p = this.seats[winner];
      const amount = this.pot;
      p.chips += amount;
      this.pot = 0;
      const winners = [{ seat: winner, amount, hand: null, best: [], name: p.name }];
      this.result = { winners, showdown: false };
      this.emitEvt({ t: 'win', winners, showdown: false });
      this.broadcast();
      this.schedule(() => this.startHand(), 3500);
    }, 750);
  }

  // ---------- estado enviado ao cliente ----------
  stateFor(socketId) {
    const mySeat = this.seatOf(socketId);
    const seats = this.seats.map((p, i) => {
      if (!p) return null;
      let cards = [];
      if (p.inHand && p.cards.length) {
        const show = i === mySeat || (this.reveal && !p.folded);
        cards = show ? p.cards : p.cards.map(() => 'XX');
        if (p.folded && i !== mySeat) cards = [];
      }
      let hand = null;
      if (p.inHand && !p.folded && this.board.length >= 3 && (i === mySeat || this.reveal)) {
        hand = bestHand([...p.cards, ...this.board]).name;
      }
      return {
        name: p.name, chips: p.chips, bet: p.bet, color: p.color,
        folded: p.folded, allIn: p.allIn, inHand: p.inHand,
        connected: p.connected, sitOut: p.sitOut, leaving: p.leaving,
        lastAction: p.lastAction, cards, hand
      };
    });
    const st = {
      id: this.id,
      handNo: this.handNo,
      stage: this.stage,
      board: this.board,
      pot: this.pot,
      totalPot: this.pot + this.seats.reduce((s, p) => s + (p ? p.bet : 0), 0),
      currentBet: this.currentBet,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      startStack: this.startStack,
      dealer: this.dealer,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      turn: this.turn,
      turnRemaining: this.turn >= 0 ? Math.max(0, this.turnDeadline - Date.now()) : 0,
      turnTime: this.turnTime,
      mySeat,
      seats,
      result: this.result
    };
    if (mySeat >= 0) {
      const p = this.seats[mySeat];
      const toCall = Math.max(0, this.currentBet - p.bet);
      st.me = {
        toCall: Math.min(toCall, p.chips),
        canRaise: p.chips > toCall,
        minRaiseTo: Math.min(this.currentBet + this.minRaise, p.bet + p.chips),
        maxRaiseTo: p.bet + p.chips,
        bet: p.bet
      };
    }
    return st;
  }

  destroy() {
    this.clearTurnTimer();
    clearTimeout(this.flowTimer);
    for (const p of this.seats) if (p) clearTimeout(p.dcTimer);
  }
}

module.exports = { Table, MAX_SEATS };
