# Third-party notices for the public edition

Runtime dependencies (installed by `npm ci` in the export):

| Package | License | Purpose | URL |
| --- | --- | --- | --- |
| jose | MIT | Signing and verifying the guest session token (HS256) | https://github.com/panva/jose |
| redis (node-redis) | MIT | Optional shared store for rate limits, caches, saved briefs, and the live-inference budget when `REDIS_URL` is set | https://github.com/redis/node-redis |

Build-time only (used by the export script in the private repository, not
shipped): TypeScript (Apache-2.0), to compile the Studio finance engine.

External services the agent calls at runtime, each subject to its own terms:

| Service | Used for | Terms to observe |
| --- | --- | --- |
| Nebius Token Factory | NVIDIA Nemotron inference through the OpenAI-compatible chat completions API | Nebius terms of service; usage billed to the key holder |
| OpenStreetMap Nominatim | Address geocoding (fallback when no Mapbox token is configured) | Nominatim usage policy: descriptive User-Agent (set `CONTACT_EMAIL`), one request per second, no heavy use; data ODbL |
| FCC Area API | Point to county resolution | Public federal API |
| IndianaMap parcel layer (State of Indiana, Indiana Geographic Information Office) | Parcel geometry and published attributes for Indiana points | Public state data; attribution to the originating county via IndianaMap |
| US Census Bureau API (ACS 5-year, County Business Patterns) | City fundamentals and county establishment counts, when a key is configured | Census API terms; key required |
| CARTO basemaps (Positron style) and OpenStreetMap tiles | The map in the workspace page | CARTO basemap terms; OpenStreetMap contributors, ODbL |
| MapLibre GL JS 4.7.1 (from cdnjs) | Map rendering in the browser | BSD-3-Clause |
| Google Fonts: DM Sans, Manrope | Typography, loaded from fonts.googleapis.com | SIL Open Font License 1.1 |

No font files, images, or map tiles are bundled in the export. No third-party
datasets are redistributed; every evidence row is fetched live from the source
named on it, and the test fixtures are synthetic and labeled as such.
