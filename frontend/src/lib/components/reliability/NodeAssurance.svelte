<!--
	One farm's (or other water user's) assurance of supply, where you look at
	that node (issue #444): the unit's detail on Hydrological units, and the
	picked dam on the Dams page (a dam has no assurance of its own: it is the
	unit's supply, which the dam serves). Its reliability over the reporting
	window in one line, then a strip of stress classes by calendar month (each
	month's supplied ÷ demand, the window's years pooled) in the
	AssurancePanel's ramp and words, and how many months of the whole run fell
	in each class. The year-by-month grid stays in AssurancePanel. The class
	name is in every cell, so colour is never the only cue.
-->
<script lang="ts">
	import { STRESS_LABEL, type SupplyAssurance } from '@water-management/engine';
	import type { Snippet } from 'svelte';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { fmtNum } from '$lib/format/number';
	import { classCounts, nodeAssurance, notComputedText, pctText, reliabilityLine, STRESS_BIN, STRESS_ORDER, STRESS_SHORT, stressLegend } from './reliability';

	let {
		assurance,
		nodeId,
		engineVersion = null,
		heading = 'Assurance of supply',
		lead,
		more
	}: {
		assurance: SupplyAssurance | undefined | null;
		nodeId: string;
		/** The run's engine version, for the "not computed" note on older runs. */
		engineVersion?: string | null;
		heading?: string;
		/** A line under the heading: what the figures are about (the Dams page says they are the unit's). */
		lead?: Snippet;
		/** A line at the foot: where to see more. */
		more?: Snippet;
	} = $props();

	const uid = $props.id();
	const node = $derived(assurance ? nodeAssurance(assurance, nodeId) : null);
	const legend = $derived(assurance ? stressLegend(assurance.stress) : []);
	const counts = $derived(node?.grid ? classCounts(node.grid) : null);
	const countText = $derived(
		counts
			? STRESS_ORDER.filter((c) => counts[c] > 0)
					.map((c) => `${fmtNum(counts[c])} ${STRESS_LABEL[c]}`)
					.join(', ')
			: ''
	);
	const describe = (m: number) => {
		const cell = node?.months[m];
		if (!cell?.cls) return `${WATER_YEAR_MONTHS[m]}: no demand`;
		return `${WATER_YEAR_MONTHS[m]}: ${STRESS_LABEL[cell.cls]} stress, ${pctText(cell.ratio, 1)} of demand supplied`;
	};
</script>

<section class="node-assurance" aria-labelledby="{uid}-h" data-testid="node-assurance">
	<h3 id="{uid}-h">{heading}</h3>
	{#if lead}<p class="muted small lead">{@render lead()}</p>{/if}
	{#if !assurance}
		<p class="muted small" data-testid="node-assurance-not-computed">{notComputedText(engineVersion)}</p>
	{:else if !node}
		<p class="muted small">Not in this run's assurance of supply: it had no demand in the run, or was added since.</p>
	{:else}
		<p class="small facts" data-testid="node-reliability">
			{reliabilityLine(node.reliability)}
			<span class="muted">({assurance.reportStart} to {assurance.reportEnd})</span>
		</p>
		<!-- Twelve cells, each with its month and class in words; six to a row in a narrow column, so nothing scrolls or clips. -->
		<ol class="strip" aria-label="Stress class by calendar month, the reporting window's years pooled" data-testid="node-stress-strip">
			{#each node.months as cell, m (m)}
				<li class={cell.cls ? `b${STRESS_BIN[cell.cls]}` : 'none'} title={describe(m)}>
					<span class="mo" aria-hidden="true">{WATER_YEAR_MONTHS[m]}</span><span class="cls" aria-hidden="true">{cell.cls ? STRESS_SHORT[cell.cls] : '–'}</span><span class="visually-hidden">{describe(m)}</span>
				</li>
			{/each}
		</ol>
		<ul class="legend" aria-label="Stress classes">
			{#each legend as k (k.cls)}
				<li><span class="swatch b{STRESS_BIN[k.cls]}" aria-hidden="true"></span><strong>{STRESS_SHORT[k.cls]}</strong>&nbsp;{k.range}</li>
			{/each}
			<li><span class="swatch none" aria-hidden="true"></span>No demand</li>
		</ul>
		<p class="muted small note">
			Each month's supplied ÷ demand over the reporting window, its years pooled.{#if counts}{' '}Over the whole run: {countText || 'no month with demand'}.{/if}
		</p>
	{/if}
	{#if more}<p class="small more">{@render more()}</p>{/if}
</section>

<style>
	/* AssurancePanel's ramp (and the EwrHeatmap's): light = Low stress, dark = Critical. */
	.node-assurance {
		--heat-0: var(--surface);
		--heat-1: #86b6ef;
		--heat-2: #3987e5;
		--heat-3: #1c5cab;
		--heat-4: #0d366b;
		--heat-ink-1: #161816;
		--heat-ink-2: #161816;
		--heat-ink-3: #ffffff;
		--heat-ink-4: #ffffff;
		margin-top: 0.75rem;
		container: node-assurance / inline-size;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .node-assurance {
			--heat-1: #184f95;
			--heat-2: #256abf;
			--heat-3: #3987e5;
			--heat-4: #86b6ef;
			--heat-ink-1: #ffffff;
			--heat-ink-2: #ffffff;
			--heat-ink-3: #121312;
			--heat-ink-4: #121312;
		}
	}
	:global(:root[data-theme='dark']) .node-assurance {
		--heat-1: #184f95;
		--heat-2: #256abf;
		--heat-3: #3987e5;
		--heat-4: #86b6ef;
		--heat-ink-1: #ffffff;
		--heat-ink-2: #ffffff;
		--heat-ink-3: #121312;
		--heat-ink-4: #121312;
	}
	h3 {
		font-size: 0.95rem;
		margin: 0 0 0.25rem;
	}
	.small {
		font-size: 0.8rem;
	}
	.lead,
	.facts,
	.note,
	.more {
		margin: 0 0 0.3rem;
	}
	.facts {
		color: var(--text-2);
	}
	.strip {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 2px;
		padding: 0;
		margin: 0.2rem 0;
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}
	.strip li {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.1rem 0;
		border-radius: 3px;
		line-height: 1.2;
		min-width: 0;
	}
	.strip .mo {
		font-weight: 600;
	}
	@container node-assurance (max-width: 30rem) {
		.strip {
			grid-template-columns: repeat(6, minmax(0, 1fr));
		}
	}
	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.7rem;
		padding: 0;
		margin: 0.2rem 0 0.25rem;
		font-size: 0.72rem;
		color: var(--text-2);
	}
	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.swatch {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 2px;
		border: 1px solid var(--border);
	}
	.b0 {
		background: var(--heat-0);
		box-shadow: inset 0 0 0 1px var(--border);
	}
	.b1 {
		background: var(--heat-1);
		color: var(--heat-ink-1);
	}
	.b2 {
		background: var(--heat-2);
		color: var(--heat-ink-2);
	}
	.b3 {
		background: var(--heat-3);
		color: var(--heat-ink-3);
	}
	.b4 {
		background: var(--heat-4);
		color: var(--heat-ink-4);
	}
	.none {
		background: repeating-linear-gradient(45deg, transparent 0 3px, var(--border) 3px 4px);
	}
	@media (forced-colors: active) {
		.strip li {
			forced-color-adjust: none;
		}
	}
</style>
