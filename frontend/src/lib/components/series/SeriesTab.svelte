<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fromEpochDay, observedAgreement, toEpochDay, type SeriesMeta } from '@water-management/engine';
	import { api, type RunMeta } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import DownloadMenu from '$lib/components/export/DownloadMenu.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { downloads } from '$lib/export';
	import { fmtNum } from '$lib/format/number';
	import { CsvError, parseSeriesCsv, type ParsedSeries } from '$lib/series/csv';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';
	import { coverageBins, coverageStats, daysBetween, describeAge, mergePreview, type Daily } from './coverage';
	import AgreementTable from './AgreementTable.svelte';
	import CoverageStrip from './CoverageStrip.svelte';
	import { KIND_ROLES, seriesInUse } from './roles';
	import { valuesCache } from './valuesCache';

	let {
		projectId,
		readonly,
		initial = null,
		runs = null,
		onSeriesChange
	}: {
		projectId: string;
		readonly: boolean;
		/** Already-loaded list (the page's), so the first frame has the final layout. */
		initial?: SeriesMeta[] | null;
		runs?: RunMeta[] | null;
		onSeriesChange?: (list: SeriesMeta[]) => void;
	} = $props();

	let list = $state<SeriesMeta[]>(untrack(() => initial ?? []));
	let loading = $state(untrack(() => initial === null));
	let loadError = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	// Full values per series (for coverage and the chart). Input series are few
	// (one per kind, a handful of names), so fetching them all is cheap.
	// $state.raw: 16k-value daily arrays must not be wrapped in deep reactive
	// proxies — reading them element by element froze the Runs tab. Replace, never mutate.
	let values = $state.raw<Record<string, Daily>>({});
	const today = new Date().toISOString().slice(0, 10);

	let selectedId = $state<string | null>(null);
	const viewing = $derived(list.find((s) => s.id === selectedId) ?? null);
	let flowLog = $state(false);

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const endDate = (s: { startDate: string; length: number }) => fromEpochDay(toEpochDay(s.startDate) + s.length - 1);
	const inUse = $derived(seriesInUse(list));
	const latestRun = $derived(runs?.[0] ?? null);
	const isRain = (k: string) => k.startsWith('rain_');

	async function load() {
		if (!list.length) loading = true;
		loadError = null;
		try {
			list = await api.series.list(projectId);
			onSeriesChange?.(list);
			void loadValues();
		} catch (e) {
			loadError = msg(e);
		} finally {
			loading = false;
		}
	}
	onMount(() => {
		if (initial) void loadValues();
		void load();
	});

	async function loadValues() {
		await Promise.all(
			list.map(async (s) => {
				const key = `${projectId}/${s.id}`;
				const hit = valuesCache.get(key);
				if (hit && hit.startDate === s.startDate && hit.values.length === s.length) {
					values = { ...values, [s.id]: hit };
					return;
				}
				try {
					const d = await api.series.get(projectId, s.id);
					const v = { startDate: d.startDate, values: d.values };
					valuesCache.set(key, v);
					values = { ...values, [s.id]: v };
				} catch {
					/* coverage cells stay "–" */
				}
			})
		);
		if (!selectedId && list.length) selectedId = pickDefault(list);
	}

	// Default chart: observed flow if present, else the main rainfall.
	function pickDefault(l: SeriesMeta[]): string {
		const prefer = ['flow_observed_m3s', 'rain_catchment_mm'];
		for (const k of prefer) {
			const s = l.find((x) => x.kind === k && inUse.has(x.id));
			if (s) return s.id;
		}
		return l[0]!.id;
	}

	const stats = $derived(
		Object.fromEntries(list.map((s) => [s.id, values[s.id] ? coverageStats(values[s.id]!, s.kind) : null]))
	);
	const bins = $derived(Object.fromEntries(list.map((s) => [s.id, values[s.id] ? coverageBins(values[s.id]!) : []])));
	const newestDate = $derived(list.reduce((m, s) => (endDate(s) > m ? endDate(s) : m), ''));
	const newerThanRun = $derived(
		latestRun ? list.filter((s) => KIND_ROLES[s.kind]?.driver !== false && inUse.has(s.id) && endDate(s) > latestRun.endDate) : []
	);

	// Gauge vs logger, when both records exist (first of each kind by name, as a run reads them).
	const agreement = $derived.by(() => {
		const first = (k: string) =>
			[...list].filter((s) => s.kind === k).sort((a, b) => a.name.localeCompare(b.name))[0];
		const o = first('flow_observed_m3s');
		const l = first('flow_logger_m3s');
		const vo = o && values[o.id];
		const vl = l && values[l.id];
		return vo && vl ? observedAgreement({ flow_observed_m3s: vo, flow_logger_m3s: vl }) : null;
	});

	async function remove(s: SeriesMeta) {
		if (!confirm(`Delete the series "${s.name || kindLabel(s.kind)}"? Runs already stored are not affected.`)) return;
		actionError = null;
		try {
			await api.series.remove(projectId, s.id);
			list = list.filter((x) => x.id !== s.id);
			onSeriesChange?.(list);
			if (selectedId === s.id) selectedId = list[0]?.id ?? null;
		} catch (e) {
			actionError = msg(e);
		}
	}

	// --- upload ---------------------------------------------------------------
	let kind = $state<string>(KIND_OPTIONS[0]!.value);
	let name = $state('');
	let unit = $state(defaultUnit(KIND_OPTIONS[0]!.value));
	let unitTouched = $state(false);
	let parsed = $state.raw<ParsedSeries | null>(null);
	let fileName = $state('');
	let parseError = $state<string | null>(null);
	let uploading = $state(false);
	let uploadDone = $state<string | null>(null);
	let fileInput: HTMLInputElement | undefined = $state();
	let mode = $state<'merge' | 'replace'>('merge');

	const target = $derived(list.find((s) => s.kind === kind && s.name === name.trim()) ?? null);
	const namesForKind = $derived(list.filter((s) => s.kind === kind).map((s) => s.name));
	const targetValues = $derived(target ? (values[target.id] ?? null) : null);
	const preview = $derived(
		parsed && target && mode === 'merge' && targetValues
			? mergePreview(targetValues, { startDate: parsed.startDate, values: parsed.values })
			: null
	);
	const unitMismatch = $derived(target && unit.trim() && target.unit !== unit.trim() ? target.unit : null);

	function onKind(k: string) {
		kind = k;
		if (!unitTouched) unit = defaultUnit(k);
		// Pre-select the series of that kind to update, if there is exactly one.
		const same = list.filter((s) => s.kind === k);
		if (same.length === 1) name = same[0]!.name;
		else if (!same.some((s) => s.name === name.trim())) name = '';
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
		const label = name.trim() || kindLabel(kind);
		try {
			let meta: SeriesMeta;
			if (target && mode === 'merge') {
				// Send the file's span with its blank days filled from what is
				// stored, so a partial file adds and corrects but never erases.
				const p = preview ?? mergePreview(null, { startDate: parsed.startDate, values: parsed.values });
				const off = toEpochDay(parsed.startDate) - toEpochDay(p.result.startDate);
				meta = await api.request<SeriesMeta>('POST', `/projects/${encodeURIComponent(projectId)}/series/merge`, {
					kind,
					name: name.trim(),
					unit: unit.trim(),
					startDate: parsed.startDate,
					values: p.result.values.slice(off, off + parsed.values.length)
				});
				uploadDone = `Updated “${meta.name || kindLabel(meta.kind)}”: ${fmtNum(p.added)} new day${p.added === 1 ? '' : 's'}, ${fmtNum(p.changed)} changed. Data now runs to ${endDate(meta)}.`;
			} else {
				meta = await api.series.put(projectId, {
					kind,
					name: name.trim() || undefined,
					unit: unit.trim(),
					startDate: parsed.startDate,
					values: parsed.values
				});
				uploadDone = `Uploaded ${fmtNum(meta.length)} days to “${meta.name || label}”.`;
			}
			valuesCache.delete(`${projectId}/${meta.id}`);
			values = Object.fromEntries(Object.entries(values).filter(([id]) => id !== meta.id));
			parsed = null;
			fileName = '';
			if (fileInput) fileInput.value = '';
			await load();
			selectedId = meta.id;
		} catch (err) {
			actionError = msg(err);
		} finally {
			uploading = false;
		}
	}

	const typical = (s: SeriesMeta) => {
		const st = stats[s.id];
		if (!st) return '…';
		if (isRain(s.kind)) return st.meanAnnualMm === null ? '–' : `${fmtNum(st.meanAnnualMm)} mm/a`;
		return st.meanDaily === null ? '–' : `${fmtNum(st.meanDaily, st.meanDaily < 1 ? 3 : 2)} ${s.unit}`;
	};
