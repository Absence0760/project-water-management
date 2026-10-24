<!-- i18n-section: farm.compare -->
<script lang="ts">
	// "Compared with last season" (design §3 Q1, E4): the same dates a year
	// earlier, from the same published run.
	import type { FarmProjection } from '@water-management/engine';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { compareCard } from './cards';

	let { farm }: { farm: FarmProjection } = $props();
	const vm = $derived(compareCard(farm));
</script>

<section class="card" aria-labelledby="cmp-h">
	<h2 id="cmp-h">{t('Compared with last season')}</h2>
	{#if vm.available}
		<table>
			<thead>
				<tr><th scope="col" class="span">{vm.span}</th><th scope="col">{vm.now}</th><th scope="col">{vm.then}</th></tr>
			</thead>
			<tbody>
				{#each vm.rows as r (r.label)}
					<tr><th scope="row">{r.label}</th><td>{r.now}</td><td>{r.then}</td></tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p>{vm.text}</p>
	{/if}
</section>

<style>
	table {
		width: 100%;
		table-layout: fixed;
		border-collapse: collapse;
		font-size: 15px;
	}
	th,
	td {
		padding: 3px 0 3px 6px;
		text-align: right;
		vertical-align: top;
		overflow-wrap: anywhere;
		font-variant-numeric: tabular-nums;
	}
	/* Three equal columns wrapped "Water received" and "Dam on 31 Dec" onto two
	   lines at 390 px beside two half-empty columns of short figures. The words
	   take the room; the figures sit right, under their season. */
	th.span {
		width: 40%;
	}
	th.span,
	tbody th {
		padding-left: 0;
		text-align: left;
	}
	thead th {
		font-weight: 600;
	}
	/* "2024–25" breaks at its dash at 320 px in Afrikaans otherwise. */
	thead th:not(.span) {
		white-space: nowrap;
	}
	th.span,
	tbody th {
		font-weight: 400;
		color: var(--text-2);
	}
</style>
