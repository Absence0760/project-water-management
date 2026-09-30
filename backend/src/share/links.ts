// Read-only share links (roadmap WP-2.3 phase 2, 025_share_links.sql,
// docs/api.md § Share): the request bodies, the row shapes and the URL. The
// token is 32 random bytes, base64url, stored as SHA-256 (auth/tokens.ts, the
// emailed tokens' format), and travels in the URL's fragment so it never
// reaches a server log.
import type { RestrictionLevel, CatchmentSite, NoticeText } from '@water-management/engine';
import { z } from 'zod';
import { UUID } from '../projects/access.js';

/** Longest label, in characters (025_share_links.sql CHECK). */
export const SHARE_LABEL_MAX = 100;
/** Longest a link lives, in days (025_share_links.sql CHECK). */
export const SHARE_DAYS_MAX = 365;

/** The catchment series a share link may read (app_share_series' allowlist). */
export const SHARE_SERIES_KEYS = ['natural_flow', 'simulated_outflow', 'observed_flow', 'ewr', 'ewr_shortfall'] as const;

/** What a link may name besides the published baseline (share_link.target_kind); evidence packs add 'pack'. */
export const SHARE_TARGET_KINDS = ['scenario'] as const;
export type ShareTargetKind = (typeof SHARE_TARGET_KINDS)[number];

export const CreateBody = z
	.object({
		label: z
			.string()
			.trim()
			.min(1, 'give the link a label')
			.max(SHARE_LABEL_MAX)
			.refine((s) => !s.includes('\u0000'), 'label cannot contain NUL characters'),
		expiresInDays: z.number().int().min(1).max(SHARE_DAYS_MAX),
		/** A link to one scenario (WP-3.15, 115_scenario_share_notes); absent: the published baseline. */
		targetKind: z.enum(SHARE_TARGET_KINDS).optional(),
		targetId: z.string().regex(UUID, 'not a valid id').optional()
	})
	.strict()
	.refine((b) => (b.targetKind === undefined) === (b.targetId === undefined), 'a targeted link needs both targetKind and targetId');

/**
 * GET /projects/:id/share-links: the catchment links (owner), every link in
 * the project (`scope=all`, the owner's inventory), or the links to one
 * scenario (`scenarioId`).
 */
export const ListQuery = z
	.object({ scenarioId: z.string().regex(UUID, 'not a valid id').optional(), scope: z.enum(['baseline', 'all']).optional() })
	.strict()
	.refine((q) => !(q.scenarioId && q.scope), 'give scenarioId or scope, not both');

/** A token as the client sent it; anything malformed is simply not a live link. */
export const ViewBody = z.object({ token: z.string().max(200) }).strict();
export const SeriesBody = z.object({ token: z.string().max(200), key: z.string().max(64) }).strict();

/**
 * The page a link opens, with the token in the fragment (never sent to a
 * server). A targeted link says its kind there too (`k=scenario`), so the
 * page asks the right public read.
 */
export function shareUrl(token: string, kind: ShareTargetKind | null = null): string {
	const base = (process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '');
	return `${base}/share#t=${token}${kind ? `&k=${kind}` : ''}`;
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
	target_kind: ShareTargetKind | null;
	target_id: string | null;
	target_name: string | null;
	target_status: string | null;
	mine: boolean;
}

