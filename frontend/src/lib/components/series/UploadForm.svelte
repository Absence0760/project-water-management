<script lang="ts">
	// CSV upload with preview, used by the Data tab and the project-wide "Add
	// data" dialog. Picking (or dropping) a file guesses which stored series it
	// updates; an existing series defaults to append / update (POST
	// …/series/merge), which adds new days and corrects overlapping ones but
	// never erases a stored value the file leaves blank (the server keeps it).
	// An upload that would overwrite stored days (a merge that changes some,
	// or a replace) asks first, with the days and what they change.
	// Rows can be pasted instead of a file (issue #477 (b), "Paste rows"): the
	// same reader ($lib/series/paste.ts), note, preview and requests.
	import { tick, untrack } from 'svelte';
	import { fromEpochDay, toEpochDay, unitOptions, type DayBoundary, type SeriesMeta } from '@water-management/engine';
	import { asksFreeProvenance, asksProvenance, CHIRPS_CHOICES, freeProvenanceFields, provenanceFields } from '$lib/series/provenance';
	import { api } from '$lib/api';
	import LineChart from '$lib/components/charts/LineChart.svelte';
	import { fmtNum, fmtReading } from '$lib/format/number';
	import { CsvError, type ParsedSeries } from '$lib/series/csv';
	import { parseSeriesFile } from '$lib/series/file';
	import { parsePastedSeries } from '$lib/series/paste';
	import { defaultUnit, KIND_OPTIONS, kindLabel } from '$lib/series/kinds';
	import { holeBefore, mergePreview, type Daily } from './coverage';
	import { dataEnd, guessSeries, headerLine, seriesEnd } from './freshness';
	import { latestFileText } from '$lib/files/latest';
	import { inStoredUnit, type UploadResult, type UploadSubmit } from './upload';
	import type { SeriesWriteResult } from '$lib/api/types';
	import { cachedValues, cacheValues, forgetValues } from './valuesCache';
	import { newSeriesEffect } from './roles';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import FormatHelp from '$lib/components/common/FormatHelp.svelte';
	import { SERIES_EXAMPLE, SERIES_EXAMPLE_FILE } from '$lib/series/example';

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
	// Where the days come from: a file, or rows pasted from a spreadsheet (issue #477).
	let input = $state<'file' | 'paste'>('file');
	let pasteText = $state('');
	const what = $derived(input === 'paste' ? 'the pasted rows' : 'the file');
	let mode = $state<'merge' | 'replace'>('merge');
	// A kind picked by hand is never overridden by the file-name guess.
	let kindTouched = $state(false);
	let targetValues = $state.raw<Daily | null>(null);
	// The stored values failed to load (the merge preview needs them): said in the summary, with Try again.
	let targetError = $state<string | null>(null);
	let targetTry = $state(0);
	let errorEl: HTMLElement | undefined = $state();
	// CHIRPS only (issue #40 part c): which product and version the file holds, as a provenance key ('' = not recorded).
	let provenanceKey = $state('');
	let provenanceTouched = $state(false);
	// The alternative gauge and the reanalysis (issue #40 (b)): a free product and version, e.g. "SASSCAL AWS" / "1".
	let freeProduct = $state('');
	let freeVersion = $state('');
	// Where the file's values came from (107_series_source.sql): a station, agency, file or feed. Free text, optional.
	let source = $state('');
	let sourceTouched = $state(false);
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
	// Until typed in, an existing series' own source (so a replace keeps it rather than clearing it).
	$effect(() => {
		const t = target;
		if (!sourceTouched) source = t?.source ?? '';
	});
	const askProvenance = $derived(asksProvenance(kind));
	const askFree = $derived(asksFreeProvenance(kind));
	// Said only when filled in; the server refuses a half label.
	const labelFields = $derived(
		askProvenance ? (provenanceKey ? provenanceFields(provenanceKey) : null) : askFree ? freeProvenanceFields(freeProduct, freeVersion) : null
	);
	// One of the free pair filled and not the other: the server refuses a half label, so the form asks for both or neither.
	const halfLabel = $derived(askFree && !freeProvenanceFields(freeProduct, freeVersion) && !!(freeProduct.trim() || freeVersion.trim()));
	const boundaryFields = $derived(subDailyText !== null ? { dayBoundary } : {});
	const namesForKind = $derived(list.filter((s) => s.kind === kind).map((s) => s.name));
	// A new series of a kind that has some: whether runs will read it, and the name it was probably meant to be.
	const newEffect = $derived(target ? null : newSeriesEffect(list, kind, name));
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
		const verb = input === 'paste' ? 'Save' : 'Upload';
		if (uploading) return input === 'paste' ? 'Saving…' : 'Uploading…';
		if (asking && overwrite) return overwrite.changes ? `Overwrite ${plural(overwrite.days, 'day')}` : `Replace ${plural(overwrite.days, 'day')}`;
		return target && mode === 'merge' ? `${verb} and merge` : target ? `${verb} and replace` : verb;
	});
	const submitDisabled = $derived(
		asking ? uploading : !parsed || uploading || !unit.trim() || halfLabel || (!!target && mode === 'merge' && !preview)
	);
	$effect(() => {
		submit = { label: submitLabel, disabled: submitDisabled, confirming: asking, uploading, input };
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

	// Stored values of the target series, for the merge preview. A failed read is kept and said, with Try
	// again (`targetTry`): without the stored values the merge can't say what it changes, so it waits.
	$effect(() => {
		const t = target;
		void targetTry;
		targetError = null;
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
			.catch((e: unknown) => {
				if (target?.id === t.id) targetError = msg(e);
			});
	});
	// A refused upload's reason is about that file, series, mode and unit: another choice clears it.
	$effect(() => {
		void [kind, name, mode, unit];
		untrack(() => (error = null));
	});

	function onKind(k: string) {
		error = null;
		kind = k;
		// Keep a chosen unit while it still fits the kind (l/s for another flow); else the kind's own.
		if (!unitTouched || !unitOptions(k).includes(unit)) unit = defaultUnit(k);
		const same = list.filter((s) => s.kind === k);
		if (same.length === 1) name = same[0]!.name;
		else if (!same.some((s) => s.name === name.trim())) name = '';
	}

	const fileText = latestFileText();

	function reset(name: string) {
		parsed = null;
		parseError = null;
		uploadDone = null;
		error = null;
		guessed = null;
		subDailyText = null;
		parseSeq++;
		fileName = name;
	}

	/** Read a file's or a paste's text: parsed (added up into days if sub-daily) and, unless the kind was picked, the series guessed. */
	function readText(text: string, label: string, parse: typeof parseSeriesFile) {
		try {
			try {
				parsed = parse(text);
			} catch (err) {
				// Several timed readings a day: add them up into days, in the window picked below.
				if (!(err instanceof CsvError) || !err.subDaily) throw err;
				subDailyText = text;
				parsed = parse(text, { dayBoundary });
			}
			const g = guessSeries(label, headerLine(text), list);
			if (g && !kindTouched) {
				onKind(g.kind);
				name = g.name;
				mode = 'merge';
				guessed = g.name ? `${kindLabel(g.kind)} · ${g.name}` : kindLabel(g.kind);
			}
		} catch (err) {
			parseError = err instanceof CsvError ? err.message : `Could not read ${what}: ${msg(err)}`;
		}
	}

	async function read(f: File | null | undefined) {
		reset(f?.name ?? '');
		// Started before the early return, so clearing the file also drops a read still in flight.
		const pending = fileText(f ?? null);
		if (!f) return;
		try {
			const text = await pending;
			if (text === null) return; // another file was picked while this one was read
			readText(text, f.name, parseSeriesFile);
		} catch (err) {
			parseError = `Could not read the file: ${msg(err)}`;
		}
	}

	/** The paste box's rows, read as they change (an empty box clears the summary rather than calling it an error). */
	function readPaste(text: string) {
		pasteText = text;
		reset('');
		if (text.trim()) readText(text, '', parsePastedSeries);
	}

	/** File or paste: switching drops what the other one read, so a save is always of what is shown. */
	function pickInput(next: 'file' | 'paste') {
		if (next === input) return;
		input = next;
		reset('');
		pasteText = '';
		if (fileInput) fileInput.value = '';
	}

	$effect(() => {
		const f = file;
		if (f)
			untrack(() => {
				// A file dropped on the page is a file, whichever way the form was set.
				input = 'file';
				pasteText = '';
				void read(f);
			});
	});

	function onBoundary(b: DayBoundary) {
		dayBoundary = b;
		if (subDailyText === null) return;
		parseSeq++;
		try {
			parsed = (input === 'paste' ? parsePastedSeries : parseSeriesFile)(subDailyText, { dayBoundary: b });
			parseError = null;
		} catch (err) {
			parsed = null;
			parseError = err instanceof CsvError ? err.message : `Could not read ${what}: ${msg(err)}`;
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
					...boundaryFields,
					// Recorded only on a new or empty series; one holding values keeps its own.
					...(source.trim() ? { source: source.trim() } : {})
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
					...boundaryFields,
					// A replace records what the file is, or clears it.
					source: source.trim() || null
				});
				result = { meta, added: parsed.rowCount, changed: 0, message: `Uploaded ${plural(meta.length, 'day')} to “${meta.name || label}”.` };
			}
			forgetValues(projectId, result.meta.id);
			uploadDone = result.message;
			confirmSig = null;
			parsed = null;
			fileName = '';
			pasteText = '';
			guessed = null;
			if (fileInput) fileInput.value = '';
			await onuploaded?.(result);
		} catch (err) {
			error = msg(err);
			// Beside the action, but the dialog's body may be scrolled: bring it into view.
			await tick();
			errorEl?.scrollIntoView({ block: 'nearest' });
		} finally {
			uploading = false;
		}
	}
