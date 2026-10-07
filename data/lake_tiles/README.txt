Lake tiles derived from HydroLAKES
==================================

Source : HydroLAKES v1.0 polygons (Messager et al. 2016, hydrosheds.org)  (https://www.hydrosheds.org/products/hydrolakes)
Built  : 2026-10-07  with scripts/build_coast_tiles.py --kind lakes (clip, union, simplify, size floor,
         quantize, gzip). Lakes under 1.0 km2 (fine LOD) /
         10.0 km2 (coarse LOD) are dropped.
Curation: modern reservoirs dropped (HydroLAKES Lake_type 2 less natural lakes with a dam, and pieces inside Natural Earth reservoirs); historic lakes from Natural Earth ne_10m_lakes_historic (Aral Sea, Lake Chad, Lop Nur, Lake Texcoco); river reaches dropped (a 100 m3/s channel through, thinner than the river's ceiling, water held under 10 days; river_reaches.csv) -- scripts/historic_lakes.py, scripts/river_lakes.py
         (the historic outlines are Natural Earth, public domain)

Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
Attribution: Messager, M.L., Lehner, B., Grill, G., Nedeva, I., Schmitt, O. (2016). Estimating the
volume and age of water stored in global lakes using a geo-statistical approach. Nature
Communications 7: 13603. doi:10.1038/ncomms13603
