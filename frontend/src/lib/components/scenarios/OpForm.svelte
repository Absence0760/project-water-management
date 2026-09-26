<script lang="ts">
	// "Add a change": one form for every op of the engine's ScenarioOp union
	// (docs/scenarios.md § Op catalogue). It picks targets from the model as
	// the ops already listed leave it (so a node the scenario added can be
	// changed next), shows the value a field has now, and builds the op with
	// buildOp, which runs the engine's validator. Whether the op applies to
	// the base run is the server's check, shown in the list after saving.
	import { LAND_COVER_CLASSES, PE_SOURCE_MAX, SCALABLE_SERIES_KINDS, SCENARIO_OP_NAMES, type ModelInput, type PeKind, type ScenarioOp, type ScenarioOpName } from '@water-management/engine';
	import { PE_KIND_OPTIONS } from '$lib/components/settings/peInput';
	import { kindLabel } from '$lib/series/kinds';
	import { MONTH_NAMES, NODE_FIELD_SPECS, SETTINGS_FIELDS, TRANSFER_FIELDS, formatValue, nodeFields, peDraftOf, settingsValue, valueText, type ValueSpec } from './fields';
	import { OP_LABEL, buildOp, draftSpec, emptyDraft, type OpDraft } from './ops';

	let {
		input,
		onadd,
		disabled = false
	}: {
		/** The input a new op meets: the base run with the listed ops applied. */
		input: ModelInput;
		onadd: (op: ScenarioOp) => Promise<boolean>;
		disabled?: boolean;
	} = $props();

	let d = $state<OpDraft>(emptyDraft());
	let error = $state<string | null>(null);
	let busy = $state(false);

	const nodes = $derived(input.model.nodes);
	const farms = $derived(nodes.filter((n) => n.kind === 'farm'));
	const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
	const node = $derived(nodes.find((n) => n.id === d.nodeId));
	const transfer = $derived(input.model.transfers.find((t) => t.id === d.transferId));
	const spec = $derived(draftSpec(d));

	/** The value the picked field has now, in the input the op meets. */
	const current = $derived.by<unknown>(() => {
		if (d.kind === 'node.set') return node && d.field ? (node as unknown as Record<string, unknown>)[d.field] : undefined;
		if (d.kind === 'transfer.set') return transfer && d.field ? (transfer as unknown as Record<string, unknown>)[d.field] : undefined;
		if (d.kind === 'settings.set') return d.field ? settingsValue(input.settings, d.field) : undefined;
		return undefined;
	});
	const currentArea = $derived(
		d.kind === 'cropArea.set' && d.nodeId && d.cropId
			? input.model.cropAreas.filter((a) => a.nodeId === d.nodeId && a.cropId === d.cropId).reduce((s, a) => s + a.areaM2, 0)
			: null
	);
	const fieldOptions = $derived.by(() => {
		if (d.kind === 'node.set') return node ? nodeFields(node.kind).map((f) => ({ value: f.field, label: f.label })) : [];
		if (d.kind === 'transfer.set') return TRANSFER_FIELDS.map((f) => ({ value: f.field, label: f.label }));
		if (d.kind === 'settings.set') return SETTINGS_FIELDS.map((f) => ({ value: f.path, label: f.label }));
		return [];
	});

	/** Start the value at what the field holds now, so a small change is a small edit. */
	function prefill() {
		const s = draftSpec(d);
		d.value = s ? valueText(s, current) : '';
		d.months = s?.t === 'months' && Array.isArray(current) ? [...(current as number[])] : [];
		if (s?.t === 'pe') d.pe = peDraftOf(current, input.settings);
	}
	/** Switch the PE input's kind: a new monthly row starts from the PE GR4J runs on now (the Settings form's rule). */
	function pickPeKind(kind: PeKind) {
		d.pe = kind === d.pe.kind ? d.pe : peDraftOf(current, input.settings, kind);
	}
	function pickKind(kind: ScenarioOpName) {
		d = emptyDraft(kind);
		error = null;
	}
	function pickNode(id: string) {
		d.nodeId = id;
		// A field the new node's kind doesn't have is dropped (a gauge has only a name).
		if (d.kind === 'node.set' && !fieldOptions.some((f) => f.value === d.field)) d.field = '';
		prefill();
	}
	function copyFactors(cropId: string) {
		const c = input.model.crops.find((x) => x.id === cropId);
		if (c) d.cropFactors = c.cropFactor.join(' ');
	}
	function toggleMonth(m: number, on: boolean) {
		d.months = on ? [...d.months, m].sort((a, b) => a - b) : d.months.filter((x) => x !== m);
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const r = buildOp(d, input.model);
		if (!r.ok) {
			error = r.error;
			return;
		}
		error = null;
		busy = true;
		try {
			if (await onadd(r.op)) d = emptyDraft(d.kind);
		} finally {
			busy = false;
		}
	}

	const nowText = (s: ValueSpec, v: unknown) => `Now: ${formatValue(s, v, nodeName)}`;
