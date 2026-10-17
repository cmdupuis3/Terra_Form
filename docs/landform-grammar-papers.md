# Landform grammar: literature notes

Papers whose ideas transfer to the Terra Form MCP's "landform grammar" (describe pass, seam lint,
typed catalog with edge connectors). Compiled 2026-10-16 by a web search agent; citations were checked
against search metadata from two sources and, where noted, the abstract page. Items marked *(inferred)*
are our transfer, not the paper's claim. Several ACM/PDF pages returned 403, so a few "idea" lines rest
on abstracts plus background knowledge: Karth & Smith, Mawhorter & Mateas, Zhou et al., Alaka & Bidarra.
Check the Cohen et al. DOI on ACM before citing it.

Parts: **D** = describe, **L** = seam lint, **C** = catalog + operators.

## Ranked list

1. **Mawhorter & Mateas (2010), "Procedural Level Generation Using Occupancy-Regulated Extension," IEEE CIG.**
   Hand-authored chunks carry typed anchor points; the generator selects a context, filters compatible chunks,
   integrates one. **C, L.** Almost exactly `attach(A.edge, B.edge)`: a real region is a chunk, connectors are
   anchors, compatibility is a filter. Take the catalog schema (anchor type, position along edge, tolerance)
   and the select-filter-integrate loop, with the LLM as selector.
   https://www.cs.hmc.edu/~pmawhorter/research/papers/procedural_level_generation_using_occupancy_regulated_extension-Mawhorter_Mateas-2010.pdf

2. **Karth & Smith (2017), "WaveFunctionCollapse is Constraint Solving in the Wild," FDG. doi:10.1145/3102071.3110566.**
   WFC (Gumin 2016) recast as constraint solving over adjacency rules learned from an exemplar. **C, L.**
   Mine allowed (terrain, climate, relief) adjacencies from real snapshots and use them as an allow-list; a
   "contradiction" is a precise lint signal with coordinates. Tile-adjacency vs overlapping-pattern modes map
   to 1-tile connectors vs N-tile seam windows. Warns that pure local adjacency misses global structure,
   which is what the describe pass is for. https://escholarship.org/uc/item/3rm1w0mn

3. **Jasiewicz & Stepinski (2013), "Geomorphons," Geomorphology 182:147-156. doi:10.1016/j.geomorph.2012.11.005.**
   Per cell, compare elevation along 8 lines of sight to get a ternary pattern; 498 patterns map to 10 forms
   (peak, ridge, spur, slope, hollow, valley, pit, ...). **D.** Scale-free, derivative-free, a few lines of code
   on the tile grid with relief/height as elevation; forms read directly as glyphs. Lookback radius ~5-10 tiles.
   https://www.geomorphometry.org/uploads/pdf/pdf2013/Jasiewicz2013geomorphometry.pdf

4. **Zhou, Sun, Turk & Rehg (2007), "Terrain Synthesis from Digital Elevation Models," IEEE TVCG 13(4):834-848.**
   Real DEM patches placed under a feature map, joined by graph cut and Poisson editing, placed feature-first.
   **L, C.** Seam cost = mismatch (relief, terrain, climate) summed over an overlap strip; the min-cut path says
   where a ragged seam should run instead of a straight cut; attach mountain pieces before lowland fill.
   https://faculty.cc.gatech.edu/~turk/my_papers/terrain_synth_tvcg.pdf

5. **Argudo, Galin, Peytavie, Paris, Gain & Guérin (2019), "Orometry-based Terrain Analysis and Synthesis," ACM TOG 38(6).**
   Ranges characterised by a peak-saddle graph (dominance, prominence, isolation). **D, L.** A mountain spine is
   a chain of prominent peaks linked by saddles, more robust than thresholding; a truncated wall is a spine
   that ends at a seam where the orometric signature changes sharply.
   https://perso.liris.cnrs.fr/aparis/public_html/projects/argudo2019_Orometry.html

6. **Cohen, Shade, Hiller & Deussen (2003), "Wang Tiles for Image and Texture Generation," ACM TOG 22(3):287-294.**
   Edge-coloured square tiles matched by colour. **C.** Connector type = edge colour. Completeness: to attach
   freely, every needed colour combination must exist. Catalog lint: count supply/demand per connector type
   and flag types with no partner piece.
   https://graphics.uni-konstanz.de/publikationen/Cohen2003WangTilesImage/index.html

7. **Lagae, *Wang Tiles in Computer Graphics* (Morgan & Claypool, 2009); Lagae, Kari & Dutré (2006), "Aperiodic Sets of Square Tiles with Colored Corners," KU Leuven TR.**
   Corner tiles colour corners, not edges. **C, L.** Pieces meet at corners as well as edges; corner typing
   avoids the diagonal mismatch at 4-way junctions. Also covers how many tiles a complete set needs.
   https://www.springer.com/book/9783031795367

