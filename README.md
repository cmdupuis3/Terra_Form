# Terra Form

Convert real-world geographic data into a viable tile-based game maps. Frame a
region in the viewer, tune the tile classification, and export.

Currently targeting Civilization 4 maps

This app uses real elevation, coastline, climate zone, river, and satellite maps.


## Run it

Run `server.py` to open the html app in a browswer.

- Drag to pan, scroll to zoom. The viewer aspect is locked to the output grid
  (W×H), so what you frame is exactly what gets sampled into tiles.
- View modes: satellite colour, elevation (hypsometric), roughness (heat ramp),
  Köppen climate (Beck et al. 2018 palette; ocean shown white), and the Civ tile
  preview.
- **Coastline panel** — *vector cutoff* sets the coarse↔crisp zoom switch; *island
  bias* (↑) lowers the land %% a coastal tile needs so small islands survive; *seaway
  bias* (↑) raises it in land-surrounded spots so channels (e.g. around Marajó) open;
  *small-island expander* (↑) enlarges islands smaller than 10% of the view area,
  each growing toward a cap of half the largest scaled island's area (never beyond;
  the smallest reaches it at max slider) so nothing overshoots; *expander steepness*
  (number box) shapes the area falloff. Land is filled per-polygon, so overlapping/
  expanded islands union (OR) instead of cancelling to sea. Vector regime only.
  A halo around each tile decides which regime it's in; the halo radius scales with zoom (larger when zoomed in) for stable classification at high zoom.
- **⟳ reseed climate** reseeds the moisture-driven colour & Köppen; real height &
  coastline are untouched.
- **Generate** writes a `.CivBeyondSwordWBSave` and runs a validator
  (plot count = W×H, land↔plot-type consistency, starts on land, header present).


## Data provenance

- Coastline & lakes: Natural Earth 1:10m land + lakes (public domain).
- Köppen: Beck et al. (2023) high-resolution (1 km) Köppen-Geiger map, area-majority
  downsampled (low-res map), and vectorized (high-res maps)
- Satellite colour: NASA Blue Marble Next Generation, Aug 2004 topography
  composite
- Elevation: ETOPO 2022 1 arcminute.
