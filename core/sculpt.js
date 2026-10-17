/* core/sculpt.js -- the sculpt pathway: original terrain built on a height field, then climatised and classified.
 *
 * The frame pathway reads a real region; the compose pathway rearranges real pieces. Neither can make geography
 * that is not Earth's. The sculpt canvas starts from an ocean floor and builds a height field (metres, 2x2 cells
 * per tile) from:
 *   stamps     small fragments of real elevation (any lon/lat box), placed at any size, rotation and mirror,
 *              feathered into what is there. Each source box may be stamped once (allowRepeat to override), so
 *              no piece of the real world appears twice.
 *   shapes     primitives: blob (a land mass), ridge (a mountain chain along a path), plateau, basin, rift (a
 *              trough with raised shoulders), chain (a hotspot track: high volcanoes at the young end aging into
 *              atolls at the old end), fjords (narrow glacial troughs cut into a coast), noise, smooth.
 *   sea level  set by a target land share, so the gaps between pieces fill with lowland or shelf as needed.
 * realize then derives everything from the heights: land and relief (absolute metres, not per-view percentiles),
 * climate from a physical model (core/climate.js), the game's own classification of the synthetic samples,
 * lakes in closed basins (salt-fringed when arid), and rivers from flow accumulation weighted by rainfall.
 * The result is one snapshot, placed on the compose canvas, so describe, lint, the generators and export apply.
 *
 * Classic script; reads core/app.js / generate.js / climate.js globals at call time.
 */
