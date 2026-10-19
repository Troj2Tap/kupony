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
  const first = process.argv[2] || (scheduled ? (now.hour === cfg.runHour ? addDays(now.date, 1) : now.date) : (now.hour >= 12 ? addDays(now.date, 1) : now.date));
  const nDays = Math.max(1, Math.min(7, parseInt(process.env.DAYS, 10) || 1));
  for (let i = 0; i < nDays; i++) {
    const d = addDays(first, i);
    if (process.env.ANALYSIS_ONLY === 'true') {
      const f = path.join(ROOT, 'data', d + '.json');
      if (!fs.existsSync(f)) { console.log('Brak danych dla ' + d + ', pomijam analizy.'); continue; }
      const day = JSON.parse(fs.readFileSync(f, 'utf8'));
      await analyzeMatches(d, day.coupons, day.legs);
    } else await generateDay(d, now, scheduled);
  }
}

/* ---------- analizy meczów (Claude API + wyszukiwanie w sieci) ---------- */
const SYSTEM = `Jesteś doświadczonym, profesjonalnym analitykiem sportowym i strategiem taktycznym. Przeprowadzasz dogłębną, obiektywną analizę nadchodzącego meczu piłkarskiego, popartą danymi.
Podejście: chłodne, analityczne spojrzenie bez emocji kibica i truizmów; nacisk na taktykę, profile zawodników, strukturę gry i statystyki; zrozumienie kontekstu (forma, kontuzje, stawka, presja).
Używaj wyszukiwania w sieci, aby sprawdzić aktualną formę, absencje, przewidywane składy i style gry. Pisz wyłącznie fakty, które potwierdziłeś; niczego nie zmyślaj. Jeśli czegoś nie udało się ustalić (np. składu), napisz to wprost zamiast zgadywać.
Odpowiadasz po polsku. Twoja ostatnia wiadomość ma być WYŁĄCZNIE jednym obiektem JSON, bez żadnego tekstu przed ani po.`;

function analysisPrompt(m, market) {
  return `Przeanalizuj mecz: ${m.match} (${m.league}), początek ${new Date(m.time).toLocaleString('pl-PL', { timeZone: TZ })}.
Rynkowe szanse z kursów bukmacherów (kontekst, nie dowód): ${market || 'brak'}.

Struktura analizy (każde pole: konkretny tekst, 2-5 zdań, bez ogólników):
- "forma": ostatnie 5 meczów obu drużyn i bilans bramkowy/punktowy, kluczowe absencje (kontuzje, zawieszenia) i ich wpływ na strukturę zespołu, stawka meczu i nastawienie psychologiczne.
- "taktyka": dominujące systemy gry i jak na siebie nachodzą, gdzie rozstrzygnie się mecz (kluczowe strefy), budowanie ataku vs pressing rywala, przejście z ataku do obrony.
- "pojedynki": 2-3 kluczowe pojedynki indywidualne oraz zawodnik będący "x-factorem".
- "stale_fragmenty": skuteczność i zagrożenie przy rzutach rożnych i wolnych obu stron; jeśli masz dane o kartkach i faulach, dodaj krótko.
- "scenariusze": scenariusz A (szybka pierwsza bramka) oraz scenariusz B (mecz defensywny i zamknięty).
- "prognoza": prawdopodobny styl i tempo meczu oraz najbardziej prawdopodobne rozstrzygnięcie z krótkim uzasadnieniem punktowym.
- "pewnosc": "wysoka", "srednia" lub "niska" (jak dobre dane udało się znaleźć).
- "uwagi": jedno zdanie o brakach w danych (np. niepotwierdzone składy).
Zwróć jeden obiekt JSON z dokładnie tymi kluczami.`;
}

