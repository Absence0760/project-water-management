<script lang="ts">
	// A river off-take sized by a diversion curve (engine ≥ 1.113.0, docs/model.md
	// §2.6a): the share of the river diverted, a × x^b percent, x the river's flow
	// at the off-take in the unit picked, at most the largest share and the
	// rule's rate (the canal). Its five fields, then what it diverts at a few
	// example flows and which limit binds (diversionPreview.ts), since the unit of
	// x changes the answer completely. Shown on a river off-take's card in the
	// Transfers tab when Takes is "A share of the river's flow".
	import { DIVERSION_FLOW_UNITS, type DiversionFlowBasis, type DiversionFlowUnit, type Transfer } from '@water-management/engine';
	import NumberInput from '#lib/components/common/NumberInput.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fmtPct, fmtQty } from '#lib/format/number.js';
	import { diversionPreview, LIMIT_TEXT, UNIT_TEXT } from './diversionPreview';

	let { rule, label, disabled = false }: { rule: Transfer; /** "transfer 1": names the fields. */ label: string; disabled?: boolean } = $props();

	const preview = $derived(diversionPreview(rule));
	const unit = $derived(preview ? UNIT_TEXT[preview.unit] : '');
	// Decimals for a flow in the curve's unit: m³/s wants three, the others none above 10.
	const flow = (v: number) => fmtQty(v, preview?.unit === 'm3/s' ? 3 : v >= 10 ? 0 : 2, true);
</script>

<fieldset class="curve" data-testid="diversion-curve">
	<legend class="curve-t">Share of the river diverted: a × x<sup>b</sup> %</legend>
	<p class="small muted hint">x is the river’s flow at the off-take, in the unit you pick; at most the largest share, and the rule’s rate (the canal).</p>
	<div class="curve-fields">
		<div class="fld">
			<span class="fld-l"><span aria-hidden="true">Coefficient a</span> <HelpTip key="transfer.diversionCoefficient" /></span>
			<NumberInput label="Coefficient a of {label}" min={0} nullable placeholder="a" {disabled} value={rule.diversionCoefficient ?? null} onchange={(v) => (rule.diversionCoefficient = v)} />
		</div>
		<div class="fld">
			<span class="fld-l"><span aria-hidden="true">Exponent b</span> <HelpTip key="transfer.diversionExponent" /></span>
			<NumberInput label="Exponent b of {label}" nullable placeholder="b" {disabled} value={rule.diversionExponent ?? null} onchange={(v) => (rule.diversionExponent = v)} />
		</div>
		<div class="fld">
			<span class="fld-l"><span aria-hidden="true">Largest share, %</span> <HelpTip key="transfer.diversionMaxPct" /></span>
			<NumberInput label="Largest share of {label}, %" min={0} max={100} scale={100} nullable placeholder="100" {disabled} value={rule.diversionMaxPct ?? null} onchange={(v) => (rule.diversionMaxPct = v)} />
		</div>
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

	{#if preview}
		<!-- Four short columns: they fit a phone's card as a table (the headings wrap), so no stacking. -->
		<div class="preview">
			<table class="data" data-testid="diversion-preview">
				<caption>
					What it diverts at a few river flows{rule.diversionFlowBasis === 'natural' ? ', with x the river itself (the natural flow is at least this)' : ''}; the canal takes
					{preview.canalM3Day > 0 ? `up to ${flow(preview.canal)} ${unit}` : 'nothing (no rate in any month)'}
				</caption>
				<thead>
					<tr><th scope="col">River, {unit}</th><th scope="col">Share</th><th scope="col">Diverted, {unit}</th><th scope="col">Limited by</th></tr>
				</thead>
				<tbody>
					{#each preview.rows as r (r.flowM3Day)}
						<tr data-limit={r.limit}>
							<th scope="row">{flow(r.flow)}</th>
							<td>{fmtPct(r.share, r.share < 0.1 ? 1 : 0)}</td>
							<td>{flow(r.diverted)}</td>
							<td>{LIMIT_TEXT[r.limit]}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="small muted" data-testid="diversion-preview-empty">Enter a, b and the unit of x to see what it diverts at a few river flows.</p>
	{/if}
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
	.fld :global(input),
	.fld select {
		width: 100%;
		min-width: 0;
	}
	.preview {
		margin-top: 0.6rem;
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
