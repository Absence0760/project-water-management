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
		<p class="muted">Transfers need at least two nodes in the network.</p>
	{:else if transfers.length === 0}
		<div class="empty">
			<p>No transfer rules.</p>
			{#if !readonly}<button type="button" class="btn btn-primary" onclick={() => editor.addTransfer()}>Add transfer</button>{/if}
		</div>
	{:else}
		<div class="table-wrap">
			<table class="data compact">
				<thead>
					<tr>
						<th scope="col">#</th>
						<th scope="col">From <HelpTip key="transfer.fromNodeId" /></th>
						<th scope="col">To</th>
						<th scope="col">Months <HelpTip key="transfer.months" /></th>
						<th scope="col" class="num">Max rate <HelpTip key="transfer.maxRateM3s" /><br /><span class="u">m³/s</span></th>
						<th scope="col" class="num">Daily cap<br /><span class="u">m³ (blank = none)</span></th>
						<th scope="col" class="num">Min storage <HelpTip key="transfer.minStoragePct" /><br /><span class="u">% of source dam</span></th>
						<th scope="col">Enabled</th>
						{#if !readonly}<th scope="col"><span class="visually-hidden">Remove</span></th>{/if}
					</tr>
				</thead>
				<tbody>
					{#each transfers as t, i (t.id)}
						{@const label = `transfer ${i + 1}`}
						<tr class:off={!t.enabled}>
							<th scope="row" class="num">{i + 1}</th>
							<td>
								<select aria-label="Source of {label}" disabled={readonly} bind:value={t.fromNodeId}>
									{#if !nodes.some((n) => n.id === t.fromNodeId)}<option value={t.fromNodeId}>— choose —</option>{/if}
									{#each nodes as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
								</select>
							</td>
							<td>
								<select aria-label="Destination of {label}" disabled={readonly} bind:value={t.toNodeId}>
									{#if !nodes.some((n) => n.id === t.toNodeId)}<option value={t.toNodeId}>— choose —</option>{/if}
									{#each nodes as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
								</select>
							</td>
							<td>
								<MonthPicker label="Months {label} runs ({describeMonths(t.months)})" disabled={readonly} bind:months={t.months} />
								<span class="sr-summary muted">{describeMonths(t.months)}</span>
							</td>
							<td><NumberInput label="Max rate of {label}, m³/s" min={0} step={0.001} disabled={readonly} bind:value={t.maxRateM3s} /></td>
							<td><NumberInput label="Daily cap of {label}, m³" min={0} nullable placeholder="none" disabled={readonly} bind:value={t.dailyCapM3} /></td>
							<td><NumberInput label="Minimum source storage for {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={t.minStoragePct} /></td>
							<td class="center"><input type="checkbox" aria-label="{label} enabled" disabled={readonly} bind:checked={t.enabled} /></td>
							{#if !readonly}
								<td>
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
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	td {
		min-width: 110px;
	}
	td:nth-child(4) {
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
</style>
