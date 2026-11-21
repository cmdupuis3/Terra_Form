/* games/civ4/types.d.ts -- Civilization IV tile shapes (ambient; see core/types.d.ts for how these are shared). */

/** What the serializer reads from a tile (games/civ4/wbs_core.ts). plot: 0 peak, 1 hills, 2 flat, 3 water. */
interface Civ4Plot {
  terrain: string;
  plot: number;
  feature?: string | null;
  /** FeatureVariety */
  fv?: number;
  /** 'BONUS_*' from a special-tile rule */
  bonus?: string | null;
}
/** A Civ4 tile as the classifier makes it (games/civ4/module.ts). */
interface Civ4Tile extends Civ4Plot, CoreTileFields {
  /** mean satellite colour of the footprint */
  rgb?: RGB;
  /** Köppen group (TerraForm.util.classGroup) */
  z?: number;
  lat?: number;
  /** Köppen class 1..30 */
  kc?: number;
  /** special-tile marker, e.g. 'river-corner' */
  special?: string | null;
}
interface Civ4Player { leader: string; civ: string; x: number; y: number }
interface Civ4SerializeOpts {
  W: number; H: number; topLat: number; botLat: number;
  /** x, y already in Civ (south-origin) coords */
  players?: Civ4Player[];
  rivers?: RiverEdges | null;
  startYear?: number;
  wrapX?: number | boolean;
  description?: string;
  randomizeResources?: boolean;
  /** seats written when players is empty */
  placeholderPlayers?: number;
}
interface Civ4WBSApi {
  worldSizeFor(W: number, H: number): string;
  plotRiverLines(nof: RiverEdgeMap, wof: RiverEdgeMap, gx: number, civY: number, H: number): string[];
  serialize(grid: Civ4Plot[][], opts: Civ4SerializeOpts): string;
}
declare var Civ4WBS: Civ4WBSApi;
/** What Civ4's export.build returns: the save text and the placed players ride along for validate(). */
interface Civ4Built extends Built { text: string; players: Civ4Player[] }
