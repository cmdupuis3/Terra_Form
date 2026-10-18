/* core/climate.js -- a small physical climate model for synthetic terrain, and the samples a game classifies.
 *
 * Real frames take their climate from the Köppen raster. A sculpted world (core/sculpt.js) or a collage whose
 * pieces were moved to new latitudes has no real climate, so this derives one from the terrain itself:
 *
 *   temperature  mean annual T by latitude (27 °C at the equator to -25 °C at the pole), -6.5 °C per km of
 *                elevation; the seasonal swing grows with latitude and with distance from the sea
 *                (continentality), giving a warmest and a coldest month.
 *   moisture     advected along the prevailing wind of each latitude band (trade-wind easterlies under 30°,
 *                westerlies from 30° to 60°, polar easterlies beyond): the sea recharges it, land drains it with
 *                distance, and every climb drops rain on the windward slope and leaves a rain shadow behind.
 *                A short isotropic coastal term keeps leeward coasts from going bone dry. The result is scaled
 *                by the latitude band's circulation (ITCZ wet, subtropical highs dry, mid-latitude storm tracks
 *                wet, polar deserts dry).
 *   seasonality  west coasts between 30° and 44° get dry summers (Mediterranean Cs); the 15-35° windward coasts
 *                of easterly flow get dry winters (monsoon w).
 *   Köppen       the standard decision tree on (T, warmest, coldest, annual precipitation, seasonality).
 *
 * A tile's satellite-like colour comes from the mean colour of its Köppen class on the real Earth (measured once
 * from the working rasters), so colour-driven game classifiers (Civ4's moisture biome, forest density) behave
 * as they do on real data. buildSamples assembles the same per-tile sample object sampleRegion produces, so any
 * game module's classify() works on synthetic terrain unchanged.
 *
 * Classic script; reads core/app.js globals at call time.
 */
