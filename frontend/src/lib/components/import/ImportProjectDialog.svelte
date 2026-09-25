<script lang="ts">
	// "Import project file" on the project list (WP-1.8; docs/ui.md § Project
	// list). Steps: pick a file → read it here → preview (ImportPreview) →
	// POST /projects/import → done (link to the project) or failed (nothing
	// created). The preview and submit steps take an already-parsed document
	// (`ParsedImport`), so another source, such as a b023 workbook read in a
	// worker (WP-1.31), only has to produce one: extend `readImportFile` and
	// `IMPORT_ACCEPT` in projectFile.ts, or call `preview()` with it.
	import { base } from '$app/paths';
	import { api, ApiError, type ImportResult, type Team } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import ImportPreview from './ImportPreview.svelte';
	import { IMPORT_ACCEPT, importBody, importTooLarge, readImportFile, type ParsedImport } from './projectFile';

	let {
		open = $bindable(false),
		teams,
		defaultTeamId = '',
		onimported
	}: {
		open?: boolean;
		/** Teams the user may add projects to (member or admin). */
		teams: Team[];
		/** Team preselected in the preview ('' = personal). */
		defaultTeamId?: string;
		/** After a successful import (the list can reload). */
		onimported?: (result: ImportResult) => void;
	} = $props();

	type Step = 'pick' | 'reading' | 'preview' | 'importing' | 'done' | 'failed';
	let step = $state<Step>('pick');
	let parsed = $state<ParsedImport | null>(null);
	let fileName = $state('');
	let pickError = $state<string | null>(null);
	let name = $state('');
	let teamId = $state('');
	let run = $state(false);
	let failure = $state<{ message: string; created: 'no' | 'unknown' } | null>(null);
	let result = $state<ImportResult | null>(null);

	// Every opening starts over at the file picker.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) reset();
		wasOpen = open;
	});

	function reset() {
		step = 'pick';
		parsed = null;
		fileName = '';
		pickError = null;
		failure = null;
		result = null;
		run = false;
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
		fileName = f.name;
		pickError = null;
		step = 'reading';
		try {
			preview(await readImportFile(f));
		} catch (e) {
			pickError = e instanceof Error ? e.message : String(e);
			step = 'pick';
		}
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!parsed || !name.trim()) return;
		const body = importBody(parsed.file, name);
		const tooLarge = importTooLarge(body.bytes);
		if (tooLarge) {
			failure = { message: tooLarge, created: 'no' };
			step = 'failed';
			return;
		}
		step = 'importing';
		try {
			result = await api.projects.importProject(body.file, { teamId: teamId || null, run });
			step = 'done';
			onimported?.(result);
		} catch (err) {
			// A response from the server means its transaction rolled back; no
			// response (status 0) means we can't know whether it went through.
			const reached = err instanceof ApiError && err.status !== 0;
			failure = { message: err instanceof Error ? err.message : String(err), created: reached ? 'no' : 'unknown' };
			step = 'failed';
		}
	}

	const title = $derived(step === 'done' ? 'Project imported' : 'Import project file');
</script>

<Dialog bind:open {title} wide>
	<form id="import-form" onsubmit={submit} aria-busy={step === 'reading' || step === 'importing'}>
		{#if step === 'pick' || step === 'reading'}
			{#if pickError}<div class="alert alert-error" role="alert">{pickError}</div>{/if}
			<p class="muted small">
				A project file holds a catchment's model, settings and time series: the <strong>.json</strong> that
				<em>Download project (JSON)</em> on a project's Overview writes, or the workbook importer's
				<span class="mono">project.json</span>. It becomes a new project; nothing existing changes.
			</p>
			<div class="field">
				<label for="imp-file">Project file (.json)</label>
				<input
					id="imp-file"
					type="file"
					accept={IMPORT_ACCEPT}
					disabled={step === 'reading'}
					onchange={(e) => pick(e.currentTarget.files?.[0])}
				/>
			</div>
			<p class="muted small" role="status">{step === 'reading' ? `Reading ${fileName}…` : ''}</p>
		{:else if (step === 'preview' || step === 'importing') && parsed}
			<p class="muted small file">From <span class="mono">{fileName}</span></p>
			<ImportPreview {parsed} {teams} bind:name bind:teamId bind:run disabled={step === 'importing'} />
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
		{:else}
			{#if step === 'preview'}<button type="button" class="btn" onclick={reset}>Choose another file</button>{/if}
			<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
			{#if step === 'preview' || step === 'importing'}
				<button type="submit" form="import-form" class="btn btn-primary" disabled={step === 'importing' || !name.trim()}>
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
	.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
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
</style>
