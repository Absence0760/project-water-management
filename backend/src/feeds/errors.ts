// A feed fetch fails in one of two ways, and each carries a message written
// by us for the feed-status panel (never a raw upstream body or stack):
//
//   FeedFormatError      — the source answered, but not in the format we
//                          parse (a changed page, a corrupt grid, a station
//                          code the source doesn't know). Nothing is written.
//   FeedUnavailableError — the source didn't answer usefully (network error,
//                          timeout, HTTP 5xx, a response too large). Nothing is
//                          written; the next scheduled fetch tries again.
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

/** The longest stored feed error (018_feeds.sql CHECK). */
export const FEED_ERROR_MAX = 500;

/** The message to store for anything a fetch threw. Unexpected errors get a generic text. */
export function feedErrorMessage(err: unknown): string {
	const clip = (s: string) => (s.length > FEED_ERROR_MAX ? `${s.slice(0, FEED_ERROR_MAX - 1)}…` : s);
	if (err instanceof FeedFormatError) return clip(`the source’s data could not be read: ${err.message}`);
	if (err instanceof FeedUnavailableError) return clip(`the source is unreachable: ${err.message}`);
	return 'the fetch failed with an internal error';
}
