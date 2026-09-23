<script lang="ts">
	import { untrack } from 'svelte';
	import type { FlowShareMethod, ProjectSettings } from '@water-management/engine';
	import { api, type Project } from '$lib/api';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { fmtNum } from '$lib/format/number';
	import { WATER_YEAR_MONTHS } from '$lib/format/months';
	import { calibrationFields, parseNumberList } from './calibration';

	let {
		project,
		readonly,
		onProjectChange
	}: { project: Project; readonly: boolean; onProjectChange: (p: Project) => void } = $props();

	// Mutable view of the settings (the engine's Monthly type is a readonly tuple).
	type Editable = Omit<ProjectSettings, 'apanMm' | 'ewrPragmaticM3PerDay' | 'calibration'> & {
		apanMm: number[];
		ewrPragmaticM3PerDay: number[];
		calibration: Record<string, unknown>;
	};
	const clone = (v: ProjectSettings): Editable => JSON.parse(JSON.stringify(v));

	let s = $state<Editable>(clone(untrack(() => project.settings)));
	let saved = $state(JSON.stringify(untrack(() => project.settings)));
	let listText = $state<Record<string, string>>({});
	let listInvalid = $state<Record<string, boolean>>({});
	let saving = $state(false);
	let error = $state<string | null>(null);
	let justSaved = $state(false);

	const dirty = $derived(JSON.stringify(s) !== saved);
	const calFields = $derived(calibrationFields(s.calibration));
	const hiLoSum = $derived((s.hiLoSplit.hi || 0) + (s.hiLoSplit.lo || 0));
	const dateError = $derived(
		s.simulationStart && s.simulationEnd && s.simulationStart > s.simulationEnd
			? 'Simulation start must be before the end.'
			: null
	);
	const hasInvalidList = $derived(Object.values(listInvalid).some(Boolean));

	function resetListText() {
		listText = Object.fromEntries(
			Object.entries(s.calibration)
				.filter(([, v]) => Array.isArray(v))
				.map(([k, v]) => [k, (v as unknown[]).join(', ')])
		);
		listInvalid = {};
	}
	resetListText();

	function setList(key: string, text: string) {
		listText[key] = text;
		const parsed = parseNumberList(text);
		listInvalid[key] = parsed === null;
		if (parsed) s.calibration[key] = parsed;
	}

	function discard() {
		s = clone(JSON.parse(saved));
		resetListText();
		error = null;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (dateError || hasInvalidList) return;
		saving = true;
		error = null;
		justSaved = false;
		try {
			const p = await api.projects.update(project.id, { settings: $state.snapshot(s) as unknown as ProjectSettings });
			onProjectChange(p);
			s = clone(p.settings);
			saved = JSON.stringify(p.settings);
			resetListText();
			justSaved = true;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	const METHODS: { value: FlowShareMethod; label: string }[] = [
		{ value: 'area', label: 'By catchment area' },
		{ value: 'hiLo', label: 'Pitman high/low MAP split' },
		{ value: 'manual', label: 'Manual share per node' }
	];
</script>

<form onsubmit={save} novalidate>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

	<div class="grid">
		<section class="panel" aria-labelledby="gen-h">
			<div class="panel-head"><h2 id="gen-h">General</h2></div>
			<div class="field">
				<label for="st-erf">Effective rain fraction</label>
				<NumberInput id="st-erf" min={0} max={1} step={0.01} disabled={readonly} bind:value={s.effectiveRainFraction} aria-describedby="st-erf-h" />
				<span class="hint" id="st-erf-h">Share of rain on cropped land that offsets irrigation demand (0–1).</span>
			</div>
			<div class="field">
				<label for="st-feb">Days in February</label>
				<NumberInput id="st-feb" min={28} max={29} step={0.01} disabled={readonly} bind:value={s.februaryDays} aria-describedby="st-feb-h" />
				<span class="hint" id="st-feb-h">Used to convert monthly volumes to per-day; the workbook uses 28.25.</span>
			</div>
			<div class="form-row">
				<div class="field">
					<label for="st-start">Simulation start</label>
					<input
						id="st-start"
						type="date"
						readonly={readonly}
						value={s.simulationStart ?? ''}
						onchange={(e) => (s.simulationStart = e.currentTarget.value || null)}
					/>
				</div>
				<div class="field">
					<label for="st-end">Simulation end</label>
					<input
						id="st-end"
						type="date"
						readonly={readonly}
						value={s.simulationEnd ?? ''}
						onchange={(e) => (s.simulationEnd = e.currentTarget.value || null)}
					/>
				</div>
			</div>
			<p class="hint muted">Leave blank to simulate the full length of the input series.</p>
			{#if dateError}<p class="err" role="alert">{dateError}</p>{/if}
		</section>

		<section class="panel" aria-labelledby="flow-h">
			<div class="panel-head"><h2 id="flow-h">Flow share</h2></div>
			<div class="field">
				<label for="st-method">Method</label>
				<select id="st-method" disabled={readonly} bind:value={s.flowShareMethod}>
					{#each METHODS as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
				</select>
				<span class="hint">How each farm's share of catchment natural flow is derived.</span>
			</div>
			<fieldset class="form-row plain">
				<legend class="label">High/low MAP split</legend>
				<div class="field">
					<label for="st-hi">High</label>
					<NumberInput id="st-hi" min={0} max={1} step={0.01} disabled={readonly} bind:value={s.hiLoSplit.hi} />
				</div>
				<div class="field">
					<label for="st-lo">Low</label>
					<NumberInput id="st-lo" min={0} max={1} step={0.01} disabled={readonly} bind:value={s.hiLoSplit.lo} />
				</div>
				<div class="field">
					<span class="label">Sum</span>
					<span class="sum" class:warn={Math.abs(hiLoSum - 1) > 1e-6}>{fmtNum(hiLoSum, 3)}</span>
				</div>
			</fieldset>
			{#if s.flowShareMethod !== 'hiLo'}<p class="hint muted">Only used by the high/low method.</p>{/if}
		</section>
	</div>

	<section class="panel" aria-labelledby="monthly-h">
		<div class="panel-head">
			<h2 id="monthly-h">Monthly inputs</h2>
			<span class="muted small">Water year, October → September</span>
		</div>
		<div class="table-wrap">
			<table class="data compact monthly">
				<thead>
					<tr>
						<th scope="col">Parameter</th>
						{#each WATER_YEAR_MONTHS as m (m)}<th scope="col" class="num">{m}</th>{/each}
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">A-pan evaporation <span class="u">mm</span></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td><NumberInput label="A-pan evaporation, {m}, mm" min={0} disabled={readonly} bind:value={s.apanMm[i]} /></td>
						{/each}
					</tr>
					<tr>
						<th scope="row">Pragmatic EWR <span class="u">m³/day</span></th>
						{#each WATER_YEAR_MONTHS as m, i (m)}
							<td><NumberInput label="Pragmatic EWR, {m}, m³/day" min={0} disabled={readonly} bind:value={s.ewrPragmaticM3PerDay[i]} /></td>
						{/each}
					</tr>
				</tbody>
			</table>
		</div>
	</section>

	<section class="panel" aria-labelledby="cal-h">
		<div class="panel-head">
			<h2 id="cal-h">Flow calibration</h2>
			<span class="muted small">Rain → natural-flow parameters. Lists are comma-separated.</span>
		</div>
		<div class="cal">
			{#each calFields as f (f.key)}
				<div class="field">
					<label for="cal-{f.key}">{f.label}</label>
					{#if f.kind === 'number'}
						<NumberInput
							id="cal-{f.key}"
							disabled={readonly}
							value={f.value}
							onchange={(v) => {
								if (v !== null) s.calibration[f.key] = v;
							}}
						/>
					{:else if f.kind === 'list'}
						<input
							id="cal-{f.key}"
							readonly={readonly}
							value={listText[f.key] ?? ''}
							aria-invalid={listInvalid[f.key] || undefined}
							class:invalid={listInvalid[f.key]}
							oninput={(e) => setList(f.key, e.currentTarget.value)}
						/>
						{#if listInvalid[f.key]}<span class="err">Enter numbers separated by commas.</span>{/if}
					{:else if f.kind === 'boolean'}
						<input
							id="cal-{f.key}"
							type="checkbox"
							disabled={readonly}
							checked={f.value}
							onchange={(e) => (s.calibration[f.key] = e.currentTarget.checked)}
						/>
					{:else}
						<input id="cal-{f.key}" readonly value={JSON.stringify(f.value)} class="mono" />
						<span class="hint">Structured value — edit via the API.</span>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	{#if !readonly}
		<div class="actions">
			{#if justSaved && !dirty}<span class="muted" role="status">Settings saved.</span>{/if}
			{#if dirty}<span class="unsaved">Unsaved settings</span>{/if}
			<button type="button" class="btn" disabled={!dirty || saving} onclick={discard}>Discard</button>
			<button type="submit" class="btn btn-primary" disabled={!dirty || saving || !!dateError || hasInvalidList}>
				{saving ? 'Saving…' : 'Save settings'}
			</button>
		</div>
	{/if}
</form>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 0 1rem;
	}
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.monthly th[scope='row'] {
		white-space: nowrap;
	}
	.monthly td {
		min-width: 76px;
	}
	.plain {
		border: 0;
		padding: 0;
		margin: 0;
	}
	.plain legend {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
		margin-bottom: 0.25rem;
		padding: 0;
	}
	.plain .field {
		width: 110px;
	}
	.sum {
		padding: 0.35rem 0;
		font-variant-numeric: tabular-nums;
	}
	.sum.warn {
		color: var(--warning);
		font-weight: 600;
	}
	.cal {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0 1rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	input.invalid {
		border-color: var(--danger);
	}
	.actions {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 0.6rem;
		padding: 0.75rem 0;
		background: var(--bg);
		border-top: 1px solid var(--border);
	}
	.unsaved {
		color: var(--warning);
		font-weight: 500;
	}
</style>
