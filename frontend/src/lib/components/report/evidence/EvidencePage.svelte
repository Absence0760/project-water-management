<script lang="ts">
	// The report route's evidence mode (issue #71, WP-2.15 Phase C; docs/ui.md
	// § Evidence report): /projects/:id/report?run=<runId>&evidence. The run is
	// an application run (a scenario run, reported against its base) or the
	// nominated run alone. The server builds the whole report
	// (GET …/runs/:runId/evidence-report); this page shows the checks (board 1),
	// a refusal when the run isn't evidence (board 2), or the report itself in
	// its own chunk. data-report-ready follows the same contract as the
	// catchment report, so e2e and a server render wait on it.
	import { untrack } from 'svelte';
	import { base } from '$app/paths';
	import { REPORT_FOOTER, type EvidenceReport } from '@water-management/engine';
	import { api, ApiError, type Project, type SignoffList } from '$lib/api';
	import ChunkFailed from '$lib/components/common/ChunkFailed.svelte';
	import Lazy from '$lib/components/common/Lazy.svelte';
	import { loadOnce } from '$lib/components/common/lazy';
	import { boardChecks, DRAFT_STAMP, refusedChecks } from './sections';

	let { projectId, runId }: { projectId: string; runId: string | null } = $props();

	const loadReport = () => import('./EvidenceReport.svelte');

	let project = $state.raw<Project | null>(null);
	let report = $state.raw<EvidenceReport | null>(null);
	let signoffs = $state.raw<SignoffList | null>(null);
	let status = $state<'loading' | 'loaded' | 'no-run' | 'not-found' | 'forbidden' | 'error' | 'chunk-failed'>('loading');
	let error = $state('');

	async function load(id: string, rid: string | null) {
		status = 'loading';
		report = null;
		if (!rid) {
			status = 'no-run';
			return;
		}
		try {
			const [p, r, so] = await Promise.all([api.projects.get(id), api.evidence.report(id, rid), api.signoffs.list(id, rid)]);
			project = p;
			report = r;
			signoffs = so;
			if (!r.refused) {
				try {
					await loadOnce(loadReport);
				} catch {
					status = 'chunk-failed';
					return;
				}
			}
			status = 'loaded';
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) status = 'not-found';
			else if (e instanceof ApiError && e.status === 403) status = 'forbidden';
			else {
				error = e instanceof Error ? e.message : String(e);
				status = 'error';
			}
		}
	}
	$effect(() => {
		const id = projectId;
		const rid = runId;
		untrack(() => load(id, rid));
	});

	async function signoffsChanged(next: SignoffList['signoffs'] | null) {
		if (!signoffs || !runId) return;
		if (next) signoffs = { ...signoffs, signoffs: next };
		else signoffs = await api.signoffs.list(projectId, runId);
	}

	const ready = $derived(status === 'loaded');
	const title = $derived(report?.identity.title ?? '');
	const footer = $derived(project && report ? `${DRAFT_STAMP} · ${REPORT_FOOTER(project.name, title, 'Appendix B.3')}` : undefined);
	const back = $derived(
		report?.identity.application ? `${base}/projects/${projectId}?tab=scenarios&scenario=${encodeURIComponent(report.identity.application.scenarioId)}` : `${base}/projects/${projectId}?tab=runs${runId ? `&run=${encodeURIComponent(runId)}` : ''}`
	);
	const failed = $derived(report ? refusedChecks(report) : []);
</script>

<svelte:head><title>{project ? `Evidence report · ${project.name} · ` : ''}Water Management</title></svelte:head>

