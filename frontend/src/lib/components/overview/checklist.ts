// Setup checklist for a catchment: network → crops & areas → rainfall/flow
// data → settings & EWR → run. Status is derived from data the Overview tab
// already has (the model being edited, project settings, series + run lists).
import type { ProjectModel, ProjectSettings, SeriesMeta } from '@water-management/engine';
import type { RunMeta } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

export type StepId = 'network' | 'crops' | 'series' | 'settings' | 'runs';
/** `done`; `partial` = started or has a gap worth a look; `todo`; `unknown` = still loading. */
export type StepStatus = 'done' | 'partial' | 'todo' | 'unknown';

export interface ChecklistStep {
	id: StepId;
	/** The project tab to open (`?tab=`). */
	tab: StepId;
	title: string;
	status: StepStatus;
	/** One line: what's there, or what to do next. */
	detail: string;
	/** Can be skipped and still get a run (e.g. no irrigation, no EWR). */
	optional?: boolean;
}

export interface ChecklistInput {
	model: ProjectModel;
	settings: ProjectSettings;
	/** null while loading. */
	series: SeriesMeta[] | null;
	runs: RunMeta[] | null;
	/** Project last changed (model or settings save); flags results as stale. */
	updatedAt?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const RAIN = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'];
const OBSERVED = ['flow_observed_m3s', 'flow_logger_m3s'];

function networkStep(m: ProjectModel, s: ProjectSettings): ChecklistStep {
	const base = { id: 'network', tab: 'network', title: 'River network' } as const;
	const farms = m.nodes.filter((n) => n.kind === 'farm');
	const gauges = m.nodes.length - farms.length;
	const outlets = m.nodes.filter((n) => n.downstreamNodeId === null);
	if (!m.nodes.length)
		return { ...base, status: 'todo', detail: 'Add hydrological units and gauges, each draining to the one below, ending at the outflow gauge.' };
	if (!farms.length)
		return { ...base, status: 'partial', detail: `${plural(gauges, 'gauge')} but no hydrological units yet. Add the hydrological units that draw water.` };
	if (outlets.length !== 1)
		return { ...base, status: 'partial', detail: 'The network needs exactly one outflow gauge (a node that drains nowhere).' };
	const area = farms.reduce((a, n) => a + (n.areaKm2 || 0), 0);
	if (!(area > 0) && !(s.calibration.catchmentAreaKm2 && s.calibration.catchmentAreaKm2 > 0))
		return { ...base, status: 'partial', detail: 'Give the hydrological units their catchment areas (km²) so rainfall can be turned into flow.' };
	return {
		...base,
		status: 'done',
		detail: `${plural(farms.length, 'hydrological unit')}, ${plural(gauges, 'gauge')}, draining to ${outlets[0]!.name || 'the outflow gauge'}.`
	};
}

function cropsStep(m: ProjectModel): ChecklistStep {
	const base = { id: 'crops', tab: 'crops', title: 'Crops & irrigated areas', optional: true } as const;
	const areaHa = m.cropAreas.reduce((a, c) => a + (c.areaM2 || 0), 0) / 10_000;
	if (!m.crops.length)
		return { ...base, status: 'todo', detail: 'Add crops with monthly crop factors, then the hectares planted on each hydrological unit. Skip if nothing is irrigated.' };
	if (!(areaHa > 0))
		return { ...base, status: 'partial', detail: `${plural(m.crops.length, 'crop')} defined, but no irrigated area on any hydrological unit yet.` };
	const farms = new Set(m.cropAreas.filter((c) => c.areaM2 > 0).map((c) => c.nodeId)).size;
	return {
		...base,
		status: 'done',
		detail: `${plural(m.crops.length, 'crop')} on ${plural(farms, 'hydrological unit')}, ${fmtNum(areaHa, 1, true)} ha irrigated.`
	};
}

function seriesStep(series: SeriesMeta[] | null): ChecklistStep {
	const base = { id: 'series', tab: 'series', title: 'Rainfall & flow data' } as const;
	if (series === null) return { ...base, status: 'unknown', detail: 'Checking time series…' };
	const rain = series.filter((x) => RAIN.includes(x.kind));
	// The outlet's record: a run's calibration statistics (NSE, PBIAS) read it; one attached to a gauge inside the network (084_gauge_records) is checked there, and fitted only at a calibration site.
	const observed = series.some((x) => OBSERVED.includes(x.kind) && !x.siteNodeId);
	if (!rain.length)
		return { ...base, status: 'todo', detail: 'Upload daily catchment rainfall (mm). Add observed flow (m³/s) to calibrate against.' };
	const years = Math.max(0, ...rain.map((x) => x.length)) / 365.25;
	const what = `Rainfall${years >= 1 ? ` (${plural(Math.floor(years), 'year')})` : ''}`;
	if (!observed)
		return { ...base, status: 'partial', detail: `${what} loaded. No observed flow yet, so calibration fit (NSE, PBIAS) can't be checked.` };
	return { ...base, status: 'done', detail: `${what} and observed flow loaded.` };
}

function settingsStep(s: ProjectSettings): ChecklistStep {
	const base = { id: 'settings', tab: 'settings', title: 'Evaporation, calibration & EWR' } as const;
	const apan = s.apanMm.some((v) => v > 0);
	const ewr = s.ewrPragmaticM3PerDay.some((v) => v > 0);
	if (!apan && !ewr)
		return { ...base, status: 'todo', detail: 'Enter monthly A-pan evaporation (mm) and the pragmatic EWR (m³/day), Oct–Sep.' };
	if (!apan)
		return { ...base, status: 'partial', detail: 'A-pan evaporation is all zero, so crops need no irrigation. Enter it for Oct–Sep.' };
	if (!ewr)
		return { ...base, status: 'partial', detail: 'No EWR set, so environmental shortfalls won’t be reported.', optional: true };
	return { ...base, status: 'done', detail: 'A-pan evaporation and EWR set. Review the calibration against observed flow.' };
}

function runsStep(runs: RunMeta[] | null, updatedAt?: string): ChecklistStep {
	const base = { id: 'runs', tab: 'runs', title: 'Run the model' } as const;
	if (runs === null) return { ...base, status: 'unknown', detail: 'Checking runs…' };
	if (!runs.length) return { ...base, status: 'todo', detail: 'Run it to get hydrological unit supply & deficit, dam storage, spills and EWR shortfalls.' };
	const last = runs.reduce((a, r) => (Date.parse(r.createdAt) > Date.parse(a.createdAt) ? r : a));
	const when = last.createdAt.slice(0, 10);
	if (updatedAt && Date.parse(updatedAt) > Date.parse(last.createdAt))
		return { ...base, status: 'partial', detail: `Last run ${when}; the project has changed since. Run again to refresh the results.` };
	return { ...base, status: 'done', detail: `${plural(runs.length, 'run')}, latest ${when}.` };
}

export function checklist(input: ChecklistInput): ChecklistStep[] {
	return [
		networkStep(input.model, input.settings),
		cropsStep(input.model),
		seriesStep(input.series),
		settingsStep(input.settings),
		runsStep(input.runs, input.updatedAt)
	];
}

/** Steps that are finished (for "3 of 5 done"). Optional steps left as-is still count once they're `partial`. */
export function progress(steps: ChecklistStep[]): { done: number; total: number; complete: boolean } {
	const done = steps.filter((s) => s.status === 'done' || (s.optional && s.status === 'partial')).length;
	return { done, total: steps.length, complete: done === steps.length };
}

/** First step still needing work: the one to highlight as "Next". */
export function nextStep(steps: ChecklistStep[]): ChecklistStep | undefined {
	return steps.find((s) => s.status === 'todo' || (s.status === 'partial' && !s.optional));
}

/**
 * How the Summary shows the checklist: `complete` → a "Setup complete" pill in the section header,
 * whose popover lists the steps (SetupPill); `open` → the full checklist on the page; `checking` →
 * a one-line bar while series or runs load and every step known so far is done. Decided from the
 * steps already known, so the first frame has the final shape: never open-then-collapse.
 */
export type ChecklistMode = 'complete' | 'checking' | 'open';
export function checklistMode(steps: ChecklistStep[]): ChecklistMode {
	if (progress(steps).complete) return 'complete';
	const checking = steps.some((s) => s.status === 'unknown');
	const knownGap = steps.some((s) => s.status !== 'unknown' && s.status !== 'done' && !(s.optional && s.status === 'partial'));
	return checking && !knownGap ? 'checking' : 'open';
}
