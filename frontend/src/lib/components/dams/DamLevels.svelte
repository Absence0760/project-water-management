<script lang="ts">
	// Dams → Dam levels: each dam's storage at the end of the latest run and
	// at its lowest in the run's last year (overview/damLevels.ts), emptiest
	// first. DamsTab loads the levels (its cards and chart use them too) and
	// shows this table under its first screen. It was on the Summary until the
	// Dams page existed (issue #17); the Summary now links here.
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtDay, fmtNum } from '$lib/format/number';
	import { runHref } from '$lib/components/overview/attention';
	import { levelBand, LOW_PCT, type DamLevel } from '$lib/components/overview/damLevels';

	let {
		runId,
		levels,
		total,
		done,
		loading,
		error,
		retry
	}: {
		runId: string;
		/** Emptiest first (loadDamLevels). */
		levels: DamLevel[];
		/** Dams in the run, and how many are fetched so far. */
		total: number;
		done: number;
		loading: boolean;
		error: string | null;
		retry: () => void;
	} = $props();

	/** Rows shown before "Show all". */
	const FIRST = 8;
	let showAll = $state(false);

	const shown = $derived(showAll ? levels : levels.slice(0, FIRST));
	const pct = (v: number) => `${fmtNum(v, 0)}%`;
	const BAND_WORDS = { 'at-min': 'at its minimum level', low: `below ${LOW_PCT}%`, ok: '' } as const;
</script>

{#if total}
	<section class="panel dams" aria-labelledby="dams-h" aria-busy={loading}>
		<div class="panel-head">
			<h2 id="dams-h">Dam levels</h2>
			<a href={runHref(runId)}>Open in Runs</a>
		</div>
		{#if loading}
			<p class="muted" role="status">Loading dam levels ({done} of {total})…</p>
		{:else}
		<LoadState loading={false} {error} {retry}>
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
						{showAll ? `Show the ${FIRST} emptiest rows` : `Show all ${levels.length} rows`}
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
	/* The page is the one scroll: the table grows with its rows (at most 8 until "Show all") instead of
	   scrolling inside the global 70vh cap; it still scrolls sideways on a narrow screen. */
	.table-wrap {
		max-height: none;
	}
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
