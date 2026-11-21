/* core/types.d.ts -- shared ambient declarations for Terra Form's browser code.
 *
 * Every browser file (core/*.ts, games/<id>/*.ts) is a CLASSIC SCRIPT: no import/export, one shared global
 * scope, loaded by <script src> in index.html. tsc treats such files as global scripts, so the types below are
 * visible everywhere without an import. This file declares the contracts that cross a file boundary:
 *
 *   - the window.TerraForm registry (core/registry.ts) and the game-module contract (games/README.md)
 *   - what the core hands a module: Samples, RiverEdges, Region, ExportCtx
 *   - the river-edge structures of core/rivers_core.ts and the Civ4 serializer's API (games/civ4/wbs_core.ts)
 *   - TerraForm.api, the entry points core/bridge.ts drives, and the bridge's wire messages (mcp/server.mts)
 *
 * Declarations only: nothing here is emitted.
 */

/* ---------- small shared shapes ---------- */
/** A colour as [r, g, b], 0..255 (not necessarily integer). */
type RGB = number[];
/** A point or offset as [x, y]. */
type XY = number[];
interface GridSize { W: number; H: number }
/** A lon/lat box in degrees. W > E crosses the antimeridian. */
interface LonLatBounds { W: number; S: number; E: number; N: number }
/** A rectangle in source-raster px (or tiles, on the compose canvas). */
interface Rect { x: number; y: number; w: number; h: number }
/** The viewer's frame: centre and width in source px, rotation in degrees (clockwise). */
interface FrameView { cx: number; cy: number; spanX: number; rot: number }

/* ---------- rivers (core/rivers_core.ts, mirrored in core/app.ts) ---------- */
/** A channel id: the river-tile `rid`, or a generated feature's id. */
type RiverId = number | string;
/** One river edge on the square lattice. dir: 0 N, 1 E, 2 S, 3 W (flow direction); d: discharge, m3/s. */
interface RiverEdge { dir: number; d: number; rid?: RiverId | null; bridge?: boolean }
/** Edges keyed 'row,col' (row 0 = north). */
type RiverEdgeMap = Map<string, RiverEdge>;
/** nof: the SOUTH edge of tile (col,row) (the tile is "north of the river"); wof: its EAST edge. */
interface RiverEdges { nof: RiverEdgeMap; wof: RiverEdgeMap }
type RiverEdgeKind = 'nof' | 'wof';
/** A centerline reach: l = polyline parts of [lon, lat] vertices; d = discharge; rid = its channel. */
interface RiverReach { d: number; rid?: RiverId | null; l: number[][][]; [extra: string]: any }
/** An axis-aligned lon/lat view (lonL < lonR, latT > latB). */
interface RiverView { lonL: number; lonR: number; latT: number; latB: number }
interface RiverProjOpts { WSRC: number; HSRC: number; rect: Rect; W: number; H: number; rot?: number; cx: number; cy: number }
/** (lon, lat) -> [fx, fy] grid coords; reset() starts a new polyline (see makeRiverProj). */
interface RiverProj { (lon: number, lat: number): number[]; reset(): void }
type RiverEdgeOk = (m: RiverEdgeKind, key: string) => boolean;
/** One side of a tile as a key into nof / wof (nudgeRiverEdges). */
interface RiverEdgeRef { s: 'N' | 'E' | 'S' | 'W'; m: RiverEdgeKind; key: string }
/** Per-channel accumulator of reachesToEdges: signed traversal count + max discharge per lattice edge. */
interface RiverChan { NH: Map<string, { n: number; d: number }>; VE: Map<string, { n: number; d: number }>; rid: RiverId | null | undefined }
interface RiversCoreApi {
  reachesToEdges(reaches: RiverReach[], view: RiverView, W: number, H: number, proj?: RiverProj | null): RiverEdges;
  makeRiverProj(o: RiverProjOpts): RiverProj;
  plotRiverLines(nof: RiverEdgeMap, wof: RiverEdgeMap, gx: number, civY: number, H: number): string[];
  nudgeRiverEdges(nof: RiverEdgeMap, wof: RiverEdgeMap, W: number, H: number, edgeOk?: RiverEdgeOk | null): void;
}

