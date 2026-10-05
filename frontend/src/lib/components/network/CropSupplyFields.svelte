<script lang="ts">
	// A unit's crop supply table (engine ≥ 1.73.0, issue #408, docs/model.md
	// §2.7k): the crops' demand split in fixed shares between the unit's own
	// dam (under its supply rule), the river at the unit (the crops' own river
	// abstraction: its pump and pool) and the dam of another unit, through a
	// pipe. Each source is asked for its share only; what one can't give is a
	// deficit. Unticked, the crops take one water source (WaterSourceFields).
	// Ticking starts the table from that source (100 % dam or 100 % river);
	// unticking clears it. The node is the editor's own object, so edits land
	// in the model directly; the remote unit's list and the problems read the
	// network's nodes.
	import { cropSupplyIssues, hasCropShares, type NetworkNode } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import FieldHistoryLine from '$lib/components/history/FieldHistoryLine.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtNum } from '$lib/format/number';
	import FlowUnitSelect from './FlowUnitSelect.svelte';
	import { pumpUnit } from './flowUnit.svelte';
	import PumpCapacityField from './PumpCapacityField.svelte';

	let { node, nodes, rule, readonly }: { node: NetworkNode; nodes: readonly NetworkNode[]; rule: string; readonly: boolean } = $props();

	const id = (k: string) => `cs-${k}-${node.id}`;
	const unit = $derived(node.kind === 'farm' ? node.id : null);
	const on = $derived(hasCropShares(node));
	const dam = $derived(node.cropShareDam ?? 0);
	const river = $derived(node.cropShareRiver ?? 0);
	const remote = $derived(node.cropShareRemote ?? 0);
	const total = $derived(dam + river + remote);
	// The units whose dam can give a share: every other unit with a dam (whether this one drains into it is a save rule, shown below).
	const dams = $derived(nodes.filter((n) => n.kind === 'farm' && n.id !== node.id && n.damCapacityM3 > 0));
	// The engine's save rules for this unit's table, in the form's words (the unit's name is the heading above).
	const problems = $derived.by(() => {
		const out: string[] = [];
		cropSupplyIssues(nodes as NetworkNode[], [], (key, message) => {
			if (key.slice(key.indexOf(':') + 1) !== node.id) return;
			const prefix = `"${node.name}": `;
			out.push(message.startsWith(prefix) ? message.slice(prefix.length) : message);
		});
		return out;
	});

	function toggle(checked: boolean) {
		if (checked) {
			// Start from the crops' one source, so the run is unchanged until a share moves.
			const fromRiver = node.cropWaterSource === 'river';
			node.cropShareDam = fromRiver ? 0 : 1;
			node.cropShareRiver = fromRiver ? 1 : 0;
			node.cropShareRemote = 0;
		} else {
			node.cropShareDam = null;
			node.cropShareRiver = null;
			node.cropShareRemote = null;
			node.cropRemoteNodeId = null;
			node.cropRemoteCapM3Day = null;
		}
	}
	const pct = (v: number) => `${fmtNum(v * 100, 2, true)} %`;
</script>

