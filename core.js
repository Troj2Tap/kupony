/* Wspólna logika: analiza kursów i budowa kuponów (przeglądarka + Node). */
(function (root) {
  const TARGETS = [3, 5, 10, 50];
  const MAX_LEGS = 9;
  const MARKETS = {
    h2h: { label: 'Wynik 1X2' }, double_chance: { label: 'Podwójna szansa' }, draw_no_bet: { label: 'Remis bez zakładu' },
    totals: { label: 'Gole' }, alternate_totals: { label: 'Gole (inne linie)' }, btts: { label: 'Obie strzelą' },
    alternate_totals_corners: { label: 'Rzuty rożne' }, alternate_totals_cards: { label: 'Kartki' }
  };

  function pickText(mk, name, point) {
    if (mk === 'btts') return name === 'Yes' ? 'Tak' : 'Nie';
    if (mk === 'h2h' || mk === 'draw_no_bet') return name === 'Draw' ? 'Remis' : name;
    if (mk === 'double_chance') return name.replace(/ or /g, ' lub ').replace(/\bDraw\b/g, 'Remis');
    return (name === 'Over' ? 'Powyżej ' : 'Poniżej ') + point;
  }

  /* szansa każdego typu = średnia z kursów bukmacherów po usunięciu marży */
  function analyze(events, cfg) {
    cfg = cfg || {};
    const allowed = cfg.markets || Object.keys(MARKETS), minBooks = cfg.minBooks || 2;
    const legs = [];
    for (const e of events) {
      const groups = {};
      for (const b of e.books) for (const m of b.markets) {
        if (!MARKETS[m.key] || !allowed.includes(m.key)) continue;
        const byPt = {};
        m.outcomes.forEach(o => (byPt[o.point == null ? '' : o.point] ||= []).push(o));
        for (const pt in byPt) (groups[m.key + '|' + pt] ||= { mk: m.key, point: pt, books: [] }).books.push({ name: b.name, outs: byPt[pt] });
      }
      for (const g of Object.values(groups)) {
        const full = Math.max(...g.books.map(x => x.outs.length));
        if (full < 2) continue;
        const exp = g.mk === 'double_chance' ? 2 : 1, agg = {};
        for (const b of g.books.filter(x => x.outs.length === full)) {
          const tot = b.outs.reduce((s, o) => s + 1 / o.price, 0);
          for (const o of b.outs) {
            const a = (agg[o.name] ||= { sum: 0, cnt: 0, best: null });
            a.sum += (1 / o.price) / tot * exp; a.cnt++;
            if (!a.best || o.price > a.best.odds) a.best = { odds: o.price, book: b.name };
          }
        }
        for (const name in agg) {
          const a = agg[name], p = a.sum / a.cnt;
          if (a.cnt < Math.min(minBooks, e.books.length)) continue;
          legs.push({ eid: e.id, league: e.league, match: e.home + ' – ' + e.away, time: e.time, mk: g.mk, market: MARKETS[g.mk].label,
            pick: pickText(g.mk, name, g.point), p, odds: a.best.odds, book: a.best.book, edge: p * a.best.odds - 1, books: a.cnt });
        }
      }
    }
    return legs;
  }

  /* kupon o zadanym kursie z maksymalną szansą trafienia, jeden typ na mecz */
  function buildCoupon(legs, target) {
    const byEvent = {};
    legs.filter(l => l.odds >= 1.08 && l.p >= 0.25).forEach(l => (byEvent[l.eid] ||= []).push(l));
    const lo = Math.log(target * 0.93), hi = Math.log(target * 1.12), STEP = 0.015;
    let dp = new Map([[0, { lo: 0, lp: 0, legs: [] }]]);
    for (const cands of Object.values(byEvent)) {
      const next = new Map(dp);
      for (const st of dp.values()) {
        if (st.legs.length >= MAX_LEGS) continue;
        for (const c of cands) {
          const nlo = st.lo + Math.log(c.odds);
          if (nlo > hi) continue;
          const ns = { lo: nlo, lp: st.lp + Math.log(c.p) + 0.05 * Math.max(0, c.edge), legs: [...st.legs, c] };
          const b = Math.round(nlo / STEP), cur = next.get(b);
          if (!cur || ns.lp > cur.lp) next.set(b, ns);
        }
      }
      dp = next;
    }
    const all = [...dp.values()].filter(s => s.legs.length);
    let pool = all.filter(s => s.lo >= lo && s.lo <= hi);
    if (!pool.length) pool = all.sort((a, b) => Math.abs(a.lo - Math.log(target)) - Math.abs(b.lo - Math.log(target))).slice(0, 5);
    pool.sort((a, b) => b.lp - a.lp);
    const s = pool[0];
    if (!s) return null;
    return { target, odds: Math.exp(s.lo), prob: s.legs.reduce((x, l) => x * l.p, 1), legs: s.legs };
  }

  function build(events, cfg) {
    const legs = analyze(events, cfg);
    const coupons = legs.length ? TARGETS.map(t => buildCoupon(legs, t)).filter(Boolean) : [];
    return { legs, coupons };
  }

  const api = { TARGETS, MARKETS, analyze, buildCoupon, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