</script>

{#if actionError}<div class="alert alert-error" role="alert">{actionError}</div>{/if}

{#if newerThanRun.length && latestRun}
	<div class="alert alert-info" role="status">
		New data since the latest run: {newerThanRun.map((s) => s.name || kindLabel(s.kind)).join(', ')} now run{newerThanRun.length === 1 ? 's' : ''}
		to {newestDate}, but “{latestRun.label || 'the latest run'}” ends {latestRun.endDate}.
		<a href="?tab=runs">Re-run the model</a> to include it.
	</div>
{/if}

<section class="panel" aria-labelledby="ser-h">
	<div class="panel-head">
		<h2 id="ser-h">Input time series</h2>
		{#if list.length}
			<span class="muted small">Daily values · {list.length} series{newestDate ? ` · data up to ${newestDate} (${describeAge(daysBetween(newestDate, today))})` : ''}</span>
		{/if}
	</div>
	<LoadState
		{loading}
		error={loadError}
		retry={load}
		empty={list.length === 0}
		emptyText="No time series yet. Upload daily rainfall (and, to calibrate, observed flow at the outflow gauge) as CSV files."
	>
		<div class="table-wrap">
			<table class="data series">
				<thead>
					<tr>
						<th scope="col">Series</th>
						<th scope="col">Period</th>
						<th scope="col">Data up to</th>
						<th scope="col" class="num">Missing<br /><span class="u">% of days</span></th>
						<th scope="col" class="num">Typical<br /><span class="u">mean</span></th>
						<th scope="col" class="cov">Coverage by year</th>
						<th scope="col"><span class="visually-hidden">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each list as s (s.id)}
						{@const st = stats[s.id]}
						{@const end = endDate(s)}
						{@const age = daysBetween(st?.lastValueDate ?? end, today)}
						{@const role = KIND_ROLES[s.kind]}
						<tr class:selected={s.id === selectedId}>
							<th scope="row">
								<span class="kind">{kindLabel(s.kind)}</span>
								<span class="nm">{s.name || '–'} <span class="u">({s.unit})</span></span>
								{#if role}
									<span class="role" class:unused={!inUse.has(s.id)} title={role.help}>
										{inUse.has(s.id)
											? role.role
											: s.kind === 'flow_logger_m3s' && !list.some((x) => x.kind === s.kind && inUse.has(x.id))
												? 'Calibration if chosen in settings'
												: 'Not used (another series of this kind is)'}
									</span>
								{/if}
							</th>
							<td class="num period">{s.startDate} →<br />{end}</td>
							<td class="upto">
								<span class="num">{st?.lastValueDate ?? end}</span>
								<span class="age" class:stale={age > 31}>{describeAge(age)}</span>
							</td>
							<td class="num" class:warn={st && st.missingPct >= 5}>{st ? fmtNum(st.missingPct, 1) : '…'}</td>
							<td class="num">{typical(s)}</td>
							<td class="cov">
								{#if values[s.id]}
									<CoverageStrip bins={bins[s.id] ?? []} byMonth={s.length < 3 * 365} label="Coverage of {s.name || kindLabel(s.kind)}" />
									<span class="range"><span>{s.startDate.slice(0, 4)}</span><span>{end.slice(0, 4)}</span></span>
								{:else}
									<span class="strip-ph" aria-hidden="true"></span>
								{/if}
							</td>
							<td class="act">
								<div class="acts">
								<button type="button" class="btn btn-sm" aria-pressed={s.id === selectedId} onclick={() => (selectedId = s.id)}>View</button>
								<DownloadMenu label="CSV" items={[{ label: `${s.name || kindLabel(s.kind)} (CSV)`, url: downloads.series(projectId, s.id), hint: `${s.startDate} → ${end}` }]} />
								{#if !readonly}
									<button type="button" class="btn btn-sm btn-danger" onclick={() => remove(s)} aria-label="Delete {s.name || kindLabel(s.kind)}">Delete</button>
								{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="muted small key">
			<span class="sw full"></span> complete year <span class="sw part"></span> some days missing <span class="sw none"></span> no data.
			Rainfall "typical" = mean annual total; flow = mean daily flow.
		</p>
	</LoadState>
</section>

{#if viewing}
	<section class="panel" aria-labelledby="chart-h">
		<h2 id="chart-h" class="visually-hidden">Series chart</h2>
		{#if values[viewing.id]}
			<LineChart
				title="{kindLabel(viewing.kind)}{viewing.name ? ` · ${viewing.name}` : ''}"
				unit={isRain(viewing.kind) ? 'mm/day' : viewing.unit}
				series={[{ label: viewing.name || kindLabel(viewing.kind), startDate: values[viewing.id]!.startDate, values: values[viewing.id]!.values }]}
				logToggle={!isRain(viewing.kind)}
				bind:log={flowLog}
				recentDays={3 * 365}
				recentLabel="Last 3 years"
			/>
		{:else}
			<div class="chart-ph" role="status">Loading series…</div>
		{/if}
	</section>
{/if}

{#if agreement}
	<section class="panel" aria-label="Gauge vs logger agreement">
		<AgreementTable {agreement} headingLevel={2} />
	</section>
{/if}

<div class="lower">
	<section class="panel" aria-labelledby="use-h">
		<div class="panel-head"><h2 id="use-h">What the model uses</h2></div>
		<dl class="roles">
			{#each KIND_OPTIONS as o (o.value)}
				{@const r = KIND_ROLES[o.value]}
				{@const have = list.some((s) => s.kind === o.value)}
				<div>
					<dt>{o.label} <HelpTip key={`series.${o.value}`} /> {#if have}<span class="have">✓ loaded</span>{/if}</dt>
					<dd>{r?.help}</dd>
				</div>
			{/each}
		</dl>
		<p class="muted small">
			A run needs at least one rainfall series (or Pitman flow); its period is the span of those series unless Settings sets one.
			With several series of one kind, the first by name is used.
		</p>
	</section>

	{#if !readonly}
		<section class="panel" aria-labelledby="up-h">
			<div class="panel-head"><h2 id="up-h">Upload CSV</h2></div>
			<form onsubmit={upload}>
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
					</ul>
				</details>
				<div class="field">
					<label for="up-kind">Kind</label>
					<select id="up-kind" value={kind} onchange={(e) => onKind(e.currentTarget.value)}>
						{#each KIND_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
					</select>
				</div>
				<div class="form-row">
					<div class="field grow">
						<label for="up-name">Name <span class="muted">(optional)</span></label>
						<input id="up-name" maxlength="100" placeholder="e.g. Station 0021" list="up-names" bind:value={name} />
						<datalist id="up-names">{#each namesForKind as n (n)}<option value={n}></option>{/each}</datalist>
					</div>
					<div class="field unit">
						<label for="up-unit">Unit</label>
						<input id="up-unit" required maxlength="20" bind:value={unit} oninput={() => (unitTouched = true)} />
					</div>
				</div>
				{#if target}
					<fieldset class="mode">
						<legend>“{target.name || kindLabel(target.kind)}” already exists ({target.startDate} → {endDate(target)})</legend>
						<label><input type="radio" name="mode" value="merge" bind:group={mode} /> Append / update: add new days, correct overlapping ones</label>
						<label><input type="radio" name="mode" value="replace" bind:group={mode} /> Replace the whole series with this file</label>
					</fieldset>
				{:else}
					<p class="hint muted">Creates a new series. Pick an existing name to append to it instead.</p>
				{/if}
				{#if unitMismatch}
					<p class="warn-text">The stored series is in {unitMismatch}; this upload says {unit}. Values are not converted.</p>
				{/if}
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
						{#if preview}
							<div><dt>New days</dt><dd class="ok">{fmtNum(preview.added)}</dd></div>
							<div><dt>Changed</dt><dd class:warn-text={preview.changed > 0}>{fmtNum(preview.changed)}</dd></div>
							<div><dt>Unchanged</dt><dd>{fmtNum(preview.unchanged)}</dd></div>
							<div><dt>Series after</dt><dd>{preview.result.startDate} → {fromEpochDay(toEpochDay(preview.result.startDate) + preview.result.values.length - 1)}</dd></div>
						{:else if target && mode === 'replace'}
							<div class="wide"><dt>Replaces</dt><dd class="warn-text">all {fmtNum(target.length)} stored days</dd></div>
						{/if}
					</dl>
					<LineChart
						title="File preview"
						height={140}
						unit={unit}
						series={[{ label: fileName || 'file', startDate: parsed.startDate, values: parsed.values }]}
					/>
				{/if}
				{#if uploadDone}<p class="ok" role="status">{uploadDone}</p>{/if}
				<button type="submit" class="btn btn-primary" disabled={!parsed || uploading || !unit.trim()}>
					{uploading ? 'Uploading…' : target && mode === 'merge' ? 'Upload and merge' : target ? 'Upload and replace' : 'Upload'}
				</button>
			</form>
		</section>
	{/if}
</div>

<style>
	.small {
		font-size: 0.8rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
	}
	.series th[scope='row'] {
		min-width: 190px;
	}
	.kind {
		display: block;
		font-weight: 600;
	}
	.nm {
		display: block;
		font-weight: 400;
		color: var(--text-2);
		font-size: 0.82rem;
	}
	.role {
		display: inline-block;
		margin-top: 0.15rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		cursor: help;
	}
	.role.unused {
		background: var(--surface-2);
		color: var(--text-muted);
	}
	.period {
		font-size: 0.82rem;
		text-align: left;
	}
	.upto .num {
		display: block;
		text-align: left;
	}
	.age {
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.age.stale {
		color: var(--warning);
		font-weight: 600;
	}
	.warn {
		color: var(--warning);
		font-weight: 600;
	}
	.cov {
		min-width: 150px;
		width: 22%;
	}
	.range {
		display: flex;
		justify-content: space-between;
		font-size: 0.7rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.strip-ph {
		display: block;
		height: 14px;
		margin-bottom: 1rem;
		border-radius: 2px;
		background: var(--surface-2);
	}
	tr.selected {
		background: var(--accent-soft);
	}
	.act {
		text-align: right;
		white-space: nowrap;
	}
	.acts {
		display: flex;
		gap: 0.3rem;
		justify-content: flex-end;
		align-items: center;
	}
	.key {
		margin: 0.5rem 0 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
	}
	.sw {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 2px;
		margin-left: 0.4rem;
	}
	.sw.full {
		background: var(--brand-outlet);
		margin-left: 0;
	}
	.sw.part {
		background: color-mix(in srgb, var(--warning) 70%, transparent);
	}
	.sw.none {
		background: color-mix(in srgb, var(--danger) 55%, transparent);
	}
	.chart-ph {
		height: 380px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}
	.lower {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 420px);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 1000px) {
		.lower {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	.roles {
		margin: 0 0 0.5rem;
		display: grid;
		gap: 0.5rem;
	}
	.roles dt {
		font-weight: 600;
		font-size: 0.875rem;
	}
	.roles dd {
		margin: 0.1rem 0 0;
		font-size: 0.82rem;
		color: var(--text-2);
	}
	.have {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--success);
		margin-left: 0.3rem;
	}
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
		.act .btn,
		form > .btn-primary {
			min-height: 44px;
		}
	}
</style>
