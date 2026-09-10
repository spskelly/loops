# Loops

A small walking-loop planner. Pick a starting point, a distance, and a preference for hills. Get up to three different ways home.

## Run

Requires Node.js 20 or later. No dependency install or build step:

```sh
node server.mjs
```

Open **http://localhost:5173**. `npm start` also works. The server only serves files; all geocoding, graph processing, elevation sampling, and history run in the browser. For deployment, serve `index.html`, `style.css`, `favicon.svg`, `config.json`, and `src/` on any static HTTPS host. Location permission requires HTTPS or localhost.

## Use

1. Type an address or park and choose a suggested match to move the map. Enter or **Search** also looks up places. You can use your location, click the map, or paste `latitude, longitude` coordinates.
   **Save this start** gives the point a name such as Home or Work. Optionally make it the default when you reopen Loops. Saved starts are available from the dropdown and can be removed there. Browser location lookup keeps the form usable and shows permission, device, or timeout errors next to the link; cancel it by clicking the link again.
2. Choose 0.5–6 miles (0.8–9.6 km) and a terrain preference. Select **Find my loops**.
3. Compare loops and follow the arrows on the selected route. **Reverse direction** flips the walk, elevation profile, and GPX export while keeping the same start and distance. The initial compass heading shows which way to set off. Routes containing one-way walking segments have a fixed direction. Download GPX for your walking app.
   To avoid a segment, **drag the selected route line onto a nearby street**. Or choose **Adjust route**, tap a segment, then tap the street you want to use instead. The dashed line is a drag preview; on release the app calculates a real walking detour. It replaces the nearby part of the loop, excludes the selected segment, and updates distance, climbing, and GPX. **Undo edit** restores the previous route. Exclusions belong to that edited loop, not a permanent street blacklist.
   Prefer your own way? Choose **Or draw your own route on the map**, tap points along your walk in order, then **Finish loop**. Loops connects the points with real walking paths on the map data and closes the loop back at your start. **Undo point** removes the last tap; **Cancel** leaves drawing. The drawn route gets the same elevation profile, GPX export, reverse, drag-to-adjust, and walk saving as a generated loop.
4. After your walk, choose **I walked this**. Completed walks stay in IndexedDB on this device. They can be removed from **Your walks**.
5. After a walk with elevation data, apply the suggested next effort: 7% above the most recent walk's equivalent flat distance.

The Central Park example performs a real search. There are no sample routes masquerading as results. Routes are suggestions, not turn-by-turn navigation or GPS tracking.

## How it works

- **Geocoding:** Photon, with suggestions after a pause in typing, requests spaced at least 1.1 seconds apart locally, and results cached for 30 days. New input cancels stale lookups. Suggestions require a selection before moving the map; explicit searches with one match select it immediately.
- **Walking graph:** Overpass fetches OSM nodes and ways, cached for seven days around a rounded coordinate and a radius bucket. Primary and secondary roads are included at a 2.5x path-cost penalty (tertiary is 1.85x) so drawn routes can follow a sidewalk OSM has not mapped separately; generated loops take them only when no quieter alternative exists. That penalty is a placeholder: retune it if generated loops start hugging busy roads. The radius includes the rounding offset. Explicit pedestrian restrictions, private access, conditional access, impassable barriers, and area polygons are excluded. Explicit foot permission can override general access. Vehicle one-way rules are ignored; foot one-way rules are respected.
- **Loops:** A module worker builds an adjacency graph, sweeps 12 bearings at three waypoint radii and two turn directions, and connects waypoints with weighted Dijkstra paths. Reused edges cost more on later legs. Candidates are scored by target-distance error, length retraced, and road mix, then deduplicated with edge-set Jaccard similarity. A maximum of eight candidates receive elevation; the best three are presented. There may be fewer results in sparse areas.
- **Elevation:** Terrarium z14 PNGs are decoded as `R * 256 + G + B / 256 - 32768`. Routes are sampled at 20 m with bilinear interpolation across tile boundaries, a five-sample smoothing window, and 3 m reversal hysteresis. Up to four tiles load concurrently. Missing tiles yield unavailable elevation, never zero gain. Hill ranking is disabled if candidate coverage is incomplete.
- **Progression:** Equivalent flat distance in meters is `distance + 9 * gain`. The suggested next target is `previous equivalent distance * 1.07`. Applying it estimates a physical distance from the previous climb rate, then ranks new candidates by actual estimated effort. This is a planning heuristic, not a training prescription or an exact difficulty guarantee.
- **Route editing:** Detours run in the worker on the loaded graph, retaining the original start and route outside the edited section. The dropped point snaps to a mapped node within 150 m. Selected edges are excluded in both directions, including repeated occurrences; prior exclusions on that loop are retained. Private access and foot one-way rules still apply. Unreachable drops, excessive retracing, or very long detours leave the route unchanged. Edited routes can differ from the requested target distance.
- **Drawn routes:** The start snaps to the nearest mapped node within 250 m. Every other tap snaps to the nearest walkable segment within 60 m (distance to the line, not to a node), and each leg walks to the end of that segment nearest the tap (path cost breaks ties), so a tap on a corner reaches that corner; consecutive points are joined by unpenalized Dijkstra paths on the loaded graph, then the loop closes back at the start node. Snapping to segments rather than nodes matters: a mid-block tap on a long street, or a tap on a busy road that is not in the walking graph, used to jump to the nearest node of a side street and the route detoured there and back. Taps more than 60 m from any walkable segment (trunk roads, motorways, open ground) are rejected with a message naming the point. Verified 2026-09-09 against Waynesville, NC: North Main Street is highway=primary with no sidewalk tag in OSM, so before this change taps on it jumped to side-street dead ends. The dashed preview while drawing is straight lines; real paths are computed once on Finish. The graph loads at the larger of the distance slider's radius or twice the farthest point. Drawn routes are not checked against the target distance or the retracing cap; out-and-back legs are allowed.
- **Saved starts:** IndexedDB stores named coordinates and an optional default. Database upgrades retain existing walk history and graph caches. Location requests have a 12-second app-level deadline even if a browser is still waiting for permission; late callbacks cannot overwrite an address you entered in the meantime.
  Location failures open **Location details** beneath the link. The same events appear in the browser console under `[Loops location]`: permission state, elapsed time, native browser error codes/messages, and whether Loops' own deadline expired. Coordinates are excluded from diagnostics. The Geolocation API delegates acquisition to the browser/device, so a location lookup may not appear as a fetch in the page's Network tab. On Windows, verify Location services and browser site permission; Edge also requires the Windows Geolocation Service (`lfsvc`) to be enabled ([Microsoft troubleshooting guide](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/edge-geolocation-not-working)).

