<script lang="ts">
	// Allocations (?tab=allocations, WP-3.10, issue #17 option A, docs/ui.md
	// § Allocations): a run's modelled use against the registered volumes.
	// The section header counts the volumes and the units above registered and
	// carries the run picker (`run=`), Download CSV and, for editors, Import
	// (`import=1`) and + Add volume (`volume=new`; Change is `volume=<id>`),
	// each a side sheet. Under it a list of each unit and water source, the
	// ones to look into first (above registered, then use with nothing
	// registered), beside the picked unit's water years and its registered
	// volumes (`unit=`); from 1100 × 620 that block is the height left in the
	// window, the list scrolling in its card. Below: every registered volume
	// with its source file, the imported files, and every unit's water years.
	// Viewers see volumes but no holder names (decision D3; the API leaves them
	// out, RLS enforces it). Farmers never reach the workspace.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { AllocationComparison, AllocationMode } from '@water-management/engine';
	import { api, type Allocation, type AllocationList, type RunMeta } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import { withoutParam, withParam } from '$lib/workspace/overlays';
	import AllocationForm from './AllocationForm.svelte';
	import AllocationImport from './AllocationImport.svelte';
	import YearTable from './YearTable.svelte';
	import {
		allocationsContext,
		AUTHORISATION_LABEL,
		comparisonRows,
		conditionsSummary,
		MODE_NOTE,
		pickUnit,
		PURPOSE_LABEL,
		shortHash,
		SOURCE_LABEL,
		unitRows,
		unitStatusText,
		waterYearLabel
	} from './allocations';

	let { projectId, runs, canEdit }: { projectId: string; runs: RunMeta[] | null; canEdit: boolean } = $props();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const runList = $derived(runs ?? []);
	const url = $derived(page.url);

	// --- the registered volumes ---
	let data = $state<AllocationList | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	async function load() {
		loading = true;
		error = null;
		try {
			data = await api.allocations.list(projectId);
		} catch (e) {
			error = msg(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});
	const sourceById = $derived(new Map((data?.sources ?? []).map((s) => [s.id, s])));
	const unmatchedCount = $derived(data?.allocations.filter((a) => a.nodeId === null).length ?? 0);
	/** Bumped on every change so the comparison reloads. */
	let version = $state(0);
	async function changed(message?: string) {
		if (message) notice = message;
		await load();
		version++;
	}

	// --- which run: `run=`, else the published run (what members and farmers see), else the latest ---
	const defaultRun = $derived(runList.find((r) => r.published && !r.scenarioId) ?? runList[0] ?? null);
	const runParam = $derived(url.searchParams.get('run'));
	const named = $derived(runParam ? (runList.find((r) => r.id === runParam) ?? null) : null);
	/** `run=` names a run that isn't in the list (deleted since): the default is shown, and said. */
	const gone = $derived(!!runParam && !!runs && !named);
	const run = $derived(named ?? defaultRun);
	const runLabel = (r: RunMeta) => `${r.label || 'Untitled run'} · ${fmtDate(r.createdAt, true)}${r.published ? ' · published' : ''}${r.scenarioId ? ' · scenario' : ''}`;
	function pickRun(id: string) {
		void goto(withParam(url, 'run', id), { noScroll: true, keepFocus: true });
	}

	// --- the comparison for that run ---
	let comparison = $state.raw<AllocationComparison | null>(null);
	/** What the compared run's allocation mode did to its use (engine ≥ 1.18.0). */
	let runMode = $state<AllocationMode>('none');
	let cLoading = $state(false);
	let cError = $state<string | null>(null);
	let wanted = '';
	async function loadComparison(id: string) {
		wanted = id;
		cLoading = true;
		cError = null;
		try {
			const r = await api.allocations.compare(projectId, id);
			if (wanted === id) {
				comparison = r.comparison;
				runMode = r.run.allocationMode ?? 'none';
			}
		} catch (e) {
			if (wanted === id) {
				comparison = null;
				cError = msg(e);
			}
		} finally {
			if (wanted === id) cLoading = false;
		}
	}
	$effect(() => {
		// Reload when the run changes or the allocations do.
		void version;
		const id = run?.id;
		if (id) untrack(() => loadComparison(id));
	});
	const rows = $derived(comparison ? comparisonRows(comparison) : []);
	const units = $derived(comparison ? unitRows(comparison) : []);

	// --- the picked unit (`unit=`), else the first on the list ---
	const pickedId = $derived(pickUnit(units, url.searchParams.get('unit')));
	const pickedName = $derived(units.find((u) => u.nodeId === pickedId)?.name ?? '');
	const pickedYears = $derived(rows.filter((r) => r.nodeId === pickedId));
	const pickedStorage = $derived(comparison?.nodes.find((n) => n.nodeId === pickedId)?.storage ?? null);
	const pickedVolumes = $derived(data?.allocations.filter((a) => a.nodeId === pickedId) ?? []);
	const tally = $derived.by(() => {
		const n = (s: string) => units.filter((u) => u.status === s).length;
		return [
			[n('over'), 'above registered'],
			[n('unregistered'), 'with no registered volume']
		]
			.filter(([k]) => k)
			.map(([k, w]) => `${k} ${w}`)
			.join(' · ');
	});

	// --- fitting the window (the playbook's dashboards): from 1100 × 620, measured, not assumed ---
	let pageW = $state(0);
	let innerW = $state(0);
	let innerH = $state(0);
	// The same width as the container query that sets the two columns (56rem at 14 px).
	const side = $derived(pageW >= 784);
	const fit = $derived(side && innerW >= 1100 && innerH >= 620 && units.length > 0);
	let firstEl: HTMLDivElement | undefined = $state();
	let firstTop = $state(0);
	$effect(() => {
		if (!firstEl) return;
		const el = firstEl;
		const measure = () => (firstTop = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});
	// Stacked (a phone, a narrow window) the lists show the first few until "Show all", so the picked unit and the
	// volumes aren't a screenful of scrolling away; the page scrolls, not a box.
	const UNIT_CAP = 6;
	const VOL_CAP = 8;
	let unitsAll = $state(false);
	let volsAll = $state(false);
	const narrow = $derived(pageW > 0 && pageW < 560);
	const shownUnits = $derived(side || unitsAll ? units : units.slice(0, UNIT_CAP));
	const shownVols = $derived(!data ? [] : narrow && !volsAll ? data.allocations.slice(0, VOL_CAP) : data.allocations);
	/** The picked unit's bars: modelled use against the registered volume, on one scale. */
	const barScale = $derived(Math.max(1, ...pickedYears.map((r) => Math.max(r.year.modelledM3, r.year.registeredM3))));
	const bothSources = $derived(new Set(pickedYears.map((r) => r.source)).size > 1);

	// A link that names a unit further down the list: bring its row into view once, inside the list's own scroller
	// (once the block fits the window at its measured height; stacked, the page isn't scrolled away from the header).
	let listEl: HTMLUListElement | undefined = $state();
	let revealed = false;
	$effect(() => {
		if (revealed || !listEl || !pickedId || !fit || !firstTop) return;
		revealed = true;
		const row = untrack(() => url.searchParams.get('unit')) ? listEl.querySelector('.unit.picked') : null;
		if (!row) return;
		// The list's own scroll only (scrollIntoView would move the page too).
		const r = row.getBoundingClientRect();
		const l = listEl.getBoundingClientRect();
		listEl.scrollTop += r.top - l.top - (l.height - r.height) / 2;
	});

	let detailEl: HTMLElement | undefined = $state();
	function choose(e: MouseEvent, id: string) {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		void goto(withParam(url, 'unit', id), { noScroll: true, keepFocus: true }).then(() => {
			if (!side) detailEl?.scrollIntoView({ block: 'start' });
		});
	}

	// --- the sheets: add or change a volume (`volume=new|<id>`), import (`import=1`); editors only ---
	const volumeParam = $derived(url.searchParams.get('volume'));
	const editing = $derived(volumeParam && volumeParam !== 'new' ? (data?.allocations.find((a) => a.id === volumeParam) ?? null) : null);
	let formOpen = $state(false);
	$effect(() => {
		formOpen = canEdit && !!data && (volumeParam === 'new' || !!editing);
	});
	$effect(() => {
		// Closed (Save, Cancel, Esc, the ✕): drop `volume` in place, so Back goes to where it was opened from.
		if (!formOpen && data && untrack(() => volumeParam)) void goto(withoutParam(url, 'volume'), { replaceState: true, noScroll: true, keepFocus: true });
	});
	const importParam = $derived(url.searchParams.get('import'));
	let importOpen = $state(false);
	$effect(() => {
		importOpen = canEdit && importParam === '1';
	});
	$effect(() => {
		if (!importOpen && untrack(() => importParam)) void goto(withoutParam(url, 'import'), { replaceState: true, noScroll: true, keepFocus: true });
	});
	const openSheet = (name: string, value: string) => goto(withParam(url, name, value), { noScroll: true, keepFocus: true });

	async function remove(a: Allocation) {
		if (!confirm(`Delete the registered volume ${a.registrationNo || ''} (${fmtNum(a.volumeM3PerYear)} m³/a)?`)) return;
		try {
			await api.allocations.remove(projectId, a.id);
			await changed();
		} catch (err) {
			notice = msg(err);
		}
	}

	async function undoImport(id: string, fileName: string, n: number) {
		if (!confirm(`Remove the import of ${fileName} and its ${n} registered volume${n === 1 ? '' : 's'}?`)) return;
		try {
			await api.allocations.removeSource(projectId, id);
			await changed(`Removed the import of ${fileName}.`);
		} catch (err) {
			notice = msg(err);
		}
	}

	const validity = (a: Allocation) =>
		a.validFrom || a.validTo ? `${a.validFrom ? fmtDate(a.validFrom) : '…'} – ${a.validTo ? fmtDate(a.validTo) : '…'}` : 'open';

	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

<svelte:window bind:innerWidth={innerW} bind:innerHeight={innerH} />

{#snippet headerContext()}
	<span data-testid="allocations-summary">{data ? allocationsContext(data.allocations.length, unmatchedCount, comparison ? units : null) : ''}</span>
{/snippet}
{#snippet headerActions()}
	{#if runList.length > 1 && run}
		<label class="run-pick">
			<span class="visually-hidden">Run compared</span>
			<select value={run.id} onchange={(e) => pickRun(e.currentTarget.value)}>
				{#each runList as r (r.id)}<option value={r.id}>{runLabel(r)}</option>{/each}
			</select>
		</label>
	{/if}
	{#if data?.allocations.length}<a class="btn" href={api.allocations.exportUrl(projectId)} download>Download CSV</a>{/if}
	{#if canEdit}
		<a class="btn" href={withParam(url, 'import', '1')} data-sveltekit-noscroll data-sveltekit-keepfocus>Import</a>
		<a class="btn" href={withParam(url, 'volume', 'new')} data-sveltekit-noscroll data-sveltekit-keepfocus>+ Add volume</a>
	{/if}
{/snippet}

<div class="allocations" bind:clientWidth={pageW}>
	{#if gone}<p class="alert alert-info" role="note">That run no longer exists, so this compares the {defaultRun?.published ? 'published' : 'newest'} run.</p>{/if}
	{#if notice}<p class="alert alert-info slim" role="status">{notice}</p>{/if}

	{#if !run}
		<section class="panel" aria-labelledby="alloc-compare-h" data-testid="allocation-compare">
			<h2 id="alloc-compare-h">Modelled use vs registered volume</h2>
			<p class="muted">Run the model to compare its use with the registered volumes.</p>
		</section>
	{:else}
		<div class="compare" data-testid="allocation-compare">
			<p class="muted intro">
				Run “{run.label || 'Untitled run'}”{run.published ? ' (published)' : ''}: the model’s abstraction per water year (October–September) next to the volume
				registered for it. Modelled use is <strong>modelled, not metered</strong>, and a registered volume can be incomplete, so a difference is something to look into,
				not a finding about anyone’s use.
			</p>
			<LoadState loading={cLoading && !comparison} error={cError} retry={() => run && loadComparison(run.id)}>
				{#if comparison}
					{#if MODE_NOTE[runMode]}<p class="alert alert-info slim" data-testid="allocation-mode-note">{MODE_NOTE[runMode]}</p>{/if}
					{#if comparison.unmatchedAllocationIds.length}
						<p class="alert alert-info slim">
							{comparison.unmatchedAllocationIds.length} registered volume{comparison.unmatchedAllocationIds.length === 1 ? ' is' : 's are'} not matched to a hydrological unit yet,
							so {comparison.unmatchedAllocationIds.length === 1 ? 'it is' : 'they are'} not counted.{canEdit ? ' Change a volume to match it.' : ''}
						</p>
					{/if}
					{#if comparison.notInRunAllocationIds.length}
						<p class="alert alert-info slim">
							{comparison.notInRunAllocationIds.length} registered volume{comparison.notInRunAllocationIds.length === 1 ? ' belongs' : 's belong'} to a hydrological unit this run
							doesn't have (added or removed since it ran).
						</p>
					{/if}
					{#if units.length}
						<div class="first" class:fit bind:this={firstEl} style:--first-top="{firstTop}px">
							<section class="panel list-card" aria-labelledby="alloc-compare-h">
								<div class="panel-head">
									<h2 id="alloc-compare-h">Modelled use vs registered volume</h2>
									<span class="muted small">Each hydrological unit and source, mean water year{tally ? ` · ${tally}` : ''}</span>
								</div>
								<ul class="units" bind:this={listEl} aria-label="Hydrological units, the ones to look into first">
									{#each shownUnits as u (u.key)}
										<li class="unit st-{u.status}" class:picked={u.nodeId === pickedId} data-unit={u.nodeId} data-status={u.status}>
											<p class="unit-head">
												<a class="name" href={withParam(url, 'unit', u.nodeId)} aria-current={u.nodeId === pickedId ? 'true' : undefined} onclick={(e) => choose(e, u.nodeId)}>{u.name}</a>
												<span class="src">{SOURCE_LABEL[u.source]}</span>
											</p>
											<p class="figs">
												<span class="status status-{u.status}">{unitStatusText(u)}</span>
												{#if u.ratio !== null}<span class="ratio">{fmtNum(u.ratio * 100, 0)} %</span>{/if}
											</p>
											<p class="facts">
												{u.registeredM3 > 0 ? `Registered ${fmtNum(u.registeredM3)}` : 'Nothing registered'} · modelled {fmtNum(u.modelledM3)} m³{u.partOnly ? ' in the part year' : ' a year'}
											</p>
										</li>
									{/each}
								</ul>
								{#if shownUnits.length < units.length}
									<button type="button" class="btn btn-sm more" onclick={() => (unitsAll = true)}>Show all {fmtNum(units.length)} hydrological units and sources</button>
								{/if}
							</section>

							<section class="panel detail" aria-labelledby="alloc-unit-h" bind:this={detailEl} data-testid="allocation-unit">
								<div class="panel-head">
									<h2 id="alloc-unit-h">{pickedName}</h2>
									{#if pickedId}
										<p class="links small">
											<a href="?tab=network&node={encodeURIComponent(pickedId)}" aria-label="{pickedName} on the Network">On the Network</a>
											<a href="?tab=supply&unit={encodeURIComponent(pickedId)}" aria-label="{pickedName} in Hydrological units">Hydrological units</a>
										</p>
									{/if}
								</div>
								<div class="detail-body">
									<p class="small muted ycap" aria-hidden="true" data-testid="allocation-unit-bars-caption">Modelled use per water year (October–September), m³</p>
									<ul class="ybars" aria-hidden="true" data-testid="allocation-unit-bars">
										{#each pickedYears as r (r.key)}
											<li class="st-{r.year.status}">
												<span class="yl">{waterYearLabel(r.year.waterYear)}{bothSources ? ` · ${r.source === 'surface' ? 'surface' : 'ground'}` : ''}{r.year.partial ? ' (part)' : ''}</span>
												<span class="track">
													<span class="bar" style:width="{(100 * r.year.modelledM3) / barScale}%"></span>
													{#if r.year.registeredM3 > 0}<span class="tick" style:left="{(100 * r.year.registeredM3) / barScale}%"></span>{/if}
												</span>
												<span class="yv">{fmtNum(r.year.modelledM3)} m³</span>
											</li>
										{/each}
									</ul>
									<p class="small muted key" aria-hidden="true"><span class="kbar"></span>modelled use (modelled, not metered) <span class="ktick"></span>registered volume</p>
									<YearTable rows={pickedYears} tolerance={comparison.tolerance} showName={false} caption="{pickedName}: modelled use against the registered volume per water source and water year" testid="allocation-unit-years" />
									{#if pickedStorage && (pickedStorage.registeredM3 !== null || pickedStorage.modelledCapacityM3)}
										<p class="small storage">
											Registered storage {pickedStorage.registeredM3 === null ? 'not stated' : `${fmtNum(pickedStorage.registeredM3)} m³`} · dam capacity in the run
											{fmtNum(pickedStorage.modelledCapacityM3)} m³
										</p>
									{/if}
									<h3 class="sub-h">Registered volumes for this hydrological unit</h3>
									{#if pickedVolumes.length}
										<ul class="vols">
											{#each pickedVolumes as a (a.id)}
												<li>
													<span class="vol-main"><strong>{fmtNum(a.volumeM3PerYear)} m³/a</strong> · {SOURCE_LABEL[a.waterSource]} · {AUTHORISATION_LABEL[a.authorisation]}</span>
													<span class="small muted">
														{a.registrationNo || 'No registration number'}{data?.canSeeHolders && a.holder ? ` · ${a.holder}` : ''} · valid {validity(a)}
													</span>
													{#if canEdit}
														<span class="vol-actions">
															<button type="button" class="btn btn-sm btn-ghost" onclick={() => openSheet('volume', a.id)} aria-label="Change {a.registrationNo || 'this volume'}">Change</button>
															<button type="button" class="btn btn-sm btn-ghost" onclick={() => remove(a)} aria-label="Delete {a.registrationNo || 'this volume'}">Delete</button>
														</span>
													{/if}
												</li>
											{/each}
										</ul>
									{:else}
										<p class="muted small">None: the model abstracts here with no registered volume in force.</p>
									{/if}
								</div>
							</section>
						</div>
					{:else}
						<section class="panel" aria-labelledby="alloc-compare-h">
							<h2 id="alloc-compare-h">Modelled use vs registered volume</h2>
							<p class="muted" data-testid="allocation-compare-empty">This run has no modelled abstraction and no registered volume to compare.</p>
						</section>
					{/if}
				{/if}
			</LoadState>
		</div>
	{/if}

	<section class="panel" aria-labelledby="alloc-list-h">
		<div class="panel-head">
			<h2 id="alloc-list-h">Registered volumes</h2>
			{#if data && !data.canSeeHolders && data.allocations.length}<span class="muted small">Names of registered users are shown to editors only.</span>{/if}
		</div>
		<LoadState {loading} {error} retry={load}>
			{#if data}
				{#if data.allocations.length}
					<div class="table-wrap vol-wrap">
						<table class="data vol-table" data-testid="allocation-list">
							<caption class="visually-hidden">Registered and licensed volumes</caption>
							<thead>
								<tr>
									<th scope="col">Hydrological unit or user<span class="sub">registration</span></th>
									{#if data.canSeeHolders}<th scope="col">Registered user</th>{/if}
									<th scope="col">Authorisation<span class="sub">purpose</span></th>
									<th scope="col" class="num">Volume (m³/a)<span class="sub">source</span></th>
									<th scope="col" class="num">Storage (m³)</th>
									<th scope="col">Valid<span class="sub">from</span></th>
									{#if canEdit}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
								</tr>
							</thead>
							<tbody>
								{#each shownVols as a (a.id)}
									{@const src = a.sourceId ? sourceById.get(a.sourceId) : undefined}
									<tr class:flag={a.nodeId === null}>
										<th scope="row">{a.nodeName ?? 'Not matched'}<span class="sub">{a.registrationNo || '–'}</span></th>
										{#if data.canSeeHolders}<td data-label="Registered user">{a.holder ?? '–'}</td>{/if}
										<td data-label="Authorisation">{AUTHORISATION_LABEL[a.authorisation]}<span class="sub">{PURPOSE_LABEL[a.purpose]}</span></td>
										<td class="num" data-label="Volume (m³/a)">{fmtNum(a.volumeM3PerYear)}<span class="sub">{SOURCE_LABEL[a.waterSource]}</span></td>
										<td class="num" data-label="Storage (m³)">{fmtNum(a.storageM3)}</td>
										<td data-label="Valid">
											{validity(a)}
											{#if conditionsSummary(a)}<span class="sub" data-testid="allocation-conditions" title={a.conditions.join('\n') || undefined}>{conditionsSummary(a)}</span>{/if}
											<span class="sub">{#if src}<span title="SHA-256 {src.sha256}">{src.fileName} · {shortHash(src.sha256)}</span>{:else}Entered by hand{/if}</span>
										</td>
										{#if canEdit}
											<td class="row-actions">
												<button type="button" class="btn btn-sm btn-ghost" onclick={() => openSheet('volume', a.id)} aria-label="Change {a.registrationNo || 'this volume'}">Change</button>
												<button type="button" class="btn btn-sm btn-ghost" onclick={() => remove(a)} aria-label="Delete {a.registrationNo || 'this volume'}">Delete</button>
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if shownVols.length < data.allocations.length}
						<button type="button" class="btn btn-sm more" onclick={() => (volsAll = true)}>Show all {fmtNum(data.allocations.length)} registered volumes</button>
					{/if}
				{:else}
					<p class="muted" data-testid="allocations-empty">
						No registered volumes yet.{canEdit ? ' Import a WARMS extract or the CSV template, or add one by hand (Import and + Add volume, above).' : ''}
					</p>
				{/if}

				{#if data.sources.length}
					<h3 class="sub-h">Imported files</h3>
					<ul class="sources">
						{#each data.sources as s (s.id)}
							<li>
								<span><strong>{s.fileName}</strong> · {s.rows} row{s.rows === 1 ? '' : 's'} · {fmtDate(s.importedAt, true)}{s.importedBy ? ` by ${s.importedBy}` : ''}</span>
								<span class="mono small" title="SHA-256 of the file">{s.sha256}</span>
								{#if s.reference}<span class="small muted">{s.reference}</span>{/if}
								{#if canEdit}<button type="button" class="btn btn-sm btn-ghost" onclick={() => undoImport(s.id, s.fileName, s.rows)}>Remove this import</button>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</LoadState>
	</section>

	{#if comparison && rows.length}
		<section class="panel" aria-labelledby="alloc-years-h">
			<div class="panel-head">
				<h2 id="alloc-years-h">Every hydrological unit and water year</h2>
			</div>
			<YearTable {rows} tolerance={comparison.tolerance} caption="Modelled use against the registered volume per hydrological unit, water source and water year" testid="allocation-compare-table" />
			<p class="hint muted">
				“Within band” is within ±{fmtNum(comparison.tolerance * 100, 0)} % of the registered volume. A part year compares the days the run covers with the registered
				volume prorated to them, and isn’t counted in the whole water years above.
			</p>
		</section>
	{/if}

	{#if canEdit && data}
		<AllocationForm {projectId} nodes={data.nodes} canSeeHolders={data.canSeeHolders} allocation={editing} bind:open={formOpen} onsaved={() => changed()} />
		<AllocationImport {projectId} bind:open={importOpen} onimported={(m) => changed(m)} />
	{/if}
</div>

<style>
	.allocations {
		container: alloc-page / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.allocations > :global(*),
	.allocations .panel {
		margin: 0;
	}
	.slim {
		margin: 0;
		padding: 0.4rem 0.75rem;
	}
	.compare {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.intro {
		margin: 0;
		max-width: 110ch;
		font-size: 0.9rem;
	}
	.run-pick select {
		max-width: min(24rem, 60vw);
		min-height: 36px;
	}
	.sub {
		display: block;
		font-weight: 400;
		font-size: 0.75rem;
		color: var(--text-2);
	}
	.sub-h {
		margin: 0.75rem 0 0.4rem;
		font-size: 1rem;
	}
	.small {
		font-size: 0.8rem;
	}
	.panel-head .small {
		overflow-wrap: anywhere;
	}

	/* The status words, in the list and both year tables. */
	.allocations :global(.status) {
		display: inline-block;
		white-space: nowrap;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 600;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-2);
	}
	.allocations :global(.status-over),
	.allocations :global(.status-unregistered) {
		background: var(--warning-soft);
		color: var(--warning);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
	}
	.allocations :global(.status-within) {
		background: var(--success-soft);
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
	}

	/* The first block: the list beside the picked unit. */
	.first {
		display: grid;
		gap: 1rem;
	}
	.list-card,
	.detail {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.units {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
		align-content: start;
	}
	.unit {
		position: relative;
		display: grid;
		gap: 0.15rem;
		padding: 0.45rem 0.7rem 0.45rem 0.85rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: inset 4px 0 0 var(--border-strong);
	}
	.unit.st-over,
	.unit.st-unregistered {
		box-shadow: inset 4px 0 0 var(--warning);
	}
	.unit.st-within {
		box-shadow: inset 4px 0 0 var(--success);
	}
	.unit.picked {
		border-color: var(--accent);
		outline: 1px solid var(--accent);
	}
	.unit p {
		margin: 0;
	}
	.unit-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0 0.5rem;
	}
	.name {
		font-weight: 600;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text);
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 3px;
	}
	/* The whole row picks the unit: the name's link is stretched over it. */
	.name::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}
	.name:focus-visible {
		outline: none;
	}
	.unit:has(.name:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.src,
	.facts {
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.figs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.5rem;
	}
	.ratio {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.detail .panel-head {
		flex-wrap: wrap;
	}
	.detail h2 {
		overflow-wrap: anywhere;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.9rem;
		margin: 0;
	}
	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	.detail-body {
		min-height: 0;
	}
	.storage {
		margin: 0.5rem 0 0;
		color: var(--text-2);
	}
	.vols,
	.sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.vols li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 0.75rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid var(--border);
	}
	.vol-main {
		flex: 1 1 100%;
	}
	.vols .muted {
		flex: 1 1 12rem;
	}
	.more {
		align-self: flex-start;
		margin-top: 0.6rem;
	}
	/* The picked unit's water years as bars: modelled use, with the registered volume as a line across it. */
	.ybars {
		list-style: none;
		margin: 0 0 0.25rem;
		padding: 0;
		display: grid;
		gap: 0.3rem;
	}
	.ycap {
		margin: 0 0 0.3rem;
	}
	.ybars li {
		display: grid;
		grid-template-columns: 8.5rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
	}
	/* Each bar's value beside it, so the bars read without the table (the table below holds both figures). */
	.yv {
		min-width: 5.5rem;
		text-align: right;
	}
	/* A phone: a narrower year column (a long "2019/20 · ground (part)" wraps), so the bars keep their length. */
	@media (max-width: 640px) {
		.ybars li {
			grid-template-columns: 5.5rem minmax(0, 1fr) auto;
		}
	}
	.ybars .track {
		position: relative;
		height: 0.9rem;
		background: var(--surface-2);
		border-radius: 3px;
	}
	.ybars .bar,
	.kbar {
		display: block;
		height: 100%;
		border-radius: 3px;
		background: var(--accent);
	}
	.ybars .st-over .bar,
	.ybars .st-unregistered .bar {
		background: var(--warning);
	}
	.ybars .st-within .bar {
		background: var(--success);
	}
	.ybars .tick,
	.ktick {
		position: absolute;
		top: -0.2rem;
		bottom: -0.2rem;
		width: 2px;
		margin-left: -1px;
		background: var(--text);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem 0.4rem;
		margin: 0 0 0.6rem;
	}
	.kbar {
		display: inline-block;
		width: 1.2rem;
		height: 0.6rem;
	}
	.ktick {
		position: static;
		display: inline-block;
		height: 0.9rem;
		margin-left: 0.5rem;
	}
	@media (forced-colors: active) {
		.ybars .bar,
		.kbar {
			background: CanvasText;
		}
		.ybars .tick,
		.ktick {
			background: Highlight;
		}
	}
	.vol-actions {
		white-space: nowrap;
	}
	.sources li {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		overflow-wrap: anywhere;
	}
	.row-actions {
		white-space: nowrap;
	}
	.hint {
		font-size: 0.8rem;
		margin: 0.5rem 0 0;
	}

	/* Wide: the list in a column beside the picked unit. */
	@container alloc-page (min-width: 56rem) {
		.first {
			grid-template-columns: minmax(17rem, 26rem) minmax(0, 1fr);
			align-items: start;
		}
	}
	/* Wide and tall enough: the block is the height left in the window; the list and the unit scroll inside their cards. */
	.first.fit {
		height: max(420px, calc(100vh - var(--first-top, 0px) - var(--dock-h, 0px) - 1rem));
		align-items: stretch;
	}
	.fit .units,
	.fit .detail-body {
		flex: 1 1 auto;
		overflow: auto;
		/* Room for the picked row's outline and the focus ring inside the scroller. */
		padding: 3px;
		margin: -3px;
	}
	.fit .detail-body :global(.table-wrap) {
		max-height: none;
	}

	/* Narrow (a phone): each registered volume is a card of label–value lines, the page scrolls rather than a box. */
	@container alloc-page (max-width: 40rem) {
		.vol-wrap {
			max-height: none;
			border: 0;
			background: none;
		}
		.vol-table thead {
			display: none;
		}
		.vol-table,
		.vol-table tbody {
			display: block;
		}
		.vol-table tr {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 0.35rem 0.75rem;
			padding: 0.6rem 0;
			border-bottom: 1px solid var(--border);
		}
		.vol-table th,
		.vol-table td {
			display: block;
			padding: 0;
			border-bottom: none;
			text-align: left;
			overflow-wrap: anywhere;
			white-space: normal;
			min-width: 0;
		}
		.vol-table th,
		.vol-table .row-actions {
			grid-column: 1 / -1;
		}
		.vol-table td[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: 0.75rem;
			color: var(--text-2);
		}
	}
	@media (max-width: 640px) {
		.run-pick select {
			min-height: 44px;
		}
	}
</style>
