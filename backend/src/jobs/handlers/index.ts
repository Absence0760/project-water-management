// Every job kind the worker can run. A kind without an entry here is dead on
// its first attempt ("no handler"), so enqueue a kind only once it's listed.
// WP-2.10 adds feed_fetch / feed_ingest, WP-2.13 alert_eval, WP-2.15
// report_render (jobs/registry.ts has the contract).
import type { HandlerRegistry } from '../registry.js';
import { rerunHandler } from './rerun.js';

export const handlers: HandlerRegistry = {
	rerun: rerunHandler
};