## Service limits and privacy

This is intended for personal use. Public Photon and Overpass instances can throttle requests or be unavailable. Photon explicitly allows reasonable use of its demo server without availability guarantees: [Photon service policy](https://github.com/komoot/photon#demo-server). Map tiles follow the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Larger deployments need suitable service providers or self-hosted instances; per-browser caching cannot enforce an application-wide service limit.

`config.json` controls the Photon-compatible geocoder, Overpass endpoint, Terrarium tile root, and raster map URL. Change these without rebuilding. Preserve the proper provider attribution when changing basemaps. This app uses Photon rather than the public Nominatim endpoint.

Address searches go to Photon. The search area goes to Overpass; viewed map and terrain areas go to the tile providers. MapLibre loads from unpkg and optional fonts load from Google Fonts. Completed walk history and saved starting points stay locally in IndexedDB; there is no account, analytics, or app backend. Clearing browser data removes history, saved locations, and caches. The app needs a network connection to load its map library and uncached data.

## Limits

- OSM does not consistently describe sidewalks, crossings, closures, accessibility, lighting, or dog restrictions. The graph tolerates residential roads; a generated route is not a guarantee of safety, accessibility, or permission. Conditional-access segments are conservatively excluded.
- The start snaps to the nearest mapped node within 250 m. The UI reports meaningful offsets. Travel between the pin and that node is excluded from route distance and GPX; the app does not invent a connecting path.
- No good cycle means an actionable empty result. It does not substitute an out-and-back route. Target distance is approximate (candidates outside 60–145% are excluded), and repeats are capped at 32% of route length.
- Terrain resolution varies by source. Bridges, tunnels, stairs, and urban surfaces may disagree with the ground DEM. Gain and walking time are estimates. More terrain data does not guarantee more accurate climbing.
- Terrain preferences compare the generated candidates; they cannot guarantee a flat or hilly loop. Automatic progressive targets require complete elevation data and remain subject to the distance slider's limits.
- No offline map download, cloud sync, background location tracking, or turn-by-turn guidance.
- Edits are limited to the already loaded walking graph. Choose another drop point or generate a longer loop to load a wider area. A location reported by a desktop browser may be approximate; its reported accuracy is displayed so you can check the pin.

## Verify

```sh
npm test
```

The dependency-free Node suite checks geometry, antimeridian sampling, elevation hysteresis, OSM access filtering, directional edges, shortest-path penalties, closed loops, deduplication, empty graphs, Terrarium decoding, and GPX escaping.

Optional browser integration checks use an installed Chrome and Playwright:

```sh
npm install --no-save --package-lock=false playwright
node server.mjs
# In another terminal:
node tests/browser.mjs
```

Browser checks use deterministic API fixtures for route generation, elevation, persistence, GPX, missing terrain, cancellation, and mobile layout. They require network access to the CDN map library; the fixture map, geocoder, Overpass, and DEM responses are intercepted. Screenshots go to `.artifacts/`.

Implementation references: [MapLibre raster maps](https://maplibre.org/maplibre-gl-js/docs/examples/map-tiles/), [Terrarium encoding](https://github.com/tilezen/joerd/blob/master/docs/formats.md), and [terrain tile service](https://github.com/tilezen/joerd/blob/master/docs/use-service.md).
