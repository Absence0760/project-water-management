<!--
	How much irrigation can the catchment support? (issue #53, design
	planning-outputs.md §3.8, docs/ui.md § Irrigation the catchment supports,
	docs/model.md §2.14b). Beside the outcome matrix on the EWR page, from the
	same demand sweep (OutcomeMatrixPanel shares its sweep and matrix through
	`onview`; this panel looks nothing up itself): one bar per demand level
	across the record's water years by natural water available (driest left),
	each year a mark (a dot where the requirement failed, a ring where it held),
	and a marker at the wettest year that failed, worded. The Key message comes
	first, from the numbers (irrigationSupport.ts keyMessage), then the bars,
	then "Show the numbers". No sweep: one row (common/ToolRow) whose Run…
	opens the outcome matrix's sweep form. It reports what past years did at
	each level and never picks one.
-->
<script lang="ts">
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import ToolRow from '#lib/components/common/ToolRow.svelte';
	import {
		aboutMillion,
		axisPct,
		buildSupportView,
		IRRIGATION_SUPPORT_HEADING,
		markerText,
		millionM3,
		spreadText,
		type SupportLevel,
		type SupportView
	} from './irrigationSupport';
	import { demandLevelOf, type MatrixShare } from './matrix';

	let {
		source,
		plantedHa,
		fullAllocation = false,
		canEdit,
		onRun
	}: {
		/** The outcome matrix panel's sweep and matrix (null until it reports). */
		source: MatrixShare | null;
		/** The base run's planted area, ha (plantedHaOf); null when unknown. */
		plantedHa: number | null;
		/** The base run is a full-allocation run: a level is a share of registered volume, so no hectares. */
		fullAllocation?: boolean;
		canEdit: boolean;
		/** Open the outcome matrix's sweep form. */
		onRun: () => void;
	} = $props();

	const view = $derived(source?.view ?? null);
	const board = $derived.by((): SupportView | null => {
		const v = view;
		const sweep = source?.sweep;
		if (!v?.outcome || !sweep) return null;
		const members = [...sweep.members]
			.sort((a, b) => a.position - b.position)
			.map((m) => ({ id: m.id, pct: demandLevelOf(m) ?? Number.NaN, done: m.status === 'done' }));
		return buildSupportView({ matrix: v.outcome, classes: v.classes, members, plantedHa, fullAllocation });
	});
	const state = $derived(!source ? 'loading' : source.state);
	const collapsed = $derived(state !== 'complete' || !view);

	const metWords = $derived(view?.metric === 'reserveMonthsMet' ? 'every month met the Reserve rule table' : 'no day below the EWR');

	/** The bar's fill: failed years' zone, the mixed zone and the met zone, each in the band tints, blended at their edges. */
	function trackFill(l: SupportLevel, max: number): string {
		const r = l.result;
		const at = (m3: number) => `${axisPct(m3, { maxM3: max }).toFixed(2)}%`;
		if (r.kind === 'neverFailed') return 'var(--success-soft)';
		if (r.kind === 'wettestFailed') return 'var(--danger-soft)';
		if (r.kind !== 'threshold') return 'var(--surface-sunken)';
		const driestMet = Math.min(r.thresholdM3, ...l.years.filter((y) => y.met).map((y) => y.naturalM3));
		return `linear-gradient(to right, var(--danger-soft) 0 ${at(driestMet)}, var(--warning-soft) ${at(r.thresholdM3)}, var(--success-soft) ${at(r.nextMet.naturalM3)} 100%)`;
	}
	/** Keep the marker's label inside the bar: anchored left near the start, right near the end. */
	const labelAnchor = (pct: number) => (pct < 25 ? 'start' : pct > 75 ? 'end' : 'middle');

	function levelSentence(l: SupportLevel): string {
		const r = l.result;
		const who = `${l.name}${l.haLabel ? ` (${l.haLabel})` : ''}`;
		switch (r.kind) {
			case 'threshold':
				return `${who}: not met in ${r.failed} of ${r.failed + r.met} years; breaches start at about ${aboutMillion(r.thresholdM3)} million m³ (${r.wettestFailed.label}); every wetter year met it.`;
			case 'neverFailed':
				return `${who}: met in all ${r.met} years.`;
			case 'wettestFailed':
				return `${who}: not met in ${r.failed} of ${r.failed + r.met} years, the wettest (${r.wettest.label}) included.`;
			case 'tooFewYears':
				return `${who}: only ${r.nYears} years, too few to mark.`;
		}
	}
	const counts = (l: SupportLevel) => {
		const failed = l.years.filter((y) => !y.met).length;
		return `Not met in ${failed} of ${l.years.length} years`;
	};
