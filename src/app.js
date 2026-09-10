import { distance, equivalentDistance, toGPX, reverseRoute, startingDirection } from './geo.js';
import { config, geocode, fetchGraph, calculateRoutes, calculateDetour, calculateDrawn, addElevation } from './services.js';
import { getWalks, saveWalk, deleteWalk, clearWalks, getLocations, saveLocation, deleteLocation, getDefaultLocation, setDefaultLocation } from './storage.js';
import { currentLocation } from './location.js';

const $ = id => document.getElementById(id);
const colors = ['#355f46', '#b78646', '#7287a0'];
const state = { unit: 'mi', effort: 'gentle', origin: null, placeName: '', query: '', routes: [], selected: 0, walks: [], busy: false, controller: null, map: null, marker: null, nextTarget: null, locations: [], defaultLocation: null, graph: null, editMode: false, pendingEdge: null, editMarker: null, drawing: false, waypoints: [], drawMarkers: [] };
const factor = () => state.unit === 'mi' ? 1609.344 : 1000;
const meters = () => Number($('distance').value) * factor();
const formatDistance = n => `${(n / factor()).toFixed(1)} ${state.unit}`;
const formatGain = n => Number.isFinite(n) ? `${Math.round(n * (state.unit === 'mi' ? 3.28084 : 1))} ${state.unit === 'mi' ? 'ft' : 'm'}` : 'Unavailable';
const minutes = route => Math.round(route.length / 80 + (route.gain || 0) / 10);
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function status(message = '', error = false) { $('status').textContent = message; $('status').className = error ? 'error' : ''; }
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function updateDistance() {
  $('distance-value').value = Number($('distance').value).toFixed(1);
  $('distance-unit').textContent = state.unit === 'mi' ? 'miles' : 'kilometers';
  $('walk-time').textContent = `~${Math.round(meters() / 80)} min walking`;
}
function busy(value) {
  state.busy = value; $('controls').disabled = value; $('cancel').hidden = !value;
  $('example').disabled = value; $('draw').disabled = value; $('draw-cancel').disabled = value;
  $('draw-undo').disabled = value || !state.waypoints.length; $('draw-finish').disabled = value || !state.waypoints.length;
  $('find').innerHTML = value ? 'Finding your way around… <span>↻</span>' : 'Find my loops <span aria-hidden="true">↗</span>';
  $('planner').setAttribute('aria-busy', String(value));
  $('route-detail').querySelectorAll('button').forEach(button => button.disabled = value || (button.id === 'reverse' && state.routes[state.selected]?.reversible === false) || (button.id === 'complete' && state.walks.some(w => w.routeId === state.routes[state.selected]?.id)));
  $('route-list').querySelectorAll('button').forEach(button => button.disabled = value);
}
function setPlace(place) {
  cancelLocation();
  cancelPlaceSearch();
  state.origin = place.coord; state.placeName = place.name; state.query = place.name;
  $('address').value = place.name; $('places').hidden = true;
  $('address').setAttribute('aria-expanded', 'false');
  placeStatus('Starting point selected.');
  $('map-label').textContent = place.name; $('map-welcome').hidden = true;
  clearRoutes();
  showStartingPoint();
  renderSavedLocations();
  status('Starting point set. Choose a distance and find your loops.');
}
function showStartingPoint() {
  if (!state.map || !state.origin) return;
  state.marker?.remove();
  const el = document.createElement('div'); el.className = 'start-pin';
  state.marker = new maplibregl.Marker({ element: el }).setLngLat(state.origin).addTo(state.map);
  // Route fitting leaves camera padding behind; reset it for a new start.
  state.map.flyTo({ center: state.origin, zoom: 14, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
}
function clearRoutes() {
  resetRouteEditor(); stopDrawing();
  state.routes = []; $('results').hidden = true; $('route-detail').hidden = true; $('fit-map').hidden = true;
  $('route-list').replaceChildren();
  updateMapRoutes();
}
let lastSearch = 0, searchTimer, searchController;
function placeStatus(message, error = false) {
  $('place-status').textContent = message;
  $('place-status').classList.toggle('error', error);
}
function cancelPlaceSearch() {
  clearTimeout(searchTimer); searchController?.abort(); searchController = null;
  $('address').setAttribute('aria-busy', 'false');
}
async function searchPlaces({ suggest = false, continueToLoops = false } = {}) {
  cancelPlaceSearch();
  const query = $('address').value.trim();
  if (query.length < 3) { placeStatus('Enter at least three characters, or use your location.'); return; }
  if (state.busy) return;
  const controller = new AbortController(); searchController = controller;
  $('address').setAttribute('aria-busy', 'true'); placeStatus('Looking for matching places…');
  try {
    // Space lookups without disabling the input; newer text cancels stale results.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, Math.max(0, 1100 - (Date.now() - lastSearch)));
      controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (controller.signal.aborted) return;
    lastSearch = Date.now();
    // Pasted coordinates also work without contacting a geocoder.
    const coords = query.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coords && Math.abs(Number(coords[1])) <= 85 && Math.abs(Number(coords[2])) <= 180) {
      setPlace({ coord: [Number(coords[2]), Number(coords[1])], name: query });
      if (continueToLoops) await findLoops();
      return;
    }
    const places = await geocode(query, controller.signal);
    if (controller.signal.aborted) return;
    if (!places.length) { placeStatus('No places found. Try a street and city, or choose a point on the map.', true); return; }
    if (places.length === 1 && !suggest) {
      setPlace(places[0]); if (continueToLoops) await findLoops(); return;
    }
    $('places').replaceChildren();
    for (const place of places) {
      const button = document.createElement('button'); button.type = 'button';
      button.innerHTML = `${escape(place.name)}<small>${escape(place.description)}</small>`;
      button.onclick = () => { setPlace(place); if (continueToLoops) findLoops(); }; $('places').append(button);
    }
    $('places').hidden = false; $('address').setAttribute('aria-expanded', 'true');
    placeStatus('Choose a match below the address to move the map.');
  } catch (error) { if (!controller.signal.aborted) placeStatus(friendlyError(error), true); }
  finally { if (searchController === controller) { searchController = null; $('address').setAttribute('aria-busy', 'false'); } }
}
function friendlyError(error) {
  return error.message === 'Failed to fetch' ? 'Could not reach the map service. Check your connection and try again.' : error.message;
}
async function findLoops(event) {
  event?.preventDefault(); if (state.busy) return;
  if (!state.origin || $('address').value !== state.query) { await searchPlaces({ continueToLoops: true }); return; }
  cancelPlaceSearch();
  cancelLocation();
  const controller = new AbortController(); state.controller = controller;
  busy(true); clearRoutes(); status('Gathering nearby paths and quiet streets…');
  try {
    const elements = await fetchGraph(state.origin, meters(), controller.signal);
    if (controller.signal.aborted) return;
    state.graph = elements;
    status('Connecting paths into loops…');
    let routes = await calculateRoutes(elements, state.origin, meters(), controller.signal, progress => status(`Exploring different directions… ${Math.round(progress * 100)}%`));
    status('Checking the hills along the way…');
    try {
      routes = await addElevation(routes, controller.signal, progress => status(`Checking elevation… ${Math.round(progress * 100)}%`));
    } catch (error) { if (controller.signal.aborted) throw error; /* Keep usable routes if terrain is unavailable. */ }
    if (controller.signal.aborted) return;
    // Compare elevation only when all candidates have data, avoiding bias toward missing tiles.
    const terrainComplete = routes.every(r => Number.isFinite(r.gain));
    for (const route of routes) {
      const hillRate = Number.isFinite(route.gain) ? route.gain / route.length : 0;
      route.rank = route.score;
      if (terrainComplete) route.rank += state.effort === 'gentle' ? hillRate * 16 : state.effort === 'challenge' ? -Math.min(hillRate, .12) * 8 : Math.abs(hillRate - .015) * 4;
      if (state.nextTarget && terrainComplete) route.rank += Math.abs(equivalentDistance(route.length, route.gain) - state.nextTarget) / state.nextTarget * 4;
    }
    routes.sort((a, b) => a.rank - b.rank);
    state.routes = routes.slice(0, 3).map((r, i) => ({ ...r, name: ['The everyday escape', 'A different way home', 'The scenic detour'][i], id: crypto.randomUUID(), placeName: state.placeName }));
    state.selected = 0; renderRoutes(); selectRoute(0, true);
    const allElevation = state.routes.every(r => Number.isFinite(r.gain));
    status(`${state.routes.length} ${state.routes.length === 1 ? 'loop' : 'loops'} to make your own.${allElevation ? '' : ' Some elevation data is unavailable; hill preferences could not be compared.'}`);
    if (window.innerWidth <= 720) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { if (!controller.signal.aborted) status(friendlyError(error), true); }
  finally { if (state.controller === controller) busy(false); }
}
function renderRoutes() {
  $('results').hidden = !state.routes.length;
  $('route-count').textContent = `${state.routes.length} ${state.routes.length === 1 ? 'possibility' : 'possibilities'}`;
  $('route-list').innerHTML = state.routes.map((route, i) => `<button type="button" class="route-card" data-route="${i}" aria-pressed="${i === state.selected}" style="--route-color:${colors[i]}"><span class="route-top"><span class="route-dot"></span><strong>${escape(route.name)}</strong><small>${state.walks.some(w => w.routeId === route.id) ? 'WALKED' : route.drawn ? 'YOUR ROUTE' : i === 0 ? 'BEST FIT' : 'ALTERNATIVE'}</small></span><span class="route-stats"><span>${formatDistance(route.length)}</span><span>↗ ${formatGain(route.gain)}</span><span>~${minutes(route)} min</span></span></button>`).join('');
  $('route-list').querySelectorAll('button').forEach(b => b.onclick = () => selectRoute(Number(b.dataset.route), true));
}
function profileSVG(route) {
  if (!route.profile) return '<p class="muted">Elevation is unavailable for this loop. Distance and GPX are still available.</p>';
  const elevations = route.profile.map(p => p.elevation), low = Math.min(...elevations), high = Math.max(...elevations), span = Math.max(high - low, 10);
  const line = route.profile.map((p, i) => `${i ? 'L' : 'M'}${(p.meters / route.length * 500).toFixed(1)},${(62 - (p.elevation - low) / span * 52).toFixed(1)}`).join(' ');
  return `<svg class="profile" viewBox="0 0 500 74" preserveAspectRatio="none" role="img" aria-label="Elevation profile: ${escape(formatGain(low))} to ${escape(formatGain(high))}"><defs><linearGradient id="profile-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#dce7c8"/><stop offset="1" stop-color="#eff3e5" stop-opacity=".3"/></linearGradient></defs><path d="M0 22H500M0 47H500M0 72H500" stroke="#e9ecdf" stroke-dasharray="3 4" fill="none"/><path d="${line} L500,74 L0,74Z" fill="url(#profile-fill)"/><path d="${line}" fill="none" stroke="#7f9861" stroke-width="2" vector-effect="non-scaling-stroke"/></svg><div class="profile-labels"><span>Start · ${formatGain(elevations[0])}</span><span>Estimated elevation</span><span>${formatDistance(route.length)} · Home</span></div>`;
}
function selectRoute(index, fit = false) {
  resetRouteEditor();
  state.selected = index; const route = state.routes[index]; if (!route) return;
  renderRoutes(); updateMapRoutes();
  $('route-detail').hidden = false; $('fit-map').hidden = !state.map;
  const completed = state.walks.some(w => w.routeId === route.id);
  $('route-detail').innerHTML = `<div class="detail-heading"><h2>${escape(route.name)}</h2><span class="badge">${Math.round(route.quiet * 100)}% paths & quiet lanes</span></div><div class="detail-stats"><div><strong>${formatDistance(route.length)}</strong><small>ROUND TRIP</small></div><div><strong>${formatGain(route.gain)}</strong><small>EST. CLIMBING</small></div><div><strong>${minutes(route)} min</strong><small>AT A WALKING PACE</small></div></div>${profileSVG(route)}<p class="detail-note">${route.via ? `Via ${escape(route.via)}. ` : ''}${Math.round(route.overlap * 100)}% retraced. ${route.startOffset > 15 ? `Starts ${Math.round(route.startOffset)} m from your pin; getting to the path is not included. ` : ''}${route.steps ? 'Includes steps. ' : ''}Check local access and crossings.</p><div class="detail-actions"><button class="secondary" id="download">↓ &nbsp; GPX</button><button class="primary" id="complete" ${completed ? 'disabled' : ''}>${completed ? '✓ Walk saved' : '✓ &nbsp; I walked this'}</button></div>`;
  $('route-detail').querySelector('.detail-heading').insertAdjacentHTML('afterend', `<div class="route-direction"><span id="direction-label">Head ${startingDirection(route.coords)} · follow the arrows</span><button class="text-button" id="reverse" aria-pressed="${Boolean(route.reversed)}" ${route.reversible === false ? 'disabled' : ''}>⇄ &nbsp; Reverse direction</button></div>${route.reversible === false ? '<p class="detail-note">Direction fixed: includes a one-way walking segment.</p>' : ''}`);
  $('reverse').onclick = () => {
    state.routes[index] = reverseRoute(route);
    selectRoute(index);
    $('reverse').focus({ preventScroll: true });
    toast('Direction reversed. Elevation profile and GPX updated.');
  };
  $('route-detail').querySelector('.detail-actions').insertAdjacentHTML('beforebegin', `<div class="route-edit-actions"><button class="text-button" id="adjust-route" aria-pressed="false">✎ Adjust route</button>${route.previous ? '<button class="text-button" id="undo-route">↶ Undo edit</button>' : ''}<span id="edit-hint" role="status">Drag the line to another street.</span></div>`);
  $('adjust-route').onclick = () => {
    state.editMode = !state.editMode; state.pendingEdge = null; state.editMarker?.remove();
    $('adjust-route').setAttribute('aria-pressed', String(state.editMode));
    $('edit-hint').textContent = state.editMode ? 'Tap a segment, then tap a street to use instead.' : 'Drag the line to another street.';
    state.map?.getCanvas().style.setProperty('cursor', state.editMode ? 'crosshair' : '');
  };
  if ($('undo-route')) $('undo-route').onclick = () => { state.routes[index] = route.previous; selectRoute(index, true); toast('Route edit undone.'); };
  $('download').onclick = () => {
    const url = URL.createObjectURL(new Blob([toGPX(route)], { type: 'application/gpx+xml' }));
    const a = document.createElement('a'); a.href = url; a.download = `loops-${route.name.toLowerCase().replaceAll(' ', '-')}.gpx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('complete').onclick = async () => {
    $('complete').disabled = true;
    try {
      const { previous, ...snapshot } = route;
      await saveWalk({ id: crypto.randomUUID(), routeId: route.id, name: route.name, placeName: route.placeName, length: route.length, gain: route.gain, completedAt: Date.now(), equivalent: equivalentDistance(route.length, route.gain), origin: state.origin, route: snapshot });
      await loadHistory(); selectRoute(state.selected); toast('A little more outside. Walk saved.');
    } catch { $('complete').disabled = false; toast('Could not save this walk. Browser storage may be unavailable.'); }
  };
  if (fit) fitMap();
}
function resetRouteEditor() {
  state.editMode = false; state.pendingEdge = null; state.editMarker?.remove(); state.editMarker = null;
  state.map?.getSource('edit-preview')?.setData({ type: 'FeatureCollection', features: [] });
  state.map?.getCanvas().style.setProperty('cursor', '');
}
function closestRouteSegment(point) {
  const route = state.routes[state.selected]; if (!route || !state.map) return null;
  let best = null, minimum = 18;
  for (let i = 0; i < route.coords.length - 1; i++) {
    const a = state.map.project(route.coords[i]), b = state.map.project(route.coords[i + 1]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const offset = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
    if (offset < minimum) { minimum = offset; best = i; }
  }
  return best;
}
function showEditPoint(coord, edgeIndex = state.pendingEdge) {
  if (!state.editMarker) {
    const element = document.createElement('div'); element.className = 'edit-pin';
    state.editMarker = new maplibregl.Marker({ element }).setLngLat(coord).addTo(state.map);
  } else state.editMarker.setLngLat(coord);
  const route = state.routes[state.selected];
  if (route && edgeIndex !== null) state.map.getSource('edit-preview')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [route.coords[edgeIndex], coord, route.coords[edgeIndex + 1]] } });
}
async function editRoute(edgeIndex, destination) {
  if (state.busy) return;
  const index = state.selected, route = state.routes[index]; if (!route) return;
  cancelLocation(); resetRouteEditor();
  const controller = new AbortController(); state.controller = controller;
  busy(true); $('edit-hint').textContent = 'Finding a walking detour…'; status('Rerouting around that segment…');
  try {
    const { previous, ...snapshot } = route;
    if (!state.graph) { status('Gathering nearby paths…'); state.graph = await fetchGraph(state.origin, route.length, controller.signal); }
    if (controller.signal.aborted) return;
    let updated = await calculateDetour(state.graph, snapshot, edgeIndex, destination, controller.signal);
    if (controller.signal.aborted) return;
    $('edit-hint').textContent = 'Checking the new distance and hills…';
    try { [updated] = await addElevation([updated], controller.signal, () => {}); } catch (error) { if (controller.signal.aborted) throw error; }
    if (controller.signal.aborted) return;
    state.routes[index] = { ...updated, id: crypto.randomUUID(), previous: route };
    selectRoute(index, true);
    status('Route adjusted. The dragged segment is excluded from this loop.');
    toast('Detour ready. Distance, elevation and GPX updated.');
  } catch (error) {
    if (!controller.signal.aborted) { $('edit-hint').textContent = friendlyError(error); status(friendlyError(error), true); toast('Could not make that detour. Your loop is unchanged.'); }
  } finally { if (state.controller === controller) busy(false); }
}
// ponytail: the dashed preview is straight lines; real walking paths are computed once on Finish.
function stopDrawing() {
  state.drawing = false; state.waypoints = [];
  state.drawMarkers.forEach(m => m.remove()); state.drawMarkers = [];
  $('draw-bar').hidden = true; $('draw').setAttribute('aria-pressed', 'false');
  state.map?.getSource('edit-preview')?.setData({ type: 'FeatureCollection', features: [] });
  state.map?.getCanvas().style.setProperty('cursor', '');
}
function renderDrawing() {
  const count = state.waypoints.length;
  $('draw-undo').disabled = !count; $('draw-finish').disabled = !count;
  $('draw-hint').textContent = count ? `${count} ${count === 1 ? 'point' : 'points'} added. Tap to add more, or finish to connect them by walking paths.` : 'Tap the map to add points. The loop closes back at your start.';
  state.drawMarkers.forEach(m => m.remove());
  state.drawMarkers = state.waypoints.map((coord, i) => {
    const element = document.createElement('div'); element.className = 'draw-pin'; element.textContent = i + 1;
    return new maplibregl.Marker({ element }).setLngLat(coord).addTo(state.map);
  });
  state.map.getSource('edit-preview')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [state.origin, ...state.waypoints, state.origin] } });
}
function startDrawing() {
  if (state.busy) return;
  if (state.drawing) { stopDrawing(); status('Drawing cancelled.'); return; }
  if (!state.origin || !state.map) { status(state.map ? 'Choose a starting point first, then draw your route from there.' : 'The map is unavailable, so routes cannot be drawn.', true); $('address').focus(); return; }
  cancelPlaceSearch(); cancelLocation(); clearRoutes();
  state.drawing = true; $('draw-bar').hidden = false; $('draw').setAttribute('aria-pressed', 'true');
  $('map-welcome').hidden = true; renderDrawing();
  state.map.getCanvas().style.setProperty('cursor', 'crosshair');
  status('Tap the map to add points along your walk.');
  if (window.innerWidth <= 720) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function finishDrawing() {
  if (state.busy || !state.waypoints.length) return;
  const origin = state.origin, waypoints = [origin, ...state.waypoints];
  const controller = new AbortController(); state.controller = controller;
  busy(true); status('Gathering nearby paths and quiet streets…');
  try {
    // Load at least the slider's radius, and enough to cover the farthest point.
    state.graph = await fetchGraph(origin, Math.max(meters(), 2 * Math.max(...waypoints.map(p => distance(origin, p)))), controller.signal);
    if (controller.signal.aborted) return;
    status('Connecting your points by walking paths…');
    let route = await calculateDrawn(state.graph, waypoints, controller.signal);
    if (controller.signal.aborted) return;
    status('Checking the hills along the way…');
    try { [route] = await addElevation([route], controller.signal, () => {}); } catch (error) { if (controller.signal.aborted) throw error; }
    if (controller.signal.aborted) return;
    stopDrawing();
    state.routes = [{ ...route, name: 'Your own way', id: crypto.randomUUID(), placeName: state.placeName }];
    state.selected = 0; renderRoutes(); selectRoute(0, true);
    status(`Your route is ${formatDistance(route.length)} following mapped paths. Drag the line to adjust any street.`);
    if (window.innerWidth <= 720) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { if (!controller.signal.aborted) status(friendlyError(error), true); }
  finally { if (state.controller === controller) busy(false); }
}
let ignoreMapClickUntil = 0, ignoredMapClickPoint;
function installRouteDragging(map) {
  let drag = null;
  const move = event => {
    if (!drag || (event.points && event.points.length !== 1)) return;
    if (event.originalEvent.cancelable) event.originalEvent.preventDefault();
    if (Math.hypot(event.point.x - drag.point.x, event.point.y - drag.point.y) > 5) drag.moved = true;
    drag.destination = [event.lngLat.lng, event.lngLat.lat];
    drag.lastPoint = event.point;
    if (drag.moved) { showEditPoint(drag.destination, drag.edge); $('edit-hint').textContent = 'Release on the street you want to use.'; }
  };
  const finish = () => {
    if (!drag) return;
    const completed = drag; drag = null; ignoreMapClickUntil = Date.now() + 400;
    ignoredMapClickPoint = completed.lastPoint || completed.point;
    map.off('mousemove', move); map.off('touchmove', move); map.off('mouseup', finish); map.off('touchend', finish);
    window.removeEventListener('mouseup', finish); window.removeEventListener('touchend', finish); window.removeEventListener('blur', cancel);
    map.getCanvas().style.cursor = state.editMode ? 'crosshair' : '';
    if (completed.moved) editRoute(completed.edge, completed.destination);
    else if (state.editMode) { state.pendingEdge = completed.edge; showEditPoint(completed.destination); $('edit-hint').textContent = 'Now tap the street you want to use instead.'; }
  };
  const cancel = () => { if (drag) { drag.moved = false; state.editMode = false; finish(); resetRouteEditor(); } };
  const start = event => {
    if (state.busy || drag || !state.routes.length || state.pendingEdge !== null || (event.points && event.points.length !== 1) || (event.originalEvent.button !== undefined && event.originalEvent.button !== 0)) return;
    const edge = closestRouteSegment(event.point); if (edge === null) return;
    event.preventDefault();
    drag = { edge, point: event.point, destination: [event.lngLat.lng, event.lngLat.lat], moved: false };
    map.getCanvas().style.cursor = 'grabbing';
    map.on('mousemove', move); map.on('touchmove', move); map.on('mouseup', finish); map.on('touchend', finish);
    window.addEventListener('mouseup', finish); window.addEventListener('touchend', finish); window.addEventListener('blur', cancel);
  };
  map.on('mousedown', start); map.on('touchstart', start);
  map.on('mousemove', event => { if (!drag && !state.busy) map.getCanvas().style.cursor = state.editMode ? 'crosshair' : closestRouteSegment(event.point) !== null ? 'grab' : ''; });
}
function updateMapRoutes() {
  const map = state.map; if (!map?.getSource('loops')) return;
  const ordered = state.routes.map((route, i) => ({ route, i })).sort((a, b) => Number(a.i === state.selected) - Number(b.i === state.selected));
  map.getSource('loops').setData({ type: 'FeatureCollection', features: ordered.map(({ route, i }) => ({ type: 'Feature', properties: { color: colors[i], width: i === state.selected ? 5 : 3, opacity: i === state.selected ? 1 : .45, index: i, selected: i === state.selected }, geometry: { type: 'LineString', coordinates: route.coords } })) });
}
function fitMap() {
  if (!state.map || !state.routes[state.selected]) return;
  const bounds = new maplibregl.LngLatBounds(); state.routes[state.selected].coords.forEach(p => bounds.extend(p));
  const height = $('route-detail').offsetHeight;
  state.map.fitBounds(bounds, { padding: { top: 85, left: 50, right: 65, bottom: height + 92 }, maxZoom: 16, duration: 700 });
}
async function initMap() {
  try {
    const settings = await config();
    if (!window.maplibregl) throw new Error('Map library unavailable');
    const map = new maplibregl.Map({ container: 'map', center: [-73.9665, 40.7812], zoom: 12.5, attributionControl: true, style: { version: 8, sources: { basemap: { type: 'raster', tiles: [settings.mapTiles], tileSize: 256, maxzoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' } }, layers: [{ id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-saturation': -.65, 'raster-contrast': -.1, 'raster-opacity': .83 } }] } });
    state.map = map; map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    showStartingPoint();
    installRouteDragging(map);
    map.on('load', () => {
      map.addSource('loops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'loop-halo', type: 'line', source: 'loops', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fffefa', 'line-width': ['+', ['get', 'width'], 3], 'line-opacity': ['get', 'opacity'] } });
      map.addLayer({ id: 'loop-lines', type: 'line', source: 'loops', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] } });
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.beginPath(); ctx.moveTo(11, 7); ctx.lineTo(21, 16); ctx.lineTo(11, 25);
      ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = '#244d3d'; ctx.lineWidth = 7; ctx.stroke();
      ctx.strokeStyle = '#fffefa'; ctx.lineWidth = 3; ctx.stroke();
      map.addImage('direction-arrow', ctx.getImageData(0, 0, 32, 32), { pixelRatio: 2 });
      map.addLayer({ id: 'loop-arrows', type: 'symbol', source: 'loops', filter: ['==', ['get', 'selected'], true], layout: { 'symbol-placement': 'line', 'symbol-spacing': 75, 'icon-image': 'direction-arrow', 'icon-rotation-alignment': 'map', 'icon-keep-upright': false, 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      map.addSource('edit-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'edit-preview', type: 'line', source: 'edit-preview', paint: { 'line-color': '#b78646', 'line-width': 3, 'line-dasharray': [2, 2] } });
      updateMapRoutes();
    });
    map.on('error', () => { $('map-error').hidden = false; });
    map.on('idle', () => { if (map.areTilesLoaded()) $('map-error').hidden = true; });
    map.on('click', event => {
      if (state.busy || (Date.now() < ignoreMapClickUntil && ignoredMapClickPoint && Math.hypot(event.point.x - ignoredMapClickPoint.x, event.point.y - ignoredMapClickPoint.y) < 8)) return;
      if (state.drawing) {
        if (Math.abs(event.lngLat.lat) > 85) return;
        const point = event.lngLat.wrap(); state.waypoints.push([point.lng, point.lat]); renderDrawing(); return;
      }
      if (state.editMode) {
        if (state.pendingEdge !== null) { editRoute(state.pendingEdge, [event.lngLat.lng, event.lngLat.lat]); return; }
        const edge = closestRouteSegment(event.point);
        if (edge !== null) { state.pendingEdge = edge; showEditPoint([event.lngLat.lng, event.lngLat.lat]); $('edit-hint').textContent = 'Now tap the street you want to use instead.'; }
        else $('edit-hint').textContent = 'Choose a segment on the selected loop first.';
        return;
      }
      const routes = map.getLayer('loop-lines') ? map.queryRenderedFeatures(event.point, { layers: ['loop-lines'] }) : [];
      if (routes.length) { selectRoute(Number(routes[0].properties.index)); return; }
      if (Math.abs(event.lngLat.lat) > 85) { status('Please choose a starting point below 85° latitude.', true); return; }
      const point = event.lngLat.wrap(); setPlace({ coord: [point.lng, point.lat], name: `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` });
    });
  } catch { $('map-error').hidden = false; }
}
async function loadHistory() {
  try { state.walks = await getWalks(); } catch { state.walks = []; }
  $('history-count').textContent = state.walks.length;
  renderHistory(); renderNextWalk();
}
function renderHistory() {
  $('clear-history').hidden = !state.walks.length;
  $('history-list').innerHTML = state.walks.length ? state.walks.map(w => `<div class="history-item"><div class="history-main"><input class="walk-name" value="${escape(w.name)}" maxlength="80" aria-label="Walk name" data-rename="${escape(w.id)}"><small>${w.placeName ? `${escape(w.placeName)} · ` : ''}${new Date(w.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${formatDistance(w.length)} · ${formatGain(w.gain)} climbing</small></div><span class="history-actions">${w.route ? `<button class="text-button" data-show="${escape(w.id)}">Show on map</button>` : ''}<button class="text-button" data-delete="${escape(w.id)}" aria-label="Remove walk from ${escape(new Date(w.completedAt).toLocaleDateString())}">Remove</button></span></div>`).join('') : '<div class="empty-history">Your next little adventure starts here.<br>Find a loop, head outside, then mark it complete.</div>';
  $('history-list').querySelectorAll('[data-rename]').forEach(input => input.onchange = async () => {
    const walk = state.walks.find(w => w.id === input.dataset.rename), name = input.value.trim();
    if (!walk || !name) { input.value = walk?.name || ''; return; }
    try {
      await saveWalk({ ...walk, name }); walk.name = name;
      const shown = state.routes.find(r => r.id === walk.routeId); if (shown) { shown.name = name; selectRoute(state.selected); }
      toast('Walk renamed.');
    } catch { input.value = walk.name; toast('Could not rename this walk.'); }
  });
  $('history-list').querySelectorAll('[data-show]').forEach(b => b.onclick = () => showWalk(state.walks.find(w => w.id === b.dataset.show)));
  $('history-list').querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => {
    try { await deleteWalk(b.dataset.delete); await loadHistory(); if (state.routes.length) selectRoute(state.selected); }
    catch { toast('Could not remove this walk.'); }
  });
}
function showWalk(walk) {
  if (!walk?.route || state.busy) return;
  $('history-dialog').close();
  setPlace({ coord: walk.origin || walk.route.coords[0], name: walk.placeName || walk.name });
  state.graph = null;
  state.routes = [{ ...walk.route, name: walk.name, id: walk.routeId, placeName: walk.placeName }];
  state.selected = 0; renderRoutes(); selectRoute(0, true);
  status(`Showing your walk from ${new Date(walk.completedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.`);
}
function renderNextWalk() {
  const recent = state.walks[0];
  $('next-walk').hidden = !recent;
  if (!recent) return;
  if (!Number.isFinite(recent.equivalent)) { $('next-walk').innerHTML = '<strong>Keep the good thing going.</strong>Save a walk with elevation data to get an effort-based next step.'; return; }
  const target = recent.equivalent * 1.07;
  $('next-walk').innerHTML = `<strong>A little further, when you’re ready.</strong>Next suggested effort: ${formatDistance(target)} on flat ground — 7% above your last walk, with climbing factored in.<br><button class="text-button" id="use-next">Use this as my next target ↗</button>`;
  $('use-next').onclick = () => {
    if (state.busy) { toast('Finish or cancel the current search first.'); return; }
    const estimate = target / (1 + 9 * recent.gain / recent.length);
    $('distance').value = Math.max(Number($('distance').min), Math.min(Number($('distance').max), estimate / factor())).toFixed(1);
    state.nextTarget = target; updateDistance(); status('Next-walk effort applied. We’ll compare routes using distance plus climbing.'); $('planner').scrollIntoView({ behavior: 'smooth' });
  };
}
$('planner').onsubmit = findLoops;
$('search').onclick = () => searchPlaces();
$('address').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); searchPlaces(); }
  if (event.key === 'ArrowDown' && !$('places').hidden) { event.preventDefault(); $('places').querySelector('button')?.focus(); }
  if (event.key === 'Escape') { cancelPlaceSearch(); $('places').hidden = true; $('address').setAttribute('aria-expanded', 'false'); }
};
$('address').oninput = () => {
  cancelLocation();
  cancelPlaceSearch(); $('places').hidden = true; $('address').setAttribute('aria-expanded', 'false');
  if ($('address').value !== state.query) {
    state.origin = null; state.marker?.remove(); state.marker = null; clearRoutes();
    $('map-label').textContent = 'Choose your new starting point';
  }
  renderSavedLocations();
  const query = $('address').value.trim();
  placeStatus(query.length >= 3 ? 'Looking for matching places…' : 'Type a place, then choose a match to move the map.');
  if (query.length >= 3) searchTimer = setTimeout(() => searchPlaces({ suggest: true }), 650);
};
$('distance').oninput = () => { state.nextTarget = null; updateDistance(); };
document.querySelectorAll('[data-unit]').forEach(button => button.onclick = () => {
  const previousMeters = meters(); state.unit = button.dataset.unit;
  $('distance').min = state.unit === 'mi' ? '.5' : '.8'; $('distance').max = state.unit === 'mi' ? '6' : '9.6';
  $('distance').value = (previousMeters / factor()).toFixed(1);
  document.querySelectorAll('[data-unit]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  updateDistance(); if (state.routes.length) selectRoute(state.selected); renderHistory(); renderNextWalk();
});
document.querySelectorAll('[data-effort]').forEach(button => button.onclick = () => {
  state.effort = button.dataset.effort; state.nextTarget = null;
  document.querySelectorAll('[data-effort]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
});
let locationController, locationSlowTimer;
function locationStatus(message, error = false) { $('location-status').textContent = message; $('location-status').classList.toggle('error', error); }
function cancelLocation() {
  locationController?.abort(); locationController = null; clearTimeout(locationSlowTimer);
  $('locate').innerHTML = '<span aria-hidden="true">⌖</span> Use my location';
  $('locate').setAttribute('aria-busy', 'false'); locationStatus('');
  $('location-diagnostics').hidden = true;
}
$('locate').onclick = async () => {
  if (locationController) { cancelLocation(); locationStatus('Location lookup cancelled. You can enter an address instead.'); return; }
  cancelPlaceSearch();
  if (!window.isSecureContext) { locationStatus('Location needs HTTPS or localhost. You can still search for an address.', true); return; }
  const controller = new AbortController(); locationController = controller;
  $('location-log').textContent = ''; $('location-diagnostics').hidden = false; $('location-diagnostics').open = false;
  const diagnostic = event => {
    console.info('[Loops location]', event);
    if (locationController === controller) $('location-log').textContent += `${JSON.stringify(event)}\n`;
  };
  diagnostic({ event: 'environment', secureContext: window.isSecureContext, visibility: document.visibilityState });
  $('locate').textContent = 'Cancel location lookup'; $('locate').setAttribute('aria-busy', 'true');
  locationStatus('Waiting for your browser’s location. Allow access if prompted.');
  locationSlowTimer = setTimeout(() => locationStatus('Still waiting for your device. You can cancel or enter an address at any time.'), 4000);
  try {
    const location = await currentLocation({ signal: controller.signal, onDiagnostic: diagnostic });
    if (controller.signal.aborted) return;
    setPlace({ coord: location.coord, name: 'My current location' });
    locationStatus(`Location found${Number.isFinite(location.accuracy) ? ` (within about ${Math.round(location.accuracy)} m)` : ''}. ${location.accuracy > 250 ? 'This is approximate; check the pin or select a more precise starting point.' : 'The map is centered on your starting point. Choose Save this start to keep it.'}`);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn('[Loops location]', error.message);
      locationStatus(error.message, true); $('location-diagnostics').open = true;
    }
  }
  finally {
    if (locationController === controller) {
      locationController = null; clearTimeout(locationSlowTimer);
      $('locate').innerHTML = '<span aria-hidden="true">⌖</span> Use my location'; $('locate').setAttribute('aria-busy', 'false');
    }
  }
};
function renderSavedLocations() {
  $('save-location').disabled = !state.origin;
  $('saved-locations').hidden = !state.locations.length;
  $('saved-location').innerHTML = '<option value="">Saved starting points</option>' + state.locations.map(location => `<option value="${escape(location.id)}">${location.id === state.defaultLocation ? '★ ' : ''}${escape(location.name)}</option>`).join('');
  const selected = state.locations.find(location => state.origin && location.coord.every((n, i) => Math.abs(n - state.origin[i]) < .000001));
  $('saved-location').value = selected?.id || ''; $('remove-location').hidden = !selected;
}
async function loadSavedLocations(restore = false) {
  try {
    [state.locations, state.defaultLocation] = await Promise.all([getLocations(), getDefaultLocation()]);
    renderSavedLocations();
    const saved = state.locations.find(location => location.id === state.defaultLocation);
    if (restore && saved && !state.origin && !$('address').value.trim() && !locationController && !state.busy) {
      setPlace(saved); placeStatus('Your saved starting point is ready.');
    }
  } catch (error) { locationStatus(`Saved locations are unavailable. ${error.message}`, true); }
}
let locationToSave;
$('save-location').onclick = () => {
  if (!state.origin) return;
  locationToSave = { coord: [...state.origin], name: state.placeName };
  const existing = state.locations.find(location => location.coord.every((n, i) => Math.abs(n - state.origin[i]) < .000001));
  if (existing) locationToSave.id = existing.id;
  $('location-name').value = existing?.name || (state.placeName === 'My current location' ? 'Home' : state.placeName);
  $('location-default').checked = !state.defaultLocation || existing?.id === state.defaultLocation;
  $('save-location-error').textContent = ''; $('save-location-dialog').showModal();
};
$('save-location-close').onclick = () => $('save-location-dialog').close();
$('save-location-form').onsubmit = async event => {
  event.preventDefault();
  const name = $('location-name').value.trim(); if (!name) { $('location-name').focus(); return; }
  $('save-location-submit').disabled = true;
  try {
    const saved = { ...locationToSave, name, id: locationToSave.id || crypto.randomUUID() };
    await saveLocation(saved);
    if ($('location-default').checked) await setDefaultLocation(saved.id);
    else if (state.defaultLocation === saved.id) await setDefaultLocation(null);
    await loadSavedLocations(); $('save-location-dialog').close(); toast('Starting point saved on this device.');
  } catch { $('save-location-error').textContent = 'Could not save this location. Browser storage may be unavailable.'; }
  finally { $('save-location-submit').disabled = false; }
};
$('saved-location').onchange = () => {
  const selected = state.locations.find(location => location.id === $('saved-location').value);
  if (selected) setPlace(selected); else $('remove-location').hidden = true;
};
$('remove-location').onclick = async () => {
  const id = $('saved-location').value; if (!id) return;
  try { await deleteLocation(id); if (id === state.defaultLocation) await setDefaultLocation(null); await loadSavedLocations(); toast('Saved starting point removed.'); }
  catch { locationStatus('Could not remove this saved location.', true); }
};
$('cancel').onclick = () => { state.controller?.abort(); resetRouteEditor(); stopDrawing(); busy(false); if ($('edit-hint')) $('edit-hint').textContent = 'Edit cancelled. Your loop is unchanged.'; status('Search cancelled. Ready when you are.'); };
$('example').onclick = () => { setPlace({ coord: [-73.9819, 40.7681], name: 'Central Park · Columbus Circle' }); findLoops(); };
$('fit-map').onclick = fitMap;
$('draw').onclick = startDrawing; $('draw-cancel').onclick = () => { stopDrawing(); status('Drawing cancelled.'); };
$('draw-undo').onclick = () => { state.waypoints.pop(); renderDrawing(); };
$('draw-finish').onclick = finishDrawing;
$('history-open').onclick = () => { renderHistory(); $('history-dialog').showModal(); };
$('history-close').onclick = () => $('history-dialog').close();
$('history-dialog').onclick = event => { if (event.target === $('history-dialog')) { const rect = $('history-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('history-dialog').close(); } };
$('clear-history').onclick = async () => {
  if (!confirm('Clear all completed walks from this device?')) return;
  try { await clearWalks(); state.nextTarget = null; await loadHistory(); if (state.routes.length) selectRoute(state.selected); toast('Walk history cleared.'); } catch { toast('Could not clear walk history.'); }
};
updateDistance(); loadHistory(); loadSavedLocations(true);
// The deferred CDN script is guaranteed to have settled by DOMContentLoaded.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMap, { once: true }); else initMap();
