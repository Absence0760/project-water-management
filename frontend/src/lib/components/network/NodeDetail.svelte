<script lang="ts">
	// One node's fields as a labelled form with help text — the small-screen
	// (and "focus on one node") alternative to the wide network table.
	import { BOREHOLE_RULES, IRRIGATION_SYSTEMS, type BoreholeRule, type LandCoverPatch, type NetworkNode, type NodeKind } from '@water-management/engine';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fmtPct } from '$lib/format/number';
	import { damHints, GROUPS, isPct, NODE_FIELDS, setNodeField, systemOf, type NodeField } from './fields';
	import UserFields from './UserFields.svelte';
	import LandCoverFields from './LandCoverFields.svelte';

	let {
		node,
		nodes,
		share,
		readonly,
		onremove,
		onmove,
		canMoveUp = false,
		canMoveDown = false,
		onmakeoutlet,
		landCover = [],
		onaddcover,
		onremovecover,
		farmersNote = null,
		previewHref = null
	}: {
		node: NetworkNode;
		nodes: NetworkNode[];
		/** Computed flow share (0–1) with the current method; null for gauges. */
		share: number | null;
		readonly: boolean;
		onremove?: () => void;
		onmove?: (delta: -1 | 1) => void;
		canMoveUp?: boolean;
		canMoveDown?: boolean;
		onmakeoutlet?: () => void;
		/** This node's land-cover patches (WP-1.35; farms only). */
		landCover?: LandCoverPatch[];
		onaddcover?: () => void;
		onremovecover?: (id: string) => void;
		/** "N farmers are linked…" for a farm with linked farmers (WP-2.1); null otherwise. */
		farmersNote?: string | null;
		/** A farm's page as its farmer sees it (WP-2.6); null for other nodes. */
		previewHref?: string | null;
	} = $props();

	const groups = $derived.by(() => {
		const out = new Map<NodeField['group'], NodeField[]>();
		for (const f of NODE_FIELDS) {
			if (f.farmOnly && node.kind !== 'farm') continue;
			if (f.notGauge && node.kind === 'gauge') continue;
			// An other water user has no land, dam or routing of its own (WP-1.33), but may have boreholes (WP-1.34).
			if (node.kind === 'user' && f.group !== 'groundwater') continue;
			if (!out.has(f.group)) out.set(f.group, []);
			out.get(f.group)!.push(f);
		}
		return [...out];
	});
	const id = (k: string) => `nd-${k}-${node.id}`;
	const BOREHOLE_RULE_LABEL: Record<BoreholeRule, string> = {
		supplemental: 'Supplemental: after the dam and river',
		primary: 'Primary: first, the dam and river cover the rest',
		drought: 'Drought: supplemental while the dam is below the trigger'
	};
	const hints = $derived(damHints(node));
</script>

