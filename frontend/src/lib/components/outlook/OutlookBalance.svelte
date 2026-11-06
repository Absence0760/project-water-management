<!--
	The seasonal outlook's part 6 (docs/ui.md § Seasonal outlook, the
	operator's mock-up 2026-11-03): one level's season month by month, as
	stacked bars (irrigation supplied, other water users supplied, the EWR the
	river carried, lost from the dams) and the dams' storage at each month's
	end as a line inside its 10–90 % band. Each figure is its own median across
	the analogue years (engine ≥ 1.115.0). The chart is a picture of the table
	under it, so it is aria-hidden and the table is what a screen reader reads.
	View model: ./briefing.ts buildBalance.
-->
<script lang="ts">
	import type { OutlookResult } from '#lib/api/types.js';
	import { fmtNum } from '#lib/format/number.js';
	import { BALANCE_PARTS, buildBalance, volume } from './briefing';

	let { result }: { result: OutlookResult } = $props();

	const ran = $derived(result.levels.filter((l) => !l.problems.length));
	let picked = $state<string | null>(null);
	const view = $derived(buildBalance({ result }, picked));

	const W = 560;
	const H = 230;
	const LEFT = 44;
	const RIGHT = 8;
	const TOP = 12;
	const BASE = 196;
	const geo = $derived.by(() => {
		if (!view.ok) return null;
		const max = Math.max(
			...view.months.map((m) => Math.max(m.irrigation + m.otherUsers + m.ewr + m.damLoss, m.storage?.p90 ?? 0)),
			view.capacityM3,
			1
		);
		const step = niceStep(max / view.unit.div / 4);
		const top = Math.ceil(max / view.unit.div / step) * step;
		const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
		const slot = (W - LEFT - RIGHT) / view.months.length;
		const y = (m3: number) => BASE - (m3 / view.unit.div / top) * (BASE - TOP);
		const cx = (k: number) => LEFT + slot * (k + 0.5);
		const stored = view.months.map((m, k) => (m.storage ? { k, ...m.storage } : null)).filter((p) => p !== null);
		return {
			slot,
			y,
			cx,
			ticks,
			bars: view.months.map((m) => {
				let at = 0;
				return BALANCE_PARTS.map((p) => {
					const v = m[p.key];
					const seg = { key: p.key, label: p.label, from: at, to: at + v };
					at += v;
					return seg;
				});
			}),
			line: stored.map((p) => `${cx(p.k)},${y(p.p50)}`).join(' '),
			band: stored.length ? [...stored.map((p) => `${cx(p.k)},${y(p.p90)}`), ...[...stored].reverse().map((p) => `${cx(p.k)},${y(p.p10)}`)].join(' ') : '',
			stored
		};
	});

	function niceStep(raw: number): number {
		if (!(raw > 0)) return 1;
		const p = 10 ** Math.floor(Math.log10(raw));
		const f = raw / p;
		return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
	}
	const tick = (v: number) => fmtNum(v, v < 10 && v % 1 ? 1 : 0);
</script>