/* ---------- what the core hands a game module ---------- */
/** The framed region on the game's grid: one entry per tile, row-major, row 0 north (games/README.md). */
interface Samples {
  W: number; H: number;
  /** height, 0..1 on the RG16 scale (TerraForm.util.heightMetres) */
  h: Float32Array;
  /** normalised roughness at the viewer's smoothing halo */
  rough: Float32Array;
  reliefHill: Float32Array; reliefPeak: Float32Array;
  /** 0 flat, 1 hills, 2 peak; 0 on water */
  relief: Uint8Array;
  /** 1 land, 0 water */
  land: Uint8Array;
  landFrac: Float32Array;
  /** dominant Köppen class 1..30, 0 none */
  kc: Uint8Array;
  r: Float32Array; g: Float32Array; b: Float32Array;
  white: Float32Array; playa: Float32Array; lat: Float32Array; polar: Float32Array;
  surrArid: Float32Array; surrTemp: Float32Array;
  moistJit: Float64Array;
  /** 1 where a generated salt pan covers the tile (core/generate.ts) */
  genPan?: Uint8Array;
}
/** Core fields on every classified tile, whatever the game. */
interface CoreTileFields {
  /** mean height (RG16 0..1), for the compose canvas' generators */
  _h?: number;
  /** land that is mostly salt pan */
  _salt?: number;
  /** id of the foreign game a pasted tile came from */
  _g?: string;
}
/** A tile of some game: the module's own object plus the core fields. The core never reads a game's vocabulary. */
type Tile = CoreTileFields & { [field: string]: any };
interface GameGrid { kind: 'square' | 'hex'; min: GridSize; max: GridSize; default: GridSize; step?: number }
interface ClassifyCtx { W: number; H: number; hex: boolean; grid: GameGrid }
/** The evaluated frame, or the composed canvas (core/app.ts composeRegion), given to export.build / validate.
 *  A composed canvas has no geography: the fields marked "frame only" are absent and the latitudes are nominal. */
interface Region<T = Tile> {
  tiles: T[][]; W: number; H: number;
  /** the river edges selected for serialization */
  rivers: RiverEdges;
  /** latitude of the top / bottom row, degrees (the export header) */
  topLat: number; botLat: number;
  /** 1 when the frame spans the full 360 degrees */
  wrapX: number;
  /** id of the game that made the tiles */
  game: string;
  /** frame only: tile counts from the samples */
  land?: number; hills?: number; peaks?: number;
  /** frame only */
  samples?: Samples;
  /** frame only: lon/lat box of the (rotated: bounding) frame */
  bounds?: LonLatBounds;
  /** frame only */
  frame?: FrameView;
  /** frame only: the lattice the tiles were evaluated on */
  hex?: boolean;
}
interface ExportCtx { mode: 'frame' | 'compose'; hex: boolean; riverN: number; patches: number; baseName: string }
interface ExportFile { name: string; data: string | Blob; mime: string }
/** A game's export: the files, an optional sub-folder, and whatever the module's validate() wants back. */
interface Built { files: ExportFile[]; dir?: string; [extra: string]: any }
type ValidationRow = [label: string, ok: boolean, detail: string];
/** A legend swatch, or a text glyph instead of a colour. */
type LegendItem = [label: string, color: RGB | null, glyph?: string];

