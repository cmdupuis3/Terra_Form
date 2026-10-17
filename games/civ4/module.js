/* games/civ4/module.js -- Civilization IV (Beyond the Sword) for Terra Form.
 *
 * The core (index.html) samples the real world into per-tile measurements -- height, roughness, relief,
 * Koppen class, satellite colour, land/water, latitude, salt pans, river edges -- and hands them to the
 * active game module. This module turns them into Civ4 plots (TERRAIN_* + PlotType), lays the features
 * (forest, jungle, flood plains, oasis) once the river edges are known, draws the Civ preview and writes
 * the .CivBeyondSwordWBSave through games/civ4/wbs_core.js. See games/README.md for the contract.
 *
 * Nothing in here is reached before index.html has installed TerraForm.util / TerraForm.ui, so the helpers
 * are read at call time (T.util.xxx), never at load time.
 */
(function () {
  "use strict";
  const T = window.TerraForm;

  /* ---------- Civ4 vocabulary ---------- */
  const PLOT = { PEAK: 0, HILLS: 1, FLAT: 2, WATER: 3 };
  const TERR = { OCEAN: 'TERRAIN_OCEAN', COAST: 'TERRAIN_COAST', GRASS: 'TERRAIN_GRASS', PLAINS: 'TERRAIN_PLAINS', DESERT: 'TERRAIN_DESERT', TUNDRA: 'TERRAIN_TUNDRA', SNOW: 'TERRAIN_SNOW' };
  const TCOLOR = { [TERR.OCEAN]: [18, 58, 81], [TERR.COAST]: [47, 109, 140], [TERR.GRASS]: [92, 138, 74], [TERR.PLAINS]: [167, 164, 78], [TERR.DESERT]: [203, 181, 111], [TERR.TUNDRA]: [128, 138, 114], [TERR.SNOW]: [233, 236, 224] };
  const LEADERS = [['LEADER_BRENNUS', 'CIVILIZATION_CELT'], ['LEADER_HUAYNA_CAPAC', 'CIVILIZATION_INCA'], ['LEADER_TOKUGAWA', 'CIVILIZATION_JAPAN'], ['LEADER_GILGAMESH', 'CIVILIZATION_SUMERIA'], ['LEADER_ZARA_YAQOB', 'CIVILIZATION_ETHIOPIA'], ['LEADER_SURYAVARMAN', 'CIVILIZATION_KHMER'], ['LEADER_MANSA_MUSA', 'CIVILIZATION_MALI'], ['LEADER_ASOKA', 'CIVILIZATION_INDIA'], ['LEADER_PERICLES', 'CIVILIZATION_GREECE'], ['LEADER_RAMESSES', 'CIVILIZATION_EGYPT'], ['LEADER_PACAL', 'CIVILIZATION_MAYA'], ['LEADER_QIN_SHI_HUANG', 'CIVILIZATION_CHINA']];
  const KNOWN_TERRAINS = new Set(Object.values(TERR));
  const KNOWN_FEATURES = new Set(['FEATURE_FOREST', 'FEATURE_JUNGLE', 'FEATURE_FLOOD_PLAINS', 'FEATURE_OASIS']);
  const RELIEF_PLOT = [PLOT.FLAT, PLOT.HILLS, PLOT.PEAK];   // core relief class (0 flat, 1 hills, 2 peak) -> Civ4 PlotType

  /* ---------- tunables (the Base Terrain / Features panels) ---------- */
  const P = {
    sea: 0.5,                                              // normalised height treated as sea level by the altitude lapse (fixed; the slider was removed)
    dryPlains: 0.42, dryDesert: 0.66,                      // dryness-axis boundaries (0 wet -> 1 arid): >=dryPlains -> plains, >=dryDesert -> desert
    tempTundra: 0.39, tempSnow: 0.27,                      // temperature thresholds (0 cold -> 1 hot); colder than these -> tundra / snow
    latTundra: 55, latIce: 70,                             // poleward cold onsets (deg): tundra ramp begins at latTundra, ice ramp at latIce (higher); each climbs to full over LAT_RAMP_SPAN
    alpine: 0.6,                                           // strength of the snow-cover cold tilt (satellite white-fraction -> colder)
    clim: 0.45, feat: false,
    fpKoppen: true,                                        // arid BW-desert Koppen stays desert so a green/dark floodplain strip isn't reclassified as plains/grass by colour (off -> colour variety when zoomed in)
    fpThresh: 0.5, oasisThresh: 0.62,                      // flood-plain / oasis quality thresholds on the [0,1] feature score (oasisThresh is tied to the flood-plain slider)
    oasisRatio: 0.14,                                      // base cap on oasis count = oasisRatio x flood-plain ("river") tile count, applied PER Koppen zone; own slider, max 0.4
    oasisMultDesert: 10, oasisMultSemiArid: 3,             // per-zone multipliers on the base ratio: true desert (BWh/BWk) x10, semi-arid steppe (BSh/BSk) x3, everything else x1
    forestDens: 0.5, jungleDens: 0.5 };                    // forest / jungle density sliders (0.5 = natural rate, 0 = none, 1 = max)
  const HUMID_F = new Set([14, 15, 16, 25, 26, 27, 28]);   // Cfa/Cfb/Cfc + Dfa/Dfb/Dfc/Dfd: fully-humid (no dry season) -- reliably green/fertile. Wet prior AND lean on climate over colour, so tan harvested fields in humid country stay grass
  const TEMP_LAPSE = 0.6;                                  // how much land elevation above sea cools the temperature metric (altitude -> tundra/snow)
  const COLOR_WARM = 0.30, COLOR_ICE = 0.35;               // satellite colour: vegetation/soil warms, bright desaturated ice/snow cools
  const SALT_VAL = 0.60, SALT_SAT = 0.30, SALT_FRAC = 0.12;   // salt-pan detector (in arid B): bright + desaturated average, OR this white-fraction
  const RED_LO = 8, RED_HI = 32, RED_SAT = 0.50;           // iron-red arid-soil detector: hue in [RED_LO,RED_HI] and saturated -> desert
  const SNOW_FULL = 0.30;                                  // white-fraction giving full snow-cover cold tilt
  const PLAYA_MIN = 0.5;                                   // tile is a salt flat if >= this fraction of its footprint lies inside a playa polygon (ground truth)
  const SURR_ARID_FRAC = 0.5;                              // >= this fraction of non-white witnesses in arid B -> read white as salt (desert)
  const SALT_SURR_WARM = 0.45;                             // ...but only if surrounding base-temp is at least this (excludes cold playa->snow)
  const SNOW_WARM_T = 0.55;                                // surrounding base-temp at/above which the snow tilt is fully damped (mild region)
  const SNOW_COLD_T = 0.35;                                // ...and at/below which it is untouched (cold region); linear between the two
  const SNOW_GATE_FLOOR = 0.30;                            // never damp the snow tilt below this -- protects real cold-surrounded snowfields
  const TUNDRA_HUE = 62, TAIGA_HUE = 82, TUNDRA_W = 0.35, TUNDRA_KC_MAX = 0.32, LAT_TILT_W = 0.6;   // boreal colour term: brown/tan tundra reads cold, dark-green taiga mild, only inside the cold Koppen zone; LAT_TILT_W lowers the latitude weight
  const LAT_NUDGE_LO = 50, LAT_NUDGE_HI = 80, LAT_NUDGE_W = 0.15;   // gentle broad poleward cold nudge (~15%) below the sharp Arctic ramp, to cool subarctic taiga
  const LAT_RAMP_SPAN = 20;                                // degrees over which each poleward ramp (tundra, ice) climbs 0 -> full past its onset latitude
  const ALT_TUNDRA_HI = 0.42;                              // the tundra COLOUR term applies only below this elevation (lowland Arctic); higher brown ground is left to the white-gated alpine term
  /* per-Koppen-class potential-vegetation weights (index 0 = ocean/nodata). Forest is the base rate for a grass/
     plains/tundra tile to be wooded; jungle for a grassland tile to be tropical rainforest. Order matches KOPPEN_KEYS 1-30:
     Af Am Aw | BWh BWk BSh BSk | Csa Csb Csc Cwa Cwb Cwc Cfa Cfb Cfc | Dsa Dsb Dsc Dsd Dwa Dwb Dwc Dwd Dfa Dfb Dfc Dfd | ET EF */
  const FOREST_W = [0, 0.15, 0.15, 0.20, 0.02, 0.02, 0.10, 0.12, 0.22, 0.45, 0.40, 0.42, 0.48, 0.42, 0.60, 0.72, 0.62,
                    0.35, 0.45, 0.52, 0.45, 0.45, 0.55, 0.60, 0.55, 0.60, 0.68, 0.74, 0.66, 0.18, 0.00];
  const JUNGLE_W = [0, 0.90, 0.85, 0.45, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.20, 0.05, 0.00, 0.15, 0.02, 0.00,
                    0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00];
  let featSeed = 1234;   // the re-roll button varies it; fhash(x,y,seed) keeps preview and export in step
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  /* ---------- the classifier ---------- */
  /* moisture biome from Koppen class + satellite colour. Specific-class overrides first, then the general dryness model.
     moistJit is a small per-tile deterministic dither added to the dryness D: it lets a uniformly-humid region cross the
     grass->plains->desert thresholds as a gradual speckled band instead of flipping all at once. */
  function moistureBiome(kc, hue, sat, val, moistJit) {
    const U = T.util, ca = U.colorAridity(hue, sat, val);
    if (kc === 8) return TERR.PLAINS;                                      // Csa -> plains by default
    const z = U.classGroup(kc);
    if (z === 2) {                                                         // arid B climates
      if (P.fpKoppen && (kc === 4 || kc === 5)) return TERR.DESERT;        // true desert Koppen (BWh/BWk): stay desert so a green floodplain strip isn't pulled to plains by colour
      if (hue >= RED_LO && hue <= RED_HI && sat >= RED_SAT) return TERR.DESERT;   // iron-red arid soil (Australia, Somalia) -> desert even when not bright
      if (kc === 6 || kc === 7) return val >= P.dryDesert ? TERR.DESERT : TERR.PLAINS;   // BSh/BSk steppe: lighter -> desert, darker -> plains
    }
    let kop, climW = P.clim;
    if (HUMID_F.has(kc)) { kop = 0.20; climW = clamp01(P.clim + 0.32); }   // fully-humid temperate/continental: wet prior, and colour matters little (land-use, not moisture)
    else kop = z === 2 ? 0.85 : z === 3 ? 0.18 : z === 4 ? 0.30 : z === 5 ? 0.42 : 0.45;   // B arid / A trop / C temp / D cont / polar-neutral
    const D = clamp01((1 - climW) * ca + climW * kop + (moistJit || 0));
    return D >= P.dryDesert ? TERR.DESERT : D >= P.dryPlains ? TERR.PLAINS : TERR.GRASS;
  }
  /* temperature in [0,1] (0 cold -> 1 hot) from Koppen class + altitude lapse + satellite colour (NO latitude) */
  function temperature(h, kc, hue, sat, val) {
    const ice = clamp01((val - 0.70) / 0.25) * clamp01((0.25 - sat) / 0.25);   // bright + desaturated = snow/ice
    const colorT = COLOR_WARM - (COLOR_WARM + COLOR_ICE) * ice;                 // vegetation/soil warms; ice cools
    return clamp01(T.util.KOPPEN_TEMP[kc] + colorT - Math.max(0, h - P.sea) * TEMP_LAPSE);
  }
  function classifyTile(h, plot, rgb, lat, kc, isLand, whiteFrac, surrArid, surrTemp, playaFrac, moistJit) {
    if (!isLand) return { terrain: TERR.OCEAN, plot: PLOT.WATER, rgb };
    const U = T.util;
    const [hue, sat, val] = U.hsv(rgb[0], rgb[1], rgb[2]), aLat = Math.abs(lat), z = U.classGroup(kc), arid = (z === 2), wf = whiteFrac || 0;
    const kk = U.KOPPEN_KEYS[kc], warmSummerD = (kk && kk[0] === 'D' && (kk[2] === 'a' || kk[2] === 'b'));   // Dxa/Dxb: warm/hot-summer continental -- never tundra/ice
    if (playaFrac >= PLAYA_MIN) return { terrain: TERR.DESERT, plot, rgb, z, lat, kc };   // ground-truth playa/salt flat -> desert, never snow
    // salt pan: bright/white ground reads as a hot salt flat (desert, not snow) when this tile's own climate is
    // arid B, OR the surrounding non-white climate is arid and not cold (catches pans whose own tile isn't B, e.g. Etosha).
    const saltWhite = (val >= SALT_VAL && sat <= SALT_SAT) || wf >= SALT_FRAC;
    const surrHotArid = (surrArid >= SURR_ARID_FRAC) && (surrTemp >= SALT_SURR_WARM);
    if (saltWhite && (arid || surrHotArid)) return { terrain: TERR.DESERT, plot, rgb, z, lat, kc };
    let terrain = moistureBiome(kc, hue, sat, val, moistJit);          // 1) moisture: grass / plains / desert
    let Tm = temperature(h, kc, hue, sat, val);                        // 2) temperature: Koppen + colour + altitude lapse
    // 3a) boreal cold tilt = latitude + altitude (no proximity; the base temperature stays latitude-free)
    const latTundra = clamp01((aLat - P.latTundra) / LAT_RAMP_SPAN), latIce = clamp01((aLat - P.latIce) / LAT_RAMP_SPAN);
    const latNudge = LAT_NUDGE_W * clamp01((aLat - LAT_NUDGE_LO) / Math.max(1e-6, LAT_NUDGE_HI - LAT_NUDGE_LO));
    const green = clamp01((hue - TUNDRA_HUE) / Math.max(1e-6, TAIGA_HUE - TUNDRA_HUE));                      // 0 = tundra brown, 1 = taiga green
    const tundraCold = (U.KOPPEN_TEMP[kc] <= TUNDRA_KC_MAX && h < ALT_TUNDRA_HI) ? (1 - green) * TUNDRA_W : 0;   // brown lowland tundra = cold; high brown plateaus go to the alpine term
    const coldCommon = tundraCold + latNudge;
    // 3b) snow-cover cold tilt (satellite white in non-arid tiles), damped where the SURROUNDING climate is mild
    let snowTerm = arid ? 0 : clamp01(wf / SNOW_FULL);
    const snowGate = SNOW_GATE_FLOOR + (1 - SNOW_GATE_FLOOR) * clamp01((SNOW_WARM_T - surrTemp) / Math.max(1e-6, SNOW_WARM_T - SNOW_COLD_T));
    snowTerm *= snowGate;
    const cold = coldCommon + P.alpine * snowTerm;
    const Tice = clamp01(Tm - clamp01(LAT_TILT_W * latIce + cold)), Ttundra = clamp01(Tm - clamp01(LAT_TILT_W * latTundra + cold));
    if (z !== 4 && !warmSummerD) { if (Tice < P.tempSnow) terrain = TERR.SNOW; else if (Ttundra < P.tempTundra) terrain = TERR.TUNDRA; }   // C (z===4) and warm-summer Dxa/Dxb never freeze
    return { terrain, plot, rgb, z, lat, kc };
  }
  /* water tiles touching land (on the active lattice's ring) are COAST, the rest OCEAN */
  function coastPass(tiles, W, H) {
    const ring = T.util.gridRing;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (tiles[y][x].plot !== PLOT.WATER) continue;
      let adj = false;
      for (const o of ring(y, H)) { const ny = y + o[1], nx = x + o[0]; if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue; if (tiles[ny][nx].plot !== PLOT.WATER) { adj = true; break; } }
      tiles[y][x].terrain = adj ? TERR.COAST : TERR.OCEAN;
    }
  }
  function classify(S) {
    const { W, H } = S, tiles = [];
    for (let ty = 0; ty < H; ty++) {
      const row = [];
      for (let tx = 0; tx < W; tx++) {
        const i = ty * W + tx;
        row.push(classifyTile(S.h[i], RELIEF_PLOT[S.relief[i]], [S.r[i], S.g[i], S.b[i]], S.lat[i], S.kc[i], S.land[i], S.white[i], S.surrArid[i], S.surrTemp[i], S.playa[i], S.moistJit[i]));
      }
      tiles.push(row);
    }
    coastPass(tiles, W, H);   // features come later (features()), once the river edges are known
    return { tiles };
  }

  /* ---------- features: forest / jungle / flood plains / oasis ----------
     Applied AFTER river edges are computed (flood plains need river adjacency). Placement mixes a climate prior
     (Koppen group), relief (hills cluster forest), satellite colour contrast against the local open-terrain mean,
     and a seeded random term; the re-roll button varies featSeed. Terrain gates follow Civ4 validity: jungle ->
     grassland only; forest -> grass/plains/tundra; flood plains & oasis -> flat desert (flood plains additionally
     require a river edge on the tile). */
  /* Special tiles: a river-corner tile (a river bending around one of its corners) gets ONE random bonus resource,
     on a terrain the bonus is valid on; the bonus is written to the WBS. */
  const CIV4_SPECIAL = { 'river-corner': [
    { bonus: 'BONUS_INCENSE' },                       // stays desert
    { bonus: 'BONUS_DYE' },                           // desert is fine (non-vanilla but valid, no crash)
    { bonus: 'BONUS_HORSE', terrain: TERR.PLAINS },   // "plains with horses"
    { bonus: 'BONUS_IVORY', terrain: TERR.PLAINS },   // "plains with ivory"
    { bonus: 'BONUS_WHEAT' }] };                      // desert is fine too
  function markSpecialTile(t, x, y, kind) {
    t.special = kind; t.feature = null;
    const opts = CIV4_SPECIAL[kind]; if (!opts) return;
    const pick = opts[Math.min(opts.length - 1, (T.util.fhash(x, y, featSeed + 4444) * opts.length) | 0)];   // seeded random bonus (varies on re-roll)
    t.bonus = pick.bonus; if (pick.terrain) t.terrain = pick.terrain;
  }
  function features(tiles, S, rivers) {
    const U = T.util, { W, H } = S, fhash = U.fhash;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x]; t.feature = null; t.fv = 0; t.special = null; t.bonus = null; }   // clear any prior features / special markers
    if (!P.feat) return;
    const N = W * H, hueA = new Float32Array(N), satA = new Float32Array(N), valA = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x], i = y * W + x, c = t.rgb || [128, 128, 128], hv = U.hsv(c[0], c[1], c[2]); hueA[i] = hv[0]; satA[i] = hv[1]; valA[i] = hv[2]; }
    const meanVal = (x, y, pred) => { let s = 0, n = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; const t = tiles[ny][nx]; if (!pred(t)) continue; s += valA[ny * W + nx]; n++; } return n ? s / n : -1; };   // local baseline value over same-family tiles
    const isDesert = t => t.terrain === TERR.DESERT;
    const oasisZoneOf = kc => (kc === 4 || kc === 5) ? 0 : (kc === 6 || kc === 7) ? 1 : 2;   // Koppen -> oasis zone: 0 true desert (BWh/BWk), 1 semi-arid steppe (BSh/BSk), 2 other
    const oasisGrid = new Uint8Array(N); const floodByZone = [0, 0, 0]; const oasisCands = [];   // oases deferred + capped PER zone
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const t = tiles[y][x], i = y * W + x;
      if (t.plot === PLOT.WATER || t.plot === PLOT.PEAK) continue;
      if (S.genPan && S.genPan[i]) continue;   // a generated salt pan stays bare (no flood plain, oasis or vegetation)
      const hue = hueA[i], sat = satA[i], val = valA[i], z = t.z, rnd = fhash(x, y, featSeed);
      // ---- flat desert: flood plains (on a river) else oasis ----
      if (isDesert(t) && t.plot === PLOT.FLAT) {
        const bv = meanVal(x, y, isDesert), bref = bv >= 0 ? bv : 0.72;                   // surrounding desert brightness
        const veg = (hue >= 70 && hue <= 170) ? 1 : (hue >= 52 && hue < 70 ? 0.4 : 0);     // green hue -> vegetated
        const darker = clamp01((bref - val) / 0.16);                                        // darker than nearby desert
        const green = clamp01(0.55 * darker + 0.75 * veg * clamp01(0.4 + darker));          // green/dark floodplain -> high
        const salt = (val >= SALT_VAL && sat <= SALT_SAT) ? clamp01((val - bref) / 0.16) * 0.55 + 0.2 : 0;   // white/salt floodplain -> lower
        const colour = Math.max(green, salt);
        const dis = U.tileRiverDischarge(rivers, x, y);
        if (dis >= 0) {
          const disN = clamp01((Math.log10(1 + Math.max(0, dis)) - 1) / 3);   // ~0 at 10 m3/s, ~1 at 10^4
          const det = clamp01(0.55 * colour + 0.45 * disN);
          const total = 0.8 * det + 0.2 * rnd;                                  // ~20% randomness in the score
          if (total >= P.fpThresh) { t.feature = 'FEATURE_FLOOD_PLAINS'; floodByZone[oasisZoneOf(t.kc || 0)]++; continue; }
          continue;   // on a river but below threshold: stays plain desert, not an oasis
        }
        const oScore = clamp01(0.5 * darker + 0.9 * ((hue >= 70 && hue <= 170) ? 1 : 0) * clamp01(0.3 + darker));   // wet/green desert spot (no river) -> oasis
        const oTotal = 0.8 * oScore + 0.2 * rnd;
        let coast = false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; if (tiles[ny][nx].plot === PLOT.WATER) coast = true; }   // oasis coast exclusion (3x3; the hex 6-ring packed them too densely)
        if (!coast && oTotal >= P.oasisThresh) {
          if (U.atRiverCorner(rivers, x, y, W, H)) { markSpecialTile(t, x, y, 'river-corner'); }   // river-corner tile -> special bonus, not counted against the oasis cap
          else { oasisCands.push({ i, x, y, s: oTotal, z: oasisZoneOf(t.kc || 0) }); }
        }
        continue;
      }
      const kc = t.kc || 0;   // raw Koppen class (1-30) drives the per-zone vegetation weights
      // ---- jungle: grassland only, per-Koppen weight (tropical + a little humid-subtropical fringe) ----
      if (t.terrain === TERR.GRASS) {
        const jw = JUNGLE_W[kc] || 0;
        if (jw > 0) {
          const bv = meanVal(x, y, tt => tt.terrain === TERR.GRASS), darker = clamp01(((bv >= 0 ? bv : val) - val) / 0.18);
          const p = jw * (1 + (t.plot === PLOT.HILLS ? 0.2 : 0) + 0.4 * darker);               // zone weight scaled by relief & darkness
          if (rnd < clamp01(p * 2 * P.jungleDens)) { t.feature = 'FEATURE_JUNGLE'; continue; }   // slider scales density (0.5 = natural)
        }
      }
      // ---- forest: grass / plains / tundra, per-Koppen weight (Csa & semidesert keep a slight chance) ----
      if (t.terrain === TERR.GRASS || t.terrain === TERR.PLAINS || t.terrain === TERR.TUNDRA) {
        const fw = FOREST_W[kc] || 0;
        if (fw > 0) {
          const tundra = (t.terrain === TERR.TUNDRA);
          let p = fw * (1 + (t.plot === PLOT.HILLS ? 0.35 : 0));                                   // forests cluster on rough ground
          if (tundra) { p *= (0.5 + clamp01((hue - TUNDRA_HUE) / (TAIGA_HUE - TUNDRA_HUE))); }      // greener -> taiga (open tundra browner)
          else { const bv = meanVal(x, y, tt => tt.terrain === t.terrain); p *= (1 + 0.5 * clamp01(((bv >= 0 ? bv : val) - val) / 0.2)); }   // darker than open land -> forest
          if (fhash(x, y, featSeed + 7) < clamp01(p * 2 * P.forestDens)) { t.feature = 'FEATURE_FOREST'; t.fv = (tundra || z === 5) ? 1 : 0; }
        }
        continue;
      }
    }
    // Cap oases PER Koppen zone at (base ratio x zone multiplier x that zone's flood-plain count), highest score first,
    // enforcing the 3x3 spacing exclusion as they're placed. A zone with no flood plains gets no oases.
    if (oasisCands.length) {
      oasisCands.sort((a, b) => b.s - a.s);
      const mult = [P.oasisMultDesert, P.oasisMultSemiArid, 1];
      const cap = [0, 1, 2].map(z => Math.round(P.oasisRatio * mult[z] * floodByZone[z]));
      const placed = [0, 0, 0];
      for (let c = 0; c < oasisCands.length; c++) {
        const o = oasisCands[c]; if (placed[o.z] >= cap[o.z]) continue; let adj = false;
        for (let dy = -1; dy <= 1 && !adj; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = o.x + dx, ny = o.y + dy; if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue; if (oasisGrid[ny * W + nx]) { adj = true; break; } }
        if (adj) continue;
        tiles[o.y][o.x].feature = 'FEATURE_OASIS'; oasisGrid[o.i] = 1; placed[o.z]++;
      }
    }
  }

  /* ---------- preview: colours, glyphs, legend ---------- */
  function tileColor(t) {
    let c = TCOLOR[t.terrain].slice();
    if (t.plot === PLOT.HILLS) c = c.map(v => v * 0.93); else if (t.plot === PLOT.PEAK) c = c.map(v => v * 0.84 + 12);
    if (t.feature === 'FEATURE_FOREST') c = [34, 95, 42]; else if (t.feature === 'FEATURE_JUNGLE') c = [18, 64, 26]; else if (t.feature === 'FEATURE_FLOOD_PLAINS') c = [154, 182, 66]; else if (t.feature === 'FEATURE_OASIS') c = [200, 188, 120];
    else if (t._salt && t.terrain === TERR.DESERT && t.plot !== PLOT.WATER) c = [232, 226, 208];   // salt pan (real playa or generated): the export writes plain desert, the preview shows the flat
    return c;
  }
  /* One character per tile, for the text grid the MCP bridge (mcp/) hands an agent: water is '~' ocean or ',' coast;
     land is its terrain letter (g p d t s), UPPERCASE on hills; a peak is '^' whatever the terrain; a feature wins
     over the terrain letter (f forest, j jungle, r flood plains, o oasis). Legend keys may be one char or a range. */
  const ASCII_TERR = { [TERR.GRASS]: 'g', [TERR.PLAINS]: 'p', [TERR.DESERT]: 'd', [TERR.TUNDRA]: 't', [TERR.SNOW]: 's' };
  const ASCII_FEAT = { FEATURE_FOREST: 'f', FEATURE_JUNGLE: 'j', FEATURE_FLOOD_PLAINS: 'r', FEATURE_OASIS: 'o' };
  function ascii(t) {
    if (t.plot === PLOT.WATER) return t.terrain === TERR.COAST ? ',' : '~';
    if (t.plot === PLOT.PEAK) return '^';
    const c = (t.feature && ASCII_FEAT[t.feature]) || ASCII_TERR[t.terrain] || '?';
    return t.plot === PLOT.HILLS ? c.toUpperCase() : c;
  }
  function asciiLegend() { return { '~': 'ocean', ',': 'coast', 'g': 'grass', 'p': 'plains', 'd': 'desert', 't': 'tundra', 's': 'snow', 'f': 'forest', 'j': 'jungle', 'r': 'flood plains', 'o': 'oasis', '^': 'peak', 'A-Z': 'hills (uppercase terrain letter)' }; }
  const relief = t => t.plot === PLOT.PEAK ? 2 : t.plot === PLOT.HILLS ? 1 : 0;
  /* Every glyph takes its target context `g`: the same grid is drawn to the live canvas, to snapshot thumbnails and to the compose canvas. */
  function drawHillGlyph(g, px, py, w, h) {   // rounded hill: a smooth hump, drawn as a neutral shadow so the terrain hue underneath still reads
    g.fillStyle = 'rgba(18,14,8,0.30)';
    g.beginPath(); g.moveTo(px + 0.14 * w, py + 0.74 * h); g.quadraticCurveTo(px + 0.5 * w, py + 0.30 * h, px + 0.86 * w, py + 0.74 * h); g.closePath(); g.fill();
  }
  function drawPeakGlyph(g, px, py, w, h, snowy) {   // mountain: a capital-lambda; snow cap only on cold terrain, else a rocky cap
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(38,30,22,0.9)'; g.lineWidth = Math.max(1, w * 0.14);
    g.beginPath(); g.moveTo(px + 0.22 * w, py + 0.80 * h); g.lineTo(px + 0.5 * w, py + 0.20 * h); g.lineTo(px + 0.78 * w, py + 0.80 * h); g.stroke();
    g.strokeStyle = snowy ? 'rgba(242,246,250,0.92)' : 'rgba(150,140,126,0.85)'; g.lineWidth = Math.max(1, w * 0.09);
    g.beginPath(); g.moveTo(px + 0.40 * w, py + 0.40 * h); g.lineTo(px + 0.5 * w, py + 0.20 * h); g.lineTo(px + 0.60 * w, py + 0.40 * h); g.stroke();
  }
  function drawBonusGlyph(g, px, py, w, h) {   // special (bonus) tile: a small gold resource diamond
    const cx = px + 0.5 * w, cy = py + 0.5 * h, r = Math.max(2, w * 0.16);
    g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath();
    g.fillStyle = 'rgba(240,205,70,0.95)'; g.fill();
    g.lineWidth = Math.max(1, w * 0.03); g.strokeStyle = 'rgba(90,60,10,0.9)'; g.stroke();
  }
  function drawPalmGlyph(g, px, py, w, h) {   // oasis: a little palm tree over a pool
    const cx = px + 0.5 * w, base = py + 0.80 * h, topY = py + 0.34 * h;
    g.lineCap = 'round';
    g.fillStyle = 'rgba(58,140,190,0.85)'; g.beginPath(); g.ellipse(cx, base + 0.06 * h, 0.20 * w, 0.07 * h, 0, 0, 7); g.fill();   // pool
    g.strokeStyle = 'rgba(74,52,28,0.95)'; g.lineWidth = Math.max(1, w * 0.09);
    g.beginPath(); g.moveTo(cx, base); g.lineTo(cx, topY); g.stroke();   // trunk
    g.strokeStyle = 'rgba(24,116,48,0.95)'; g.lineWidth = Math.max(1, w * 0.08);
    const fr = 0.30 * w, fronds = [[-1, -0.15], [1, -0.15], [-0.75, -0.7], [0.75, -0.7], [0, -1]];
    for (const f of fronds) { g.beginPath(); g.moveTo(cx, topY); g.quadraticCurveTo(cx + f[0] * fr * 0.5, topY + f[1] * fr * 0.3, cx + f[0] * fr, topY + f[1] * fr); g.stroke(); }   // fronds
  }
  function glyph(g, t, px, py, w, h) {
    if (t.feature === 'FEATURE_OASIS') drawPalmGlyph(g, px, py, w, h);
    if (t.special) drawBonusGlyph(g, px, py, w, h);
    if (t.plot === PLOT.HILLS) drawHillGlyph(g, px, py, w, h); else if (t.plot === PLOT.PEAK) drawPeakGlyph(g, px, py, w, h, t.terrain === TERR.SNOW || t.terrain === TERR.TUNDRA);
  }
  function legend() {
    const items = [['Ocean', TCOLOR[TERR.OCEAN]], ['Coast', TCOLOR[TERR.COAST]], ['Grass', TCOLOR[TERR.GRASS]], ['Plains', TCOLOR[TERR.PLAINS]], ['Desert', TCOLOR[TERR.DESERT]], ['Tundra', TCOLOR[TERR.TUNDRA]], ['Snow', TCOLOR[TERR.SNOW]]];
    if (P.feat) items.push(['Forest', [34, 95, 42]], ['Jungle', [18, 64, 26]], ['Flood plains', [154, 182, 66]], ['Oasis <span class="eyebrow-n">🌴</span>', [200, 188, 120]]);
    items.push(['Hills', null, '⌢'], ['Mountain', null, 'Λ']);   // the relief glyphs drawn over the tiles
    return items;
  }
  function worldSizeFor(W, H) { const n = W * H; if (n <= 40 * 24) return 'DUEL'; if (n <= 56 * 36) return 'TINY'; if (n <= 66 * 44) return 'SMALL'; if (n <= 84 * 52) return 'STANDARD'; if (n <= 104 * 64) return 'LARGE'; return 'HUGE'; }

  /* ---------- export: .CivBeyondSwordWBSave ---------- */
  function pickStarts(region, k) {
    const { tiles, W, H } = region, land = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tiles[y][x].plot !== PLOT.WATER && tiles[y][x].plot !== PLOT.PEAK) land.push([x, y]);
    const chosen = []; if (!land.length) return chosen;
    for (let i = 0; i < k; i++) { const idx = Math.floor((i + 0.5) / k * land.length) % land.length, [tx, ty] = land[idx]; chosen.push({ leader: LEADERS[i % LEADERS.length][0], civ: LEADERS[i % LEADERS.length][1], x: tx, y: (H - 1) - ty }); }
    return chosen;
  }
  function playersWanted() { const el = document.getElementById('np'); return Math.max(0, Math.min(12, parseInt(el && el.value) || 0)); }
  function build(region, ctx) {
    const players = pickStarts(region, playersWanted()), rivers = region.rivers;   // rivers are always written, even with the view toggle off; deselected channels were dropped upstream
    const text = window.Civ4WBS.serialize(region.tiles, { W: region.W, H: region.H, topLat: region.topLat, botLat: region.botLat, startYear: -4000, players, rivers, wrapX: region.wrapX || 0,
      description: 'Generated by Terra Form' + (ctx.mode === 'compose' ? ' (composed from ' + ctx.patches + ' snapshot' + (ctx.patches === 1 ? '' : 's') + ')' : '') + (ctx.hex ? ' (hex layout for Civ5 import)' : '') });   // wrap X only when the frame spans the full 360
    return { files: [{ name: ctx.baseName + '.CivBeyondSwordWBSave', data: text, mime: 'application/octet-stream' }], text, players };
  }
  function validate(region, built, ctx) {
    const { tiles, W, H } = region, text = built.text, players = built.players, rivers = region.rivers, want = W * H, got = (text.match(/BeginPlot/g) || []).length;
    let bad = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const t = tiles[y][x], isW = (t.terrain === TERR.OCEAN || t.terrain === TERR.COAST); if (isW !== (t.plot === PLOT.WATER)) bad++; }
    const wantEdges = rivers ? (rivers.nof.size + rivers.wof.size) : 0, gotEdges = (text.match(/isNOfRiver|isWOfRiver/g) || []).length;
    let waterRiver = 0; if (rivers) { const isW = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? true : tiles[y][x].plot === PLOT.WATER; for (const [k] of rivers.nof) { const p = k.split(','); if (isW(+p[1], +p[0]) && isW(+p[1], +p[0] + 1)) waterRiver++; } for (const [k] of rivers.wof) { const p = k.split(','); if (isW(+p[1], +p[0]) && isW(+p[1] + 1, +p[0])) waterRiver++; } }
    let bridged = 0; if (rivers) { for (const e of rivers.nof.values()) if (e.bridge) bridged++; for (const e of rivers.wof.values()) if (e.bridge) bridged++; }
    let fourSided = 0; if (rivers) { const { nof, wof } = rivers; const nb = (m, k) => !!m.get(k); for (let gy = 0; gy < H; gy++) for (let gx = 0; gx < W; gx++) { if (nb(nof, (gy - 1) + ',' + gx) && nb(nof, gy + ',' + gx) && nb(wof, gy + ',' + gx) && nb(wof, gy + ',' + (gx - 1))) fourSided++; } }   // rivers on all 4 sides of a tile: almost always a rasterization error
    return [['plots written = ' + W + '×' + H, got === want, got + ' / ' + want],
      ['land ↔ plot-type consistent', bad === 0, bad ? bad + ' mismatched' : 'all ' + want + ' ok'],
      ['river edges written', gotEdges === wantEdges, gotEdges + ' / ' + wantEdges + (wantEdges ? ' (' + ctx.riverN + ' rivers)' : '')],
      ['no river on all-water edge', waterRiver === 0, waterRiver ? waterRiver + ' bad' : 'ok'],
      ['no tile with rivers on all 4 sides', fourSided === 0, fourSided ? fourSided + ' tile(s)' : 'ok'],
      ['estuary bridges to open ocean', true, bridged + ' edge(s)'],
      ['starting plots on land', players.length === (parseInt(document.getElementById('np').value) || 0), players.length + ' placed'],   // the raw box value, so an out-of-range entry shows as a warning
      ['header + map block present', /BeginMap/.test(text) && /num plots written=/.test(text), 'ok']];
  }

  /* ---------- the panels this game adds to the inspector ---------- */
  const TC = { grass: 'rgba(92,138,74,.72)', plains: 'rgba(167,164,78,.72)', desert: 'rgba(203,181,111,.72)', tundra: 'rgba(128,138,114,.72)', snow: 'rgba(233,236,224,.72)' };
  const fmt2 = v => v.toFixed(2);
  const ui = {
    /* rail-level control (outside the panels, so it is visible with them collapsed): the features switch */
    rail: '<button type="button" class="feature-toggle" id="feat" aria-pressed="false" title="Include forests, jungles, flood plains, and oases in the map">Emit Features <span class="feature-state" aria-hidden="true">Off</span></button>',
    panels: [
      { section: 'base-terrain', title: 'Base Terrain',
        help: 'Moisture picks grass / plains / desert (steppe on brightness, iron-red arid soil on hue); bright white is read as salt or snow by the surrounding non-white climate (arid&rarr;salt, cold&rarr;snow). Temperature (Köppen zone, altitude, colour) plus a boreal cold tilt (latitude + tundra/taiga colour) and an alpine snow-cover tilt swap in tundra / snow.',
        html: '<div class="ctl"><div class="row"><label>Dryness &mdash; grass &middot; plains &middot; desert</label><span class="valx" id="vDry"></span></div><div id="drynessRange"></div></div>'
          + '<div class="ctl"><div class="row"><label>Boreal cold tilt &mdash; tundra &middot; ice <span class="eyebrow-n">temperature thresholds: below &rarr; tundra, further below &rarr; ice</span></label><span class="valx" id="vTemp"></span></div><div id="tempRange"></div></div>'
          + '<div class="ctl"><div class="row"><label>Latitude ramp &mdash; tundra &middot; ice <span class="eyebrow-n">tundra cold onset &middot; ice onset (latitude)</span></label><span class="valx" id="vBoreal"></span></div><div id="borealRange"></div></div>'
          + '<div class="ctl"><div class="row"><label for="alpine">Alpine cold <span class="eyebrow-n">satellite snow cover</span></label><span class="val" id="vAlpine"></span></div><input type="range" id="alpine" min="0" max="1" step="0.05" value="0.6"></div>'
          + '<div class="ctl"><div class="row"><label for="clim">Climate prior weight <span class="eyebrow-n">Köppen</span></label><span class="val" id="vClim"></span></div><input type="range" id="clim" min="0" max="1" step="0.02" value="0.45"></div>' },
      { section: 'features', title: 'Features',
        help: 'Forest &amp; jungle from climate, relief &amp; colour (potential/pre-industrial, not present cover); flood plains on flat desert along rivers (score = colour contrast + discharge + ~20% random); oasis in wet desert spots. Re-roll varies the seeded placement.',
        html: '<label class="toggle" style="font-size:12.5px;color:var(--paper)"><input type="checkbox" id="fpKoppen" checked> keep arid deserts <span class="eyebrow-n">Köppen &mdash; enables flood plains; off &rarr; colour gives plains/grass variety when zoomed in</span></label>'
          + '<div class="ctl" style="margin-top:8px"><div class="row"><label for="forestDens">Forest density</label><span class="val" id="vForest"></span></div><input type="range" id="forestDens" min="0" max="1" step="0.02" value="0.5"></div>'
          + '<div class="ctl"><div class="row"><label for="jungleDens">Jungle density</label><span class="val" id="vJungle"></span></div><input type="range" id="jungleDens" min="0" max="1" step="0.02" value="0.5"></div>'
          + '<div class="ctl"><div class="row"><label for="fpAmt">Flood-plain amount <span class="eyebrow-n">flat desert along rivers</span></label><span class="val" id="vFp"></span></div><input type="range" id="fpAmt" min="0" max="1" step="0.02" value="0.5"></div>'
          + '<div class="ctl"><div class="row"><label for="oasisDens">Oasis density <span class="eyebrow-n">base oasis : flood-plain ratio · ×10 desert, ×3 steppe</span></label><span class="val" id="vOasis"></span></div><input type="range" id="oasisDens" min="0" max="0.4" step="0.02" value="0.14"></div>'
          + '<button class="vbtn" id="reroll" title="Re-roll the seeded forest / jungle / flood-plain / oasis placement">⟳ re-roll features</button>' }],
    bind(api) {
      const $ = id => document.getElementById(id), commit = () => { ui.refresh(); api.invalidate(); };
      api.makeMultiSlider($('drynessRange'), { min: 0, max: 1, step: 0.01, values: [P.dryPlains, P.dryDesert], segMode: 'knots', segColors: [TC.grass, TC.plains, TC.desert], onInput: v => { P.dryPlains = v[0]; P.dryDesert = v[1]; commit(); } });
      /* temperature axis reads cold(left) -> hot(right); the two thumbs are the snow and tundra cutoffs */
      api.makeMultiSlider($('tempRange'), { min: 0, max: 1, step: 0.01, values: [P.tempSnow, P.tempTundra], segMode: 'knots', segColors: [TC.snow, TC.tundra, ''], onInput: v => { P.tempSnow = v[0]; P.tempTundra = v[1]; commit(); } });
      /* boreal axis reads equator(left) -> pole(right) */
      api.makeMultiSlider($('borealRange'), { min: 35, max: 95, step: 1, values: [P.latTundra, P.latIce], segMode: 'knots', segColors: ['', TC.tundra, TC.snow], onInput: v => { P.latTundra = v[0]; P.latIce = v[1]; commit(); } });
      $('alpine').addEventListener('input', e => { P.alpine = parseFloat(e.target.value); commit(); });
      $('clim').addEventListener('input', e => { P.clim = parseFloat(e.target.value); commit(); });
      $('feat').addEventListener('click', e => { P.feat = !P.feat; e.currentTarget.setAttribute('aria-pressed', String(P.feat)); e.currentTarget.querySelector('.feature-state').textContent = P.feat ? 'On' : 'Off'; api.legendChanged(); api.invalidate(); });
      $('fpKoppen').addEventListener('change', e => { P.fpKoppen = e.target.checked; api.invalidate(); });
      const fp = a => { P.fpThresh = 0.25 + 0.5 * Math.pow(1 - a, 2.2); P.oasisThresh = 0.42 - 0.18 * a; };   // curved flood-plain threshold; oasis density tied to the same slider
      fp(+$('fpAmt').value);
      $('fpAmt').addEventListener('input', e => { fp(+e.target.value); commit(); });
      $('forestDens').addEventListener('input', e => { P.forestDens = +e.target.value; commit(); });
      $('jungleDens').addEventListener('input', e => { P.jungleDens = +e.target.value; commit(); });
      $('oasisDens').addEventListener('input', e => { P.oasisRatio = +e.target.value; commit(); });   // oasis count capped at ratio x flood-plain tiles
      $('reroll').addEventListener('click', () => { featSeed = (Math.random() * 1e9) | 0; api.invalidate(); });
      ui.refresh();
    },
    refresh() {
      const $ = id => document.getElementById(id);
      $('vDry').innerHTML = 'plains <b>' + fmt2(P.dryPlains) + '</b> · desert <b>' + fmt2(P.dryDesert) + '</b>';
      $('vTemp').innerHTML = 'tundra <b>' + fmt2(P.tempTundra) + '</b> · ice <b>' + fmt2(P.tempSnow) + '</b>';
      $('vBoreal').innerHTML = 'tundra <b>' + Math.round(P.latTundra) + '°</b> · ice <b>' + Math.round(P.latIce) + '°</b>';
      $('vClim').textContent = P.clim.toFixed(2); $('vAlpine').textContent = P.alpine.toFixed(2);
      $('vFp').textContent = Math.round(+$('fpAmt').value * 100) + '%';
      $('vForest').textContent = Math.round(P.forestDens * 100) + '%'; $('vJungle').textContent = Math.round(P.jungleDens * 100) + '%';
      $('vOasis').textContent = P.oasisRatio.toFixed(2) + '×';
    }
  };

  const game = {
    id: 'civ4', name: 'Civilization IV',
    grid: { kind: 'square', min: { W: 8, H: 8 }, max: { W: 160, H: 120 }, default: { W: 52, H: 32 } },
    P, PLOT, TERR, TCOLOR,
    classify, features, finalize: coastPass,
    isWater: t => t.plot === PLOT.WATER,
    blankTile: kind => kind === 'barrier'
      ? { terrain: TERR.GRASS, plot: PLOT.PEAK, rgb: [96, 110, 86], z: 5, lat: 0, kc: 0, feature: null, fv: 0, special: null, bonus: null }
      : { terrain: TERR.OCEAN, plot: PLOT.WATER, rgb: [18, 58, 81], z: 5, lat: 0, kc: 0, feature: null, fv: 0, special: null, bonus: null },
    /* Generated features on the compose canvas (core/generate.js): a lake is water (coastPass re-derives coast vs
       ocean); a salt pan is flat desert with no feature, the same tile the classifier makes from a real playa. */
    paint(t, kind) {
      if (kind === 'lake') return Object.assign({ terrain: TERR.OCEAN, plot: PLOT.WATER, rgb: [18, 58, 81], z: (t && t.z) || 5, lat: (t && t.lat) || 0, kc: (t && t.kc) || 0, feature: null, fv: 0, special: null, bonus: null }, t && t._h != null ? { _h: t._h } : {});
      if (kind === 'lowland') return t && t.plot !== PLOT.WATER ? Object.assign({}, t, { plot: PLOT.FLAT, terrain: t.terrain === TERR.SNOW ? TERR.TUNDRA : t.terrain, feature: null, fv: 0, special: null, bonus: null, _salt: undefined, _h: 0.09 }) : null;
      if (kind === 'salt_pan') return Object.assign({}, t, { terrain: TERR.DESERT, plot: PLOT.FLAT, feature: null, fv: 0, special: null, bonus: null, _salt: 1 });
      return null;
    },
    validateTile(t) {
      if (!KNOWN_TERRAINS.has(t.terrain)) return 'unknown terrain "' + t.terrain + '"';
      if (!Number.isInteger(t.plot) || t.plot < 0 || t.plot > 3) return 'invalid plot value "' + t.plot + '" (expected 0..3)';
      if (t.feature != null && !KNOWN_FEATURES.has(t.feature)) return 'unknown feature "' + t.feature + '"';
      return null;
    },
    preview: { color: tileColor, glyph, legend, ascii, asciiLegend, relief, reliefLabels: ['flat', 'hills', 'peaks'] },
    sizeLabel: worldSizeFor,
    ui,
    export: {
      caption: 'CIV IV · WBS', ext: '.CivBeyondSwordWBSave', title: 'Generate a .CivBeyondSwordWBSave file',
      pickerType: { description: 'Civ4 WorldBuilder save', accept: { 'application/octet-stream': ['.CivBeyondSwordWBSave'] } },
      optionsHTML: '<div class="ctl" style="margin-top:0"><div class="row"><label for="np">Playable civs <span class="eyebrow-n">0 = random civs &amp; starts · else auto-placed on land</span></label></div><input class="numin" id="np" type="number" min="0" max="12" value="0"></div>',
      build, validate
    }
  };
  T.registerGame(game);
})();
