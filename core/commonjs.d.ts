/* core/commonjs.d.ts -- the one Node global the dual browser/Node files test for.
 *
 * core/rivers_core.ts and games/civ4/wbs_core.ts end with
 *     if (typeof module !== "undefined" && module.exports) module.exports = api; else root.X = api;
 * so the same emitted file loads as a <script> and through require() (the tests). The browser project has no
 * @types/node; this declares just enough for that line. (The test project uses @types/node instead and does
 * not include this file.)
 */
declare var module: { exports: any } | undefined;
