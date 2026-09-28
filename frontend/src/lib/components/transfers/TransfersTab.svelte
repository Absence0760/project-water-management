<script lang="ts">
	// Transfers (issue #17, option A): the rules table, and under it "When
	// water moves", each month's enabled rules and the most they can move in a
	// day together (capacity.ts). On the page (`page`) the section header
	// carries the title, the count (workspace/context.ts), Show on the map and
	// + Add transfer; from 1100 × 620 the two cards fill the window, the rules
	// scrolling inside theirs. The grid modal (`grid=transfers`) and scenario
	// override mode show the table alone, with Add transfer under it.
	import { tick } from 'svelte';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { fmtNum } from '$lib/format/number';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import { monthCapacity } from './capacity';
	import MonthRates from './MonthRates.svelte';
	import type { TransferSizing, TransferSource } from '@water-management/engine';

	let { editor, readonly, page = false }: { editor: ModelEditor; readonly: boolean; /** The workspace page (not a modal or override mode). */ page?: boolean } = $props();

	const nodes = $derived(editor.model.nodes);
	const transfers = $derived(editor.model.transfers);
	const name = (id: string) => nodes.find((n) => n.id === id)?.name || '(unnamed)';
	const canAdd = $derived(!readonly && nodes.length >= 2);

	let root: HTMLDivElement | undefined = $state();
	/** Adds a rule after the others and puts the cursor in its From, scrolled into view. */
	async function add() {
		const t = editor.addTransfer();
		await tick();
		root?.querySelector<HTMLSelectElement>(`tr[data-id="${t.id}"] select`)?.focus();
	}

	// --- When water moves: the enabled rules by month, the tallest month the full bar ---
	const months = $derived(monthCapacity(transfers));
	const peak = $derived(Math.max(0, ...months.map((m) => m.maxM3Day)));
	const rulesWord = (n: number) => `${n} rule${n === 1 ? '' : 's'}`;
	const monthSentence = (m: (typeof months)[number]) =>
		m.rules ? `${m.month}: ${rulesWord(m.rules)}, up to ${fmtNum(m.maxM3Day)} m³ a day` : `${m.month}: no rule runs`;

	// --- fitting the window (the playbook's dashboards): from 1100 × 620, measured, not assumed ---
	let innerW = $state(0);
	let innerH = $state(0);
	let top = $state(0);
	const fit = $derived(page && transfers.length > 0 && nodes.length >= 2 && innerW >= 1100 && innerH >= 620);
	$effect(() => {
		if (!page || !root) return;
		const el = root;
		const measure = () => (top = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});

	$effect(() => fillHeader({ actions: headerActions }, page));
</script>

<svelte:window bind:innerWidth={innerW} bind:innerHeight={innerH} />

{#snippet headerActions()}
	{#if transfers.length && nodes.length >= 2}<a class="btn" href="?tab=network">Show on the map</a>{/if}
	{#if canAdd}<button type="button" class="btn" onclick={add}>+ Add transfer</button>{/if}
{/snippet}

<div class="transfers" class:fit bind:this={root} style:--tr-top="{top}px" data-testid="transfers">
	{#if nodes.length < 2}
		<section class="panel" aria-label="Transfer rules">
			<p class="muted">
				Transfers need at least two hydrological units in the network. Add them on the <a href="?tab=network">Network tab</a>.
			</p>
		</section>
	{:else if transfers.length === 0}
		<section class="panel" aria-label="Transfer rules">
			<div class="empty">
				<p>No transfer rules.</p>
				<p class="small">
					A transfer moves water from one hydrological unit’s dam to another, at a maximum rate you set for each month, such as a
					pipeline pumping from a river dam to a hydrological unit’s dam in summer. A river off-take takes from the river instead, like a
					canal fed from a weir. Most catchments have none.
				</p>
				{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add transfer</button>{/if}
			</div>
		</section>
	{:else}
		<section class="panel rules-card" aria-labelledby="tr-h">
			<div class="panel-head">
				<h2 id="tr-h">Transfer rules</h2>
				<span class="muted small">Water moved from one hydrological unit’s dam, or from the river there, to another hydrological unit, up to each month’s rate</span>
			</div>
			<div class="table-wrap">
				<table class="data compact rules" class:editable={!readonly}>
					<thead>
						<tr>
							<th scope="col" class="num">#</th>
							<th scope="col">From → To <HelpTip key="transfer.fromNodeId" /></th>
							<th scope="col">Max rate by month <HelpTip key="transfer.monthlyRateM3s" /><br /><span class="u">m³/s, blank = off</span></th>
							<th scope="col" class="num">Daily cap<br /><span class="u">m³, blank = none</span></th>
							<th scope="col">Takes from <HelpTip key="transfer.source" /><br /><span class="u">dam: min storage %; river: off-take</span></th>
							<th scope="col" class="num">Priority <HelpTip key="transfer.priority" /><br /><span class="u">lower first</span></th>
							<th scope="col" class="center"><span aria-hidden="true">On</span><span class="visually-hidden">Enabled</span></th>
							{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each transfers as t, i (t.id)}
							{@const label = `transfer ${i + 1}`}
							<tr class:off={!t.enabled} data-id={t.id}>
								<th scope="row" class="num c-head"><span class="cell-label">Transfer{' '}</span>{i + 1}{#if !t.enabled}{' '}<span class="off-tag">off</span>{/if}</th>
								<td class="c-route">
									<div class="route">
										<div class="end">
											<span class="cell-label">From <HelpTip key="transfer.fromNodeId" /></span>
											<select aria-label="Source of {label}" disabled={readonly} bind:value={t.fromNodeId}>
												{#if !nodes.some((n) => n.id === t.fromNodeId)}<option value={t.fromNodeId}>— choose —</option>{/if}
												{#each nodes as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
											</select>
										</div>
										<span class="arrow" aria-hidden="true">→</span>
										<div class="end">
											<span class="cell-label" aria-hidden="true">To</span>
											<select aria-label="Destination of {label}" disabled={readonly} bind:value={t.toNodeId}>
												{#if !nodes.some((n) => n.id === t.toNodeId)}<option value={t.toNodeId}>— choose —</option>{/if}
												{#each nodes as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
											</select>
										</div>
									</div>
								</td>
								<td class="c-months">
									<span class="cell-label">Max rate by month, m³/s <HelpTip key="transfer.monthlyRateM3s" /></span>
									<MonthRates rule={t} {label} disabled={readonly} />
								</td>
								<td class="c-cap">
									<span class="cell-label" aria-hidden="true">Daily cap, m³</span>
									<NumberInput label="Daily cap of {label}, m³" min={0} nullable placeholder="none" disabled={readonly} bind:value={t.dailyCapM3} />
								</td>
								<td class="c-min">
									<span class="cell-label">Takes from <HelpTip key="transfer.source" /></span>
									<!-- The source's dam (§2.6) or the river leaving the source unit today: a river off-take (engine ≥ 1.14.0, §2.6a). -->
									<select aria-label="Where {label} takes its water" disabled={readonly} value={t.source ?? 'dam'} onchange={(e) => (t.source = e.currentTarget.value as TransferSource)}>
										<option value="dam">The source’s dam</option>
										<option value="river">The river (an off-take)</option>
									</select>
									{#if (t.source ?? 'dam') === 'river'}
										<div class="offtake" data-testid="offtake-fields">
											<span class="sub">Hands-off flow, m³/day <HelpTip key="transfer.handsOffM3Day" /></span>
											<NumberInput label="Hands-off flow for {label}, m³/day" min={0} nullable placeholder="none" disabled={readonly} value={t.handsOffM3Day ?? null} onchange={(v) => (t.handsOffM3Day = v)} />
											<span class="sub">Losses on the way, % <HelpTip key="transfer.lossPct" /></span>
											<NumberInput label="Conveyance losses of {label}, %" min={0} max={99.9} scale={100} disabled={readonly} value={t.lossPct ?? 0} onchange={(v) => (t.lossPct = v ?? 0)} />
											<span class="sub">Takes <HelpTip key="transfer.sizing" /></span>
											<select aria-label="How much {label} takes" disabled={readonly} value={t.sizing ?? 'demand'} onchange={(e) => (t.sizing = e.currentTarget.value as TransferSizing)}>
												<option value="demand">What the destination needs</option>
												<option value="capacity">Up to capacity</option>
											</select>
											<label class="check">
												<input type="checkbox" aria-label="{label} leaves the EWR in the river" disabled={readonly} checked={!!t.handsOffEwr} onchange={(e) => (t.handsOffEwr = e.currentTarget.checked)} />
												<span aria-hidden="true">Leaves the EWR in the river</span>
											</label>
											<label class="check">
												<input type="checkbox" aria-label="{label} tops up the destination’s dam" disabled={readonly} checked={!!t.topUpDam} onchange={(e) => (t.topUpDam = e.currentTarget.checked)} />
												<span aria-hidden="true">Tops up the destination’s dam</span>
											</label>
										</div>
									{:else}
										<span class="sub">Min source storage, % <HelpTip key="transfer.minStoragePct" /></span>
										<NumberInput label="Minimum source storage for {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={t.minStoragePct} />
									{/if}
								</td>
								<td class="c-pri">
									<span class="cell-label" aria-hidden="true">Priority</span>
									<NumberInput label="Priority of {label} (lower moves first)" step={1} disabled={readonly} bind:value={t.priority} />
								</td>
								<td class="center c-on">
									<label class="on-toggle">
										<input type="checkbox" aria-label="{label} enabled" disabled={readonly} bind:checked={t.enabled} />
										<span class="cell-label" aria-hidden="true">Enabled</span>
									</label>
								</td>
								{#if !readonly}
									<td class="c-rm">
										<button type="button" class="btn btn-icon" aria-label="Remove {label} ({name(t.fromNodeId)} → {name(t.toNodeId)})" title="Remove transfer" onclick={() => editor.removeTransfer(t.id)}>✕</button>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if !page && !readonly}<div class="toolbar after"><button type="button" class="btn" onclick={add}>+ Add transfer</button></div>{/if}
		</section>

		{#if page}
			<section class="panel months-card" aria-labelledby="tr-months-h">
				<div class="panel-head">
					<h2 id="tr-months-h">When water moves</h2>
					<span class="muted small">The most the enabled rules can move in a day, m³, before each dam’s own limits</span>
				</div>
				<ol class="mbars" aria-labelledby="tr-months-h" data-testid="transfer-months">
					{#each months as m (m.month)}
						<li class:none={!m.rules}>
							<span class="track" aria-hidden="true" style:--h="{peak > 0 ? (100 * m.maxM3Day) / peak : 0}%">
								<span class="bar"></span>
								<span class="v">{m.rules ? fmtNum(m.maxM3Day) : '–'}</span>
							</span>
							<span class="m" aria-hidden="true">{m.month}</span>
							<span class="n" aria-hidden="true">{m.rules ? rulesWord(m.rules) : 'none'}</span>
							<span class="visually-hidden">{monthSentence(m)}</span>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	{/if}
</div>

<style>
	.transfers {
		container: transfers / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.transfers > .panel {
		margin: 0;
	}
	/* Wide and tall enough: the two cards are the height left in the window (less the save bar); the rules
	   scroll inside theirs and When water moves takes what they leave. */
	.transfers.fit {
		height: max(460px, calc(100vh - var(--tr-top, 0px) - var(--dock-h, 0px) - 1rem));
	}
	.fit .rules-card {
		flex: 0 1 auto;
		min-height: 12rem;
		display: flex;
		flex-direction: column;
	}
	.fit .rules-card .table-wrap {
		flex: 1 1 auto;
		min-height: 0;
		max-height: none;
	}
	.fit .months-card {
		flex: 1 0 9.5rem;
		display: flex;
		flex-direction: column;
	}
	.fit .mbars {
		flex: 1 1 auto;
	}
	.panel-head .small {
		overflow-wrap: anywhere;
	}
	.rules thead th {
		white-space: normal;
		vertical-align: bottom;
	}
	.rules .u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.rules td.c-route {
		min-width: 12rem;
	}
	/* Six month rates to a row: wide enough for 0.0125 in each. */
	.rules td.c-months {
		min-width: 22rem;
	}
	.route {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.25rem;
	}
	.arrow {
		display: none;
	}
	.center {
		text-align: center;
	}
	/* Takes from: the source's dam (its minimum storage) or a river off-take's fields, stacked. */
	.rules td.c-min {
		min-width: 12.5rem;
	}
	.c-min select,
	.offtake select {
		width: 100%;
	}
	.c-min .sub {
		display: block;
		margin-top: 0.3rem;
		font-size: 0.72rem;
		color: var(--text-2);
	}
	.offtake .check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.3rem;
		font-size: 0.8rem;
		cursor: pointer;
		white-space: nowrap;
		/* Each switch at least 24 px apart from the next (WCAG 2.5.8). */
		min-height: 24px;
	}
	/* Not the data table's full-width inputs (app.css): a box beside its words. */
	.rules td .offtake .check input[type='checkbox'] {
		flex: none;
		width: 1rem;
		margin: 0;
	}
	/* A rule switched off: a tinted row and "off" in words by its number (not faded text, which fails contrast). */
	.rules tr.off {
		background: var(--surface-2);
	}
	.off-tag {
		display: block;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-2);
	}
	.after {
		margin: 0.75rem 0 0;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty .small {
		max-width: 60ch;
		margin: 0 auto 1rem;
	}

	/* When water moves: a bar per month with its figure above and the month and rule count below. */
	.months-card .panel-head {
		margin-bottom: 0.5rem;
	}
	.mbars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(12, minmax(0, 1fr));
		gap: 0.4rem;
		min-height: 7.5rem;
	}
	.mbars li {
		display: grid;
		grid-template-rows: minmax(3.5rem, 1fr) auto auto;
		justify-items: center;
		gap: 0.15rem;
		min-width: 0;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	/* The figure sits on its bar; the track keeps a line clear above the tallest one for it. */
	.mbars .track {
		position: relative;
		width: 100%;
		border-bottom: 1px solid var(--border-strong);
		margin-top: 1.3rem;
	}
	.mbars .bar {
		position: absolute;
		bottom: 0;
		left: 50%;
		translate: -50% 0;
		width: min(100%, 3.5rem);
		height: var(--h);
		background: var(--accent);
		border-radius: 3px 3px 0 0;
	}
	.mbars .v {
		position: absolute;
		bottom: calc(var(--h) + 0.15rem);
		left: 50%;
		translate: -50% 0;
		font-weight: 600;
		white-space: nowrap;
	}
	.mbars .m {
		font-weight: 600;
		color: var(--text-2);
	}
	.mbars .n,
	.mbars .none .v {
		color: var(--text-muted);
		font-size: 0.72rem;
		white-space: nowrap;
	}

	.cell-label {
		display: none;
	}
	/* Wide: From and To side by side, with an arrow between. */
	@container transfers (min-width: 80rem) {
		.rules td.c-route {
			min-width: 24rem;
		}
		.route {
			grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
			align-items: center;
		}
		.arrow {
			display: inline;
			color: var(--text-muted);
		}
	}
	/* Narrow: each rule becomes a card with its fields labelled, instead of a table that scrolls sideways
	   past everything but From and To; two cards to a row where there is room. The page scrolls, not a box. */
	@container transfers (max-width: 64rem) {
		.rules-card .table-wrap {
			max-height: none;
			border: 0;
			background: none;
		}
		.rules thead {
			display: none;
		}
		.rules,
		.rules tbody {
			display: block;
		}
		.rules tbody {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
			gap: 0.75rem;
		}
		.rules tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-template-areas:
				'head head'
				'route route'
				'months months'
				'cap pri'
				'min min'
				'on on';
			gap: 0.6rem 0.75rem;
			padding: 0.75rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: var(--surface);
		}
		.rules.editable tr {
			grid-template-areas:
				'head rm'
				'route route'
				'months months'
				'cap pri'
				'min min'
				'on on';
		}
		.rules tr > * {
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
		}
		.rules td.c-route,
		.rules td.c-months {
			min-width: 0;
		}
		.rules td :global(input[type='number']) {
			min-width: 0;
		}
		.cell-label {
			display: block;
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-2);
			margin-bottom: 0.15rem;
		}
		.c-head {
			grid-area: head;
			align-self: center;
			font-weight: 600;
		}
		.c-head .off-tag {
			display: inline;
			margin-left: 0.5rem;
		}
		.c-head .cell-label {
			display: inline;
			font-size: inherit;
			color: inherit;
		}
		.c-route {
			grid-area: route;
		}
		.route {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.75rem;
		}
		.arrow {
			display: none;
		}
		.c-months {
			grid-area: months;
		}
		.c-cap {
			grid-area: cap;
		}
		.c-min {
			grid-area: min;
		}
		.c-pri {
			grid-area: pri;
		}
		.c-on {
			grid-area: on;
			align-self: end;
		}
		.c-rm {
			grid-area: rm;
			justify-self: end;
		}
		.on-toggle {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			min-height: 44px;
			cursor: pointer;
		}
		.on-toggle input {
			width: 1.25rem;
			height: 1.25rem;
		}
		.on-toggle .cell-label {
			margin: 0;
			font-size: 0.875rem;
		}
		/* The off-take's switches at tap size, their words part of the target. */
		.offtake .check {
			min-height: 44px;
			font-size: 0.875rem;
		}
		.rules td .offtake .check input[type='checkbox'] {
			width: 1.25rem;
			height: 1.25rem;
		}
		.c-min select {
			min-height: 44px;
		}
		/* The month rates fill the card, six to a row, as tap-sized fields; the button beside the words. */
		.c-months :global(.rates input) {
			min-height: 44px;
			font-size: 0.875rem;
		}
		.c-months :global(.rates .all) {
			min-height: 44px;
			border: 1px solid var(--border);
			justify-content: center;
		}
		/* The months six to a row as well. */
		.mbars {
			grid-template-columns: repeat(6, minmax(0, 1fr));
			row-gap: 0.75rem;
			min-height: 0;
		}
		.mbars li {
			grid-template-rows: 3rem auto auto;
		}
	}
</style>
