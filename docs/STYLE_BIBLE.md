# Shanghai 3D Demo · Style Bible v1

Approved direction: **cool-gray operational digital twin with real material separation**.
Reference: `reference/style-demo/approved-style.png` (repository root).

The target is not photorealism and not a white GIS massing model. It is a restrained Shanghai digital twin: real geometry, clear parcels and road hierarchy, differentiated building surfaces, soft overcast light, and a deep blue-gray Huangpu River. Risk overlays remain the most saturated elements in the final product.

| Element | Primary color | Secondary / accent | Roughness | Opacity | Visual rule |
|---|---|---|---:|---:|---|
| Ground · neutral | `#CDD2D2` | `#C4C9C9` | 0.92 | 1.00 | Cool light-gray base; no photographic-map dominance |
| Parcel · residential | `#D1CEC6` | `#C8C5BE` | 0.94 | 0.82 | Slight warm-gray difference from generic ground |
| Parcel · commercial | `#C4CDD0` | `#BBC5C9` | 0.90 | 0.84 | Cool gray, slightly darker than residential |
| Parcel · industrial | `#B9C0C1` | `#AEB7B9` | 0.95 | 0.84 | Neutral and visually recessed |
| Parcel · civic | `#D3D3CD` | `#C8CBC7` | 0.90 | 0.84 | Pale neutral, not bright white |
| Green | `#748575` | `#849483` | 0.88 | 0.78 | Muted sage only; never saturated lawn green |
| Water | `#365568` | `#2F4A5B` | 0.30 | 1.00 | Deep steel blue; no cyan outline in visual demo |
| Expressway | `#465761` | casing `#9CA8AC` | — | 0.98 | Widest/darkest continuous road skeleton |
| Primary road | `#586A74` | casing `#B3BCBE` | — | 0.96 | Strong city-level readability |
| Secondary road | `#72818A` | — | — | 0.90 | Mid-level hierarchy |
| Local road | `#939DA1` | — | — | 0.68 | Only visible close to camera |
| Glass · blue | `#587687` | `#7894A2` | 0.24 | 1.00 | Low-saturation cool glass, not transparent |
| Glass · silver | `#87979E` | `#A4AFB2` | 0.31 | 1.00 | Silver-gray office curtain wall |
| Stone | `#B9B0A4` | `#C9C1B6` | 0.76 | 1.00 | Warm neutral civic/commercial facade |
| Residential | `#C4BBB0` | windows `#6E7C82` | 0.72 | 1.00 | Warm-gray body + restrained repetitive window rhythm |
| Concrete | `#A8AFB1` | `#949DA0` | 0.86 | 1.00 | Generic fallback, never pure white |
| Roof | `#CDD2D1` | edge `#B7BFC0` | 0.80 | 1.00 | 6–10% brighter than facade; roof edge must read |
| Base / podium | `#69777C` | `#7D898D` | 0.68 | 1.00 | 10–18% darker than facade to anchor buildings |
| Shadow | `#50616A` | — | — | 0.22–0.30 | Soft directional shadow, no black patches |

## Lighting

- HDR: **on**.
- Environment / IBL: cool overcast, medium intensity.
- Directional light: north-west / west-north-west, elevation ~35–45°.
- AO: restrained; enough to separate podium, roof edge, and neighboring buildings.
- Bloom: off or effectively zero for city surfaces.
- Exposure: neutral to slightly bright; preserve readable glass without clipping roofs.
- Fog / haze: subtle at city scale; only to soften the far skyline.

## Building surface hierarchy

Every context building should read as three vertical material zones:

1. **ROOF** — lighter, high roughness, readable roof edge.
2. **FACADE** — one of Glass Blue / Glass Silver / Residential / Stone / Concrete.
3. **BASE** — darker podium/base to separate the mass from the parcel.

Facade variation is visual, not semantic truth. Do not claim that OSM buildings have real material data unless a source provides it.

## Golden visual rules

- Lujiazui Astra GLB is the highest-detail visual anchor.
- Context buildings are simpler but belong to the same palette.
- Roads and parcels must be readable before labels.
- The basemap is background evidence, not the visual surface.
- Flood / forecast / warning colors remain the most saturated colors in the scene.
