<script lang="ts">
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { describeMonths } from '$lib/format/months';
	import type { ModelEditor } from '$lib/model/editor.svelte';
	import MonthPicker from './MonthPicker.svelte';

	let { editor, readonly }: { editor: ModelEditor; readonly: boolean } = $props();

	const nodes = $derived(editor.model.nodes);
	const transfers = $derived(editor.model.transfers);
	const name = (id: string) => nodes.find((n) => n.id === id)?.name || '(unnamed)';
</script>

<section class="panel" aria-labelledby="tr-h">
	<div class="panel-head">
		<h2 id="tr-h">Transfer rules</h2>
		<span class="muted small">Water pumped or released from one node's dam to another in selected months</span>
	</div>
	{#if nodes.length < 2}
		<p class="muted">
			Transfers need at least two nodes in the network. Add them on the <a href="?tab=network">Network tab</a>.
		</p>
	{:else if transfers.length === 0}
		<div class="empty">
			<p>No transfer rules.</p>
			<p class="small">
				A transfer moves water from one node's dam to another in the months you pick, such as a pipeline pumping from a
				river dam to a unit’s dam in summer. Most catchments have none.
			</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={() => editor.addTransfer()}>Add transfer</button>{/if}
		</div>
	{:else}
		<div class="table-wrap">
			<table class="data compact rules" class:editable={!readonly}>
				<thead>
					<tr>
						<th scope="col">#</th>
						<th scope="col">From <HelpTip key="transfer.fromNodeId" /></th>
						<th scope="col">To</th>
						<th scope="col">Months <HelpTip key="transfer.months" /></th>
						<th scope="col" class="num">Max rate <HelpTip key="transfer.maxRateM3s" /><br /><span class="u">m³/s</span></th>
						<th scope="col" class="num">Daily cap<br /><span class="u">m³ (blank = none)</span></th>
						<th scope="col" class="num">Min storage <HelpTip key="transfer.minStoragePct" /><br /><span class="u">% of source dam</span></th>
						<th scope="col" class="num">Priority <HelpTip key="transfer.priority" /><br /><span class="u">lower first</span></th>
						<th scope="col">Enabled</th>
						{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each transfers as t, i (t.id)}
						{@const label = `transfer ${i + 1}`}
						<tr class:off={!t.enabled}>
							<th scope="row" class="num c-head"><span class="cell-label">Transfer{' '}</span>{i + 1}</th>
							<td class="c-from">
								<span class="cell-label">From <HelpTip key="transfer.fromNodeId" /></span>
								<select aria-label="Source of {label}" disabled={readonly} bind:value={t.fromNodeId}>
									{#if !nodes.some((n) => n.id === t.fromNodeId)}<option value={t.fromNodeId}>— choose —</option>{/if}
									{#each nodes as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
								</select>
							</td>
							<td class="c-to">
								<span class="cell-label" aria-hidden="true">To</span>
								<select aria-label="Destination of {label}" disabled={readonly} bind:value={t.toNodeId}>
									{#if !nodes.some((n) => n.id === t.toNodeId)}<option value={t.toNodeId}>— choose —</option>{/if}
									{#each nodes as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
								</select>
							</td>
							<td class="c-months">
								<span class="cell-label">Months <HelpTip key="transfer.months" /></span>
								<MonthPicker label="Months {label} runs ({describeMonths(t.months)})" disabled={readonly} bind:months={t.months} />
								<span class="sr-summary muted">{describeMonths(t.months)}</span>
							</td>
							<td class="c-rate">
								<span class="cell-label">Max rate, m³/s <HelpTip key="transfer.maxRateM3s" /></span>
								<NumberInput label="Max rate of {label}, m³/s" min={0} step={0.001} disabled={readonly} bind:value={t.maxRateM3s} />
							</td>
							<td class="c-cap">
								<span class="cell-label" aria-hidden="true">Daily cap, m³</span>
								<NumberInput label="Daily cap of {label}, m³" min={0} nullable placeholder="none" disabled={readonly} bind:value={t.dailyCapM3} />
							</td>
							<td class="c-min">
								<span class="cell-label">Min source storage, % <HelpTip key="transfer.minStoragePct" /></span>
								<NumberInput label="Minimum source storage for {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={t.minStoragePct} />
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
		{#if !readonly}<div class="toolbar after"><button type="button" class="btn" onclick={() => editor.addTransfer()}>+ Add transfer</button></div>{/if}
	{/if}
</section>

<style>
	td {
		min-width: 110px;
	}
	td.c-months {
		min-width: 340px;
	}
	.sr-summary {
		display: block;
		font-size: 0.72rem;
		margin-top: 0.15rem;
	}
	.center {
		text-align: center;
		min-width: 0;
	}
	tr.off td,
	tr.off th {
		opacity: 0.6;
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
	/* Phones: each rule becomes a card with its fields labelled, instead of a
	   table that scrolls sideways past everything but From and To. */
	.cell-label {
		display: none;
	}
	@media (max-width: 640px) {
		.rules thead {
			display: none;
		}
		.rules,
		.rules tbody {
			display: block;
		}
		.rules tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-template-areas:
				'head head'
				'from to'
				'months months'
				'rate cap'
				'min pri'
				'on on';
			gap: 0.6rem 0.75rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border);
		}
		.rules.editable tr {
			grid-template-areas:
				'head rm'
				'from to'
				'months months'
				'rate cap'
				'min pri'
				'on on';
		}
		.rules tr:last-child {
			border-bottom: none;
		}
		.rules tr > * {
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
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
		.c-head .cell-label {
			display: inline;
			font-size: inherit;
			color: inherit;
		}
		.c-from {
			grid-area: from;
		}
		.c-to {
			grid-area: to;
		}
		.c-months {
			grid-area: months;
		}
		.c-rate {
			grid-area: rate;
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
		/* The month toggles fill the card, six to a row, as tap-sized targets. */
		.c-months :global(.months) {
			display: grid;
			grid-template-columns: repeat(6, minmax(0, 1fr));
			gap: 4px;
		}
		.c-months :global(.months label) {
			width: auto;
			height: 44px;
			font-size: 0.875rem;
		}
		.c-months :global(.months .all) {
			grid-column: 1 / -1;
			margin: 0;
			min-height: 44px;
			border: 1px solid var(--border);
			justify-content: center;
		}
	}
</style>
