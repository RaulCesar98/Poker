// Avaliador de mãos de Texas Hold'em
// Cartas no formato "As", "Td", "9c" (rank + naipe: s h d c)

const RANKS = '23456789TJQKA';
const NAMES = [
  'Carta Alta', 'Par', 'Dois Pares', 'Trinca', 'Sequência',
  'Flush', 'Full House', 'Quadra', 'Straight Flush'
];

const rankVal = c => RANKS.indexOf(c[0]) + 2;

function eval5(cards) {
  const vals = cards.map(rankVal).sort((a, b) => b - a);
  const flush = cards.every(c => c[1] === cards[0][1]);
  const uniq = new Set(vals);
  let straightHigh = 0;
  if (uniq.size === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, c]) => [+v, c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ordered = groups.map(g => g[0]);

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, ...ordered];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...ordered];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, ...ordered];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...ordered];
  if (groups[0][1] === 2) return [1, ...ordered];
  return [0, ...vals];
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Melhor mão de 5 entre 5..7 cartas
function bestHand(cards) {
  let best = null;
  const n = cards.length;
  const pick = [];
  const rec = start => {
    if (pick.length === 5) {
      const five = pick.map(i => cards[i]);
      const score = eval5(five);
      if (!best || compare(score, best.score) > 0) best = { score, cards: five };
      return;
    }
    for (let i = start; i <= n - (5 - pick.length); i++) {
      pick.push(i); rec(i + 1); pick.pop();
    }
  };
  rec(0);
  best.name = handName(best.score);
  return best;
}

function handName(score) {
  if (score[0] === 8 && score[1] === 14) return 'Royal Flush';
  return NAMES[score[0]];
}

module.exports = { bestHand, compare, handName, eval5 };
