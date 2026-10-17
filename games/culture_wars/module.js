/* games/culture_wars/module.js -- Culture Wars (local Unity project, WIP) for Terra Form's viewer.
 *
 * Culture Wars reads a *world pack*: equirectangular rasters of the raw layers (elevation, land mask, Koppen,
 * rivers) plus vector rivers and salt pans, written by export_world_pack.py beside this file at any lon/lat
 * frame and pixel density. There is no terrain classification in between -- the game does that itself -- so
 * this module is a frame picker: it previews the raw layers the pack will carry (water, elevation tint,
 * Koppen class) on the chosen grid and exports a frame.json with the bounds and size, together with the
 * exporter command that produces the pack. The grid is square; the default matches the working density.
 */
(function () {
  "use strict";
  const T = window.TerraForm;
  const WATER = [26, 52, 86];

  function classify(S) {
    const { W, H } = S, U = T.util, tiles = [];
    for (let y = 0; y < H; y++) {
      const row = [];
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        row.push(S.land[i] ? { water: false, m: Math.round(U.heightMetres(S.h[i])), h: S.h[i], kc: S.kc[i], relief: S.relief[i] } : { water: true, m: 0, h: S.h[i], kc: 0, relief: 0 });
      }
      tiles.push(row);
    }
    return { tiles };
  }
  function color(t) {
    if (t.water) return WATER;
    const c = T.util.elevColor(t.h);   // the viewer's hypsometric ramp, so the preview reads like the Elevation view
    return t.relief === 2 ? c.map(v => v * 0.8 + 20) : t.relief === 1 ? c.map(v => v * 0.92) : c;
  }
  async function build(region, ctx) {
    const b = region.bounds || {};
    const frame = { game: 'culture_wars', name: ctx.baseName, bounds: b, width: region.W, height: region.H, hex: false,
      rotation: (region.frame && region.frame.rot) || 0,
      ppd: b.E != null ? region.W / (((b.E - b.W) % 360 + 360) % 360 || 360) : null,
      command: command(region, ctx) };
    return { files: [{ name: ctx.baseName + '.frame.json', data: JSON.stringify(frame, null, 2) + '\n', mime: 'application/json' }], frame };
  }
  function command(region, ctx) {
    const b = region.bounds; if (!b) return '';
    return 'python games/culture_wars/export_world_pack.py --bounds ' + [b.W, b.S, b.E, b.N].map(v => +v.toFixed(3)).join(' ') + ' --width ' + region.W + ' --out <WorldPacks/' + ((ctx && ctx.baseName) || 'pack') + '>';
  }
  function validate(region, built) {
    const f = built.frame, rot = Math.abs(f.rotation) > 1e-6;
    let land = 0; for (const row of region.tiles) for (const t of row) if (!t.water) land++;
    return [['frame bounds written', !!region.bounds, region.bounds ? [region.bounds.W, region.bounds.S, region.bounds.E, region.bounds.N].map(v => v.toFixed(2)).join(' / ') : 'none'],
      ['no rotation (the pack exporter is north-up)', !rot, rot ? f.rotation.toFixed(1) + '° — the exporter takes the unrotated bounding box' : 'north-up'],
      ['pixel density', true, f.ppd ? f.ppd.toFixed(2) + ' px/deg (working grid 11.38)' : '—'],
      ['land share of the preview', land > 0, Math.round(land / (region.W * region.H) * 100) + '%']];
  }
  T.registerGame({
    id: 'culture_wars', name: 'Culture Wars (world pack frame)',
    grid: { kind: 'square', min: { W: 16, H: 16 }, max: { W: 512, H: 512 }, default: { W: 256, H: 128 }, step: 4 },   // a preview size; the pack itself is written by export_world_pack.py at any density
    classify,
    isWater: t => !!t.water,
    blankTile: kind => kind === 'barrier' ? { water: false, m: 3000, h: 0.54, kc: 0, relief: 2 } : { water: true, m: 0, h: 0.05, kc: 0, relief: 0 },
    validateTile(t) { return typeof t.water === 'boolean' ? null : 'missing water flag'; },
    preview: { color, legend: () => [['Water', WATER], ['Lowland', T.util.elevColor(0.1)], ['Upland', T.util.elevColor(0.3)], ['Mountain', T.util.elevColor(0.6)]] },
    sizeLabel: (W, H) => (W * H / 1e3).toFixed(0) + ' k px',
    export: { caption: 'CULTURE WARS · FRAME', ext: '.frame.json', title: 'Write the frame (bounds, size) for export_world_pack.py',
      build, validate, note: command }
  });
})();
