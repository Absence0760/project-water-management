<script lang="ts">
	// A farm dam's survey curve and release rule (WP-3.5, docs/model.md §2.7a),
	// in the one-node form: the curve is pasted as level, area, volume rows and
	// drawn as a small area–volume chart; the release rule and its monthly
	// amounts sit below it. The outlet capacity and seepage share are ordinary
	// number fields in the Farm dam group (./fields.ts).
	import { DAM_RELEASE_RULES, type DamReleaseRule, type NetworkNode } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtNum } from '$lib/format/number';
	import { curveNotes, curveText, parseDamCurve } from './damCurve';

	let { node, readonly }: { node: NetworkNode; readonly: boolean } = $props();

	const id = (k: string) => `dam-${k}-${node.id}`;
	const label = $derived(node.name || 'this hydrological unit');
	const RULE_LABEL: Record<DamReleaseRule, string> = {
		none: 'None: the dam releases nothing',
		passInflow: 'Pass inflow: up to what the river below still needs',
		fixed: 'Fixed: a set release each month'
	};

	const rows = $derived([...(node.damCurve ?? [])].sort((a, b) => a.volumeM3 - b.volumeM3));
	const check = $derived(curveNotes(node.damCurve, node.damCapacityM3));
	let pasted = $state('');
	let pasteError = $state<string | null>(null);
	let editing = $state(false);

	function startEdit() {
		pasted = curveText(node.damCurve);
		pasteError = null;
		editing = true;
	}
	function applyPaste() {
		const p = parseDamCurve(pasted);
		pasteError = p.error;
		if (p.error) return;
		node.damCurve = p.rows;
		editing = false;
	}
	function removeCurve() {
		node.damCurve = null;
		editing = false;
	}

	// The chart: area against volume, 0 to the largest of each.
	const W = 280;
	const H = 150;
	const PAD = { l: 44, r: 8, t: 8, b: 30 };
	const maxV = $derived(Math.max(1, ...rows.map((r) => r.volumeM3), node.damCapacityM3));
	const maxA = $derived(Math.max(1, ...rows.map((r) => r.areaM2)));
	const x = (v: number) => PAD.l + (v / maxV) * (W - PAD.l - PAD.r);
	const y = (a: number) => H - PAD.b - (a / maxA) * (H - PAD.t - PAD.b);
	const path = $derived((rows[0] && rows[0].volumeM3 > 0 ? [{ volumeM3: 0, areaM2: 0 }, ...rows] : rows).map((r) => `${x(r.volumeM3).toFixed(1)},${y(r.areaM2).toFixed(1)}`).join(' '));
	const chartLabel = $derived(
		rows.length
			? `Area against volume for ${label}: from ${fmtNum(rows[0]!.areaM2)} m² at ${fmtNum(rows[0]!.volumeM3)} m³ to ${fmtNum(rows.at(-1)!.areaM2)} m² at ${fmtNum(rows.at(-1)!.volumeM3)} m³`
			: ''
	);

	const rule = $derived(node.damReleaseRule ?? 'none');
	const release = $derived(node.damReleaseM3Day ?? new Array<number>(12).fill(0));
	const useEwr = $derived(rule === 'passInflow' && (node.damReleaseM3Day === null || node.damReleaseM3Day === undefined));

	function setRule(r: DamReleaseRule) {
		node.damReleaseRule = r;
		// A fixed release needs its amounts; pass inflow starts from the EWR.
		if (r === 'fixed' && !node.damReleaseM3Day) node.damReleaseM3Day = new Array(12).fill(0);
	}
	function setMonth(i: number, v: number | null) {
		const next = [...release];
		next[i] = v ?? 0;
		node.damReleaseM3Day = next;
	}
	function fillAll() {
		node.damReleaseM3Day = new Array(12).fill(release[0] ?? 0);
	}
</script>