<div class="crop-supply" data-testid="crop-supply-{node.id}">
	<label class="check">
		<input type="checkbox" disabled={readonly} checked={on} onchange={(e) => toggle(e.currentTarget.checked)} />
		Split the crops’ water between sources
		<HelpTip key="node.cropShareDam" />
	</label>
	{#if on}
		<div class="sources" role="group" aria-labelledby={id('caption')}>
			<p class="caption" id={id('caption')}>Share of the crop demand asked of each source. A source that can’t give its share leaves a deficit; it doesn’t pass to another.</p>
			<div class="source">
				<div class="field share">
					<label for={id('dam')}>This unit’s dam <span class="u">(%)</span></label>
					<NumberInput id={id('dam')} min={0} max={100} scale={100} disabled={readonly} aria-describedby="{id('dam')}-h" value={dam} onchange={(v) => (node.cropShareDam = v ?? 0)} />
					<span class="hint" id="{id('dam')}-h">Under the supply rule ({rule}).</span>
					<FieldHistoryLine field="node:{node.id}:cropShareDam" {unit} />
				</div>
			</div>
			<div class="source">
				<div class="field share">
					<label for={id('river')}>The river at this unit <span class="u">(%)</span></label>
					<NumberInput id={id('river')} min={0} max={100} scale={100} disabled={readonly} aria-describedby="{id('river')}-h" value={river} onchange={(v) => (node.cropShareRiver = v ?? 0)} />
					<span class="hint" id="{id('river')}-h">The crops’ own pump on the flow past the dam.</span>
					<FieldHistoryLine field="node:{node.id}:cropShareRiver" {unit} />
				</div>
				{#if river > 0}
					<PumpCapacityField
						idBase={id('pump')}
						label="River pump capacity"
						forWhom=" for the crops"
						value={node.cropRiverPumpM3Day ?? null}
						{readonly}
						note={(node.cropRiverPumpM3Day ?? null) === null ? 'Blank is no limit: it takes what the river offers, and the run warns.' : readonly ? 'Pumps × m³/h per pump × 24 h.' : 'Or enter the pumps and their rate to work it out (pumps × m³/h × 24 h).'}
						onchange={(v) => (node.cropRiverPumpM3Day = v)}
					>
						{#snippet history()}<FieldHistoryLine field="node:{node.id}:cropRiverPumpM3Day" {unit} />{/snippet}
					</PumpCapacityField>
					<div class="field">
						<label for={id('pool')}>Pool at the pump for the crops <span class="u">(m³)</span></label>
						<NumberInput id={id('pool')} min={0} grouped nullable placeholder="no pool" disabled={readonly} aria-describedby="{id('pool')}-h" value={node.cropRiverPoolM3 ?? null} onchange={(v) => (node.cropRiverPoolM3 = v)} />
						<span class="hint" id="{id('pool')}-h">Starts full; its surface is estimated from the capacity, for its evaporation.</span>
						<FieldHistoryLine field="node:{node.id}:cropRiverPoolM3" {unit} />
					</div>
				{/if}
			</div>
			<div class="source">
				<div class="field share">
					<label for={id('remote')}>Another unit’s dam <span class="u">(%)</span></label>
					<NumberInput id={id('remote')} min={0} max={100} scale={100} disabled={readonly} aria-describedby="{id('remote')}-h" value={remote} onchange={(v) => (node.cropShareRemote = v ?? 0)} />
					<span class="hint" id="{id('remote')}-h">The same day, from what that dam holds after its own unit is supplied.</span>
					<FieldHistoryLine field="node:{node.id}:cropShareRemote" {unit} />
				</div>
				{#if remote > 0}
					<div class="field">
						<label for={id('from')}>Which unit’s dam</label>
						<select id={id('from')} disabled={readonly} value={node.cropRemoteNodeId ?? ''} onchange={(e) => (node.cropRemoteNodeId = e.currentTarget.value || null)}>
							<option value="">Choose a unit…</option>
							{#each dams as d (d.id)}<option value={d.id}>{d.name || 'Unnamed unit'}</option>{/each}
						</select>
						{#if !dams.length}<span class="hint">No other unit has a dam yet.</span>{/if}
						<FieldHistoryLine field="node:{node.id}:cropRemoteNodeId" {unit} />
					</div>
					<div class="field">
						<span class="lbl"
							><label for={id('pipe')}>Pipe capacity{' '}<span class="visually-hidden">({pumpUnit.label})</span></label><FlowUnitSelect unit={pumpUnit} label="Unit of pipe capacity" /></span
						>
						<NumberInput id={id('pipe')} min={0} scale={pumpUnit.scale} grouped nullable placeholder="no limit" disabled={readonly} aria-describedby="{id('pipe')}-h" value={node.cropRemoteCapM3Day ?? null} onchange={(v) => (node.cropRemoteCapM3Day = v)} />
						<span class="hint" id="{id('pipe')}-h">Blank is no limit: it takes what the dam can give, and the run warns.</span>
						<FieldHistoryLine field="node:{node.id}:cropRemoteCapM3Day" {unit} />
					</div>
				{/if}
			</div>
			<p class="total" data-testid="crop-supply-total-{node.id}">Total <strong>{pct(total)}</strong></p>
			{#if problems.length}
				<ul class="problems" role="alert">
					{#each problems as p, k (k)}<li>{p}</li>{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.crop-supply {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.sources {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.caption {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.source {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
		gap: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.total {
		margin: 0;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}
	.problems {
		margin: 0;
		padding-left: 1.2rem;
		color: var(--danger);
		font-size: 0.85rem;
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select {
			min-height: 44px;
		}
	}
</style>
