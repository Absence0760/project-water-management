<!--
	EWR required vs met at each EWR site (the outlet, then the gauges), per
	water year and over the run (engine ≥ 0.32.0, WP-3.4, docs/model.md
	§2.11b): the share of the required volume that passed the site, the
	volume required and the days short. River & reserve shows it in the EWR
	by month panel; it was the tail of the water account until issue #175,
	though it isn't part of the mass balance. Input:
	RunSummary.supplyAssurance.waterAccount; nothing shows on older runs.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import type { SupplyAssurance, WaterAccountRow } from '@water-management/engine';
	import { fmtNum } from '$lib/format/number';
	import { waterYearLabel } from '$lib/components/calibration/metrics';
	import { ewrMetShare, pctText } from '$lib/components/reliability/reliability';
	import { fmtVolume } from './heatmap';

	let { assurance }: { assurance: SupplyAssurance | undefined | null } = $props();

	const uid = $props.id();
	const account = $derived(assurance?.waterAccount ?? null);
	const rows = $derived(account ? [...account.years, account.total] : []);
	const label = (r: WaterAccountRow) => (r.waterYear === null ? 'Whole run' : waterYearLabel(r.waterYear));
</script>

{#if account?.total.ewr.length}
	<section class="required-met" aria-labelledby="{uid}-h">
		<h4 id="{uid}-h">EWR required vs met, each water year <HelpTip key="ewr-shortfall" label="About the EWR volume met" /></h4>
		<div class="table-wrap scroll">
			<table class="data" data-testid="ewr-required-met">
				<caption class="visually-hidden">EWR required and met at each site per water year, m³</caption>
				<thead>
					<tr>
						<th scope="col">Site</th>
						{#each rows as r (r.waterYear ?? 'run')}<th scope="col" class="num">{label(r)}</th>{/each}
					</tr>
				</thead>
				<tbody>
					{#each account.total.ewr as site, si (site.nodeId ?? 'outlet')}
						<tr>
							<th scope="row">{site.name}{site.nodeId === null ? ' (outlet)' : ''}</th>
							{#each rows as r (r.waterYear ?? 'run')}
								{@const e = r.ewr[si]}
								<td class="num">
									{#if e}{pctText(ewrMetShare(e), 1)} <span class="muted">of {fmtVolume(e.requiredM3)}; {fmtNum(e.daysNotMet)} days short</span>{:else}–{/if}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="note muted">Met = the part of the requirement that passed the site (the flow, capped at the requirement each day).</p>
	</section>
{/if}

<style>
	.required-met {
		margin-top: 1rem;
	}
	.required-met h4 {
		margin: 0 0 0.4rem;
	}
	.scroll {
		overflow-x: auto;
	}
	.note {
		font-size: 0.8rem;
		margin-top: 0.4rem;
	}
</style>