<div class="dam" data-testid="dam-storage-{node.id}">
	<h3 class="sub">Survey curve <HelpTip key="node.damCurve" /></h3>
	{#if check.error}<p class="hint err" role="alert">{check.error}</p>{/if}
	{#each check.notes as n (n)}<p class="hint" role="note">{n}</p>{/each}
	{#if rows.length}
		<div class="curve">
			<table class="data compact rows">
				<caption class="visually-hidden">Survey rows of {label}</caption>
				<thead><tr><th scope="col" class="num">Level (m)</th><th scope="col" class="num">Area (m²)</th><th scope="col" class="num">Volume (m³)</th></tr></thead>
				<tbody>
					{#each rows as r, i (i)}
						<tr><td class="num">{fmtNum(r.levelM, 2, true)}</td><td class="num">{fmtNum(r.areaM2)}</td><td class="num">{fmtNum(r.volumeM3)}</td></tr>
					{/each}
				</tbody>
			</table>
			<svg viewBox="0 0 {W} {H}" width={W} height={H} role="img" aria-label={chartLabel} data-testid="dam-curve-chart">
				<line class="axis" x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} />
				<line class="axis" x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} />
				{#if node.damCapacityM3 > 0}
					<line class="cap" x1={x(node.damCapacityM3)} y1={PAD.t} x2={x(node.damCapacityM3)} y2={H - PAD.b} />
				{/if}
				<polyline class="line" points={path} />
				{#each rows as r, i (i)}<circle class="pt" cx={x(r.volumeM3)} cy={y(r.areaM2)} r="2.5" />{/each}
				<text class="tick" x={PAD.l - 4} y={PAD.t + 8} text-anchor="end">{fmtNum(maxA)}</text>
				<text class="tick" x={PAD.l - 4} y={H - PAD.b} text-anchor="end">0</text>
				<text class="tick" x={W - PAD.r} y={H - PAD.b + 12} text-anchor="end">{fmtNum(maxV)}</text>
				<text class="axis-label" x={(W + PAD.l) / 2} y={H - 4} text-anchor="middle">Volume (m³){node.damCapacityM3 > 0 ? ', dashed = capacity' : ''}</text>
				<text class="axis-label" x="10" y={(H - PAD.b) / 2} text-anchor="middle" transform="rotate(-90 10 {(H - PAD.b) / 2})">Area (m²)</text>
			</svg>
		</div>
	{/if}
	{#if !readonly}
		{#if editing}
			<div class="field">
				<label for={id('paste')}>Level (m), area (m²), volume (m³): one row per line</label>
				<textarea
					id={id('paste')}
					rows="6"
					bind:value={pasted}
					aria-describedby="{id('paste')}-h"
					aria-invalid={pasteError ? 'true' : undefined}
					placeholder={'100, 0, 0\n101, 8000, 4000\n102, 14000, 15000'}
				></textarea>
				<span class="hint" id="{id('paste')}-h">Paste from a spreadsheet or the DW789 form: commas, semicolons, tabs or spaces between values; a header line is skipped. No thousands separators.</span>
				{#if pasteError}<p class="hint err" role="alert">{pasteError}</p>{/if}
			</div>
			<div class="actions">
				<button type="button" class="btn btn-sm" onclick={applyPaste}>Use these rows</button>
				<button type="button" class="btn btn-sm" onclick={() => (editing = false)}>Cancel</button>
			</div>
		{:else}
			<div class="actions">
				<button type="button" class="btn btn-sm" onclick={startEdit}>{rows.length ? 'Edit the survey rows' : 'Paste survey rows'}</button>
				{#if rows.length}<button type="button" class="btn btn-sm" onclick={removeCurve}>Remove the curve</button>{/if}
			</div>
		{/if}
	{/if}

	<h3 class="sub">Releases <HelpTip key="node.damReleaseRule" /></h3>
	<div class="field">
		<label for={id('rule')}>Release rule</label>
		<select id={id('rule')} disabled={readonly} value={rule} onchange={(e) => setRule(e.currentTarget.value as DamReleaseRule)}>
			{#each DAM_RELEASE_RULES as r (r)}<option value={r}>{RULE_LABEL[r]}</option>{/each}
		</select>
		<span class="hint">
			{#if rule === 'passInflow'}
				Before irrigation the dam passes its inflow below the wall, up to what the river there still needs, capped by the outlet.
			{:else if rule === 'fixed'}
				Before irrigation the dam releases the amounts below from the water above its minimum operating level, capped by the outlet.
			{:else}
				A compensation or low-flow release is a common licence condition; pick a rule to model one.
			{/if}
		</span>
	</div>
	{#if rule === 'passInflow'}
		<label class="check">
			<input
				type="checkbox"
				disabled={readonly}
				checked={useEwr}
				onchange={(e) => (node.damReleaseM3Day = e.currentTarget.checked ? null : new Array(12).fill(0))}
			/>
			Pass up to the EWR required here (this hydrological unit's share and upstream shares)
		</label>
	{/if}
	{#if rule === 'fixed' || (rule === 'passInflow' && !useEwr)}
		<table class="data compact months">
			<caption>
				{rule === 'fixed' ? 'Release' : 'Flow to keep below the dam'}, m³/day, per month <HelpTip key="node.damReleaseM3Day" />
			</caption>
			<thead>
				<tr>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}</tr>
			</thead>
			<tbody>
				<tr>
					{#each WATER_YEAR_MONTHS as m, i (m)}
						<td>
							<NumberInput label="Dam release of {label} in {m}, m³/day" min={0} grouped={readonly} disabled={readonly} value={release[i] ?? 0} onchange={(v) => setMonth(i, v)} />
						</td>
					{/each}
				</tr>
			</tbody>
		</table>
		{#if !readonly}
			<button type="button" class="btn btn-sm" onclick={fillAll}>Use October’s amount for every month</button>
		{/if}
	{/if}
</div>

<style>
	.sub {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 0.5rem 0 0.25rem;
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.curve {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		align-items: flex-start;
		margin: 0.25rem 0 0.5rem;
	}
	.rows td,
	.months td :global(input) {
		font-variant-numeric: tabular-nums;
	}
	svg {
		max-width: 100%;
		height: auto;
	}
	.axis {
		stroke: var(--chart-axis);
	}
	.cap {
		stroke: var(--text-muted);
		stroke-dasharray: 3 3;
	}
	.line {
		fill: none;
		stroke: var(--series-1);
		stroke-width: 2;
	}
	.pt {
		fill: var(--series-1);
	}
	.tick,
	.axis-label {
		fill: var(--text-muted);
		font-size: 10px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.5rem;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.field select,
	textarea {
		width: 100%;
		max-width: 32rem;
		font-variant-numeric: tabular-nums;
	}
	textarea {
		font-family: var(--font-mono);
	}
	.err {
		color: var(--danger);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		margin-bottom: 0.5rem;
	}
	.months {
		display: block;
		overflow-x: auto;
		margin: 0.5rem 0;
	}
	.months caption {
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-2);
		padding-bottom: 0.25rem;
	}
	.months td {
		min-width: 76px;
	}
	.months td :global(input) {
		width: 100%;
		text-align: right;
	}
	@media (max-width: 640px) {
		.field select,
		.actions .btn {
			min-height: 44px;
		}
	}
</style>
