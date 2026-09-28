<script lang="ts">
	// CSV upload with preview, used by the Data tab and the project-wide "Add
	// data" dialog. Picking (or dropping) a file guesses which stored series it
	// updates; an existing series defaults to append / update (POST
	// …/series/merge), which adds new days and corrects overlapping ones but
	// never erases a stored value the file leaves blank (the server keeps it).
	// An upload that would overwrite stored days (a merge that changes some,
	// or a replace) asks first, with the days and what they change.
	import { tick, untrack } from 'svelte';
	import { fromEpochDay, toEpochDay, unitOptions, type DayBoundary, type SeriesMeta } from '@water-management/engine';
	import { asksFreeProvenance, asksProvenance, CHIRPS_CHOICES, freeProvenanceFields, provenanceFields } from '$lib/series/provenance';
	import { api } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { fmtNum, fmtReading } from '$lib/format/number';
	import { CsvError, type ParsedSeries } from '$lib/series/csv';
	import { parseSeriesFile } from '$lib/series/file';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';
	import { holeBefore, mergePreview, type Daily } from './coverage';
	import { dataEnd, guessSeries, headerLine, seriesEnd } from './freshness';
	import { inStoredUnit, type UploadResult, type UploadSubmit } from './upload';
	import type { SeriesWriteResult } from '$lib/api/types';
	import { cachedValues, cacheValues, forgetValues } from './valuesCache';

	let {
		projectId,
		list,
		file = null,
		idPrefix = 'up',
		pending = $bindable(false),
		external = false,
		submit = $bindable(null),
		onuploaded
	}: {
		projectId: string;
		list: SeriesMeta[];
		/** A file handed in from outside (drag and drop); read as soon as it changes. */
		file?: File | null;
		idPrefix?: string;
		/** Out: a file is read but not uploaded yet, or an upload is running. */
		pending?: boolean;
		/** The buttons are drawn outside the form (a dialog's action row, through `submit`, `back()` and the form id `${idPrefix}-form`). */
		external?: boolean;
		/** Out, with `external`: the submit button's label and state. */
		submit?: UploadSubmit | null;
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
	// CHIRPS only (issue #40 part c): which product and version the file holds, as a provenance key ('' = not recorded).
	let provenanceKey = $state('');
	let provenanceTouched = $state(false);
	// The alternative gauge and the reanalysis (issue #40 (b)): a free product and version, e.g. "SASSCAL AWS" / "1".
	let freeProduct = $state('');
	let freeVersion = $state('');
	// A sub-daily file (issue #40 (b) amendment 5): its text, kept to add it up again when the day boundary changes.
	let subDailyText = $state<string | null>(null);
	let dayBoundary = $state<DayBoundary>('08:00');
	// Bumped on every read of a file, so a confirm never outlives the file it was for.
	let parseSeq = $state(0);
	// The overwrite the person was asked about (its `sig`); null while not asking.
	let confirmSig = $state<string | null>(null);
	let confirmEl: HTMLElement | undefined = $state();
	const CHANGES_SHOWN = 100;

	$effect(() => {
		pending = parsed !== null || uploading;
	});

	const id = (s: string) => `${idPrefix}-${s}`;
	const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
	const byCode = (r: Record<string, number>) => Object.keys(r).sort((a, b) => Number(a) - Number(b));
	const qualityList = (r: Record<string, number>) => byCode(r).map((c) => `${c} × ${fmtNum(r[c]!)}`).join(', ');
	// Why a DWS export's rows were read as gaps, for the summary.
	function dwsGapParts(d: NonNullable<ParsedSeries['dws']>): string[] {
		const parts: string[] = [];
		if (d.gaps.code) parts.push(`${plural(d.gaps.code, 'row')} with a missing-data quality code (${byCode(d.gapCodes).join(', ')})`);
		if (d.gaps.negative) parts.push(`${plural(d.gaps.negative, 'negative value')} (a placeholder such as -999)`);
		if (d.gaps.blank) parts.push(`${plural(d.gaps.blank, 'row')} with no value`);
		return parts;
	}
	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const target = $derived(list.find((s) => s.kind === kind && s.name === name.trim()) ?? null);
	// Until picked by hand, an existing series' own label (so appending to it just works).
	$effect(() => {
		const t = target;
		if (!provenanceTouched) provenanceKey = t?.product && t.productVersion ? `${t.product}/${t.productVersion}` : '';
	});
	const askProvenance = $derived(asksProvenance(kind));
	const askFree = $derived(asksFreeProvenance(kind));
	// Said only when filled in; the server refuses a half label.
	const labelFields = $derived(
		askProvenance ? (provenanceKey ? provenanceFields(provenanceKey) : null) : askFree ? freeProvenanceFields(freeProduct, freeVersion) : null
	);
	const boundaryFields = $derived(subDailyText !== null ? { dayBoundary } : {});
	const namesForKind = $derived(list.filter((s) => s.kind === kind).map((s) => s.name));
	// The file in the stored unit, so the preview compares like with like.
	const stored = $derived(parsed ? inStoredUnit(kind, unit.trim(), parsed.values) : null);
	const preview = $derived(
		parsed && stored && target && mode === 'merge' && targetValues
			? mergePreview(targetValues, { startDate: parsed.startDate, values: stored.values })
			: null
	);
	// Days left blank between the stored data and an appended file: stored as blanks, run as dry for rain.
	const hole = $derived(parsed && target && mode === 'merge' ? holeBefore(dataEnd(target), parsed.startDate) : null);
	// Series are stored in their kind's canonical unit (m³/s, mm); the server converts
	// An upload that overwrites stored days: a merge's changed days, or every stored day a replace drops.
	const overwrite = $derived.by(() => {
		if (!parsed || !target) return null;
		if (mode === 'merge') {
			if (!preview || preview.changed === 0) return null;
			const c = preview.changes;
			return { days: preview.changed, from: c[0]!.date, to: c.at(-1)!.date, changes: c };
		}
		const days = targetValues ? targetValues.values.filter((v) => v != null).length : target.length;
		if (days === 0) return null;
		return { days, from: target.startDate, to: seriesEnd(target), changes: null };
	});
	const overwriteSig = $derived(overwrite ? [target?.id, mode, unit, parseSeq, overwrite.days, overwrite.from, overwrite.to].join('|') : null);
	const confirming = $derived(confirmSig !== null && confirmSig === overwriteSig);
	const asking = $derived(confirming && !!overwrite && !!target);
	const submitLabel = $derived.by(() => {
		if (uploading) return 'Uploading…';
		if (asking && overwrite) return overwrite.changes ? `Overwrite ${plural(overwrite.days, 'day')}` : `Replace ${plural(overwrite.days, 'day')}`;
		return target && mode === 'merge' ? 'Upload and merge' : target ? 'Upload and replace' : 'Upload';
	});
	const submitDisabled = $derived(asking ? uploading : !parsed || uploading || !unit.trim() || (!!target && mode === 'merge' && !preview));
	$effect(() => {
		submit = { label: submitLabel, disabled: submitDisabled, confirming: asking };
	});
	/** Back out of the overwrite question (the dialog's Back). */
	export function back() {
		confirmSig = null;
	}
	// Anything that changes the overwrite (another file, mode, series or unit) takes the question back
	// for good: switching back doesn't bring it back already answered.
	$effect(() => {
		if (confirmSig !== null && confirmSig !== overwriteSig) confirmSig = null;
	});
	// an upload in any of these (engine units.ts), so a file in l/s is read as l/s.
	const units = $derived(unitOptions(kind));
	const converted = $derived(unit && units[0] && unit !== units[0] ? units[0] : null);

	// Stored values of the target series, for the merge preview.
	$effect(() => {
		const t = target;
		if (!t) {
			targetValues = null;
			return;
		}
		const hit = cachedValues(projectId, t);
		if (hit) {
			targetValues = hit;
			return;
		}
		targetValues = null;
		api.series
			.get(projectId, t.id)
			.then((d) => {
				const v = cacheValues(projectId, d);
				if (target?.id === t.id) targetValues = v;
			})
			.catch(() => {});
	});

	function onKind(k: string) {
		kind = k;
		// Keep a chosen unit while it still fits the kind (l/s for another flow); else the kind's own.
		if (!unitTouched || !unitOptions(k).includes(unit)) unit = defaultUnit(k);
		const same = list.filter((s) => s.kind === k);
		if (same.length === 1) name = same[0]!.name;
		else if (!same.some((s) => s.name === name.trim())) name = '';
	}

	async function read(f: File | null | undefined) {
		parsed = null;
		parseError = null;
		uploadDone = null;
		guessed = null;
		subDailyText = null;
		parseSeq++;
		fileName = f?.name ?? '';
		if (!f) return;
		try {
			const text = await f.text();
			try {
				parsed = parseSeriesFile(text);
			} catch (err) {
				// Several timed readings a day: add them up into days, in the window picked below.
				if (!(err instanceof CsvError) || !err.subDaily) throw err;
				subDailyText = text;
				parsed = parseSeriesFile(text, { dayBoundary });
			}
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

	function onBoundary(b: DayBoundary) {
		dayBoundary = b;
		if (subDailyText === null) return;
		parseSeq++;
		try {
			parsed = parseSeriesFile(subDailyText, { dayBoundary: b });
			parseError = null;
		} catch (err) {
			parsed = null;
			parseError = err instanceof CsvError ? err.message : `Could not read the file: ${msg(err)}`;
		}
	}

	async function upload(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed || !stored) return;
		if (overwriteSig && !confirming) {
			confirmSig = overwriteSig;
			await tick();
			confirmEl?.focus();
			return;
		}
		uploading = true;
		error = null;
		const label = name.trim() || kindLabel(kind);
		try {
			let result: UploadResult;
			if (target && mode === 'merge') {
				// The file as it is: the server keeps the stored value of a day
				// the file leaves blank, under the row lock, so nothing is filled here.
				const p = preview ?? mergePreview(null, { startDate: parsed.startDate, values: stored.values });
				const meta = await api.request<SeriesWriteResult>('POST', `/projects/${encodeURIComponent(projectId)}/series/merge`, {
					kind,
					name: name.trim(),
					unit: unit.trim(),
					startDate: parsed.startDate,
					values: parsed.values,
					// Said only when picked: a merge that doesn't say keeps the series' label; one of another version is refused.
					...(labelFields ?? {}),
					// A sub-daily file's day boundary: one of the other window into a filled series is refused (409).
					...boundaryFields
				});
				result = {
					meta,
					added: p.added,
					changed: p.changed,
					message: `Updated “${meta.name || kindLabel(meta.kind)}”: ${fmtNum(p.added)} new day${p.added === 1 ? '' : 's'}, ${fmtNum(p.changed)} changed. Data now runs to ${dataEnd(meta)}.`
				};
			} else {
				const meta = await api.series.put(projectId, {
					kind,
					name: name.trim() || undefined,
					unit: unit.trim(),
					startDate: parsed.startDate,
					values: parsed.values,
					...(askProvenance ? provenanceFields(provenanceKey) : (labelFields ?? {})),
					...boundaryFields
				});
				result = { meta, added: parsed.rowCount, changed: 0, message: `Uploaded ${plural(meta.length, 'day')} to “${meta.name || label}”.` };
			}
			forgetValues(projectId, result.meta.id);
			uploadDone = result.message;
			confirmSig = null;
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

<form id={id('form')} onsubmit={upload}>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<details class="fmt">
		<summary>File formats</summary>
		<p>Two columns, <span class="mono">date,value</span>, one row per day; a header row is optional.</p>
		<pre class="mono">date,value
2025-04-01,0.0
2025-04-02,12.4
2025-04-03,</pre>
		<ul>
			<li>Dates: YYYY-MM-DD (safest), YYYY/MM/DD, DD/MM/YYYY or MM/DD/YYYY. The order is worked out from the whole file; if no day is above 12, day/month is assumed and the summary says so.</li>
			<li>Separators: comma, semicolon or tab, worked out from the file. Quote a value that holds the separator.</li>
			<li>Numbers: 12.5 or 12,5 (a decimal comma in a semicolon or tab file, or quoted), with or without thousands separators (1 234,5 · 1,234.5). The decimal separator is worked out from the whole file; a file that mixes them, or where 1,234 could be either, is refused.</li>
			<li>Blank, NA or - = no reading (stored as a gap).</li>
			<li>
				DWS hydrology exports load as they are: the daily table from the DWS site (<span class="mono">DATE D AVG F/R QUAL</span>, dates as
				YYYYMMDD), as text or the saved page. Days whose quality code says the data is missing (151, 165, 170, 172, 246, 247, 255), and blank
				or negative values such as -999, are stored as gaps; the summary counts them.
			</li>
			<li>Units: rainfall in mm per day; flow as the daily mean in m³/s.</li>
			<li>Name the file after the series (e.g. <span class="mono">Weir flow.csv</span>) and it is picked for you.</li>
		</ul>
	</details>
	<div class="field">
		<label for={id('file')}>CSV file</label>
		<input id={id('file')} type="file" accept=".csv,.tsv,.txt,.htm,.html,text/csv,text/plain" bind:this={fileInput} onchange={(e) => read(e.currentTarget.files?.[0])} />
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
			<select id={id('unit')} required bind:value={unit} onchange={() => (unitTouched = true)}>
				{#each units as u (u)}<option value={u}>{u}</option>{/each}
			</select>
		</div>
	</div>
	{#if askProvenance}
		<div class="field">
			<label for={id('provenance')}>CHIRPS product and version</label>
			<select id={id('provenance')} bind:value={provenanceKey} onchange={() => (provenanceTouched = true)} aria-describedby={id('provenance-h')}>
				<option value="">Not known</option>
				{#each CHIRPS_CHOICES as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
			</select>
			<span class="hint muted" id={id('provenance-h')}>
				CHIRPS v2.0 and v3.0 differ by an amount that changes over the years, so one series holds one of them. A b023 workbook’s CHIRPS
				column is usually v2.0; the CHIRPS data feed writes v3.0.
			</span>
		</div>
	{:else if askFree}
		<div class="form-row">
			<div class="field grow">
				<label for={id('product')}>Product <span class="muted">(optional)</span></label>
				<input id={id('product')} maxlength="40" placeholder="e.g. SASSCAL AWS, ERA5" bind:value={freeProduct} />
			</div>
			<div class="field unit">
				<label for={id('version')}>Version</label>
				<input id={id('version')} maxlength="20" placeholder="e.g. 1" bind:value={freeVersion} />
			</div>
		</div>
	{/if}
	{#if subDailyText !== null}
		<fieldset class="mode" data-testid="day-boundary">
			<legend>This file has several readings a day. Add them up into days from</legend>
			<label
				><input type="radio" name="{idPrefix}-boundary" value="08:00" checked={dayBoundary === '08:00'} onchange={() => onBoundary('08:00')} /> 08:00 to 08:00,
				booked to the day it starts (the manual-gauge day)</label
			>
			<label
				><input type="radio" name="{idPrefix}-boundary" value="00:00" checked={dayBoundary === '00:00'} onchange={() => onBoundary('00:00')} /> midnight to
				midnight</label
			>
			<span class="hint muted"
				>Each timestamp is taken as the end of its interval, so a reading at 08:00 closes the day before. The series records the choice, and a rain-source
				period (Settings → Rain source) compares like with like.</span
			>
		</fieldset>
	{/if}
	{#if target}
		<fieldset class="mode">
			<legend>“{target.name || kindLabel(target.kind)}” already exists ({target.startDate} → {seriesEnd(target)})</legend>
			<label><input type="radio" name="{idPrefix}-mode" value="merge" bind:group={mode} /> Append / update: add new days, correct overlapping ones</label>
			<label><input type="radio" name="{idPrefix}-mode" value="replace" bind:group={mode} /> Replace the whole series with this file</label>
		</fieldset>
	{:else}
		<p class="hint muted">Creates a new series. Pick an existing name to append to it instead.</p>
	{/if}
	{#if converted}
		<p class="hint muted" data-testid="unit-converted">Values in {unit} are converted to {converted} when saved.</p>
	{/if}
	{#if parseError}
		<div class="alert alert-error" role="alert">{fileName}: {parseError}</div>
	{:else if parsed}
		<dl class="preview" aria-label="File summary">
			<div><dt>Period</dt><dd>{parsed.startDate} → {parsed.endDate}</dd></div>
			<div><dt>Days</dt><dd>{fmtNum(parsed.values.length)}</dd></div>
			<div><dt>With values</dt><dd>{fmtNum(parsed.rowCount)}</dd></div>
			<div><dt>Gaps</dt><dd>{fmtNum(parsed.missingCount)}</dd></div>
			{#if parsed.subDaily}
				<div class="wide">
					<dt>Added up from</dt>
					<dd data-testid="sub-daily-summary">
						{fmtNum(parsed.subDaily.readings)} readings, {fmtNum(parsed.subDaily.readingsPerDay)} a day, {parsed.subDaily.dayBoundary}–{parsed.subDaily.dayBoundary}{#if parsed.subDaily.incompleteDays}
							<span class="warn-text">; {fmtNum(parsed.subDaily.incompleteDays)} days have fewer readings, so their totals may be short</span>{/if}
					</dd>
				</div>
			{/if}
			{#if parsed.negativeGaps}
				<div class="wide">
					<dt>Negative values</dt>
					<dd data-testid="negative-gaps">
						<span class="warn-text"
							>{fmtNum(parsed.negativeGaps)} read as gaps: rain, flow and evaporation are never below zero, so a negative value (−999, −1) is a
							“no reading” placeholder.</span
						>
					</dd>
				</div>
			{/if}
			{#if parsed.dws}
				{@const d = parsed.dws}
				{@const dropped = d.gaps.code + d.gaps.negative + d.gaps.blank}
				<div class="wide">
					<dt>DWS export</dt>
					<dd data-testid="dws-summary">
						{fmtNum(d.rows)} rows{#if d.column}, {d.column}{/if}.
						{#if dropped}
							<span class="warn-text"
								>{fmtNum(dropped)} read as gaps:{#each dwsGapParts(d) as part, i (part)}{i ? ';' : ''} {part}{/each}.</span
							>
						{:else}
							No rows read as gaps.
						{/if}
					</dd>
				</div>
				<div class="wide">
					<dt>Quality codes</dt>
					<dd data-testid="dws-quality">{qualityList(d.quality) || 'none given'}</dd>
				</div>
			{/if}
			{#if parsed.dateOrder !== 'iso'}
				<div>
					<dt>Dates read as</dt>
					<dd class:warn-text={parsed.dateOrderAssumed}>
						{parsed.dateOrder === 'dmy' ? 'day/month/year' : 'month/day/year'}{#if parsed.dateOrderAssumed}
							(assumed: no day above 12; use YYYY-MM-DD to be sure){/if}
					</dd>
				</div>
			{/if}
			{#if preview}
				<div><dt>New days</dt><dd class="ok">{fmtNum(preview.added)}</dd></div>
				<div><dt>Changed</dt><dd class:warn-text={preview.changed > 0}>{fmtNum(preview.changed)}</dd></div>
				<div><dt>Unchanged</dt><dd>{fmtNum(preview.unchanged)}</dd></div>
				<div><dt>Series after</dt><dd>{preview.result.startDate} → {fromEpochDay(toEpochDay(preview.result.startDate) + preview.result.values.length - 1)}</dd></div>
				{#if hole}
					<div class="wide">
						<dt>Blank days</dt>
						<dd class="warn-text" data-testid="upload-hole">
							The series has values to {dataEnd(target!)} and this file starts {parsed.startDate}: {fmtNum(hole.days)} day{hole.days === 1 ? '' : 's'} between ({hole.from}{hole.days > 1
								? ` to ${hole.to}`
								: ''}) will be blank{target!.kind.startsWith('rain_') ? ', and a run treats a blank rain day as dry (0 mm)' : ''}.
						</dd>
					</div>
				{/if}
			{:else if target && mode === 'merge'}
				<div class="wide"><dt>Comparing with the stored series…</dt><dd></dd></div>
			{:else if target && mode === 'replace'}
				<div class="wide"><dt>Replaces</dt><dd class="warn-text">all {fmtNum(target.length)} stored days</dd></div>
			{/if}
		</dl>
		<LineChart title="File preview" height={140} {unit} series={[{ label: fileName || 'file', startDate: parsed.startDate, values: parsed.values }]} />
	{/if}
	{#if uploadDone}<p class="ok" role="status">{uploadDone}</p>{/if}
	{#if asking && overwrite && target}
		{@const n = plural(overwrite.days, 'day')}
		<div class="confirm" role="group" aria-labelledby={id('confirm-h')} data-testid="overwrite-confirm">
			<p class="confirm-h" id={id('confirm-h')} tabindex="-1" bind:this={confirmEl}>
				{#if overwrite.changes}
					This changes {n} already stored in “{target.name || kindLabel(target.kind)}”, between {overwrite.from} and {overwrite.to}.
				{:else}
					This replaces all {n} stored in “{target.name || kindLabel(target.kind)}” ({overwrite.from} → {overwrite.to}) with the file.
				{/if}
			</p>
			{#if overwrite.changes}
				<details class="changes">
					<summary>Show the changes</summary>
					<table>
						<thead><tr><th scope="col">Date</th><th scope="col">Stored ({target.unit})</th><th scope="col">From the file ({target.unit})</th></tr></thead>
						<tbody>
							{#each overwrite.changes.slice(0, CHANGES_SHOWN) as c (c.date)}
								<tr><td>{c.date}</td><td>{fmtReading(c.from)}</td><td>{fmtReading(c.to)}</td></tr>
							{/each}
						</tbody>
					</table>
					{#if overwrite.changes.length > CHANGES_SHOWN}
						<p class="hint muted">…and {plural(overwrite.changes.length - CHANGES_SHOWN, 'more day')}.</p>
					{/if}
				</details>
			{/if}
			<p class="hint muted">The values it replaces are kept: you can put them back from the History tab (“Restore the earlier values”).</p>
			{#if !external}
				<div class="confirm-actions">
					<button type="button" class="btn" onclick={back} disabled={uploading}>Back</button>
					<button type="submit" class="btn btn-primary" disabled={submitDisabled}>{submitLabel}</button>
				</div>
			{/if}
		</div>
	{:else if !external}
		<button type="submit" class="btn btn-primary" disabled={submitDisabled}>{submitLabel}</button>
	{/if}
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
		/* As wide as its words, so its focus ring (it takes focus first in the Add data dialog) hugs them. */
		width: fit-content;
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
	.confirm {
		margin-top: 0.75rem;
		padding: 0.6rem 0.75rem;
		border: 1px solid var(--warning);
		border-radius: var(--radius-sm);
		font-size: 0.85rem;
		display: grid;
		gap: 0.5rem;
		min-width: 0;
	}
	.confirm p {
		margin: 0;
	}
	.confirm-h {
		font-weight: 600;
	}
	.changes summary {
		cursor: pointer;
		color: var(--accent);
		font-weight: 600;
		min-height: 28px;
		display: flex;
		align-items: center;
	}
	.changes table {
		width: 100%;
		border-collapse: collapse;
		font-variant-numeric: tabular-nums;
		margin-top: 0.35rem;
	}
	.changes th,
	.changes td {
		text-align: right;
		padding: 0.15rem 0.4rem;
		border-bottom: 1px solid var(--border);
	}
	.changes th:first-child,
	.changes td:first-child {
		text-align: left;
	}
	.changes th {
		color: var(--text-muted);
		font-weight: 600;
		font-size: 0.75rem;
	}
	.confirm-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		justify-content: flex-end;
	}
	@media (max-width: 640px) {
		.field input,
		.field select,
		form > .btn-primary,
		.confirm-actions .btn {
			min-height: 44px;
		}
	}
</style>
