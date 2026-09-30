<script lang="ts">
	// Month × water-year Reserve grids, baseline and application side by side
	// (§1 The river, C10; grid.ts says how a cell is shaded). Real tables:
	// each cell carries its number and its verdict in words.
	import type { EvidenceSite } from '@water-management/engine';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { reserveGrid, waterYearLabel } from './grid';

	let { site, application }: { site: EvidenceSite; application: boolean } = $props();
	const grids = $derived(application ? [{ label: 'Baseline', g: reserveGrid(site, 'a') }, { label: 'Application', g: reserveGrid(site, 'b') }] : [{ label: 'Baseline', g: reserveGrid(site, 'a') }]);
</script>

<div class="grids">
	{#each grids as { label, g } (label)}
		<div class="table-wrap">
			<table class="rgrid">
				<caption>{label}: months meeting the Reserve at {site.name}, % of the requirement delivered</caption>
				<thead><tr><th scope="col">Water year</th>{#each WATER_YEAR_MONTHS as m (m)}<th scope="col">{m}</th>{/each}</tr></thead>
				<tbody>
					{#each g.waterYears as y, r (y)}
						<tr>
							<th scope="row">{waterYearLabel(y)}</th>
							{#each g.cells[r]! as c, m (m)}
								{#if c}
									<td class="d{c.depth}" class:lost={c.change === 'lost'} class:gained={c.change === 'gained'} title={c.text}>
										<span aria-hidden="true">{c.met ? '✓' : c.delivered === null ? '·' : Math.min(99, Math.round(c.delivered * 100))}</span><span class="visually-hidden">{c.text}</span>
									</td>
								{:else}
									<td class="none"><span class="visually-hidden">no complete month</span></td>
								{/if}
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/each}
</div>
<p class="cap">
	✓: the month met its requirement. A number: the month failed, and that share of the requirement was delivered (darker is deeper). Outlined:
	the application changes the month ({site.lost} lost{application ? `, ${site.gained} gained` : ''}). Blank: no complete month.
</p>

<style>
	.grids {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr));
		gap: 0.75rem;
	}
	.rgrid {
		border-collapse: collapse;
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}
	caption {
		text-align: left;
		font-size: 0.8rem;
		font-weight: 600;
		padding-bottom: 0.25rem;
	}
	th,
	td {
		padding: 0.1rem 0.2rem;
		text-align: center;
		min-width: 1.6rem;
	}
	thead th {
		font-weight: 500;
		color: var(--text-muted);
	}
	tbody th {
		text-align: left;
		font-weight: 500;
		white-space: nowrap;
	}
	td {
		border: 1px solid var(--border);
	}
	/* Neutral shades, deeper for a deeper failure; the met month is the light one. */
	.d0 {
		background: var(--surface);
	}
	.d1 {
		background: color-mix(in srgb, var(--text) 18%, var(--surface));
	}
	.d2 {
		background: color-mix(in srgb, var(--text) 32%, var(--surface));
	}
	.d3 {
		background: color-mix(in srgb, var(--text) 48%, var(--surface));
		color: var(--surface);
	}
	.d4 {
		background: color-mix(in srgb, var(--text) 66%, var(--surface));
		color: var(--surface);
	}
	.lost,
	.gained {
		outline: 2px solid var(--text);
		outline-offset: -2px;
	}
	.gained {
		outline-style: dashed;
	}
	.none {
		border-color: transparent;
	}
	.cap {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 72ch;
	}
	@media print {
		.rgrid {
			font-size: 6.8pt;
		}
		.d0,
		.d1,
		.d2,
		.d3,
		.d4 {
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}
	}
</style>