/* ---------- the game-module contract (games/README.md) ---------- */
interface MultiSliderOpts {
  min: number; max: number; step?: number; values: number[];
  segColors?: string[] | null; thumbColors?: string[] | null;
  segMode?: 'knots' | 'centers'; independent?: boolean;
  onInput?: (values: number[], index: number) => void;
}
interface MultiSlider { get(): number[]; set(values: number[]): void }
/** What a game's ui.bind / export.bindOptions get. */
interface UiApi {
  makeMultiSlider(el: HTMLElement, opts: MultiSliderOpts): MultiSlider;
  invalidate(): void; rerender(): void; legendChanged(): void; refreshStats(): void;
}
interface GamePanel { section: string; title: string; help?: string; html: string }
interface GameUI {
  rail?: string; panels?: GamePanel[];
  bind?(api: UiApi): void; refresh?(): void;
  /** set by TerraForm.mountPanels */
  __key?: string;
}
interface GamePreview<T = Tile> {
  color(t: T): RGB;
  glyph?(g: CanvasRenderingContext2D, t: T, px: number, py: number, w: number, h: number): void;
  legend(): LegendItem[];
  ascii?(t: T): string;
  asciiLegend?(): Record<string, string>;
  relief?(t: T): number;
  reliefLabels?: string[];
}
interface GameExport<T = Tile, B extends Built = Built> {
  caption?: string; ext?: string; title?: string;
  pickerType?: { description: string; accept: Record<string, string[]> };
  optionsHTML?: string;
  bindOptions?(api: UiApi): void;
  build(region: Region<T>, ctx: ExportCtx): B | Promise<B>;
  validate?(region: Region<T>, built: B, ctx: ExportCtx): ValidationRow[];
  note?(region: Region<T>, ctx: ExportCtx): string;
}
interface GameModule<T = Tile, B extends Built = Built> {
  id: string; name: string;
  grid: GameGrid;
  classify(S: Samples, ctx: ClassifyCtx): { tiles: T[][] };
  features?(tiles: T[][], S: Samples, rivers: RiverEdges, ctx: ClassifyCtx): void;
  finalize?(tiles: T[][], W: number, H: number): void;
  isWater(t: T): boolean;
  blankTile(kind: 'water' | 'barrier'): T;
  paint?(t: T | null | undefined, kind: string): T | null;
  validateTile?(t: T): string | null;
  preview: GamePreview<T>;
  sizeLabel?(W: number, H: number): string;
  ui?: GameUI;
  export: GameExport<T, B>;
  /** the module's tunables, read and set by name through the MCP bridge's `tune` */
  P?: Record<string, any>;
}

/* ---------- window.TerraForm ---------- */
/** Helpers the core installs for the modules (core/app.ts); read at call time, never at load time. */
interface TerraFormUtil {
  clamp01(v: number): number;
  hsv(r: number, g: number, b: number): number[];
  fhash(x: number, y: number, seed: number): number;
  vnoise(x: number, y: number): number;
  classGroup(kc: number): number;
  KOPPEN_KEYS: (string | null)[];
  KOPPEN_TEMP: number[];
  KOPPEN_PALETTE: RGB[];
  BECK2018: Record<string, RGB>;
  colorAridity(hue: number, sat: number, val: number): number;
  latOf(sy: number): number;
  lonOf(sx: number): number;
  wrapLon(lon: number): number;
  heightMetres(h: number): number;
  elevColor(h: number): RGB;
  elevColorSea(h: number): RGB;
  tileRiverDischarge(rivers: RiverEdges | null | undefined, x: number, y: number): number;
  atRiverCorner(rivers: RiverEdges | null | undefined, x: number, y: number, W: number, H: number): boolean;
  gridRing(y: number, H: number): number[][];
  hexShiftX(y: number, H: number): number;
  isShoreAt(tiles: Tile[][], W: number, H: number, x: number, y: number): boolean;
}
interface TerraFormRegistry {
  games: Record<string, GameModule<any, any>>;
  order: string[];
  util: TerraFormUtil;
  ui: Record<string, any>;
  /** the active module */
  game: GameModule<any, any> | null;
  registerGame<T, B extends Built>(m: GameModule<T, B>): GameModule<T, B>;
  mountPanels(): void;
  /** installed by core/app.ts (its last statement); driven by core/bridge.ts */
  api: TerraFormApi;
  /** installed by core/generate.ts: the hydrology helpers the generators and the sculpt pathway share */
  hydro: TerraFormHydro;
  /** installed by core/climate.ts: the physical climate model for synthetic terrain */
  climate: TerraFormClimate;
  /** installed by core/landforms.ts: describe / lint / connectors for the MCP bridge */
  landforms: TerraFormLandforms;
  /** installed by core/bridge.ts when the page may connect to an MCP server */
  bridge?: TerraFormBridge;
}
declare var TerraForm: TerraFormRegistry;
declare var RiversCore: RiversCoreApi;

