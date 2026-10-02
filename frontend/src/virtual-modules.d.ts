// The calibration worker's URL: frontend/vite.config.ts (workerChunks)
// emits the worker as a chunk of the page build and serves its URL here.
declare module 'virtual:autocal-worker-url' {
	const url: string;
	export default url;
}

// The preview worker's URL (lib/preview/engine.worker.ts, roadmap WP-1.17):
// emitted by the same plugin (workerChunks) as a chunk of the page build.
declare module 'virtual:preview-worker-url' {
	const url: string;
	export default url;
}

// MapLibre's worker (the catchment map, issue #288): emitted by the same
// plugin as a chunk of the page build, so it shares MapLibre's code with the
// map's chunk instead of carrying a copy.
declare module 'virtual:maplibre-worker-url' {
	const url: string;
	export default url;
}
