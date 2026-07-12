# Terra Form

Convert real-world geographic data into a viable tile-based game maps. Frame a
region in the viewer, tune the tile classification, and export.

Currently targeting Civilization 4 maps

This app uses real elevation, coastline, climate zone, river, and satellite maps.


## Run it

Run `server.py` to open the html app in a browswer.

- **View** - Drag to pan, scroll to zoom. The viewer aspect is locked to the output grid,
  so what you frame is exactly what gets sampled into tiles.
- **Tune** — Numerous options are included to fine tune how the real data is interpreted.
  What results in nice maps in one part of the world may yield poor results somewhere else.
  Control terrain roughness, dryness, amplify small islands for emphasis, and so on. 
- **Generate** - writes a `.CivBeyondSwordWBSave` and runs a validator.

## Panel Options

### Coast & Seas

- Island Bias: Show more islands; this tends to give small islands a tile when they otherwise
  would be interpreted as seas.
- Small Island Expander: Scale smaller islands up to balance them against larger islands.
- Seaway Bias: Open up more narrow channels, great for fjords.

### Elevation

- Relief basis: The proportion of elevation to roughness used to distribute hills and mountains.
  High roughness basis prioritizes edges of mountain ranges: good for high plateaus.
- Relief thresholds: The elevation/roughness threshold for hills and mountains
- Roughness smoothing: Higher smoothing creates more clustered hills and mountains.

### Base terrain

- Dryness: Thresholds for grassland, plains, and desert tiles.
- Cold Tilt: Tilt tiles colder by climate zone.
- Latitude Ramp: Tilt tiles colder by latitude.
- Alpine Cold: More tundra and snow in mountains
- Climate prior weight: The proportion of climate data to satellite data used for base terrains.

### Rivers

Clicking rivers in the viewer will deselect them, allowing you to remove river channels you don't want.

- Top-N Rivers: Include the N largest rivers (by discharge) in the viewer.
- Connect Estuaries to Coast: Force rivers to connect to nearby sea tiles, if the estuary otherwise
  turns into land. Helps preserve river courses for zoomed-out or small maps.

### General

- Vector cutoff: The zoom threshold for importing high-resolution data.
- X nudge: shift tile grid horizontally
- Y nudge: shift tile grid vertically

## Data provenance

- Coastline & lakes: Natural Earth 1:10m land + lakes (public domain).
- Köppen: Beck et al. (2023) high-resolution (1 km) Köppen-Geiger map, area-majority
  downsampled (low-res map), and vectorized (high-res maps)
- Satellite colour: NASA Blue Marble Next Generation, Aug 2004 topography
  composite
- Elevation: ETOPO 2022 1 arcminute.
