<script lang="ts">
	// CSV upload with preview, used by the Data tab and the project-wide "Add
	// data" dialog. Picking (or dropping) a file guesses which stored series it
	// updates; an existing series defaults to append / update (POST
	// …/series/merge), which adds new days and corrects overlapping ones but
	// never erases a stored value the file leaves blank.
	import { untrack } from 'svelte';
	import { fromEpochDay, toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { api } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { fmtNum } from '$lib/format/number';
	import { CsvError, parseSeriesCsv, type ParsedSeries } from '$lib/series/csv';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';
	import { mergePreview, type Daily } from './coverage';
	import { guessSeries, headerLine, seriesEnd } from './freshness';
	import type { UploadResult } from './upload';
	import { valuesCache } from './valuesCache';

	let {
		projectId,
		list,
		file = null,
		idPrefix = 'up',
		onuploaded
	}: {
		projectId: string;
		list: SeriesMeta[];
		/** A file handed in from outside (drag and drop); read as soon as it changes. */
		file?: File | null;
		idPrefix?: string;
		onuploaded?: (r: UploadResult) => void | Promise<void>;
	} = $props();

	let kind = $state<string>(KIND_OPTIONS[0]!.value);
	let name = $state('');
	let unit = $state(defaultUnit(KIND_OPTIONS[0]!.value));
	let unitTouched = $state(false);
	let parsed = $state.raw<ParsedSeries | null>(null);
	let fileName = $state('');
	let parseError = $state<string | null>(null);
	let uploading = $state(false);
	let uploadDone = $state<string | null>(null);
	let error = $state<string | null>(null);
	let guessed = $state<string | null>(null);
	let fileInput: HTMLInputElement | undefined = $state();
	let mode = $state<'merge' | 'replace'>('merge');
	// A kind picked by hand is never overridden by the file-name guess.
	let kindTouched = $state(false);
	let targetValues = $state.raw<Daily | null>(null);

	const id = (s: string) => `${idPrefix}-${s}`;
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const target = $derived(list.find((s) => s.kind === kind && s.name === name.trim()) ?? null);
	const namesForKind = $derived(list.filter((s) => s.kind === kind).map((s) => s.name));
	const preview = $derived(
		parsed && target && mode === 'merge' && targetValues
			? mergePreview(targetValues, { startDate: parsed.startDate, values: parsed.values })
			: null
	);
	const normUnit = (u: string) => u.trim().toLowerCase().replace(/3/g, '³').replace(/\s+/g, '');
	const unitMismatch = $derived(target && unit.trim() && normUnit(target.unit) !== normUnit(unit) ? target.unit : null);
	// Updating a stored series: use its unit unless the user typed one.
	$effect(() => {
		if (target && !unitTouched) unit = target.unit;
	});

	// Stored values of the target series, for the merge preview.
	$effect(() => {
		const t = target;
		if (!t) {
			targetValues = null;
			return;
		}
		const key = `${projectId}/${t.id}`;
		const hit = valuesCache.get(key);
		if (hit && hit.startDate === t.startDate && hit.values.length === t.length) {
			targetValues = hit;
			return;
		}
		targetValues = null;
		api.series
			.get(projectId, t.id)
			.then((d) => {
				const v = { startDate: d.startDate, values: d.values };
				valuesCache.set(key, v);
				if (target?.id === t.id) targetValues = v;
			})
			.catch(() => {});
	});

	function onKind(k: string) {
		kind = k;
		if (!unitTouched) unit = defaultUnit(k);
		const same = list.filter((s) => s.kind === k);
		if (same.length === 1) name = same[0]!.name;
		else if (!same.some((s) => s.name === name.trim())) name = '';
	}

	async function read(f: File | null | undefined) {
		parsed = null;
		parseError = null;
		uploadDone = null;
		guessed = null;
		fileName = f?.name ?? '';
		if (!f) return;
		try {
			const text = await f.text();
			parsed = parseSeriesCsv(text);
			const g = guessSeries(f.name, headerLine(text), list);
			if (g && !kindTouched) {
				onKind(g.kind);
				name = g.name;
				mode = 'merge';
				guessed = g.name ? `${kindLabel(g.kind)} · ${g.name}` : kindLabel(g.kind);
			}
		} catch (err) {
			parseError = err instanceof CsvError ? err.message : `Could not read the file: ${msg(err)}`;
		}
	}

	$effect(() => {
		const f = file;
		if (f) untrack(() => read(f));
	});

	async function upload(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed) return;
		uploading = true;
		error = null;
		const label = name.trim() || kindLabel(kind);
		try {
			let result: UploadResult;
			if (target && mode === 'merge') {
				// Send the file's span with its blank days filled from what is
				// stored, so a partial file adds and corrects but never erases.
				const p = preview ?? mergePreview(null, { startDate: parsed.startDate, values: parsed.values });
				const off = toEpochDay(parsed.startDate) - toEpochDay(p.result.startDate);
				const meta = await api.request<SeriesMeta>('POST', `/projects/${encodeURIComponent(projectId)}/series/merge`, {
					kind,
					name: name.trim(),
					unit: unit.trim(),
					startDate: parsed.startDate,
					values: p.result.values.slice(off, off + parsed.values.length)
				});
				result = {
					meta,
					added: p.added,
					changed: p.changed,
					message: `Updated “${meta.name || kindLabel(meta.kind)}”: ${fmtNum(p.added)} new day${p.added === 1 ? '' : 's'}, ${fmtNum(p.changed)} changed. Data now runs to ${seriesEnd(meta)}.`
				};
			} else {
				const meta = await api.series.put(projectId, {
					kind,
					name: name.trim() || undefined,
					unit: unit.trim(),
					startDate: parsed.startDate,
					values: parsed.values
				});
				result = { meta, added: parsed.rowCount, changed: 0, message: `Uploaded ${fmtNum(meta.length)} days to “${meta.name || label}”.` };
			}
			valuesCache.delete(`${projectId}/${result.meta.id}`);
			uploadDone = result.message;
			parsed = null;
			fileName = '';
			guessed = null;
			if (fileInput) fileInput.value = '';
			await onuploaded?.(result);
		} catch (err) {
			error = msg(err);
		} finally {
			uploading = false;
		}
	}
