export const EARTH = 6371008.8;
const rad = n => n * Math.PI / 180;
export function distance(a, b) {
  const p = rad(b[1] - a[1]), l = rad(b[0] - a[0]);
  const h = Math.sin(p / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(l / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function destination(origin, meters, bearing) {
  const d = meters / EARTH, t = rad(bearing), p = rad(origin[1]), l = rad(origin[0]);
  const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(t));
  const l2 = l + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
  return [((l2 * 180 / Math.PI + 540) % 360) - 180, p2 * 180 / Math.PI];
}
export const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
export function resample(coords, spacing = 20) {
  if (!coords.length) return [];
  const samples = [{ coord: coords[0], meters: 0 }];
  let total = 0, next = spacing;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i], length = distance(a, b);
    let dl = b[0] - a[0]; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
    while (next <= total + length && length > 0) {
      const f = (next - total) / length;
      samples.push({ coord: [((a[0] + dl * f + 540) % 360) - 180, a[1] + (b[1] - a[1]) * f], meters: next }); next += spacing;
    }
    total += length;
  }
  if (total > samples.at(-1).meters) samples.push({ coord: coords.at(-1), meters: total });
  return samples;
}
// Track extrema; ignore reversals smaller than the threshold, including flat-road jitter.
export function elevationGain(values, threshold = 3) {
  if (!values.length || values.some(v => !Number.isFinite(v))) return null;
  let low = values[0], high = low, climbing = false, gain = 0;
  for (const value of values.slice(1)) {
    if (!climbing) {
      low = Math.min(low, value);
      if (value - low >= threshold) { climbing = true; high = value; }
    } else {
      high = Math.max(high, value);
      if (high - value >= threshold) { gain += high - low; low = value; climbing = false; }
    }
  }
  return gain + (climbing ? high - low : 0);
}
export function equivalentDistance(length, gain) { return Number.isFinite(gain) ? length + gain * 9 : null; }
export function startingDirection(coords) {
  const a = coords[0], b = coords.slice(1).find(p => distance(a, p) >= 10) || coords[1];
  if (!a || !b) return '';
  const p1 = rad(a[1]), p2 = rad(b[1]), dl = rad(b[0] - a[0]);
  const bearing = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(bearing / 45) % 8];
}
export function reverseRoute(route) {
  if (route.reversible === false) throw new Error('This loop includes a one-way walking segment.');
  const profile = route.profile?.length ? [...route.profile].reverse().map(p => ({ ...p, meters: route.profile.at(-1).meters - p.meters })) : null;
  return { ...route, coords: [...route.coords].reverse(), nodeIds: route.nodeIds ? [...route.nodeIds].reverse() : undefined, profile, gain: profile ? elevationGain(profile.map(p => p.elevation)) : null, reversed: !route.reversed };
}
export function toGPX(route) {
  const escape = s => String(s).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' })[c]);
  // Keep every graph vertex in exports: fixed-interval samples can cut corners.
  let traveled = 0, sampleIndex = 0;
  const points = route.coords ? route.coords.map((coord, i) => {
    if (i) traveled += distance(route.coords[i - 1], coord);
    const point = { coord };
    if (route.profile?.length) {
      while (sampleIndex + 1 < route.profile.length && route.profile[sampleIndex + 1].meters < traveled) sampleIndex++;
      const a = route.profile[sampleIndex], b = route.profile[Math.min(sampleIndex + 1, route.profile.length - 1)];
      if (Number.isFinite(a.elevation) && Number.isFinite(b.elevation)) {
        const fraction = Math.min(1, Math.max(0, (traveled - a.meters) / (b.meters - a.meters || 1)));
        point.elevation = a.elevation + (b.elevation - a.elevation) * fraction;
      }
    }
    return point;
  }) : route.profile || [];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Loops" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${escape(route.name)}</name><trkseg>${points.map(p => `<trkpt lat="${p.coord[1]}" lon="${p.coord[0]}">${Number.isFinite(p.elevation) ? `<ele>${p.elevation.toFixed(2)}</ele>` : ''}</trkpt>`).join('')}</trkseg></trk></gpx>`;
}
