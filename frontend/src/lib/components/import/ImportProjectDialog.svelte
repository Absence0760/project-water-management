<script lang="ts">
	// "Import project file" and "Import b023 workbook" on the project list
	// (WP-1.8, WP-1.31; docs/ui.md § Project list). Steps: pick a file → read
	// it → preview (ImportPreview) → POST /projects/import → done (link to the
	// project) or failed (nothing created). The preview and submit steps take
	// an already-parsed document (`ParsedImport`), whichever source made it:
	//   - a .json project file is read here (projectFile.ts);
	//   - a b023 .xlsx / .xlsm workbook is read in a Web Worker
	//     ($lib/spreadsheet/import/runner.ts, imported on demand so SheetJS is
	//     never in a page chunk), with progress per sheet and Cancel, and its
	//     review adds the gauge option, the importer's notes and the unmapped
	//     report (WorkbookReview).
	// The notes and unmapped report the review showed (a project file's notes,
	// for a .json) go with the POST as `importReport` and are kept with the
	// project (importReport.ts; the Overview's Import record shows them).
	// `source` only picks the wording and what the picker offers; the file's
	// type decides how it is read, so either entry point takes either kind.
	import { version } from '$app/environment';
	import { base } from '$app/paths';
	import { api, ApiError, type ImportResult, type Team } from '$lib/api';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import type { WorkbookImportProgress } from '$lib/spreadsheet/import/messages';
	import type { WorkbookImportSession } from '$lib/spreadsheet/import/runner';
	import ImportPreview from './ImportPreview.svelte';
	import { buildImportReport, importerVersion, projectFileNotes } from './importReport';
	import { IMPORT_ACCEPT, importBody, importTooLarge, readImportFile, type ParsedImport } from './projectFile';
	import WorkbookReview from './WorkbookReview.svelte';
	import {
		WORKBOOK_ACCEPT,
		WORKBOOK_MAX_MB,
		describeFailure,
		fromResult,
		gaugeOptions,
		isWorkbookFile,
		progressText,
		withChirpsProvenance,
		DEFAULT_CHIRPS_KEY,
		type FailureView,
		type WorkbookReport
	} from './workbookFile';

	let {
		open = $bindable(false),
		teams,
		defaultTeamId = '',
		source = 'project',
		onimported
	}: {
		open?: boolean;
		/** Teams the user may add projects to (member or admin). */
		teams: Team[];
		/** Team preselected in the preview ('' = personal). */
		defaultTeamId?: string;
		/** Which entry point opened the dialog: a project file (.json) or a b023 workbook. */
		source?: 'project' | 'workbook';
		/** After a successful import (the list can reload). */
		onimported?: (result: ImportResult) => void;
	} = $props();

	type Step = 'pick' | 'reading' | 'preview' | 'importing' | 'done' | 'failed';
	let step = $state<Step>('pick');
	let parsed = $state<ParsedImport | null>(null);
	let fileName = $state('');
	let pickError = $state<string | null>(null);
	/** The workbook reader's chunk didn't download: only a reload can fetch it (common/lazy.ts). */
	let readerFailed = $state(false);
	let pickFailure = $state<FailureView | null>(null);
	let name = $state('');
	let teamId = $state('');
	let run = $state(false);
	let failure = $state<{ message: string; created: 'no' | 'unknown' } | null>(null);
	let result = $state<ImportResult | null>(null);

	// The workbook source. `attempt` changes whenever a read is started,
	// cancelled or reset, so a late answer from an abandoned read is dropped.
	let session: WorkbookImportSession | null = null;
	let attempt = 0;
	let report = $state<WorkbookReport | null>(null);
	let progress = $state<WorkbookImportProgress | null>(null);
	let readingWorkbook = $state(false);
	let gaugeAsReference = $state(false);
	let scalingFrom = $state('');
	let scaleFactor = $state('');
	/** The workbook's CHIRPS column: product and version (issue #40 part c), v2.0 unless the review says otherwise. */
	let chirpsKey = $state(DEFAULT_CHIRPS_KEY);
	let optionsError = $state<string | null>(null);
	let updating = $state(false);

	const isWorkbook = $derived(source === 'workbook');
	const reading = $derived(progressText(progress));

	// Every opening starts over at the file picker; closing stops any worker.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) reset();
		if (!open && wasOpen) closeSession();
		wasOpen = open;
	});

	function closeSession() {
		attempt++;
		session?.close();
		session = null;
	}

	function reset() {
		closeSession();
		step = 'pick';
		parsed = null;
		report = null;
		progress = null;
		readingWorkbook = false;
		fileName = '';
		pickError = null;
		pickFailure = null;
		readerFailed = false;
		failure = null;
		result = null;
		run = false;
		gaugeAsReference = false;
		scalingFrom = '';
		scaleFactor = '';
		chirpsKey = DEFAULT_CHIRPS_KEY;
		optionsError = null;
		updating = false;
	}

	/** Show the preview for a document read from any source. */
	export function preview(p: ParsedImport) {
		parsed = p;
		name = p.file.name;
		teamId = teams.some((t) => t.id === defaultTeamId) ? defaultTeamId : '';
		failure = null;
		step = 'preview';
	}

	async function pick(f: File | undefined) {
		if (!f) return;
		reset();
		fileName = f.name;
		step = 'reading';
		if (isWorkbookFile(f)) return pickWorkbook(f);
		try {
			preview(await readImportFile(f));
		} catch (e) {
			pickError = e instanceof Error ? e.message : String(e);
			step = 'pick';
		}
	}

	async function pickWorkbook(f: File) {
		readingWorkbook = true;
		const mine = ++attempt;
		let runner: typeof import('$lib/spreadsheet/import/runner');
		try {
			runner = await import('$lib/spreadsheet/import/runner');
		} catch {
			if (mine !== attempt) return;
			readingWorkbook = false;
			readerFailed = true;
			step = 'pick';
			return;
		}
		if (mine !== attempt) return;
		const { createWorkbookImport, WorkbookImportCancelled, WorkbookImportFailed } = runner;
		const s = createWorkbookImport();
		session = s;
		try {
			const r = await s.parse(f, {}, (p) => (progress = p));
			if (session !== s) return;
			const out = fromResult(r);
			report = out.report;
			preview(out.parsed);
		} catch (e) {
			if (session !== s || e instanceof WorkbookImportCancelled) return;
			closeSession();
			if (e instanceof WorkbookImportFailed) pickFailure = describeFailure(e.failure);
			else pickError = e instanceof Error ? e.message : String(e);
			step = 'pick';
		} finally {
			if (mine === attempt || session === null) readingWorkbook = false;
		}
	}

	function cancelReading() {
		closeSession();
		readingWorkbook = false;
		progress = null;
		step = 'pick';
	}

	/** The gauge options changed on the review: extract again from the workbook already read. */
	async function changeOptions() {
		const opts = gaugeOptions(gaugeAsReference, scalingFrom, scaleFactor);
		if ('error' in opts) {
			optionsError = opts.error;
			return;
		}
		const s = session;
		if (!s || !parsed) return;
		optionsError = null;
		updating = true;
		try {
			const { WorkbookImportFailed } = await import('$lib/spreadsheet/import/runner');
			try {
				const out = fromResult(await s.extract(opts.options));
				if (session !== s) return;
				// Keep the name, team and run choice the user already made.
				parsed = { ...out.parsed, file: { ...out.parsed.file, name: parsed.file.name } };
				report = out.report;
			} catch (e) {
				if (session !== s) return;
				optionsError = e instanceof WorkbookImportFailed ? describeFailure(e.failure).detail : e instanceof Error ? e.message : String(e);
			}
		} finally {
			updating = false;
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed || !name.trim() || updating || optionsError) return;
		const source = report ? 'b023-workbook' : 'project-file';
		const importReport = buildImportReport({
			source,
			fileName,
			importerVersion: importerVersion(source, version),
			notes: report ? report.notes : projectFileNotes(parsed.notes),
			unmapped: report ? report.unmapped : []
		});
		// A workbook's CHIRPS column goes in labelled with the review's answer; a project file carries its own labels.
		const body = importBody(report ? withChirpsProvenance(parsed.file, chirpsKey) : parsed.file, name, importReport);
		const tooLarge = importTooLarge(body.bytes);
		if (tooLarge) {
			failure = { message: tooLarge, created: 'no' };
			step = 'failed';
			return;
		}
		step = 'importing';
		// Closing (or reopening) the dialog mid-request moves `attempt` on; a
		// late answer then mustn't overwrite what the user is doing now.
		const mine = attempt;
		try {
			const r = await api.projects.importProject(body.file, { teamId: teamId || null, run, report: importReport });
			if (mine !== attempt) {
				onimported?.(r);
				return;
			}
			result = r;
			step = 'done';
			closeSession();
			onimported?.(result);
		} catch (err) {
			if (mine !== attempt) return;
			// A response from the server means its transaction rolled back; no
			// response (status 0) means we can't know whether it went through.
			const reached = err instanceof ApiError && err.status !== 0;
			failure = { message: err instanceof Error ? err.message : String(err), created: reached ? 'no' : 'unknown' };
			step = 'failed';
		}
	}

	const title = $derived(step === 'done' ? 'Project imported' : isWorkbook || report ? 'Import b023 workbook' : 'Import project file');
	const inputLabel = $derived(isWorkbook ? 'b023 workbook (.xlsm or .xlsx)' : 'Project file (.json)');
	const accept = $derived(isWorkbook ? WORKBOOK_ACCEPT : IMPORT_ACCEPT);
