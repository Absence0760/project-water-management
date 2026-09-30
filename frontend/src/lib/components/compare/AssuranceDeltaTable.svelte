<script lang="ts">
	// Assurance of supply in both runs (WP-3.4, issue #70; compare/assurance.ts):
	// per farm and other water user, run B's value and the change from run A.
	// The Runs tab's Assurance panel has the definitions and the stress grids.
	import type { SupplyAssurance } from '@water-management/engine';
	import { fmtPct } from '$lib/format/number';
	import Delta from './Delta.svelte';
	import { compareAssurance } from './assurance';
	import type { MetricSpec } from './delta';

	let { a, b }: { a: SupplyAssurance | undefined; b: SupplyAssurance | undefined } = $props();
	const c = $derived(compareAssurance(a, b));
	const share: MetricSpec = { format: 'fraction', better: 'higher', digits: 0 };
	const days: MetricSpec = { format: 'count', better: 'lower' };
	const cols = [
		{ key: 'time', label: 'Demand days fully met', spec: share },
		{ key: 'volumetric', label: 'Volume supplied', spec: share },
		{ key: 'annual', label: 'Water years met', spec: share },
		{ key: 'longestFailureDays', label: 'Longest run not fully met (days)', spec: days }
	] as const;
	const fmt = (v: number | null, spec: MetricSpec) => (v === null ? '–' : spec.format === 'fraction' ? fmtPct(v, 0) : String(v));
</script>

{#if !c}
	<p class="muted">Neither run has an assurance of supply (runs from engine 0.32.0 on, with a farm or other water user).</p>
{:else}
	{#if c.missing}
		<p class="note small" role="note">
			Run {c.missing.toUpperCase()} was made before the engine reported assurance of supply; rerun it to compare this.
		</p>
	{:else}
		<p class="muted small">
			Over each run’s reporting window. Each cell shows run B’s value and, below it, the change from run A. Water years met counts the
			complete water years whose supply reached the annual threshold ({fmtPct(b!.annualThreshold, 0)} of demand).
		</p>
		{#if c.thresholds}
			<p class="note small" role="note" data-testid="assurance-threshold-note">
				The runs used different annual thresholds (A {fmtPct(c.thresholds.a, 0)}, B {fmtPct(c.thresholds.b, 0)}), so water years met counts against different bars.
			</p>
		{/if}
		{#if c.windows}
			<p class="note small" role="note">The runs cover different reporting windows (A {c.windows.a}, B {c.windows.b}).</p>
		{/if}
		{#if c.rows.length}
			<div class="table-wrap">
				<table class="data">
					<caption class="visually-hidden">Assurance of supply per hydrological unit and water user, run B with the change from run A</caption>
					<thead>
						<tr>
							<th scope="col">Hydrological unit or water user</th>
							{#each cols as col (col.key)}<th scope="col" class="num">{col.label}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each c.rows as r, i (`${r.name}-${i}`)}
							<tr>
								<th scope="row">{r.name}{#if r.kind === 'user'}<span class="muted small"> (water user)</span>{/if}</th>
								{#each cols as col (col.key)}
									<td class="num">
										<span class="val">{fmt(r[col.key].b, col.spec)}{#if col.key === 'annual'}<span class="muted small"> ({r.yearsB})</span>{/if}</span>
										<Delta m={r[col.key]} spec={col.spec} />
										{#if col.key === 'annual'}<span class="val muted small">A: {r.yearsA}</span>{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if c.onlyInA.length || c.onlyInB.length}
			<p class="muted small">
				{#if c.onlyInA.length}Only in run A: {c.onlyInA.join(', ')}.{/if}
				{#if c.onlyInB.length}Only in run B: {c.onlyInB.join(', ')}.{/if}
			</p>
		{/if}
	{/if}
{/if}

<style>
	td.num {
		line-height: 1.25;
	}
	td .val {
		display: block;
	}
	td :global(.delta) {
		font-size: 0.8rem;
	}
</style>
