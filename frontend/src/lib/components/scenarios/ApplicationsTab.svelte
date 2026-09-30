<script lang="ts">
	// The assessors' Applications tab (?tab=applications, WP-3.3, docs/ui.md
	// § Applications; issue #17 option A): every application an applicant has
	// submitted. The section header carries the count, how many await a
	// decision and for how long, and "Decide the longest waiting"; the card
	// filters by status (`status=` in the URL, so Back returns to the last
	// filter) and sorts by date or status. From 1100 × 620 the card fills the
	// window and the rows scroll inside it; in a narrow column each row is a
	// card. Opening one goes to the Scenarios tab, where an editor who didn't
	// make it decides it. Drafts never appear: they are the applicant's alone
	// (RLS, 045_contributor_scope). Each row lists the application's evidence
	// packs (WP-3.14) with their status, newest version first, each linking to
	// its page, and has its comments (the notes drawer on the scenario,
	// WP-3.15); its share links are in the scenario's Application panel.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, type Pack, type Scenario } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import PackBadge from '$lib/components/packs/PackBadge.svelte';
	import { packHref, packsByScenario } from '$lib/components/packs/pack';
	import NotesDrawer from '$lib/components/notes/NotesDrawer.svelte';
	import { scenarioAudiences } from '$lib/components/notes/notes';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { fmtDate } from '$lib/format/number';
	import { withoutParam, withParam } from '$lib/workspace/overlays';
	import {
		APPLICATION_FILTERS,
		applicationCounts,
		applicationsContext,
		daysSince,
		daysText,
		FILTER_LABEL,
		filterApplications,
		longestWaiting,
		parseFilter,
		sortApplications,
		statusPill,
		type ApplicationFilter,
		type ApplicationSort
	} from './applications';

	let { projectId }: { projectId: string } = $props();

	let items = $state<Scenario[] | null>(null);
	/** The project's evidence packs by application; null when they couldn't be read (the list still shows). */
	let packs = $state.raw<Map<string | null, Pack[]> | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let sort = $state<ApplicationSort>('date');
	/** When the list was loaded: "waiting N days" counts from here. */
	let now = $state(Date.now());

	async function load() {
		loading = true;
		error = null;
		try {
			const [list, pk] = await Promise.all([api.scenarios.applications(projectId), api.packs.list(projectId).catch(() => null)]);
			items = list;
			packs = pk ? packsByScenario(pk) : null;
			now = Date.now();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	const filter = $derived(parseFilter(page.url.searchParams.get('status')));
	const counts = $derived(applicationCounts(items ?? []));
	const shown = $derived(sortApplications(filterApplications(items ?? [], filter), sort));
	const next = $derived(longestWaiting(items ?? []));
	// The assessors' list: they write to the assessors by default.
	const ASSESSOR_AUDIENCES = scenarioAudiences({ assessor: true, party: false });
	const scenarioHref = (id: string) => `?tab=scenarios&scenario=${encodeURIComponent(id)}`;
	const filterHref = (f: ApplicationFilter) => (f === 'all' ? withoutParam(page.url, 'status') : withParam(page.url, 'status', f));
	const EMPTY_FILTER: Record<ApplicationFilter, string> = {
		all: 'No applications submitted.',
		awaiting: 'Nothing is awaiting a decision.',
		decided: 'No application has been decided yet.',
		withdrawn: 'No application has been withdrawn.'
	};

	// --- fitting the window (the playbook's dashboards): from 1100 × 620, measured, not assumed ---
	let root: HTMLDivElement | undefined = $state();
	let innerW = $state(0);
	let innerH = $state(0);
	let top = $state(0);
	const fit = $derived(!!items?.length && innerW >= 1100 && innerH >= 620);
	$effect(() => {
		if (!root) return;
		const el = root;
		const measure = () => (top = el.getBoundingClientRect().top + window.scrollY);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(document.body);
		return () => ro.disconnect();
	});

	$effect(() => fillHeader(items ? { context: headerContext, actions: headerActions } : {}));
</script>

<svelte:window bind:innerWidth={innerW} bind:innerHeight={innerH} />

{#snippet headerContext()}<span>{applicationsContext(items ?? [], now)}</span>{/snippet}
{#snippet headerActions()}
	{#if next}<a class="btn" href={scenarioHref(next.id)} title="Open “{next.name}”, waiting longest">Decide the longest waiting</a>{/if}
{/snippet}

<div class="applications" class:fit bind:this={root} style:--ap-top="{top}px" data-testid="applications">
	<section class="panel apps-card" aria-labelledby="applications-h">
		<div class="panel-head">
			<div class="head-text">
				<!-- Not "Applications": the page's h1 already says it, and the tab body is the region of that name. -->
				<h2 id="applications-h">Submitted applications</h2>
				<span class="muted small">On the published baseline. Open one to see its changes and runs, and to decide it. Drafts stay with the applicant.</span>
			</div>
			{#if items?.length}
				<div class="tools">
					<div class="filters" role="group" aria-label="Show applications">
						{#each APPLICATION_FILTERS as f (f)}
							<a
								class="chip"
								href={filterHref(f)}
								aria-current={filter === f ? 'true' : undefined}
								data-sveltekit-noscroll
								data-sveltekit-keepfocus
							>
								{FILTER_LABEL[f]} <span class="n">{counts[f]}</span>
							</a>
						{/each}
					</div>
					<div class="field sort">
						<label for="applications-sort">Sort by</label>
						<select id="applications-sort" bind:value={sort}>
							<option value="date">Newest first</option>
							<option value="status">Status</option>
						</select>
					</div>
				</div>
			{/if}
		</div>
		<LoadState {loading} {error} retry={load}>
			{#if !items?.length}
				<div class="empty-box">
					<p class="empty" data-testid="applications-empty">No applications submitted.</p>
					<p class="small">
						An applicant (a member with the Applicant role) starts an application on the published baseline, and it shows here once they
						submit it. Add applicants on the <a href="?tab=project">Project page</a>; publish a run as the baseline in
						<a href="?tab=runs">Runs &amp; results</a>.
					</p>
				</div>
			{:else if !shown.length}
				<p class="empty" data-testid="applications-none">{EMPTY_FILTER[filter]} <a href={filterHref('all')} data-sveltekit-noscroll>Show all</a></p>
			{:else}
				<div class="table-wrap">
					<table class="data apps">
						<thead>
							<tr>
								<th scope="col">Application</th>
								<th scope="col">Applicant</th>
								<th scope="col">Status</th>
								<th scope="col">Submitted</th>
								<th scope="col" class="num">Changes</th>
								<th scope="col" class="num">Runs</th>
								<th scope="col">Evidence packs</th>
								<th scope="col"><span class="visually-hidden">Comments</span></th>
							</tr>
						</thead>
						<tbody>
							{#each shown as a (a.id)}
								{@const pill = statusPill(a)}
								<tr data-status={a.status}>
									<th scope="row" class="c-name"><a href={scenarioHref(a.id)}>{a.name}</a></th>
									<td class="c-who">
										{a.owner ?? '—'}
										{#if a.members.length}<span class="sub">shared with {a.members.length}</span>{/if}
									</td>
									<td class="c-status">
										<span class="pill tone-{pill.tone}">{pill.text}</span>
										{#if a.status === 'decided' && a.decidedAt}<span class="sub">decided {fmtDate(a.decidedAt)}</span>{/if}
									</td>
									<td class="c-when">
										<span class="cell-label">Submitted{' '}</span>{a.submittedAt ? fmtDate(a.submittedAt, true) : '—'}
										{#if a.status === 'submitted' && a.submittedAt}<span class="sub wait">waiting {daysText(daysSince(a.submittedAt, now))}</span>{/if}
									</td>
									<td class="num c-ops">{a.ops.length}<span class="cell-label">{' '}change{a.ops.length === 1 ? '' : 's'}</span></td>
									<td class="num c-runs">{a.runCount}<span class="cell-label">{' '}run{a.runCount === 1 ? '' : 's'}</span></td>
									<td class="c-packs" data-testid="application-packs">
										{#if packs === null}
											<span class="sub">couldn’t be read</span>
										{:else}
											{@const list = packs.get(a.id) ?? []}
											<span class="cell-label">Evidence packs:{' '}</span>
											{#each list as p (p.id)}
												<a class="pack-link" href={packHref(base, projectId, p.id)}><span class="visually-hidden">Evidence pack{' '}</span><PackBadge status={p.status} version={p.version} /></a>
											{:else}
												<span class="sub none">none</span>
											{/each}
										{/if}
									</td>
									<td class="c-notes"><NotesDrawer {projectId} compact target={{ kind: 'scenario', scenarioId: a.id, name: a.name, audiences: ASSESSOR_AUDIENCES }} /></td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</LoadState>
	</section>
</div>

<style>
	.applications {
		container: applications / inline-size;
		display: flex;
		flex-direction: column;
	}
	.applications > .panel {
		margin: 0;
	}
	/* Wide and tall enough: the card is the height left in the window; the rows scroll inside it. */
	.applications.fit {
		height: max(360px, calc(100vh - var(--ap-top, 0px) - var(--dock-h, 0px) - 1rem));
	}
	.fit .apps-card {
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.fit .table-wrap {
		flex: 1 1 auto;
		min-height: 0;
		max-height: none;
	}
	.panel-head {
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.6rem 1rem;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		flex: 1 1 22rem;
		min-width: 0;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.filters {
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
		color: var(--text-2);
		font-weight: 400;
	}
	.sort {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
	}
	.sort label {
		margin: 0;
		white-space: nowrap;
	}
	.apps tbody td,
	.apps tbody th {
		vertical-align: top;
	}
	.c-name a {
		overflow-wrap: anywhere;
	}
	.sub {
		display: block;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.wait {
		font-weight: 600;
	}
	.c-packs {
		white-space: normal;
	}
	.pack-link {
		display: inline-block;
		min-height: 24px;
		margin: 0 0.25rem 0.25rem 0;
		text-decoration: none;
	}
	.c-packs .none {
		display: inline;
	}
	/* The status in words; the band colour repeats it. */
	.pill {
		display: inline-block;
		padding: 0.05rem 0.5rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		font-size: 0.8rem;
		font-weight: 600;
		line-height: 1.4;
		background: var(--surface-2);
		color: var(--text-2);
		white-space: nowrap;
	}
	.tone-awaiting {
		background: var(--accent-soft);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
		color: var(--text);
	}
	.tone-good {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	.tone-mixed {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.tone-bad {
		background: var(--danger-soft);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--danger);
	}
	.empty {
		margin: 0.5rem 0 0;
		color: var(--text-2);
	}
	.empty-box {
		margin-top: 0.5rem;
		padding: 1.25rem;
		text-align: center;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty-box .empty {
		margin: 0 0 0.35rem;
		font-weight: 600;
	}
	.empty-box .small {
		max-width: 65ch;
		margin: 0 auto;
		color: var(--text-2);
	}
	.cell-label {
		display: none;
	}
	/* Narrow (under 640 px): each application a card, the page scrolling rather than a box inside it. */
	@container applications (max-width: 45.7rem) {
		.table-wrap {
			max-height: none;
			border: 0;
			background: none;
		}
		.apps thead {
			display: none;
		}
		.apps,
		.apps tbody {
			display: block;
		}
		.apps tbody {
			display: grid;
			gap: 0.6rem;
		}
		.apps tr {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			grid-template-areas:
				'name name'
				'status status'
				'who who'
				'when when'
				'ops runs'
				'packs packs'
				'notes notes';
			justify-content: start;
			gap: 0.35rem 1rem;
			padding: 0.75rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
			background: var(--surface);
		}
		.apps tr > * {
			min-width: 0;
			padding: 0;
			border: 0;
			text-align: left;
		}
		.c-name {
			grid-area: name;
			font-size: 1rem;
		}
		.c-status {
			grid-area: status;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.2rem 0.6rem;
		}
		.c-who {
			grid-area: who;
		}
		.c-when {
			grid-area: when;
		}
		.c-ops {
			grid-area: ops;
		}
		.c-runs {
			grid-area: runs;
		}
		.c-packs {
			grid-area: packs;
		}
		.c-notes {
			grid-area: notes;
		}
		.c-status .sub {
			display: inline;
		}
		.cell-label {
			display: inline;
		}
		.c-when .cell-label {
			color: var(--text-2);
		}
	}
</style>
