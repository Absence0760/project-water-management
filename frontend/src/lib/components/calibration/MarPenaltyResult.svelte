<!--
	The fit with and without the soft WR2012 MAR penalty (issue #4 phase 8),
	so the user sees what pulling the MAR towards WR2012 costs the fit.
-->
<script lang="ts">
	import type { CalibrationReport, MarPenaltyResult } from '@water-management/engine';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { objectiveName } from '$lib/calibration/fit';
	import { fmtNum } from '$lib/format/number';

	let { report, penalty, paramLabel }: { report: CalibrationReport; penalty: MarPenaltyResult; paramLabel: (k: string) => string } = $props();

	const uid = $props.id();
	const obj = $derived(report.objective);
	const hasBand = $derived(penalty.marLowMm3 !== null && penalty.marHighMm3 !== null);
	const score = (v: number | null | undefined) => (v == null ? '–' : fmtNum(v, 2));
	const ratio = (v: number) => `${fmtNum(v, 2)} (${v >= 1 ? '+' : '−'}${fmtNum(Math.abs(100 * (v - 1)), 0)} %)`;
	const param = (v: number | undefined) => (v === undefined ? '–' : fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 3));
</script>

<div class="table-wrap">
	<table class="data compact" aria-labelledby="{uid}-c">
		<caption id="{uid}-c">
			WR2012 MAR penalty, weight {fmtNum(penalty.weight, 2)} <HelpTip key="wr2012-penalty" />
		</caption>
		<thead>
			<tr>
				<th scope="col"><span class="visually-hidden">Measure</span></th>
				<th scope="col" class="num">With the penalty</th>
				<th scope="col" class="num">Without it</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<th scope="row">{objectiveName(obj)}</th>
				<td class="num">{score(report.fit.scores[obj])}</td>
				<td class="num">{penalty.unpenalised ? score(penalty.unpenalised.fit.scores[obj]) : '–'}</td>
			</tr>
			<tr>
				<th scope="row"
					>{#if hasBand}Simulated natural MAR ÷ band ({fmtNum(penalty.marLowMm3!, 3)}–{fmtNum(penalty.marHighMm3!, 3)} Mm³/a){:else}Simulated
					natural MAR ÷ WR2012 ({fmtNum(penalty.targetMarMm3, 3)} Mm³/a){/if}</th
				>
				<td class="num">{ratio(penalty.marRatio)}</td>
				<td class="num">{penalty.unpenalised ? ratio(penalty.unpenalised.marRatio) : '–'}</td>
			</tr>
			{#each report.free as k (k)}
				<tr>
					<th scope="row">{paramLabel(k)}</th>
					<td class="num">{param(report.params[k])}</td>
					<td class="num">{param(penalty.unpenalised?.params[k])}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
<p class="muted small">
	{#if hasBand}
		The penalty is zero once the simulated natural MAR is inside the band ({fmtNum(penalty.marLowMm3!, 3)}–{fmtNum(penalty.marHighMm3!, 3)} Mm³/a,
		{penalty.basis === 'overlap' ? 'over the years both cover' : 'over the simulated period'}), and pulls it towards the nearer bound outside it.
	{:else}
		The penalty pulls the simulated natural MAR towards the scaled WR2012 MAR ({penalty.basis === 'overlap' ? 'over the years both cover' : 'over the simulated period'}).
	{/if}
	“Apply to form” uses the fit with the penalty. {#if !penalty.unpenalised}The fit without it didn’t run because the calibration was cancelled.{/if}
</p>

<style>
	caption {
		text-align: left;
		font-weight: 500;
		padding-bottom: 0.25rem;
	}
</style>
