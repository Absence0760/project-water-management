<script lang="ts">
	// A river off-take taking by a formula (engine ≥ 1.113.0; a formula per month,
	// 1.114.0, docs/model.md §2.6a): the share of the river diverted is a × x^b
	// percent, x the river's flow at the off-take in the unit picked here (one for
	// every month), at most the month's largest share and its rate (the canal).
	// Each month's a, b and largest share are in the month table (TakesByMonth);
	// here: the unit and which flow x is, then what each formula diverts at a few
	// example flows, which limit binds, and, split between destinations (engine ≥
	// 1.114.0), what each destination gets after the losses (diversionPreview.ts),
	// since the unit of x changes the answer completely. Shown on a river
	// off-take's card in the Transfers tab when Takes is "By month: a maximum or a
	// formula".
	import { DIVERSION_FLOW_UNITS, isSplitTransfer, transferDestinations, type DiversionFlowBasis, type DiversionFlowUnit, type Transfer } from '@water-management/engine';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { fmtPct, fmtQty } from '#lib/format/number.js';
	import { diversionPreviews, LIMIT_TEXT, UNIT_TEXT } from './diversionPreview';

	let {
		rule,
		label,
		disabled = false,
		name = (id: string | null) => id ?? 'Outside the catchment'
	}: { rule: Transfer; /** "transfer 1": names the fields. */ label: string; disabled?: boolean; /** A destination's name. */ name?: (id: string | null) => string } = $props();

	const previews = $derived(diversionPreviews(rule));
	const ends = $derived(isSplitTransfer(rule) ? transferDestinations(rule) : []);
	// Decimals for a flow in the curve's unit: m³/s wants three, the others none above 10.
	const flow = (v: number, unit: DiversionFlowUnit) => fmtQty(v, unit === 'm3/s' ? 3 : v >= 10 ? 0 : 2, true);
	/** The months a formula runs in, in words: "every month", "Oct–Mar", "Oct, Dec". */
	function monthsText(ks: number[]): string {
		if (ks.length === 12) return 'every month';
		const runs: string[] = [];
		for (let i = 0; i < ks.length; ) {
			let j = i;
			while (j + 1 < ks.length && ks[j + 1] === ks[j]! + 1) j++;
			runs.push(j > i ? `${WATER_YEAR_MONTHS[ks[i]!]}–${WATER_YEAR_MONTHS[ks[j]!]}` : WATER_YEAR_MONTHS[ks[i]!]!);
			i = j + 1;
		}
		return runs.join(', ');
	}
</script>

<fieldset class="curve" data-testid="diversion-curve">
	<legend class="curve-t">The formula: a × x<sup>b</sup> % of the river</legend>
	<p class="small muted hint">x is the river’s flow at the off-take, in the unit you pick; at most the month’s largest share, and its rate (the canal). Each month’s a and b are in the table above.</p>
	<div class="curve-fields">
		<div class="fld">
			<span class="fld-l"><span aria-hidden="true">x in</span> <HelpTip key="transfer.diversionFlowUnit" /></span>
			<select aria-label="x in, flow unit of {label}" {disabled} value={rule.diversionFlowUnit ?? ''} onchange={(e) => (rule.diversionFlowUnit = (e.currentTarget.value || null) as DiversionFlowUnit | null)}>
				{#if !rule.diversionFlowUnit}<option value="">— choose —</option>{/if}
				{#each DIVERSION_FLOW_UNITS as u (u)}<option value={u}>{UNIT_TEXT[u]}</option>{/each}
			</select>
		</div>
		<div class="fld">
			<span class="fld-l"><span aria-hidden="true">x is</span> <HelpTip key="transfer.diversionFlowBasis" /></span>
			<select aria-label="x is, the flow the curve of {label} reads" {disabled} value={rule.diversionFlowBasis ?? 'modelled'} onchange={(e) => (rule.diversionFlowBasis = e.currentTarget.value as DiversionFlowBasis)}>
				<option value="modelled">The river at the off-take</option>
				<option value="natural">The natural flow there</option>
			</select>
		</div>
	</div>

	{#each previews as p, i (i)}
		{@const unit = UNIT_TEXT[p.unit]}
		<!-- Short columns: they fit a phone's card as a table (the headings wrap), so no stacking. -->
		<!-- The table can be wider than a phone's card: the wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="preview table-wrap" tabindex="0" role="region" aria-label="What {label}’s formula diverts at a few river flows{previews.length > 1 ? `, ${monthsText(p.months)}` : ''}">
			<table class="data" data-testid="diversion-preview">
				<caption>
					What it diverts at a few river flows{previews.length > 1 || p.months.length < 12 ? ` (${monthsText(p.months)})` : ''}{rule.diversionFlowBasis === 'natural' ? ', with x the river itself (the natural flow is at least this)' : ''}; the canal takes
					{p.canalM3Day > 0 ? `up to ${flow(p.canal, p.unit)} ${unit}` : 'nothing (no rate in these months)'}{ends.length ? `, then ${(rule.lossPct ?? 0) > 0 ? 'after its losses ' : ''}split between its destinations` : ''}
				</caption>
				<thead>
					<tr>
						<th scope="col">River, {unit}</th>
						<th scope="col">Share</th>
						<th scope="col">Diverted, {unit}</th>
						{#each ends as d, k (k)}<th scope="col">To {name(d.nodeId)} ({fmtPct(d.pct, 0)}), {unit}</th>{/each}
						<th scope="col">Limited by</th>
					</tr>
				</thead>
				<tbody>
					{#each p.rows as r (r.flowM3Day)}
						<tr data-limit={r.limit}>
							<th scope="row">{flow(r.flow, p.unit)}</th>
							<td>{fmtPct(r.share, r.share < 0.1 ? 1 : 0)}</td>
							<td>{flow(r.diverted, p.unit)}</td>
							{#each ends as _, k (k)}<td>{flow(r.delivered[k]!, p.unit)}</td>{/each}
							<td>{LIMIT_TEXT[r.limit]}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="small muted" data-testid="diversion-preview-empty">Pick the unit of x and give a month a formula (its a and b) to see what it diverts at a few river flows.</p>
	{/each}
</fieldset>

<style>
	.curve {
		grid-column: 1 / -1;
		margin: 0;
		padding: 0.5rem 0 0;
		border: 0;
		border-top: 1px solid var(--border);
		min-width: 0;
	}
	.curve-t {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0;
		font-size: var(--font-sm);
		font-weight: 600;
	}
	.hint {
		margin: 0.15rem 0 0.4rem;
	}
	.curve-fields {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: 0.5rem 0.75rem;
		align-items: start;
	}
	.fld {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}
	.fld-l {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 24px;
		font-size: var(--font-sm);
		color: var(--text-2);
		white-space: nowrap;
	}
	.fld select {
		width: 100%;
		min-width: 0;
	}
	.preview {
		margin-top: 0.6rem;
		overflow-x: auto;
	}
	.preview:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.preview table {
		width: 100%;
	}
	.preview thead th {
		white-space: normal;
		vertical-align: bottom;
	}
	.preview caption {
		caption-side: top;
		text-align: left;
		font-size: var(--font-sm);
		color: var(--text-2);
		padding-bottom: 0.3rem;
	}
	.preview th[scope='row'],
	.preview td:not(:last-child) {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.preview tr[data-limit='canal'] td:last-child,
	.preview tr[data-limit='largest'] td:last-child {
		font-weight: 600;
	}
</style>
