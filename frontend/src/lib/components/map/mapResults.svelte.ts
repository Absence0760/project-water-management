// Results on the map, the state (issue #326 A1; docs/ui.md § Map): which run
// and measure the URL names, the run's record through the Runs cache, its dam
// levels when "Dam level" is picked (from the summary, or each dam's series
// for a run before engine 1.2.0, as the Network's colour by dam level), each
// unit's and gauge's figure (mapStatus.ts), and the fills CatchmentMap draws,
// read again whenever the app's theme changes (`dark`). Built during the
// tab's init, so its effects belong to the tab.
import { untrack } from 'svelte';
import type { NetworkNode } from '@water-management/engine';
import { api, type MapFeature, type Role, type Run, type RunMeta, type RunSeriesRef } from '$lib/api';
import { cachedSeries, detailCache } from '$lib/components/runs/cache';
import { damLevelsFromSummary, damsInRun, loadDamLevels, type DamLevel } from '$lib/components/overview/damLevels';
import { historyEnd } from '$lib/components/overview/latestRun';
import { BAND_TOKEN, bandFills, chooseMapRun, ewrStatuses, mapRuns, readToken, unitStatuses, type MapBand, type MapStatus } from './mapStatus';
import { MEASURE_PARAM, RUN_PARAM, resultFills, viewFromParam, type MapView } from './mapResults';

