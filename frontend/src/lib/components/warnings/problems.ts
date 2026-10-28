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
import { isCalibrationSetting } from '#lib/components/settings/sections.js';
import { stableHash } from './ids';

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

/** The Area filter's values: what a row is about. */
export type Area = 'data' | 'rain' | 'calibration' | 'model' | 'feeds' | 'runs';
export const AREAS: readonly Area[] = ['data', 'rain', 'calibration', 'model', 'feeds', 'runs'];
export const AREA_LABEL: Record<Area, string> = { data: 'Data', rain: 'Rain', calibration: 'Calibration', model: 'Model', feeds: 'Feeds', runs: 'Runs' };

/** How a problem is solved from the page: a link to where it is fixed, a feed's Fetch now, or a run. */
export type ProblemAction = { kind: 'link'; label: string; href: string } | { kind: 'fetch'; label: string; feedId: string } | { kind: 'run'; label: string };

export interface Problem {
	/** Stable across reloads, for the kept list: `<source>:…`. */
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
	/** What to do, in plain words. */
	how: string;
	/** The row's primary action. */
	fix: ProblemAction;
	area: Area;
	/** The series it is about (Data behind), for the Record filter; null otherwise. */
	record: string | null;
}

/** A failing or stale feed, as sources.ts shapes it from the feeds list (feeds.ts healthMessage). */
export interface FeedProblem {
	id: string;
	name: string;
	message: string;
	/** Switched on, so Fetch now (POST …/run-now, an editor's) can try again. */
	enabled?: boolean;
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

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Every problem from the sources above, by source in SOURCE_FILTERS' order. */
export function problems(p: ProblemInputs): Problem[] {
	const out: Problem[] = [];
	const editor = hasRole(p.role, 'editor');
	for (const x of p.issues ?? []) {
		const href = issueHref(x);
		out.push({
			id: `model:${x.area}:${x.itemId ?? ''}:${stableHash(x.message)}`,
			source: 'model',
			title: AREA_LABEL_OF_ISSUE[x.area],
			detail: x.message,
			href,
			action: `Go to ${AREA_LABEL_OF_ISSUE[x.area]}`,
			how: 'Open it and correct what the message names; the model can’t be saved, or run, until it is.',
			fix: { kind: 'link', label: `Go to ${AREA_LABEL_OF_ISSUE[x.area]}`, href },
			area: 'model',
			record: null
		});
	}
	// The settings' problems are an unsaved edit's: an editor's alone.
	if (editor)
		for (const b of p.blockers ?? []) {
			const href = blockerHref(b.id, 'warnings');
			out.push({
				id: `settings:${b.id}`,
				source: 'settings',
				title: b.label,
				detail: `${b.message} Save is blocked until it is fixed.`,
				href,
				action: `Go to ${b.label}`,
				how: 'Correct the field, then press Save changes on the save bar; or Discard to drop the unsaved edits.',
				fix: { kind: 'link', label: `Go to ${b.label}`, href },
				area: isCalibrationSetting(b.id) ? 'calibration' : b.id === 'set-rain' ? 'rain' : 'model',
				record: null
			});
		}
	for (const f of p.feeds ?? [])
		out.push({
			id: `feeds:${f.id}`,
			source: 'feeds',
			title: f.name,
			detail: f.message,
			href: '?tab=series#data-feeds',
			action: 'Go to Data feeds',
			how: editor && f.enabled !== false ? 'Fetch it now to try again; if it keeps failing, check the feed’s settings on Data.' : 'Check the feed on Data: an editor can fetch it again or change it.',
			fix: editor && f.enabled !== false ? { kind: 'fetch', label: 'Fetch now', feedId: f.id } : { kind: 'link', label: 'Go to Data feeds', href: '?tab=series#data-feeds' },
			area: 'feeds',
			record: null
		});
	for (const s of p.behind ?? []) {
		const href = `?tab=series&series=${encodeURIComponent(s.id)}`;
		out.push({
			id: `data:${s.id}`,
			source: 'data',
			title: s.name || kindLabel(s.kind),
			detail: `Its last day is ${days(s.age)} old: runs read nothing newer.`,
			href,
			action: 'Go to Data',
			how: 'Add its newer data (a file, or a feed that fills it daily), or keep it if the record has ended.',
			fix: editor ? { kind: 'link', label: 'Add newer data', href: '?tab=series&add=data' } : { kind: 'link', label: 'Go to Data', href },
			area: 'data',
			record: s.id
		});
	}
	// A known engine bug: the runs a reader relies on, the newest and the published ones, not every old run.
	const newest = p.runs?.[0]?.id;
	for (const r of p.runs ?? []) {
		if (!r.errata?.length || (r.id !== newest && !r.published)) continue;
		const href = `?tab=runs&run=${encodeURIComponent(r.id)}`;
		out.push({
			id: `runs:${r.id}`,
			source: 'runs',
			title: `${r.label || 'Untitled run'}${r.published ? ' (published)' : ''}`,
			detail: `May be affected by ${r.errata.length === 1 ? 'a known engine bug' : `${r.errata.length} known engine bugs`} (${r.errata.join(', ')}): re-run it on the current engine to compare.`,
			href,
			action: 'Go to Runs & results',
			how: 'Run the model again on the current engine, then compare the new run with this one.',
			fix: editor ? { kind: 'run', label: 'Run the model' } : { kind: 'link', label: 'Go to Runs & results', href },
			area: 'runs',
			record: null
		});
	}
	return out;
}

const AREA_LABEL_OF_ISSUE: Record<ModelIssue['area'], string> = { network: 'Network', crops: 'Crops & demand', transfers: 'Transfers' };

/** The Warnings row's badge: the data checks' open items and every problem from elsewhere. Null until the checks are counted. */
export function badgeCount(openChecks: number | null, other: readonly Problem[]): number | null {
	return openChecks === null ? null : openChecks + other.length;
}
