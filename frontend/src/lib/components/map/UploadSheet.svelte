<!--
	Upload a GeoJSON file, in a side sheet over the Map (`upload=1`; issue
	#326 E5 and D2, docs/ui.md § Map). Two steps: choose the file, and Review
	reads it on the server (POST …/map/import/preview), which proposes each
	feature's kind (from a `kind`/`type`/`layer` property, else from its
	shape) and the node it stands for. The review table lets the editor change
	each row's kind, name and Stands for ("Set every row's kind" sets the whole
	column) before Import; nothing is saved until then. A refused file lists
	its problems by feature and imports nothing. A row marked as the boundary
	while the project has one shows a warning, and Import waits for its
	"Replace the current boundary" tick (off for every file; the server
	refuses the import without it). The files imported so far sit
	under it (each SHA-256 cut to 12 characters, with a copy button). The sheet
	widens for the table; on a phone each row is a card of labelled fields.
-->
<script lang="ts">
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { api, ApiError, type MapFeatureKind, type MapImportPreview, type MapImportProblem, type MapSource } from '#lib/api/index.js';
	import Dialog from '#lib/components/common/Dialog.svelte';
	import FormatHelp from '#lib/components/common/FormatHelp.svelte';
	import { areaText, GEO_MAX_BYTES, importProblems, KIND_LABEL, KIND_NODES, problemText } from './mapData';
	// The example file the "Expected format" offers; the backend's geojson.test.ts checks it passes the upload's checks.
	import { GEOJSON_FORMAT } from './uploadFormat';
	import {
		importBody,
		kindCounts,
		kindsFor,
		nodesFor,
		replaceBoundaryText,
		replacesBoundary,
		REVIEW_KINDS,
		reviewProblems,
		reviewRows,
		setEveryKind,
		withKind,
		type ReviewRow
	} from './importReview';
	import SourceList from './SourceList.svelte';

	let {
		open = $bindable(false),
		projectId,
		sources,
		onimported
	}: {
		open?: boolean;
		projectId: string;
		sources: MapSource[];
		/** The file went in: the tab reloads, closes the sheet and picks the first feature. */
		onimported: (r: { fileName: string; ids: string[] }) => Promise<void> | void;
	} = $props();

	const uid = $props.id();
	const formId = `${uid}-form`;
	let file = $state<File | null>(null);
	let text = '';
	let busy = $state(false);
	let error = $state<string | null>(null);
	/** The file's problems, or the import's refusal, listed by feature. */
	let problems = $state<MapImportProblem[]>([]);
	let review = $state<MapImportPreview | null>(null);
	let rows = $state<ReviewRow[]>([]);
	let everyKind = $state<MapFeatureKind | ''>('');
	let everyNote = $state<string | null>(null);
	/** "Replace the current boundary": off for every file; Import waits for it while a row would replace the boundary. */
	let replaceTicked = $state(false);

	const blocking = $derived(review ? [...review.problems, ...reviewProblems(rows)] : []);
	const importable = $derived(rows.filter((r) => r.kind).length);
	const replacing = $derived(review ? replacesBoundary(rows, review.currentBoundary) : false);
	const needsTick = $derived(replacing && !replaceTicked);
	const shown = $derived(blocking.length ? blocking : problems);
	const problemsOf = (index: number) => shown.filter((p) => p.feature === index).map((p) => p.message);
	/** The Problems column, only while some row has one: a column of "None" took the width the names need. */
	const rowProblems = $derived(rows.some((r) => problemsOf(r.index).length > 0));
	/** Some kinds came from the file's properties: the summary says so once, not under every row. */
	const fromFile = $derived(rows.some((r) => r.kind && r.kindFrom === 'property'));

	const GEOMETRY_LABEL: Record<string, string> = { Point: 'Point', LineString: 'Line', MultiLineString: 'Lines', Polygon: 'Polygon', MultiPolygon: 'Polygons' };
	const geometryText = (r: ReviewRow) => (r.geometryType ? `${GEOMETRY_LABEL[r.geometryType]}${r.areaM2 !== null ? `, ${areaText(r.areaM2)}` : ''}` : '–');

	function reset() {
		error = null;
		problems = [];
	}

	/** Step one: the file read and checked on the server, each feature's kind proposed. */
	async function readFile(e: SubmitEvent) {
		e.preventDefault();
		reset();
		if (!file) {
			error = 'Choose a GeoJSON file (.geojson or .json).';
			return;
		}
		if (file.size > GEO_MAX_BYTES) {
			error = `The file is larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it.`;
			return;
		}
		if (/\.(zip|shp)$/i.test(file.name)) {
			error = 'Shapefiles aren’t read yet: export the layer as GeoJSON in WGS84 (EPSG:4326), e.g. from QGIS, and upload that.';
			return;
		}
		busy = true;
		// Review is disabled while a file is read, but the picker isn't: a file picked (or
		// the sheet closed) meanwhile drops this read, so its review can't land under the
		// file the picker now shows (issue #384).
		const picked = file;
		const current = () => open && file === picked;
		try {
			const t = await picked.text();
			if (!current()) return;
			const p = await api.map.importPreview(projectId, { fileName: picked.name, text: t });
			if (!current()) return;
			text = t;
			review = p;
			rows = reviewRows(p);
			everyKind = '';
			everyNote = null;
			replaceTicked = false;
		} catch (err) {
			if (current()) error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	/** Step two: every row as reviewed; the server checks it all again. */
	async function importReviewed(e: SubmitEvent) {
		e.preventDefault();
		if (!review || blocking.length || review.duplicate || !importable || needsTick) return;
		reset();
		busy = true;
		try {
			const r = await api.map.import(projectId, { fileName: review.fileName, text, ...importBody(rows, review.currentBoundary, replaceTicked) });
			await onimported({ fileName: r.source.fileName, ids: r.features.map((f) => f.id) });
			chooseAnother();
		} catch (err) {
			problems = err instanceof ApiError ? importProblems(err.details) : [];
			error = err instanceof ApiError && problems.length ? 'The file was not imported. Fix these and upload it again:' : err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function chooseAnother() {
		review = null;
		rows = [];
		file = null;
		text = '';
		replaceTicked = false;
		reset();
	}

	function setKind(i: number, kind: MapFeatureKind) {
		rows[i] = withKind(rows[i]!, kind, review?.nodes ?? []);
	}

	function setEvery(kind: MapFeatureKind | '') {
		everyKind = kind;
		if (!kind) return;
		const r = setEveryKind(rows, kind, review?.nodes ?? []);
		rows = r.rows;
		everyNote = r.skipped ? `${r.skipped} ${r.skipped === 1 ? 'row keeps its kind' : 'rows keep their kinds'}: ${KIND_LABEL[kind].toLowerCase()} can’t be ${r.skipped === 1 ? 'its' : 'their'} shape.` : null;
	}
</script>

<Dialog bind:open title="Upload a GeoJSON file" side extraWide={review !== null}>
	{#if !review}
		<form id={formId} onsubmit={readFile} novalidate>
			<div class="field">
				<label for="{uid}-file">GeoJSON file <span class="u">(WGS84, at most 5 MB)</span> <HelpTip key="map-geojson-upload" label="About the GeoJSON checks" /></label>
				<input
					id="{uid}-file"
					type="file"
					accept=".geojson,.json,application/geo+json,application/json"
					onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)}
					aria-describedby="{uid}-file-h"
					data-testid="map-file"
				/>
				<!-- One short line under the field (playbook § 2); the rest stays its description, and the ⓘ explains it in full. -->
				<span class="hint" id="{uid}-file-h">
					WGS84 longitude and latitude; a file in a Lo zone or UTM is refused.
					<span class="visually-hidden"
						>It is refused rather than guessed: reproject it first (QGIS: Export → Save Features As, CRS EPSG:4326). A file may mix boundaries,
						parcels, dams, gauges and rivers: you check each feature’s kind before anything is saved.</span
					>
				</span>
			</div>
			<FormatHelp format={GEOJSON_FORMAT} />
			{#if error}
				<div class="alert alert-error" role="alert" data-testid="map-import-error"><p>{error}</p></div>
			{/if}
		</form>
	{:else}
		<form id={formId} onsubmit={importReviewed} novalidate class="review">
			<p class="summary" data-testid="map-review-summary">
				<strong>{review.fileName}</strong>: {rows.length}
				{rows.length === 1 ? 'feature' : 'features'}{importable ? ` (${kindCounts(rows)})` : ''}.
				{#if importable}{fromFile ? 'Kinds come from the file’s properties, else from each shape. ' : ''}Check each kind before you import; nothing is saved until then.{:else}Nothing in this file can be imported.{/if}
			</p>
			{#if review.duplicate}
				<div class="alert alert-error" role="alert" data-testid="map-import-duplicate">
					<p>This file was imported already. Delete its features first to import it again.</p>
				</div>
			{/if}
			{#if blocking.length || error}
				<div class="alert alert-error" role="alert" data-testid="map-import-error">
					<p>{blocking.length ? 'The file was not imported. Fix these and upload it again:' : error}</p>
					{#if shown.length}
						<ul>
							{#each shown as p, i (i)}<li>{problemText(p)}</li>{/each}
						</ul>
					{/if}
				</div>
			{/if}
			{#if replacing && review.currentBoundary}
				<div class="alert alert-warning replace" data-testid="map-import-replaces">
					<p>{replaceBoundaryText(review.currentBoundary)}</p>
					<label class="check"><input type="checkbox" bind:checked={replaceTicked} data-testid="map-import-replace-tick" /> Replace the current boundary</label>
				</div>
			{/if}
			{#if importable}
				<div class="field every">
					<label for="{uid}-every">Set every row’s kind</label>
					<select id="{uid}-every" value={everyKind} onchange={(e) => setEvery(e.currentTarget.value as MapFeatureKind | '')} aria-describedby="{uid}-every-h">
						<option value="">As proposed</option>
						{#each REVIEW_KINDS as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
					</select>
					<span class="hint" id="{uid}-every-h" data-testid="map-review-every-note">{everyNote ?? 'A default for the Kind column; each row can still be changed.'}</span>
				</div>
			{/if}
			<!-- A file nothing in can be imported shows its problems once, in the alert above, and no table of dashes. -->
			{#if importable}
			<div class="table-wrap review-wrap">
				<table class="data review-table" data-testid="map-review-table">
					<caption class="visually-hidden">The file’s features, each with its kind</caption>
					<thead>
						<tr>
							<th scope="col" class="num">#</th>
							<th scope="col">Name</th>
							<th scope="col">Shape</th>
							<th scope="col">Kind</th>
							<th scope="col">Stands for</th>
							{#if rowProblems}<th scope="col">Problems</th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each rows as r, i (r.index)}
							{@const own = problemsOf(r.index)}
							{@const choices = nodesFor(r.kind, review.nodes)}
							<tr class:flag={own.length > 0} data-testid="map-review-row">
								<th scope="row" class="num" data-label="Feature">{r.index}</th>
								<td data-label="Name">
									{#if r.kind}
										<input type="text" maxlength="100" bind:value={rows[i]!.name} aria-label="Name of feature {r.index}" placeholder="No name" />
									{:else}–{/if}
								</td>
								<td data-label="Shape">{geometryText(r)}</td>
								<td data-label="Kind">
									{#if r.kind}
										<select value={r.kind} onchange={(e) => setKind(i, e.currentTarget.value as MapFeatureKind)} aria-label="Kind of feature {r.index}" aria-describedby="{uid}-from-{r.index}">
											{#each kindsFor(r) as k (k)}<option value={k}>{KIND_LABEL[k]}</option>{/each}
										</select>
										<!-- Said under the row only when it isn't the file's own (the summary says that once); a screen reader hears it always. -->
										<span class="from" class:visually-hidden={r.kindFrom === 'property' && !r.note} id="{uid}-from-{r.index}">{r.kindFrom === 'property' ? 'from the file' : 'from its shape'}{r.note ? `: ${r.note}` : ''}</span>
									{:else}–{/if}
								</td>
								<td data-label="Stands for">
									{#if r.kind && KIND_NODES[r.kind].length}
										<select value={r.nodeId ?? ''} onchange={(e) => (rows[i]!.nodeId = e.currentTarget.value || null)} aria-label="What feature {r.index} stands for">
											<option value="">Nothing</option>
											{#each choices as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
										</select>
									{:else}–{/if}
								</td>
								{#if rowProblems}
									<td data-label="Problems" class="problems" class:none={!own.length}>
										{#if own.length}{own.map((m) => `It ${m}.`).join(' ')}{:else}<span class="muted">None</span>{/if}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{/if}
		</form>
	{/if}

	{#if sources.length}
		<section class="sources" aria-labelledby="{uid}-src-h">
			<h3 id="{uid}-src-h">Imported files</h3>
			<SourceList {sources} />
		</section>
	{/if}

	{#snippet actions()}
		{#if review && !importable}
			<!-- Nothing to import: choosing another file is the one thing left to do. -->
			<button type="button" class="btn btn-primary" onclick={chooseAnother} disabled={busy}>Choose another file</button>
		{:else if review}
			<button type="button" class="btn" onclick={chooseAnother} disabled={busy}>Choose another file</button>
			<button type="submit" form={formId} class="btn btn-primary" disabled={busy || review.duplicate || blocking.length > 0 || !importable || needsTick}>
				{busy ? 'Importing…' : `Import ${importable} ${importable === 1 ? 'feature' : 'features'}`}
			</button>
		{:else}
			<button type="button" class="btn" onclick={() => (open = false)}>Close</button>
			<button type="submit" form={formId} class="btn btn-primary" disabled={busy}>{busy ? 'Reading…' : 'Review'}</button>
		{/if}
	{/snippet}
</Dialog>

<style>
	form {
		display: grid;
		gap: 0.75rem;
	}
	.field {
		display: grid;
		gap: 0.25rem;
	}
	.hint,
	.from {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.from {
		display: block;
		font-size: var(--font-sm);
		margin-top: 0.15rem;
	}
	.alert p,
	.summary {
		margin: 0;
	}
	.replace {
		display: grid;
		gap: 0.5rem;
	}
	.check {
		display: inline-flex;
		min-height: 24px;
		font-weight: 600;
	}
	.every select {
		max-width: 20rem;
	}
	/* The sheet's body is the one scroll: the table grows with its rows, and its header row sticks to the top of
	   that scroll (a wrap that scrolls would hold it, so the wrap doesn't: the sheet is wide enough for the table). */
	.review-wrap {
		max-height: none;
		overflow: visible;
	}
	.review-table :is(td, th) {
		vertical-align: top;
	}
	.review-table input {
		min-width: 14rem;
	}
	.problems {
		min-width: 10rem;
		overflow-wrap: anywhere;
	}
	.sources {
		margin-top: 1.25rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	.sources h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}

	/* A phone: each feature is a card of labelled fields, the sheet scrolls rather than a box in it. Its first line is
	   the number and shape ("1 · Polygon, 0.35 ha"), then the name, then Kind and Stands for side by side where they
	   fit; no Problems line on a row without one (the row's flag and the alert carry them). */
	@media (max-width: 640px) {
		.review-wrap {
			container: review / inline-size;
			border: 0;
			background: none;
		}
		.review-table thead {
			display: none;
		}
		.review-table,
		.review-table tbody {
			display: block;
		}
		.review-table tr {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			gap: 0.4rem 0.75rem;
			padding: 0.6rem 0.75rem;
			margin-bottom: 0.5rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: var(--surface);
		}
		.review-table th,
		.review-table td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			min-width: 0;
		}
		.review-table td[data-label='Name'],
		.review-table td[data-label='Kind'],
		.review-table td[data-label='Stands for'],
		.review-table td.problems {
			grid-column: 1 / -1;
		}
		.review-table td.problems.none {
			display: none;
		}
		/* The head line: the number and the shape on the first row, whatever comes after them in the markup. */
		.review-table th[scope='row'] {
			grid-row: 1;
			grid-column: 1;
			font-weight: 600;
		}
		.review-table td[data-label='Shape'] {
			grid-row: 1;
			grid-column: 2 / -1;
		}
		.review-table th[scope='row']::after {
			content: ' ·';
			font-weight: 400;
			color: var(--text-muted);
		}
		.review-table input,
		.review-table select {
			min-width: 0;
			min-height: 44px;
		}
		.review-table [data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: 0.85rem;
			font-weight: 400;
			color: var(--text-2);
		}
		/* The head line's two cells need no labels: "1 · Polygon, 0.35 ha" reads as itself. */
		.review-table th[data-label='Feature']::before,
		.review-table td[data-label='Shape']::before {
			content: none;
		}
		.hint,
		.from {
			font-size: 0.85rem;
		}
	}
	/* Room for two selects (a phone held upright is about 22rem of card): Kind and Stands for side by side, Kind
	   taking the number's narrow column too, so the two are close to equal. */
	@container review (min-width: 20rem) {
		.review-table tr {
			grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
		}
		.review-table td[data-label='Kind'] {
			grid-column: 1 / 3;
		}
		.review-table td[data-label='Stands for'] {
			grid-column: 3;
		}
	}
</style>