<main class="page report ev-page" data-report-ready={ready || undefined} data-report-footer={footer} aria-busy={status === 'loading'}>
	{#if status === 'not-found'}
		<div class="alert alert-error" role="alert">This project or run doesn't exist, or you don't have access to it. <a href="{base}/">Back to projects</a></div>
	{:else if status === 'forbidden'}
		<div class="alert alert-error" role="alert">An evidence report needs the viewer role or above on this project.</div>
	{:else if status === 'no-run'}
		<div class="alert alert-info" role="status">Choose a run for the evidence report. <a href="{base}/projects/{projectId}?tab=runs">Go to Runs &amp; results</a></div>
	{:else if status === 'error'}
		<div class="alert alert-error" role="alert">
			The evidence report could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, runId)}>Try again</button>
		</div>
	{:else if status === 'chunk-failed'}
		<ChunkFailed what="The evidence report" />
	{/if}

	{#if status === 'loading' || status === 'loaded'}
		<div class="bar no-print">
			<a href={back}>← Back</a>
			<button type="button" class="btn btn-primary" disabled={!ready || !!report?.refused} onclick={() => window.print()}>Download draft PDF</button>
			<a class="btn" href="{base}/projects/{projectId}/report?run={runId}">Catchment report</a>
			<p class="muted small" role="status">
				{#if !ready}Preparing the evidence report…{:else}A draft: every page says “{DRAFT_STAMP}”. Issuing, with a hash and a verify link, is an evidence pack (WP-3.14).{/if}
			</p>
		</div>
	{/if}

	{#if status === 'loaded' && report}
		{#if report.refused}
			<section class="board" aria-labelledby="ev-refused-h" data-testid="evidence-refused">
				<h1 id="ev-refused-h">This run can’t be reported as evidence</h1>
				<p>An evidence report is built only from the project’s current nominated run and an application run on it (docs/design/evidence-report.md §2). This run fails:</p>
				<ul class="checks">
					{#each failed as c (c.id)}
						<li><strong>{c.label}.</strong> {c.detail}{#if c.fix}<span class="fix"> Way out: {c.fix}</span>{/if}</li>
					{/each}
				</ul>
				<p><a href="{base}/projects/{projectId}/report?run={runId}">Open the ordinary catchment report of this run</a>: it isn’t evidence, and says so.</p>
			</section>
		{:else}
			<details class="board no-print" data-testid="evidence-checks" open>
				<summary>
					<strong>Checks</strong>
					{report.issuable ? 'Every check that stops a pack being issued passes.' : 'Some checks stop this report being issued as a pack.'}
				</summary>
				<ul class="checks">
					{#each boardChecks(report) as c (c.id)}
						<li class:fail={!c.passed}>
							<span class="mark" aria-hidden="true">{c.passed ? '✓' : c.blocksIssue || c.refuses ? '✗' : '!'}</span>
							<span><strong>{c.label}</strong>{c.passed ? '' : c.blocksIssue ? ' (stops issue)' : ' (printed, doesn’t stop issue)'}. {c.detail}{#if c.fix}<span class="fix"> {c.fix}</span>{/if}</span>
						</li>
					{/each}
				</ul>
				{#if report.questions.length}
					<p class="small"><strong>Expect questions about:</strong></p>
					<ul class="small questions">{#each report.questions as q, i (i)}<li>{q}</li>{/each}</ul>
				{/if}
			</details>
			<Lazy load={loadReport}>
				{#snippet children(EvidenceReportView)}
					<EvidenceReportView report={report!} {projectId} stamp={DRAFT_STAMP} {signoffs} signoffRunId={runId} onsignoffchange={signoffsChanged} />
				{/snippet}
			</Lazy>
		{/if}
	{/if}
</main>

<style>
	.ev-page {
		max-width: 1000px;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-bottom: 1rem;
	}
	.bar p {
		margin: 0;
		flex-basis: 100%;
	}
	.board {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 0.75rem 1rem;
		margin-bottom: 1.25rem;
	}
	.board h1 {
		margin-top: 0;
		font-size: 1.35rem;
	}
	summary {
		cursor: pointer;
	}
	.checks {
		list-style: none;
		padding: 0;
		margin: 0.5rem 0;
		display: grid;
		gap: 0.35rem;
	}
	.checks li {
		display: flex;
		gap: 0.5rem;
		max-width: 90ch;
	}
	.checks li.fail {
		font-weight: 500;
	}
	.mark {
		flex: none;
		width: 1.2rem;
		text-align: center;
		font-weight: 700;
	}
	.fix {
		display: block;
		color: var(--text-muted);
		font-weight: 400;
	}
	.questions {
		margin: 0.25rem 0 0;
		padding-left: 1.3rem;
		max-width: 90ch;
	}
	@media print {
		:global(body:has(main.ev-page) .verify-banner),
		.no-print {
			display: none !important;
		}
		:global(html:has(main.ev-page)),
		:global(body:has(main.ev-page)) {
			background: #fff;
		}
		.ev-page {
			max-width: none;
			padding: 0;
			font-size: 9.5pt;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}
		.ev-page :global(table.data) {
			font-size: 7.5pt;
		}
		.ev-page :global(.table-wrap) {
			overflow: visible;
			max-height: none;
			border: 0;
		}
		.ev-page :global(h2),
		.ev-page :global(h3) {
			break-after: avoid;
		}
		.ev-page :global(tr),
		.ev-page :global(figure) {
			break-inside: avoid;
		}
	}
</style>
