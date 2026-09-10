import { distance, destination, edgeKey } from './geo.js';
const penalties = { footway: 1, pedestrian: 1, path: 1.08, living_street: 1.12, track: 1.2, residential: 1.3, unclassified: 1.5, tertiary: 1.85, steps: 1.8 };
const denied = new Set(['no', 'private', 'customers', 'delivery', 'permit', 'agricultural', 'forestry', 'destination', 'use_sidepath']);
export function walkable(tags = {}) {
  if (!(tags.highway in penalties) || tags.area === 'yes' || tags.indoor === 'yes') return false;
  if (tags['access:conditional'] || tags['foot:conditional']) return false;
  if (tags.foot) return !denied.has(tags.foot);
  return !denied.has(tags.access) && tags.motorroad !== 'yes';
}
function blocked(tags = {}) {
  if (denied.has(tags.foot)) return true;
  if (['yes', 'designated', 'permissive'].includes(tags.foot)) return false;
  return denied.has(tags.access) || ['wall', 'fence', 'hedge', 'retaining_wall'].includes(tags.barrier);
}
export function buildGraph(elements) {
  const nodes = new Map(), adjacency = new Map();
  for (const e of elements) if (e.type === 'node' && !blocked(e.tags)) nodes.set(e.id, [e.lon, e.lat]);
  for (const way of elements) {
    if (way.type !== 'way' || !walkable(way.tags)) continue;
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1], b = way.nodes[i];
      if (!nodes.has(a) || !nodes.has(b) || a === b) continue;
      const length = distance(nodes.get(a), nodes.get(b));
      const penalty = penalties[way.tags.highway] * (way.tags.sidewalk === 'no' ? 1.15 : 1);
      const edge = { length, weight: length * penalty, key: edgeKey(a, b), quiet: penalty <= 1.2, name: way.tags.name || '', steps: way.tags.highway === 'steps' };
      const add = (from, to) => { if (!adjacency.has(from)) adjacency.set(from, []); adjacency.get(from).push({ ...edge, to }); };
      // Vehicle one-way rules don't constrain walkers; explicit foot one-way rules do.
      if (way.tags['oneway:foot'] !== '-1') add(a, b);
      if (!['yes', '1', 'true'].includes(way.tags['oneway:foot'])) add(b, a);
    }
  }
  for (const id of nodes.keys()) if (!adjacency.has(id)) nodes.delete(id);
  return { nodes, adjacency };
}
export function nearest(graph, coord, allowed) {
  let id = null, meters = Infinity;
  for (const [key, point] of graph.nodes) {
    if (allowed && !allowed.has(key)) continue;
    const d = distance(coord, point);
    if (d < meters) { id = key; meters = d; }
  }
  return { id, meters };
}
class Heap {
  items = [];
  push(item) {
    const a = this.items; a.push(item); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= item[0]) break; a[i] = a[p]; i = p; } a[i] = item;
  }
  pop() {
    const a = this.items, result = a[0], last = a.pop();
    if (a.length) { let i = 0; while (i * 2 + 1 < a.length) { let c = i * 2 + 1; if (c + 1 < a.length && a[c + 1][0] < a[c][0]) c++; if (a[c][0] >= last[0]) break; a[i] = a[c]; i = c; } a[i] = last; }
    return result;
  }
}
export function shortestPaths(graph, start, target = null, reused = new Set(), maxCost = Infinity) {
  const costs = new Map([[start, 0]]), previous = new Map(), heap = new Heap(); heap.push([0, start]);
  while (heap.items.length) {
    const [cost, node] = heap.pop();
    if (cost !== costs.get(node)) continue;
    if (node === target) break;
    for (const edge of graph.adjacency.get(node) || []) {
      const next = cost + edge.weight * (reused.has(edge.key) ? 5 : 1);
      if (next > maxCost || next >= (costs.get(edge.to) ?? Infinity)) continue;
      costs.set(edge.to, next); previous.set(edge.to, { from: node, edge }); heap.push([next, edge.to]);
    }
  }
  return { costs, previous };
}
function path(tree, from, to) {
  if (!tree.costs.has(to)) return null;
  const nodes = [to], edges = [];
  while (to !== from) { const step = tree.previous.get(to); if (!step) return null; edges.push(step.edge); nodes.push(step.from); to = step.from; }
  return { nodes: nodes.reverse(), edges: edges.reverse() };
}
export function jaccard(a, b) {
  let shared = 0; for (const key of a) if (b.has(key)) shared++;
  return shared / (a.size + b.size - shared || 1);
}
export function generateLoops(elements, origin, target, onProgress = () => {}) {
  const graph = buildGraph(elements), start = nearest(graph, origin);
  if (start.id === null || start.meters > 250) throw new Error('No mapped walking path within 250 m. Try a nearby street or park entrance.');
  const tree = shortestPaths(graph, start.id, null, new Set(), target * 2.5);
  if (tree.costs.size < 8) throw new Error('This starting point has too few connected paths. Try another nearby street.');
  const candidates = [], seenAnchors = new Set(), center = graph.nodes.get(start.id);
  for (let angle = 0; angle < 360; angle += 30) {
    onProgress(angle / 360);
    for (const scale of [.18, .25, .32]) for (const turn of [-75, 75]) {
      const a = nearest(graph, destination(center, target * scale, angle), tree.costs).id;
      const b = nearest(graph, destination(center, target * scale, angle + turn), tree.costs).id;
      if (a === b || a === start.id || b === start.id || seenAnchors.has(`${a}:${b}`)) continue;
      seenAnchors.add(`${a}:${b}`);
      const first = path(tree, start.id, a); if (!first) continue;
      const used = new Set(first.edges.map(e => e.key));
      const second = path(shortestPaths(graph, a, b, used, target * 7), a, b); if (!second) continue;
      second.edges.forEach(e => used.add(e.key));
      const third = path(shortestPaths(graph, b, start.id, used, target * 7), b, start.id); if (!third) continue;
      const edges = [...first.edges, ...second.edges, ...third.edges];
      const length = edges.reduce((s, e) => s + e.length, 0);
      if (length < target * .6 || length > target * 1.45) continue;
      const edgeLengths = new Map(edges.map(e => [e.key, e.length]));
      const uniqueLength = [...edgeLengths.values()].reduce((s, n) => s + n, 0);
      const overlap = 1 - uniqueLength / length;
      if (overlap > .32) continue;
      const quiet = edges.reduce((s, e) => s + (e.quiet ? e.length : 0), 0) / length;
      const score = Math.abs(length - target) / target * 3 + overlap * 3 + (1 - quiet) * .2;
      const nodeIds = [...first.nodes, ...second.nodes.slice(1), ...third.nodes.slice(1)];
      const coords = nodeIds.map(id => graph.nodes.get(id));
      const reversible = nodeIds.slice(1).every((id, i) => graph.adjacency.get(id)?.some(e => e.to === nodeIds[i]));
      const names = new Map(); for (const e of edges) if (e.name) names.set(e.name, (names.get(e.name) || 0) + e.length);
      candidates.push({ coords, nodeIds, length, overlap, quiet, score, reversible, edgeKeys: [...edgeLengths.keys()], gain: null, steps: edges.some(e => e.steps), startOffset: start.meters, via: [...names].sort((a, b) => b[1] - a[1])[0]?.[0] || '' });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const distinct = [];
  for (const route of candidates) {
    if (distinct.every(r => jaccard(new Set(r.edgeKeys), new Set(route.edgeKeys)) < .72)) distinct.push(route);
    if (distinct.length === 8) break;
  }
  if (!distinct.length) throw new Error('No good loops at this distance. Try a longer walk or move the starting point to a more connected area.');
  return distinct;
}

// Replace only the neighborhood around a dragged segment, preserving the rest of the loop.
export function rerouteSection(elements, route, edgeIndex, destinationCoord) {
  const ids = route.nodeIds;
  if (!ids || !Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= ids.length - 1) throw new Error('Select a segment on the current loop to adjust.');
  const graph = buildGraph(elements);
  const avoidedEdges = new Set(route.avoidedEdges || []);
  const removed = edgeKey(ids[edgeIndex], ids[edgeIndex + 1]); avoidedEdges.add(removed);
  for (const [id, edges] of graph.adjacency) graph.adjacency.set(id, edges.filter(e => !avoidedEdges.has(e.key)));
  const target = nearest(graph, destinationCoord);
  if (target.id === null || target.meters > 150) throw new Error('Drop closer to a mapped path in this area. Your loop has not changed.');
  const occurrences = ids.slice(1).flatMap((id, i) => edgeKey(ids[i], id) === removed ? [i] : []);
  let left = occurrences[0], right = occurrences.at(-1) + 1;
  const reach = Math.min(600, Math.max(160, distance(route.coords[edgeIndex], destinationCoord)));
  for (let length = 0; left > 0 && length < reach; left--) length += distance(route.coords[left], route.coords[left - 1]);
  for (let length = 0; right < ids.length - 1 && length < reach; right++) length += distance(route.coords[right], route.coords[right + 1]);
  if (target.id === ids[left] || target.id === ids[right]) throw new Error('Drop on a different part of the walking network to make a detour.');
  const kept = new Set();
  for (let i = 0; i < ids.length - 1; i++) if (i < left || i >= right) kept.add(edgeKey(ids[i], ids[i + 1]));
  const budget = Math.max(route.length * 8, 10000);
  const first = path(shortestPaths(graph, ids[left], target.id, kept, budget), ids[left], target.id);
  if (!first) throw new Error('No walkable detour reaches that point without the selected segment. Try another nearby street.');
  first.edges.forEach(e => kept.add(e.key));
  const second = path(shortestPaths(graph, target.id, ids[right], kept, budget), target.id, ids[right]);
  if (!second) throw new Error('No walkable detour returns to your loop from there. Try another nearby street.');
  const nodeIds = [...ids.slice(0, left), ...first.nodes, ...second.nodes.slice(1), ...ids.slice(right + 1)];
  const edges = nodeIds.slice(1).map((id, i) => graph.adjacency.get(nodeIds[i])?.find(e => e.to === id));
  if (edges.some(e => !e)) throw new Error('This detour crosses a restricted segment. Try another street.');
  const length = edges.reduce((sum, e) => sum + e.length, 0);
  const unique = new Map(edges.map(e => [e.key, e.length]));
  const overlap = 1 - [...unique.values()].reduce((sum, n) => sum + n, 0) / length;
  if (overlap > .4 || length > Math.max(route.length * 2, route.length + 2000)) throw new Error('That detour would add too much retracing or distance. Try a closer street.');
  const names = new Map(); for (const e of edges) if (e.name) names.set(e.name, (names.get(e.name) || 0) + e.length);
  return {
    ...route, nodeIds, coords: nodeIds.map(id => graph.nodes.get(id)), length, overlap,
    quiet: edges.reduce((sum, e) => sum + (e.quiet ? e.length : 0), 0) / length,
    steps: edges.some(e => e.steps), edgeKeys: [...unique.keys()], avoidedEdges: [...avoidedEdges],
    reversible: nodeIds.slice(1).every((id, i) => graph.adjacency.get(id)?.some(e => e.to === nodeIds[i])),
    via: [...names].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    gain: null, profile: null, edited: true, editPoint: graph.nodes.get(target.id),
  };
}
