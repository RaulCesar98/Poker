(() => {
  'use strict';
  const socket = io({ transports: ['websocket', 'polling'] });
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- identidade ----------
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  let token;
  try { token = sessionStorage.getItem('pk_token'); } catch (e) {}
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { sessionStorage.setItem('pk_token', token); } catch (e) {}
  }

  const params = new URLSearchParams(location.search);
  $('#nameInput').value = store.get('pk_name', '');
  $('#roomInput').value = params.get('sala') || '';

  // ---------- elementos ----------
  const tableEl = $('#table');
  const seatsEl = $('#seats');
  const boardEl = $('#board');
  const potEl = $('#pot');
  const deckEl = $('#deck');
  const dealerEl = $('#dealerBtn');
  const seatEls = [], betEls = [];
  const cache = [];

  let S = null;          // estado atual
  let joinedRoom = null;
  let viewSeat = 0;
  let boardShown = 0;
  let boardHand = -1;
  let dealPending = null;
  let turnDeadline = 0;
  let lastTurnKey = '';
  let lastTick = 0;
  let unread = 0;

  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const rankTxt = r => (r === 'T' ? '10' : r);
  const fmt = n => Number(n || 0).toLocaleString('pt-BR');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cardTxt = c => rankTxt(c[0]) + SUIT[c[1]];

  function cardHTML(c, cls = '') {
    if (!c || c === 'XX') return `<div class="card back ${cls}"></div>`;
    const red = c[1] === 'h' || c[1] === 'd';
    return `<div class="card ${red ? 'red' : ''} ${cls}" data-c="${c}"><span class="r">${rankTxt(c[0])}</span><span class="s1">${SUIT[c[1]]}</span><span class="s2">${SUIT[c[1]]}</span></div>`;
  }

  const DENOMS = [
    [5000, '#e67e22'], [1000, '#f1c40f'], [500, '#8e44ad'], [100, '#1d1d1d'],
    [25, '#27ae60'], [5, '#c0392b'], [1, '#3f74c9']
  ];
  function chipsHTML(amount, maxCols = 4, maxPer = 7) {
    const cols = [];
    let rem = amount;
    for (const [v, c] of DENOMS) {
      const n = Math.floor(rem / v);
      if (!n) continue;
      rem -= n * v;
      cols.push([c, Math.min(n, maxPer)]);
    }
    return cols.slice(0, maxCols)
      .map(([c, n]) => `<div class="chip-col">${`<div class="chip" style="--cc:${c}"></div>`.repeat(n)}</div>`).join('');
  }

  // ---------- montagem dos assentos ----------
  for (let i = 0; i < 8; i++) {
    const el = document.createElement('div');
    el.className = 'seat empty';
    el.innerHTML = `
      <div class="seat-cards"></div>
      <div class="pod">
        <div class="avatar"><div class="face"></div><span class="ini"></span></div>
        <div class="info"><div class="name"></div><div class="stack"></div></div>
        <div class="tag"></div>
      </div>
      <div class="hand-name"></div>
      <button class="sit-btn">Sentar</button>
      <div class="empty-mark"></div>`;
    el.querySelector('.sit-btn').onclick = () => { Sound.unlock(); socket.emit('sit', { seat: i }); };
    seatsEl.appendChild(el);
    seatEls.push(el);
    const b = document.createElement('div');
    b.className = 'bet empty';
    b.innerHTML = '<div class="chips"></div><span class="amt"></span>';
    seatsEl.appendChild(b);
    betEls.push(b);
    cache.push({ sig: '', tag: '', bet: 0, hand: -1 });
  }
  boardEl.innerHTML = '<div class="slot"></div>'.repeat(5);

  const portrait = () => matchMedia('(max-aspect-ratio: 4/5)').matches;
  function polar(r, rx, ry, extra = 0) {
    const a = (90 + r * 45) * Math.PI / 180 + extra;
    return { x: 50 + Math.cos(a) * rx, y: 50 + Math.sin(a) * ry };
  }
  const rel = i => (i - viewSeat + 8) % 8;
  function positionAll() {
    const pt = portrait();
    for (let i = 0; i < 8; i++) {
      const r = rel(i);
      const s = polar(r, pt ? 52 : 50, pt ? 50 : 52);
      seatEls[i].style.left = s.x + '%';
      seatEls[i].style.top = s.y + '%';
      const b = polar(r, pt ? 30 : 33, pt ? 31 : 27);
      betEls[i].style.left = b.x + '%';
      betEls[i].style.top = b.y + '%';
    }
    placeDealer();
  }
  function placeDealer() {
    if (!S || S.dealer < 0 || !S.seats[S.dealer]) { dealerEl.hidden = true; return; }
    dealerEl.hidden = false;
    const pt = portrait();
    const d = polar(rel(S.dealer), pt ? 34 : 38, pt ? 38 : 34, 0.38);
    dealerEl.style.left = d.x + '%';
    dealerEl.style.top = d.y + '%';
  }
  window.addEventListener('resize', positionAll);

  // ---------- animações ----------
  function center(el) {
    const t = tableEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - t.left, y: r.top + r.height / 2 - t.top };
  }
  function fly(html, fromEl, toEl, { duration = 450, delay = 0, fade = false, scaleTo = 1, onDone, onStart } = {}) {
    const go = () => {
      if (!fromEl.isConnected || !toEl.isConnected) { onDone && onDone(); return; }
      const a = center(fromEl), b = center(toEl);
      const el = document.createElement('div');
      el.className = 'flyer';
      el.style.left = a.x + 'px';
      el.style.top = a.y + 'px';
      el.innerHTML = `<div class="fi">${html}</div>`;
      tableEl.appendChild(el);
      onStart && onStart();
      const anim = el.animate([
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(${scaleTo})`, opacity: fade ? 0 : 1 }
      ], { duration, easing: 'cubic-bezier(.25,.8,.3,1)', fill: 'forwards' });
      anim.onfinish = () => { el.remove(); onDone && onDone(); };
    };
    delay ? setTimeout(go, delay) : go();
  }

  let bannerTimer = null;
  function banner(html, ms = 3200) {
    const b = $('#banner');
    clearTimeout(bannerTimer);
    b.className = 'banner';
    b.innerHTML = html;
    b.hidden = false;
    bannerTimer = setTimeout(() => {
      b.classList.add('out');
      bannerTimer = setTimeout(() => { b.hidden = true; }, 400);
    }, ms);
  }

  function confetti() {
    const colors = ['#e8c26a', '#e74c3c', '#3498db', '#2ecc71', '#fff', '#9b59b6'];
    const rect = tableEl.getBoundingClientRect();
    for (let i = 0; i < 70; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.background = colors[i % colors.length];
      c.style.left = rect.width / 2 + 'px';
      c.style.top = rect.height / 2 + 'px';
      tableEl.appendChild(c);
      const ang = Math.random() * Math.PI * 2;
      const dist = 120 + Math.random() * rect.width * 0.45;
      const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist * 0.7;
      c.animate([
        { transform: 'translate(0,0) rotate(0)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy + 160}px) rotate(${Math.random() * 900}deg)`, opacity: 0 }
      ], { duration: 1400 + Math.random() * 900, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' }).onfinish = () => c.remove();
    }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.tm);
    toast.tm = setTimeout(() => { t.hidden = true; }, 2600);
  }

  // ---------- histórico / chat ----------
  function addLog(html, cls = '') {
    const ul = $('#logList');
    const li = document.createElement('li');
    li.className = cls;
    li.innerHTML = html;
    ul.appendChild(li);
    while (ul.children.length > 250) ul.firstChild.remove();
    ul.scrollTop = ul.scrollHeight;
  }
  function addChat(name, color, text) {
    const ul = $('#chatList');
    const li = document.createElement('li');
    li.innerHTML = `<b style="color:${esc(color)}">${esc(name)}:</b> ${esc(text)}`;
    ul.appendChild(li);
    while (ul.children.length > 200) ul.firstChild.remove();
    ul.scrollTop = ul.scrollHeight;
    if (!$('#side').classList.contains('open')) { unread++; $('#chatBadge').hidden = false; }
  }
  const nameOf = i => (S && S.seats[i] ? `<b>${esc(S.seats[i].name)}</b>` : 'Jogador');

  // ---------- eventos do servidor ----------
  socket.on('evt', e => {
    switch (e.t) {
      case 'newHand':
        Sound.shuffle();
        dealPending = { handNo: e.handNo };
        $$('.seat.winner').forEach(s => s.classList.remove('winner'));
        addLog(`Mão #${e.handNo}`, 'hand');
        break;
      case 'action': onAction(e); break;
      case 'collect': onCollect(); break;
      case 'board':
        addLog(`${{ flop: 'Flop', turn: 'Turn', river: 'River' }[e.stage]}: ${e.cards.map(cardTxt).join(' ')}`);
        break;
      case 'win': onWin(e); break;
      case 'turn':
        if (S && e.seat === S.mySeat) {
          Sound.turn();
          if (navigator.vibrate) navigator.vibrate(60);
        }
        break;
      case 'sys': addLog(esc(e.msg), 'sys'); break;
    }
  });

  function onAction(e) {
    const label = {
      fold: 'desiste', check: 'passa (check)', call: `paga ${fmt(e.amount)}`,
      raise: `aumenta para ${fmt(e.to)}`, allin: `vai ALL-IN (${fmt(e.to)})`
    }[e.action] || e.action;
    addLog(`${nameOf(e.seat)} ${label}`);
    switch (e.action) {
      case 'fold': {
        Sound.fold();
        if (S && e.seat !== S.mySeat) {
          const cardsEl = seatEls[e.seat].querySelector('.seat-cards');
          if (cardsEl.children.length) {
            fly(cardsEl.innerHTML, cardsEl, deckEl, { duration: 500, fade: true, scaleTo: 0.6 });
            cardsEl.innerHTML = '';
            cache[e.seat].sig = 'folded';
          }
        }
        break;
      }
      case 'check': Sound.check(); break;
      case 'call': Sound.chips(3); break;
      case 'raise': Sound.chips(6); break;
      case 'allin': Sound.allin(); break;
    }
  }

  function onCollect() {
    let any = false;
    betEls.forEach((b, i) => {
      if (b.classList.contains('empty')) return;
      any = true;
      fly(`<div class="chips">${b.querySelector('.chips').innerHTML}</div>`, b, potEl, { duration: 520, delay: i * 30 });
      b.classList.add('empty');
      cache[i].bet = 0;
    });
    if (any) Sound.chips(5, 0.35);
  }

  function onWin(e) {
    const me = S ? S.mySeat : -1;
    const iWon = e.winners.some(w => w.seat === me);
    const wasIn = S && me >= 0 && S.seats[me] && S.seats[me].inHand;
    e.winners.forEach((w, k) => {
      const target = seatEls[w.seat].querySelector('.pod');
      fly(`<div class="chips">${chipsHTML(w.amount, 4, 8)}</div>`, potEl, target, { duration: 750, delay: 250 + k * 300 });
      setTimeout(() => seatEls[w.seat].classList.add('winner'), 900 + k * 300);
      addLog(`🏆 ${esc(w.name)} ganha ${fmt(w.amount)}${w.hand ? ' com ' + w.hand : ''}`);
    });
    potEl.classList.add('empty');
    if (iWon) { Sound.win(); confetti(); }
    else if (wasIn && e.showdown) Sound.lose();
    else Sound.chips(8, 0.3);

    const lines = e.winners.map(w =>
      `<div class="big">${esc(w.name)} ganha ${fmt(w.amount)}</div>` +
      (w.hand ? `<div class="small">${w.hand}</div>` : '')).join('');
    const head = e.winners.length > 1 ? '<div class="small">Pote dividido</div>' : '';
    setTimeout(() => banner(head + lines, e.showdown ? 4200 : 2400), e.showdown ? 300 : 100);
  }

  socket.on('state', st => {
    const prev = S;
    S = st;
    turnDeadline = performance.now() + st.turnRemaining;
    render(prev);
  });
  socket.on('toast', toast);
  socket.on('chat', m => { addChat(m.name, m.color, m.text); Sound.chat(); });
  socket.on('kicked', msg => { toast(msg); joinedRoom = null; showLobby(); });
  socket.on('connect', () => { if (joinedRoom) doJoin(joinedRoom, true); });
  socket.on('disconnect', () => { if (joinedRoom) toast('Conexão perdida. Reconectando...'); });

  // ---------- renderização ----------
  const TAGS = { Fold: 'fold', Check: 'check', Call: 'call', Raise: 'raise', Bet: 'bet', 'All-in': 'allin', SB: '', BB: '' };
  const BETTING = ['preflop', 'flop', 'turn', 'river'];

  function render(prev) {
    const newView = S.mySeat >= 0 ? S.mySeat : 0;
    if (newView !== viewSeat || !prev) { viewSeat = newView; positionAll(); }

    $('#roomName').textContent = S.id;
    $('#blindsInfo').textContent = `Blinds ${fmt(S.smallBlind)}/${fmt(S.bigBlind)}`;

    const newHand = dealPending && dealPending.handNo === S.handNo;
    const toDeal = [];

    S.seats.forEach((p, i) => {
      const el = seatEls[i];
      const c = cache[i];
      el.classList.toggle('empty', !p);
      el.classList.toggle('can-sit', !p && S.mySeat < 0);
      el.classList.toggle('me', i === S.mySeat);
      if (!p) {
        c.sig = ''; c.tag = '';
        el.querySelector('.seat-cards').innerHTML = '';
        el.classList.remove('turn', 'folded', 'winner', 'offline', 'out');
        setBet(i, 0, prev);
        return;
      }
      el.classList.toggle('turn', S.turn === i);
      el.classList.toggle('folded', p.folded);
      el.classList.toggle('offline', !p.connected);
      el.classList.toggle('out', !p.inHand && S.stage !== 'waiting');
      el.querySelector('.face').style.setProperty('--c', p.color);
      el.querySelector('.ini').textContent = p.name.slice(0, 2).toUpperCase();
      el.querySelector('.name').textContent = p.name;
      el.querySelector('.stack').textContent = p.sitOut ? 'Ausente' : (p.chips === 0 && p.allIn ? 'ALL-IN' : fmt(p.chips));

      // etiqueta da última ação
      const tagEl = el.querySelector('.tag');
      if (c.tag !== p.lastAction) {
        c.tag = p.lastAction;
        tagEl.textContent = p.lastAction;
        tagEl.className = 'tag ' + (TAGS[p.lastAction] || '');
        if (p.lastAction) { void tagEl.offsetWidth; tagEl.classList.add('pop'); }
      }

      // cartas
      const cardsEl = el.querySelector('.seat-cards');
      const sig = S.handNo + ':' + p.cards.join(',');
      if (sig !== c.sig && !(c.sig === 'folded' && p.folded)) {
        const wasHidden = c.sig.startsWith(S.handNo + ':XX');
        const dealing = newHand && p.cards.length && c.hand !== S.handNo;
        cardsEl.innerHTML = p.cards.map(cd => cardHTML(cd, dealing ? 'pending' : (wasHidden && cd !== 'XX' ? 'reveal' : ''))).join('');
        if (dealing) toDeal.push(i);
        c.sig = sig;
        if (p.cards.length) c.hand = S.handNo;
      }

      // nome da mão
      const hn = el.querySelector('.hand-name');
      hn.textContent = p.hand && (i !== S.mySeat || S.stage === 'showdown') ? p.hand : '';

      setBet(i, p.bet, prev);
    });

    if (toDeal.length) runDeal(toDeal);
    if (newHand) dealPending = null;

    placeDealer();
    renderBoard();
    renderPot();
    renderStatus();
    highlightBest();
    renderControls(prev);
  }

  function setBet(i, amount, prev) {
    const b = betEls[i];
    const c = cache[i];
    if (amount === c.bet) return;
    const prevAmt = c.bet;
    c.bet = amount;
    if (!amount) { b.classList.add('empty'); return; }
    b.querySelector('.chips').innerHTML = chipsHTML(amount);
    b.querySelector('.amt').textContent = fmt(amount);
    const wasEmpty = b.classList.contains('empty');
    if (amount > prevAmt && prev) {
      // ficha voando do jogador até a aposta
      b.style.visibility = wasEmpty ? 'hidden' : '';
      fly(`<div class="chips">${chipsHTML(amount - prevAmt, 2, 4)}</div>`, seatEls[i].querySelector('.pod'), b, {
        duration: 380,
        onDone: () => { b.style.visibility = ''; b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
      });
    }
    b.classList.remove('empty');
  }

  function runDeal(seats) {
    // ordem: à esquerda do dealer, duas voltas
    const order = seats.slice().sort((a, b) => ((a - S.dealer + 7) % 8) - ((b - S.dealer + 7) % 8));
    let k = 0;
    for (let r = 0; r < 2; r++) {
      for (const i of order) {
        const cardEl = seatEls[i].querySelectorAll('.seat-cards .card')[r];
        if (!cardEl) continue;
        const delay = 450 + k * 140;
        k++;
        fly(cardHTML('XX'), deckEl, cardEl, {
          duration: 380, delay,
          onStart: () => Sound.card(),
          onDone: () => {
            cardEl.classList.remove('pending');
            if (!cardEl.classList.contains('back')) {
              cardEl.classList.add('reveal');
              cardEl.addEventListener('animationend', () => cardEl.classList.remove('reveal'), { once: true });
            }
          }
        });
      }
    }
  }

  function renderBoard() {
    if (boardHand !== S.handNo || S.board.length < boardShown) {
      boardEl.innerHTML = '<div class="slot"></div>'.repeat(5);
      boardShown = 0;
      boardHand = S.handNo;
    }
    const slots = boardEl.children;
    for (let k = boardShown; k < S.board.length; k++) {
      const n = k - boardShown;
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHTML(S.board[k], 'flip-in');
      const cardEl = tmp.firstChild;
      cardEl.style.animationDelay = (n * 0.2) + 's';
      cardEl.addEventListener('animationend', () => { cardEl.classList.remove('flip-in'); cardEl.style.animationDelay = ''; }, { once: true });
      boardEl.replaceChild(cardEl, slots[k]);
      Sound.flip(n * 0.2 + 0.1);
    }
    boardShown = S.board.length;
  }

  function renderPot() {
    const total = S.totalPot;
    if (!total || S.stage === 'waiting' || (S.result && S.stage === 'showdown')) {
      potEl.classList.add('empty');
      return;
    }
    potEl.classList.remove('empty');
    const sig = S.pot;
    if (potEl.dataset.sig !== String(sig)) {
      potEl.dataset.sig = sig;
      $('.chips', potEl).innerHTML = S.pot ? chipsHTML(S.pot, 5, 8) : '';
    }
    $('.pot-amt', potEl).textContent = 'Pote: ' + fmt(total);
  }

  function renderStatus() {
    const st = $('#status');
    const seated = S.seats.filter(Boolean).length;
    if (S.stage === 'waiting') {
      st.textContent = seated < 2 ? 'Aguardando jogadores… (mínimo 2)' : 'Nova mão começando…';
    } else if (S.stage === 'showdown') {
      st.textContent = '';
    } else {
      st.textContent = `Mão #${S.handNo}`;
    }
  }

  function highlightBest() {
    const all = $$('#table .card:not(.back)');
    all.forEach(c => c.classList.remove('best', 'dim'));
    if (!S.result || !S.result.showdown || S.stage !== 'showdown') return;
    const best = new Set();
    S.result.winners.forEach(w => (w.best || []).forEach(c => best.add(c)));
    if (!best.size) return;
    const winnerSeats = new Set(S.result.winners.map(w => w.seat));
    $$('.card', boardEl).forEach(c => c.classList.toggle(best.has(c.dataset.c) ? 'best' : 'dim', true));
    seatEls.forEach((el, i) => {
      if (!winnerSeats.has(i)) return;
      $$('.seat-cards .card', el).forEach(c => { if (best.has(c.dataset.c)) c.classList.add('best'); });
    });
  }

  // ---------- controles ----------
  const range = $('#raiseRange'), rInput = $('#raiseInput');
  function renderControls(prev) {
    const me = S.mySeat >= 0 ? S.seats[S.mySeat] : null;
    const info = $('#myInfo');
    if (!me) {
      info.innerHTML = S.seats.some(p => !p) ? 'Você está assistindo. Clique em <b>Sentar</b> num lugar vazio.' : 'Mesa cheia — você está assistindo.';
    } else {
      info.innerHTML = `Suas fichas: <b>${fmt(me.chips)}</b>` + (me.hand && !me.folded ? ` · <span class="hn">${me.hand}</span>` : '');
    }

    const myTurn = me && S.turn === S.mySeat && S.me && BETTING.includes(S.stage);
    $('#actions').hidden = !myTurn;
    if (myTurn) {
      const m = S.me;
      const callBtn = $('#callBtn');
      if (m.toCall === 0) callBtn.innerHTML = 'Check <kbd>C</kbd>';
      else if (m.toCall >= me.chips) callBtn.innerHTML = `All-in ${fmt(m.toCall)} <kbd>C</kbd>`;
      else callBtn.innerHTML = `Pagar ${fmt(m.toCall)} <kbd>C</kbd>`;
      $('#foldBtn').hidden = false;

      $('#raiseBox').hidden = !m.canRaise;
      $('#raiseBtn').hidden = !m.canRaise;
      const key = S.handNo + ':' + S.stage + ':' + S.currentBet;
      if (key !== lastTurnKey) {
        lastTurnKey = key;
        range.min = m.minRaiseTo; range.max = m.maxRaiseTo; range.step = 1;
        setRaise(m.minRaiseTo);
      }
    }

    $('#rebuyBtn').hidden = !(me && me.chips === 0 && !(me.inHand && BETTING.includes(S.stage)));
    $('#sitoutBtn').hidden = !me;
    if (me) $('#sitoutBtn').textContent = me.sitOut ? 'Voltar ao jogo' : 'Ausentar';
  }

  function setRaise(v) {
    if (!S || !S.me) return;
    const m = S.me;
    v = Math.round(Number(v) || 0);
    v = Math.max(m.minRaiseTo, Math.min(m.maxRaiseTo, v));
    range.value = v;
    rInput.value = v;
    const allin = v >= m.maxRaiseTo;
    const verb = S.currentBet === 0 ? 'Apostar' : 'Aumentar p/';
    $('#raiseBtn').innerHTML = allin ? `ALL-IN ${fmt(v)} <kbd>R</kbd>` : `${verb} ${fmt(v)} <kbd>R</kbd>`;
  }
  range.addEventListener('input', () => setRaise(range.value));
  rInput.addEventListener('change', () => setRaise(rInput.value));
  $$('.step').forEach(b => b.onclick = () => setRaise(Number(range.value) + Number(b.dataset.s) * S.bigBlind));
  $$('.presets button').forEach(b => b.onclick = () => {
    const m = S.me;
    const potAfterCall = S.totalPot + m.toCall;
    const v = {
      min: m.minRaiseTo,
      half: S.currentBet + Math.round(potAfterCall / 2),
      pot: S.currentBet + potAfterCall,
      max: m.maxRaiseTo
    }[b.dataset.p];
    setRaise(v);
  });

  function act(action, amount) {
    Sound.unlock();
    socket.emit('action', { action, amount });
    $('#actions').hidden = true;
  }
  $('#foldBtn').onclick = () => act('fold');
  $('#callBtn').onclick = () => act(S.me && S.me.toCall > 0 ? 'call' : 'check');
  $('#raiseBtn').onclick = () => {
    const v = Number(rInput.value);
    act(v >= S.me.maxRaiseTo ? 'allin' : 'raise', v);
  };
  document.addEventListener('keydown', e => {
    if ($('#actions').hidden || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'f') $('#foldBtn').click();
    else if (k === 'c') $('#callBtn').click();
    else if (k === 'r' && !$('#raiseBtn').hidden) $('#raiseBtn').click();
  });

  $('#rebuyBtn').onclick = () => socket.emit('rebuy');
  $('#sitoutBtn').onclick = () => socket.emit('sitout');

  // relógio da vez
  function loop() {
    requestAnimationFrame(loop);
    if (!S) return;
    for (let i = 0; i < 8; i++) {
      const av = seatEls[i].querySelector('.avatar');
      if (S.turn !== i) { if (av.style.getPropertyValue('--p') !== '0') av.style.setProperty('--p', '0'); continue; }
      const rem = Math.max(0, turnDeadline - performance.now());
      const p = rem / S.turnTime;
      av.style.setProperty('--p', p.toFixed(4));
      av.style.setProperty('--tc', p > 0.5 ? '#e8c26a' : p > 0.25 ? '#f39c12' : '#e74c3c');
      if (i === S.mySeat && rem < 5000 && rem > 0) {
        const sec = Math.ceil(rem / 1000);
        if (sec !== lastTick) { lastTick = sec; Sound.tick(); }
      }
    }
  }
  requestAnimationFrame(loop);

  // ---------- lobby ----------
  function showLobby() {
    $('#game').hidden = true;
    $('#lobby').hidden = false;
    refreshRooms();
  }
  function showGame() {
    $('#lobby').hidden = true;
    $('#game').hidden = false;
    $('#soundBtn').textContent = Sound.isMuted() ? '🔇' : '🔊';
    requestAnimationFrame(positionAll);
  }

  function doJoin(room, silent) {
    const name = ($('#nameInput').value || '').trim() || 'Jogador';
    const opts = {
      smallBlind: Number($('#sbInput').value),
      bigBlind: Number($('#bbInput').value),
      startStack: Number($('#stackInput').value),
      turnTime: Number($('#timeInput').value)
    };
    socket.emit('join', { room, name, token, opts }, res => {
      if (!res || !res.ok) { toast('Não foi possível entrar'); return; }
      joinedRoom = res.room;
      history.replaceState(null, '', '?sala=' + encodeURIComponent(res.room));
      if (!silent) {
        $('#logList').innerHTML = '';
        addLog(`Você entrou na sala <b>${esc(res.room)}</b>`, 'sys');
        if (res.seat < 0) toast('Mesa cheia — você está assistindo');
      }
      showGame();
    });
  }

  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    Sound.unlock();
    const name = $('#nameInput').value.trim();
    if (!name) return;
    store.set('pk_name', name);
    doJoin(($('#roomInput').value || 'principal').trim());
  });

  function refreshRooms() {
    if ($('#lobby').hidden) return;
    socket.emit('rooms', list => {
      const ul = $('#roomList');
      if (!list || !list.length) { ul.innerHTML = '<li class="muted">Nenhuma sala aberta. Crie a sua!</li>'; return; }
      ul.innerHTML = list.map(r => `
        <li class="room" data-id="${esc(r.id)}">
          <span><span class="dot ${r.playing ? 'on' : ''}"></span><b>${esc(r.id)}</b></span>
          <span class="muted">${r.players}/8 · ${fmt(r.smallBlind)}/${fmt(r.bigBlind)}</span>
        </li>`).join('');
      $$('.room', ul).forEach(li => li.onclick = () => { $('#roomInput').value = li.dataset.id; $('#nameInput').focus(); });
    });
  }
  setInterval(refreshRooms, 4000);
  socket.on('connect', refreshRooms);

  // ---------- topo / painel ----------
  $('#copyBtn').onclick = async () => {
    const url = location.origin + '/?sala=' + encodeURIComponent(joinedRoom || 'principal');
    try { await navigator.clipboard.writeText(url); toast('Link copiado! Envie para seus amigos.'); }
    catch (e) { prompt('Copie o link:', url); }
  };
  $('#soundBtn').onclick = () => { $('#soundBtn').textContent = Sound.toggle() ? '🔇' : '🔊'; };
  $('#leaveBtn').onclick = () => {
    socket.emit('leave');
    joinedRoom = null;
    S = null;
    cache.forEach(c => { c.sig = ''; c.tag = ''; c.bet = 0; c.hand = -1; });
    history.replaceState(null, '', '/');
    showLobby();
  };
  const side = $('#side');
  $('#sideBtn').onclick = () => {
    side.classList.toggle('open');
    if (side.classList.contains('open')) { unread = 0; $('#chatBadge').hidden = true; }
  };
  $('#closeSide').onclick = () => side.classList.remove('open');
  $$('.tab').forEach(t => t.onclick = () => {
    $$('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('#chatList').hidden = t.dataset.tab !== 'chat';
    $('#logList').hidden = t.dataset.tab !== 'log';
    $('#chatForm').hidden = t.dataset.tab !== 'chat';
  });
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#chatInput').value.trim();
    if (v) socket.emit('chat', v);
    $('#chatInput').value = '';
  });

  // entra direto se veio por link e já tem nome salvo
  if (params.get('sala') && $('#nameInput').value) {
    socket.once('connect', () => doJoin(params.get('sala')));
  }
})();