<div class="balance" data-testid="outlook-balance-body">
	{#if ran.length > 1 && view.ok}
		<div class="field level">
			<label for="outlook-balance-level">Demand level</label>
			<select id="outlook-balance-level" value={view.levelId} onchange={(e) => (picked = e.currentTarget.value)} data-testid="outlook-balance-level">
				{#each ran as l (l.id)}<option value={l.id}>{l.label}{l.id === result.planning.levelId && result.planning.reason === 'met' ? ' (the planning figure)' : ''}</option>{/each}
			</select>
		</div>
	{/if}

	{#if !view.ok}
		<p class="hint" data-testid="outlook-balance-missing" data-reason={view.reason}>{view.text}</p>
	{:else if geo}
		<p class="hint">
			At <strong>{view.label}</strong>{view.planning ? ', the planning figure' : ''}: each month’s median over the {result.nYears} analogue years, every part its own median, so a month’s parts need not
			add up to any one year’s. The line is the dams at each month’s end (median), the shading their 10–90 % range.
		</p>
		<svg class="chart" viewBox="0 0 {W} {H}" aria-hidden="true" data-testid="outlook-balance-chart">
			{#each geo.ticks as t (t)}
				<line class="grid" x1={LEFT} x2={W - RIGHT} y1={geo.y(t * view.unit.div)} y2={geo.y(t * view.unit.div)} />
				<text class="tick" x={LEFT - 4} y={geo.y(t * view.unit.div) + 3.5} text-anchor="end">{tick(t)}</text>
			{/each}
			{#each geo.bars as segs, k (view.months[k]!.month)}
				{#each segs as s (s.key)}
					{#if s.to > s.from}
						<rect class="part part-{s.key}" x={geo.cx(k) - geo.slot * 0.3} y={geo.y(s.to)} width={geo.slot * 0.6} height={Math.max(geo.y(s.from) - geo.y(s.to), 0.5)} data-part={s.key} />
					{/if}
				{/each}
				<text class="tick" x={geo.cx(k)} y={BASE + 14} text-anchor="middle">{view.months[k]!.name.slice(0, 3)}</text>
			{/each}
			{#if geo.stored.length}
				<polygon class="range" points={geo.band} />
				<polyline class="storage" points={geo.line} />
				{#each geo.stored as p (p.k)}<circle class="storage-dot" cx={geo.cx(p.k)} cy={geo.y(p.p50)} r="3" />{/each}
			{/if}
			<line class="axis" x1={LEFT} x2={W - RIGHT} y1={BASE} y2={BASE} />
			<text class="tick unit" x={4} y={TOP - 2}>{view.unit.text}</text>
		</svg>
		<ul class="legend" aria-hidden="true">
			{#each BALANCE_PARTS as p (p.key)}<li><span class="swatch part-{p.key}"></span>{p.label}</li>{/each}
			{#if geo.stored.length}<li><span class="swatch line"></span>Dams at the month’s end (10–90 % shaded)</li>{/if}
		</ul>
		<div class="table-wrap">
			<table class="data" data-testid="outlook-balance-table">
				<caption>The season month by month at {view.label} (medians over the analogue years)</caption>
				<thead>
					<tr>
						<th scope="col">Month</th>
						<th scope="col">Irrigation supplied (of demand)</th>
						<th scope="col">Other water users supplied</th>
						<th scope="col">EWR the river carried (of required)</th>
						<th scope="col">Lost from the dams</th>
						<th scope="col">Dams at the month’s end (10–90 %)</th>
					</tr>
				</thead>
				<tbody>
					{#each view.months as m (m.month)}
						<tr>
							<th scope="row">{m.name}</th>
							<td>{volume(m.irrigation)} <span class="muted">({volume(m.irrigationDemand)})</span></td>
							<td>{volume(m.otherUsers)}</td>
							<td>{volume(m.ewr)} <span class="muted">({volume(m.ewrRequired)})</span></td>
							<td>{volume(m.damLoss)}</td>
							<td>{#if m.storage}{volume(m.storage.p50)} <span class="muted">({volume(m.storage.p10)} – {volume(m.storage.p90)})</span>{:else}No farm dam{/if}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.level {
		max-width: 20rem;
		margin-bottom: 0.5rem;
	}
	.chart {
		display: block;
		width: 100%;
		max-width: 40rem;
		height: auto;
	}
	.grid {
		stroke: var(--border);
	}
	.axis {
		stroke: var(--border-strong);
	}
	.tick {
		fill: var(--text-muted);
		font-size: var(--font-xs);
		font-variant-numeric: tabular-nums;
	}
	.part-irrigation {
		fill: var(--series-1);
		background: var(--series-1);
	}
	.part-otherUsers {
		fill: var(--series-5);
		background: var(--series-5);
	}
	.part-ewr {
		fill: var(--series-3);
		background: var(--series-3);
	}
	.part-damLoss {
		fill: var(--surface-2);
		background: var(--surface-2);
		stroke: var(--text-muted);
		stroke-width: 0.5;
	}
	.range {
		fill: var(--text);
		opacity: 0.1;
	}
	.storage {
		fill: none;
		stroke: var(--text);
		stroke-width: 2;
	}
	.storage-dot {
		fill: var(--text);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		list-style: none;
		padding: 0;
		margin: 0.25rem 0 0.75rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.swatch {
		display: inline-block;
		width: 0.8rem;
		height: 0.8rem;
		margin-right: 0.35rem;
		vertical-align: -0.1rem;
		border: 1px solid var(--border-strong);
	}
	.swatch.line {
		height: 0;
		border: none;
		border-top: 2px solid var(--text);
		vertical-align: 0.2rem;
	}
	.table-wrap {
		overflow-x: auto;
	}
	.muted {
		color: var(--text-muted);
	}
	@media (forced-colors: active) {
		.part {
			fill: CanvasText;
		}
		.storage {
			stroke: Highlight;
		}
	}
</style>