(function () {
  const T = window.TerraForm;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;
  let SC = null;

  function need() { if (!SC) throw new Error('no sculpt canvas: call sculpt_new first'); return SC; }
  function fbm(x, y, oct, seed) { let s = 0, a = 0.5, f = 1, n = 0; for (let o = 0; o < (oct || 4); o++) { s += a * vnoise(x * f + seed * 17.3 + o * 31.7, y * f - seed * 11.1 + o * 7.9); n += a; a *= 0.5; f *= 2.03; } return s / n; }
  function ridged(x, y, seed) { return 1 - Math.abs(fbm(x, y, 4, seed) * 2 - 1); }
  /* distance from point to a polyline (tile units): {d, t (0..1 along the whole path), nx, ny (unit normal)} */
  function polyDist(path, px, py) {
    let best = { d: Infinity, t: 0, nx: 0, ny: 0 }, acc = 0, total = 0;
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1], [bx, by] = path[i], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      const u = clamp(((px - ax) * dx + (py - ay) * dy) / (L * L), 0, 1), qx = ax + u * dx, qy = ay + u * dy, d = Math.hypot(px - qx, py - qy);
      if (d < best.d) best = { d, t: (acc + u * L) / (total || 1), nx: -dy / L, ny: dx / L };
      acc += L;
    }
    best.len = total; return best;
  }
  function forCells(fn) { const { GW, GH, k } = SC; for (let cy = 0; cy < GH; cy++) for (let cx = 0; cx < GW; cx++) fn(cy * GW + cx, (cx + 0.5) / k, (cy + 0.5) / k); }

  /* ---------- canvas ---------- */
  function sNew(o) {
    const W = o.W | 0 || 120, H = o.H | 0 || 80, k = 2, lat = o.latitudes || { top: 60, bottom: -60 };
    const deg = o.degPerTile || Math.abs(lat.top - lat.bottom) / H;
    SC = { W, H, k, GW: W * k, GH: H * k, h: new Float32Array(W * k * H * k).fill(o.base != null ? +o.base : -3500), base: o.base != null ? +o.base : -3500,
      latTop: +lat.top, latBot: +lat.bottom, degPerTile: deg, kmPerTile: deg * 111.32, sea: 0, seaSet: null, seed: o.seed | 0 || 7, ops: [], sources: new Map(), post: [] };
    return info('new canvas');
  }
  function bilinearH(sx, sy) {
    const x = sx - 0.5, y = clamp(sy - 0.5, 0, HSRC - 1.001), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, X = v => ((v % WSRC) + WSRC) % WSRC;
    const a = heightArr[y0 * WSRC + X(x0)], b = heightArr[y0 * WSRC + X(x0 + 1)], c = heightArr[(y0 + 1) * WSRC + X(x0)], d = heightArr[(y0 + 1) * WSRC + X(x0 + 1)];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  function stamp(o) {
    need(); const src = o.source; if (!src || src.length !== 4) throw new Error('source [W,S,E,N] (lon/lat) required');
    let [w0, s0, e0, n0] = src.map(Number); if (e0 <= w0) e0 += 360; if (!(n0 > s0)) throw new Error('source needs N > S');
    const key = [w0, s0, e0, n0].map(v => v.toFixed(2)).join(',');
    if (SC.sources.has(key) && !o.allowRepeat) throw new Error(`source ${key} was already stamped (op ${SC.sources.get(key)}); every piece of the real world is used once — pick another box, or pass allowRepeat:true`);
    const at = o.at || [SC.W / 2, SC.H / 2], midLat = (s0 + n0) / 2, aspect = (e0 - w0) * Math.cos(midLat * Math.PI / 180) / (n0 - s0);
    let w = +((o.size && o.size[0]) || 20), h = +((o.size && o.size[1]) || w / aspect);
    const rot = (+o.rot || 0) * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot), feather = o.feather != null ? +o.feather : Math.min(w, h) * 0.2;
    const mode = o.mode || 'max', gain = o.gain != null ? +o.gain : 1, off = +o.offset || 0, landOnly = o.landOnly !== false, flip = String(o.flip || '');
    const HM = T.util.heightMetres; let n = 0;
    forCells((i, x, y) => {
      const dx = x - at[0], dy = y - at[1];
      let u = (dx * cr + dy * sr) / w + 0.5, v = (-dx * sr + dy * cr) / h + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) return;
      const a = feather > 0 ? sstep(0, feather, Math.min(Math.min(u, 1 - u) * w, Math.min(v, 1 - v) * h)) : 1; if (a <= 0) return;
      if (flip.includes('x')) u = 1 - u; if (flip.includes('y')) v = 1 - v;
      const lon = w0 + u * (e0 - w0), lat = n0 - v * (n0 - s0), sx = (lon + 180) / 360 * WSRC, sy = (90 - lat) / 180 * HSRC;
      const isLand = landMask[clamp(Math.floor(sy), 0, HSRC - 1) * WSRC + ((Math.floor(sx) % WSRC) + WSRC) % WSRC];
      if (landOnly && !isLand) return;
      const m = (isLand ? Math.max(1, HM(bilinearH(sx, sy))) : -1500) * gain + off, cur = SC.h[i];
      const tgt = mode === 'blend' ? m : mode === 'add' ? cur + m : mode === 'min' ? Math.min(cur, m) : Math.max(cur, m);
      SC.h[i] = cur + (tgt - cur) * a; n++;
    });
    const id = SC.ops.length + 1; SC.sources.set(key, id);
    SC.ops.push({ id, op: 'stamp', source: key, at, size: [+w.toFixed(1), +h.toFixed(1)], rot: +o.rot || 0, flip: flip || undefined, mode, cells: n });
    return info(`stamped ${key} at ${at.join(',')} (${w.toFixed(1)}x${h.toFixed(1)} tiles, rot ${+o.rot || 0}°${flip ? ', flip ' + flip : ''}) into ${n} cells`);
  }
  function shape(o) {
    need(); const kind = o.kind, seed = (SC.seed + SC.ops.length * 13) | 0; let note = '';
    if (kind === 'blob') {   // a land mass: domain-warped disc raised to `height`
      const [ax, ay] = o.at || [SC.W / 2, SC.H / 2], r = +o.radius || 15, hgt = o.height != null ? +o.height : 250, irr = o.irregular != null ? +o.irregular : 0.5, fall = o.falloff != null ? +o.falloff : 0.35, sx = o.stretch ? +o.stretch : 1, ang = (+o.angle || 0) * Math.PI / 180;
      forCells((i, x, y) => { let dx = x - ax, dy = y - ay; const rx = (dx * Math.cos(ang) + dy * Math.sin(ang)) / sx, ry = -dx * Math.sin(ang) + dy * Math.cos(ang); const d = Math.hypot(rx, ry) / r, warp = d * (1 + irr * (fbm(x / r * 1.6, y / r * 1.6, 4, seed) - 0.5) * 1.4); const p = sstep(1, 1 - fall, warp); if (p <= 0) return; const val = hgt + 160 * (fbm(x / 6, y / 6, 3, seed + 1) - 0.5); SC.h[i] = Math.max(SC.h[i], lerp(SC.h[i], val, p)); });
    } else if (kind === 'ridge' || kind === 'rift') {
      const path = o.path; if (!path || path.length < 2) throw new Error(kind + ' needs path [[x,y],...] (tiles)');
      const wdt = +o.width || (kind === 'rift' ? 2 : 3), hgt = o.height != null ? +o.height : 2500, dep = o.depth != null ? +o.depth : 2000, jag = o.jag != null ? +o.jag : 0.5;
      forCells((i, x, y) => { const P = polyDist(path, x, y); if (P.d > wdt * 3) return; const along = P.t * P.len;
        if (kind === 'ridge') { const prof = Math.exp(-Math.pow(P.d / wdt, 2) * 2.2), body = (1 - jag) + jag * 1.4 * ridged(along / 4, P.d / 3, seed), taper = sstep(0, 0.08, P.t) * sstep(1, 0.92, P.t); SC.h[i] = Math.max(SC.h[i], SC.h[i] + hgt * prof * body * (0.35 + 0.65 * taper)); }
        else { const trough = Math.exp(-Math.pow(P.d / wdt, 2) * 2.5), shoulder = Math.exp(-Math.pow((P.d - wdt * 1.8) / wdt, 2) * 2) * 0.18; SC.h[i] += dep * (shoulder - trough); } });
    } else if (kind === 'plateau' || kind === 'basin') {
      const [ax, ay] = o.at || [SC.W / 2, SC.H / 2], r = +o.radius || 8, irr = o.irregular != null ? +o.irregular : 0.4;
      forCells((i, x, y) => { const d = Math.hypot(x - ax, y - ay) / r * (1 + irr * (fbm(x / r * 2, y / r * 2, 3, seed) - 0.5) * 1.2);
        if (kind === 'plateau') { const p = sstep(1, 1 - (o.edge != null ? +o.edge : 0.25), d); if (p > 0) SC.h[i] = Math.max(SC.h[i], lerp(SC.h[i], (o.height != null ? +o.height : 1500) + 120 * (fbm(x / 5, y / 5, 3, seed + 3) - 0.5), p)); }
        else { const p = Math.exp(-d * d * 2.5); SC.h[i] -= (o.depth != null ? +o.depth : 400) * p; } });
    } else if (kind === 'chain') {   // hotspot track: young high volcanoes at the path's start, old atolls at its end
      const path = o.path; if (!path || path.length < 2) throw new Error('chain needs path [[x,y],...]');
      const cnt = Math.max(2, o.count | 0 || 8), [h0, h1] = o.height || [2500, 200], [r0, r1] = o.radius || [3, 1], nAt = Math.max(0, o.atolls != null ? o.atolls | 0 : Math.floor(cnt / 3)), jit = o.jitter != null ? +o.jitter : 0.6;
      const pts = []; let total = 0; for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      const at = s => { let acc = 0; for (let i = 1; i < path.length; i++) { const L = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]); if (acc + L >= s || i === path.length - 1) { const u = L ? clamp((s - acc) / L, 0, 1) : 0; const dx = path[i][0] - path[i - 1][0], dy = path[i][1] - path[i - 1][1], n = Math.hypot(dx, dy) || 1; return [path[i - 1][0] + u * dx, path[i - 1][1] + u * dy, -dy / n, dx / n]; } acc += L; } };
      for (let j = 0; j < cnt; j++) { const f = j / (cnt - 1), p = at(f * total), off = (vnoise(j * 1.7 + seed, 3.1) - 0.5) * 2 * jit * lerp(r0, r1, f) * 1.5; pts.push({ x: p[0] + p[2] * off, y: p[1] + p[3] * off, h: lerp(h0, h1, f) * (0.75 + 0.5 * vnoise(j * 2.3, seed)), r: lerp(r0, r1, f) * (0.8 + 0.4 * vnoise(seed, j * 1.9)), atoll: j >= cnt - nAt, s: seed + j * 101 }); }
      for (const v of pts) {
        if (v.atoll) { SC.post.push({ kind: 'atoll', x: v.x, y: v.y, r: Math.max(0.6, v.r), s: v.s }); continue; }
        /* r is the island's radius AT SEA LEVEL: above it a shield rising to v.h, below it the submarine flank falling to
           the floor over another 1.5 r, with lobed outlines so no two islands share a shape */
        forCells((i, x, y) => { const dx = x - v.x, dy = y - v.y, ang = Math.atan2(dy, dx), lobe = 1 + 0.28 * (vnoise(Math.cos(ang) * 1.8 + v.s, Math.sin(ang) * 1.8 - v.s) - 0.5) * 2, d = Math.hypot(dx, dy) / (v.r * lobe); if (d > 2.6) return;
          const val = d < 1 ? v.h * (1 - Math.pow(d, 1.4)) * (0.85 + 0.3 * vnoise(x * 1.3 + v.s, y * 1.3)) + 3 : -Math.min(1, (d - 1) / 1.5) * (-SC.base); SC.h[i] = Math.max(SC.h[i], val); });
      }
      note = `${cnt - nAt} volcanoes + ${nAt} atolls`;
    } else if (kind === 'fjords') {   // narrow troughs cut inland from a coast, below the final sea level (applied at view/realize)
      const path = o.path; if (!path || path.length < 2) throw new Error('fjords need path [[x,y],...] along the coast');
      SC.post.push({ kind: 'fjords', path, count: o.count | 0 || 6, length: +o.length || 8, width: +o.width || 0.7, depth: +o.depth || 300, side: o.side || 'auto', s: seed });
      note = `${o.count | 0 || 6} fjords queued (cut after sea level)`;
    } else if (kind === 'noise') {
      const amp = o.amplitude != null ? +o.amplitude : 300, sc = +o.scale || 10, [ax, ay] = o.at || [0, 0], r = o.radius ? +o.radius : 0;
      forCells((i, x, y) => { const m = r ? sstep(1, 0.6, Math.hypot(x - ax, y - ay) / r) : 1; if (!m) return; SC.h[i] += amp * 2 * (fbm(x / sc, y / sc, 5, seed) - 0.5) * m; });
    } else if (kind === 'smooth') {
      const R = Math.max(1, Math.round((+o.radius || 1) * SC.k)), { GW, GH } = SC, src = Float32Array.from(SC.h);
      for (let cy = 0; cy < GH; cy++) for (let cx = 0; cx < GW; cx++) { let s = 0, n = 0; for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue; s += src[ny * GW + nx]; n++; } SC.h[cy * GW + cx] = s / n; }
    } else throw new Error("kind must be blob, ridge, rift, plateau, basin, chain, fjords, noise or smooth");
    if (SC.seaSet && SC.seaSet.land != null) setSea({ land: SC.seaSet.land }, true);   // keep the requested land share as the terrain changes
    SC.ops.push(Object.assign({ id: SC.ops.length + 1, op: kind }, o));
    return info(`${kind}${note ? ': ' + note : ''}`);
  }
  function setSea(o, quiet) {
    need();
    if (o.level != null) { SC.sea = +o.level; SC.seaSet = { level: SC.sea }; }
    else if (o.land != null) { const f = clamp(+o.land, 0.01, 0.99), arr = Float32Array.from(SC.h).sort(); SC.sea = arr[Math.floor((1 - f) * (arr.length - 1))]; SC.seaSet = { land: f }; }
    else throw new Error('give land (target share 0..1) or level (metres)');
    return quiet ? null : info(`sea level ${Math.round(SC.sea)} m`);
  }
  /* the final height field relative to sea level, with the sea-relative features (atolls, fjords) applied */
  function finalHeights() {
    /* A sea level BELOW 0 (more land asked for than the shapes made) must not turn existing land into mountains: the
       ground that emerges becomes coastal lowland (0..LOW m, in proportion to how far below 0 it was) and existing
       land keeps its height on top of that. A sea level above 0 simply drowns the low ground. */
    const { GW, GH, k } = SC, h = new Float32Array(SC.h.length), L = SC.sea, LOW = 150;
    for (let i = 0; i < h.length; i++) { const v = SC.h[i]; h[i] = L >= 0 ? v - L : v >= 0 ? v + LOW : v > L ? (v - L) / (-L) * LOW : v - L; }
    for (const p of SC.post) {
      if (p.kind === 'atoll') {
        const R = Math.ceil((p.r * 1.5 + 1) * k), cx0 = Math.floor(p.x * k), cy0 = Math.floor(p.y * k);
        for (let cy = cy0 - R; cy <= cy0 + R; cy++) for (let cx = cx0 - R; cx <= cx0 + R; cx++) { if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) continue; const x = (cx + 0.5) / k, y = (cy + 0.5) / k, dx = x - p.x, dy = y - p.y, ang = Math.atan2(dy, dx), rr = p.r * (1 + 0.25 * (vnoise(Math.cos(ang) * 1.5 + p.s, Math.sin(ang) * 1.5) - 0.5) * 2), d = Math.hypot(dx, dy), i = cy * GW + cx;
          const ring = Math.exp(-Math.pow((d - rr) / Math.max(0.55, rr * 0.4), 2)); if (d < rr) h[i] = Math.max(h[i], -25 + 20 * ring); if (ring > 0.35) h[i] = Math.max(h[i], 4 + 6 * ring); else if (d > rr) h[i] = Math.max(h[i], -60 * (1 - ring) - 5); }   // a reef ring wide enough to hold land at tile scale, a shallow lagoon inside
      } else if (p.kind === 'fjords') {
        let total = 0; for (let i = 1; i < p.path.length; i++) total += Math.hypot(p.path[i][0] - p.path[i - 1][0], p.path[i][1] - p.path[i - 1][1]);
        for (let j = 0; j < p.count; j++) {
          const s = (j + 0.5) / p.count * total; let acc = 0, x = 0, y = 0, nx = 0, ny = 0;
          for (let i = 1; i < p.path.length; i++) { const L = Math.hypot(p.path[i][0] - p.path[i - 1][0], p.path[i][1] - p.path[i - 1][1]); if (acc + L >= s || i === p.path.length - 1) { const u = L ? clamp((s - acc) / L, 0, 1) : 0, dx = p.path[i][0] - p.path[i - 1][0], dy = p.path[i][1] - p.path[i - 1][1], n = Math.hypot(dx, dy) || 1; x = p.path[i - 1][0] + u * dx; y = p.path[i - 1][1] + u * dy; nx = -dy / n; ny = dx / n; break; } acc += L; }
          const probe = (sx, sy) => { const cx = clamp(Math.floor(sx * k), 0, GW - 1), cy = clamp(Math.floor(sy * k), 0, GH - 1); return h[cy * GW + cx]; };
          let sgn = p.side === 'left' ? 1 : p.side === 'right' ? -1 : (probe(x + nx * 3, y + ny * 3) >= probe(x - nx * 3, y - ny * 3) ? 1 : -1);   // inland = the higher side
          let dirx = nx * sgn, diry = ny * sgn; x -= dirx * 1.5; y -= diry * 1.5;   // start offshore so the mouth opens to the sea
          const len = p.length * (0.7 + 0.6 * vnoise(j * 3.1, p.s)), steps = Math.ceil(len * k * 2);
          for (let t = 0; t < steps; t++) {
            const wob = (vnoise(t / (k * 3) + j * 7, p.s) - 0.5) * 0.9; const ca = Math.cos(wob * 0.35), sa = Math.sin(wob * 0.35); const nx2 = dirx * ca - diry * sa, ny2 = dirx * sa + diry * ca; dirx = nx2; diry = ny2;
            x += dirx / (k * 2); y += diry / (k * 2); const wd = p.width * (1 - 0.5 * t / steps);
            const R = Math.ceil(wd * k + 1); for (let cy = Math.floor(y * k) - R; cy <= Math.floor(y * k) + R; cy++) for (let cx = Math.floor(x * k) - R; cx <= Math.floor(x * k) + R; cx++) { if (cx < 0 || cy < 0 || cx >= GW || cy >= GH) continue; if (Math.hypot((cx + 0.5) / k - x, (cy + 0.5) / k - y) <= wd) h[cy * GW + cx] = Math.min(h[cy * GW + cx], -p.depth * (1 - 0.6 * t / steps)); }
          }
        }
      }
    }
    return h;
  }
  /* tile-level view of the final heights: mean, local range, land */
  function tileField() {
    const { W, H, k, GW } = SC, F = finalHeights(), elev = new Float32Array(W * H), lo = new Float32Array(W * H), hi = new Float32Array(W * H), land = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, mn = Infinity, mx = -Infinity, above = 0; for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const v = F[(y * k + dy) * GW + x * k + dx]; s += v; if (v < mn) mn = v; if (v > mx) mx = v; if (v > 0) above++; } const i = y * W + x; elev[i] = s / (k * k); lo[i] = mn; hi[i] = mx; land[i] = above * 2 >= k * k ? 1 : 0; }
    const range = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let mn = Infinity, mx = -Infinity; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (lo[j] < mn) mn = lo[j]; if (hi[j] > mx) mx = hi[j]; } range[y * W + x] = Math.max(0, mx - Math.max(0, mn)); }
    return { elev, range, land, F };
  }
  /* the cheap preview: elevation glyphs per tile and stats */
  function info(msg) { const r = infoFull(msg); return { msg: r.msg }; }
  function infoFull(msg) {
    const { W, H } = SC, tf = tileField(); let land = 0; const bands = [0, 0, 0, 0, 0];
    for (let i = 0; i < W * H; i++) if (tf.land[i]) { land++; const e = tf.elev[i]; bands[e < 200 ? 0 : e < 600 ? 1 : e < 1200 ? 2 : e < 2400 ? 3 : 4]++; }
    const seen = new Uint8Array(W * H), sizes = [];
    for (let i = 0; i < W * H; i++) { if (!tf.land[i] || seen[i]) continue; let n = 0; const st = [i]; seen[i] = 1; while (st.length) { const c = st.pop(); n++; const x = c % W, y = (c - x) / W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (tf.land[j] && !seen[j]) { seen[j] = 1; st.push(j); } } } sizes.push(n); }
    sizes.sort((a, b) => b - a);
    return { kind: 'sculpt', msg, W, H, latitudes: { top: SC.latTop, bottom: SC.latBot }, degPerTile: +SC.degPerTile.toFixed(3), sea: Math.round(SC.sea), land, landPct: +(land / (W * H) * 100).toFixed(1),
      bands: { '0-200m': bands[0], '200-600m': bands[1], '600-1200m': bands[2], '1200-2400m': bands[3], '2400m+': bands[4] }, landmasses: { count: sizes.length, top: sizes.slice(0, 8) }, ops: SC.ops.length, post: SC.post.length, tf };
  }
  function view(o) {
    need(); const r = infoFull(o.msg || 'view'), tf = r.tf; delete r.tf; r.recent = SC.ops.slice(-3).map(op => op.op + (op.source ? ' ' + op.source : ''));
    if (o.grid !== false) {
      const { W, H } = SC; let [x0, y0, x1, y1] = o.bbox || [0, 0, W - 1, H - 1]; x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0); x1 = Math.min(W - 1, x1 | 0); y1 = Math.min(H - 1, y1 | 0);
      const step = Math.max(1, (o.step | 0) || Math.max(Math.ceil((x1 - x0 + 1) / 120), Math.ceil((y1 - y0 + 1) / 80))), rows = [];
      for (let y = y0; y <= y1; y += step) { let s = ''; for (let x = x0; x <= x1; x += step) { const i = y * W + x, e = tf.elev[i]; s += !tf.land[i] ? (e > -150 ? '-' : '~') : e < 200 ? '.' : e < 600 ? ':' : e < 1200 ? '+' : e < 2400 ? 'n' : '^'; } rows.push({ y, s }); }
      r.grid = { x0, y0, x1, y1, step, rows, legend: "~ deep sea  - shelf  . 0-200m  : 200-600m  + 600-1200m  n 1200-2400m  ^ 2400m+" };
    }
    return r;
  }
  function undoLast() { throw new Error('undo is not supported: start again with sculpt_new (the ops list in the view says what was done)'); }

  /* ---------- realize: heights -> climate -> the game's tiles, lakes, rivers -> a snapshot on the compose canvas ---------- */
  async function realize(o) {
    need(); o = o || {};
    const { W, H } = SC, g = activeGame(), tf = tileField(), land = Uint8Array.from(tf.land), elev = Float32Array.from(tf.elev);
    for (let i = 0; i < W * H; i++) if (!land[i]) elev[i] = Math.min(elev[i], -1);
    const lat = y => SC.latTop + (SC.latBot - SC.latTop) * (y + 0.5) / H;
    let relief = T.climate.reliefOf(W, H, elev, land, tf.range, o.relief);
    const grid = { W, H, land, elev, lat, kmPerTile: SC.kmPerTile, seed: SC.seed };
    let C = T.climate.run(grid, { wetness: o.wetness });
    // lakes in closed basins: priority flood on land heights, depressions deeper than lakeDepth and at least 2 tiles
    const lakes = []; let salt = null;
    if (o.lakes !== false) {
      const PF = T.hydro.priorityFlood(elev, W, H, i => !land[i], null, o.edgeOutlets !== false), seen = new Uint8Array(W * H), minD = +o.lakeDepth || 25, maxLakes = o.lakes | 0 || 6, comps = [];
      for (let i = 0; i < W * H; i++) { if (!land[i] || seen[i] || PF.filled[i] - elev[i] < minD) continue; const st = [i], cells = []; seen[i] = 1; while (st.length) { const c = st.pop(); cells.push(c); const x = c % W, y = (c - x) / W; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (!seen[j] && land[j] && PF.filled[j] - elev[j] >= minD) { seen[j] = 1; st.push(j); } } } if (cells.length >= 2) comps.push(cells); }
      comps.sort((a, b) => b.length - a.length);
      const cg = T.util.classGroup; salt = new Uint8Array(W * H);
      for (const cells of comps.slice(0, maxLakes)) {
        let arid = 0; for (const c of cells) if (cg(C.kc[c]) === 2) arid++; const dry = arid * 2 >= cells.length;
        /* an arid closed basin is mostly salt flat (playa / sabkha) around a small terminal lake in its deepest part;
           a humid one fills with water */
        let water = cells; if (dry) { const byDepth = cells.slice().sort((p, q) => (PF.filled[q] - elev[q]) - (PF.filled[p] - elev[p])); water = byDepth.slice(0, Math.max(0, Math.floor(cells.length * 0.15))).filter(c2 => PF.filled[c2] - elev[c2] > minD * 3); for (const c2 of cells) salt[c2] = 1; }
        for (const c of water) { land[c] = 0; elev[c] = -5; salt[c] = 0; }
        if (dry) for (const c of water) { const x = c % W, y = (c - x) / W; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (land[j]) salt[j] = 1; } }
        lakes.push({ tiles: water.length, saltFlat: dry ? cells.length - water.length : 0, at: [cells[0] % W, (cells[0] / W) | 0], climate: dry ? 'arid: salt flat' + (water.length ? ' with terminal lake' : '') : 'humid' });
      }
      if (lakes.length) { relief = T.climate.reliefOf(W, H, elev, land, tf.range, o.relief); C = T.climate.run(grid, { wetness: o.wetness }); }
    }
    const S = T.climate.buildSamples(Object.assign({}, grid, { relief }), C);
    if (salt) for (let i = 0; i < W * H; i++) if (salt[i] && land[i]) { S.playa[i] = 1; }
    const res = g.classify(S, { W, H, hex: false, grid: g.grid }), tiles = res.tiles;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x], i = y * W + x; if (!t || typeof t !== 'object') continue; t._h = Math.round(S.h[i] * 10000) / 10000; if (S.land[i] && S.playa[i] >= 0.5) t._salt = 1; }
    finalizeTiles(tiles, W, H);
    // rivers: flow accumulation of rainfall along a depression-free surface; channels where it passes a threshold
    const rv = riversFrom(elev, land, C, o);
    cleanupRiverEdges(rv.nof, rv.wof, tiles, W, H);
    dropStubs(rv.nof, rv.wof, 3);   // the coast cleanup can leave 1-2 edge fragments at a mouth: not rivers
    if (g.features) g.features(tiles, S, rv, { W, H, hex: false, grid: g.grid });
    // the snapshot, and the compose canvas showing it
    const a = T.api, flat = []; for (const row of tiles) for (const t of row) flat.push(t);
    const snap = { v: 1, kind: 'terra-form-snapshot', id: a.newId(), name: o.name || 'sculpted world', W, H, hex: false, game: g.id, topLat: SC.latTop, botLat: SC.latBot,
      frame: { cx: WSRC / 2, cy: HSRC / 2, spanX: SC.degPerTile * W * WSRC / 360, rot: 0 }, createdAt: Date.now(), tiles: flat, rivers: { nof: Array.from(rv.nof), wof: Array.from(rv.wof) }, sculpted: { ops: SC.ops.length, sea: Math.round(SC.sea) }, thumb: null };
    snap.thumb = a.thumb(snap); await a.shelf.save(snap);
    a.setMode('compose'); a.compose.clear(); a.compose.setSize(W, H); a.compose.setLatitudes(SC.latTop, SC.latBot); a.compose.state().degPerTile = SC.degPerTile;
    a.compose.add(snap, 0, 0, false); a.render();
    return { snapshot: snap.id, name: snap.name, climate: T.climate.summary(Object.assign({}, grid, { land }), C), lakes, rivers: rv.systems };
  }
  /* drop river components (edges sharing exact corners) with fewer than min edges. nof 'gy,gx' spans corners
     (gx,gy+1)-(gx+1,gy+1), wof 'gy,gx' spans (gx+1,gy)-(gx+1,gy+1) */
  function dropStubs(nof, wof, min) {
    const E = [], byC = new Map(), add = (m, kind) => { for (const k of m.keys()) { const p = k.split(','), gy = +p[0], gx = +p[1], c = kind === 'n' ? [gx + ',' + (gy + 1), (gx + 1) + ',' + (gy + 1)] : [(gx + 1) + ',' + gy, (gx + 1) + ',' + (gy + 1)], e = { m, k, c }; E.push(e); for (const q of c) (byC.get(q) || byC.set(q, []).get(q)).push(e); } };
    add(nof, 'n'); add(wof, 'w'); const seen = new Set();
    for (const e of E) { if (seen.has(e)) continue; const comp = [], st = [e]; seen.add(e); while (st.length) { const x = st.pop(); comp.push(x); for (const q of x.c) for (const y of byC.get(q)) if (!seen.has(y)) { seen.add(y); st.push(y); } } if (comp.length < min) for (const x of comp) x.m.delete(x.k); }
  }
  function riversFrom(elev, land, C, o) {
    const W = SC.W, H = SC.H, N = W * H, hh = new Float32Array(N); for (let i = 0; i < N; i++) { const x = i % W, y = (i - x) / W; hh[i] = elev[i] + (vnoise(x / 2 + SC.seed, y / 2) - 0.5) * 0.5; }
    const edgeOut = o.edgeOutlets !== false, PF = T.hydro.priorityFlood(hh, W, H, i => !land[i], null, edgeOut), acc = new Float64Array(N), km2 = SC.kmPerTile * SC.kmPerTile;
    for (let i = 0; i < N; i++) if (land[i]) acc[i] = Math.max(0, C.P[i] || 0) * km2;   // mm·km² of rain per tile
    for (let q = PF.order.length - 1; q >= 0; q--) { const c = PF.order[q], r = PF.recv[c]; if (r >= 0 && land[c]) acc[r] += acc[c]; }
    // discharge m³/s: 40% runoff of the accumulated rain
    const Q = i => acc[i] / 1000 * 1e6 * 0.4 / 31.5e6;
    const dens = clamp(o.riverDensity != null ? +o.riverDensity : 0.06, 0.005, 0.3), landQ = []; for (let i = 0; i < N; i++) if (land[i]) landQ.push(acc[i]); landQ.sort((a, b) => a - b);
    const thr = Math.max(landQ.length ? landQ[Math.floor((1 - dens) * (landQ.length - 1))] : Infinity, (+o.minDischarge || 20) * 31.5e6 / (1e6 * 0.4) * 1000);
    const isCh = i => land[i] && acc[i] >= thr, donors = new Uint8Array(N); for (let i = 0; i < N; i++) { const r = PF.recv[i]; if (r >= 0 && isCh(i)) donors[r] = 1; }
    const heads = []; for (let i = 0; i < N; i++) if (isCh(i) && !donors[i]) heads.push(i); heads.sort((a, b) => acc[b] - acc[a]);
    const used = new Uint8Array(N), reaches = []; let rid = 4e9, systems = 0;
    for (const hd of heads) {
      const cells = [], qs = []; let c = hd, guard = 0, exit = null;
      while (c >= 0 && guard++ < N) {
        cells.push(c); qs.push(Q(c)); if (!land[c]) break; if (used[c] && cells.length > 1) break; used[c] = 1;
        /* near the border, leave the map straight across it: the flood treats every border tile as an outlet at its own
           height, so the drainage just inside a raised border runs along it to the lowest border tile, a river hugging the edge */
        const x = c % W, y = (c - x) / W, dB = Math.min(x, y, W - 1 - x, H - 1 - y);
        if (edgeOut && dB <= 1 && cells.length > 1) {
          const [sx, sy] = dB === x ? [-1, 0] : dB === W - 1 - x ? [1, 0] : dB === y ? [0, -1] : [0, 1];
          for (let k = 0; k < dB; k++) { c += sy * W + sx; cells.push(c); qs.push(Q(c)); used[c] = 1; }
          const ex = c % W, ey = (c - ex) / W; exit = sx ? [sx < 0 ? 0 : W, ey + 0.5] : [ex + 0.5, sy < 0 ? 0 : H]; break;
        }
        c = PF.recv[c];
      }
      if (cells.length < 3) continue; systems++;
      const id = rid++, sm = T.hydro.riverLine(cells, W, o.meander != null ? +o.meander : 0.6, id & 0xffff);   // smoothed with a seeded meander, so channels across filled flats do not run in ruler lines
      if (exit) sm.push(exit);
      for (let s = 0; s + 1 < sm.length; s += 4) { const seg = sm.slice(s, Math.min(sm.length, s + 5)); if (seg.length < 2) continue; const qi = Math.min(qs.length - 1, Math.floor(s / sm.length * qs.length)); reaches.push({ rid: id, d: Math.round(Math.max(5, qs[qi])), l: [seg.map(p => [p[0], H - p[1]])] }); }
    }
    const E = reachesToEdges(reaches, { lonL: 0, lonR: W, latT: H, latB: 0 }, W, H, null);
    return { nof: E.nof, wof: E.wof, systems };
  }

  /* ---------- reclimate: a collage's climate recomputed for where its pieces now sit ---------- */
  async function reclimate(o) {
    o = o || {}; const a = T.api, c = a.compose.state();
    if (c.latTop == null || c.latBot == null) throw new Error('declare the canvas latitudes first (compose_new {latitudes:{top,bottom}})');
    const C0 = a.compose.composite(), W = C0.W, H = C0.H, g = activeGame(), rel = (g.preview && g.preview.relief) || (t => t.relief | 0), HM = T.util.heightMetres;
    const land = new Uint8Array(W * H), elev = new Float32Array(W * H), relief = new Uint8Array(W * H), oldG = new Uint8Array(W * H), cg = T.util.classGroup;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = C0.tiles[y][x], i = y * W + x; land[i] = isWaterTile(t) ? 0 : 1; elev[i] = land[i] ? (typeof t._h === 'number' ? Math.max(1, HM(t._h)) : 150 + 700 * (rel(t) | 0)) : -200; relief[i] = land[i] ? (rel(t) | 0) : 0; oldG[i] = land[i] && t.kc ? cg(t.kc) : 255; }
    let deg = c.degPerTile; if (!deg) { const ds = c.patches.map(p => p.snap && Math.abs(p.snap.topLat - p.snap.botLat) / Math.max(1, p.snap.H)).filter(v => v > 0).sort((p, q) => p - q); deg = ds.length ? ds[ds.length >> 1] : Math.abs(c.latTop - c.latBot) / H; }
    const grid = { W, H, land, elev, lat: y => c.latTop + (c.latBot - c.latTop) * (y + 0.5) / H, kmPerTile: deg * 111.32, seed: 11 };
    const C = T.climate.run(grid, { wetness: o.wetness }), S = T.climate.buildSamples(Object.assign({}, grid, { relief }), C);
    const tiles = g.classify(S, { W, H, hex: false, grid: g.grid }).tiles; let changed = 0, landN = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x], i = y * W + x, o0 = C0.tiles[y][x]; if (o0 && o0._h != null) t._h = o0._h; if (land[i]) { landN++; if (oldG[i] !== 255 && oldG[i] !== cg(C.kc[i])) changed++; } }
    finalizeTiles(tiles, W, H);
    const rv = { nof: new Map(C0.rivers.nof), wof: new Map(C0.rivers.wof) }; cleanupRiverEdges(rv.nof, rv.wof, tiles, W, H);
    if (g.features) g.features(tiles, S, rv, { W, H, hex: false, grid: g.grid });
    const flat = []; for (const row of tiles) for (const t of row) flat.push(t);
    const snap = { v: 1, kind: 'terra-form-snapshot', id: a.newId(), name: o.name || 'reclimated collage', W, H, hex: false, game: g.id, topLat: c.latTop, botLat: c.latBot, frame: { cx: WSRC / 2, cy: HSRC / 2, spanX: deg * W * WSRC / 360, rot: 0 }, createdAt: Date.now(), tiles: flat, rivers: { nof: Array.from(rv.nof), wof: Array.from(rv.wof) }, reclimated: true, thumb: null };
    snap.thumb = a.thumb(snap); await a.shelf.save(snap);
    const lt = c.latTop, lb = c.latBot; a.compose.clear(); a.compose.setLatitudes(lt, lb); a.compose.state().degPerTile = deg; a.compose.add(snap, 0, 0, false); a.render();
    return { snapshot: snap.id, changedGroups: changed, landTiles: landN, climate: T.climate.summary(grid, C) };
  }

  const attach = () => { if (T.api) T.api.sculpt = { new: sNew, stamp, shape, sea: setSea, view, realize, reclimate, undo: undoLast, state: () => SC }; else setTimeout(attach, 50); };
  attach();
})();
