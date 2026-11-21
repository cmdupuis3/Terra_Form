/* games/civ5/module.js -- Civilization V for Terra Form.
 *
 * Civ5 imports a Civ4 WorldBuilder save by placing square plot (x,y) on its hex plot (x,y): odd rows (in
 * Civ5's south-origin count) sit half a tile east and rows are sqrt(3)/2 apart. So this game IS the Civ4
 * module -- same classifier, same features, same .CivBeyondSwordWBSave -- evaluated on the hex lattice:
 * the core samples shifted rows half a tile east, uses the 0.866 row pitch for the frame and runs every
 * adjacency (coast ring, chokepoints) on the hex 6-neighbourhood. Rivers stay on the square lattice (Civ5's
 * importer converts them). The Base Terrain / Features panels are shared with Civ4 (same ui object).
 */
(function () {
    "use strict";
    const T = window.TerraForm, civ4 = T.games.civ4;
    if (!civ4)
        throw new Error('games/civ5/module.js must load after games/civ4/module.js');
    T.registerGame(Object.assign({}, civ4, {
        id: 'civ5', name: 'Civilization V (hex, via Civ4 import)',
        grid: { kind: 'hex', min: { W: 8, H: 8 }, max: { W: 160, H: 120 }, default: { W: 52, H: 32 } },
        export: Object.assign({}, civ4.export, { caption: 'CIV V · HEX · WBS', title: 'Generate a .CivBeyondSwordWBSave laid out for Civ5 import' })
    }));
})();
