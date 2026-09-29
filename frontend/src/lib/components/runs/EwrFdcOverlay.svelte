<!--
	The monthly flow-duration curves on the EWR (engine ≥ 1.19.0, calibration
	research CR-29; docs/model.md §2.9c): for one month of the year, the run's
	natural flow, its present-day (simulated) flow and, when given, another
	run's flow (a scenario, or run B in a comparison) at the rule table's %
	points, against the EWR curve. Log scale; the table under it holds the
	values. Nothing on a run from before engine 1.19.0 (no natural curve).
-->
<script lang="ts">
	import type { EwrAssuranceSite } from '@water-management/engine';
	import { monthName } from '$lib/format/months';
	import { fmtFlow, UNIT_LABEL } from './ewrAssurance';
	import { fdcLines, fdcOverlayChart } from './ewrReporting';

	let {
		site,
		other = null,
		presentLabel
	}: {
		site: EwrAssuranceSite;
		/** Another run's same site, drawn as a third line (a scenario, or run B). */
		other?: { label: string; site: EwrAssuranceSite } | null;
		/** The present-day line's name (default "Present day (this run)"). */
		presentLabel?: string;
	} = $props();

	const uid = $props.id();
	const W = 520;
	const H = 256;
	// Open on the first month of the year where the simulated curve falls below the EWR at a point.
	const firstShort = $derived(Math.max(0, site.byMonth.findIndex((m) => m.fdc.some((f) => f.met === false))));
	let picked = $state<number | null>(null);
	const w = $derived(picked ?? firstShort);
	const has = $derived(site.byMonth.some((m) => m.fdc.some((f) => f.natural !== undefined)));
	const lines = $derived(fdcLines(site, w, { presentLabel, other }));
	const chart = $derived(fdcOverlayChart(lines, site.points, W, H, { l: 56, r: 12, t: 10, b: 42 }));
	const u = $derived(UNIT_LABEL[site.unit] ?? site.unit);
	const month = $derived(monthName(site.byMonth[w]?.month ?? 10));
	const otherDropped = $derived(!!other && !lines.some((l) => l.key === 'scenario') && !!other.site.byMonth[w]?.fdc.some((f) => f.impacted !== null));
</script>

{#if has}
	<div class="fdc-overlay" data-testid="ewr-fdc-overlay">
		<div class="field">
			<label for="{uid}-m">Month</label>
			<select id="{uid}-m" value={w} onchange={(e) => (picked = Number(e.currentTarget.value))}>
				{#each site.byMonth as m, i (m.month)}<option value={i}>{monthName(m.month)}</option>{/each}
			</select>
		</div>
		<ul class="key" aria-label="Lines">
			{#each lines as l (l.key)}
				<li><svg width="28" height="10" aria-hidden="true"><line x1="0" x2="28" y1="5" y2="5" class="ln {l.key}" /></svg>{l.label}</li>
			{/each}
		</ul>
		<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t">
			<title id="{uid}-t">{month} flow-duration curves at {site.name} against the EWR curve, {u} on a log scale; the table below holds the values.</title>
			{#each chart.yTicks as t (t.y)}
				<line class="grid" x1="56" x2={W - 12} y1={t.y} y2={t.y} />
				<text class="tick" x="50" y={t.y + 4} text-anchor="end">{t.label}</text>
			{/each}
			{#each chart.xTicks as t (t.x)}
				<text class="tick" x={t.x} y={H - 24} text-anchor="middle">{t.label}</text>
			{/each}
			<text class="axis-title" x={(56 + W - 12) / 2} y={H - 4} text-anchor="middle">% of {month}s the flow is at least this</text>
			<text class="axis-title" transform="translate(12 {(10 + H - 42) / 2}) rotate(-90)" text-anchor="middle">Flow ({u}, log scale)</text>
			{#each chart.paths as p (p.key)}
				<path class="ln {p.key}" d={p.d} />
			{/each}
		</svg>
		<p class="muted small">
			Exceedance: the share of {month}s the flow is at least this ({u}, log scale). Where the present-day curve lies below the EWR
			curve, the rule's assurance isn't met at that point.{#if chart.floored} A zero flow is drawn at the foot of the axis.{/if}
			{#if otherDropped} {other!.label} uses other % points, so it isn't drawn.{/if}
		</p>
		<details>
			<summary>Values for {month}</summary>
			<div class="table-wrap">
				<table class="data compact">
					<caption class="visually-hidden">{month} flow-duration values at {site.name} ({u})</caption>
					<thead>
						<tr>
							<th scope="col" class="num">% point</th>
							{#each lines as l (l.key)}<th scope="col" class="num">{l.label}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each site.points as p, i (p)}
							<tr>
								<th scope="row" class="num">{p}</th>
								{#each lines as l (l.key)}<td class="num">{fmtFlow(l.values[i])}</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</details>
	</div>
{/if}

<style>
	.fdc-overlay svg[role='img'] {
		width: 100%;
		max-width: 560px;
		height: auto;
		display: block;
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		list-style: none;
		padding: 0;
		margin: 0.4rem 0;
		font-size: 0.8rem;
	}
	.key li {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.grid {
		stroke: var(--border);
		stroke-width: 1;
	}
	.tick {
		font-size: 11px;
		fill: var(--text-muted);
	}
	.axis-title {
		font-size: 11px;
		fill: var(--text);
	}
	.ln {
		fill: none;
		stroke-width: 2;
	}
	.ln.natural {
		stroke: var(--series-1);
		stroke-dasharray: 6 3;
	}
	.ln.present {
		stroke: var(--series-2);
	}
	.ln.scenario {
		stroke: var(--series-3);
		stroke-dasharray: 2 2;
	}
	.ln.ewr {
		stroke: var(--text);
		stroke-width: 2.5;
		stroke-dasharray: 10 3 2 3;
	}
	.field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
</style>
