# Terra Form

Convert real-world geographic data into viable Civilization maps. Frame a
region in the viewer, tune the tile classification, and export.

Currently targeting Civilization 4 maps, and Civilization 5 by way of its Civ 4 map import.

This app uses real elevation, coastline, lake, climate zone, river, and satellite maps.


## Run it

On Windows, run `TerraForm.exe`, keeping it next to `index.html` and `data/`. The release zip's
exe runs as is; the copy in the repository needs the .NET 7 Desktop Runtime. Anywhere else, run
`python serve.py` to open the app in a browser.

- **View** - Drag to pan, scroll to zoom, Ctrl+drag to rotate. The viewer aspect is locked to
  the output grid, so what you frame is exactly what gets sampled into tiles. Switch between
  satellite, elevation, roughness, climate, and the Civ tile preview.
- **Tune** - Numerous options are included to fine tune how the real data is interpreted.
  What results in nice maps in one part of the world may yield poor results somewhere else.
  Control terrain roughness, dryness, amplify small islands for emphasis, and so on.
- **Compose** - Capture framed regions as snapshots, then arrange them on a blank canvas to
  build a map out of pieces from anywhere on Earth.
- **Export** - Writes a `.CivBeyondSwordWBSave` and runs a validator.

## Panel Options

### Output grid

- Width / Height: The size of the map in tiles. Lock the aspect ratio to scale both together.
- Game: Civilization IV (square tiles) or Civilization V (hex tiles). The Civ 5 option writes
  the same Civ 4 save, sampled on the hex layout Civ 5 gives it on import.

### Coast & Seas

- Island Bias: Show more islands; this tends to give small islands a tile when they otherwise
  would be interpreted as seas.
- Seaway Bias: Open up more narrow channels, great for fjords.
- Small Island Expander: Scale smaller islands up to balance them against larger islands.
  Steepness and max × shape how quickly, and how far, the small ones grow.

### Elevation

- Roughness smoothing: Higher smoothing creates more clustered hills and mountains.
- Relief basis: The proportion of elevation to roughness used to distribute hills and mountains.
  High roughness basis prioritizes edges of mountain ranges: good for high plateaus.
- Relief thresholds: The elevation/roughness threshold for hills and mountains.
- Mountain passes: Demote peaks to hills where a range would otherwise be a solid wall.
- Flat spots: Leave some flat tiles in rough terrain.

### Base Terrain

- Dryness: Thresholds for grassland, plains, and desert tiles.
- Boreal cold tilt: Tilt tiles colder by climate zone.
- Latitude ramp: Tilt tiles colder by latitude.
- Alpine cold: More tundra and snow in mountains.
- Climate prior weight: The proportion of climate data to satellite data used for base terrains.

### Features

Toggle Emit Features to include forests, jungles, flood plains, and oases in the map.

- Keep arid deserts: Keep true deserts as desert even where the satellite shows green, so
  river valleys like the Nile get flood plains. Turn it off for more variety on zoomed-in maps.
- Forest / Jungle density: How much of the land that could carry forest or jungle does.
- Flood-plain amount: How readily desert tiles along rivers become flood plains.
- Oasis density: How many oases appear relative to flood plains.
- Re-roll features: Shuffle the placement. The preview and the export always agree.

### Rivers

Clicking a river in the viewer cycles it: deselected (red, never written), selected (green,
always written), and back to default. What you see is what gets written to the save.

- Top-N Rivers: Include the N largest rivers (by discharge) in the viewer.
- Connect Estuaries to Coast: Force rivers to connect to nearby sea tiles, if the estuary otherwise
  turns into land. Helps preserve river courses for zoomed-out or small maps.

### General Options

- Vector cutoff: The zoom threshold for importing high-resolution data.
- X nudge: shift tile grid horizontally
- Y nudge: shift tile grid vertically

### Export settings

- Playable civs: 0 leaves civs and start locations random; otherwise that many starts are
  placed on land.
- Save destination: Choose a folder once (e.g. Civ 4's `PublicMaps`) and every export is
  written straight into it. Without one, exports go to your browser's downloads.

## Snapshots & Compose

Draw a box or lasso mask over the viewer and hit Capture snapshot to freeze that region, tiles
and all, with whatever settings were active. Snapshots collect on the shelf.

In Compose mode, place snapshots onto a blank ocean canvas, drag them around, and re-stack
them. "Land only" keeps a snapshot's ocean from painting over its neighbors. Exporting from
Compose writes the whole canvas.

## MCP server

`mcp/` holds an MCP server that lets an AI agent drive the running app: frame regions, tune,
capture snapshots, compose, and export. See [mcp/README.md](mcp/README.md).

## Development

The app is written in TypeScript. The compiled `.js` sits next to each `.ts` and is committed,
so running the app needs no build step. Edit the `.ts`, then:

```bash
npm install          # once
npm run build        # compile in place
npm test
```

To add a game, see [games/README.md](games/README.md).

## Rebuilding the data

Everything the app needs is already in `data/`. The scripts that built it from the sources
below are in `scripts/` and `terraform/`; each one documents its usage in its header.

## Data provenance

- Coastline: OpenStreetMap land polygons (© OpenStreetMap contributors, ODbL 1.0) zoomed in;
  Natural Earth 1:10m land (public domain) zoomed out.
- Lakes: HydroLAKES v1.0 (Messager et al. 2016, CC BY 4.0) zoomed in; Natural Earth 1:10m
  lakes zoomed out. Modern reservoirs are removed, and lakes that have since shrunk (the Aral
  Sea, Lake Chad) are restored from Natural Earth's historic lakes.
- Rivers: HydroRIVERS v1.0 (Lehner & Grill 2013), with desert channels checked against
  OpenStreetMap waterways.
- Köppen: Beck et al. (2023) high-resolution (1 km) Köppen-Geiger map (CC BY 4.0), area-majority
  downsampled (low-res map), and vectorized (high-res maps).
- Satellite colour: NASA Blue Marble Next Generation, Aug 2004 topography
  composite.
- Elevation: ETOPO 2022 (NOAA), 1 arcminute base and 30 arcsecond tiles.

## License

The code is MIT licensed; see [LICENSE](LICENSE). The files in `data/` are derived from the
sources above and stay under their own terms. In particular, `data/coast_tiles/` is an
OpenStreetMap derivative under the ODbL.