</script>

<section aria-labelledby="irr-h-t" data-testid="irrigation-support" data-state={state}>
	{#if collapsed}
		<ToolRow headingId="irr-h" titleId="irr-h-t" title={IRRIGATION_SUPPORT_HEADING} help="irrigation-support" purpose="Below how much water a year the river’s requirement failed, at each demand level.">
			{#snippet action()}
				{#if state === 'loading'}<span>Loading…</span>
				{:else if state === 'pending'}<span>Waiting for the demand sweep…</span>
				{:else if state === 'stuck'}<span>The demand sweep didn’t finish: see the outcome matrix.</span>
				{:else if !source?.runnable}<span>Needs an ordinary run with its natural flow.</span>
				{:else if canEdit}<button type="button" class="btn" aria-describedby="irr-h-t" onclick={onRun}>Run…</button>
				{:else}<span>Not run yet: an editor can run a demand sweep.</span>{/if}
			{/snippet}
		</ToolRow>
	{:else}
		<h3 id="irr-h"><span id="irr-h-t">{IRRIGATION_SUPPORT_HEADING}</span> <HelpTip key="irrigation-support" /></h3>
		<p class="muted small lead">
			The outcome matrix’s demand levels, each across the record’s water years from driest to wettest: where the river’s requirement
			started to fail as there was less water. Historical, not a forecast; the choice of level is the WUA’s.
		</p>
		{#if view?.siteMissing}
			<p class="alert alert-warning" data-testid="irr-site-missing">{view.siteMissing}</p>
		{:else if !board || !board.axis || !board.levels.length}
			<p class="muted" data-testid="irr-none">
				{view?.nYears ? 'No demand level of this sweep ran, so there is nothing to draw.' : 'The base run has no complete water year (1 October to 30 September), so there is nothing to draw.'}
			</p>
		{:else}
			{@const axis = board.axis}
			<div class="key" role="note" aria-labelledby="irr-key-h" data-testid="irr-key">
				<h4 id="irr-key-h">Key message</h4>
				<p>{board.keyMessage}</p>
			</div>
			<p class="small measure">
				A year met the requirement when it had {metWords} ({view?.metricLabel ?? ''}). Natural water available is the year’s natural flow at
				the outlet; MAR is its mean over the {board.nYears} years.
			</p>

			<ul class="bars" aria-label="Demand levels">
				{#each board.levels as l (l.id)}
					{@const r = l.result}
					<li
						class="row"
						data-testid="irr-level"
						data-level={l.pct}
						data-kind={r.kind}
						data-threshold-m3={r.kind === 'threshold' ? r.thresholdM3 : undefined}
					>
						<div class="who">
							<strong>{l.name}</strong>
							{#if l.haLabel}<span class="ha">{l.haLabel}</span>{/if}
							<span class="count">{counts(l)}</span>
						</div>
						<div class="track-wrap">
							<span class="visually-hidden">{levelSentence(l)}</span>
							<div class="track" style:background={trackFill(l, axis.maxM3)} aria-hidden="true">
								{#each l.years as y (y.waterYear)}
									<span class="yr" class:failed={!y.met} style:left="{axisPct(y.naturalM3, axis)}%" title="{y.label}: {millionM3(y.naturalM3)} million m³, {y.met ? 'met' : 'not met'}"></span>
								{/each}
								{#if r.kind === 'threshold'}
									{@const p = axisPct(r.thresholdM3, axis)}
									<span class="marker" style:left="{p}%"></span>
								{/if}
							</div>
							<span class="mark-label" aria-hidden="true" data-anchor={r.kind === 'threshold' ? labelAnchor(axisPct(r.thresholdM3, axis)) : 'none'} style:left={r.kind === 'threshold' ? `${axisPct(r.thresholdM3, axis)}%` : undefined}>{markerText(r)}</span>
						</div>
					</li>
				{/each}
			</ul>
			<div class="axis-row" aria-hidden="true">
				<span></span>
				<div class="axis">
					<div class="ticks">
						{#each axis.ticks as t, i (t)}
							<span class="tick" data-edge={i === 0 ? 'start' : i === axis.ticks.length - 1 ? 'end' : undefined} style:left="{axisPct(t, axis)}%">{millionM3(t).replace(/\.0+$/, '')}</span>
						{/each}
						<span class="mar" style:left="{axisPct(axis.meanM3, axis)}%">MAR {aboutMillion(axis.meanM3)}</span>
					</div>
					<p class="axis-title">Natural water available in the water year (million m³)</p>
					<p class="ends"><span>← Drier years (less water)</span><span>Wetter years (more water) →</span></p>
				</div>
			</div>
			<p class="small legend">
				<span class="sw dot" aria-hidden="true"></span> a year the requirement was not met ·
				<span class="sw ring" aria-hidden="true"></span> a year it was met ·
				<span class="sw line" aria-hidden="true"></span> the wettest year not met (breaches start here)
			</p>

			{#if board.notes.length}
				<ul class="notes" data-testid="irr-notes">
					{#each board.notes as n (n)}<li>{n}</li>{/each}
				</ul>
			{/if}
			{#if board.notRun.length}
				<p class="hint">Not drawn (the level didn’t run; see the outcome matrix): {board.notRun.map((n) => n.name).join(', ')}.</p>
			{/if}

			<details class="numbers">
				<summary>Show the numbers</summary>
				<!-- On a phone the table scrolls sideways: the box takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="scroll" tabindex="0" role="region" aria-label="Where breaches start: the numbers">
					<table data-testid="irr-table">
						<caption class="visually-hidden">Where breaches start at each demand level</caption>
						<thead>
							<tr>
								<th scope="col">Demand level</th>
								<th scope="col">Area</th>
								<th scope="col" class="num">Breaches start at about (million m³)</th>
								<th scope="col">Spread</th>
								<th scope="col" class="num">Years not met</th>
								<th scope="col" class="num">Years met</th>
							</tr>
						</thead>
						<tbody>
							{#each board.levels as l (l.id)}
								{@const r = l.result}
								<tr>
									<th scope="row">{l.name}</th>
									<td>{l.haLabel ?? `${l.pct} % of demand`}</td>
									<td class="num">{r.kind === 'threshold' ? aboutMillion(r.thresholdM3) : markerText(r)}</td>
									<td class="spread">{spreadText(r)}</td>
									<td class="num">{l.years.filter((y) => !y.met).length}</td>
									<td class="num">{l.years.filter((y) => y.met).length}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="hint">
					Breaches start at the wettest year that was not met: every wetter year met the requirement. The spread is the gap to the next wetter
					year, and any drier years that met it anyway (when the water came in the year matters as well as how much).
					{#if !fullAllocation && plantedHa}Areas are the run’s planted area scaled by the level: demand is scaled, not the crops, so read them as equivalents.{/if}
				</p>
			</details>
		{/if}
	{/if}
</section>

<style>
	section {
		container: irr / inline-size;
	}
	.lead {
		max-width: 80ch;
		margin: 0 0 0.75rem;
	}
	.key {
		border: 1px solid var(--border);
		border-left: 4px solid var(--accent);
		background: var(--accent-soft);
		border-radius: var(--radius, 6px);
		padding: 0.6rem 0.85rem;
		max-width: 80ch;
	}
	.key h4 {
		margin: 0 0 0.2rem;
		font-size: 0.9rem;
	}
	.key p {
		margin: 0;
	}
	.measure,
	.hint,
	.legend {
		font-size: var(--font-sm);
		color: var(--text-muted);
		max-width: 80ch;
		margin: 0.5rem 0 0;
	}
	.bars {
		list-style: none;
		margin: 0.75rem 0 0;
		padding: 0;
		display: grid;
		gap: 0.9rem;
	}
	.row,
	.axis-row {
		display: grid;
		grid-template-columns: 12rem minmax(0, 1fr);
		gap: 0.25rem 1rem;
		align-items: end;
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding-bottom: 0.15rem;
	}
	.ha,
	.count {
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	/* The marker's label sits above the bar on the card, not on the tint, so its contrast is the card's. */
	.track-wrap {
		position: relative;
		padding-top: 1.5rem;
	}
	.track {
		position: relative;
		height: 1.75rem;
		border-radius: 0.4rem;
		border: 1px solid var(--border-input);
	}
	.yr {
		position: absolute;
		top: 50%;
		width: 0.6rem;
		height: 0.6rem;
		margin: -0.3rem 0 0 -0.3rem;
		border-radius: 50%;
		border: 2px solid var(--success);
		background: var(--surface);
	}
	.yr.failed {
		border-color: var(--danger);
		background: var(--danger);
	}
	.marker {
		position: absolute;
		top: -0.4rem;
		bottom: -0.4rem;
		border-left: 2px dashed var(--text);
		margin-left: -1px;
	}
	.mark-label {
		position: absolute;
		top: 0;
		font-size: var(--font-sm);
		font-weight: 600;
		white-space: nowrap;
	}
	.mark-label[data-anchor='middle'] {
		transform: translateX(-50%);
	}
	.mark-label[data-anchor='end'] {
		transform: translateX(-100%);
	}
	.mark-label[data-anchor='none'] {
		left: 0;
		font-weight: 400;
		color: var(--text-muted);
	}
	.axis-row {
		margin-top: 0.25rem;
		align-items: start;
	}
	.ticks {
		position: relative;
		height: 2.4rem;
		border-top: 1px solid var(--border-input);
		font-size: var(--font-xs);
		color: var(--text-muted);
	}
	.tick {
		position: absolute;
		top: 0.2rem;
		transform: translateX(-50%);
	}
	.tick[data-edge='start'] {
		transform: none;
	}
	.tick[data-edge='end'] {
		transform: translateX(-100%);
	}
	.mar {
		position: absolute;
		top: 1.2rem;
		transform: translateX(-50%);
		color: var(--text);
		white-space: nowrap;
	}
	.mar::before {
		content: '▲ ';
	}
	.axis-title {
		margin: 0;
		font-size: var(--font-sm);
		text-align: center;
	}
	.ends {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin: 0.2rem 0 0;
		font-size: var(--font-sm);
		color: var(--text-muted);
	}
	.sw {
		display: inline-block;
		vertical-align: middle;
	}
	.sw.dot,
	.sw.ring {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
	}
	.sw.dot {
		background: var(--danger);
		border: 2px solid var(--danger);
	}
	.sw.ring {
		border: 2px solid var(--success);
	}
	.sw.line {
		height: 0.9rem;
		border-left: 2px dashed var(--text);
	}
	.notes {
		font-size: var(--font-sm);
		margin: 0.5rem 0 0;
		padding-left: 1.2rem;
	}
	.numbers {
		margin-top: 0.75rem;
	}
	.numbers summary {
		cursor: pointer;
		min-height: 24px;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		margin-top: 0.5rem;
		font-size: var(--font-sm);
	}
	th,
	td {
		border: 1px solid var(--border);
		padding: 0.35rem 0.55rem;
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}
	/* The spread is the one long cell: it wraps, the rest keep a line, and on a phone the table scrolls in its box. */
	td.spread {
		white-space: normal;
		min-width: 24rem;
	}
	.num {
		text-align: right;
	}
	/* Narrow: the level's name over its bar, the axis full width under the last. */
	@container irr (max-width: 36rem) {
		.row,
		.axis-row {
			grid-template-columns: minmax(0, 1fr);
		}
		.axis-row > span:first-child {
			display: none;
		}
		.who {
			flex-direction: row;
			flex-wrap: wrap;
			gap: 0 0.6rem;
			align-items: baseline;
		}
	}
</style>
