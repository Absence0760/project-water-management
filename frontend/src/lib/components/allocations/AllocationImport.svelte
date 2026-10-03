<script lang="ts">
	// Import a WARMS extract or the app's CSV template (WP-3.10, docs/ui.md
	// § Allocations), in a side sheet the page opens from `import=1`: choose a
	// file → preview (rows with problems and unmatched rows first, each
	// unmatched row matched by hand) → import. The server keeps no preview: the
	// commit sends the file again and re-checks it. Closing the sheet drops a
	// preview.
	import { api, type AllocationImportKind, type AllocationPreview } from '$lib/api';
	import Dialog from '$lib/components/common/Dialog.svelte';
	import { fmtNum } from '$lib/format/number';
	import { AUTHORISATION_LABEL, MATCHED_BY_LABEL, previewOrder, SOURCE_LABEL, TEMPLATE_CSV, volumeCell } from './allocations';

	let { projectId, open = $bindable(false), onimported }: { projectId: string; open?: boolean; onimported: (message: string) => void } = $props();

	type Phase = 'choose' | 'reading' | 'preview' | 'importing';
	let phase = $state<Phase>('choose');
	let kind = $state<AllocationImportKind>('warms_extract');
	let reference = $state('');
	let file = $state<{ name: string; text: string } | null>(null);
	let preview = $state<AllocationPreview | null>(null);
	/** Manual matches by file line: a node id, or '' for "leave unmatched". */
	let matches = $state<Record<string, string>>({});
	let error = $state<string | null>(null);
	let input: HTMLInputElement | undefined = $state();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const rows = $derived(preview ? previewOrder(preview.rows) : []);
	const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE_CSV)}`;

	/** The node a row ends up with: the manual choice, else the automatic match. */
	const nodeOf = (line: number, auto: string | null) => (Object.hasOwn(matches, String(line)) ? matches[String(line)] || null : auto);
	const valid = $derived(rows.filter((r) => r.errors.length === 0));
	const unmatched = $derived(valid.filter((r) => nodeOf(r.line, r.nodeId) === null).length);

	async function choose(e: Event) {
		const f = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!f) return;
		// Any file chosen supersedes one still read, a refused one too: the
		// earlier file's preview would land under the refusal (and over the
		// later choice), and the sheet would stay "Reading" until it did.
		const run = ++generation;
		error = null;
		// A WARMS extract says how it was obtained (162, D3; operator agreement 3A.1(d)).
		if (kind === 'warms_extract' && !reference.trim()) {
			error = 'Say how you obtained this extract (the DWS or CMA letter or terms) before choosing the file.';
			phase = 'choose';
			if (input) input.value = '';
			return;
		}
		if (f.size > 2 * 1024 * 1024) {
			error = 'The file is larger than 2 MB. Split it, or keep only the catchment’s rows.';
			phase = 'choose';
			return;
		}
		phase = 'reading';
		try {
			const read = { name: f.name, text: await f.text() };
			// A file chosen while this one was read: drop it before asking for its preview.
			if (run !== generation) return;
			const answer = await api.allocations.preview(projectId, { kind, fileName: read.name, text: read.text, reference });
			if (run !== generation) return;
			file = read;
			preview = answer;
			matches = {};
			phase = 'preview';
		} catch (err) {
			if (run !== generation) return;
			error = msg(err);
			phase = 'choose';
		} finally {
			if (input) input.value = '';
		}
	}

	// Bumped by every reset and every file chosen: a file chosen while another
	// is still read supersedes it (the picker stays live, since disabling it
	// would drop the focus out of the sheet), and a read or import that
	// answers after the sheet was closed some other way (Back takes `import=1`
	// away) leaves the sheet as it now is, so a reopened sheet isn't filled,
	// or shut, by an older request.
	let generation = 0;
	function reset() {
		generation++;
		phase = 'choose';
		preview = null;
		file = null;
		matches = {};
		error = null;
	}
	$effect(() => {
		if (!open) reset();
	});
	// While the file is read or imported the sheet stays open (Escape and the ✕ do nothing):
	// closing it then would drop the preview under a request still running, and a reopened
	// sheet would be overwritten when that request came back. It closes itself on success.
	const busy = $derived(phase === 'reading' || phase === 'importing');
	const mayClose = () => !busy;

	async function commit() {
		if (!file || !preview) return;
		phase = 'importing';
		error = null;
		const run = generation;
		try {
			const sent: Record<string, string | null> = {};
			for (const [line, id] of Object.entries(matches)) sent[line] = id || null;
			const r = await api.allocations.commit(projectId, { kind, fileName: file.name, text: file.text, reference, matches: sent });
			// The rows are in whatever became of the sheet: the page still says so.
			if (run === generation) open = false;
			onimported(
				`Imported ${fmtNum(r.imported)} row${r.imported === 1 ? '' : 's'} from ${r.source.fileName}` +
					(r.skipped ? `; ${fmtNum(r.skipped)} with problems were left out` : '') +
					(r.unmatched ? `; ${fmtNum(r.unmatched)} not matched to a hydrological unit yet` : '') +
					'.'
			);
		} catch (err) {
			if (run !== generation) return;
			error = msg(err);
			phase = 'preview';
		}
	}
</script>

<Dialog bind:open side wide title="Import registered volumes" beforeclose={mayClose}>
	<div class="import" data-testid="allocation-import">
		{#if phase === 'choose' || phase === 'reading'}
			<p class="muted intro">
				A WARMS extract from the CMA or DWS, or the template filled in. Columns are found by their headings. Files with ID numbers, phone numbers or email addresses
				are refused: delete those columns first.
			</p>
			<p><a class="btn btn-sm" href={templateHref} download="allocations-template.csv">Download the CSV template</a></p>
			<div class="field">
				<label for="alloc-kind">What the file is</label>
				<select id="alloc-kind" bind:value={kind}>
					<option value="warms_extract">WARMS extract (registrations)</option>
					<option value="csv">CSV template or other table</option>
				</select>
			</div>
			<div class="field">
				{#if kind === 'warms_extract'}
					<label for="alloc-ref">How you obtained this extract (the DWS or CMA letter or terms)</label>
					<input id="alloc-ref" type="text" maxlength="500" required placeholder="e.g. CMA letter ref. 12/3, 2026-08-01" bind:value={reference} />
				{:else}
					<label for="alloc-ref">Reference <span class="muted">(optional)</span></label>
					<input id="alloc-ref" type="text" maxlength="500" placeholder="e.g. template filled in by the WUA, date" bind:value={reference} />
				{/if}
			</div>
			<div class="field">
				<label for="alloc-file">File (CSV, up to 2 MB)</label>
				<input id="alloc-file" type="file" accept=".csv,text/csv" bind:this={input} onchange={choose} />
			</div>
			{#if phase === 'reading'}<p class="muted" role="status">Reading the file…</p>{/if}
		{:else if preview}
			<p role="status" data-testid="allocation-preview-summary">
				<strong>{preview.fileName}</strong>: {fmtNum(preview.summary.rows)} rows, {fmtNum(valid.length - unmatched)} matched to a hydrological unit,
				{fmtNum(unmatched)} not matched{preview.summary.invalid ? `, ${fmtNum(preview.summary.invalid)} with problems (they won't be imported)` : ''}.
			</p>
			{#if preview.ignoredColumns.length}
				<p class="muted small">Columns not read: {preview.ignoredColumns.join(', ')}.</p>
			{/if}
			<div class="table-wrap">
				<table class="data compact" data-testid="allocation-preview">
					<caption class="visually-hidden">Rows of the file: problems and unmatched rows first</caption>
					<thead>
						<tr>
							<th scope="col">Line</th>
							<th scope="col">Registration</th>
							<th scope="col">Farm in the file</th>
							<th scope="col">Type · source</th>
							<th scope="col" class="num">Volume (m³/a)</th>
							<th scope="col">Matched to</th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.line)}
							<tr class:flag={r.errors.length > 0}>
								<td class="num">{r.line}</td>
								<td>{r.registrationNo || '–'}{#if r.alreadyInProject}<span class="note" title="A volume with this registration number is already in the project; importing adds another.">already in project</span>{/if}</td>
								<td>{r.farm || r.propertyRef || '–'}</td>
								<td>{r.authorisation ? AUTHORISATION_LABEL[r.authorisation] : '–'}<span class="note">{r.waterSource ? SOURCE_LABEL[r.waterSource] : '–'}</span></td>
								<!-- A 21(b) row is a dam's storage, never a take (issue #72). -->
								<td class="num">{#if r.waterUse === '21b' && !r.errors.length}{volumeCell(r)}<span class="note">storage {fmtNum(r.storageM3)} m³</span>{:else}{fmtNum(r.volumeM3PerYear)}{/if}</td>
								<td>
									{#if r.errors.length}
										<span class="err">{r.errors.join('; ')}</span>
									{:else}
										<select
											aria-label="Hydrological unit for line {r.line}"
											value={nodeOf(r.line, r.nodeId) ?? ''}
											onchange={(e) => (matches = { ...matches, [String(r.line)]: e.currentTarget.value })}
										>
											<option value="">Not matched</option>
											{#each preview.nodes as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
										</select>
										{#if r.matchedBy && !Object.hasOwn(matches, String(r.line))}<span class="note">by {MATCHED_BY_LABEL[r.matchedBy]}</span>{/if}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="muted small hash" title={preview.sha256}>File SHA-256 {preview.sha256.slice(0, 12)}…, kept with every row</p>
		{/if}
		{#if phase === 'importing'}<p class="muted" role="status" data-testid="allocation-importing">Importing… the sheet closes when it's done.</p>{/if}
		{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
	</div>
	{#snippet actions()}
		{#if preview && (phase === 'preview' || phase === 'importing')}
			<button type="button" class="btn" onclick={reset} disabled={phase === 'importing'}>Choose another file</button>
			<button type="button" class="btn btn-primary" onclick={commit} disabled={phase === 'importing' || valid.length === 0}>
				{phase === 'importing' ? 'Importing…' : `Import ${fmtNum(valid.length)} row${valid.length === 1 ? '' : 's'}`}
			</button>
		{:else}
			<button type="button" class="btn" onclick={() => (open = false)} disabled={busy}>Close</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.import {
		display: grid;
		gap: 0.75rem;
		align-content: start;
	}
	.import > p,
	.field {
		margin: 0;
	}
	.intro {
		max-width: 70ch;
	}
	.note {
		display: block;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.err {
		color: var(--danger);
		font-size: 0.8rem;
	}
	.hash {
		overflow-wrap: anywhere;
	}
</style>
