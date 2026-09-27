<!-- i18n-section: landing.whatif -->
<script lang="ts">
	// "Try a what-if" (issue #57): one farm in the example catchment plants more
	// apples and may build a bigger dam. The results are a grid of engine runs
	// made at build time (data.generated.ts, 7 orchard sizes × 5 dam sizes), so
	// the sliders answer at once with no model in the browser. The figures are
	// announced as they change (a polite live region), and the takeaway uses
	// Compare runs' words: what the change costs the river, and what it gives
	// the farm.
	import { t } from '$lib/i18n/locale.svelte';
	import { DATA } from './data.generated';
	import { fmt, signed } from './format';

	const w = DATA.whatIf;
	let ha = $state(0);
	let dam = $state(0);

	const cell = $derived(w.grid[ha]![dam]!);
	const today = w.grid[0]![0]!;
	const moreDays = $derived(cell.reserveDays - today.reserveDays);
	const supplyChange = $derived(cell.supplied - today.supplied);
	const scaleText = (i: number) => `×${fmt(w.damScale[i]!, w.damScale[i]! % 1 ? 2 : 0).replace(/0$/, '')}`;

	const takeaway = $derived.by(() => {
		if (ha === 0 && dam === 0) return t('This is the farm as it is today. Move a slider to change it.');
		const days = Math.round(moreDays);
		const river =
			days > 0
				? t('It costs the river {days} more days a year below the reserve', { days })
				: days < 0
					? t('It gives the river {days} fewer days a year below the reserve', { days: -days })
					: t('The river is below the reserve about as often as today');
		const farm =
			Math.abs(supplyChange) < 0.5
				? t('and the farm gets about as much of what it needs.')
				: supplyChange > 0
					? t('and the farm gets {points} points more of what it needs.', { points: fmt(supplyChange) })
					: t('and the farm gets {points} points less of what it needs.', { points: fmt(-supplyChange) });
		return `${river}, ${farm}`;
	});
	const barWidth = (v: number, max: number) => `${Math.max(2, Math.min(100, (v / max) * 100)).toFixed(1)}%`;
	const DAYS_MAX = 366;
</script>

<section class="whatif" aria-labelledby="whatif-title">
	<div class="copy">
		<h2 id="whatif-title">{t('Try a what-if')}</h2>
		<p>
			{t('{farm}, a farm in the example catchment, grows {ha} ha of apples. It wants to plant more, and could build a bigger dam. What would that do to the farm, and to the river?', { farm: w.farm, ha: w.baseHa })}
		</p>
		<p class="muted small">{t('Worked out in advance from {runs} runs of the model.', { runs: w.extraHa.length * w.damScale.length })}</p>
	</div>
	<div class="card">
		<div class="controls">
			<label>
				<span class="label">{t('More apples')} <span class="val">{t('+{ha} ha', { ha: w.extraHa[ha]! })}</span></span>
				<input type="range" min="0" max={w.extraHa.length - 1} step="1" bind:value={ha} aria-valuetext={t('{ha} more hectares', { ha: w.extraHa[ha]! })} />
			</label>
			<label>
				<span class="label">{t('Dam size')} <span class="val">{scaleText(dam)}</span></span>
				<input type="range" min="0" max={w.damScale.length - 1} step="1" bind:value={dam} aria-valuetext={t('{times} times today’s dam', { times: fmt(w.damScale[dam]!, 2) })} />
			</label>
		</div>
		<div class="results" aria-live="polite">
			<div class="figure">
				<p class="what">{t('Irrigation supplied')}</p>
				<p class="value">{t('{pct} % of what the farm needs', { pct: fmt(cell.supplied) })}</p>
				<div class="bars" aria-hidden="true">
					<span class="bar today" style:width={barWidth(today.supplied, 100)}></span>
					<span class="bar plan supply" style:width={barWidth(cell.supplied, 100)}></span>
				</div>
			</div>
			<div class="figure">
				<p class="what">{t('River below the reserve')}</p>
				<p class="value">{t('{days} days a year', { days: fmt(cell.reserveDays) })}</p>
				<div class="bars" aria-hidden="true">
					<span class="bar today" style:width={barWidth(today.reserveDays, DAYS_MAX)}></span>
					<span class="bar plan reserve" style:width={barWidth(cell.reserveDays, DAYS_MAX)}></span>
				</div>
			</div>
			<p class="key" aria-hidden="true"><i class="today"></i>{t('Today')} <i class="plan"></i>{t('This plan')}</p>
			<p class="takeaway">{takeaway}</p>
		</div>
		<p class="muted small change" aria-hidden="true">
			{t('Change from today: supply {supply} points, river {days} days a year.', { supply: signed(supplyChange), days: signed(Math.round(moreDays)) })}
		</p>
	</div>
</section>

<style>
	.whatif {
		display: grid;
		grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
		gap: clamp(1.5rem, 4vw, 3.5rem);
		align-items: center;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 3.2vw, 2.25rem);
		letter-spacing: -0.015em;
	}
	.copy p {
		margin: 0 0 0.75rem;
		line-height: 1.6;
		color: var(--text-2);
		max-width: 34rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.card {
		padding: clamp(1.25rem, 3vw, 2rem);
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--surface);
		box-shadow: 0 10px 30px rgb(16 42 67 / 0.08);
	}
	.controls {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.25rem;
		margin-bottom: 1.5rem;
	}
	label {
		display: grid;
		gap: 0.5rem;
	}
	.label {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		font-weight: 600;
	}
	/* A span, not <output>: an <output> inside the label would take the label's name from the slider. */
	.val {
		font-variant-numeric: tabular-nums;
		color: var(--accent);
	}
	input[type='range'] {
		width: 100%;
		min-height: var(--tap);
		accent-color: var(--accent);
	}
	.results {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem 1.5rem;
	}
	.figure p {
		margin: 0;
	}
	.what {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.value {
		margin-bottom: 0.5rem !important;
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-variant-numeric: tabular-nums;
	}
	.bars {
		display: grid;
		gap: 4px;
	}
	.bar {
		display: block;
		height: 8px;
		border-radius: 4px;
		transition: width 250ms ease-out;
	}
	.bar.today {
		background: var(--border-strong);
	}
	.bar.supply {
		background: var(--series-3);
	}
	.bar.reserve {
		background: var(--warning);
	}
	.key {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.key i {
		display: inline-block;
		width: 14px;
		height: 8px;
		border-radius: 4px;
		background: var(--border-strong);
	}
	.key i.plan {
		margin-left: 0.6rem;
		background: linear-gradient(90deg, var(--series-3) 50%, var(--warning) 50%);
	}
	.takeaway {
		grid-column: 1 / -1;
		margin: 0.25rem 0 0;
		padding: 0.75rem 0.9rem;
		border-left: 3px solid var(--accent);
		background: var(--accent-soft);
		border-radius: 0 var(--radius) var(--radius) 0;
		line-height: 1.5;
	}
	.change {
		margin: 0.75rem 0 0;
		font-variant-numeric: tabular-nums;
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			transition: none;
		}
	}
	@media (max-width: 760px) {
		.whatif,
		.controls,
		.results {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