<div class="detail">
	<div class="ident">
		<div class="field">
			<label for={id('name')}>Name</label>
			<input id={id('name')} maxlength="100" readonly={readonly} bind:value={node.name} />
		</div>
		<div class="field">
			<span class="lbl"><label for={id('kind')}>Kind</label><HelpTip key="node.kind" /></span>
			<select id={id('kind')} disabled={readonly} bind:value={node.kind}>
				<option value={'farm' satisfies NodeKind}>Farm (or stand-alone dam)</option>
				<option value={'gauge' satisfies NodeKind}>Gauge</option>
				<option value={'user' satisfies NodeKind}>Other water user (town, industry, unlisted)</option>
			</select>
		</div>
		<div class="field">
			<span class="lbl"><label for={id('down')}>Drains into</label><HelpTip key="node.downstreamNodeId" /></span>
			<select
				id={id('down')}
				disabled={readonly}
				value={node.downstreamNodeId ?? ''}
				onchange={(e) => (node.downstreamNodeId = e.currentTarget.value || null)}
			>
				<option value="">— Outlet (none) —</option>
				{#each nodes as other (other.id)}
					{#if other.id !== node.id}<option value={other.id}>{other.name || '(unnamed)'}</option>{/if}
				{/each}
			</select>
			<span class="hint">
				{node.downstreamNodeId === null
					? 'This is the outflow gauge: the catchment outlet where simulated outflow is compared with observed flow and the EWR.'
					: 'The node directly downstream. Its outflow joins that node’s upstream inflow.'}
			</span>
		</div>
	</div>

	{#if farmersNote}<p class="hint gauge-note" role="note">{farmersNote}</p>{/if}
	{#if previewHref}<p class="hint gauge-note"><a href={previewHref}>Preview as farmer</a>: this farm’s page as its farmer sees it, from the current publication.</p>{/if}
	{#if node.kind === 'gauge'}
		<p class="hint gauge-note">
			A gauge passes all upstream flow through; it has no dam, demand or flow share of its own.
		</p>
	{:else if node.kind === 'user'}
		<p class="hint gauge-note">
			An other water user takes its demand from the river where it sits, with no land, dam or crops of its own.
		</p>
		<fieldset>
			<legend>Other water user</legend>
			<UserFields {node} {readonly} />
		</fieldset>
	{/if}

	{#each groups as [g, fields] (g)}
		<fieldset>
			<legend>{GROUPS[g]}</legend>
			<div class="grid">
				{#each fields as f (f.key)}
					<div class="field">
						<span class="lbl"><label for={id(f.key)}>{f.label} <span class="u">({f.unit})</span></label><HelpTip key={`node.${f.key}`} /></span>
						<NumberInput
							id={id(f.key)}
							min={0}
							max={isPct(f) ? 100 : undefined}
							scale={isPct(f) ? 100 : 1}
							nullable={f.nullable}
							grouped={!isPct(f)}
							placeholder={f.nullable ? 'not set' : undefined}
							disabled={readonly}
							aria-describedby="{id(f.key)}-h"
							value={node[f.key] ?? null}
							onchange={(v) => setNodeField(node, f.key, v)}
						/>
						<span class="hint" id="{id(f.key)}-h">{f.help}</span>
					</div>
				{/each}
				{#if g === 'irrigation'}
					<div class="field">
						<span class="lbl"><label for={id('system')}>Irrigation system</label><HelpTip key="node.irrigationEfficiency" /></span>
						<select
							id={id('system')}
							disabled={readonly}
							value={systemOf(node.irrigationEfficiency) ?? ''}
							aria-describedby="{id('system')}-h"
							onchange={(e) => {
								const s = IRRIGATION_SYSTEMS.find((x) => x.id === e.currentTarget.value);
								if (s) node.irrigationEfficiency = s.efficiency;
							}}
						>
							<option value="">Other (efficiency as entered)</option>
							{#each IRRIGATION_SYSTEMS as s (s.id)}
								<option value={s.id}>{s.label}: {Math.round(s.efficiency * 100)} % (indicative)</option>
							{/each}
						</select>
						<span class="hint" id="{id('system')}-h">Sets an indicative efficiency for the system; a scheme's own measurement is better.</span>
					</div>
				{/if}
				{#if g === 'groundwater'}
					<div class="field">
						<span class="lbl"><label for={id('bh-rule')}>Borehole rule</label><HelpTip key="node.boreholeRule" /></span>
						<select id={id('bh-rule')} disabled={readonly} value={node.boreholeRule ?? 'supplemental'} onchange={(e) => (node.boreholeRule = e.currentTarget.value as BoreholeRule)}>
							{#each BOREHOLE_RULES as r (r)}<option value={r}>{BOREHOLE_RULE_LABEL[r]}</option>{/each}
						</select>
					</div>
				{/if}
				{#if g === 'dam'}
					{#each hints as h (h)}
						<p class="hint dam-hint" role="note">{h}</p>
					{/each}
				{/if}
				{#if g === 'share' && share !== null}
					<div class="field">
						<span class="label">Share in use</span>
						<span class="computed">{fmtPct(share, 2)}</span>
						<span class="hint">With the current flow-share method. Saved settings only.</span>
					</div>
				{/if}
			</div>
		</fieldset>
	{/each}

	{#if node.kind === 'farm'}
		<fieldset>
			<legend>Land cover</legend>
			<LandCoverFields {node} patches={landCover} {readonly} onadd={onaddcover} onremove={onremovecover} />
		</fieldset>
	{/if}

	{#if !readonly}
		<div class="actions">
			{#if onmove}
				<button type="button" class="btn" disabled={!canMoveUp} onclick={() => onmove(-1)}>Move up the list</button>
				<button type="button" class="btn" disabled={!canMoveDown} onclick={() => onmove(1)}>Move down the list</button>
			{/if}
			{#if onmakeoutlet && node.downstreamNodeId !== null}
				<button type="button" class="btn" onclick={onmakeoutlet} title="This node drains nowhere; the current outflow gauge drains into it">
					Make outflow gauge
				</button>
			{/if}
			<span class="spacer"></span>
			{#if onremove}
				<button type="button" class="btn btn-danger" onclick={onremove}>Remove {node.name || 'this node'}</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.ident {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0 1rem;
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	fieldset {
		border: 0;
		border-top: 1px solid var(--border);
		margin: 0.25rem 0 0;
		padding: 0.75rem 0 0;
	}
	legend {
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0 0.4rem 0 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 0 1rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.lbl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.lbl label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	/* Read-only values sit under their label rather than at the far right. */
	.detail :global(input:read-only) {
		text-align: left;
	}
	.computed {
		padding: 0.35rem 0;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.dam-hint {
		grid-column: 1 / -1;
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
	}
	.gauge-note {
		margin: 0 0 0.5rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.actions {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.spacer {
		flex: 1;
	}
	@media (max-width: 640px) {
		.actions .btn {
			min-height: 44px;
		}
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select {
			min-height: 44px;
		}
	}
</style>
