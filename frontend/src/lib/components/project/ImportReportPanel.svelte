<script lang="ts">
	// The project’s import record on the Project page (017_project_import; docs/ui.md
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	// § Project, "Import record"): which file it was imported from, when and by
	// whom, and what the importer flagged, its notes and the unmapped report,
	// each list closed at first. Shown only for an imported project, to every
	// member (viewers included), so a reviewer or assessor can see what the
	// importer interpreted long after the import. The text came from the file:
	// ImportReportLists renders it as text only, never {@html}.
	import { api, type StoredImportReport } from '$lib/api';
	import ImportReportLists from '$lib/components/import/ImportReportLists.svelte';
	import { fmtDate } from '$lib/format/number';
	import { FORMER_MEMBER } from '$lib/format/maker';

	let { projectId }: { projectId: string } = $props();

	let report = $state.raw<StoredImportReport | null>(null);
	let error = $state<string | null>(null);

	let loadedFor = '';
	async function load(id: string) {
		loadedFor = id;
		report = null;
		error = null;
		try {
			const r = await api.projects.importReport(id);
			if (loadedFor === id) report = r;
		} catch (e) {
			if (loadedFor === id) error = e instanceof Error ? e.message : String(e);
		}
	}
	$effect(() => {
		if (projectId !== loadedFor) load(projectId);
	});

	const when = $derived(report ? fmtDate(report.importedAt, true) : '');
	const sourceLabel = $derived(report?.source === 'b023-workbook' ? 'b023 workbook' : 'project file');
</script>

{#if report}
	<section class="panel" aria-labelledby="import-record-h-t">
		<div class="panel-head"><h2 id="import-record-h"><span id="import-record-h-t">Import record</span> <HelpTip key="import-record" /></h2></div>
		<!-- One line of markup, so the sentence has no stray line break in its text. -->
		<p class="summary">Imported from the {sourceLabel} <span class="mono">{report.fileName}</span> on {when} by {report.importedBy ?? FORMER_MEMBER}.</p>
		<p class="muted small">Importer: {report.importerVersion}. What it flagged then is kept here as it was shown.</p>
		<ImportReportLists
			notes={report.notes}
			unmapped={report.unmapped}
			notesOmitted={report.notesOmitted}
			unmappedOmitted={report.unmappedOmitted}
			idPrefix="ov-import"
			showUnmapped={report.source === 'b023-workbook'}
			collapsible
		/>
	</section>
{:else if error}
	<section class="panel" aria-labelledby="import-record-h">
		<div class="panel-head"><h2 id="import-record-h">Import record</h2></div>
		<p class="alert alert-error" role="alert">Couldn't load the import record: {error}</p>
		<button type="button" class="btn" onclick={() => load(projectId)}>Try again</button>
	</section>
{/if}

<style>
	.summary {
		margin: 0 0 0.25rem;
		overflow-wrap: anywhere;
	}
	.mono {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.9em;
	}
	.small {
		font-size: 0.8rem;
		margin: 0 0 0.25rem;
	}
</style>