// The target's name and status come through the caller's RLS on scenario: a
// target they can't read (a withdrawn application is a draft again, which
// only its parties read; a deleted one) is null, and so is its name.
export const SELECT_LINKS = `
	SELECT s.id, s.label, s.created_at, cu.display_name AS created_by_name, s.expires_at, s.revoked_at,
		ru.display_name AS revoked_by_name, s.last_used_at, s.target_kind, s.target_id,
		sc.name AS target_name, sc.status AS target_status,
		s.created_by IS NOT DISTINCT FROM app_current_user_id() AS mine
	FROM share_link s
	LEFT JOIN scenario sc ON s.target_kind = 'scenario' AND sc.id = s.target_id
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
	/** null: the published baseline. */
	targetKind: ShareTargetKind | null;
	targetId: string | null;
	/**
	 * The target's name and status as the caller reads them; null for the
	 * baseline, and for a target they can't read now (withdrawn, so a draft
	 * again, or deleted): such a link opens nothing.
	 */
	target: { name: string; status: string } | null;
	/** The caller made it. */
	mine: boolean;
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
	lastUsedAt: iso(r.last_used_at),
	targetKind: r.target_kind,
	targetId: r.target_id,
	target: r.target_name !== null && r.target_status !== null ? { name: r.target_name, status: r.target_status } : null,
	mine: r.mine
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

// ---------------------------------------------------------------------------
// A scenario link (WP-3.15, 115_scenario_share_notes.sql app_share_scenario)
// ---------------------------------------------------------------------------

/** One EWR site's Reserve compliance on a shared run: counts and rates; the deficit only past the k rule. */
export interface SharedEwrSite {
	/** A gauge's name; null for the outlet (it may be a farm). */
	name: string | null;
	isOutlet: boolean;
	months: number | null;
	met: number | null;
	rate: number | null;
	longestNotMetRun: number | null;
	deficitM3: number | null;
	byMonth: { month: number; years: number; met: number; rate: number | null }[];
}

/** What a scenario link shows of a run. `volumes` null: the catchment has fewer than 5 farm holders. */
export interface SharedRun {
	engineVersion: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	ewrDaysNotMet: number | null;
	ewrFractionDaysNotMet: number | null;
	volumes: {
		meanNaturalFlowM3Day: number | null;
		meanSimulatedOutflowM3Day: number | null;
		farms: { count: number; demandM3Day: number; suppliedM3Day: number; belowTarget: number };
	} | null;
	ewrSites: SharedEwrSite[];
}

export interface SharedComment {
	body: string;
	/** The author's display name; null once that account is gone. */
	author: string | null;
	createdAt: string;
	editedAt: string | null;
}

/** POST /share/scenario's answer. */
export interface ShareScenario {
	/** The id lets a signed-in member comment from the page (POST /projects/:id/notes); it grants nothing on its own. */
	project: { id: string; name: string };
	scenario: {
		id: string;
		name: string;
		description: string;
		origin: 'team' | 'applicant';
		status: 'submitted' | 'decided';
		submittedAt: string | null;
		decidedAt: string | null;
		outcome: string | null;
		decisionNote: string;
		/** engine ScenarioOp[], as stored: rendered as text, never as markup. */
		ops: unknown[];
		opsSha256: string;
		/** The proposer's own nodes: an op on any other node is a baseline assumption (engine classifyOp). */
		ownedNodeIds: string[];
		/** Names of its own nodes only; every other node is anonymous. */
		opNames: { id: string; name: string }[];
		/** Each op's class as its latest run applied it (a baseline assumption shows in red); null without a run. */
		classified: ('proposal' | 'baseline')[] | null;
	};
	/**
	 * `ready`: both runs, stored by the backend (their stamps verify).
	 * `none`: the scenario has no run of its current ops yet.
	 * `unverified`: a run's stamp is missing or doesn't match, so no result is shown.
	 */
	results: 'ready' | 'none' | 'unverified';
	base: SharedRun | null;
	run: SharedRun | null;
	/** Comments posted for public participation, oldest first. */
	comments: SharedComment[];
}

/** What app_share_scenario returns (one row, or none). */
export interface ShareScenarioRow {
	project_name: string;
	scenario: Record<string, unknown>;
	base_run: Record<string, unknown> | null;
	base_stamp: Buffer | null;
	base_digest: Buffer | null;
	/** The candidate runs, newest first: `{ projection, classified, stamp, digest }` (stamp and digest hex). */
	runs: Record<string, unknown>[];
	comments: Record<string, unknown>[];
}

const hex = (v: unknown): Buffer | null => (typeof v === 'string' && /^[0-9a-f]*$/.test(v) && v.length ? Buffer.from(v, 'hex') : null);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One shared run, field by field: the database's allowlist again, so nothing it adds later leaves by default. */
export function toSharedRun(raw: Record<string, unknown>): SharedRun {
	const v = raw.volumes === null || raw.volumes === undefined ? null : obj(raw.volumes);
	const farms = obj(v?.farms);
	return {
		engineVersion: str(raw.engineVersion) ?? '',
		startDate: str(raw.startDate) ?? '',
		endDate: str(raw.endDate) ?? '',
		createdAt: str(raw.createdAt) ?? '',
		ewrDaysNotMet: num(raw.ewrDaysNotMet),
		ewrFractionDaysNotMet: num(raw.ewrFractionDaysNotMet),
		volumes: v
			? {
					meanNaturalFlowM3Day: num(v.meanNaturalFlowM3Day),
					meanSimulatedOutflowM3Day: num(v.meanSimulatedOutflowM3Day),
					farms: { count: num(farms.count) ?? 0, demandM3Day: num(farms.demandM3Day) ?? 0, suppliedM3Day: num(farms.suppliedM3Day) ?? 0, belowTarget: num(farms.belowTarget) ?? 0 }
				}
			: null,
		ewrSites: arr(raw.ewrSites).map((x) => {
			const s = obj(x);
			const isOutlet = s.isOutlet === true;
			return {
				name: isOutlet ? null : str(s.name),
				isOutlet,
				months: num(s.months),
				met: num(s.met),
				rate: num(s.rate),
				longestNotMetRun: num(s.longestNotMetRun),
				deficitM3: v ? num(s.deficitM3) : null,
				byMonth: arr(s.byMonth).map((m) => {
					const o = obj(m);
					return { month: num(o.month) ?? 0, years: num(o.years) ?? 0, met: num(o.met) ?? 0, rate: num(o.rate) };
				})
			};
		})
	};
}

/**
 * POST /share/scenario's answer from app_share_scenario's row. `verify` says
 * whether a run's stamp matches its digest (runs/stamp.ts stampMatches): the
 * results show only when both runs were stored by the backend.
 */
export function toShareScenario(r: ShareScenarioRow, verify: (digest: Buffer | null, stamp: Buffer | null) => boolean): ShareScenario {
	const s = r.scenario;
	const ops = arr(s.ops);
	const owned = arr(s.ownedNodeIds).filter((x): x is string => typeof x === 'string');
	const ownSet = new Set(owned);
	// The newest candidate the backend stored (its stamp verifies): a newer row written past the API can't displace it.
	const candidates = arr(r.runs).map(obj);
	const chosen = candidates.find((c) => verify(hex(c.digest), hex(c.stamp))) ?? null;
	const results: ShareScenario['results'] = !candidates.length ? 'none' : chosen && verify(r.base_digest, r.base_stamp) ? 'ready' : 'unverified';
	const classes = chosen && Array.isArray(chosen.classified) && chosen.classified.length === ops.length ? chosen.classified : null;
	const run = results === 'ready' && chosen ? toSharedRun(obj(chosen.projection)) : null;
	let base = results === 'ready' && r.base_run ? toSharedRun(r.base_run) : null;
	// Volumes on both or neither: the base's alone beside a hidden run's would say nothing new, but keep the pair honest.
	if (base && run && !run.volumes) base = { ...base, volumes: null, ewrSites: base.ewrSites.map((x) => ({ ...x, deficitM3: null })) };
	return {
		project: { id: str(s.projectId) ?? '', name: r.project_name },
		scenario: {
			id: str(s.id) ?? '',
			name: str(s.name) ?? '',
			description: str(s.description) ?? '',
			origin: s.origin === 'team' ? 'team' : 'applicant',
			status: s.status === 'decided' ? 'decided' : 'submitted',
			submittedAt: str(s.submittedAt),
			decidedAt: str(s.decidedAt),
			outcome: str(s.outcome),
			decisionNote: str(s.decisionNote) ?? '',
			ops,
			opsSha256: str(s.opsSha256) ?? '',
			ownedNodeIds: owned,
			// Only from a run whose stamp verifies: a forged run can't relabel a baseline assumption a proposal.
			classified: classes ? classes.map((c) => (c === 'proposal' ? 'proposal' : 'baseline')) : null,
			// Own nodes only, again: the database already filters.
			opNames: arr(s.opNames)
				.map(obj)
				.filter((x) => typeof x.id === 'string' && typeof x.name === 'string' && ownSet.has(x.id))
				.map((x) => ({ id: x.id as string, name: x.name as string }))
		},
		results,
		base,
		run,
		comments: arr(r.comments).map((c) => {
			const o = obj(c);
			return { body: str(o.body) ?? '', author: str(o.author), createdAt: str(o.createdAt) ?? '', editedAt: str(o.editedAt) };
		})
	};
}
