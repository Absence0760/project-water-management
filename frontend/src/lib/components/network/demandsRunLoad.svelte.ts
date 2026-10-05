// Loads the latest run's summary for the Demands grid (docs/ui.md § Demands
// grid) and gives each row its figure (demandsRun.ts). The latest run is
// runs[0], as the Network's supply colouring takes it; the summary comes from
// the Runs cache when the page already holds it, else one fetch.
import { api, type RunMeta } from '$lib/api';
import { detailCache } from '$lib/components/runs/cache';
import type { RunSummary } from '@water-management/engine';
import type { DemandRow } from './demands';
import { demandRunFigures, runTotal, type RunFigure } from './demandsRun';

export interface DemandsRun {
	/** The run shown, or null without one. */
	readonly meta: RunMeta | null;
	readonly loading: boolean;
	readonly failed: boolean;
	/** Each row's figure by key, once the summary is in; null before (or without a run). */
	readonly figures: Map<string, RunFigure> | null;
	readonly total: RunFigure | null;
	retry(): void;
}

export function latestRunFigures(projectId: () => string | null, runs: () => RunMeta[] | null, rows: () => readonly DemandRow[]): DemandsRun {
	const meta = $derived(projectId() ? (runs()?.[0] ?? null) : null);
	let loaded = $state<{ id: string; summary: RunSummary } | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let wanted = '';

	async function load(pid: string, id: string) {
		wanted = id;
		const hit = detailCache.get(id);
		if (hit) {
			loaded = { id, summary: hit.run.summary };
			return;
		}
		loading = true;
		failed = false;
		try {
			const d = await api.runs.get(pid, id);
			detailCache.set(id, d);
			if (wanted === id) loaded = { id, summary: d.run.summary };
		} catch {
			if (wanted === id) failed = true;
		} finally {
			if (wanted === id) loading = false;
		}
	}

	$effect(() => {
		const pid = projectId();
		const id = meta?.id;
		if (pid && id && id !== wanted) void load(pid, id);
	});

	const figures = $derived(meta && loaded?.id === meta.id ? demandRunFigures(rows(), loaded.summary) : null);
	const total = $derived(figures ? runTotal(rows(), figures) : null);

	return {
		get meta() {
			return meta;
		},
		get loading() {
			return loading;
		},
		get failed() {
			return failed;
		},
		get figures() {
			return figures;
		},
		get total() {
			return total;
		},
		retry() {
			const pid = projectId();
			if (pid && meta) {
				wanted = '';
				void load(pid, meta.id);
			}
		}
	};
}