async function claudeAnalysis(m, market) {
  const messages = [{ role: 'user', content: analysisPrompt(m, market) }];
  for (let turn = 0; turn < 4; turn++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.analysisModel, max_tokens: 8000, output_config: { effort: 'medium' }, system: SYSTEM,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: cfg.analysisMaxSearches }], messages
      }),
      signal: AbortSignal.timeout(300000)
    });
    if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    if (j.stop_reason === 'refusal') throw new Error('model odmówił odpowiedzi');
    if (j.stop_reason === 'pause_turn') { messages.splice(1, 1, { role: 'assistant', content: j.content }); continue; }
    const texts = j.content.filter(b => b.type === 'text').map(b => b.text);
    for (let i = texts.length - 1; i >= 0; i--) {
      const a = texts[i].indexOf('{'), b = texts[i].lastIndexOf('}');
      if (a < 0 || b < a) continue;
      try { const o = JSON.parse(texts[i].slice(a, b + 1)); if (o.prognoza) return o; } catch (e) { /* próbuj poprzedni blok */ }
    }
    throw new Error('brak poprawnego JSON w odpowiedzi (stop_reason: ' + j.stop_reason + ')');
  }
  throw new Error('zbyt wiele przerw pause_turn');
}

function marketSummary(legs, match) {
  const L = (legs || []).filter(l => l.match === match);
  const pick = (market, pt) => L.filter(l => l.market === market && (!pt || l.pick === pt));
  const pct = l => l.pick + ' ' + Math.round(l.p * 100) + '%';
  const parts = [];
  const x12 = pick('Wynik 1X2'); if (x12.length) parts.push('1X2: ' + x12.map(pct).join(', '));
  const g = pick('Gole', 'Powyżej 2.5')[0]; if (g) parts.push('gole powyżej 2.5: ' + Math.round(g.p * 100) + '%');
  const b = pick('Obie strzelą', 'Tak')[0]; if (b) parts.push('obie strzelą: ' + Math.round(b.p * 100) + '%');
  return parts.join('; ');
}

async function analyzeMatches(date, coupons, legs) {
  if (!process.env.ANTHROPIC_API_KEY) { console.log('Brak ANTHROPIC_API_KEY, pomijam analizy meczów.'); return; }
  const dir = path.join(ROOT, 'data', 'analysis'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, date + '.json');
  let store = { date, model: cfg.analysisModel, matches: {} };
  try { if (fs.existsSync(file)) store = Object.assign(store, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* zaczynamy od nowa */ }
  const freq = new Map();
  coupons.forEach(c => c.legs.forEach(l => { const x = freq.get(l.match) || { match: l.match, league: l.league, time: l.time, n: 0 }; x.n++; freq.set(l.match, x); }));
  const todo = [...freq.values()].sort((a, b) => b.n - a.n).slice(0, cfg.analysisMatches)
    .filter(m => process.env.FORCE === 'true' || !store.matches[m.match]);
  console.log(`Analizy ${date}: do zrobienia ${todo.length}`);
  for (let i = 0; i < todo.length; i += cfg.analysisConcurrency) {
    await Promise.all(todo.slice(i, i + cfg.analysisConcurrency).map(async m => {
      try {
        const a = await claudeAnalysis(m, marketSummary(legs, m.match));
        store.matches[m.match] = Object.assign({ league: m.league, time: m.time, generated: new Date().toISOString() }, a);
        console.log('  OK: ' + m.match);
      } catch (e) { console.warn('  Błąd analizy ' + m.match + ': ' + e.message); }
    }));
  }
  store.model = cfg.analysisModel;
  fs.writeFileSync(file, JSON.stringify(store));
}

async function generateDay(date, now, scheduled) {
  const dataDir = path.join(ROOT, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const outFile = path.join(dataDir, date + '.json');
  if (fs.existsSync(outFile) && process.env.FORCE !== 'true') { console.log('Dzień ' + date + ' już wygenerowany, pomijam.'); return; }
  console.log('Generuję kupony na ' + date);

  const from = date === now.date ? new Date() : warsawMidnight(date), to = warsawMidnight(addDays(date, 1));
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
    let list;
    try { list = await api(`/sports/${s.key}/odds`, Object.assign({ regions: 'eu', markets: cfg.bulkMarkets, oddsFormat: 'decimal' }, win)); }
    catch (e) { if (e.status === 401 || e.status === 429) throw e; console.warn('Pomijam ligę ' + s.title + ': ' + e.message); continue; }
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

  if (!events.length) { console.log('Brak meczów z kursami na ' + date + ', nic nie zapisuję.'); return; }
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
  await analyzeMatches(date, out.coupons, out.legs);
}
main().catch(e => { console.error('Błąd:', e.message); process.exit(1); });