</script>

<form onsubmit={upload}>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<details class="fmt">
		<summary>CSV format</summary>
		<p>Two columns, <span class="mono">date,value</span>, one row per day; a header row is optional.</p>
		<pre class="mono">date,value
2025-04-01,0.0
2025-04-02,12.4
2025-04-03,</pre>
		<ul>
			<li>Dates: YYYY-MM-DD, YYYY/MM/DD or DD/MM/YYYY.</li>
			<li>Separators: comma, semicolon or tab.</li>
			<li>Blank, NA or - = no reading (stored as a gap).</li>
			<li>Units: rainfall in mm per day; flow as the daily mean in m³/s.</li>
			<li>Name the file after the series (e.g. <span class="mono">G1 flow.csv</span>) and it is picked for you.</li>
		</ul>
	</details>
	<div class="field">
		<label for={id('file')}>CSV file</label>
		<input id={id('file')} type="file" accept=".csv,.txt,text/csv" bind:this={fileInput} onchange={(e) => read(e.currentTarget.files?.[0])} />
		{#if fileName && !fileInput?.files?.length}<span class="hint">{fileName}</span>{/if}
	</div>
	{#if guessed}<p class="hint muted guess">Looks like <strong>{guessed}</strong> — change below if not.</p>{/if}
	<div class="field">
		<label for={id('kind')}>Kind</label>
		<select id={id('kind')} value={kind} onchange={(e) => ((kindTouched = true), onKind(e.currentTarget.value))}>
			{#each KIND_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
	</div>
	<div class="form-row">
		<div class="field grow">
			<label for={id('name')}>Name <span class="muted">(optional)</span></label>
			<input id={id('name')} maxlength="100" placeholder="e.g. Station 0021" list={id('names')} bind:value={name} />
			<datalist id={id('names')}>{#each namesForKind as n (n)}<option value={n}></option>{/each}</datalist>
		</div>
		<div class="field unit">
			<label for={id('unit')}>Unit</label>
			<input id={id('unit')} required maxlength="20" bind:value={unit} oninput={() => (unitTouched = true)} />
		</div>
	</div>
	{#if target}
		<fieldset class="mode">
			<legend>“{target.name || kindLabel(target.kind)}” already exists ({target.startDate} → {seriesEnd(target)})</legend>
			<label><input type="radio" name="{idPrefix}-mode" value="merge" bind:group={mode} /> Append / update: add new days, correct overlapping ones</label>
			<label><input type="radio" name="{idPrefix}-mode" value="replace" bind:group={mode} /> Replace the whole series with this file</label>
		</fieldset>
	{:else}
		<p class="hint muted">Creates a new series. Pick an existing name to append to it instead.</p>
	{/if}
	{#if unitMismatch}
		<p class="warn-text">The stored series is in {unitMismatch}; this upload says {unit}. Values are not converted.</p>
	{/if}
	{#if parseError}
		<div class="alert alert-error" role="alert">{fileName}: {parseError}</div>
	{:else if parsed}
		<dl class="preview" aria-label="File summary">
			<div><dt>Period</dt><dd>{parsed.startDate} → {parsed.endDate}</dd></div>
			<div><dt>Days</dt><dd>{fmtNum(parsed.values.length)}</dd></div>
			<div><dt>With values</dt><dd>{fmtNum(parsed.rowCount)}</dd></div>
			<div><dt>Gaps</dt><dd>{fmtNum(parsed.missingCount)}</dd></div>
			{#if preview}
				<div><dt>New days</dt><dd class="ok">{fmtNum(preview.added)}</dd></div>
				<div><dt>Changed</dt><dd class:warn-text={preview.changed > 0}>{fmtNum(preview.changed)}</dd></div>
				<div><dt>Unchanged</dt><dd>{fmtNum(preview.unchanged)}</dd></div>
				<div><dt>Series after</dt><dd>{preview.result.startDate} → {fromEpochDay(toEpochDay(preview.result.startDate) + preview.result.values.length - 1)}</dd></div>
			{:else if target && mode === 'merge'}
				<div class="wide"><dt>Comparing with the stored series…</dt><dd></dd></div>
			{:else if target && mode === 'replace'}
				<div class="wide"><dt>Replaces</dt><dd class="warn-text">all {fmtNum(target.length)} stored days</dd></div>
			{/if}
		</dl>
		<LineChart title="File preview" height={140} {unit} series={[{ label: fileName || 'file', startDate: parsed.startDate, values: parsed.values }]} />
	{/if}
	{#if uploadDone}<p class="ok" role="status">{uploadDone}</p>{/if}
	<button type="submit" class="btn btn-primary" disabled={!parsed || uploading || !unit.trim() || (!!target && mode === 'merge' && !preview)}>
		{uploading ? 'Uploading…' : target && mode === 'merge' ? 'Upload and merge' : target ? 'Upload and replace' : 'Upload'}
	</button>
</form>

<style>
	.fmt {
		margin-bottom: 0.75rem;
		font-size: 0.85rem;
	}
	.fmt summary {
		cursor: pointer;
		font-weight: 600;
		color: var(--accent);
		min-height: 32px;
		display: flex;
		align-items: center;
	}
	.fmt pre {
		background: var(--surface-2);
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		margin: 0.4rem 0;
	}
	.fmt ul {
		margin: 0.25rem 0 0;
		padding-left: 1.1rem;
		color: var(--text-2);
	}
	.guess {
		margin: -0.25rem 0 0.5rem;
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
	.mode {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.75rem;
		display: grid;
		gap: 0.35rem;
		font-size: 0.85rem;
		min-width: 0;
	}
	.mode legend {
		font-weight: 600;
		padding: 0 0.25rem;
	}
	.mode label {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
		min-height: 28px;
	}
	.mode input {
		margin-top: 0.2rem;
		width: auto;
	}
	.warn-text {
		color: var(--warning);
		font-weight: 600;
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
	.preview .wide {
		grid-column: 1 / -1;
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
	form > .btn-primary {
		margin-top: 0.75rem;
	}
	@media (max-width: 640px) {
		.field input,
		.field select,
		form > .btn-primary {
			min-height: 44px;
		}
	}
</style>
