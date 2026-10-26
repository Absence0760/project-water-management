// Links into a panel that moved to another page (issue #586): an old
// `?tab=settings#set-feeds` in an email, a bookmark or a note, or a
// `?tab=runs#res-curtailment` from before EWR and Hydrological units had pages
// of their own (issue #17), a `?tab=settings#set-fit` or `?tab=runs#res-calibration`
// from before Calibration had them (issue #586 round 3). Every such move is one row of ANCHOR_MOVES, and
// anchorForward reads them: the page the reader opened sends the link on to the
// panel's new page and anchor (anchorLanding.ts followAnchors, with a replace
// navigation so Back skips the old address), and that page lands on the panel
// and focuses its heading. Moving another panel is adding a row.
import { MODEL_QUALITY_ANCHORS } from '#lib/components/calibration/links.js';
import { CALIBRATION_SETTINGS_ANCHORS, isCalibrationAnchor } from '#lib/components/settings/sections.js';
import { PROJECT_ANCHORS } from '#lib/components/project/links.js';
import { RIVER_ANCHORS, RIVER_STRIP_ANCHOR, SUMMARY_STRIP_ANCHORS } from '#lib/components/river/links.js';
import { SUPPLY_ANCHORS, SUPPLY_TAB } from '#lib/components/supply/links.js';
import { hashId } from '#lib/help/anchor.js';
import type { TabId } from '#lib/workspace/tabs.js';

/** One moved anchor (or several that moved together, to the same page). */
export interface AnchorMove {
	/** The page the anchors were on: the workspace tab whose component reads the link (not its `?tab=` spelling, so `?tab=results` counts as Runs). */
	from: TabId;
	/** The old anchors, without the `#`, or a test for a whole family of them (every `set-…`). */
	hash: string | readonly string[] | ((id: string) => boolean);
	/** The page they live on now. */
	tab: TabId;
	/** The new anchor: the old one when left out; null for the page itself (no `#`). */
	to?: string | null;
	/**
	 * The query parameters that go along: 'all' keeps every one in its place (`rain=boundary`, `run=`), only
	 * `tab` changed; a list keeps those, in that order, after `tab`, and drops the rest.
	 */
	keep: 'all' | readonly string[];
	/** Also forward a link with no `#` when this holds for its query (`?tab=settings&rain=boundary` asks for Data feeds). */
	bare?: (params: URLSearchParams) => boolean;
}

/** The run and, for Hydrological units, the curtailment's reporting window: what a Runs & results link carried (issue #17). */
const RUN = ['run'] as const;
const RUN_WINDOW = ['run', 'window'] as const;

/** The panels that stayed on Model settings: an old `?tab=calibration#set-ewr` goes there (any `set-…` not moved to Calibration). */
const stayedOnSettings = (id: string) => id.startsWith('set-') && !isCalibrationAnchor(id);

