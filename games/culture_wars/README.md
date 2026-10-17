# Culture Wars

Culture Wars is a Unity game (a separate project) played on a frame of the real
Earth, with provinces around seats and a city map per seat. It reads two kinds
of data from its `StreamingAssets`, and the scripts in this folder write both
from Terra Form's layers (`terraform/`):

- a **world pack** (`WorldPacks/<name>/`): the strategic map for a lon/lat frame;
- **city sites** (`CitySites/<pack>/<seat id>/`): metre-scale terrain around each
  province seat, for the city maps.

Each script's docstring is its full reference (`--help` prints it).

## World pack (`export_world_pack.py`)

A folder with `manifest.json` (format `culturewars-worldpack` v1: size, snapped
bounds, `wrapX`, per-layer encoding, the frame's arguments, sources and
attribution) and these layers, all on the frame's grid, row 0 north:

| file | contents |
|------|----------|
| `elevation.png` | RG16 elevation, 0..65535 over `minMeters`..`maxMeters` (-500..6000 m) |
| `landmask.png` | 8-bit, 255 land / 0 water: coast polygons, lakes punched out, salt pans back as land |
| `koppen.png` | 8-bit Köppen class index (Beck et al. 2023), at its own resolution when the frame is a whole multiple of it |
| `rivers.png` | 8-bit river class per cell: 1 minor, 2 medium (≥ 100 m³/s), 3 major (≥ 1000 m³/s) |
| `rivers.bin` | `CWRV` v1: the river channels as vectors, each with its terminal (mouth, confluence, sink) |
| `playas.bin` | `CWPL` v1: the salt pans under the frame as polygons |

```bash
# the Earth without the poles, on the working grid
python games/culture_wars/export_world_pack.py --out "<Unity>/Assets/StreamingAssets/WorldPacks/earth" --bounds -180 -60 180 85
# the Aegean with as many cells across as the world map
python games/culture_wars/export_world_pack.py --out "<Unity>/Assets/StreamingAssets/WorldPacks/aegean" --bounds 19 34 30 42 --width 4096
```

The frame, `--*-source` and `--island-*` arguments are the shared ones from
`terraform/cli.py`; the Earth packs use `--island-expand` with
`--island-isolation 25 --island-regions data/island_regions.json`.

## Province seats

- `generate_seats.py --pack <pack>`: scatter seats over a pack's land by
  habitability (Köppen, elevation, rivers, coast) into `<pack>/seats.yaml`.
- `select_city_seats.py --pack <pack> --geonames cities5000.txt --curated data/seats`:
  pick seats from real places (GeoNames plus the curated `data/seats/historic_*.csv`).
- `cull_city_seats.py --seats <pack>/seats.yaml --target N --out ...`: thin a
  seats file, keeping its regional balance.
- `audit_lake_rivers.py <pack>`: screen a pack's inland water for thin,
  river-threaded lake pieces (run before and after a lake-layer change).

## City sites

- `score_city_sites.py --pack <pack> --report <dir> --seats 171,62`: survey the
  ground around each seat and choose its window (`<dir>/frames.json`).
- `export_city_sites.py --pack <pack> --out <dir> --seats 171,62 [--frames frames.json]`:
  write each site's height, Köppen, water, shore, river and reef rasters,
  `vectors.bin` (`CWCS` v1) and `site.json`. Heights come from Copernicus
  GLO-30/90, read over HTTPS and cached under `cache/copernicus`; Overture water
  is cached under `cache/overture`.