(function () {
  const T = window.TerraForm;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerpTable = (tab, x) => { if (x <= tab[0][0]) return tab[0][1]; for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) { const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return tab[tab.length - 1][1]; };
  const T_LAT = [[0, 27], [15, 26], [30, 20], [45, 11], [60, 1], [75, -12], [90, -25]];
  /* how far moisture reaches inland, km: rainfall recycled by vegetation keeps equatorial and storm-track interiors wet,
     the subtropical highs dry it out fast */
  const L_BAND = [[0, 3000], [10, 2600], [15, 1500], [20, 900], [30, 900], [40, 1600], [55, 2000], [70, 1200], [90, 800]];
  const P_BAND = [[0, 1.4], [8, 1.3], [14, 0.75], [20, 0.3], [25, 0.22], [30, 0.3], [38, 0.65], [45, 0.95], [55, 1.0], [65, 0.6], [75, 0.35], [90, 0.2]];
  const K = {};   // Köppen key -> class index
  function keys() { if (!K.Af) (T.util.KOPPEN_KEYS || KOPPEN_KEYS).forEach((k, i) => { if (k) K[k] = i; }); return K; }

  /* ---------- the model ---------- */
  /* grid: { W, H, land: Uint8Array, elev: Float32Array (metres above sea, per tile), lat(y) -> degrees, kmPerTile }
     returns { T, warm, cold, P, kc, seasonal } per tile */
  function run(grid, opts) {
    opts = opts || {};
    const { W, H, land, elev } = grid, N = W * H, km = grid.kmPerTile || 50, k = keys();
    // distance to the sea (tiles -> km), 8-neighbour BFS
    const dist = new Float32Array(N).fill(1e9), q = [];
    for (let i = 0; i < N; i++) if (!land[i]) { dist[i] = 0; q.push(i); }
    for (let qi = 0; qi < q.length; qi++) { const c = q[qi], x = c % W, y = (c - x) / W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx, d = dist[c] + (dx && dy ? 1.414 : 1); if (d < dist[n]) { dist[n] = d; q.push(n); } } }
    if (!q.length) for (let i = 0; i < N; i++) dist[i] = 1e3;   // no sea at all: deep interior everywhere
    // directional moisture along each row, following the band's prevailing wind
    const mDir = new Float32Array(N), oro = new Float32Array(N), mar = new Float32Array(N), fromWest = new Uint8Array(H);
    for (let y = 0; y < H; y++) {
      const a = Math.abs(grid.lat(y)), westerly = a >= 30 && a < 65; fromWest[y] = westerly ? 1 : 0;
      const Lkm = lerpTable(L_BAND, a);
      let m = 0.35, prev = 0, fetch = 600;   // the air entering at the upwind map edge is partly charged (the world goes on past it, mostly land or sea unknown)
      for (let s = 0; s < W; s++) {
        const x = westerly ? s : W - 1 - s, i = y * W + x;
        if (!land[i]) { m = Math.min(1, m + 0.18); prev = 0; mDir[i] = m; fetch = 0; continue; }
        fetch += km; mar[i] = Math.exp(-fetch / 700);           // maritime air: how far it has come over land since the last sea
        const e = Math.max(0, elev[i]), up = Math.max(0, e - prev);
        oro[i] = m * Math.min(1, up / 1200);                   // rain wrung out by the climb
        m *= Math.exp(-km / Lkm) * Math.exp(-up / 1100);       // inland drying (the band's penetration length), and the rain shadow behind every rise
        mDir[i] = m; prev = e;
      }
    }
    /* air spreads sideways as it travels: blur the advected moisture across rows (a Gaussian of ~150 km), so a lake or an
       inlet crossed by one row does not draw a one-tile-thick wet streak downwind, and the wind-band switch is soft */
    { const sg = Math.min(H / 4, Math.max(1, 150 / km)), R = Math.ceil(sg * 2.5), wk = []; for (let d = -R; d <= R; d++) wk.push(Math.exp(-d * d / (2 * sg * sg)));
      const m2 = new Float32Array(N); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, ws = 0; for (let d = -R; d <= R; d++) { const yy = y + d; if (yy < 0 || yy >= H) continue; s += mDir[yy * W + x] * wk[d + R]; ws += wk[d + R]; } m2[y * W + x] = s / ws; }
      mDir.set(m2); }
    const Ta = new Float32Array(N), warm = new Float32Array(N), cold = new Float32Array(N), P = new Float32Array(N), kc = new Uint8Array(N), seas = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const lat = grid.lat(y), a = Math.abs(lat);
      for (let x = 0; x < W; x++) {
        const i = y * W + x; if (!land[i]) continue;
        /* the zonal tables are read at a meandering latitude (+-3.5 deg, waves ~10 deg long, measured in degrees so every map
           scale meanders alike), as storm tracks and the subtropical highs wander: climate borders are not lines of latitude */
        const dpt = km / 111.32, sd = grid.seed || 1, aE = Math.max(0, a + 7 * (vnoise(x * dpt / 10 + sd * 2.1, lat / 10 - sd) - 0.5));
        const band = lerpTable(P_BAND, aE), t0 = lerpTable(T_LAT, aE);
        const dkm = dist[i] * km, cont = clamp(dkm / 1500, 0, 1), e = Math.max(0, elev[i]);
        // mid-latitude windward coasts are mild, lee coasts and interiors cold (the ocean's heat carried on the westerlies)
        const wband = fromWest[y] ? clamp((a - 32) / 10, 0, 1) * clamp((70 - a) / 8, 0, 1) : 0;
        const t = t0 + wband * (7 * mar[i] - 2) - 6.5 * e / 1000, amp = (3 + 0.45 * a) * (0.4 + 0.9 * Math.max(cont, wband * (1 - mar[i]) * 0.6));
        Ta[i] = t; warm[i] = t + amp / 2; cold[i] = t - amp / 2;
        const mIso = 0.55 * Math.exp(-dkm / 700), m = Math.max(mDir[i], mIso);
        // weather is patchy: a low-frequency +-25% field (and a little finer grain) keeps the zonal bands from drawing ruler-straight climate borders
        const patch = 1 + 0.5 * (vnoise(x / 7 + sd * 1.3, y / 7 - sd * 0.7) - 0.5) + 0.2 * (vnoise(x / 2.5 - sd, y / 2.5 + sd) - 0.5);
        P[i] = band * (150 + 1900 * m + 2200 * oro[i]) * (opts.wetness || 1) * patch;
        // seasonality: Mediterranean west coasts, monsoon windward coasts
        const westCoast = fromWest[y] && a >= 30 && a <= 44 && cont < 0.45;
        const monsoon = !fromWest[y] && a >= 15 && a <= 35 && mDir[i] > 0.35;
        seas[i] = westCoast ? 1 : monsoon ? 2 : 0;   // 1 dry summer, 2 dry winter
      }
    }
    // a light blur of precipitation so rain shadows have soft edges
    const P2 = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!land[i]) continue; let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (!land[j]) continue; s += P[j] * (dx || dy ? 1 : 2); n += dx || dy ? 1 : 2; } P2[i] = s / n; }
    for (let i = 0; i < N; i++) {
      if (!land[i]) continue;
      const t = Ta[i], tw = warm[i], tc = cold[i], p = P2[i], s = seas[i];
      let c;
      if (tw < 0) c = k.EF; else if (tw < 10) c = k.ET;
      else {
        const pth = 20 * t + (s === 1 ? 0 : s === 2 ? 280 : 140);
        if (p < pth) c = p < pth / 2 ? (t >= 18 ? k.BWh : k.BWk) : (t >= 18 ? k.BSh : k.BSk);
        else if (tc >= 18) c = p >= 2000 ? k.Af : p >= 1500 ? k.Am : k.Aw;
        else if (tc >= -3) { const l2 = s === 1 ? 's' : s === 2 ? 'w' : 'f', l3 = tw >= 22 ? 'a' : tw >= 13 ? 'b' : 'c'; c = k['C' + l2 + l3]; }
        else { const l2 = s === 1 ? 's' : s === 2 ? 'w' : 'f', l3 = tw >= 22 ? 'a' : tw >= 16 ? 'b' : tc > -38 ? 'c' : 'd'; c = k['D' + l2 + l3]; }
      }
      kc[i] = c || k.Cfb;
    }
    return { T: Ta, warm, cold, P: P2, kc, seasonal: seas, distKm: dist.map(d => d * km) };
  }

  /* mean real-Earth satellite colour of each Köppen class (land pixels of the working rasters), measured once */
  let PALETTE = null;
  function palette() {
    if (PALETTE) return PALETTE;
    const s = new Float64Array(31 * 3), n = new Float64Array(31);
    for (let i = 0; i < WSRC * HSRC; i += 3) { if (!landMask[i]) continue; const c = koppenArr[i]; if (!c) continue; s[c * 3] += colorArr[i * 3]; s[c * 3 + 1] += colorArr[i * 3 + 1]; s[c * 3 + 2] += colorArr[i * 3 + 2]; n[c]++; }
    PALETTE = []; for (let c = 0; c < 31; c++) PALETTE.push(n[c] ? [s[c * 3] / n[c], s[c * 3 + 1] / n[c], s[c * 3 + 2] / n[c]] : [120, 120, 100]);
    return PALETTE;
  }

  /* per-tile samples, as sampleRegion makes them, from a synthetic grid:
     g = { W, H, land, elev (metres above sea), relief (0/1/2 per tile), lat(y), kmPerTile, seed }, C = run(...) */
  function buildSamples(g, C) {
    const { W, H, land, elev, relief } = g, N = W * H, pal = palette(), seed = g.seed || 1, KT = T.util.KOPPEN_TEMP || KOPPEN_TEMP, k = keys();
    const S = { W, H, h: new Float32Array(N), rough: new Float32Array(N), reliefHill: new Float32Array(N), reliefPeak: new Float32Array(N), relief: new Uint8Array(N), land: new Uint8Array(N), landFrac: new Float32Array(N), kc: new Uint8Array(N),
      r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N), white: new Float32Array(N), playa: new Float32Array(N), lat: new Float32Array(N), polar: new Float32Array(N), surrArid: new Float32Array(N), surrTemp: new Float32Array(N), moistJit: new Float64Array(N) };
    const HS = T.util.heightMetres ? T.util.heightMetres(0) : -500, HP = T.util.heightMetres ? T.util.heightMetres(1) : 6000;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, L = land[i] ? 1 : 0, kc = L ? C.kc[i] : 0;
      S.land[i] = L; S.landFrac[i] = L; S.lat[i] = g.lat(y); S.kc[i] = kc;
      S.h[i] = clamp((Math.max(L ? 0 : -500, elev[i]) - HS) / (HP - HS), 0, 1);
      S.relief[i] = L ? relief[i] : 0; S.rough[i] = S.relief[i] / 2; S.reliefHill[i] = S.relief[i] >= 1 ? 0.9 : 0.2; S.reliefPeak[i] = S.relief[i] === 2 ? 0.95 : 0.2;
      const base = L ? pal[kc] : [10, 40, 70], j = (vnoise(x / 3 + seed, y / 3 - seed) - 0.5) * 0.16, wet = L ? clamp((C.P[i] - 600) / 3000, -0.15, 0.25) : 0;
      S.r[i] = clamp(base[0] * (1 + j - wet * 0.6), 0, 255); S.g[i] = clamp(base[1] * (1 + j + wet * 0.2), 0, 255); S.b[i] = clamp(base[2] * (1 + j - wet * 0.4), 0, 255);
      S.white[i] = !L ? 0 : kc === k.EF ? 1 : kc === k.ET ? 0.35 : C.cold[i] < -12 && elev[i] > 2500 ? 0.5 : 0;
      S.moistJit[i] = (vnoise(x / 4 + seed * 0.7, y / 4 + seed * 0.3) - 0.5) * 2 * 0.08;
    }
    // polar proximity (~1/e per 8° of latitude from ET/EF tiles) and the surrounding-climate sample (radius 3, as sampleRegion)
    const degPerTile = (g.kmPerTile || 50) / 111.32, d = new Float32Array(N).fill(1e9), q = [];
    for (let i = 0; i < N; i++) if (S.kc[i] === k.ET || S.kc[i] === k.EF) { d[i] = 0; q.push(i); }
    for (let qi = 0; qi < q.length; qi++) { const c = q[qi], x = c % W, y = (c - x) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const n = ny * W + nx; if (d[c] + 1 < d[n]) { d[n] = d[c] + 1; q.push(n); } } }
    for (let i = 0; i < N; i++) S.polar[i] = Math.exp(-d[i] * degPerTile / 8);
    const cg = T.util.classGroup || classGroup;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let bC = 0, tS = 0, n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (!S.land[j] || S.white[j] >= 0.15) continue; if (cg(S.kc[j]) === 2) bC++; tS += KT[S.kc[j]]; n++; }
      const i = y * W + x; S.surrArid[i] = n ? bC / n : 0; S.surrTemp[i] = n ? tS / n : KT[S.kc[i]];
    }
    return S;
  }

  /* absolute relief from metres: a peak is high and steep, a hill moderately so (no per-view percentiles, so
     pieces made separately agree) */
  function reliefOf(W, H, elev, land, range, o) {
    o = o || {}; const hillM = o.hill || 900, peakM = o.peak || 2600, hillR = o.hillRange || 350, peakR = o.peakRange || 600, out = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { if (!land[i]) continue; const e = elev[i], r = range[i]; out[i] = (e >= peakM && r >= peakR) || r >= 2.3 * peakR + 200 ? 2 : (e >= hillM || r >= hillR) ? 1 : 0; }
    return out;
  }

  /* a compact climate summary for the feedback block: Köppen-group shares by latitude band */
  function summary(grid, C) {
    const cg = T.util.classGroup || classGroup, names = ['ice', 'tundra', 'arid', 'tropical', 'temperate', 'continental'], bands = new Map(), tot = [0, 0, 0, 0, 0, 0]; let n = 0;
    for (let y = 0; y < grid.H; y++) {
      const a = Math.abs(grid.lat(y)), b = a < 15 ? '0-15' : a < 30 ? '15-30' : a < 45 ? '30-45' : a < 60 ? '45-60' : '60+';
      let r = bands.get(b); if (!r) bands.set(b, r = [0, 0, 0, 0, 0, 0]);
      for (let x = 0; x < grid.W; x++) { const i = y * grid.W + x; if (!grid.land[i]) continue; const g = cg(C.kc[i]); r[g]++; tot[g]++; n++; }
    }
    const pct = r => { const s = r.reduce((a, b) => a + b, 0); return s ? names.map((nm, g) => [nm, Math.round(r[g] / s * 100)]).filter(e => e[1] > 0).sort((p, q) => q[1] - p[1]).map(e => e[0] + ' ' + e[1] + '%').join(', ') : ''; };
    return { overall: pct(tot), byBand: [...bands.entries()].filter(([, r]) => r.some(v => v)).map(([b, r]) => ({ band: b, mix: pct(r) })), landTiles: n };
  }

  T.climate = { run, buildSamples, reliefOf, palette, summary };
})();
