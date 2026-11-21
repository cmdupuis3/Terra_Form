/* core/registry.ts -- window.TerraForm, the game registry. Loaded first, before the game modules.
 *
 * Terra Form (core/app.ts) samples the real world into per-tile measurements; a game module turns them into
 * that game's tiles, draws its preview and writes its map file. Each module registers itself with
 * TerraForm.registerGame(); add your own game by dropping a games/<id>/module.ts and listing its compiled
 * script in index.html. Contract: games/README.md; types: core/types.d.ts.
 */
window.TerraForm = (function () {
    const T = { games: Object.create(null), order: [], util: {}, ui: {}, game: null,
        registerGame(m) {
            const need = ['id', 'grid', 'classify', 'export', 'isWater', 'blankTile', 'preview'], miss = need.filter(k => !m || m[k] == null);
            if (miss.length)
                throw new Error('TerraForm.registerGame: a game needs ' + miss.join(', '));
            for (const k of ['min', 'max', 'default'])
                if (!m.grid[k] || !(m.grid[k].W > 0 && m.grid[k].H > 0))
                    throw new Error('TerraForm.registerGame(' + m.id + '): grid.' + k + ' must give W and H');
            if (typeof m.preview.color !== 'function' || typeof m.preview.legend !== 'function')
                throw new Error('TerraForm.registerGame(' + m.id + '): preview needs color(t) and legend()');
            if (typeof m.export.build !== 'function')
                throw new Error('TerraForm.registerGame(' + m.id + '): export needs build(region, ctx)');
            if (!(m.id in T.games))
                T.order.push(m.id);
            T.games[m.id] = m;
            return m;
        },
        /* Mount every distinct ui.panels set into #gamePanels (Civ4 and Civ5 share one). Runs before the app script so the
           panels exist when the inspector's disclosure persistence and the rail logic look for .panel[data-section]. */
        mountPanels() {
            const host = document.getElementById('gamePanels');
            if (!host)
                return;
            const seen = new Map();
            let n = 0;
            for (const id of T.order) {
                const ui = T.games[id].ui;
                if (!ui || !(ui.panels || ui.rail) || seen.has(ui))
                    continue;
                const key = 'ui' + (n++);
                seen.set(ui, key);
                ui.__key = key;
                if (ui.rail) {
                    const d = document.createElement('div');
                    d.dataset.rail = 'none';
                    d.dataset.gameUi = key;
                    d.hidden = true;
                    d.innerHTML = ui.rail;
                    host.appendChild(d);
                } // rail-level controls (outside any panel), e.g. Civ4's Emit Features toggle
                for (const p of ui.panels || []) {
                    const d = document.createElement('details');
                    d.className = 'panel';
                    d.dataset.rail = 'none';
                    d.dataset.section = p.section;
                    d.dataset.gameUi = key;
                    d.hidden = true;
                    d.innerHTML = '<summary><h2>' + p.title + '</h2></summary><div class="panel-body">' + (p.help ? '<details class="panel-help"><summary>About these controls</summary><p class="sub">' + p.help + '</p></details>' : '') + p.html + '</div>';
                    host.appendChild(d);
                }
            }
        } };
    return T; // the core scripts install the rest (util, api, hydro, climate, landforms, bridge) as they load
})();
