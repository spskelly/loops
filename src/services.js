import { distance, resample, elevationGain } from './geo.js';
import { getCache, setCache } from './storage.js';
let configuration;
export async function config() {
  if (!configuration) configuration = fetch('./config.json').then(r => { if (!r.ok) throw new Error('Could not load service settings.'); return r.json(); });
  return configuration;
}
export async function fetchJSON(url, options = {}, timeout = 25000) {
  const timer = new AbortController();
  const abort = () => timer.abort(options.signal.reason);
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  const clock = setTimeout(() => timer.abort(new Error('The service took too long. Please try again.')), timeout);
  try {
    const response = await fetch(url, { ...options, signal: timer.signal });
    if (!response.ok) throw new Error(response.status === 429 ? 'The map service is busy. Please wait a minute before trying again.' : `The map service is unavailable (${response.status}). Please try again later.`);
    return await response.json();
  } finally { clearTimeout(clock); options.signal?.removeEventListener('abort', abort); }
}
export async function geocode(query, signal) {
  const key = `place:${query.trim().toLowerCase()}`;
  const cached = await getCache(key, 30 * 86400000); if (cached) return cached;
  const settings = await config(), url = new URL(settings.geocoder);
  url.searchParams.set('q', query); url.searchParams.set('limit', '5');
  const data = await fetchJSON(url, { signal });
  const places = (data.features || []).filter(f => f.geometry?.type === 'Point').map(f => {
    const p = f.properties;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    return { coord: f.geometry.coordinates, name: p.name || street || p.city || 'Selected place', description: [...new Set([street, p.city || p.town || p.village, p.state, p.country].filter(Boolean))].join(', ') };
  });
  await setCache(key, places); return places;
}
export async function fetchGraph(origin, target, signal) {
  const center = origin.map(n => Math.round(n * 100) / 100);
  const radius = Math.ceil((target / 2 + 400 + distance(center, origin)) / 1000) * 1000;
  const key = `graph:v3:${center.join(',')}:${radius}`;
  const cached = await getCache(key); if (cached) return cached;
  const settings = await config();
  const query = `[out:json][timeout:45][maxsize:33554432];way(around:${radius},${center[1]},${center[0]})["highway"~"^(footway|path|residential|living_street|pedestrian|track|unclassified|tertiary|secondary|primary|steps)$"];(._;>;);out body;`;
  const data = await fetchJSON(settings.overpass, { method: 'POST', body: new URLSearchParams({ data: query }), signal }, 55000);
  if (data.remark) throw new Error('The map query could not finish. Try a shorter distance or try again later.');
  if (!data.elements?.length) throw new Error('No walking paths found here. Try another starting point.');
  if (data.elements.length > 220000) throw new Error('This area is too dense for a lightweight search. Try a shorter distance.');
  await setCache(key, data.elements); return data.elements;
}
export function calculateRoutes(elements, origin, target, signal, onProgress) {
  return routingJob({ elements, origin, target }, signal, onProgress);
}
export async function calculateDetour(elements, route, edgeIndex, destination, signal) {
  const routes = await routingJob({ elements, edit: { route, edgeIndex, destination } }, signal, () => {});
  return routes[0];
}
export async function calculateDrawn(elements, waypoints, signal) {
  const routes = await routingJob({ elements, draw: waypoints }, signal, () => {});
  return routes[0];
}
function routingJob(payload, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./route-worker.js', import.meta.url), { type: 'module' });
    const finish = (fn, value) => { clearTimeout(timer); worker.terminate(); signal.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('This graph is taking too long. Try a shorter distance.')), 60000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    worker.onmessage = ({ data }) => { if (data.error) finish(reject, new Error(data.error)); else if (data.routes) finish(resolve, data.routes); else onProgress(data.progress); };
    worker.onerror = () => finish(reject, new Error('Route calculation failed. Reload the page and try again.'));
    worker.postMessage(payload);
  });
}
export function decodeTerrarium(r, g, b) { return r * 256 + g + b / 256 - 32768; }
export function mercatorPixel(coord, zoom = 14) {
  const size = 256 * 2 ** zoom, lat = Math.max(-85.05112878, Math.min(85.05112878, coord[1])) * Math.PI / 180;
  // Pixel centers, not pixel edges. Neighbor reads cross tile boundaries.
  return [(coord[0] + 180) / 360 * size - .5, (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * size - .5];
}
const tileCache = new Map();
async function terrainTile(x, y, settings, signal) {
  const count = 2 ** 14; x = ((x % count) + count) % count; y = Math.max(0, Math.min(count - 1, y));
  const key = `${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(`${settings.terrain}/14/${key}.png`, { signal: controller.signal });
    if (!response.ok) throw new Error('Terrain unavailable');
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, 256, 256).data;
    tileCache.set(key, pixels); if (tileCache.size > 160) tileCache.delete(tileCache.keys().next().value);
    return pixels;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export async function addElevation(routes, signal, onProgress) {
  const settings = await config(), samples = routes.map(r => resample(r.coords));
  const needed = new Map();
  for (const profile of samples) for (const point of profile) {
    const [px, py] = mercatorPixel(point.coord), x = Math.floor(px), y = Math.floor(py);
    for (const dx of [0, 1]) for (const dy of [0, 1]) { const tx = Math.floor((x + dx) / 256), ty = Math.floor((y + dy) / 256); needed.set(`${tx}/${ty}`, [tx, ty]); }
  }
  const entries = [...needed], tiles = new Map(); let index = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (index < entries.length) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const [key, [x, y]] = entries[index++];
      try { tiles.set(key, await terrainTile(x, y, settings, signal)); } catch { tiles.set(key, null); }
      onProgress(++done / entries.length);
    }
  }));
  const read = (x, y) => {
    const data = tiles.get(`${Math.floor(x / 256)}/${Math.floor(y / 256)}`); if (!data) return null;
    const offset = ((((y % 256) + 256) % 256) * 256 + ((x % 256) + 256) % 256) * 4;
    if (!data[offset + 3]) return null;
    const elevation = decodeTerrarium(data[offset], data[offset + 1], data[offset + 2]);
    return elevation < -12000 ? null : elevation;
  };
  return routes.map((route, i) => {
    const profile = samples[i].map(point => {
      const [px, py] = mercatorPixel(point.coord), x = Math.floor(px), y = Math.floor(py), fx = px - x, fy = py - y;
      const v = [read(x, y), read(x + 1, y), read(x, y + 1), read(x + 1, y + 1)];
      return { ...point, elevation: v.some(n => n === null) ? null : v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy };
    });
    if (profile.some(p => p.elevation === null)) return { ...route, gain: null, profile: null };
    // A centered 5-sample mean suppresses short DEM spikes before 3 m hysteresis.
    const smooth = profile.map((p, j) => { const window = profile.slice(Math.max(0, j - 2), j + 3); return { ...p, elevation: window.reduce((s, v) => s + v.elevation, 0) / window.length }; });
    return { ...route, profile: smooth, gain: elevationGain(smooth.map(p => p.elevation)) };
  });
}