/* ---------- core internals shared by core/*.ts ---------- */
/** A colour ramp: [position 0..1, colour] stops in ascending order. */
type Ramp = [t: number, rgb: RGB][];
/** A polygon of a vector layer (coast, lakes, playas, Köppen zones): r = rings of [lon, lat] (holes by even-odd),
 *  b = [lonMin, latMin, lonMax, latMax]; v = Köppen class on a zone polygon. */
interface GeoPoly { r: number[][][]; b: number[]; v?: number; [extra: string]: any }
interface PolySet { polys: GeoPoly[]; [extra: string]: any }
/** The smoothed roughness field: sw x sh cells, each k source px wide. */
interface RoughField { data: Float32Array; sw: number; sh: number; k: number }
/** A selection mask (box or lasso): world-pinned (source px) in the geographic viewers, tile-pinned on the compose canvas. */
interface SelectionMask { kind: string; pts: number[][]; frame?: boolean; [extra: string]: any }
/** River edges as JSON-able entry lists (a snapshot's form of RiverEdges). */
interface RiverEntries { nof: [string, RiverEdge][]; wof: [string, RiverEdge][] }
/** A captured region on the shelf ('terra-form-snapshot' v1). tiles: flat row-major (2-D in old files). */
interface Snapshot {
  v: number; kind: string; id: string; name: string;
  W: number; H: number; hex: boolean;
  /** id of the game that made the tiles (absent in snapshots predating game modules: Civ4, or Civ5 when hex) */
  game?: string;
  topLat: number; botLat: number;
  frame: FrameView; createdAt: number;
  tiles: any[];
  rivers: RiverEntries;
  /** mask fill tiles (flat indices) and the ones among them that were land; absent on generated snapshots */
  cut?: number[] | null; cutLand?: number[] | null;
  thumb: any;
  [extra: string]: any;
}
/** A snapshot placed on the compose canvas. */
interface ComposePatch {
  id: number; snap: Snapshot; x: number; y: number; landOnly: boolean;
  /** flat snapshot tile indices not to stamp / local river-edge keys to drop (bridge edits) */
  skip?: Set<number> | null; riverSkip?: Set<string> | null; editGen?: number;
  [extra: string]: any;
}
/** The compose canvas: its size, the placed patches (bottom to top), the erased tiles, bridge-declared metadata. */
interface ComposeState {
  W: number; H: number; patches: ComposePatch[]; sel: number | null; nextId: number;
  erased: Set<any>; eraseGen: number;
  riverGen?: number; riverAdd?: any[];
  latTop?: number | null; latBot?: number | null; targetLand?: number[] | null; degPerTile?: number | null;
  [extra: string]: any;
}
/** A vector-tile layer (coast / lake): its folder under data/, the loaded index, and the decoded-tile cache. */
interface VTLayer { dir: string; meta: any; cache: Map<string, any> }
/** Tile <-> canvas-pixel geometry of a drawn grid (core/app.ts civGridGeometry). s: the hex side (hex lattice only). */
interface GridGeo { hex: boolean; tw: number; th: number; s: number; ox: number; oy: number }

