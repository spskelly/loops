import { generateLoops, rerouteSection } from './routing.js';
self.onmessage = ({ data }) => {
  try {
    const routes = data.edit ? [rerouteSection(data.elements, data.edit.route, data.edit.edgeIndex, data.edit.destination)] : generateLoops(data.elements, data.origin, data.target, progress => self.postMessage({ progress }));
    self.postMessage({ routes });
  } catch (error) { self.postMessage({ error: error.message }); }
};
