<script lang="ts">
	// The irrigation demand table: per farm, m³/day per water-year month, the
	// mean and Mm³ a year, with the catchment row. Shown by the demand grid
	// (CropGrids, the grid modal's `demand`) and behind the Crops page's
	// "Show table" (CropsTab), from the same numbers (demand.ts).
	import type { ProjectSettings } from '@water-management/engine';
	import { fmtNum, fmtPct, fmtQty } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import type { FarmDemand } from './demand';

	let {
		farms,
		demand,
		total,
		areaM2,
		settings
	}: {
		farms: readonly { id: string; name: string }[];
		/** One per farm, in the same order (farmDemands). */
		demand: readonly FarmDemand[];
		/** The catchment row (catchmentDemand). */
		total: { monthly: number[]; mean: number; annual: number };
		/** Planted area on these farms, m². */
		areaM2: number;
		settings: ProjectSettings;
	} = $props();

	const peak = $derived(Math.max(1e-9, ...demand.flatMap((d) => d.monthlyM3Day)));
	const shade = (v: number) => `--i: ${Math.round((v / peak) * 100)}%`;
</script>

<p class="muted small intro">
	Gross demand = Σ area × A-pan × crop factor, spread over the days in each month (February {fmtNum(settings.februaryDays, 2)}
	days). On each simulated day the model then subtracts effective rainfall ({fmtPct(settings.effectiveRainFraction, 0)} of rain on the
	cropped area{#if settings.effectiveRainStoreMm > 0}, with what the crop can't use that day carried over in a
		{fmtNum(settings.effectiveRainStoreMm, 0)} mm soil-water store{/if}) to get the net crop requirement; the hydrological unit abstracts that ÷ its irrigation
	efficiency. Uses saved A-pan values and the crops and planted areas as edited, unsaved changes included.
</p>
<div class="table-wrap">
	<table class="data compact demand">
		<thead>
			<tr>
				<th scope="col" class="sticky">Farm</th>
				<th scope="col" class="num">Area<br /><span class="u">ha</span></th>
				{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}<br /><span class="u">m³/day</span></th>{/each}
				<th scope="col" class="num">Mean<br /><span class="u">m³/day</span></th>
				<th scope="col" class="num">Annual<br /><span class="u">Mm³/a</span></th>
			</tr>
		</thead>
		<tbody>
			{#each farms as f, i (f.id)}
				{@const d = demand[i]}
				{#if d}
					<tr>
						<th scope="row" class="sticky">{f.name || '(unnamed)'}</th>
						<td class="num">{fmtNum(d.areaHa, 1)}</td>
						{#each d.monthlyM3Day as v, m (m)}<td class="num heat" style={shade(v)}>{fmtNum(v)}</td>{/each}
						<td class="num">{fmtNum(d.meanM3Day)}</td>
						<td class="num strong">{fmtQty(d.annualMm3, 3)}</td>
					</tr>
				{/if}
			{/each}
		</tbody>
		<tfoot>
			<tr>
				<th scope="row" class="sticky">Catchment</th>
				<td class="num">{fmtNum(areaM2 / 10_000, 2)}</td>
				{#each total.monthly as v, m (m)}<td class="num">{fmtNum(v)}</td>{/each}
				<td class="num">{fmtNum(total.mean)}</td>
				<td class="num">{fmtQty(total.annual, 3)}</td>
			</tr>
		</tfoot>
	</table>
</div>
<p class="muted small after">
	1 Mm³ = 1 million m³. Darker cells are months of higher demand. Annual catchment demand is
	{fmtQty(total.annual, 3)} Mm³/a ({fmtQty((total.annual * 1e6) / 86_400 / 365.25, 3)} m³/s on average).
</p>

<style>
	.intro {
		margin: 0 0 0.75rem;
		max-width: 75ch;
	}
	th.sticky {
		position: sticky;
		left: 0;
		z-index: 2;
		background: var(--surface);
		min-width: 130px;
		white-space: nowrap;
	}
	thead th.sticky,
	tfoot th.sticky {
		background: var(--surface-2);
		z-index: 3;
	}
	.demand td {
		min-width: 64px;
	}
	.heat {
		background: color-mix(in srgb, color-mix(in srgb, var(--brand-outlet) 45%, transparent) var(--i), transparent);
	}
	.strong {
		font-weight: 600;
	}
	.after {
		margin: 0.75rem 0 0;
	}
</style>
