<script lang="ts">
	import { onMount } from 'svelte';
	import { fromEpochDay, toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { api } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fmtNum } from '$lib/format/number';
	import { CsvError, parseSeriesCsv, type ParsedSeries } from '$lib/series/csv';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';

	let { projectId, readonly }: { projectId: string; readonly: boolean } = $props();

	let list = $state<SeriesMeta[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	let selectedId = $state<string | null>(null);
	let viewing = $state<(SeriesMeta & { values: (number | null)[] }) | null>(null);
	let viewLoading = $state(false);
	let viewError = $state<string | null>(null);

	// Upload form
	let kind = $state<string>(KIND_OPTIONS[0]!.value);
	let name = $state('');
	let unit = $state(defaultUnit(KIND_OPTIONS[0]!.value));
	let unitTouched = $state(false);
	let parsed = $state<ParsedSeries | null>(null);
	let fileName = $state('');
	let parseError = $state<string | null>(null);
	let uploading = $state(false);
	let uploadDone = $state<string | null>(null);
	let fileInput: HTMLInputElement | undefined = $state();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const endDate = (s: { startDate: string; length: number }) => fromEpochDay(toEpochDay(s.startDate) + s.length - 1);

	async function load() {
		loading = true;
		loadError = null;
		try {
			list = await api.series.list(projectId);
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function view(id: string) {
		selectedId = id;
		viewLoading = true;
		viewError = null;
		try {
			viewing = await api.series.get(projectId, id);
		} catch (e) {
			viewError = msg(e);
			viewing = null;
		} finally {
			viewLoading = false;
		}
	}

	async function remove(s: SeriesMeta) {
		if (!confirm(`Delete the series "${s.name || kindLabel(s.kind)}"? Runs already stored are not affected.`)) return;
		actionError = null;
		try {
			await api.series.remove(projectId, s.id);
			list = list.filter((x) => x.id !== s.id);
			if (selectedId === s.id) {
				selectedId = null;
				viewing = null;
			}
		} catch (e) {
			actionError = msg(e);
		}
	}

	function onKind(k: string) {
		kind = k;
		if (!unitTouched) unit = defaultUnit(k);
	}

	async function onFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		parsed = null;
		parseError = null;
		uploadDone = null;
		fileName = file?.name ?? '';
		if (!file) return;
		try {
			parsed = parseSeriesCsv(await file.text());
		} catch (err) {
			parseError = err instanceof CsvError ? err.message : `Could not read the file: ${msg(err)}`;
		}
	}

	async function upload(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed) return;
		uploading = true;
		actionError = null;
		try {
			const meta = await api.series.put(projectId, {
				kind,
				name: name.trim() || undefined,
				unit: unit.trim(),
				startDate: parsed.startDate,
				values: parsed.values
			});
			uploadDone = `Uploaded ${fmtNum(meta.length)} days to “${meta.name || kindLabel(meta.kind)}”.`;
			parsed = null;
			fileName = '';
			if (fileInput) fileInput.value = '';
			await load();
			await view(meta.id);
		} catch (err) {
			actionError = msg(err);
		} finally {
			uploading = false;
		}
	}
</script>

{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}

<div class="layout">
	<section class="panel" aria-labelledby="ser-h">
		<div class="panel-head"><h2 id="ser-h">Input time series</h2></div>
		<LoadState
			{loading}
			error={loadError}
			retry={load}
			empty={list.length === 0}
			emptyText="No time series yet. Upload daily rainfall and flow records as CSV files."
		>
			<div class="table-wrap">
				<table class="data">
					<thead>
						<tr>
							<th scope="col">Kind</th>
							<th scope="col">Name</th>
							<th scope="col">Unit</th>
							<th scope="col">Start</th>
							<th scope="col">End</th>
							<th scope="col" class="num">Days</th>
							<th scope="col"><span class="visually-hidden">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{#each list as s (s.id)}
							<tr class:selected={s.id === selectedId}>
								<th scope="row">{kindLabel(s.kind)}</th>
								<td>{s.name || '–'}</td>
								<td>{s.unit}</td>
								<td class="num">{s.startDate}</td>
								<td class="num">{endDate(s)}</td>
								<td class="num">{fmtNum(s.length)}</td>
								<td class="act">
									<button
										type="button"
										class="btn btn-sm"
										aria-pressed={s.id === selectedId}
										onclick={() => view(s.id)}
									>
										View
									</button>
									{#if !readonly}
										<button type="button" class="btn btn-sm btn-danger" onclick={() => remove(s)} aria-label="Delete {s.name || kindLabel(s.kind)}">
											Delete
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</LoadState>
	</section>

	{#if !readonly}
		<section class="panel" aria-labelledby="up-h">
			<div class="panel-head"><h2 id="up-h">Upload CSV</h2></div>
			<form onsubmit={upload}>
				<p class="hint muted">
					Two columns: <span class="mono">date,value</span> (header optional). Dates as YYYY-MM-DD or DD/MM/YYYY;
					missing days are stored as gaps. Uploading the same kind and name replaces it.
				</p>
				<div class="field">
					<label for="up-kind">Kind</label>
					<select id="up-kind" value={kind} onchange={(e) => onKind(e.currentTarget.value)}>
						{#each KIND_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</select>
				</div>
				<div class="form-row">
					<div class="field grow">
						<label for="up-name">Name <span class="muted">(optional)</span></label>
						<input id="up-name" maxlength="100" placeholder="e.g. Station 0021" bind:value={name} />
					</div>
					<div class="field unit">
						<label for="up-unit">Unit</label>
						<input id="up-unit" required maxlength="20" bind:value={unit} oninput={() => (unitTouched = true)} />
					</div>
				</div>
				<div class="field">
					<label for="up-file">CSV file</label>
					<input id="up-file" type="file" accept=".csv,.txt,text/csv" bind:this={fileInput} onchange={onFile} />
				</div>
				{#if parseError}
					<div class="alert alert-error" role="alert">{fileName}: {parseError}</div>
				{:else if parsed}
					<dl class="preview" aria-label="File summary">
						<div><dt>Period</dt><dd>{parsed.startDate} → {parsed.endDate}</dd></div>
						<div><dt>Days</dt><dd>{fmtNum(parsed.values.length)}</dd></div>
						<div><dt>With values</dt><dd>{fmtNum(parsed.rowCount)}</dd></div>
						<div><dt>Gaps</dt><dd>{fmtNum(parsed.missingCount)}</dd></div>
					</dl>
				{/if}
				{#if uploadDone}<p class="ok" role="status">{uploadDone}</p>{/if}
				<button type="submit" class="btn btn-primary" disabled={!parsed || uploading || !unit.trim()}>
					{uploading ? 'Uploading…' : 'Upload'}
				</button>
			</form>
		</section>
	{/if}
</div>

{#if selectedId}
	<section class="panel" aria-labelledby="chart-h">
		<h2 id="chart-h" class="visually-hidden">Series chart</h2>
		<LoadState loading={viewLoading} error={viewError} retry={() => selectedId && view(selectedId)}>
			{#if viewing}
				<LineChart
					title="{kindLabel(viewing.kind)}{viewing.name ? ` · ${viewing.name}` : ''}"
					unit={viewing.unit}
					series={[{ label: viewing.name || kindLabel(viewing.kind), startDate: viewing.startDate, values: viewing.values }]}
				/>
			{/if}
		</LoadState>
	</section>
{/if}

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 360px;
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 1000px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	tr.selected {
		background: var(--accent-soft);
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
	.act .btn + .btn {
		margin-left: 0.25rem;
	}
	.grow {
		flex: 1;
	}
	.unit {
		width: 90px;
	}
	.field input,
	.field select {
		width: 100%;
	}
	.preview {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.4rem 1rem;
		margin: 0 0 0.75rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-2);
		border-radius: var(--radius-sm);
		font-size: 0.85rem;
	}
	.preview dt {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.preview dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.ok {
		color: var(--success);
	}
</style>
