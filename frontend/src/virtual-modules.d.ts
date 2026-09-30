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
