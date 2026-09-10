let dbPromise;
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('loops', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      if (!db.objectStoreNames.contains('walks')) db.createObjectStore('walks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('locations')) db.createObjectStore('locations', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other Loops tabs and reload to update saved locations.'));
  });
  return dbPromise;
}
async function transact(store, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode), request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
  });
}
export async function getCache(key, age = 7 * 86400000) {
  try { const item = await transact('cache', 'readonly', s => s.get(key)); return item && Date.now() - item.time < age ? item.value : null; } catch { return null; }
}
export async function setCache(key, value) {
  try {
    await transact('cache', 'readwrite', s => s.put({ time: Date.now(), value }, key));
    // Bound graph/geocode storage; terrain PNGs use the browser's HTTP cache.
    const keys = await transact('cache', 'readonly', s => s.getAllKeys());
    if (keys.length > 80) {
      const db = await database(), tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache'); const cursor = store.openCursor();
      let left = keys.length - 60;
      cursor.onsuccess = () => { const c = cursor.result; if (c && left > 0) { if (c.key !== key) { c.delete(); left--; } c.continue(); } };
    }
  } catch { /* Routing remains available when storage is unavailable or full. */ }
}
export const getWalks = async () => (await transact('walks', 'readonly', s => s.getAll())).sort((a, b) => b.completedAt - a.completedAt);
export const saveWalk = walk => transact('walks', 'readwrite', s => s.put(walk));
export const deleteWalk = id => transact('walks', 'readwrite', s => s.delete(id));
export const clearWalks = () => transact('walks', 'readwrite', s => s.clear());
export const getLocations = () => transact('locations', 'readonly', s => s.getAll());
export const saveLocation = location => transact('locations', 'readwrite', s => s.put(location));
export const deleteLocation = id => transact('locations', 'readwrite', s => s.delete(id));
export const getDefaultLocation = () => transact('settings', 'readonly', s => s.get('defaultLocation'));
export const setDefaultLocation = id => transact('settings', 'readwrite', s => s.put(id, 'defaultLocation'));