export interface MapResultsInput {
	projectId: () => string;
	runs: () => readonly RunMeta[] | null;
	role: () => Role | null;
	/** The model's nodes now (the editor's): which units and gauges to show, and the live dams. */
	nodes: () => readonly NetworkNode[];
	features: () => readonly MapFeature[];
	params: () => URLSearchParams;
	/** The app's theme now (appTheme.ts): the fills are read again when it changes. */
	dark: () => boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class MapResults {
	#o: MapResultsInput;
	constructor(o: MapResultsInput) {
		this.#o = o;
		$effect(() => {
			const id = this.run?.id ?? null;
			void this.#attempt;
			untrack(() => this.#load(id));
		});
		$effect(() => {
			const want = this.view === 'damLevel' && this.detail && this.run ? this.run : null;
			void this.#damAttempt;
			untrack(() => this.#loadDams(want));
		});
	}

	/** The picked view (`measure=`), whatever the run. */
	readonly view: MapView = $derived(viewFromParam(this.#params().get(MEASURE_PARAM)));
	/** The runs this person may show (every run for an editor, the published one below), newest first as listed. */
	readonly runs: RunMeta[] = $derived(this.#in().role() ? mapRuns(this.#in().runs() ?? [], this.#in().role()!) : []);
	readonly choice = $derived(chooseMapRun(this.#in().runs() ?? [], this.#in().role() ?? 'viewer', this.#params().get(RUN_PARAM)));
	get run(): RunMeta | null {
		return this.choice.run;
	}
	/** A measure is shown: a run to read and a measure picked. */
	readonly on: boolean = $derived(!!this.run && this.view !== 'kind');

	#params() {
		return this.#o.params();
	}
	/** The inputs, read through a method so the fields' deriveds may use them (they run after the constructor). */
	#in() {
		return this.#o;
	}

	// --- the run's record (summary, model, series list) ---
	detail = $state.raw<{ run: Run; series: RunSeriesRef[] } | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	#attempt = $state(0);
	#key = '';
	#load(id: string | null) {
		const key = id ? `${id}|${this.#attempt}` : '';
		if (key === this.#key) return;
		this.#key = key;
		this.error = null;
		const hit = id ? detailCache.get(id) : undefined;
		this.detail = hit ?? null;
		this.loading = !!id && !hit;
		if (!id || hit) return;
		api.runs
			.get(this.#o.projectId(), id)
			.then((d) => {
				detailCache.set(id, d);
				if (this.#key === key) this.detail = d;
			})
			.catch((e) => {
				if (this.#key === key) this.error = errText(e);
			})
			.finally(() => {
				if (this.#key === key) this.loading = false;
			});
	}
	retry() {
		this.#attempt++;
	}

	// --- dam levels, only while "Dam level" is shown ---
	damLevels = $state.raw<{ runId: string; levels: DamLevel[] } | null>(null);
	damLoading = $state<{ done: number; of: number } | null>(null);
	damError = $state(false);
	#damAttempt = $state(0);
	#loadDams(meta: RunMeta | null) {
		const d = this.detail;
		if (!meta || !d || d.run.id !== meta.id || this.damLevels?.runId === meta.id) return;
		// The run's own capacities and minimum levels, as the Network's and the Summary's.
		const dams = damsInRun(d.run.model?.nodes as Parameters<typeof damsInRun>[0], this.#o.nodes(), d.series);
		const fromSummary = damLevelsFromSummary(dams, d.run.summary.farms, historyEnd(meta));
		this.damError = false;
		if (fromSummary) {
			this.damLevels = { runId: meta.id, levels: fromSummary };
			return;
		}
		const projectId = this.#o.projectId();
		this.damLoading = { done: 0, of: dams.length };
		loadDamLevels(
			dams,
			(nodeId) => cachedSeries(meta.id, 'dam_storage', nodeId, () => api.runs.series(projectId, meta.id, 'dam_storage', nodeId)),
			4,
			(n) => {
				if (this.damLoading) this.damLoading = { done: n, of: dams.length };
			},
			meta.forecastFrom ?? null
		)
			.then((levels) => {
				if (this.run?.id === meta.id) this.damLevels = { runId: meta.id, levels };
			})
			.catch(() => {
				if (this.run?.id === meta.id) this.damError = true;
			})
			.finally(() => {
				this.damLoading = null;
			});
	}
	retryDams() {
		this.damLevels = null;
		this.#damAttempt++;
	}

	// --- the figures ---
	/** The run's summary, once the shown run's record is in. */
	readonly summary = $derived(this.detail && this.run && this.detail.run.id === this.run.id ? this.detail.run.summary : null);
	/** Every unit's figure for the measure (empty while the run loads or no measure is shown). */
	readonly units: MapStatus[] = $derived.by(() => {
		if (!this.on || !this.summary || this.view === 'kind') return [];
		const levels = this.damLevels?.runId === this.run?.id ? this.damLevels!.levels : null;
		return unitStatuses(this.view, { nodes: this.#in().nodes(), summary: this.summary, damLevels: levels });
	});
	/** Each gauge's and the outlet's EWR, met or missed. */
	readonly ewr: MapStatus[] = $derived(this.on && this.summary ? ewrStatuses({ nodes: this.#in().nodes(), summary: this.summary }) : []);
	readonly unitBy = $derived(new Map(this.units.map((s) => [s.nodeId, s])));
	readonly ewrBy = $derived(new Map(this.ewr.map((s) => [s.nodeId, s])));
	/** The figures are in (the run's summary and, for dam level, the levels). */
	readonly ready: boolean = $derived(this.on && !!this.summary && (this.view !== 'damLevel' || this.damLevels?.runId === this.run?.id));

	// --- the colours: each band's token as the app's theme draws it now ---
	/** Each band's resolved colour; read again when `dark` changes, so the map follows a theme switch. */
	readonly colours: Record<MapBand, string> = $derived.by(() => {
		void this.#in().dark();
		return Object.fromEntries((Object.keys(BAND_TOKEN) as MapBand[]).map((b) => [b, readToken(BAND_TOKEN[b])])) as Record<MapBand, string>;
	});
	/** The fills for CatchmentMap (undefined = each feature's kind colour). */
	readonly fills: Record<string, string> | undefined = $derived.by(() => {
		if (!this.ready) return undefined;
		const c = this.colours;
		// Units first, then the gauges' EWR for nodes that aren't units (the outlet may be a unit).
		const statuses = [...this.units, ...this.ewr.filter((s) => !this.unitBy.has(s.nodeId))];
		const byToken = new Map((Object.keys(BAND_TOKEN) as MapBand[]).map((b) => [BAND_TOKEN[b], c[b]]));
		const filled = bandFills(this.#in().features(), statuses, (token) => byToken.get(token) ?? readToken(token));
		return resultFills(this.#in().features(), filled, c.none);
	});
}
