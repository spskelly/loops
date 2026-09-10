import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, destination, resample, elevationGain, equivalentDistance, toGPX, reverseRoute, startingDirection } from '../src/geo.js';
import { walkable, buildGraph, shortestPaths, nearest, generateLoops, rerouteSection, traceRoute, jaccard } from '../src/routing.js';
import { currentLocation } from '../src/location.js';
import { decodeTerrarium, mercatorPixel } from '../src/services.js';

test('geodesic distance, bearing and sampling preserve physical distances', () => {
  const start = [-73.97, 40.77], end = destination(start, 1000, 90);
  assert.ok(Math.abs(distance(start, end) - 1000) < .001);
  const samples = resample([start, end], 20);
  assert.ok(samples.length >= 51);
  for (let i = 1; i < samples.length; i++) assert.ok(distance(samples[i - 1].coord, samples[i].coord) <= 20.01);
  assert.ok(Math.abs(samples.at(-1).meters - 1000) < .001);
  assert.deepEqual(samples.at(-1).coord, end);
});
test('resampling takes the short way across the antimeridian', () => {
  const samples = resample([[179.999, 0], [-179.999, 0]], 20);
  assert.ok(samples.every(p => Math.abs(p.coord[0]) > 179.99));
});
test('hysteresis ignores flat-road noise and counts sustained climbs', () => {
  assert.equal(elevationGain([100, 101, 99, 101, 100, 99, 100]), 0);
  assert.equal(elevationGain([0, 1, 2, 3, 4, 5, 4, 3, 2, 3, 4, 5, 6]), 9);
  assert.equal(elevationGain([10, 9, 8, 7, 6]), 0);
  assert.equal(elevationGain([0, 5, 4, 6, 3]), 6);
  assert.equal(elevationGain([1, null, 2]), null);
  assert.equal(equivalentDistance(2000, 100), 2900);
  assert.equal(equivalentDistance(2000, null), null);
});
test('access restrictions respect explicit walking permission', () => {
  assert.equal(walkable({ highway: 'residential' }), true);
  assert.equal(walkable({ highway: 'residential', access: 'private' }), false);
  assert.equal(walkable({ highway: 'path', foot: 'no' }), false);
  assert.equal(walkable({ highway: 'path', access: 'private', foot: 'yes' }), true);
  assert.equal(walkable({ highway: 'motorway' }), false);
  assert.equal(walkable({ highway: 'pedestrian', area: 'yes' }), false);
  assert.equal(walkable({ highway: 'path', 'foot:conditional': 'yes @ (sunrise-sunset)' }), false);
});
function square() {
  return [
    { type: 'node', id: 1, lon: 0, lat: 0 }, { type: 'node', id: 2, lon: .001, lat: 0 },
    { type: 'node', id: 3, lon: .001, lat: .001 }, { type: 'node', id: 4, lon: 0, lat: .001 },
    { type: 'way', id: 100, nodes: [1, 2, 3, 4, 1], tags: { highway: 'residential', oneway: 'yes' } },
  ];
}
test('walking can go against a vehicle one-way, but respects foot one-way and barriers', () => {
  const data = square(); let graph = buildGraph(data);
  assert.equal(graph.adjacency.get(2).some(e => e.to === 1), true);
  data[4].tags['oneway:foot'] = 'yes'; graph = buildGraph(data);
  assert.equal(graph.adjacency.get(2).some(e => e.to === 1), false);
  data[1].tags = { barrier: 'gate', access: 'private' }; graph = buildGraph(data);
  assert.equal(graph.nodes.has(2), false);
});
test('shortest path reuse penalty chooses the other side of a block', () => {
  const graph = buildGraph(square());
  const direct = shortestPaths(graph, 1, 2);
  const detour = shortestPaths(graph, 1, 2, new Set(['1:2']));
  assert.equal(direct.previous.get(2).from, 1);
  assert.equal(detour.previous.get(2).from, 3);
  assert.ok(detour.costs.get(2) > direct.costs.get(2));
});
export function grid(size = 17) {
  const elements = [], half = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) elements.push({ type: 'node', id: y * size + x + 1, lon: (x - half) * .001, lat: (y - half) * .001 });
  for (let i = 0; i < size; i++) {
    elements.push({ type: 'way', id: 10000 + i, nodes: Array.from({ length: size }, (_, x) => i * size + x + 1), tags: { highway: 'residential', name: `Street ${i}` } });
    elements.push({ type: 'way', id: 20000 + i, nodes: Array.from({ length: size }, (_, y) => y * size + i + 1), tags: { highway: 'footway' } });
  }
  return elements;
}
test('bearing sweep returns distinct closed walks made entirely of graph edges', () => {
  const data = grid(), graph = buildGraph(data), loops = generateLoops(data, [0, 0], 1600);
  assert.ok(loops.length >= 3);
  for (const loop of loops) {
    assert.deepEqual(loop.coords[0], loop.coords.at(-1));
    assert.ok(loop.length > 1600 * .6 && loop.length < 1600 * 1.45);
    assert.ok(loop.overlap <= .32);
    for (let i = 1; i < loop.coords.length; i++) {
      const from = [...graph.nodes].find(([, p]) => p[0] === loop.coords[i - 1][0] && p[1] === loop.coords[i - 1][1])[0];
      const to = [...graph.nodes].find(([, p]) => p[0] === loop.coords[i][0] && p[1] === loop.coords[i][1])[0];
      assert.ok(graph.adjacency.get(from).some(e => e.to === to));
    }
  }
  for (let i = 0; i < loops.length; i++) for (let j = i + 1; j < loops.length; j++) assert.ok(jaccard(new Set(loops[i].edgeKeys), new Set(loops[j].edgeKeys)) < .72);
});
test('empty or disconnected areas produce actionable errors', () => {
  assert.throws(() => generateLoops([], [0, 0], 1600), /No mapped walking path/);
  assert.throws(() => generateLoops(square(), [0, 0], 1600), /too few connected paths/);
  assert.throws(() => generateLoops(grid(), [10, 10], 1600), /within 250 m/);
});
test('Terrarium decoding and tile coordinates match the published encoding', () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(137, 219, 68), 2523.265625);
  assert.equal(decodeTerrarium(127, 255, 0), -1);
  assert.deepEqual(mercatorPixel([0, 0]), [2097151.5, 2097151.5]);
});
test('GPX escapes names and omits unknown elevation', () => {
  const xml = toGPX({ name: 'Park & <Lake>', coords: [[0, 0], [.001, 0], [0, 0]] });
  assert.ok(xml.includes('Park &amp; &lt;Lake&gt;'));
  assert.equal((xml.match(/<trkpt /g) || []).length, 3);
  assert.ok(!xml.includes('<ele>'));
  const terrain = toGPX({ name: 'Walk', profile: [{ coord: [0, 0], elevation: 2.567 }] });
  assert.ok(terrain.includes('<ele>2.57</ele>'));
  const corners = [[0, 0], [.001, 0], [.001, .001], [0, 0]];
  const sampled = resample(corners).map(p => ({ ...p, elevation: 10 }));
  const withTerrain = toGPX({ name: 'Corners', coords: corners, profile: sampled });
  assert.equal((withTerrain.match(/<trkpt /g) || []).length, corners.length);
  assert.ok(withTerrain.includes('<trkpt lat="0" lon="0.001"><ele>10.00</ele>'));
});
test('reversing preserves the start, geometry and distance while reversing elevation and GPX', () => {
  const coords = [[0, 0], [.001, 0], [.001, .001], [0, 0]];
  const profile = [
    { coord: coords[0], meters: 0, elevation: 0 },
    { coord: coords[1], meters: 100, elevation: 10 },
    { coord: coords[2], meters: 230, elevation: 4 },
    { coord: coords[3], meters: 380, elevation: 0 },
  ];
  const original = { name: 'Loop', coords, profile, length: 380, gain: 10, reversible: true };
  const reversed = reverseRoute(original);
  assert.deepEqual(reversed.coords, [...coords].reverse());
  assert.deepEqual(reversed.coords[0], original.coords[0]);
  assert.equal(reversed.length, original.length);
  assert.deepEqual(reversed.profile.map(p => p.meters), [0, 150, 280, 380]);
  assert.deepEqual(reversed.profile.map(p => p.elevation), [0, 4, 10, 0]);
  assert.equal(reversed.gain, 10);
  assert.equal(startingDirection(original.coords), 'east');
  assert.equal(startingDirection(reversed.coords), 'northeast');
  const restored = reverseRoute(reversed);
  assert.deepEqual(restored.coords, original.coords);
  assert.deepEqual(restored.profile, original.profile);
  assert.equal(restored.reversed, false);
  const points = xml => [...xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(points(toGPX(reversed)), points(toGPX(original)).reverse());
  assert.deepEqual(original.coords, coords);
  assert.equal(reverseRoute({ ...original, profile: null, gain: null }).gain, null);
});
test('loops with one-way walking edges cannot be reversed', () => {
  const elements = Array.from({ length: 16 }, (_, i) => {
    const [lon, lat] = destination([0, 0], 250, i * 22.5);
    return { type: 'node', id: i + 1, lon, lat };
  });
  elements.push({ type: 'way', id: 100, nodes: [...Array.from({ length: 16 }, (_, i) => i + 1), 1], tags: { highway: 'footway', 'oneway:foot': 'yes' } });
  const routes = generateLoops(elements, [elements[0].lon, elements[0].lat], 1600);
  assert.ok(routes.length > 0);
  assert.ok(routes.every(r => r.reversible === false));
  assert.throws(() => reverseRoute(routes[0]), /one-way walking segment/);
  assert.ok(generateLoops(grid(), [0, 0], 1600).every(r => r.reversible === true));
});
test('drag detours exclude the selected edge and remain closed graph walks', () => {
  const elements = grid(), graph = buildGraph(elements), original = generateLoops(elements, [0, 0], 1600)[0];
  const index = Math.floor(original.nodeIds.length / 3);
  const drop = destination(original.coords[index], 160, 45);
  const edited = rerouteSection(elements, original, index, drop);
  const removed = [original.nodeIds[index], original.nodeIds[index + 1]].sort((a, b) => a - b).join(':');
  assert.ok(!edited.edgeKeys.includes(removed));
  assert.ok(edited.avoidedEdges.includes(removed));
  assert.deepEqual(edited.coords[0], original.coords[0]);
  assert.deepEqual(edited.coords.at(-1), original.coords[0]);
  assert.ok(edited.coords.some(p => distance(p, drop) < 100));
  for (let i = 1; i < edited.nodeIds.length; i++) assert.ok(graph.adjacency.get(edited.nodeIds[i - 1]).some(e => e.to === edited.nodeIds[i]));
  const measured = edited.coords.slice(1).reduce((sum, p, i) => sum + distance(edited.coords[i], p), 0);
  assert.ok(Math.abs(measured - edited.length) < .001);
  assert.equal(edited.profile, null);
  assert.equal(edited.gain, null);
  assert.notDeepEqual(edited.nodeIds, original.nodeIds);
  assert.throws(() => rerouteSection(elements, original, index, [40, 40]), /Drop closer/);
  const reversed = reverseRoute(original);
  assert.deepEqual(reversed.nodeIds, [...original.nodeIds].reverse());
});
test('location requests give actionable errors and a hard deadline even without a browser callback', async () => {
  const position = await currentLocation({ geolocation: { getCurrentPosition: success => success({ coords: { longitude: -71, latitude: 42, accuracy: 30 } }) } });
  assert.deepEqual(position, { coord: [-71, 42], accuracy: 30 });
  for (const [code, message] of [[1, /blocked/], [2, /could not determine/], [3, /timed out/]]) {
    await assert.rejects(currentLocation({ geolocation: { getCurrentPosition: (_, failure) => failure({ code }) } }), message);
  }
  await assert.rejects(currentLocation({ timeout: 20, geolocation: { getCurrentPosition() {} } }), /timed out/);
  let lateCallback;
  const controller = new AbortController();
  const lookup = currentLocation({ signal: controller.signal, geolocation: { getCurrentPosition: success => { lateCallback = success; } } });
  controller.abort();
  await assert.rejects(lookup, { name: 'AbortError' });
  lateCallback({ coords: { longitude: 0, latitude: 0, accuracy: 100 } });
});
test('location diagnostics distinguish app deadlines, permission prompts, and native errors without logging coordinates', async () => {
  for (const state of ['prompt', 'granted']) {
    const events = [];
    await assert.rejects(currentLocation({
      timeout: 20,
      geolocation: { getCurrentPosition() {} },
      permissions: { query: async () => ({ state }) },
      onDiagnostic: event => events.push(event),
    }), state === 'prompt' ? /permission is still waiting/ : /Site permission is allowed/);
    assert.ok(events.some(e => e.event === 'permission' && e.permission === state));
    assert.ok(events.some(e => e.event === 'app-timeout' && e.permission === state));
    assert.ok(!events.some(e => e.event === 'browser-error'));
  }
  const events = [];
  await assert.rejects(currentLocation({ geolocation: { getCurrentPosition: (_, failure) => failure({ code: 2, message: 'Provider unavailable' }) }, onDiagnostic: event => events.push(event) }), /could not determine/);
  assert.ok(events.some(e => e.event === 'browser-error' && e.code === 2 && e.message === 'Provider unavailable'));
  events.length = 0;
  await currentLocation({ geolocation: { getCurrentPosition: success => success({ coords: { longitude: -71.07004, latitude: 42.35409, accuracy: 15 } }) }, onDiagnostic: event => events.push(event) });
  assert.ok(events.some(e => e.event === 'position-received' && e.accuracyMeters === 15));
  assert.ok(!JSON.stringify(events).includes('-71.07004'));
  assert.ok(!JSON.stringify(events).includes('42.35409'));
});
test('drawn routes snap waypoints to the graph and connect them with walking paths', () => {
  const elements = grid(), graph = buildGraph(elements);
  const waypoints = [[0, 0], [.0031, .0002], [.0029, .0031], [.0002, .0028]];
  const route = traceRoute(elements, waypoints);
  assert.deepEqual(route.coords[0], [0, 0]);
  assert.deepEqual(route.coords.at(-1), route.coords[0]);
  for (const point of waypoints) assert.ok(route.coords.some(p => distance(p, point) < 50));
  for (let i = 1; i < route.nodeIds.length; i++) assert.ok(graph.adjacency.get(route.nodeIds[i - 1]).some(e => e.to === route.nodeIds[i]));
  const measured = route.coords.slice(1).reduce((sum, p, i) => sum + distance(route.coords[i], p), 0);
  assert.ok(Math.abs(measured - route.length) < .001);
  assert.ok(route.length > 1000 && route.length < 1500);
  assert.equal(route.overlap, 0);
  assert.equal(route.reversible, true);
  assert.equal(route.gain, null);
  assert.equal(route.drawn, true);
  assert.ok(route.edgeKeys.length > 0);
  assert.throws(() => traceRoute(elements, [[0, 0], [10, 10]]), /Point 2/);
  assert.throws(() => traceRoute(elements, [[0, 0]]), /at least one/);
  assert.throws(() => traceRoute(elements, [[0, 0], [.00001, 0]]), /at least one/);
});
test('mid-block taps snap to the street segment, not a nearby dead-end node', () => {
  // A dead-end footway tip 50 m from the tap; the nearest street nodes are 58 m away but the street line is 17 m away.
  const elements = [...grid(), { type: 'node', id: 999, lon: .0025, lat: .0006 }, { type: 'way', id: 30000, nodes: [147, 999], tags: { highway: 'footway' } }];
  const graph = buildGraph(elements);
  assert.equal(nearest(graph, [.0025, .00015]).id, 999, 'node snapping would have chosen the dead end');
  const route = traceRoute(elements, [[0, 0], [.0025, .00015], [.003, .003], [0, .003]]);
  assert.ok(!route.nodeIds.includes(999), 'route must not detour to the dead end');
  assert.ok(route.nodeIds.includes(147), 'route enters the tapped street at its near end');
  // A tap exactly on a corner reaches that corner rather than stopping a block short.
  const corner = traceRoute(elements, [[0, 0], [.002, 0], [.002, .002], [0, .002]]);
  assert.ok(corner.nodeIds.includes(147) && corner.nodeIds.includes(181));
});
test('busy roads are walkable at a high penalty so drawn routes can follow their sidewalks', () => {
  assert.equal(walkable({ highway: 'primary' }), true);
  assert.equal(walkable({ highway: 'secondary', sidewalk: 'both' }), true);
  assert.equal(walkable({ highway: 'trunk' }), false);
  const graph = buildGraph([{ type: 'node', id: 1, lon: 0, lat: 0 }, { type: 'node', id: 2, lon: .001, lat: 0 }, { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'primary' } }]);
  const edge = graph.adjacency.get(1)[0];
  assert.ok(edge.weight > edge.length * 2 && !edge.quiet);
});
