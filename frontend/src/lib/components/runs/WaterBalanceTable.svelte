<!--
	The water balance of a run per water year (engine ≥ 0.12.0): the table a
	hydrologist hands a client first. Its own section in Model quality on Runs &
	results (issue #137), and inside the self-checks in the printable report
	(docs/ui.md § Self-checks). River & reserve's Water account is the
	catchment's balance for the same years; each links to the other rather than
	copying it (accountHref).
-->
<script lang="ts">
	import type { RunSummary } from '@water-management/engine';
	import { fmtNum, fmtQty } from '$lib/format/number';
	import { balanceColumns, balanceEquation, balanceTableRows, residualIsNoise, waterYearLabel } from './checks';

	let {
		summary,
		accountHref
	}: {
		summary: Pick<RunSummary, 'waterBalance'>;
		/** River & reserve's Water account for the same run (the workspace); none in the printable report. */
		accountHref?: string;
	} = $props();

	const uid = $props.id();
	const balance = $derived(balanceTableRows(summary.waterBalance));
	const hasStores = $derived(balance.some((r) => r.runoff !== null));
	const cols = $derived(balanceColumns(balance));

	/** Enough digits to see float noise without drowning the volumes. */
	const fmtValue = (x: number | null) => (x === null ? '–' : Math.abs(x) > 0 && Math.abs(x) < 1e-3 ? x.toExponential(2) : fmtNum(x, 3, true));
</script>

<section aria-labelledby="{uid}-wb">
	<h3 id="{uid}-wb">Water balance by water year</h3>
	{#if balance.length === 0}
		<p class="muted">This run was made before the water balance was recorded (engine 0.12.0). Run the model again to see it.</p>
	{:else}
		<p class="muted small">
			{balanceEquation(cols)}. Volumes in Mm³; the residual, in m³, should be 0.
			{#if summary.waterBalance?.areaKm2}Depths over {fmtNum(summary.waterBalance.areaKm2, 2)} km².{/if}
		</p>
		{#if accountHref}
			<p class="muted small" data-testid="balance-account-link">
				The catchment’s own account, from natural flow before land cover and flow shares, in m³ with a chart of in and out:
				<a href={accountHref}>Water account</a> on River &amp; reserve.
			</p>
		{/if}
		<div class="table-wrap">
			<table class="data compact">
				<thead>
					<tr>
						<th scope="col">Water year</th>
						{#each cols as col (col.key)}<th scope="col" class="num" title={col.title}>{col.label}</th>{/each}
						{#if hasStores}<th scope="col" class="num" title="Runoff model: rain − evaporation − flow + exchange − change in storage">Runoff-model residual (mm)</th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each balance as r (r.waterYear ?? 'total')}
						<tr class:total={r.waterYear === null}>
							<th scope="row">{waterYearLabel(r.waterYear)}</th>
							{#each cols as col (col.key)}
								{@const x = col.value(r)}
								<td class="num" class:off={col.key === 'residual' && !residualIsNoise(r)}>
									{col.key === 'residual' ? fmtValue(x) : col.key === 'rain' ? fmtNum(x, 0) : fmtQty(x, 3, true)}
								</td>
							{/each}
							{#if hasStores}<td class="num">{fmtValue(r.runoff?.residualMm ?? null)}</td>{/if}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	tr.total th,
	tr.total td {
		font-weight: 600;
		border-top: 2px solid var(--border);
	}
	td.off {
		color: var(--danger);
		font-weight: 600;
	}
</style>