/** Every moved anchor, by the page it was on. */
export const ANCHOR_MOVES: readonly AnchorMove[] = [
	// Settings → Data and Project (issue #586 round 1). `?rain=boundary`/`?rain=units` is a map proposal for Data feeds.
	{ from: 'settings', hash: 'set-feeds', tab: 'series', to: 'data-feeds', keep: 'all', bare: (p) => /^(boundary|units)$/.test(p.get('rain') ?? '') },
	{ from: 'settings', hash: 'set-api-keys', tab: 'project', to: 'project-api-keys', keep: 'all' },
	{ from: 'settings', hash: 'set-report-schedules', tab: 'project', to: 'project-report-schedules', keep: 'all' },
	// Runs & results → EWR and Hydrological units (issue #17): the same panel there, for the same run; the link
	// rows those groups left here for a while (#res-river, #res-units) go to the page itself.
	{ from: 'runs', hash: 'res-river', tab: 'river', to: null, keep: RUN },
	{ from: 'runs', hash: [...RIVER_ANCHORS, RIVER_STRIP_ANCHOR], tab: 'river', keep: RUN },
	{ from: 'runs', hash: 'res-units', tab: SUPPLY_TAB, to: null, keep: RUN_WINDOW },
	{ from: 'runs', hash: SUPPLY_ANCHORS, tab: SUPPLY_TAB, keep: RUN_WINDOW },
	// Settings → Calibration (issue #586 round 3): Flow calibration, Calibration record, Fit the parameters, WR2012
	// check and the Evaporation from the map card, ids unchanged.
	{ from: 'settings', hash: CALIBRATION_SETTINGS_ANCHORS, tab: 'calibration', keep: 'all' },
	// Runs & results → Calibration (issue #586 round 3): Model quality's panels, for the same run (Calibration's run
	// picker reads `run=` as Runs does). The runs filter (`q=`) is Runs' own. Water balance by water year stays.
	{ from: 'runs', hash: MODEL_QUALITY_ANCHORS, tab: 'calibration', keep: RUN },
	// `?tab=calibration` opened Settings & calibration until Calibration had a page of its own (issue #586 round 2),
	// so an old `?tab=calibration#set-ewr` (a bookmark, a note's link) goes to that panel on Model settings, which
	// sends a panel that moved again (`#set-feeds`) on to its page. The calibration panels are here now, so their
	// anchors stay.
	{ from: 'calibration', hash: stayedOnSettings, tab: 'settings', keep: 'all' },
	// The Summary's old panels (issue #17, issue #558): the model's facts, details, notes and access went to Project
	// (`/projects/:id#members-h`, bookmarked before 2026-09-27), the reserve strip and the EWR panels to EWR, for
	// the run the Summary shows (the page fills `run=`, followAnchors `fill`).
	{ from: 'overview', hash: PROJECT_ANCHORS, tab: 'project', keep: [] },
	{ from: 'overview', hash: SUMMARY_STRIP_ANCHORS, tab: 'river', to: RIVER_STRIP_ANCHOR, keep: RUN },
	{ from: 'overview', hash: [...RIVER_ANCHORS, RIVER_STRIP_ANCHOR], tab: 'river', keep: RUN }
];

const names = (m: AnchorMove, hash: string): boolean =>
	typeof m.hash === 'function' ? m.hash(hash) : typeof m.hash === 'string' ? m.hash === hash : m.hash.includes(hash);

/** The row that moves `hash` away from `from`, or null. With no hash, a row whose `bare` matches the query. */
export function anchorMove(from: TabId, hash: string, params: URLSearchParams, moves: readonly AnchorMove[] = ANCHOR_MOVES): AnchorMove | null {
	return moves.find((m) => m.from === from && (hash ? names(m, hash) : !!m.bare?.(params))) ?? null;
}

/**
 * Where a link on page `from` goes instead, when its `#anchor` names a panel that moved: the same
 * path (a base path kept), the new page's `?tab=`, the kept parameters and the new anchor. null when
 * the anchor is still on this page, or names nothing. A percent-encoded `#` is read as its id.
 * `fill` gives a kept parameter the link lacks: the Summary's link carries no `run=`, so the page
 * passes the run it shows. A list `keep` only: 'all' keeps the link's own.
 */
export function anchorForward(
	from: TabId,
	url: Pick<URL, 'pathname' | 'search' | 'hash'>,
	moves: readonly AnchorMove[] = ANCHOR_MOVES,
	fill: Readonly<Record<string, string | null | undefined>> = {}
): string | null {
	const params = new URLSearchParams(url.search);
	const hash = hashId(url.hash);
	const move = anchorMove(from, hash, params, moves);
	if (!move) return null;
	let q: URLSearchParams;
	if (move.keep === 'all') {
		q = params;
		q.set('tab', move.tab);
	} else {
		q = new URLSearchParams({ tab: move.tab });
		for (const k of move.keep) {
			const v = params.get(k) || fill[k];
			if (v) q.set(k, v);
		}
	}
	const to = move.to === undefined ? hash : move.to;
	return `${url.pathname}?${q}${to ? `#${to}` : ''}`;
}

/** True when `hash` (without the `#`) names a panel that moved away from `from`. */
export function anchorMoved(from: TabId, hash: string, moves: readonly AnchorMove[] = ANCHOR_MOVES): boolean {
	return !!hash && anchorMove(from, hash, new URLSearchParams(), moves) !== null;
}
