<script lang="ts">
	// Summary → Dam levels: each dam's storage at the end of the latest run and
	// at its lowest in the run's last year (damLevels.ts), emptiest first. The
	// run summary has no dam figures, so each dam's daily dam_storage series is
	// fetched through the Runs tab's cache, a few at a time. Capacity and the
	// minimum level come from the run's own model, so a later edit doesn't skew
	// them. Its own chunk, loaded by OverviewTab once the run's record is in.
	import { api, type Run, type RunSeriesRef } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { cachedSeries } from '$lib/components/runs/cache';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import { runHref } from './attention';
	import { levelBand, loadDamLevels, LOW_PCT, type DamLevel } from './damLevels';

	let {
		projectId,
		run,
		refs,
		liveNodes
	}: {
		projectId: string;
		run: Run;
		/** The run's stored series (its detail record). */
		refs: RunSeriesRef[];
		/** The model's nodes, for a run saved before it kept its own model. */
		liveNodes: readonly { id: string; name: string; damCapacityM3: number; damMinPct: number }[];
	} = $props();

	/** Rows shown before "Show all". */
	const FIRST = 8;
	/** Series fetched at once. */
	const AT_ONCE = 4;

	type DamNode = { id: string; name: string; damCapacityM3?: unknown; damMinPct?: unknown };
	const dams = $derived.by(() => {
		const snap = (run.model?.nodes as DamNode[] | undefined) ?? [];
		const nodes: DamNode[] = snap.length ? snap : [...liveNodes];
		const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
		return nodes
			.map((n) => ({ nodeId: n.id, name: n.name || '(unnamed)', capacityM3: num(n.damCapacityM3), minPct: num(n.damMinPct) }))
			.filter((d) => d.capacityM3 >= 1 && refs.some((r) => r.key === 'dam_storage' && r.nodeId === d.nodeId));
	});

	let levels = $state.raw<DamLevel[]>([]);
	let done = $state(0);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let attempt = $state(0);
	let showAll = $state(false);

	$effect(() => {
		const id = run.id;
		const list = dams;
		void attempt;
		levels = [];
		done = 0;
		error = null;
		loading = list.length > 0;
		if (!list.length) return;
		loadDamLevels(
			list,
			(nodeId) => cachedSeries(id, 'dam_storage', nodeId, () => api.runs.series(projectId, id, 'dam_storage', nodeId)),
			AT_ONCE,
			(n) => {
				if (id === run.id) done = n;
			}
		)
			.then((l) => {
				if (id === run.id) levels = l;
			})
			.catch((e) => {
				if (id === run.id) error = e instanceof Error ? e.message : String(e);
			})
			.finally(() => {
				if (id === run.id) loading = false;
			});
	});

	const shown = $derived(showAll ? levels : levels.slice(0, FIRST));
	const pct = (v: number) => `${fmtNum(v, 0)}%`;
	const BAND_WORDS = { 'at-min': 'at its minimum level', low: `below ${LOW_PCT}%`, ok: '' } as const;
</script>

{#if dams.length}
	<section class="panel dams" aria-labelledby="dams-h" aria-busy={loading}>
		<div class="panel-head">
			<h2 id="dams-h">Dam levels</h2>
			<a href={runHref(run.id)}>Open in Runs</a>
		</div>
		{#if loading}
			<p class="muted" role="status">Loading dam levels ({done} of {dams.length})…</p>
		{:else}
		<LoadState loading={false} {error} retry={() => attempt++}>
			{#if levels.length === 0}
				<p class="muted">This run stored no dam storage to show.</p>
			{:else}
				<p class="muted small intro">
					Storage as a share of each dam's capacity at the end of the run ({fmtDay(levels[0]!.endDate)}), emptiest first, and
					the lowest it reached in the run's last year.
				</p>
				<div class="table-wrap">
					<table class="data compact">
						<thead>
							<tr>
								<th scope="col">Dam</th>
								<th scope="col">At the end of the run</th>
								<th scope="col" class="num">Lowest in its last year</th>
								<th scope="col" class="num">Days at minimum</th>
							</tr>
						</thead>
						<tbody>
							{#each shown as l (l.nodeId)}
								{@const band = levelBand(l)}
								<tr data-dam={l.nodeId}>
									<th scope="row">{l.name}<span class="cap muted">{fmtNum(l.capacityM3)} m³</span></th>
									<td>
										<span class="level">
											<span class="bar" aria-hidden="true">
												<span class="fill {band}" style:width="{Math.min(100, Math.max(0, l.endPct))}%"></span>
												{#if l.minPct > 0}<span class="min" style:left="{Math.min(100, l.minPct)}%"></span>{/if}
											</span>
											<span class="v">{pct(l.endPct)}{#if BAND_WORDS[band]}<span class="band {band}"> · {BAND_WORDS[band]}</span>{/if}</span>
										</span>
									</td>
									<td class="num">{pct(l.lowPct)} <span class="muted">· {fmtDay(l.lowDate)}</span></td>
									<td class="num">{l.minPct > 0 ? fmtNum(l.daysAtMin) : '–'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if levels.length > FIRST}
					<button type="button" class="btn btn-sm more" aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
						{showAll ? `Show the ${FIRST} emptiest` : `Show all ${levels.length} dams`}
					</button>
				{/if}
				<p class="muted small key">
					The tick on a bar is the dam's minimum operating level. "Days at minimum" counts the days in the last year the dam
					sat at or below it.
				</p>
			{/if}
		</LoadState>
		{/if}
	</section>
{/if}

<style>
	.dams h2 {
		margin: 0;
		font-size: 1.05rem;
	}
	.intro,
	.key {
		margin: 0.25rem 0 0.5rem;
	}
	.cap {
		display: block;
		font-weight: 400;
		font-size: 0.8rem;
	}
	.level {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.bar {
		position: relative;
		flex: 0 0 8rem;
		height: 0.7rem;
		border-radius: 999px;
		background: var(--surface-sunken);
		border: 1px solid var(--border-strong);
		overflow: hidden;
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--accent);
	}
	.fill.low {
		background: var(--warning);
	}
	.fill.at-min {
		background: var(--danger);
	}
	.min {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--text);
	}
	.v {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.band.low {
		color: var(--warning);
	}
	.band.at-min {
		color: var(--danger);
	}
	.more {
		margin-top: 0.5rem;
	}
	.small {
		font-size: 0.85rem;
	}
	@media (max-width: 640px) {
		.bar {
			flex-basis: 4.5rem;
		}
		.v {
			white-space: normal;
		}
	}
</style>
