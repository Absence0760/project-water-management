// Overview → "Needs attention": the few things worth acting on, gathered from
// signals the app already computes (the latest run's summary, the series
// freshness checks, the model being edited). Each item links to the tab where
// it is fixed or read. An empty list hides the panel.
import type { ProjectModel, RunSummary, SeriesMeta } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { farmDrawerHref } from '$lib/components/crops/farmDrawer';
import { supplyHref } from '$lib/components/supply/links';
import { LOW_SUPPLY } from '$lib/components/network/supplyColour';
import { SUPPLY_TARGET } from '$lib/components/runs/results';
import { dateAge } from '$lib/format/age';
import { freshness, newDataSinceRun, STALE_DAYS } from '$lib/components/series/freshness';
import { fmtNum, fmtPct } from '$lib/format/number';

export type AttentionId = 'short-farms' | 'run-warnings' | 'new-data' | 'stale-data' | 'unplanted';

/** How much it matters: the card's colour (never alone: the title says what's wrong). */
export type AttentionTone = 'danger' | 'warning' | 'info';

export interface AttentionItem {
	id: AttentionId;
	/** A few words: the card's title. */
	title: string;
	/** One sentence under it: the detail. */
	text: string;
	tone: AttentionTone;
	/** The link's words: what to do about it. */
	action: string;
	/** `?tab=…` (and `&run=…` for a run), or `?farm=…` for the farm drawer. */
	href: string;
	/** A second link, after the first: the one farm's planted areas (the farm drawer, issue #17). */
	also?: { action: string; href: string };
}

export interface AttentionInput {
	model: ProjectModel;
	/** null while loading (the data items wait). */
	series: SeriesMeta[] | null;
	/** The run the Overview shows (overview/latestRun.ts pickRuns), null without runs. */
	latest: RunMeta | null;
	/** Its summary; null until loaded (the run items wait). */
	summary: RunSummary | null;
	/** The viewer's calendar date (YYYY-MM-DD). */
	today: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
export function nameList(names: readonly string[], max = 3): string {
	if (names.length <= max) return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
	return `${names.slice(0, max).join(', ')} and ${fmtNum(names.length - max)} more`;
}

export const runHref = (runId: string) => `?tab=runs&run=${encodeURIComponent(runId)}`;

export function attention(input: AttentionInput): AttentionItem[] {
	const { model, series, latest, summary, today } = input;
	const out: AttentionItem[] = [];

	if (latest && summary) {
		const farms = summary.farms ?? [];
		const short = farms.filter((f) => f.fractionSupplied < SUPPLY_TARGET);
		if (short.length) {
			const worst = short.reduce((a, f) => (f.fractionSupplied < a.fractionSupplied ? f : a));
			const target = fmtPct(SUPPLY_TARGET, 0);
			const worstText = `${worst.name || 'An unnamed hydrological unit'} got ${fmtPct(worst.fractionSupplied, 0)} of its demand in the latest run`;
			// Its planted areas, when it is still a farm in the model (the run may be older than an edit).
			const inModel = model.nodes.some((n) => n.id === worst.nodeId && n.kind === 'farm');
			out.push({
				id: 'short-farms',
				title: `${fmtNum(short.length)} of ${plural(farms.length, 'hydrological unit')} below ${target}`,
				// Red when the worst is in the lowest supply band (network/supplyColour.ts), amber otherwise.
				tone: worst.fractionSupplied < LOW_SUPPLY ? 'danger' : 'warning',
				text:
					short.length === 1
						? `${worstText}, below the ${target} target.`
						: `${worstText}, the least of the ${fmtNum(short.length)} hydrological units below ${target} (of ${fmtNum(farms.length)}).`,
				// Units & supply for the run, opened on the worst unit (issue #17).
				action: 'See the hydrological unit results',
				href: supplyHref(latest.id, { unit: worst.nodeId }),
				...(inModel ? { also: { action: 'Its planted areas', href: farmDrawerHref(null, worst.nodeId) } } : {})
			});
		}
		const warnings = summary.warnings?.length ?? 0;
		if (warnings) {
			const first = summary.warnings[0]!;
			out.push({
				id: 'run-warnings',
				title: `The latest run has ${plural(warnings, 'warning')}`,
				tone: 'warning',
				// The first one, so the card says what it is about.
				text: `${first.charAt(0).toUpperCase()}${first.slice(1)}${warnings > 1 ? ` (and ${fmtNum(warnings - 1)} more)` : ''}`,
				action: warnings === 1 ? 'Read it' : 'Read them',
				href: runHref(latest.id)
			});
		}
	}

	if (series) {
		const behind = latest ? newDataSinceRun(series, latest) : [];
		if (behind.length)
			out.push({
				id: 'new-data',
				title: 'New rainfall the run hasn’t used',
				tone: 'info',
				text: `${plural(behind.length, 'rainfall series', 'rainfall series')} ${behind.length === 1 ? 'has' : 'have'} data the latest run hasn’t used.`,
				action: 'Run the model again',
				href: '?tab=runs'
			});
		const fresh = freshness(series, today);
		if (fresh?.stale)
			out.push({
				id: 'stale-data',
				title: fresh.latest !== null && fresh.age !== null ? `Recorded rain ends ${dateAge(fresh.latest, fresh.age)}` : 'No recorded rain yet',
				tone: 'warning',
				text:
					fresh.latest !== null && fresh.age !== null
						? `The newest recorded rain ends ${dateAge(fresh.latest, fresh.age)}, more than ${plural(STALE_DAYS, 'day')} ago.`
						: 'There is no recorded rain (catchment or CHIRPS) yet.',
				action: 'Add data',
				href: '?tab=series'
			});
	}

	// Farms nothing is planted on draw no irrigation water. Only once something
	// is planted: before that, the setup checklist's crops step says so.
	const planted = new Set(model.cropAreas.filter((a) => a.areaM2 > 0).map((a) => a.nodeId));
	if (planted.size) {
		const bare = model.nodes.filter((n) => n.kind === 'farm' && !planted.has(n.id));
		// One farm: straight to its planted areas; several: the Crops tab's table.
		if (bare.length)
			out.push({
				id: 'unplanted',
				title: `${plural(bare.length, 'hydrological unit')} with no planted area`,
				tone: 'info',
				text: `${nameList(bare.map((n) => n.name || 'Unnamed hydrological unit'))} ${bare.length === 1 ? 'has no planted area, so it draws' : 'have no planted area, so they draw'} no irrigation water.`,
				action: bare.length === 1 ? 'Set its planted areas' : 'Set crop areas',
				href: bare.length === 1 ? farmDrawerHref(null, bare[0]!.id) : '?tab=crops'
			});
	}
	return out;
}
