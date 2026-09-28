// The calibration worker's URL: frontend/vite.config.ts (autocalWorkerChunk)
// emits the worker as a chunk of the page build and serves its URL here.
declare module 'virtual:autocal-worker-url' {
	const url: string;
	export default url;
}