8. **Merrell (2007), "Example-Based Model Synthesis," I3D (doi:10.1145/1230100.1230119); Merrell & Manocha (2010), IEEE TVCG; Merrell (2023), "Example-Based Procedural Modeling Using Graph Grammars," ACM TOG 42(4) (doi:10.1145/3592119).**
   Local-neighbourhood adjacency learned from a small example (WFC's ancestor); the 2023 paper extracts a graph
   grammar automatically. **C, L.** "Similar locally to some exemplar" is the legitimacy test for a seam; the
   graph-grammar paper is the closest match to deriving the grammar from real pieces on a region-adjacency graph.
   https://paulmerrell.org/research/

9. **Dormans (2010), "Adventures in Level Design," PCG Workshop, FDG. doi:10.1145/1814256.1814257.**
   Mission (graph grammar) separated from space. **C.** Put gameplay structure (chokepoints, starts, resources)
   on the landmass/strait graph that describe already emits, then fit geography to it.
   https://www.pcgworkshop.com/archive/dormans2010adventures.pdf

10. **Ai et al. (2014), "A Simplification of Ria Coastline with Geomorphologic Characteristics Preserved," Marine Geodesy 37(2). doi:10.1080/01490419.2014.903215.**
    Hierarchical estuary tree from a constrained Delaunay triangulation of the sea polygon. **D.** A skeleton
    (Delaunay or distance transform) of the water yields bays and straits as tree branches; the same on land
    yields isthmuses and peninsulas. Closest published match for the coastal thread.
    https://www.tandfonline.com/doi/abs/10.1080/01490419.2014.903215

11. **Beck et al. (2018), "Present and future Köppen-Geiger climate classification maps at 1-km resolution," Sci. Data 5:180214. doi:10.1038/sdata.2018.214.**
    **L** *(inferred)*: count how often each Köppen class borders each other in the real raster (we already ship
    the 2023 successor); a joined edge whose class pair is rare in reality is the climate-jump flag. Game-side
    counterpart: Dwarf Fortress adjusts rainfall for rain shadows after elevation is fixed
    (https://dwarffortresswiki.org/index.php/World_generation). https://pmc.ncbi.nlm.nih.gov/articles/PMC6207062

12. **Guérin et al. (2017), "Interactive Example-Based Terrain Authoring with Conditional GANs," ACM TOG 36(6):228. doi:10.1145/3130800.3130804.**
    **C.** Sketch-conditioned fill could heal a seam strip between two real pieces. Heavy for tile scale; later option.
    https://perso.liris.cnrs.fr/eguerin/new/blog/interactive-example-based-terrain-authoring-with-conditional-generative-adversarial-networks/

13. **Alaka & Bidarra (2023), "Hierarchical Semantic Wave Function Collapse," FDG. doi:10.1145/3582437.3587209.**
    WFC with abstract tiles that resolve to concrete children. **C, L.** Two-level catalog: coarse region type,
    then concrete piece; check compatibility and climate lint at the coarse level first.
    https://graphics.tudelft.nl/Publications-new/2023/AB23

14. **Génevaux, Galin, Guérin, Peytavie & Beneš (2013), "Terrain Generation Using Procedural Models Based on Hydrology," ACM TOG 32(4):143. doi:10.1145/2461912.2461996.**
    Terrain from a drainage graph. **L.** Model river edges as a drainage graph; every path must end at sea or a
    basin, and junction directions must agree across a seam. https://hal.archives-ouvertes.fr/hal-01339224

15. **Weiss (2001), "Topographic Position and Landforms Analysis," ESRI UC poster; Drăguţ & Eisank (2012), Geomorphology 141-142:21-33. doi:10.1016/j.geomorph.2011.12.001.**
    **D.** TPI (cell minus neighbourhood mean at several radii) is the 5-line fallback to geomorphons; Drăguţ &
    Eisank's variance-based scale selection helps pick radii for 60x40 vs 128x80 grids.
    https://pmc.ncbi.nlm.nih.gov/articles/PMC3312788

## Top three, in short

- **Mawhorter & Mateas**: the whole design reduces to assembling trusted chunks through typed anchors, which they
  built and evaluated in a game. Gives the catalog schema and the attach loop.
- **Karth & Smith**: the "learn constraints from exemplars" move, declarative enough that each violation can be
  reported to the agent as a named rule with coordinates rather than a score.
- **Jasiewicz & Stepinski**: a cheap, scale-aware vocabulary (ridge, spur, hollow, pit, peak) from relief alone,
  directly usable as glyphs; combine with the orometry peak-saddle graph for spines as chains.

## Skip

- Picture/array grammars (Stiny & Gips 1972; matrix and tiling-system grammars): no practical recognition results
  on map-like data. Split grammars (Wonka 2003) and CGA shape (Müller 2006) assume orthogonal subdivision.
- Togelius PCG survey/book, Smith & Whitehead expressive range: evaluation background only. Smith & Mateas ASP
  (TCIAIG 2011) is a viable but heavy lint encoding.
- Cordonnier et al. tectonics/erosion, Cortial et al. planets, Tasse et al.: generation; our pieces are real.
  Only the analysis halves (orometry, hydrology) apply.
- Shoreline extraction from imagery: different problem. No dedicated paper found on naming bays/peninsulas/isthmuses
  from a land mask; use Ai et al. plus textbook morphology (hull deficiency, open/close, distance-transform skeleton).
- Patel's polygonal map generation and the Caves of Qud writeups: nothing beyond the DF rain-shadow note.
