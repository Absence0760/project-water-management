// A feed fetch fails in one of two ways, and each carries a message written
// by us for the feed-status panel (never a raw upstream body or stack):
//
//   FeedFormatError      — the source answered, but not in the format we
//                          parse (a changed page, a corrupt grid, a station
//                          code the source doesn't know). Nothing is written.
//   FeedUnavailableError — the source didn't answer usefully (network error,
//                          timeout, HTTP 5xx, a response too large). Nothing is
//                          written; the next scheduled fetch tries again.
//                          FeedThrottledError is the HTTP 429 / 503 case,
//                          FeedRefusedError the HTTP 403 one, FeedServerError
//                          a page that says the source's own backend failed
//                          (DWS's ScriptServer error page, sent with HTTP 200).
//
// Either way the feed's health records the failure (feeds/store.ts), and a
// feed that keeps failing shows as failing, then stale.

export class FeedFormatError extends Error {
	override readonly name = 'FeedFormatError';
}

/** A grid cell a feed names has no data (the sea, or outside the product's coverage): a FeedFormatError the fetch can word for a bounding box. */
export class FeedNoDataError extends FeedFormatError {}

export class FeedUnavailableError extends Error {
	override readonly name = 'FeedUnavailableError';
}

/**
 * The source answered HTTP 429 or 503: it is limiting how fast we ask, or is
 * briefly overloaded. A FeedUnavailableError like any other (the feed shows
 * failing and its next fetch waits out the scheduler's backoff), but the
 * live client also stops asking that host for a while (http.ts), so a
 * throttled source isn't hammered by the fetches still queued for it.
 */
export class FeedThrottledError extends FeedUnavailableError {
	readonly status: 429 | 503;
	/** The source's Retry-After, in seconds, when it gave a usable one. */
	readonly retryAfterSeconds: number | null;
	constructor(status: 429 | 503, retryAfterSeconds: number | null = null) {
		super(`HTTP ${status}: the source asked us to slow down, so the feed tries again later`);
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/**
 * The source answered HTTP 403: it refuses this server's requests. CHC's
 * nginx does that to an address it has banned for volume (each fetcher
 * Lambda environment has its own outbound address), and the DWS site to
 * addresses outside South Africa. Unlike a 429 it says nothing of when to
 * come back, so the live client leaves the host alone for REFUSED_PAUSE_SECONDS
 * (http.ts), and the stored message starts with FEED_REFUSED_PREFIX, which
 * the scheduler reads to back the feed off for hours, not minutes
 * (242_feed_refused_backoff.sql app_feed_is_due).
 */
export class FeedRefusedError extends FeedUnavailableError {
	readonly status = 403;
	constructor() {
		super('HTTP 403');
	}
}

/**
 * The source answered, but with a page saying its own backend failed: the DWS
 * site's Kisters ScriptServer error page, which it sends with HTTP 200. That
 * is the source being down for a while, not a page whose layout changed, so
 * it is a FeedUnavailableError (the scheduler's backoff retries it: 15
 * minutes, doubling up to the day) rather than a FeedFormatError. `what` is
 * our fixed wording of what came back, and `label` the short, fixed text the
 * fetcher logs as the failure's detail (lambda-fetcher.ts failureDetail);
 * neither ever carries the page's own text.
 */
export class FeedServerError extends FeedUnavailableError {
	readonly label: string;
	constructor(what: string, label: string) {
		super(what);
		this.label = label;
	}
}

/** How a server error's stored message starts (feedErrorMessage). */
export const FEED_SERVER_ERROR_PREFIX = 'the source had a server error';

/**
 * How a refused fetch's stored message starts. app_feed_is_due
 * (242_feed_refused_backoff.sql) matches this exact text: change both
 * together (feeds.db.test.ts pins them to each other).
 */
export const FEED_REFUSED_PREFIX = 'the source refused this server’s requests';

/** The longest stored feed error (018_feeds.sql CHECK). */
export const FEED_ERROR_MAX = 500;

/** The message to store for anything a fetch threw. Unexpected errors get a generic text. */
export function feedErrorMessage(err: unknown): string {
	const clip = (s: string) => (s.length > FEED_ERROR_MAX ? `${s.slice(0, FEED_ERROR_MAX - 1)}…` : s);
	if (err instanceof FeedFormatError) return clip(`the source’s data could not be read: ${err.message}`);
	if (err instanceof FeedServerError) return clip(`${FEED_SERVER_ERROR_PREFIX} (${err.message}), so the feed tries again later`);
	if (err instanceof FeedRefusedError) return `${FEED_REFUSED_PREFIX} (HTTP 403): it may have blocked this server’s address, so the feed waits hours before asking again`;
	if (err instanceof FeedUnavailableError) return clip(`the source is unreachable: ${err.message}`);
	return 'the fetch failed with an internal error';
}
