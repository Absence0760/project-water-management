// MapLibre, loaded only when the catchment map is drawn (issue #288; a
// dynamic import from CatchmentMap.svelte, so neither the workspace page nor
// the Map tab's own chunk carries it: the bundle guard's map
// ceiling, scripts/guards/check_web_bundle_budget.mjs). Its worker is a chunk
// of the page build (frontend/vite.config.ts workerChunks), served from the
// app's own origin, so CSP `worker-src 'self'` holds without blob:.
import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'virtual:maplibre-worker-url';

setWorkerUrl(workerUrl);

let pmtiles: Promise<void> | null = null;
/** The `pmtiles://` protocol, registered once, and only when there is a basemap to read (its own lazy chunk). */
export function usePmtiles(): Promise<void> {
	pmtiles ??= import('pmtiles').then(({ Protocol }) => {
		const protocol = new Protocol();
		addProtocol('pmtiles', protocol.tile);
	});
	return pmtiles;
}

export { AttributionControl, MapLibreMap, Marker, NavigationControl };
