// The Warnings page's problems from elsewhere in the project (issue #611): each
// a row with a link to where it is fixed, read-only here (their fix is on
// their own page, not a setting this page writes). One source each, all
// already shown somewhere else in the workspace, so the page gathers them
// rather than finding new ones:
//   model: the model editor's problems (editor.issues, the sidebar's "Has
//     problems to fix" dots), each linked as the save bar links it (issueHref);
//   settings: the unsaved settings' problems that block Save (the settings
//     draft's blockers, the save bar's list), linked to their panel;
//   feeds: data feeds failing or stale (the Data page's Data feeds health);
//   data: series a run is driven by that are behind today (the Data row's
//     "N series behind" badge, series/freshness.ts);
//   runs: the newest and published runs a known engine bug may affect (the
//     run's "May be affected" tag, RunMeta.errata).
// The data checks and the run's warnings are sources too (items.ts,
// runWarnings.ts); SOURCE_FILTERS lists every source for the page's chips.
// Pure and light: the workspace page counts these for the Warnings row's
// badge without loading the page's chunk.
import { issueHref, type ModelIssue } from '#lib/model/validate.js';
import { blockerHref } from '#lib/components/settings/blockers.js';
import type { SaveBlocker } from '#lib/components/settings/sections.js';
import { kindLabel } from '#lib/series/kinds.js';
import { hasRole, type Role } from '#lib/api/types.js';

export type ProblemSource = 'model' | 'settings' | 'feeds' | 'data' | 'runs';
/** Every source the page lists, in its order: the data checks first. */
export type SourceFilter = 'all' | 'checks' | ProblemSource | 'run';
export const SOURCE_FILTERS: readonly SourceFilter[] = ['all', 'checks', 'model', 'settings', 'feeds', 'data', 'runs', 'run'];
export const SOURCE_LABEL: Record<SourceFilter, string> = {
	all: 'All',
	checks: 'Data checks',
	model: 'Model',
	settings: 'Unsaved settings',
	feeds: 'Data feeds',
	data: 'Data behind',
	runs: 'Runs',
	run: 'Run warnings'
};
export const PROBLEM_SOURCES: readonly ProblemSource[] = ['model', 'settings', 'feeds', 'data', 'runs'];

export const parseSource = (v: string | null): SourceFilter => (v && (SOURCE_FILTERS as readonly string[]).includes(v) ? (v as SourceFilter) : 'all');

export interface Problem {
	id: string;
	source: ProblemSource;
	/** What it is about: a unit, a settings panel, a feed, a series, a run. */
	title: string;
	/** What is wrong, in a sentence. */
	detail: string;
	/** Where it is fixed. */
	href: string;
	/** The link's words: "Go to Network". */
	action: string;
}

/** A failing or stale feed, as sources.ts shapes it from the feeds list (feeds.ts healthMessage). */
export interface FeedProblem {
	id: string;
	name: string;
	message: string;
}

/** A series behind today (series/freshness.ts Freshness.behind). */
export interface BehindSeries {
	id: string;
	kind: string;
	name: string;
	end: string;
	age: number;
}

/** A run as the runs list has it: its label, whether it is published, and the errata that may affect it. */
export interface RunLike {
	id: string;
	label: string | null;
	published?: boolean;
	errata?: string[];
}

export interface ProblemInputs {
	issues?: readonly ModelIssue[] | null;
	blockers?: readonly SaveBlocker[] | null;
	feeds?: readonly FeedProblem[] | null;
	behind?: readonly BehindSeries[] | null;
	/** Newest first, as the page holds them. */
	runs?: readonly RunLike[] | null;
	role?: Role | null;
}

const AREA_LABEL: Record<ModelIssue['area'], string> = { network: 'Network', crops: 'Crops & demand', transfers: 'Transfers' };
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Every problem from the sources above, by source in SOURCE_FILTERS' order. */
export function problems(p: ProblemInputs): Problem[] {
	const out: Problem[] = [];
	(p.issues ?? []).forEach((x, i) =>
		out.push({ id: `model:${x.area}:${x.itemId ?? ''}:${i}`, source: 'model', title: AREA_LABEL[x.area], detail: x.message, href: issueHref(x), action: `Go to ${AREA_LABEL[x.area]}` })
	);
	// The settings' problems are an unsaved edit's: an editor's alone.
	if (hasRole(p.role, 'editor'))
		for (const b of p.blockers ?? [])
			out.push({ id: `settings:${b.id}`, source: 'settings', title: b.label, detail: `${b.message} Save is blocked until it is fixed.`, href: blockerHref(b.id, 'warnings'), action: `Go to ${b.label}` });
	for (const f of p.feeds ?? []) out.push({ id: `feeds:${f.id}`, source: 'feeds', title: f.name, detail: f.message, href: '?tab=series#data-feeds', action: 'Go to Data feeds' });
	for (const s of p.behind ?? [])
		out.push({
			id: `data:${s.id}`,
			source: 'data',
			title: s.name || kindLabel(s.kind),
			detail: `Its last day is ${days(s.age)} old: runs read nothing newer.`,
			href: `?tab=series&series=${encodeURIComponent(s.id)}`,
			action: 'Go to Data'
		});
	// A known engine bug: the runs a reader relies on, the newest and the published ones, not every old run.
	const newest = p.runs?.[0]?.id;
	for (const r of p.runs ?? []) {
		if (!r.errata?.length || (r.id !== newest && !r.published)) continue;
		out.push({
			id: `runs:${r.id}`,
			source: 'runs',
			title: `${r.label || 'Untitled run'}${r.published ? ' (published)' : ''}`,
			detail: `May be affected by ${r.errata.length === 1 ? 'a known engine bug' : `${r.errata.length} known engine bugs`} (${r.errata.join(', ')}): re-run it on the current engine to compare.`,
			href: `?tab=runs&run=${encodeURIComponent(r.id)}`,
			action: 'Go to Runs & results'
		});
	}
	return out;
}

/** The Warnings row's badge: the data checks' open items and every problem from elsewhere. Null until the checks are counted. */
export function badgeCount(openChecks: number | null, other: readonly Problem[]): number | null {
	return openChecks === null ? null : openChecks + other.length;
}
