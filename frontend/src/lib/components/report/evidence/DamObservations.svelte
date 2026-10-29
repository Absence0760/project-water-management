<script lang="ts">
	// § 7 Observed wet days (evidence-21; Sentinel-2 beside WOfS from
	// evidence-24, issue #624 step 7; docs/evidence-pack.md § Observed wet
	// days): the applicant's own dams as the satellites saw them, satellite
	// evidence beside the model, not an input to it. A pack drafted from
	// evidence-21 to evidence-23 prints its WOfS-only table as it did then.
	import { isDamObservationsV1, type EvidenceDamObservationsAny } from '@water-management/engine';
	import { fmtDate, fmtNum } from '#lib/format/number.js';
	import { damObservationCreditLine, damObservationRows, ruleText, SOURCE_ROW_LABEL } from './damObservations';

	let { dov }: { dov: EvidenceDamObservationsAny } = $props();

	const rows = $derived(damObservationRows(dov));
	const credit = $derived(damObservationCreditLine(dov));
	const v1 = $derived(isDamObservationsV1(dov) ? dov : null);
	const v2 = $derived(isDamObservationsV1(dov) ? null : dov);
</script>

{#if v1}
	<p class="small muted">
		For each of the applicant’s dams, the dates from {fmtDate(v1.startDate)} to {fmtDate(v1.endDate)} (the baseline’s period) on which the satellite water layer saw
		it, read by one rule (provisional). <strong>Wet:</strong> at least {v1.wetMinPixels} pixels of its traced outline were water (about {fmtNum(v1.wetMinPixels * v1.pixelAreaM2)} m²),
		however much of it was seen: proof of water needs no full view. <strong>Dry:</strong> no water at all, with at least {v1.dryMinClearPct} % of the outline seen
		free of cloud and shadow, so the last pool at the wall can’t hide. <strong>Inconclusive:</strong> anything else. Landsat sees a dam every 8 to 16 days, so these are
		counts of dates seen, not of days.
	</p>
{:else if v2}
	<p class="small muted">
		For each of the applicant’s dams, the dates from {fmtDate(v2.startDate)} to {fmtDate(v2.endDate)} (the baseline’s period) on which a satellite saw it, read by one
		rule per satellite (provisional). <strong>Wet:</strong> enough pixels of its traced outline were water, however much of it was seen
		({v2.sources.map((x) => ruleText(SOURCE_ROW_LABEL[x.source], x)).join('; ')}). <strong>Dry:</strong> no water at all, with at least
		{v2.sources[0]?.dryMinClearPct ?? 99} % of the outline seen free of cloud and shadow, so the last pool at the wall can’t hide. <strong>Inconclusive:</strong> anything
		else. <strong>Either satellite</strong> counts each date once: where both saw the dam that day, the sharper Sentinel-2 view decides unless it couldn’t say. Sentinel-2
		passes every few days from 2019 and Landsat every 8 to 16 days, so these are counts of dates seen, not of days.
	</p>
{/if}
{#if rows.length}
	<div class="table-wrap">
		<table class="data compact" data-testid="evidence-dam-observations">
			<thead>
				<tr>
					<th scope="col">Dam</th>
					{#if v2}<th scope="col">Satellite</th>{/if}
					<th scope="col" class="num">Dates observed</th>
					<th scope="col" class="num">Wet</th>
					<th scope="col" class="num">Dry</th>
					<th scope="col" class="num">Inconclusive</th>
					<th scope="col">Dates span</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as r (r.key)}
					<tr class:together={r.together}>
						{#if r.dam !== null}<th scope={r.source === null ? 'row' : 'rowgroup'} rowspan={r.damRows}>{r.dam}</th>{/if}
						{#if r.source !== null}<th scope="row">{r.source}</th>{/if}
						{#each r.cells as c, i (i)}<td class="num">{c}</td>{/each}
						<td>{r.span}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else}
	<p class="na" data-testid="evidence-dam-observations-na">No dam on the applicant’s units is traced on the map, so none was observed.</p>
{/if}
<p class="small muted" data-testid="evidence-dam-observations-credit">{credit}</p>

<style>
	.na {
		font-style: italic;
		color: var(--text-muted);
	}
	tr.together :is(th, td) {
		font-weight: 600;
	}
</style>