</script>

{#snippet valueField(s: ValueSpec, label: string)}
	{#if s.t === 'pe'}
		<fieldset class="pe">
			<legend>{label}</legend>
			<div class="form-row">
				<div class="field">
					<label for="op-pe-kind">PE comes from</label>
					<select id="op-pe-kind" value={d.pe.kind} onchange={(e) => pickPeKind(e.currentTarget.value as PeKind)}>
						{#each PE_KIND_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</select>
				</div>
				{#if d.pe.kind === 'monthly'}
					<div class="field grow">
						<label for="op-pe-mm">Monthly PE (mm, Oct to Sep)</label>
						<input id="op-pe-mm" type="text" placeholder="12 values, or one for every month" bind:value={d.pe.mm} />
					</div>
				{/if}
			</div>
			{#if d.pe.kind === 'monthly'}
				<div class="field">
					<label for="op-pe-source">Source of the monthly PE (required)</label>
					<textarea id="op-pe-source" rows="2" maxlength={PE_SOURCE_MAX} bind:value={d.pe.source}></textarea>
					<span class="hint">Where the values come from, e.g. a station's FAO-56 ET₀ and its years. At most {PE_SOURCE_MAX} characters.</span>
				</div>
			{/if}
			<!-- Unset is pan × A-pan (a project saved before engine 0.31.0), so there is always a "now". -->
			<span class="hint" data-testid="op-current">{nowText(s, current ?? null)}</span>
		</fieldset>
	{:else if s.t === 'months'}
		<fieldset class="months">
			<legend>{label}</legend>
			{#each MONTH_NAMES as name, i (name)}
				<label><input type="checkbox" checked={d.months.includes(i + 1)} onchange={(e) => toggleMonth(i + 1, e.currentTarget.checked)} /> {name}</label>
			{/each}
		</fieldset>
	{:else}
		<div class="field grow">
			<label for="op-value">{label}{'unit' in s && s.unit ? ` (${s.unit})` : ''}</label>
			{#if s.t === 'enum'}
				<select id="op-value" bind:value={d.value}>
					{#if s.nullable}<option value="">{s.nullLabel ?? 'none'}</option>{:else}<option value="" disabled>Pick one</option>{/if}
					{#each s.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
				</select>
			{:else if s.t === 'bool'}
				<select id="op-value" bind:value={d.value}>
					<option value="" disabled>Pick one</option>
					<option value="true">Yes</option>
					<option value="false">No</option>
				</select>
			{:else if s.t === 'node'}
				<select id="op-value" bind:value={d.value}>
					<option value="" disabled>Pick a farm</option>
					{#each farms as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			{:else}
				<input
					id="op-value"
					type="text"
					inputmode={s.t === 'number' ? 'decimal' : undefined}
					placeholder={s.t === 'date' ? `YYYY-MM-DD, or empty for ${s.nullLabel}` : s.t === 'monthly' ? '12 values, Oct to Sep, or one for every month' : s.t === 'number' && s.nullable ? `empty for ${s.nullLabel ?? 'none'}` : undefined}
					bind:value={d.value}
				/>
			{/if}
			{#if current !== undefined}<span class="hint" data-testid="op-current">{nowText(s, current)}</span>{/if}
		</div>
	{/if}
{/snippet}

<form class="op-form" onsubmit={submit} aria-labelledby="op-form-h" novalidate>
	<h3 id="op-form-h">Add a change</h3>
	<div class="form-row">
		<div class="field">
			<label for="op-kind">Kind of change</label>
			<select id="op-kind" value={d.kind} onchange={(e) => pickKind(e.currentTarget.value as ScenarioOpName)}>
				{#each SCENARIO_OP_NAMES as k (k)}<option value={k}>{OP_LABEL[k]}</option>{/each}
			</select>
		</div>

		{#if d.kind === 'node.set' || d.kind === 'node.remove'}
			<div class="field">
				<label for="op-node">Node</label>
				<select id="op-node" value={d.nodeId} onchange={(e) => pickNode(e.currentTarget.value)}>
					<option value="" disabled>Pick a node</option>
					{#each d.kind === 'node.remove' ? nodes.filter((n) => n.downstreamNodeId !== null) : nodes as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
		{:else if d.kind === 'cropArea.set' || d.kind === 'landCover.add'}
			<div class="field">
				<label for="op-node">Farm</label>
				<select id="op-node" bind:value={d.nodeId}>
					<option value="" disabled>Pick a farm</option>
					{#each farms as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
		{:else if d.kind === 'transfer.set' || d.kind === 'transfer.remove'}
			<div class="field">
				<label for="op-transfer">Transfer</label>
				<select
					id="op-transfer"
					value={d.transferId}
					onchange={(e) => {
						d.transferId = e.currentTarget.value;
						prefill();
					}}
				>
					<option value="" disabled>Pick a transfer</option>
					{#each input.model.transfers as t, i (t.id)}<option value={t.id}>{i + 1}: {nodeName(t.fromNodeId)} → {nodeName(t.toNodeId)}</option>{/each}
				</select>
			</div>
		{:else if d.kind === 'landCover.remove'}
			<div class="field">
				<label for="op-patch">Land-cover patch</label>
				<select id="op-patch" bind:value={d.patchId}>
					<option value="" disabled>Pick a patch</option>
					{#each input.model.landCover ?? [] as p (p.id)}
						<option value={p.id}>{nodeName(p.nodeId)}: {LAND_COVER_CLASSES.find((c) => c.id === p.coverClass)?.label ?? p.coverClass}, {p.areaKm2} km²</option>
					{/each}
				</select>
			</div>
		{/if}

		{#if d.kind === 'node.set' || d.kind === 'transfer.set' || d.kind === 'settings.set'}
			<div class="field">
				<label for="op-field">{d.kind === 'settings.set' ? 'Setting' : 'Field'}</label>
				<select
					id="op-field"
					value={d.field}
					disabled={d.kind === 'node.set' && !node}
					onchange={(e) => {
						d.field = e.currentTarget.value;
						prefill();
					}}
				>
					<option value="" disabled>{d.kind === 'node.set' && !node ? 'Pick a node first' : 'Pick one'}</option>
					{#each fieldOptions as f (f.value)}<option value={f.value}>{f.label}</option>{/each}
				</select>
			</div>
		{/if}
	</div>

	{#if spec && d.field}
		<div class="form-row">
			{@render valueField(spec, d.kind === 'node.set' ? NODE_FIELD_SPECS[d.field as keyof typeof NODE_FIELD_SPECS].label : (fieldOptions.find((f) => f.value === d.field)?.label ?? 'Value'))}
		</div>
	{/if}

	{#if d.kind === 'node.add'}
		<div class="form-row">
			<div class="field">
				<label for="op-new-kind">Kind</label>
				<select id="op-new-kind" bind:value={d.newKind}>
					<option value="farm">Farm</option>
					<option value="user">Other water user</option>
				</select>
			</div>
			<div class="field grow">
				<label for="op-new-name">Name</label>
				<input id="op-new-name" type="text" maxlength="100" bind:value={d.newName} />
			</div>
			<div class="field">
				<label for="op-down">Drains into</label>
				<select id="op-down" bind:value={d.downstreamNodeId}>
					<option value="" disabled>Pick a node</option>
					{#each nodes as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
			{#if d.newKind === 'farm'}
				<div class="field">
					<label for="op-new-dam">Dam capacity (m³)</label>
					<input id="op-new-dam" type="text" inputmode="decimal" bind:value={d.damCapacityM3} />
				</div>
			{:else}
				<div class="field">
					<label for="op-new-demand">Demand (m³/day, every month)</label>
					<input id="op-new-demand" type="text" inputmode="decimal" bind:value={d.demandM3Day} />
				</div>
			{/if}
		</div>
		<p class="hint">A new node is a leaf, with no land of its own; change its other values with “Change a node's value” once it is added.</p>
	{:else if d.kind === 'cropArea.set'}
		<div class="form-row">
			<div class="field">
				<label for="op-crop">Crop</label>
				<select id="op-crop" bind:value={d.cropId}>
					<option value="" disabled>Pick a crop</option>
					{#each input.model.crops as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="op-area">Area (ha)</label>
				<input id="op-area" type="text" inputmode="decimal" bind:value={d.areaHa} />
				{#if currentArea !== null}<span class="hint" data-testid="op-current">Now: {currentArea / 10_000} ha; 0 removes the crop from the farm</span>{/if}
			</div>
		</div>
	{:else if d.kind === 'crop.add'}
		<div class="form-row">
			<div class="field">
				<label for="op-crop-name">Name</label>
				<input id="op-crop-name" type="text" maxlength="100" bind:value={d.cropName} />
			</div>
			{#if input.model.crops.length}
				<div class="field">
					<label for="op-crop-copy">Start from the factors of</label>
					<select id="op-crop-copy" value="" onchange={(e) => copyFactors(e.currentTarget.value)}>
						<option value="">No crop</option>
						{#each input.model.crops as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
					</select>
				</div>
			{/if}
			<div class="field grow">
				<label for="op-crop-factors">Crop factors (Oct to Sep)</label>
				<input id="op-crop-factors" type="text" bind:value={d.cropFactors} placeholder="12 values, or one for every month" />
			</div>
		</div>
		<p class="hint">Plant it on a farm with “Set a farm's crop area” once it is added.</p>
	{:else if d.kind === 'transfer.add'}
		<div class="form-row">
			<div class="field">
				<label for="op-from">Source</label>
				<select id="op-from" bind:value={d.fromNodeId}>
					<option value="" disabled>Pick a farm</option>
					{#each farms as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="op-to">Destination</label>
				<select id="op-to" bind:value={d.toNodeId}>
					<option value="" disabled>Pick a farm</option>
					{#each farms as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="op-rate">Maximum rate (m³/s)</label>
				<input id="op-rate" type="text" inputmode="decimal" bind:value={d.maxRateM3s} />
			</div>
			<div class="field">
				<label for="op-cap">Daily cap (m³)</label>
				<input id="op-cap" type="text" inputmode="decimal" placeholder="empty for no cap" bind:value={d.dailyCapM3} />
			</div>
			<div class="field">
				<label for="op-min">Source dam minimum level (%)</label>
				<input id="op-min" type="text" inputmode="decimal" bind:value={d.minStoragePct} />
			</div>
			<div class="field">
				<label for="op-prio">Priority</label>
				<input id="op-prio" type="text" inputmode="numeric" bind:value={d.priority} />
			</div>
		</div>
		<fieldset class="months">
			<legend>Months it runs</legend>
			{#each MONTH_NAMES as name, i (name)}
				<label><input type="checkbox" checked={d.months.includes(i + 1)} onchange={(e) => toggleMonth(i + 1, e.currentTarget.checked)} /> {name}</label>
			{/each}
		</fieldset>
	{:else if d.kind === 'landCover.add'}
		<div class="form-row">
			<div class="field">
				<label for="op-cover">Land cover</label>
				<select id="op-cover" bind:value={d.coverClass}>
					{#each LAND_COVER_CLASSES as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="op-cover-area">Area (km²)</label>
				<input id="op-cover-area" type="text" inputmode="decimal" bind:value={d.coverAreaKm2} />
			</div>
			<div class="field">
				<label for="op-density">Condensed cover (%)</label>
				<input id="op-density" type="text" inputmode="decimal" bind:value={d.densityPct} />
			</div>
		</div>
	{:else if d.kind === 'series.scale'}
		<div class="form-row">
			<div class="field">
				<label for="op-series">Rain series</label>
				<select id="op-series" bind:value={d.seriesKind}>
					{#each SCALABLE_SERIES_KINDS as k (k)}<option value={k}>{kindLabel(k)}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="op-change">Change (%)</label>
				<input id="op-change" type="text" inputmode="decimal" placeholder="e.g. −10" bind:value={d.changePct} />
			</div>
			<div class="field">
				<label for="op-from-day">From (YYYY-MM-DD)</label>
				<input id="op-from-day" type="text" placeholder="empty for the start" bind:value={d.from} />
			</div>
			<div class="field">
				<label for="op-to-day">To (YYYY-MM-DD)</label>
				<input id="op-to-day" type="text" placeholder="empty for the end" bind:value={d.to} />
			</div>
		</div>
		<p class="hint">Scales recorded rain only; missing days stay missing. Evaporation is the A-pan setting (“Change a setting”).</p>
	{/if}

	<div class="actions">
		<button type="submit" class="btn btn-primary" disabled={disabled || busy}>{busy ? 'Adding…' : 'Add change'}</button>
		{#if error}<span class="err" role="alert">{error}</span>{/if}
	</div>
</form>

<style>
	.op-form {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	.op-form h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	.field {
		min-width: 10rem;
	}
	.field.grow {
		flex: 1 1 16rem;
	}
	.months {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.75rem;
		margin: 0 0 0.75rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.pe {
		flex: 1 1 100%;
		margin: 0 0 0.75rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.pe legend,
	.months legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.months label {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-height: 32px;
	}
	.hint {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin: 0 0 0.75rem;
	}
	.actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.6rem;
	}
	.err {
		color: var(--danger);
	}
	@media (max-width: 640px) {
		.field {
			min-width: 0;
			flex: 1 1 100%;
		}
		.months label {
			min-height: var(--tap);
		}
	}
</style>
