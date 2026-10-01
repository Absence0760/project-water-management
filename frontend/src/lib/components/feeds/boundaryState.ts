// Whether a CHIRPS feed reads the map's catchment boundary (issue #326
// B-rain). No imports: the Map tab's link (map/MapRainLink.svelte) uses it,
// and stays out of the feeds panel's chunk. Re-exported from ./feeds.ts.

/** The part of a feed this needs: its source and the boundary its cells came from, if any (backend feeds/config.ts BoundaryMark). */
interface FeedLike {
	source: string;
	config: { boundary?: { featureId: string; updatedAt: string } };
}

/**
 * 'current' when a CHIRPS feed reads this version of the boundary, 'changed'
 * when one read an earlier version (the boundary was redrawn since), 'none'
 * otherwise. The Map tab offers to set the rain feed up unless it is 'current'.
 */
export function boundaryFeedState(feeds: readonly FeedLike[], boundary: { id: string; updatedAt: string }): 'current' | 'changed' | 'none' {
	const marks = feeds.filter((f) => f.source === 'chirps' && f.config.boundary?.featureId === boundary.id).map((f) => f.config.boundary!);
	if (marks.some((m) => Date.parse(m.updatedAt) === Date.parse(boundary.updatedAt))) return 'current';
	return marks.length ? 'changed' : 'none';
}
