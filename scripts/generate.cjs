/* Dzienny generator kuponów (Node 18+). Uruchamiany przez GitHub Actions o 23:00 czasu polskiego.
   Użycie: ODDS_API_KEY=... node scripts/generate.cjs [RRRR-MM-DD]   (FORCE=1 nadpisuje istniejący dzień) */
const fs = require('fs');
const path = require('path');
const Core = require('../core.js');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const KEY = process.env.ODDS_API_KEY;
const TZ = 'Europe/Warsaw';
let remaining = null;

function tzParts(date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const o = {}; f.formatToParts(date).forEach(p => o[p.type] = p.value); return o;
}
function nowWarsaw() { const p = tzParts(new Date()); return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour }; }
function addDays(key, n) { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function warsawMidnight(key) {
  const [y, m, d] = key.split('-').map(Number), base = Date.UTC(y, m - 1, d); let guess = base;
  for (let i = 0; i < 2; i++) { const p = tzParts(new Date(guess)); guess = base - (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour) - guess); }
  return new Date(guess);
}
const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function api(p, params) {
  const q = new URLSearchParams(Object.assign({ apiKey: KEY }, params || {}));
  const r = await fetch('https://api.the-odds-api.com/v4' + p + '?' + q);
  const rem = r.headers.get('x-requests-remaining'); if (rem !== null) remaining = rem;
  if (!r.ok) { const e = new Error('API ' + r.status + ' dla ' + p); e.status = r.status; throw e; }
  return r.json();
}

const PRIORITY = [/^soccer_uefa_champs/, /^soccer_uefa/, /^soccer_poland/, /^soccer_(epl|spain_la_liga|germany_bundesliga|italy_serie_a|france_ligue_one)$/, /^soccer_(netherlands|portugal|turkey|belgium|efl|england)/, /^soccer_/];
const prio = k => { const i = PRIORITY.findIndex(r => r.test(k)); return i < 0 ? 99 : i; };

const normalize = (ev, league) => ({
  id: ev.id, league, home: ev.home_team, away: ev.away_team, time: ev.commence_time,
  books: (ev.bookmakers || []).map(b => ({ name: b.title, markets: b.markets.map(m => ({ key: m.key, outcomes: m.outcomes.map(o => ({ name: o.name, price: o.price, point: o.point })) })) }))
});

async function main() {
  if (!KEY) { console.error('Brak zmiennej ODDS_API_KEY.'); process.exit(1); }
  const now = nowWarsaw(), scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  const h2 = (cfg.runHour + 1) % 24;
  if (scheduled && now.hour !== cfg.runHour && now.hour !== h2) { console.log('Nie ta godzina (' + now.hour + '), pomijam.'); return; }
  const date = process.argv[2] || (scheduled ? (now.hour === cfg.runHour ? addDays(now.date, 1) : now.date) : (now.hour >= 12 ? addDays(now.date, 1) : now.date));
  const dataDir = path.join(ROOT, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const outFile = path.join(dataDir, date + '.json');
  if (fs.existsSync(outFile) && !process.env.FORCE) { console.log('Dzień ' + date + ' już wygenerowany, pomijam.'); return; }
  console.log('Generuję kupony na ' + date);

  const from = warsawMidnight(date), to = warsawMidnight(addDays(date, 1));
  const win = { commenceTimeFrom: iso(from), commenceTimeTo: iso(to), dateFormat: 'iso' };
  const sports = (await api('/sports/')).filter(s => s.active && !s.has_outrights && s.key.startsWith('soccer_')).sort((a, b) => prio(a.key) - prio(b.key));

  // ligi z meczami w tym dniu (zapytanie o listę meczów nie kosztuje kredytów)
  const leagues = [];
  for (const s of sports) {
    if (leagues.length >= cfg.maxLeagues) break;
    try { if ((await api(`/sports/${s.key}/events`, win)).length) leagues.push(s); } catch (e) { if (e.status === 401 || e.status === 429) throw e; }
  }
  console.log('Ligi:', leagues.map(l => l.title).join(', ') || 'brak');

  // główne rynki hurtowo: jedno zapytanie na ligę
  let events = [];
  for (const s of leagues) {
    const list = await api(`/sports/${s.key}/odds`, Object.assign({ regions: 'eu', markets: cfg.bulkMarkets, oddsFormat: 'decimal' }, win));
    list.forEach(ev => { const n = normalize(ev, s.title); if (n.books.length) { n.lp = prio(s.key); n.sport = s.key; events.push(n); } });
  }
  events.sort((a, b) => a.lp - b.lp || b.books.length - a.books.length);
  events = events.slice(0, cfg.topMatches);

  // kartki i rożne tylko dla najważniejszych meczów
  for (const ev of events.slice(0, cfg.extraMatches)) {
    try {
      const x = await api(`/sports/${ev.sport}/events/${ev.id}/odds`, { regions: 'eu', markets: cfg.extraMarkets, oddsFormat: 'decimal', dateFormat: 'iso' });
      for (const b of normalize(x, ev.league).books) {
        const mine = ev.books.find(y => y.name === b.name);
        if (mine) mine.markets.push(...b.markets); else ev.books.push(b);
      }
    } catch (e) { console.warn('Brak kartek/rożnych dla ' + ev.home + ' – ' + ev.away + ': ' + e.message); }
  }
  events.forEach(e => { delete e.lp; delete e.sport; });

  const { legs, coupons } = Core.build(events, { minBooks: cfg.minBooks });
  const out = {
    date, generated: new Date().toISOString(), demo: false, events: events.length, remaining,
    coupons: coupons.map(c => Object.assign({}, c, { legs: c.legs.map(l => Object.assign({}, l, { res: null })) })),
    legs: legs.sort((a, b) => b.p - a.p).slice(0, 300)
  };
  fs.writeFileSync(outFile, JSON.stringify(out));
  const files = fs.readdirSync(dataDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
  fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify(files));
  console.log(`Gotowe: ${events.length} meczów, ${coupons.length} kuponów. Pozostałe kredyty API: ${remaining}`);
}
main().catch(e => { console.error('Błąd:', e.message); process.exit(1); });
