// Every job kind the worker can run. A kind without an entry here is dead on
// its first attempt ("no handler"), so enqueue a kind only once it's listed.
// WP-2.13 adds alert_eval, WP-2.15 report_render (jobs/registry.ts has the
// contract).
import type { HandlerRegistry } from '../registry.js';
import { feedFetchHandler } from './feed-fetch.js';
import { feedIngestHandler } from './feed-ingest.js';
import { rerunHandler } from './rerun.js';

export const handlers: HandlerRegistry = {
	rerun: rerunHandler,
	feed_fetch: feedFetchHandler,
	feed_ingest: feedIngestHandler
};
