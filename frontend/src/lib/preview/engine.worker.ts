// Web Worker: the preview engine (roadmap WP-1.17). Runs the engine on
// inputs the page already holds, off the main thread, for an answer that is
// never stored. So far one kind of request: a dam's firm yield, the Yield
// panel's instant preview (WP-3.6, ./compute.ts). It is an entry of the page
// build (frontend/vite.config.ts, workerChunks), so it shares the engine
// chunks instead of carrying its own copy. One request at a time; the page
// replaces or cancels one by terminating the worker (the engine is
// synchronous, so it can't be asked to stop).
import { handle } from './compute';

self.onmessage = (e: MessageEvent<unknown>) => {
	// A dedicated worker only hears the page that made it (its messages carry
	// an empty origin); refuse anything that names another origin.
	if (e.origin && e.origin !== self.location.origin) return;
	// The payload is untrusted data: handle() parses it strictly before the
	// engine sees it (compute.ts parseMessage), and ignores a non-request.
	const answer = handle(e.data);
	if (answer) (self as unknown as Worker).postMessage(answer);
};