/* ---------- generated features (core/generate.ts) ----------
 * core/generate.ts hangs these on window; core/app.ts calls them behind `typeof x === 'function'`, so the app
 * still runs when that script is not loaded. */
declare var genApplySamples: ((lf: Float32Array, pA: Float32Array, W: number, H: number, R: Rect) => Uint8Array | null) | undefined;
declare var genReaches: (() => RiverReach[]) | undefined;
declare var genSig: (() => string) | undefined;
declare var genApplyCompose: ((tiles: Tile[][], nof: RiverEdgeMap, wof: RiverEdgeMap, W: number, H: number) => void) | undefined;
declare var genComposeSig: (() => string) | undefined;

/* ---------- DOM lookups (a deliberate loosening, in one place) ----------
 * The app's UI code addresses the page's controls by id and reads whichever members that control has
 * (el.value, el.checked, canvas.getContext('2d') ...), assigns numbers to .value / .min / .max and lets the DOM
 * stringify them, and reads e.target.value in its listeners. Every id it asks for is in index.html or is mounted
 * from a game module's ui.panels before core/app.ts runs, so the lookups do not return null in practice.
 * Rather than a cast at each of ~120 call sites, document.getElementById is typed once to return UIElement:
 * a present element carrying the members the app uses, with the stringly ones typed `any`. Its listeners get a
 * UIEvt, whose target is that element. Code that wants the precise DOM type still casts (the game modules do).
 */
