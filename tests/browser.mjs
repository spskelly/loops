import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = [-73.9819, 40.7681];
const elements = [], size = 29, half = 14;
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) elements.push({ type: 'node', id: y * size + x + 1, lon: origin[0] + (x - half) * .0013, lat: origin[1] + (y - half) * .001 });
for (let i = 0; i < size; i++) {
  elements.push({ type: 'way', id: 10000 + i, nodes: Array.from({ length: size }, (_, x) => i * size + x + 1), tags: { highway: 'residential', name: `Test Street ${i}` } });
  elements.push({ type: 'way', id: 20000 + i, nodes: Array.from({ length: size }, (_, y) => y * size + i + 1), tags: { highway: 'footway' } });
}
await mkdir('.artifacts', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
async function setup(options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: Boolean(options.mobile), reducedMotion: 'reduce' });
  const page = await context.newPage();
  if (options.geo) await page.addInitScript(mode => {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success, failure) {
      window.delayedLocation = success;
      if (mode === 'success') setTimeout(() => success({ coords: { longitude: -71.07004, latitude: 42.35409, accuracy: 35 } }), 30);
      else if (mode === 'denied') setTimeout(() => failure({ code: 1 }), 30);
      else if (mode === 'unavailable') setTimeout(() => failure({ code: 2 }), 30);
    } } });
  }, options.geo);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/maplibre-gl.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text() + ';maplibregl.Map = class extends maplibregl.Map { constructor(...args) { super(...args); window.testMap = this; } };' });
  });
  const png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(128,50,0)'; ctx.fillRect(0, 0, 256, 256);
    return canvas.toDataURL().split(',')[1];
  }), 'base64');
  let geocodes = 0, graphCalls = 0;
  await context.route('**/tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: png }));
  await context.route('**/elevation-tiles-prod/**', route => options.noTerrain ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ contentType: 'image/png', body: png }));
  await context.route('**/photon.komoot.io/**', async route => {
    geocodes++;
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'Slow search') await new Promise(resolve => setTimeout(resolve, 1800));
    if (query === 'Missing place') return route.fulfill({ json: { features: [] } });
    if (query === 'Offline search') return route.fulfill({ status: 503, body: 'Unavailable' });
    const boston = query === 'Boston garden';
    return route.fulfill({ json: { features: [
      { geometry: { type: 'Point', coordinates: boston ? [-71.07004, 42.35409] : origin }, properties: { name: boston ? 'Boston Public Garden' : 'Test Park', city: boston ? 'Boston' : 'New York', country: 'United States' } },
      { geometry: { type: 'Point', coordinates: [origin[0] + .1, origin[1]] }, properties: { name: 'Other Test Park', city: 'New York' } },
    ] } });
  });
  await context.route('**/overpass-api.de/**', async route => {
    graphCalls++;
    if (options.slowGraph) await new Promise(resolve => setTimeout(resolve, 2200));
    await route.fulfill({ json: { elements } }).catch(() => {});
  });
  if (options.legacy) {
    await page.goto('http://localhost:5173/favicon.svg');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('loops', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('cache'); request.result.createObjectStore('walks', { keyPath: 'id' }); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('walks', 'readwrite');
        tx.objectStore('walks').put({ id: 'older-walk', name: 'An earlier walk', length: 1200, gain: 10, completedAt: Date.now(), equivalent: 1290 });
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    }));
  }
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.maplibregl);
  return { context, page, geocodes: () => geocodes, graphCalls: () => graphCalls };
}
async function waitForRoutes(page) {
  await page.waitForFunction(() => !document.getElementById('results').hidden && document.getElementById('cancel').hidden && document.querySelectorAll('.route-card').length > 0, null, { timeout: 30000 });
  assert.equal(await page.locator('.route-card').count(), 3);
  assert.equal(await page.locator('#cancel').isVisible(), false);
}
async function routeDragPoints(page) {
  return page.evaluate(async () => {
    const map = window.testMap, coords = (await map.getSource('loops').getData()).features.find(f => f.properties.selected).geometry.coordinates;
    const box = document.getElementById('map').getBoundingClientRect(), detail = document.getElementById('route-detail').getBoundingClientRect();
    for (let i = 1; i < coords.length - 2; i++) {
      const coord = [(coords[i][0] + coords[i + 1][0]) / 2, (coords[i][1] + coords[i + 1][1]) / 2];
      const point = map.project(coord), dropCoord = [coord[0] + .0013, coord[1] + .001];
      const drop = map.project(dropCoord);
      if ([point, drop].every(p => p.x > 30 && p.x < box.width - 40 && p.y > 90 && p.y + box.y < detail.top - 25)) {
        return { from: [box.x + point.x, box.y + point.y], to: [box.x + drop.x, box.y + drop.y] };
      }
    }
  });
}
try {
  const desktop = await setup(), { page } = desktop;
  assert.equal(await page.locator('#map-welcome').isVisible(), true);
  await page.locator('#address').fill('Test park'); await page.locator('#search').click();
  await page.locator('#places button').first().waitFor();
  assert.equal(await page.locator('#places button').count(), 2);
  await page.locator('#places button').first().click();
  await page.locator('#find').click(); await waitForRoutes(page);
  assert.ok((await page.locator('#route-detail').innerText()).includes('164 ft'));
  assert.ok((await page.locator('#route-detail').innerText()).includes('0 ft'));
  await page.locator('.route-card').nth(1).click();
  assert.equal(await page.locator('.route-card').nth(1).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.detail-heading h2').textContent(), 'A different way home');
  const downloaded = page.waitForEvent('download'); await page.locator('#download').click();
  const download = await downloaded; await download.saveAs('.artifacts/test-walk.gpx');
  const gpx = await readFile('.artifacts/test-walk.gpx', 'utf8');
  assert.ok(gpx.includes('<gpx version="1.1"')); assert.ok(gpx.includes('<ele>50.00</ele>'));
  const coordinates = [...gpx.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(coordinates[0], coordinates.at(-1));
  const selectedCoords = () => page.evaluate(async () => (await window.testMap.getSource('loops').getData()).features.find(f => f.properties.selected).geometry.coordinates);
  const beforeReverse = await selectedCoords();
  const originalHeading = await page.locator('#direction-label').textContent();
  await page.waitForFunction(() => window.testMap.queryRenderedFeatures({ layers: ['loop-arrows'] }).length > 0);
  assert.equal(await page.evaluate(() => window.testMap.getLayoutProperty('loop-arrows', 'icon-keep-upright')), false);
  await page.screenshot({ path: '.artifacts/direction-before.png', fullPage: true });
  await page.locator('#reverse').click();
  assert.equal(await page.locator('#reverse').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await selectedCoords(), [...beforeReverse].reverse());
  assert.notEqual(await page.locator('#direction-label').textContent(), originalHeading);
  const reverseDownload = page.waitForEvent('download'); await page.locator('#download').click();
  await (await reverseDownload).saveAs('.artifacts/reversed-walk.gpx');
  const reversedGPX = await readFile('.artifacts/reversed-walk.gpx', 'utf8');
  assert.deepEqual([...reversedGPX.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)">/g)].map(m => [m[1], m[2]]), [...coordinates].reverse());
  await page.locator('.route-card').nth(0).click();
  assert.equal(await page.locator('#reverse').getAttribute('aria-pressed'), 'false');
  await page.locator('.route-card').nth(1).click();
  assert.equal(await page.locator('#reverse').getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: '.artifacts/direction-after.png', fullPage: true });
  await page.locator('#reverse').click();
  assert.deepEqual(await selectedCoords(), beforeReverse);
  console.log('PASS: direction arrows render; reverse updates geometry, heading and GPX; each alternative remembers its direction');
  await page.locator('#complete').click(); await page.waitForFunction(() => document.getElementById('history-count').textContent === '1');
  assert.equal(await page.locator('#complete').isDisabled(), true);
  await page.screenshot({ path: '.artifacts/test-desktop.png', fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#history-count').textContent(), '1');
  assert.ok((await page.locator('#next-walk').textContent()).includes('7%'));
  await page.locator('#use-next').click();
  assert.ok((await page.locator('#status').textContent()).includes('Next-walk effort applied'));
  await page.locator('[data-unit="km"]').click(); assert.equal(await page.locator('#distance-unit').textContent(), 'kilometers');
  await page.locator('#history-open').click(); assert.equal(await page.locator('.history-item').count(), 1);
  await page.locator('[data-delete]').click(); await page.waitForFunction(() => document.getElementById('history-count').textContent === '0');
  await page.locator('#history-close').click();
  await page.locator('#address').fill('Test park'); await page.locator('#search').click(); await page.locator('#places button').first().waitFor();
  assert.equal(desktop.geocodes(), 1, 'geocoder responses survive reload in IndexedDB');
  await page.locator('#places button').first().click();
  await page.locator('#distance').fill('3.2'); await page.locator('#distance').dispatchEvent('input');
  await page.locator('#find').click(); await waitForRoutes(page);
  assert.equal(desktop.graphCalls(), 1, 'graph cache is reused across units and reload');
  console.log('PASS: search selection, route generation, elevation, route switching, GPX, save, persistence, progression, deletion, geocoder and graph caches');
  // A different starting point must reset padding left by route fitting.
  await page.locator('#address').fill('Boston garden');
  await page.locator('#places button').first().waitFor();
  await page.locator('#places button').first().click();
  await page.waitForFunction(() => Math.abs(window.testMap.getCenter().lng + 71.07004) < .00001 && Math.abs(window.testMap.getCenter().lat - 42.35409) < .00001);
  assert.deepEqual(await page.evaluate(() => window.testMap.getPadding()), { top: 0, bottom: 0, left: 0, right: 0 });
  assert.equal(await page.locator('.start-pin').count(), 1);
  assert.equal(await page.locator('#map-label').textContent(), 'Boston Public Garden');
  assert.equal(await page.locator('#results').isVisible(), false);
  const pin = await page.locator('.start-pin').boundingBox(), mapBox = await page.locator('#map').boundingBox();
  assert.ok(Math.abs(pin.x + pin.width / 2 - mapBox.x - mapBox.width / 2) < 2);
  assert.ok(Math.abs(pin.y + pin.height / 2 - mapBox.y - mapBox.height / 2) < 2);
  console.log('PASS: typing shows suggestions; selection recenters the actual map and pin after viewing a route');
  const slowRequest = page.waitForRequest(r => r.url().includes('q=Slow+search'));
  await page.locator('#address').fill('Slow search'); await slowRequest;
  assert.equal(await page.locator('#address').isEditable(), true);
  await page.locator('#address').fill('Boston garden');
  await page.locator('#places button').first().waitFor();
  await page.waitForTimeout(2000);
  assert.ok((await page.locator('#places button').first().textContent()).includes('Boston Public Garden'));
  await page.locator('#address').fill('Missing place'); await page.locator('#address').press('Enter');
  await page.waitForFunction(() => document.getElementById('place-status').textContent.includes('No places found'));
  assert.equal(await page.locator('.start-pin').count(), 0);
  await page.locator('#address').fill('Offline search'); await page.locator('#search').click();
  await page.waitForFunction(() => document.getElementById('place-status').textContent.includes('unavailable'));
  await page.locator('#address').fill('Test park'); await page.locator('#find').click();
  await page.locator('#places button').first().waitFor(); await page.locator('#places button').first().click();
  await waitForRoutes(page);
  console.log('PASS: newer input cancels stale matches, empty/error feedback appears by the input, Find my loops continues after selection');

  // Drag a visible segment to an adjacent grid street through actual mouse events.
  const dragCoordinates = await page.evaluate(async () => {
    const map = window.testMap, coords = (await map.getSource('loops').getData()).features.find(f => f.properties.selected).geometry.coordinates;
    const box = document.getElementById('map').getBoundingClientRect(), detail = document.getElementById('route-detail').getBoundingClientRect();
    for (let i = 1; i < coords.length - 2; i++) {
      const coord = [(coords[i][0] + coords[i + 1][0]) / 2, (coords[i][1] + coords[i + 1][1]) / 2];
      const point = map.project(coord), dropCoord = [coord[0] + .0013, coord[1] + .001];
      const drop = map.project(dropCoord);
      if ([point, drop].every(p => p.x > 50 && p.x < box.width - 70 && p.y > 90 && p.y + box.y < detail.top - 25)) {
        return { from: [box.x + point.x, box.y + point.y], to: [box.x + drop.x, box.y + drop.y], coord, dropCoord };
      }
    }
  });
  assert.ok(dragCoordinates, 'A route segment is visible for dragging');
  const beforeEdit = await selectedCoords();
  await page.mouse.move(...dragCoordinates.from); await page.mouse.down();
  await page.mouse.move(...dragCoordinates.to, { steps: 12 }); await page.mouse.up();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Route adjusted'), null, { timeout: 30000 });
  await waitForRoutes(page);
  assert.notDeepEqual(await selectedCoords(), beforeEdit);
  assert.deepEqual((await selectedCoords())[0], beforeEdit[0]);
  await page.screenshot({ path: '.artifacts/dragged-route.png', fullPage: true });
  await page.locator('#undo-route').click();
  assert.deepEqual(await selectedCoords(), beforeEdit);
  console.log('PASS: dragging reroutes a street through connected paths; undo restores the original loop');

  await page.locator('#save-location').click();
  await page.locator('#location-name').fill('Home');
  await page.locator('#location-default').check();
  await page.locator('#save-location-submit').click();
  await page.waitForFunction(() => !document.getElementById('save-location-dialog').open);
  const savedId = await page.locator('#saved-location').inputValue();
  assert.ok(savedId);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.getElementById('address').value === 'Home');
  await page.waitForFunction(() => window.testMap && Math.abs(window.testMap.getCenter().lng + 73.9819) < .00001);
  await page.locator('#address').fill('Boston garden'); await page.locator('#places button').first().waitFor(); await page.locator('#places button').first().click();
  await page.locator('#saved-location').selectOption(savedId);
  assert.equal(await page.locator('#address').inputValue(), 'Home');
  await page.locator('#remove-location').click();
  await page.waitForFunction(() => document.getElementById('saved-locations').hidden);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('#address').inputValue(), '');
  console.log('PASS: named starting points persist, default restores the map, saved selection and removal work');
  await desktop.context.close();

  const missing = await setup({ mobile: true, noTerrain: true });
  await missing.page.locator('#example').click(); await waitForRoutes(missing.page);
  await missing.page.locator('#reverse').click();
  assert.equal(await missing.page.locator('#reverse').getAttribute('aria-pressed'), 'true');
  await missing.page.locator('.map-panel').scrollIntoViewIfNeeded();
  await missing.page.locator('#adjust-route').click();
  const touchPoints = await routeDragPoints(missing.page);
  assert.ok(touchPoints);
  await missing.page.touchscreen.tap(...touchPoints.from);
  await missing.page.waitForFunction(() => document.getElementById('edit-hint').textContent.includes('Now tap'));
  await missing.page.touchscreen.tap(...touchPoints.to);
  await missing.page.waitForFunction(() => document.getElementById('status').textContent.includes('Route adjusted'), null, { timeout: 30000 });
  await waitForRoutes(missing.page);
  await missing.page.locator('#undo-route').click();
  console.log('PASS: touch users can tap a route segment and then a replacement street; undo works');
  assert.ok((await missing.page.locator('#route-detail').innerText()).includes('Unavailable'));
  assert.ok((await missing.page.locator('#route-detail').innerText()).includes('Elevation is unavailable'));
  await missing.page.locator('#complete').click(); await missing.page.waitForFunction(() => document.getElementById('history-count').textContent === '1');
  assert.ok((await missing.page.locator('#next-walk').innerText()).includes('Save a walk with elevation data'));
  assert.equal(await missing.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await missing.page.screenshot({ path: '.artifacts/test-mobile.png', fullPage: true });
  await missing.page.locator('.map-panel').scrollIntoViewIfNeeded();
  await missing.page.waitForTimeout(1200);
  await missing.page.screenshot({ path: '.artifacts/test-mobile-map.png' });
  console.log('PASS: missing terrain remains unknown, no fabricated progression, mobile layout has no horizontal overflow');
  await missing.context.close();

  const cancelled = await setup({ slowGraph: true });
  await cancelled.page.locator('#example').click(); await cancelled.page.locator('#cancel').click();
  await cancelled.page.waitForTimeout(2500);
  assert.equal(await cancelled.page.locator('.route-card').count(), 0);
  assert.equal(await cancelled.page.locator('#find').isDisabled(), false);
  assert.ok((await cancelled.page.locator('#status').innerText()).includes('cancelled'));
  console.log('PASS: cancellation leaves no stale routes and re-enables controls');
  await cancelled.context.close();
  for (const mode of ['success', 'denied', 'unavailable', 'silent']) {
    const location = await setup({ geo: mode });
    await location.page.locator('#locate').click();
    assert.equal(await location.page.locator('#address').isEditable(), true);
    assert.equal(await location.page.locator('#distance').isEnabled(), true);
    if (mode === 'success') {
      await location.page.waitForFunction(() => document.getElementById('location-status').textContent.includes('Location found'));
      await location.page.waitForFunction(() => Math.abs(window.testMap.getCenter().lng + 71.07004) < .00001);
      assert.ok((await location.page.locator('#location-status').innerText()).includes('35 m'));
      assert.equal(await location.page.locator('#save-location').isEnabled(), true);
    } else if (mode === 'silent') {
      await location.page.waitForFunction(() => document.getElementById('location-status').textContent.includes('timed out'), null, { timeout: 15000 });
      assert.ok((await location.page.locator('#location-log').textContent()).includes('app-timeout'));
      assert.ok((await location.page.locator('#location-status').textContent()).includes('Site permission is allowed'));
      assert.equal(await location.page.locator('#location-diagnostics').getAttribute('open'), '');
      assert.equal(await location.page.locator('#locate').getAttribute('aria-busy'), 'false');
      await location.page.locator('#locate').click();
      await location.page.locator('#address').fill('Boston garden');
      await location.page.evaluate(() => window.delayedLocation({ coords: { longitude: 0, latitude: 0, accuracy: 10 } }));
      assert.equal(await location.page.locator('#address').inputValue(), 'Boston garden');
      assert.equal(await location.page.locator('.start-pin').count(), 0);
    } else {
      await location.page.waitForFunction(expected => document.getElementById('location-status').textContent.includes(expected), mode === 'denied' ? 'blocked' : 'could not determine');
      assert.ok((await location.page.locator('#location-log').textContent()).includes('browser-error'));
    }
    await location.context.close();
  }
  console.log('PASS: geolocation success, denied access, unavailable device, silent timeout and late callbacks; form remains usable');
  const migrated = await setup({ legacy: true });
  assert.equal(await migrated.page.locator('#history-count').textContent(), '1');
  await migrated.page.locator('#address').fill('Test park'); await migrated.page.locator('#search').click();
  await migrated.page.locator('#places button').first().waitFor(); await migrated.page.locator('#places button').first().click();
  await migrated.page.locator('#save-location').click(); await migrated.page.locator('#save-location-submit').click();
  await migrated.page.waitForFunction(() => !document.getElementById('save-location-dialog').open);
  assert.equal(await migrated.page.locator('#history-count').textContent(), '1');
  await migrated.context.close();
  console.log('PASS: upgrading an existing database preserves walk history while adding saved locations');
  assert.deepEqual(errors, [], 'No browser JavaScript exceptions');
  console.log('All browser checks passed.');
} finally { await browser.close(); }
