<!--
	The water balance of a run per water year (engine ≥ 0.12.0): the table a
	hydrologist hands a client first. Its own section in Model quality on Runs &
	results (issue #137), and inside the self-checks in the printable report
	(docs/ui.md § Self-checks). The EWR page's Water account is the
	catchment's balance for the same years; each links to the other rather than
	copying it (accountHref).
-->
<script lang="ts">
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import type { RunSummary } from '@water-management/engine';
	import { fmtNum, fmtQty } from '#lib/format/number.js';
	import { balanceColumns, balanceEquation, fmtBalance, balanceTableRows, residualIsNoise, waterYearLabel } from './checks';

	let {
		summary,
		accountHref
	}: {
		summary: Pick<RunSummary, 'waterBalance'>;
		/** the EWR page's Water account for the same run (the workspace); none in the printable report. */
		accountHref?: string;
	} = $props();

	const uid = $props.id();
	const balance = $derived(balanceTableRows(summary.waterBalance));
	const hasStores = $derived(balance.some((r) => r.runoff !== null));
	const cols = $derived(balanceColumns(balance));
	// Two pairs share a column, one over the other (ui-playbook § 2, "Fit a wide table by stacking"): the
	// year's rain over its runoff coefficient, and the balance's residual over the runoff model's own.
	const coef = $derived(cols.find((c) => c.key === 'runoffCoef'));
	const shown = $derived(cols.filter((c) => c.key !== 'runoffCoef'));
	const RUNOFF_RESIDUAL_TITLE = 'the runoff model’s residual: rain − evaporation − flow + exchange − change in storage (mm)';

	/** Float noise as "< 0.001", not an exponent (checks.ts fmtBalance). */
	const fmtValue = fmtBalance;
</script>

<section aria-labelledby="{uid}-wb">
	<h3 id="{uid}-wb">Water balance by water year <HelpTip key="water-account" /></h3>
	{#if balance.length === 0}
		<p class="muted">This run was made before the water balance was recorded (engine 0.12.0). Run the model again to see it.</p>
	{:else}
		<p class="muted small">
			{balanceEquation(cols)}. Volumes in Mm³; the residual, in m³{#if hasStores}{' '}(the runoff model’s under it, in mm){/if}, should be 0.
			{#if summary.waterBalance?.areaKm2}Depths over {fmtNum(summary.waterBalance.areaKm2, 2)} km².{/if}
		</p>
		{#if accountHref}
			<p class="muted small" data-testid="balance-account-link">
				The catchment’s own account, from natural flow before land cover and flow shares, in m³ with a chart of in and out:
				<a href={accountHref}>Water account</a> on EWR.
			</p>
		{/if}
		<!-- Every water year shows: no inner scroll (the global 70vh cap), so a 15-year run reads down the page (#586 D1). -->
		<div class="table-wrap balance-wrap">
			<table class="data compact balance">
				<thead>
					<tr>
						<th scope="col">Water year</th>
						{#each shown as col (col.key)}
							{#if col.key === 'rain' && coef}
								<th scope="col" class="num" title="{col.title}; under it, {coef.title.toLowerCase()}">{col.label}{' '}<span class="under">{coef.label.toLowerCase()}</span></th>
							{:else if col.key === 'residual' && hasStores}
								<th scope="col" class="num" title="{col.title}; under it, {RUNOFF_RESIDUAL_TITLE}">{col.label}{' '}<span class="under">runoff model (mm)</span></th>
							{:else}
								<th scope="col" class="num" title={col.title}>{col.label}</th>
							{/if}
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each balance as r (r.waterYear ?? 'total')}
						<tr class:total={r.waterYear === null}>
							<th scope="row">{waterYearLabel(r.waterYear)}</th>
							{#each shown as col (col.key)}
								{@const x = col.value(r)}
								{#if col.key === 'rain'}
									<td class="num">{fmtNum(x, 0)}{#if coef}{' '}<span class="under">{fmtQty(coef.value(r), 3, true)}</span>{/if}</td>
								{:else if col.key === 'residual'}
									<td class="num"
										><span class:off={!residualIsNoise(r)}>{fmtValue(x)}</span>{#if hasStores}{' '}<span class="under">{fmtValue(r.runoff?.residualMm ?? null)}</span>{/if}</td
									>
								{:else}
									<td class="num">{fmtQty(x, 3, true)}</td>
								{/if}
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.balance-wrap {
		max-height: none;
	}
	/* Fit by wrapping the headings, not by scrolling sideways (ui-playbook § 2,
	   "Table headings wrap"): app.css keeps table headings on one line, and with
	   thirteen or more columns of two-word names the table ran 535 px past its
	   column at 1440. Each heading wraps at its spaces, bottom-aligned so the
	   last line sits on the rule; the year column and the figures never wrap. */
	.balance thead th {
		white-space: normal;
		vertical-align: bottom;
	}
	.balance tbody th {
		white-space: nowrap;
	}
	/* Eleven columns of figures: the narrower cell padding of a dense table. */
	.balance :is(th, td) {
		padding-inline: 0.35rem;
	}
	/* A run with the optional terms (groundwater, other users, losses: up to
	   twenty-one columns) can't fit any column; it scrolls inside its box, with
	   the water year held at the left edge so every row stays named. Only while it scrolls (`data-scrolls-x`,
	   lib/a11y/scrollRegions.ts), as app.css pins row names on a phone: a table that fits fixes nothing. */
	.balance-wrap:global([data-scrolls-x]) .balance :is(thead th:first-child, tbody th) {
		position: sticky;
		left: 0;
		z-index: 1;
		background: var(--surface);
	}
	.balance-wrap:global([data-scrolls-x]) .balance thead th:first-child {
		background: var(--surface-2);
	}
	tr.total th,
	tr.total td {
		font-weight: 600;
		border-top: 2px solid var(--border);
	}
	.off {
		color: var(--danger);
		font-weight: 600;
	}
	/* The second of a stacked pair: its own line, lighter, so the pair reads as two figures. */
	.under {
		display: block;
		font-weight: 400;
		color: var(--text-muted);
	}
</style>