</script>

<form id={id('form')} onsubmit={upload}>
	<fieldset class="mode input-pick" data-testid="series-input">
		<legend>Add the days from</legend>
		<label><input type="radio" name="{idPrefix}-input" value="file" checked={input === 'file'} onchange={() => pickInput('file')} /> A file</label>
		<label
			><input type="radio" name="{idPrefix}-input" value="paste" checked={input === 'paste'} onchange={() => pickInput('paste')} /> Rows pasted from a spreadsheet</label
		>
	</fieldset>
	<FormatHelp
		accepts={input === 'paste'
			? 'Rows copied from a spreadsheet (Excel and LibreOffice copy them tab-separated) or typed as date,value. At most 60 000 days from the first date to the last; a longer record goes in as a file.'
			: 'A .csv, .tsv or .txt file, or a DWS daily export saved as text or as the web page (.htm, .html). At most 60 000 days from the first date to the last.'}
		example={SERIES_EXAMPLE}
		exampleFile={SERIES_EXAMPLE_FILE}
	>
		<p>Two columns, <span class="mono">date,value</span>, one row per day; a header row is optional and lines starting with # are skipped.</p>
		<ul>
			<li>
				Dates: YYYY-MM-DD (safest), YYYY/MM/DD, YYYYMMDD, DD/MM/YYYY or MM/DD/YYYY (the last two with slashes, dots or dashes). The order is worked out from the whole file;
				if no day is above 12, day/month is assumed and the summary says so.
			</li>
			<li>
				Several readings a day (an hourly or 10-minute logger): a time after each date, <span class="mono">2025-04-01 09:00</span> (seconds and am/pm are
				read too). The form then asks how to add them up into days.
			</li>
			<li>Separators: comma, semicolon or tab, worked out from the file. Quote a value that holds the separator.</li>
			<li>Numbers: 12.5 or 12,5 (a decimal comma in a semicolon or tab file, or quoted), with or without thousands separators (1 234,5 · 1,234.5). The decimal separator is worked out from the whole file; a file that mixes them, or where 1,234 could be either, is refused.</li>
			<li>Blank, NA, NaN, null or - = no reading (stored as a gap). A negative value (-999, -1) is a “no reading” placeholder and is stored as a gap too; the summary counts them.</li>
			<li>
				DWS hydrology exports load as they are: the daily table from the DWS site (<span class="mono">DATE D AVG F/R QUAL</span>, dates as
				YYYYMMDD), as text or the saved page. Days whose quality code says the data is missing (151, 165, 170, 172, 246, 247, 255), and blank
				or negative values such as -999, are stored as gaps; the summary counts them.
			</li>
			<li>Units: pick the file's unit below and the values are converted; flow is stored as the daily mean in m³/s, rain and evaporation in mm per day.</li>
			{#if input === 'paste'}
			<li>Copy the date column and the value column together, with or without their headings. A heading that names the series (e.g. <span class="mono">Weir flow</span>) picks it for you.</li>
			<li>A blank cell is no reading: merged into a stored series, it leaves that day as it is. To clear a stored day, use Edit a day under the chart.</li>
		{:else}
			<li>Name the file after the series (e.g. <span class="mono">Weir flow.csv</span>) and it is picked for you.</li>
		{/if}
			<li>A row that can't be read stops the upload, and the message names its line (“Line 12: …”).</li>
		</ul>
	</FormatHelp>
	{#if input === 'paste'}
		<div class="field">
			<label for={id('paste')}>Dates and values</label>
			<textarea
				id={id('paste')}
				class="mono paste"
				rows="8"
				spellcheck="false"
				autocomplete="off"
				placeholder={'2025-04-01\t0.0\n2025-04-02\t12.4'}
				value={pasteText}
				oninput={(e) => readPaste(e.currentTarget.value)}
			></textarea>
		</div>
	{:else}
		<div class="field">
			<label for={id('file')}>CSV file or DWS export</label>
			<input id={id('file')} type="file" accept=".csv,.tsv,.txt,.htm,.html,text/csv,text/plain" bind:this={fileInput} onchange={(e) => read(e.currentTarget.files?.[0])} />
			{#if fileName && !fileInput?.files?.length}<span class="hint">{fileName}</span>{/if}
		</div>
	{/if}
	{#if guessed}<p class="hint muted guess">Looks like <strong>{guessed}</strong> — change below if not.</p>{/if}
	<div class="field">
		<span class="label-row"><label for={id('kind')}>Kind</label><HelpTip key={`series.${kind}`} /></span>
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
	<div class="field">
		<label for={id('source')}>Source <span class="muted">(optional)</span></label>
		<input
			id={id('source')}
			maxlength="200"
			placeholder="e.g. DWS X1H001, SAWS 0021478, farm logger"
			bind:value={source}
			oninput={() => (sourceTouched = true)}
			aria-describedby={id('source-h')}
		/>
		<span class="hint muted" id={id('source-h')}>Where the values come from: a station, agency or file. The unit chosen above is recorded with it.</span>
	</div>
	{#if askProvenance}
		<div class="field">
			<label for={id('provenance')}>CHIRPS product and version <HelpTip key="chirps-version" label="About which CHIRPS a series holds" /></label>
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
		<fieldset class="pair">
			<legend>Product and version <span class="muted">(optional)</span></legend>
			<div class="form-row">
				<div class="field grow">
					<label for={id('product')}>Product</label>
					<input
						id={id('product')}
						maxlength="40"
						placeholder="e.g. SASSCAL AWS, ERA5"
						bind:value={freeProduct}
						aria-invalid={halfLabel && !freeProduct.trim() ? 'true' : undefined}
						aria-describedby={halfLabel && !freeProduct.trim() ? id('pair-h') : undefined}
					/>
				</div>
				<div class="field unit">
					<label for={id('version')}>Version</label>
					<input
						id={id('version')}
						maxlength="20"
						placeholder="e.g. 1"
						bind:value={freeVersion}
						aria-invalid={halfLabel && !freeVersion.trim() ? 'true' : undefined}
						aria-describedby={halfLabel && !freeVersion.trim() ? id('pair-h') : undefined}
					/>
				</div>
			</div>
			{#if halfLabel}<span class="hint warn-text" id={id('pair-h')} data-testid="half-label">Give both, or leave both blank.</span>{/if}
		</fieldset>
	{/if}
	{#if subDailyText !== null}
		<fieldset class="mode" data-testid="day-boundary">
			<legend>This file has several readings a day. Add them up into days from <HelpTip key="day-boundary" /></legend>
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
			<legend>“{target.name || kindLabel(target.kind)}” already exists ({target.startDate} → {seriesEnd(target)}) <HelpTip key="series-update-mode" /></legend>
			<label><input type="radio" name="{idPrefix}-mode" value="merge" bind:group={mode} /> Append / update: add new days, correct overlapping ones</label>
			<label><input type="radio" name="{idPrefix}-mode" value="replace" bind:group={mode} /> Replace the whole series with {input === 'paste' ? 'these rows' : 'this file'}</label>
		</fieldset>
	{:else if newEffect}
		{@const what = kindLabel(kind)}
		{@const cur = newEffect.current ? `“${newEffect.current.name || what}”` : ''}
		<p class="hint muted" data-testid="new-series-effect">
			{#if newEffect.effect === 'first'}
				Creates a new series.
			{:else if newEffect.effect === 'replaces'}
				Creates a second {what} series. Runs read the first by name, so this one <strong>will replace {cur || 'the one they read'} in runs</strong>.
			{:else if newEffect.effect === 'keeps'}
				Creates a second {what} series. Runs read the first by name, so they keep reading {cur}.
			{:else}
				Creates a second {what} series.
			{/if}
			{#if newEffect.didYouMean}
				{@const dym = newEffect.didYouMean}
				Did you mean “{dym.name}”?
				<button type="button" class="btn btn-sm" onclick={() => (name = dym.name)}>Use “{dym.name}”</button>
			{:else if newEffect.effect !== 'first'}
				Pick an existing name to append to it instead.
			{/if}
		</p>
	{/if}
	{#if converted}
		<p class="hint muted" data-testid="unit-converted">Values in {unit} are converted to {converted} when saved.</p>
	{/if}
	{#if parseError}
		<div class="alert alert-error" role="alert">{input === 'paste' ? 'Pasted rows' : fileName}: {parseError}</div>
	{:else if parsed}
		<dl class="preview" aria-label={input === 'paste' ? 'Pasted rows summary' : 'File summary'}>
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
					<dt>DWS export <HelpTip key="dws-flow" /></dt>
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
							The series has values to {dataEnd(target!)} and {input === 'paste' ? 'the pasted rows start' : 'this file starts'} {parsed.startDate}: {fmtNum(hole.days)} day{hole.days === 1 ? '' : 's'} between ({hole.from}{hole.days > 1
								? ` to ${hole.to}`
								: ''}) will be blank{target!.kind.startsWith('rain_') ? ', and a run treats a blank rain day as dry (0 mm)' : ''}.
						</dd>
					</div>
				{/if}
			{:else if target && mode === 'merge' && targetError}
				<div class="wide">
					<dt>Couldn't read the stored series to compare</dt>
					<dd class="target-error" role="alert" data-testid="target-error">
						<span>“{target.name || kindLabel(target.kind)}”: {targetError}</span>
						<button type="button" class="btn btn-sm" onclick={() => targetTry++}>Try again</button>
					</dd>
				</div>
			{:else if target && mode === 'merge'}
				<div class="wide"><dt>Comparing with the stored series…</dt><dd></dd></div>
			{:else if target && mode === 'replace'}
				<div class="wide"><dt>Replaces</dt><dd class="warn-text">all {fmtNum(target.length)} stored days</dd></div>
			{/if}
		</dl>
		<LineChart
			title={input === 'paste' ? 'Pasted rows preview' : 'File preview'}
			height={140}
			{unit}
			series={[{ label: input === 'paste' ? 'pasted rows' : fileName || 'file', startDate: parsed.startDate, values: parsed.values }]}
		/>
	{/if}
	{#if uploadDone}<p class="ok" role="status">{uploadDone}</p>{/if}
	{#if asking && overwrite && target}
		{@const n = plural(overwrite.days, 'day')}
		<div class="confirm" role="group" aria-labelledby={id('confirm-h')} data-testid="overwrite-confirm">
			<p class="confirm-h" id={id('confirm-h')} tabindex="-1" bind:this={confirmEl}>
				{#if overwrite.changes}
					This changes {n} already stored in “{target.name || kindLabel(target.kind)}”, between {overwrite.from} and {overwrite.to}.
				{:else}
					This replaces all {n} stored in “{target.name || kindLabel(target.kind)}” ({overwrite.from} → {overwrite.to}) with {what}.
				{/if}
			</p>
			{#if overwrite.changes}
				<details class="changes">
					<summary>Show the changes</summary>
					<table>
						<thead><tr><th scope="col">Date</th><th scope="col">Stored ({target.unit})</th><th scope="col">{input === 'paste' ? 'Pasted' : 'From the file'} ({target.unit})</th></tr></thead>
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
	{/if}
	<!-- A refused upload, beside the action that sent it (the dialog's body scrolls; the top of the form is out of sight). -->
	{#if error}<div class="alert alert-error upload-error" role="alert" bind:this={errorEl} data-testid="upload-error">{error}</div>{/if}
	{#if !asking && !external}
		<button type="submit" class="btn btn-primary" disabled={submitDisabled}>{submitLabel}</button>
	{/if}
</form>

<style>
	.label-row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.pair {
		border: 0;
		padding: 0;
		margin: 0 0 0.75rem;
		min-width: 0;
	}
	.pair legend {
		font-size: 0.85rem;
		font-weight: 600;
		padding: 0;
		margin-bottom: 0.25rem;
	}
	.target-error {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
		color: var(--danger);
	}
	.upload-error {
		margin: 0.75rem 0 0;
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
	.paste {
		width: 100%;
		min-height: 8rem;
		resize: vertical;
		font-size: 0.85rem;
	}
	.input-pick {
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
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