interface UIElement extends HTMLElement {
  /** string per the DOM; the app also assigns numbers and lets the DOM stringify them */
  value: any; min: any; max: any; step: any;
  checked: boolean; disabled: boolean; open: boolean; placeholder: string;
  type: string; defaultChecked: boolean; defaultValue: string;
  /** <canvas> */
  width: number; height: number;
  getContext(contextId: '2d', options?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
  toDataURL(type?: string, quality?: number): string;
  /** <select> */
  selectedIndex: number;
  /* the first overload is the one the app's inline listeners resolve to; the second keeps UIElement a proper HTMLElement */
  addEventListener(type: string, listener: (ev: UIEvt) => any, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (ev: UIEvt) => any, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}
/** An event from a UIElement listener: pointer / wheel / keyboard members, and the control it fired on as its target. */
interface UIEvt extends PointerEvent {
  target: UIElement; currentTarget: UIElement;
  deltaX: number; deltaY: number; deltaMode: number;
  key: string; code: string; repeat: boolean;
}
interface Document { getElementById(elementId: string): UIElement }
interface Window {
  /** optional override of the bridge's WebSocket URL (default ws://127.0.0.1:<?mcp= port or 8765>/terraform) */
  TERRAFORM_BRIDGE_URL?: string;
}
/** File System Access API (Chromium / WebView2; not in lib.dom). The app feature-tests both before calling them. */
interface Window { showDirectoryPicker(options?: any): Promise<any>; showSaveFilePicker(options?: any): Promise<any> }

/* ---------- TerraForm.api (core/app.ts -> core/bridge.ts) ---------- */
/** TerraForm.api.state(): what the page is showing. */
interface AppState {
  mode: string; game: string; games: string[]; hex: boolean;
  W: number; H: number; effH: number;
  view: FrameView; bounds: LonLatBounds;
  /** the default tile: 'ocean' | 'peak' (the Mountain-fill toggle) */
  fill: string;
  selection: string | null; shelf: number;
  compose: { W: number; H: number; patches: number; erased: number };
  /** tile fetches in flight for the current view */
  pending: number;
}
/** The core's own tunables, by the names the MCP `tune` tool uses. */
interface CoreParams {
  islandBias: number; seawayBias: number; islandExpand: number; expandSteep: number; expandMaxMult: number;
  roughHalo: number; mtnPass: number; flatSpots: number; coastThr: number; nudgeX: number; nudgeY: number;
  riverN: number; riverEstuaries: boolean;
  hill: number; peak: number; blendHill: number; blendPeak: number;
  fill: string;
}
/** What buildExport returns: the module, the region it exported, the built files and the validation rows. */
interface ExportResult { g: GameModule<any, any>; region: Region; ctx: ExportCtx; built: Built; rows: ValidationRow[]; note: string }
/** The entry points core/bridge.ts drives: thin wrappers over the app's own functions, each leaving the page as the
 *  same clicks would. Installed by the last statement of core/app.ts. */
interface TerraFormApi {
  WSRC: number; HSRC: number; WRAP_PX: number; HALO_LOG_MIN: number;
  lonOf(sx: number): number; latOf(sy: number): number; wrapLon(lon: number): number;
  state(): AppState;
  /** the base load chain (elevation, Köppen, colour, coast, lakes) has finished */
  ready(): boolean;
  loadsPending(): number;
  render(): void;
  setGame(id: string): void;
  setMode(m: string): void;
  setSize(W?: number | null, H?: number | null): void;
  setView(v: Partial<FrameView>): void;
  evaluate(): Region;
  params(): CoreParams;
  setRelief(o: { hill?: number; peak?: number; blendHill?: number; blendPeak?: number }): void;
  setFill(kind: string): void;
  /** masks: world-pinned, in source px */
  getWorldSelection(): SelectionMask | null;
  setWorldSelection(s: SelectionMask | null): void;
  capture(name?: string | null): Snapshot;
  tiles2D(snap: Snapshot): Tile[][];
  shelf: {
    list(): Snapshot[]; get(id: string): Snapshot | null;
    save(snap: Snapshot): Promise<any>; remove(id: string): Promise<any>; rename(id: string, name: string): Promise<any>;
  };
  compose: {
    state(): ComposeState;
    composite(): { tiles: Tile[][]; rivers: RiverEdges; W: number; H: number };
    stats(): any;
    region(): Region;
    patchById(id: number | null | undefined): ComposePatch | null;
    setSize(W: number, H: number): void;
    clear(): void;
    add(snap: Snapshot, x: number, y: number, landOnly?: boolean): ComposePatch;
    move(id: number, x: number, y: number): boolean;
    remove(id: number): boolean; raise(id: number): boolean; lower(id: number): boolean;
    setLandOnly(id: number, on: boolean): boolean;
    select(id: number | null): void;
    /** inclusive tile rect; returns the number of tiles erased */
    eraseRect(x0: number, y0: number, x1: number, y1: number): number;
    unerase(): void;
    setLatitudes(top: number | null | undefined, bot: number | null | undefined): void;
    setBudget(lo: number | null | undefined, hi: number | null | undefined): void;
    setScale(deg: number | null | undefined): void;
    setSkip(id: number, idx: number[] | null): boolean;
    setRiverSkip(id: number, keys: string[] | null): boolean;
    /** [[kind 'n' | 'w', 'gy,gx', {dir, d, rid}], ...] in canvas tiles; returns the count now held */
    addRivers(ents: any[]): number;
    clearAddedRivers(): void;
  };
  thumb(snap: Snapshot, maxPx?: number): any;
  newId(): string;
  export(name?: string | null): Promise<ExportResult>;
  writeFiles(built: Built): Promise<void>;
  destHint(): string;
  isWater(t: Tile): boolean;
  gridRing(y: number, H: number): number[][];
  hexShiftX(y: number, H: number): number;
  /** the frame rect in source px, plus the sampling nudge */
  frameRect(): Rect & { nudgeX: number; nudgeY: number };
  frameToWorld(fx: number, fy: number): number[];
  /** installed by core/generate.ts once TerraForm.api exists: generated lakes / salt pans / rivers on either pathway */
  gen?: any;
  /** installed by core/sculpt.ts once TerraForm.api exists: the sculpt pathway */
  sculpt?: any;
}

/* ---------- TerraForm.hydro (core/generate.ts): hydrology on a height grid, shared with core/sculpt.ts ---------- */
/** A binary min-heap keyed by number (core/generate.ts Heap: a constructor function with prototype methods). */
interface MinHeap { k: number[]; v: any[]; push(key: number, val: any): void; pop(): any; readonly size: number }
type MinHeapCtor = new () => MinHeap;
/** A generated feature (lake, salt pan, river, painted area...): on a frame it is world-pinned (lon/lat rings or
 *  reaches), on the compose canvas tile-pinned. info is what the MCP bridge reports back. */
interface GenFeature {
  id: string; kind: string; name?: string | null; info: Record<string, any>;
  parent?: string; rid?: RiverId; bbox?: number[]; lonCentre?: number;
  rings?: any; reaches?: RiverReach[];
  [extra: string]: any;
}
interface TerraFormHydro {
  /** priority-flood depression filling: filled heights, each cell's receiver, the flood order */
  priorityFlood(h: ArrayLike<number>, W: number, H: number, isOutlet: (i: number) => boolean, blocked: ArrayLike<number> | null, edgeOutlets: boolean): any;
  pathLengths(PF: any, W: number): any;
  basinOf(PF: any, h: ArrayLike<number>, W: number, H: number, seed: number): number[];
  descend(h: ArrayLike<number>, W: number, H: number, seed: number, blocked: ArrayLike<number> | null): number;
  fillBasin(h: ArrayLike<number>, W: number, H: number, seed: number, area: number, blocked: ArrayLike<number> | null, compact: number): any;
  maskRings(mask: ArrayLike<number>, W: number, H: number): number[][][];
  chaikin(pts: number[][], iters: number, closed: boolean): number[][];
  riverLine(path: number[], W: number, meander: number, seed: number): number[][];
  /** the heap's constructor function; construct with `new (hydro.Heap as unknown as MinHeapCtor)()` */
  Heap: (this: MinHeap) => void;
}

/* ---------- TerraForm.climate (core/climate.ts): a physical climate model for synthetic terrain ---------- */
/** A synthetic world: per-tile land flag and elevation (metres above sea), row-major, row 0 north. */
interface ClimateGrid {
  W: number; H: number; land: ArrayLike<number>; elev: ArrayLike<number>;
  /** latitude of row y, degrees */
  lat(y: number): number;
  kmPerTile?: number; seed?: number;
  /** relief class per tile (0 flat, 1 hills, 2 peak), needed by buildSamples */
  relief?: ArrayLike<number>;
}
/** Per tile: mean / warmest / coldest month temperature (deg C), precipitation (mm/yr), Köppen class, dry season (1 summer, 2 winter). */
interface ClimateResult { T: Float32Array; warm: Float32Array; cold: Float32Array; P: Float32Array; kc: Uint8Array; seasonal: Uint8Array; distKm: Float32Array }
interface ReliefThresholds { hill?: number; peak?: number; hillRange?: number; peakRange?: number }
interface ClimateSummary { overall: string; byBand: { band: string; mix: string }[]; landTiles: number }
interface TerraFormClimate {
  run(grid: ClimateGrid, opts?: { wetness?: number }): ClimateResult;
  /** per-tile samples, as the core's sampleRegion makes them, from a synthetic grid */
  buildSamples(g: ClimateGrid, C: ClimateResult): Samples;
  reliefOf(W: number, H: number, elev: ArrayLike<number>, land: ArrayLike<number>, range: ArrayLike<number>, o?: ReliefThresholds): Uint8Array;
  /** mean real-Earth satellite colour of each Köppen class */
  palette(): RGB[];
  summary(grid: ClimateGrid, C: { kc: ArrayLike<number> }): ClimateSummary;
}

/* ---------- TerraForm.landforms (core/landforms.ts): describe / lint / connectors for the MCP bridge ---------- */
/** The neighbour offsets [dx, dy] of row y on the active lattice (8-ring, or the hex 6-ring of that row). */
type LatticeRing = (y: number) => number[][];
/** A connected component of a tile mask: id 1..n by size, bbox [x0, y0, x1, y1], centroid, flat tile indices. */
interface LandComponent { id: number; size: number; bbox: number[]; cx: number; cy: number; tiles: number[] }
/** How core/landforms.ts reads a tile grid without knowing the game: accessors built by the bridge (lfCtx)
 *  from the active module's preview hooks, plus the river edges and, on the compose canvas, the patch owner map. */
interface LandformCtx {
  isWater(t: Tile): boolean;
  /** 0 flat, 1 hills, 2 peak */
  relief(t: Tile): number;
  /** Köppen class of a tile, 0 unknown */
  kc(t: Tile): number;
  /** Köppen class -> group 0..5 (TerraForm.util.classGroup) */
  group(kc: number): number;
  ring: LatticeRing;
  rivers: RiverEdges | RiverEntries | null;
  /** compose canvas: the patch id that stamped each tile (0 none) */
  owner: Int32Array | null;
  /** metres, or null when the game's tiles carry no height */
  height(t: Tile): number | null;
  latOfRow: ((y: number) => number) | null;
  climateAdjacency: any;
  hex: boolean;
  riverTiles: Set<any>;
  [extra: string]: any;
}
/** One seam-lint finding. */
interface LintWarning { rule: string; at: number[]; n: number; msg: string; patches?: any[]; [extra: string]: any }
interface TerraFormLandforms {
  /** the landform report of a tile grid (landmasses, straits, bays, spines, seas, rivers, a prose summary); JSON-able */
  describe(tiles: Tile[][], W: number, H: number, ctx: LandformCtx, opts?: any): Record<string, any>;
  /** a one-line digest of a describe() report */
  brief(R: Record<string, any>): string;
  lint(tiles: Tile[][], W: number, H: number, ctx: LandformCtx, only?: string | string[]): LintWarning[];
  /** what each edge and corner of a piece offers to a neighbour (land share, relief, climate, river exits) */
  connectors(tiles: Tile[][], W: number, H: number, ctx: LandformCtx): Record<string, any>;
  riverAnalysis(tiles: Tile[][], W: number, H: number, ctx: LandformCtx): Record<string, any>;
  rules: { name: string; [extra: string]: any }[];
  /** Köppen group names, by classGroup index */
  GROUP: string[];
  components(mask: ArrayLike<number>, W: number, H: number, ring: LatticeRing, minSize?: number): { labels: Int32Array; list: LandComponent[]; all: LandComponent[] };
  distanceFrom(src: ArrayLike<number>, W: number, H: number, ring: LatticeRing, limit?: number | null): { dist: Int32Array; near: Int32Array };
  /** the landform codebook (data/landform/), fetched on first use */
  loadCodebook(url?: string): Promise<any>;
  codebook(): any;
  bandFor(cb: any, deg: number): any;
  assignCodes(tiles: Tile[][], W: number, H: number, ctx: LandformCtx, degPerTile: number, cb: any, opts?: any): any;
  codeGlyph(code: any): string;
  codeSummary(A: any, cb: any, landLabels: ArrayLike<number>, landmasses: any[], W: number, H: number): any;
  codeSentence(cs: any): string;
  CODE_GLYPHS: Record<string, string>; KIND_GLYPHS: Record<string, string>;
}

/* ---------- TerraForm.bridge (core/bridge.ts); the wire messages are in core/bridge-protocol.d.ts ---------- */
/** One bridge command: runs in the page with the app's own functions and returns a JSON-able result. */
type BridgeCommand = (args?: any) => any;
interface TerraFormBridge { url: string; connected(): boolean; commands: Record<string, BridgeCommand> }
