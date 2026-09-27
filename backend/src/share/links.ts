// Read-only share links (roadmap WP-2.3 phase 2, 025_share_links.sql,
// docs/api.md § Share): the request bodies, the row shapes and the URL. The
// token is 32 random bytes, base64url, stored as SHA-256 (auth/tokens.ts, the
// emailed tokens' format), and travels in the URL's fragment so it never
// reaches a server log.
import type { RestrictionLevel, CatchmentSite, NoticeText } from '@water-management/engine';
import { z } from 'zod';

/** Longest label, in characters (025_share_links.sql CHECK). */
export const SHARE_LABEL_MAX = 100;
/** Longest a link lives, in days (025_share_links.sql CHECK). */
export const SHARE_DAYS_MAX = 365;

/** The catchment series a share link may read (app_share_series' allowlist). */
export const SHARE_SERIES_KEYS = ['natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall'] as const;

export const CreateBody = z
	.object({
		label: z
			.string()
			.trim()
			.min(1, 'give the link a label')
			.max(SHARE_LABEL_MAX)
			.refine((s) => !s.includes('\u0000'), 'label cannot contain NUL characters'),
		expiresInDays: z.number().int().min(1).max(SHARE_DAYS_MAX)
	})
	.strict();

/** A token as the client sent it; anything malformed is simply not a live link. */
export const ViewBody = z.object({ token: z.string().max(200) }).strict();
export const SeriesBody = z.object({ token: z.string().max(200), key: z.string().max(64) }).strict();

/** The page a link opens, with the token in the fragment (never sent to a server). */
export function shareUrl(token: string): string {
	const base = (process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '');
	return `${base}/share#t=${token}`;
}

export interface ShareLinkRow {
	id: string;
	label: string;
	created_at: Date;
	created_by_name: string | null;
	expires_at: Date;
	revoked_at: Date | null;
	revoked_by_name: string | null;
	last_used_at: Date | null;
}

export const SELECT_LINKS = `
	SELECT s.id, s.label, s.created_at, cu.display_name AS created_by_name, s.expires_at, s.revoked_at,
		ru.display_name AS revoked_by_name, s.last_used_at
	FROM share_link s
	LEFT JOIN app_user cu ON cu.id = s.created_by
	LEFT JOIN app_user ru ON ru.id = s.revoked_by`;

/** A link as its owner sees it (never the token or its hash). */
export interface ShareLink {
	id: string;
	label: string;
	createdAt: string;
	createdBy: string | null;
	expiresAt: string;
	revokedAt: string | null;
	revokedBy: string | null;
	lastUsedAt: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const toLink = (r: ShareLinkRow): ShareLink => ({
	id: r.id,
	label: r.label,
	createdAt: r.created_at.toISOString(),
	createdBy: r.created_by_name,
	expiresAt: r.expires_at.toISOString(),
	revokedAt: iso(r.revoked_at),
	revokedBy: r.revoked_by_name,
	lastUsedAt: iso(r.last_used_at)
});

/** What app_share_view returns (one row, or none). */
export interface ShareViewRow {
	project_name: string;
	published_at: Date;
	published_by: string | null;
	catchment_view: SharedCatchmentView;
	restriction_level: RestrictionLevel;
	restriction_pct: string | null;
	notice: NoticeText;
	next_expected_on: string | null;
}

/** The catchment view a link shows: counts and dates only; the outlet's name is withheld (it may be a farm). */
export interface SharedCatchmentView {
	runStart: string;
	dataUntil: string;
	season: { from: string; to: string; days: number };
	last30: { from: string; to: string; days: number };
	runDays: number;
	farmCount: number;
	sites: (Omit<CatchmentSite, 'name'> & { name: string | null })[];
}

/** POST /share/view's answer. */
export interface ShareView {
	project: { name: string };
	publication: {
		publishedAt: string;
		publishedBy: string | null;
		catchmentView: SharedCatchmentView;
		restriction: { level: RestrictionLevel; pct: number | null; notice: NoticeText };
		nextExpectedOn: string | null;
	};
}

export const toShareView = (r: ShareViewRow): ShareView => ({
	project: { name: r.project_name },
	publication: {
		publishedAt: r.published_at.toISOString(),
		publishedBy: r.published_by,
		catchmentView: r.catchment_view,
		restriction: {
			level: r.restriction_level,
			pct: r.restriction_pct === null ? null : Number(r.restriction_pct),
			notice: r.notice
		},
		nextExpectedOn: r.next_expected_on
	}
});

/** What app_share_series returns (one row, or none). */
export interface ShareSeriesRow {
	label: string;
	unit: string;
	monthly_start: string;
	monthly: (number | null)[];
	recent_start: string;
	recent: (number | null)[];
}

/** POST /share/series' answer: monthly means from `monthly.startMonth`, and daily values from `recent.startDate`. */
export interface ShareSeries {
	key: string;
	label: string;
	unit: string;
	monthly: { startMonth: string; values: (number | null)[] };
	recent: { startDate: string; values: (number | null)[] };
}

const finite = (v: number | null) => (v === null || !Number.isFinite(v) ? null : v);

export const toShareSeries = (key: string, r: ShareSeriesRow): ShareSeries => ({
	key,
	label: r.label,
	unit: r.unit,
	monthly: { startMonth: r.monthly_start.slice(0, 7), values: r.monthly.map(finite) },
	recent: { startDate: r.recent_start, values: r.recent.map(finite) }
});