</script>

<Dialog bind:open {title} wide>
	<form id="import-form" onsubmit={submit} aria-busy={step === 'reading' || step === 'importing' || updating}>
		{#if step === 'pick' || step === 'reading'}
			{#if pickError}<div class="alert alert-error" role="alert">{pickError}</div>{/if}
			{#if readerFailed}<ChunkFailed what="The workbook reader" />{/if}
			{#if pickFailure}
				<div class="alert alert-error" role="alert">
					<p class="fail-head">{pickFailure.title}</p>
					<p>{pickFailure.detail}</p>
					{#if pickFailure.list?.length}
						<ul class="mono-list">
							{#each pickFailure.list as item, i (i)}<li>{item}</li>{/each}
							{#if pickFailure.more}<li class="more">and {pickFailure.more} more</li>{/if}
						</ul>
					{/if}
				</div>
			{/if}
			{#if isWorkbook}
				<p class="muted small">
					A Water Balance Tool <strong>b023</strong> workbook (<span class="mono">.xlsm</span>, or
					<span class="mono">.xlsx</span>) becomes a new project: its network, hydrological units, crops, transfers, settings and
					[Flow data] series. It's read here in your browser; only the project is sent. Formulas and macros are never run,
					and the per-farm result sheets aren't imported. Up to {WORKBOOK_MAX_MB} MB.
				</p>
			{:else}
				<p class="muted small">
					A project file holds a catchment's model, settings and time series: the <strong>.json</strong> that
					<em>Download project (JSON)</em> on a project's Overview writes, or the workbook importer's
					<span class="mono">project.json</span>. It becomes a new project; nothing existing changes.
				</p>
			{/if}
			<div class="field">
				<label for="imp-file">{inputLabel}</label>
				<input id="imp-file" type="file" {accept} disabled={step === 'reading'} onchange={(e) => pick(e.currentTarget.files?.[0])} />
			</div>
			{#if step === 'reading' && readingWorkbook}
				<div class="reading">
					<progress max="1" value={reading.fraction} aria-label="Reading the workbook"></progress>
					<p class="muted small" role="status">{fileName}: {reading.text}</p>
				</div>
			{:else}
				<p class="muted small" role="status">{step === 'reading' ? `Reading ${fileName}…` : ''}</p>
			{/if}
		{:else if (step === 'preview' || step === 'importing') && parsed}
			<p class="muted small file">From <span class="mono">{fileName}</span></p>
			<ImportPreview
				{parsed}
				{teams}
				bind:name
				bind:teamId
				bind:run
				disabled={step === 'importing'}
				fileLabel={report ? 'In this workbook' : 'In this file'}
			>
				{#snippet extra()}
					{#if report}
						<WorkbookReview
							{report}
							bind:gaugeAsReference
							bind:scalingFrom
							bind:scaleFactor
							bind:chirpsKey
							{optionsError}
							{updating}
							disabled={step === 'importing'}
							onoptions={changeOptions}
						/>
					{/if}
				{/snippet}
			</ImportPreview>
			<p class="muted small" role="status">
				{step === 'importing' ? (run ? 'Importing, then running the model…' : 'Importing…') : ''}
			</p>
		{:else if step === 'done' && result}
			<div class="alert alert-info" role="status">
				Imported <strong>{result.project.name}</strong>{result.project.team?.name ? ` into ${result.project.team.name}` : ''}.
				{#if result.runId}Its first run is ready on the Runs tab.{/if}
			</div>
			{#if result.runError}
				<div class="alert alert-warning" role="alert">
					The project was imported, but the model didn't run: {result.runError}. Fix the input, then run it from the Runs tab.
				</div>
			{/if}
		{:else if step === 'failed' && failure}
			<div class="alert alert-error" role="alert">
				<p class="fail-head">The import failed.</p>
				<p>{failure.message}</p>
				<p class="created">
					{failure.created === 'no'
						? 'Nothing was created.'
						: 'The server could not be reached, so it may or may not have gone through: check the project list before trying again.'}
				</p>
			</div>
		{/if}
	</form>
	{#snippet actions()}
		{#if step === 'done' && result}
			<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
			<a class="btn btn-primary" href="{base}/projects/{result.project.id}">Open project</a>
		{:else if step === 'failed'}
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			{#if parsed}<button type="button" class="btn btn-primary" onclick={() => (step = 'preview')}>Back to the preview</button>{/if}
		{:else if step === 'reading' && readingWorkbook}
			<button type="button" class="btn" onclick={cancelReading}>Cancel</button>
		{:else}
			{#if step === 'preview'}<button type="button" class="btn" onclick={reset}>Choose another file</button>{/if}
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			{#if step === 'preview' || step === 'importing'}
				<button
					type="submit"
					form="import-form"
					class="btn btn-primary"
					disabled={step === 'importing' || !name.trim() || updating || optionsError !== null}
				>
					{step === 'importing' ? 'Importing…' : 'Import'}
				</button>
			{/if}
		{/if}
	{/snippet}
</Dialog>

<style>
	.small {
		font-size: 0.85rem;
	}
	.file {
		margin: 0 0 0.75rem;
		overflow-wrap: anywhere;
	}
	.mono,
	.mono-list {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
	}
	.mono-list .more {
		font-family: inherit;
		list-style: none;
	}
	.mono-list li {
		overflow-wrap: anywhere;
	}
	.fail-head {
		margin: 0 0 0.25rem;
		font-weight: 600;
	}
	.alert p {
		margin: 0 0 0.25rem;
	}
	.alert p:last-child {
		margin-bottom: 0;
	}
	.created {
		color: var(--text);
	}
	.reading progress {
		width: 100%;
		margin-top: 0.25rem;
	}
	.reading p {
		overflow-wrap: anywhere;
	}
</style>
