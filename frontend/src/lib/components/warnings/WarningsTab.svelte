<script lang="ts">
	// Warnings (`?tab=warnings`, issue #611, docs/ui.md § Warnings): every
	// period a data check flags on a stored series, one row each, and the shown
	// run's warnings, each with its fix. A linked-only view (tabs.ts
	// LINKED_ONLY): it opens from Data's checks panel, the Data row's count of
	// open warnings and the run warnings on Runs & results and Calibration.
	//
	// The rows are derived, not a queue table: items.ts lists the periods
	// (engine checkPeriods, on the series the Data tab loads, plus the shown
	// run's accumulations and flow double mass) and reads each one's status
	// from the setting its decision writes to, so this page and Settings never
	// disagree. A decision saves at once through the settings PATCH, with a
	// reason in the History ("Warnings: patched 3 flat stretches"); the page's
	// usual "inputs changed since the latest run" notice follows. Filters
	// (status, check, record) are chips and a picker in the URL, each with its
	// count; rows can be ticked, or "Select all N matching" takes every row the
	// filters show (folded ones too), for one bulk decision (feohledger's
	// exceptions queue, in this app's pieces). A viewer reads it all without
	// the ticks and buttons. The page flows in the window's one scroll: the
	// first rows show, the rest behind "Show all N periods".
	import { onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { ProjectSettings, RunSummary, SeriesMeta } from '@water-management/engine';
	import { api, type Project, type RunMeta } from '#lib/api/index.js';
	import { focusAfterRemove } from '#lib/a11y/focusAfterRemove.js';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { fillHeader } from '#lib/components/workspace/headerSlot.svelte.js';
	import { shownRun } from '#lib/components/calibration/page.js';
	import { fmtNum } from '#lib/format/number.js';
	import { landOnAnchor } from '#lib/help/anchor.js';
	import { followAnchors } from '#lib/nav/anchorLanding.js';
	import { withParam, withoutParam } from '#lib/workspace/overlays.js';
	import type { Daily } from '#lib/components/series/coverage.js';
	import {
		CHECK_LABEL,
		DECISION_LABEL,
		STATUS_FILTERS,
		STATUS_LABEL,
		daysText,
		decide,
		decisionsFor,
		filterCounts,
		filterItems,
		itemsNoun,
		openCount,
		parseFilters,
		periodText,
		reopen,
		settingHref,
		statusDetail,
		warningItems,
		whatText,
		type Decision,
		type SettingsPatch,
		type StatusFilter,
		type WarningItem
	} from './items';
	import { loadRunSummary, loadValues } from './sources';

	let {
		projectId,
		project,
		series,
		runs,
		canEdit,
		nodes = [],
		onProjectChange
	}: {
		projectId: string;
		project: Project;
		/** The page's series list; null while it loads. */
		series: SeriesMeta[] | null;
		/** The page's runs, newest first; null while they load. */
		runs: RunMeta[] | null;
		canEdit: boolean;
		/** The model's nodes: a unit's own gauge and an inner gauge's record are named with theirs. */
		nodes?: readonly { id: string; name: string }[];
		onProjectChange: (p: Project) => void;
	} = $props();

	/** Rows shown before "Show all N periods". */
	const FOLD = 25;

	let values = $state.raw<Record<string, Daily> | null>(null);
	let failed = $state.raw<Record<string, string>>({});
	let loadError = $state<string | null>(null);
	let loading = $state(true);

	async function load() {
		const list = series;
		if (!list) return;
		loading = true;
		loadError = null;
		try {
			const r = await loadValues(projectId, list);
			values = r.values;
			failed = r.failed;
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	// The series list from the page: a new upload or a delete reads again (cached values come at once).
	$effect(() => {
		void series;
		untrack(load);
	});

	// The run shown: `run=` as on Runs & results and Calibration (the sidebar carries a pick), else the newest, a
	// viewer's published baseline (calibration/page.ts shownRun).
	const run = $derived(shownRun(runs, page.url.searchParams.get('run'), project.role));
	let summary = $state.raw<RunSummary | null>(null);
	let summaryFor = $state<string | null>(null);
	let runError = $state<string | null>(null);
	$effect(() => {
		const id = run?.id ?? null;
		untrack(() => {
			runError = null;
			if (!id) {
				summary = null;
				summaryFor = null;
				return;
			}
			loadRunSummary(projectId, id).then(
				(s) => {
					if ((run?.id ?? null) !== id) return;
					summary = s;
					summaryFor = id;
				},
				(e) => {
					if ((run?.id ?? null) === id) runError = e instanceof Error ? e.message : String(e);
				}
			);
		});
	});

	const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? null;
	const settings = $derived(project.settings as ProjectSettings);
	const items = $derived(values && series ? warningItems({ series, values, settings, run: summaryFor === run?.id ? summary : null, nodeName }) : []);
	const filters = $derived(parseFilters(page.url.searchParams));
	const counts = $derived(filterCounts(items, filters));
	const shown = $derived(filterItems(items, filters));
	const open = $derived(openCount(items));
	const recordsWithItems = $derived(new Set(items.map((i) => i.seriesId)).size);
	const failedNames = $derived(
		Object.keys(failed)
			.map((id) => series?.find((s) => s.id === id))
			.filter((s): s is SeriesMeta => !!s)
			.map((s) => s.name || s.kind)
	);

	let allShown = $state(false);
	const visible = $derived(allShown || shown.length <= FOLD ? shown : shown.slice(0, FOLD));

	// --- selection: ids, kept across a fold; a filter change starts over ---
	let selected = $state<Set<string>>(new Set());
	const filterKey = $derived(`${filters.check}|${filters.series}|${filters.status}`);
	$effect(() => {
		void filterKey;
		untrack(() => {
			selected = new Set();
			allShown = false;
		});
	});
	const picked = $derived(shown.filter((i) => selected.has(i.id)));
	const allVisiblePicked = $derived(visible.length > 0 && visible.every((i) => selected.has(i.id)));
	function toggle(id: string, on: boolean) {
		const next = new Set(selected);
		if (on) next.add(id);
		else next.delete(id);
		selected = next;
	}
	function toggleVisible(on: boolean) {
		selected = on ? new Set([...selected, ...visible.map((i) => i.id)]) : new Set([...selected].filter((id) => !visible.some((i) => i.id === id)));
	}
	const selectAllMatching = () => (selected = new Set(shown.map((i) => i.id)));
	const bulkCount = (d: Decision) => picked.filter((i) => decisionsFor(i).includes(d)).length;
	// By the records listed, not by what is still open, so a button never goes while it has the focus.
	const bulkDecisions = $derived<Decision[]>([
		...(items.some((i) => i.role === 'catchmentRain' || i.role === 'rain') ? (['patch'] as const) : []),
		...(items.some((i) => i.role === 'flow') ? (['exclude'] as const) : []),
		'keep'
	]);

	// --- saving ---
	let saving = $state(false);
	let notice = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);
	const DONE: Record<Decision, string> = { patch: 'Patched', exclude: 'Excluded from calibration', keep: 'Kept' };

	async function save(patch: SettingsPatch, reason: string, done: string): Promise<boolean> {
		saving = true;
		notice = null;
		try {
			const p = await api.projects.update(projectId, { settings: patch as Partial<ProjectSettings>, reason });
			onProjectChange(p);
			notice = { tone: 'ok', text: `${done} Run the model to use ${done.startsWith('Reopened') ? 'the change' : 'it'}.` };
			return true;
		} catch (e) {
			notice = { tone: 'error', text: `Couldn’t save: ${e instanceof Error ? e.message : String(e)}` };
			return false;
		} finally {
			saving = false;
		}
	}

	/** One row's decision (or Reopen): the focus goes to the row now in its place, or stays on the row when it remains. */
	async function decideRow(i: WarningItem, d: Decision | 'reopen', at: number) {
		if (saving) return;
		let ok: boolean;
		if (d === 'reopen') {
			const r = reopen(i, settings);
			if (!r) return;
			ok = await save(r.patch, r.reason, `Reopened ${itemsNoun([i])}.`);
		} else {
			const r = decide([i], d, settings);
			if (!r.ok) {
				notice = { tone: 'error', text: r.error };
				return;
			}
			ok = await save(r.patch, r.reason, `${DONE[d]} ${itemsNoun([i])}.`);
		}
		if (!ok) return;
		await tick();
		const still = document.querySelector<HTMLElement>(`#warn-rows tr[data-item="${CSS.escape(i.id)}"] [data-row-action]`);
		if (still) still.focus();
		else await focusAfterRemove(at, '#warn-rows [data-row-action]', 'warn-checks-h');
	}

	/** A bulk decision on the ticked rows; the focus stays on its button (it stays, aria-disabled once nothing is ticked). */
	async function decideBulk(d: Decision) {
		if (saving || !bulkCount(d)) return;
		const r = decide(picked, d, settings);
		if (!r.ok) {
			notice = { tone: 'error', text: r.error };
			return;
		}
		const noun = itemsNoun(picked.filter((i) => decisionsFor(i).includes(d)));
		if (await save(r.patch, r.reason, `${DONE[d]} ${noun}.`)) selected = new Set();
	}

	// --- filters in the URL: a pick is a step in history (ui-playbook.md § 4) ---
	const statusHref = (s: StatusFilter) => (s === 'open' ? withoutParam(page.url, 'status') : withParam(page.url, 'status', s));
	const checkHref = (c: string | null) => (c ? withParam(page.url, 'check', c) : withoutParam(page.url, 'check'));
	const everyHref = $derived.by(() => {
		const q = new URLSearchParams(page.url.search);
		q.delete('check');
		q.delete('series');
		q.set('status', 'all');
		return `?${q}`;
	});
	function setRecord(id: string) {
		void goto(id ? withParam(page.url, 'series', id) : withoutParam(page.url, 'series'), { reset: false });
	}

	// A link to the panel (`#warn-checks`): the tab is a lazy chunk, so land once drawn (help/anchor.ts).
	onMount(() =>
		followAnchors({
			page: 'warnings',
			land: (hash) => (hash === 'warn-checks' ? landOnAnchor(hash) : undefined),
			forward: (to) => void goto(to, { replace: true, reset: false })
		})
	);

	$effect(() => fillHeader({ context: headerContext, actions: headerActions }));
</script>

{#snippet headerContext()}
	<span data-testid="warnings-context">
		{#if !values}Checking the series…{:else if !items.length}No flagged periods in {fmtNum(series?.length ?? 0)} series{:else}{fmtNum(open)} open of {fmtNum(items.length)} flagged
			{items.length === 1 ? 'period' : 'periods'} in {fmtNum(recordsWithItems)} {recordsWithItems === 1 ? 'record' : 'records'}{/if}
	</span>
{/snippet}
{#snippet headerActions()}
	<a class="btn" href="?tab=series#data-checks">Data checks on Data</a>
{/snippet}

<div class="warnings" data-testid="warnings">
	<section class="panel" id="warn-checks" aria-labelledby="warn-checks-h" aria-busy={saving || undefined}>
		<div class="panel-head">
			<div class="head-text">
				<div class="h-row"><h2 id="warn-checks-h" tabindex="-1">Data checks</h2><HelpTip key="data-quality-limits" label="About the data checks" /></div>
				<p class="muted small intro">
					Each period a check flagged on a stored series.
					{#if canEdit}Patch rain to read it as missing and fill it, exclude flow from calibration, or keep the values as recorded. Each
						decision saves to the settings at once.{:else}An editor patches rain, excludes flow from calibration or keeps the values as recorded.{/if}
				</p>
			</div>
		</div>

		<LoadState loading={loading && !values} error={loadError} retry={load}>
			{#if failedNames.length}
				<p class="alert alert-warning small" role="status">Couldn’t read {failedNames.join(', ')}: {failedNames.length === 1 ? 'its' : 'their'} periods aren’t listed. <button type="button" class="btn btn-sm" onclick={load}>Try again</button></p>
			{/if}
			{#if runError}
				<p class="alert alert-warning small" role="status">Couldn’t read the shown run: its accumulations and flow double mass aren’t listed ({runError}).</p>
			{/if}
			{#if !items.length}
				<p class="empty" data-testid="warnings-empty">
					{#if !series?.length}No input series yet: add rain and flow on <a href="?tab=series">Data</a>, and their checks show here.{:else}No data check flags a period
						in the loaded series.{/if}
				</p>
			{:else}
				<div class="filters" data-testid="warnings-filters">
					<div class="chips" role="group" aria-label="Status">
						{#each STATUS_FILTERS as s (s)}
							{#if counts.status[s] || s === 'open' || s === 'all' || filters.status === s}
								<a class="chip" href={statusHref(s)} aria-current={filters.status === s ? 'true' : undefined} data-sveltekit-noscroll data-sveltekit-keepfocus
									>{STATUS_LABEL[s]} <span class="n">{counts.status[s]}</span></a
								>
							{/if}
						{/each}
					</div>
					<div class="chips" role="group" aria-label="Check">
						<a class="chip" href={checkHref(null)} aria-current={!filters.check ? 'true' : undefined} data-sveltekit-noscroll data-sveltekit-keepfocus
							>All checks <span class="n">{counts.checkAll}</span></a
						>
						{#each counts.check as c (c.check)}
							<a class="chip" href={checkHref(c.check)} aria-current={filters.check === c.check ? 'true' : undefined} data-sveltekit-noscroll data-sveltekit-keepfocus
								>{CHECK_LABEL[c.check]} <span class="n">{c.count}</span></a
							>
						{/each}
					</div>
					<label class="record-pick">
						<span>Record</span>
						<select value={filters.series ?? ''} onchange={(e) => setRecord(e.currentTarget.value)} data-testid="warnings-record">
							<option value="">All records ({counts.recordAll})</option>
							{#each counts.records as r (r.id)}<option value={r.id}>{r.label} ({r.count})</option>{/each}
						</select>
					</label>
				</div>

				{#if canEdit && shown.length}
					<!-- The bulk actions above the rows, in one row (ui-playbook.md § 4 "A grid's actions go above it"): always drawn, so
					     ticking a row never moves the list; each button names its count and is aria-disabled at none. -->
					<div class="toolbar bulk" role="toolbar" aria-label="Decide the ticked periods" data-testid="warnings-bulk">
						<span class="picked" aria-live="polite">{picked.length ? `${fmtNum(picked.length)} ticked` : 'None ticked'}</span>
						{#if picked.length < shown.length}
							<button type="button" class="btn btn-sm" onclick={selectAllMatching}>Select all {fmtNum(shown.length)} matching</button>
						{/if}
						{#if picked.length}<button type="button" class="btn btn-sm" onclick={() => (selected = new Set())}>Clear</button>{/if}
						<span class="sep" aria-hidden="true"></span>
						{#each bulkDecisions as d (d)}
							{@const n = bulkCount(d)}
							<button
								type="button"
								class="btn btn-sm"
								class:btn-primary={d !== 'keep'}
								aria-disabled={n === 0 || saving || undefined}
								onclick={() => void decideBulk(d)}>{d === 'exclude' ? 'Exclude' : DECISION_LABEL[d]}{#if d === 'exclude'}<span class="visually-hidden">{' '}from calibration</span>{/if}{' '}{fmtNum(n)}</button
							>
						{/each}
					</div>
				{/if}
				{#if notice}
					<p class="alert notice small" class:alert-error={notice.tone === 'error'} class:alert-info={notice.tone === 'ok'} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="warnings-notice">
						{notice.text}
					</p>
				{/if}

				{#if !shown.length}
					<p class="empty" data-testid="warnings-none">
						{filters.status === 'open' ? 'Nothing open' : 'Nothing'} matches these filters.
						<a href={everyHref} data-sveltekit-noscroll>Show every period</a>
					</p>
				{:else}
					<div class="table-wrap">
						<table class="data rows" data-testid="warnings-table">
							<caption class="visually-hidden">Flagged periods, in date order</caption>
							<thead>
								<tr>
									{#if canEdit}
										<th scope="col" class="c-pick">
											<label class="check"
												><input type="checkbox" checked={allVisiblePicked} onchange={(e) => toggleVisible(e.currentTarget.checked)} /><span
													class="visually-hidden">Tick every period shown</span
												></label
											>
										</th>
									{/if}
									<th scope="col">Period</th>
									<th scope="col">Record</th>
									<th scope="col">What the check saw</th>
									<th scope="col">Status</th>
									{#if canEdit}<th scope="col"><span class="visually-hidden">Decision</span></th>{/if}
								</tr>
							</thead>
							<tbody id="warn-rows">
								{#each visible as i, at (i.id)}
									{@const what = `${CHECK_LABEL[i.check]}, ${i.record}, ${periodText(i)}`}
									{@const href = settingHref(i)}
									<tr data-item={i.id} data-status={i.status} class:ticked={selected.has(i.id)}>
										{#if canEdit}
											<td class="c-pick">
												<label class="check"
													><input type="checkbox" checked={selected.has(i.id)} onchange={(e) => toggle(i.id, e.currentTarget.checked)} /><span class="visually-hidden"
														>Tick {what}</span
													></label
												>
											</td>
										{/if}
										<th scope="row" class="c-period">
											<span class="when">{periodText(i)}</span>
											<span class="sub">{daysText(i.days)}</span>
										</th>
										<td class="c-record"><span class="cell-label">Record:{' '}</span>{i.record}</td>
										<td class="c-what">
											<span class="badge badge-warn">{CHECK_LABEL[i.check]}</span>
											<span class="sub">{whatText(i)}</span>
										</td>
										<td class="c-status">
											<span class="pill tone-{i.status}">{STATUS_LABEL[i.status]}</span>
											<span class="sub">{statusDetail(i)}{#if href}{' '}<a href={href}>In settings</a>{/if}</span>
										</td>
										{#if canEdit}
											<td class="c-act">
												<div class="row-actions">
													{#each decisionsFor(i) as d, k (d)}
														<button
															type="button"
															class="btn btn-sm"
															data-row-action={k === 0 ? '' : undefined}
															aria-disabled={saving || undefined}
															aria-label="{DECISION_LABEL[d]}: {what}"
															onclick={() => void decideRow(i, d, at)}>{d === 'exclude' ? 'Exclude' : DECISION_LABEL[d]}</button
														>
													{:else}
														<button type="button" class="btn btn-sm" data-row-action aria-disabled={saving || undefined} aria-label="Reopen: {what}" onclick={() => void decideRow(i, 'reopen', at)}
															>Reopen</button
														>
													{/each}
												</div>
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if shown.length > FOLD}
						<button type="button" class="btn btn-sm fold" aria-expanded={allShown} aria-controls="warn-rows" onclick={() => (allShown = !allShown)}
							>{allShown ? `Show only the first ${FOLD} periods` : `Show all ${fmtNum(shown.length)} periods`}</button
						>
					{/if}
				{/if}
			{/if}
		</LoadState>
	</section>

</div>

<style>
	.warnings {
		container: warnings / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.warnings > .panel {
		margin: 0;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}
	.h-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.h-row h2 {
		margin: 0;
	}
	.intro {
		margin: 0;
		max-width: 90ch;
	}
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin: 0.5rem 0 0.6rem;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 32px;
		padding: 0.2rem 0.65rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		color: var(--text-2);
		text-decoration: none;
		font-size: 0.85rem;
		font-weight: 600;
		background: var(--surface);
		white-space: nowrap;
	}
	.chip:hover {
		border-color: var(--accent);
	}
	.chip[aria-current='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--text);
	}
	.chip .n {
		font-variant-numeric: tabular-nums;
		font-weight: 400;
	}
	.record-pick {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.record-pick select {
		max-width: 22rem;
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 0.5rem;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
	}
	.picked {
		font-weight: 600;
		min-width: 6.5rem;
	}
	.sep {
		width: 1px;
		align-self: stretch;
		background: var(--border);
		margin: 0 0.2rem;
	}
	.notice {
		margin: 0 0 0.5rem;
		padding: 0.35rem 0.6rem;
		border-radius: var(--radius);
	}
	/* The page flows in the window's one scroll: the rows don't scroll in a box of their own (folded instead). */
	.table-wrap {
		max-height: none;
	}
	.rows tbody th,
	.rows tbody td {
		vertical-align: top;
	}
	.rows tbody th {
		font-weight: 600;
	}
	tr.ticked > * {
		background: var(--accent-soft);
	}
	.c-pick {
		width: 2.2rem;
	}
	.c-pick .check {
		min-height: 24px;
		align-items: center;
	}
	.when {
		white-space: nowrap;
	}
	.sub {
		display: block;
		font-size: var(--font-sm);
		color: var(--text-2);
		font-weight: 400;
	}
	.c-what .badge {
		margin-bottom: 0.15rem;
	}
	.c-status {
		min-width: 12rem;
	}
	.c-act {
		white-space: nowrap;
	}
	.row-actions {
		display: flex;
		gap: 0.3rem;
		justify-content: flex-end;
	}
	/* The status in words; the tone repeats it. */
	.pill {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		font-size: var(--font-sm);
		font-weight: 600;
		line-height: 1.4;
		background: var(--surface-2);
		color: var(--text-2);
		white-space: nowrap;
	}
	.tone-open {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.tone-patched,
	.tone-excluded {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--text);
	}
	.tone-handled {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	.fold {
		margin-top: 0.5rem;
	}
	.empty {
		margin: 0.5rem 0 0;
		color: var(--text-2);
	}
	.cell-label {
		display: none;
	}
	/* Narrow (under 640 px): each period a card; the page scrolls, not a box inside it (Applications' pattern). */
	@container warnings (max-width: 45.7rem) {
		.table-wrap {
			max-height: none;
			border: 0;
			background: none;
		}
		.rows thead {
			display: none;
		}
		.rows,
		.rows tbody {
			display: block;
		}
		.rows tbody {
			display: grid;
			gap: 0.6rem;
		}
		.rows tr {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-areas:
				'pick period'
				'pick record'
				'pick what'
				'pick status'
				'act act';
			gap: 0.3rem 0.6rem;
			padding: 0.65rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: var(--surface);
		}
		.rows tr > * {
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
			background: none;
		}
		tr.ticked {
			background: var(--accent-soft);
			border-color: var(--accent);
		}
		.c-pick {
			grid-area: pick;
			width: auto;
		}
		.c-period {
			grid-area: period;
		}
		.c-record {
			grid-area: record;
		}
		.c-what {
			grid-area: what;
		}
		.c-status {
			grid-area: status;
			min-width: 0;
		}
		.c-act {
			grid-area: act;
			white-space: normal;
		}
		.row-actions {
			justify-content: flex-start;
		}
		/* The bulk row: the count and Select all on one line, the decisions sharing the next. */
		.bulk .sep {
			flex-basis: 100%;
			height: 0;
			width: auto;
			margin: 0;
			background: none;
		}
		.bulk > .btn {
			min-height: 44px;
		}
		.bulk .sep ~ .btn {
			flex: 1 1 0;
		}
		.row-actions .btn {
			min-height: 44px;
			flex: 1 1 0;
		}
		.cell-label {
			display: inline;
			color: var(--text-2);
		}
		.when {
			white-space: normal;
		}
	}
</style>
