export function currentLocation({ signal, timeout = 12000, geolocation = globalThis.navigator?.geolocation, permissions = globalThis.navigator?.permissions, onDiagnostic = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const report = (event, detail = {}) => { try { onDiagnostic({ event, elapsedMs: Date.now() - started, ...detail }); } catch { /* Diagnostics must not affect locating. */ } };
    if (!geolocation) { reject(new Error('Location is unavailable in this browser. Search for an address or choose a point on the map.')); return; }
    let settled = false, permission = 'unknown', permissionStatus;
    const permissionChanged = () => { permission = permissionStatus.state; report('permission', { permission }); };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); permissionStatus?.removeEventListener?.('change', permissionChanged); fn(value);
    };
    const abort = () => { report('cancelled'); finish(reject, new DOMException('Location lookup cancelled', 'AbortError')); };
    const timeoutMessage = 'Location timed out. Check your browser’s location permission, or search for an address instead.';
    // Browser timeouts may exclude time spent waiting for permission. Bound the entire request.
    const timer = setTimeout(() => {
      report('app-timeout', { permission, timeoutMs: timeout, source: 'Loops deadline; browser has not returned a result' });
      const message = permission === 'prompt' ? 'Location permission is still waiting for a response. Allow Location using the control beside your browser’s address bar, then try again.' : permission === 'granted' ? `Location timed out after ${timeout / 1000} seconds. Site permission is allowed, but the browser did not return a position. Check your device’s location services.` : timeoutMessage;
      finish(reject, new Error(message));
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    report('request-started', { timeoutMs: timeout, enableHighAccuracy: false, maximumAgeMs: 60000 });
    try {
      Promise.resolve(permissions?.query({ name: 'geolocation' })).then(result => {
        if (settled) return;
        if (!result) { report('permission-query-unavailable'); return; }
        permissionStatus = result; permissionChanged(); permissionStatus.addEventListener?.('change', permissionChanged);
      }).catch(error => { if (!settled) report('permission-query-unavailable', { message: error.message }); });
    } catch { report('permission-query-unavailable'); }
    try {
      geolocation.getCurrentPosition(position => {
        if (settled) return;
        const { longitude, latitude, accuracy } = position.coords;
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 85) {
          finish(reject, new Error('The location returned cannot be mapped here. Search for an address instead.')); return;
        }
        report('position-received', { accuracyMeters: accuracy });
        finish(resolve, { coord: [longitude, latitude], accuracy });
      }, error => {
        if (settled) return;
        report('browser-error', { code: error.code, message: error.message || '', permission });
        const messages = {
          1: 'Location access is blocked. Allow it in your browser’s site settings and check device location services, or enter an address.',
          2: 'Your device could not determine a location. Check that location services are on, or enter an address.',
          3: timeoutMessage,
        };
        finish(reject, new Error(messages[error.code] || 'Could not get your location. Enter an address or choose a point on the map.'));
      }, { timeout, maximumAge: 60000, enableHighAccuracy: false });
    } catch (error) { finish(reject, error); }
  });
}
