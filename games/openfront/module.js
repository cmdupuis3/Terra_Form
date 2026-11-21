/* games/openfront/module.js -- OpenFront (openfront.io) for Terra Form's viewer.
 *
 * An OpenFront map is a pixel map: every tile is water or land, and land carries a magnitude 0..30 that the
 * game reads as plains (< 10), highland (< 20) or mountain. This module previews that classification on the
 * framed region and exports the map generator's input -- image.png in OpenFront's own palette (water blue
 * 106, land blue = 140 + 2 * magnitude) plus info.json -- for a quick look. The production path is the
 * Python exporter beside this file (export_openfront.py): it reads the fine elevation tiles at the generator's
 * 2-3 M tile target, cuts rivers, lifts desert along the valley rule and places nations from the gazetteer.
 * The classifier here is the same square-root-of-elevation curve as the Python one (anchors fitted to
 * OpenFront's World map), so the preview tells you what the exporter will do with the frame.
 */
(function () {
    "use strict";
    const T = window.TerraForm;
    const WATER_BLUE = 106;
    const P = { plainsTop: 250, highlandTop: 1000, mountainTop: 2250, desert: false, desertMag: 12 }; // metres; --plains-top/--highland-top/--mountain-top and --desert of export_openfront.py
    const DESERT_HIGHLAND_M = 50; // --desert: the sqrt ramp reaches highland (10) at this height
    /* magnitude 0..30 from metres: square-root scale through the band anchors, floored so the plains and highland
       bands end exactly at their anchors; land at or below sea level is plains 0 (export_openfront.magnitude) */
    function magnitude(m) {
        const p = Math.sqrt(P.plainsTop), mm = Math.sqrt(P.highlandTop), t = Math.sqrt(P.mountainTop), s = Math.sqrt(Math.max(0, m));
        const mag = s < p ? 10 * s / p : s < mm ? 10 + 10 * (s - p) / (mm - p) : 20 + 10 * (s - mm) / (t - mm);
        return Math.max(0, Math.min(30, Math.floor(mag)));
    }
    function desertFloor(m) {
        // the least magnitude a BW desert tile takes: a sqrt ramp from 0 at sea level, capped at desertMag
        return Math.min(P.desertMag, Math.floor(10 * Math.sqrt(Math.max(0, m) / DESERT_HIGHLAND_M)));
    }
    function landRGB(mag) {
        // OpenFront's map palette for a land magnitude (its shipped image.png files use exactly these)
        if (mag < 10)
            return [190, 220 - 2 * mag, 140 + 2 * mag];
        if (mag < 20)
            return [200 + 2 * mag, 183 + 2 * mag, 140 + 2 * mag];
        return [230 + (mag >> 1), 230 + (mag >> 1), 140 + 2 * mag];
    }
    function classify(S) {
        const { W, H } = S, U = T.util, tiles = [];
        for (let y = 0; y < H; y++) {
            const row = [];
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!S.land[i]) {
                    row.push({ water: true, mag: 0 });
                    continue;
                }
                const m = U.heightMetres(S.h[i]);
                let mag = magnitude(m);
                if (P.desert && (S.kc[i] === 4 || S.kc[i] === 5))
                    mag = Math.max(mag, desertFloor(m)); // Koppen BW: desert drawn as rough ground (the Python exporter also spares big river valleys)
                row.push({ water: false, mag, m: Math.round(m) });
            }
            tiles.push(row);
        }
        return { tiles };
    }
    const band = (t) => t.mag < 10 ? 'plains' : t.mag < 20 ? 'highland' : 'mountain';
    /* text grid for the MCP bridge (mcp/): '~' water; land by magnitude band -- plains 0..9 as digits, highland 10..19 as a..j, mountain 20..30 as A..K */
    const ascii = (t) => t.water ? '~' : t.mag < 10 ? String(t.mag) : t.mag < 20 ? String.fromCharCode(97 + t.mag - 10) : String.fromCharCode(65 + t.mag - 20);
    const asciiLegend = () => ({ '~': 'water', '0-9': 'plains (magnitude 0-9)', 'a-j': 'highland (10-19)', 'A-K': 'mountain (20-30)' });
    const relief = (t) => t.water ? 0 : t.mag < 10 ? 0 : t.mag < 20 ? 1 : 2;
    /* ---------- export: image.png + info.json (OpenFront's map-generator/assets/maps/<id>/) ---------- */
    function mapId(name) {
        // export_openfront.map_id: fold (strip combining marks, lowercase), then UpperCamelCase the words
        const words = (name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) || []);
        let id = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
        if (!id || !/^[A-Za-z]/.test(id))
            id = 'Map' + id;
        return id;
    }
    function pngBlob(tiles, W, H) {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
                const t = tiles[y][x], o = (y * W + x) * 4, rgb = t.water ? [0, 0, WATER_BLUE] : landRGB(t.mag);
                d[o] = rgb[0];
                d[o + 1] = rgb[1];
                d[o + 2] = rgb[2];
                d[o + 3] = 255;
            }
        g.putImageData(img, 0, 0);
        return new Promise(res => c.toBlob(res, 'image/png'));
    }
    async function build(region, ctx) {
        const W = region.W - (region.W % 4), H = region.H - (region.H % 4); // the generator crops to multiples of 4; crop here so info.json coordinates stay honest
        const tiles = region.tiles.slice(0, H).map(r => r.slice(0, W));
        const nameEl = document.getElementById('ofName'), name = (nameEl && nameEl.value.trim()) || ctx.baseName, id = mapId(name);
        const info = { id, name, translation_key: 'map.' + id.toLowerCase(), categories: [region.wrapX ? 'world' : 'continental'], multiplayer_frequency: 1, nations: [] };
        let land = 0;
        for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++)
                if (!tiles[y][x].water)
                    land++;
        return { dir: id.toLowerCase(), files: [{ name: 'image.png', data: await pngBlob(tiles, W, H), mime: 'image/png' }, { name: 'info.json', data: JSON.stringify(info, null, 2) + '\n', mime: 'application/json' }],
            W, H, land, cropped: (W !== region.W || H !== region.H) };
    }
    function validate(region, built) {
        const n = built.W * built.H;
        return [['image is a multiple of 4 on both sides', true, built.W + '×' + built.H + (built.cropped ? ' (cropped from ' + region.W + '×' + region.H + ')' : '')],
            ['tile count vs the generator’s 2–3 M target', n >= 2e6 && n <= 3e6, (n / 1e6).toFixed(2) + ' M' + (n < 2e6 ? ' — a preview size; use export_openfront.py for the real map' : '')],
            ['land share', built.land > 0, Math.round(built.land / n * 100) + '% land'],
            ['nations', false, 'none placed here — export_openfront.py places them from the gazetteer']];
    }
    function note(region) {
        const b = region.bounds;
        return b ? 'Same frame with the Python exporter: python games/openfront/export_openfront.py --bounds ' + [b.W, b.S, b.E, b.N].map(v => +v.toFixed(3)).join(' ') + ' --name "<name>" --out <folder>' : '';
    }
    const ui = {
        panels: [{ section: 'openfront-terrain', title: 'OpenFront terrain',
                help: 'Magnitude follows elevation on a square-root scale through three anchors fitted to OpenFront’s World map: plains below the first, highland below the second, 30 from the third. Desert (Köppen BW) can be lifted to mid-rough ground the way OpenFront’s desert maps draw it.',
                html: '<div class="grid2"><div class="ctl"><div class="row"><label for="ofPlains">Plains top <span class="eyebrow-n">m</span></label></div><input class="numin" id="ofPlains" type="number" min="1" max="5000" step="10" value="250"></div>'
                    + '<div class="ctl"><div class="row"><label for="ofHighland">Highland top <span class="eyebrow-n">m</span></label></div><input class="numin" id="ofHighland" type="number" min="2" max="8000" step="10" value="1000"></div></div>'
                    + '<div class="ctl"><div class="row"><label for="ofMountain">Magnitude 30 from <span class="eyebrow-n">m</span></label></div><input class="numin" id="ofMountain" type="number" min="3" max="9000" step="10" value="2250"></div>'
                    + '<label class="toggle" style="margin-top:6px"><input type="checkbox" id="ofDesert"> desert as rough ground <span class="eyebrow-n">Köppen BW ≥ magnitude</span></label>'
                    + '<div class="ctl"><div class="row"><label for="ofDesertMag">Desert floor magnitude</label></div><input class="numin" id="ofDesertMag" type="number" min="10" max="19" step="1" value="12"></div>' }],
        bind(api) {
            const $ = (id) => document.getElementById(id);
            const num = (id, key, lo, hi) => $(id).addEventListener('input', e => { const v = parseFloat(e.target.value); if (!isNaN(v)) {
                P[key] = Math.max(lo, Math.min(hi, v));
                api.invalidate();
            } });
            num('ofPlains', 'plainsTop', 1, 5000);
            num('ofHighland', 'highlandTop', 2, 8000);
            num('ofMountain', 'mountainTop', 3, 9000);
            num('ofDesertMag', 'desertMag', 10, 19);
            $('ofDesert').addEventListener('change', e => { P.desert = e.target.checked; api.invalidate(); });
        }
    };
    T.registerGame({
        id: 'openfront', name: 'OpenFront',
        grid: { kind: 'square', min: { W: 16, H: 16 }, max: { W: 512, H: 512 }, default: { W: 320, H: 200 }, step: 4 }, // a preview size: the viewer re-evaluates every tile on each pan; the real 2-3 M tile map comes from export_openfront.py
        P,
        classify,
        isWater: t => !!t.water,
        blankTile: kind => kind === 'barrier' ? { water: false, mag: 30 } : { water: true, mag: 0 },
        validateTile(t) { if (typeof t.water !== 'boolean')
            return 'missing water flag'; if (!t.water && !(Number.isInteger(t.mag) && t.mag >= 0 && t.mag <= 30))
            return 'magnitude must be 0..30'; return null; },
        preview: {
            color: t => t.water ? [0, 0, WATER_BLUE] : landRGB(t.mag),
            legend: () => [['Water', [0, 0, WATER_BLUE]], ['Plains', landRGB(4)], ['Highland', landRGB(14)], ['Mountain', landRGB(26)]],
            ascii, asciiLegend, relief, reliefLabels: ['plains', 'highland', 'mountain']
        },
        sizeLabel: (W, H) => W * H >= 1e5 ? (W * H / 1e6).toFixed(2) + ' M tiles' : (W * H).toLocaleString() + ' tiles (preview)',
        ui,
        export: { caption: 'OPENFRONT · PNG', ext: '', title: 'Write image.png + info.json for OpenFront’s map generator',
            optionsHTML: '<div class="ctl" style="margin-top:0"><div class="row"><label for="ofName">Map name <span class="eyebrow-n">id and folder follow from it</span></label></div><input class="numin" id="ofName" type="text" value="" placeholder="e.g. Aegean Sea" spellcheck="false"></div>',
            build, validate, note }
    });
})();
