<script lang="ts">
	// Where an emailed report link lands (WP-2.15 Phase B; docs/ui.md §
	// Report): /projects/:id/reports/:jobId. Signed out, the layout sends the
	// reader to sign in and back. A member sees which catchment and run the PDF
	// is of, its status and, once it is ready, a download link (the API's
	// route, which checks membership on each click and redirects to a
	// one-minute pre-signed GET); anyone else gets the workspace's not-found
	// message, so a forwarded email opens nothing.
	import { onDestroy, untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { describeReport, isPending, type ReportState, type ReportStatus, reportsApi } from '$lib/components/report/serverPdf';
	import { fmtDate } from '$lib/format/number';

	const projectId = $derived(page.params.id ?? '');
	const jobId = $derived(page.params.jobId ?? '');

	let current = $state<ReportStatus | null>(null);
	let phase = $state<'loading' | 'loaded' | 'not-found' | 'error'>('loading');
	let error = $state('');
	// Which catchment and run the PDF is of: the header's context. Best effort,
	// read once; the status doesn't wait for them.
	let projectName = $state<string | null>(null);
	let runLabel = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	onDestroy(() => {
		stopped = true;
		clearTimeout(timer);
	});

	async function load(id: string, job: string) {
		clearTimeout(timer);
		try {
			current = await reportsApi(api, id).get(job);
			phase = 'loaded';
			if (!stopped && isPending(current.report.status)) timer = setTimeout(() => load(id, job), 2000);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) phase = 'not-found';
			else {
				error = e instanceof Error ? e.message : String(e);
				phase = 'error';
			}
		}
	}
	async function loadContext(id: string) {
		projectName = runLabel = null;
		const [p, runs] = await Promise.all([api.projects.get(id).catch(() => null), api.runs.list(id).catch(() => null)]);
		projectName = p?.name ?? null;
		const runId = current?.report.runId;
		const run = runId ? runs?.find((r) => r.id === runId) : null;
		runLabel = run ? run.label || `Run of ${fmtDate(run.createdAt, true)}` : null;
	}
	$effect(() => {
		const id = projectId;
		const job = jobId;
		untrack(async () => {
			await load(id, job);
			if (phase === 'loaded') await loadContext(id);
		});
	});

	/** The state in one word, for the pill; the status line beside it says the rest. */
	const STATE_WORD: Record<ReportState, string> = { queued: 'Queued', rendering: 'Making', retrying: 'Retrying', done: 'Ready', failed: 'Failed' };
	const jobState = $derived(current?.report.status ?? null);
	const runHref = $derived(`${base}/projects/${encodeURIComponent(projectId)}?tab=runs${current?.report.runId ? `&run=${encodeURIComponent(current.report.runId)}` : ''}`);
	const reportHref = $derived(`${base}/projects/${encodeURIComponent(projectId)}/report${current?.report.runId ? `?run=${encodeURIComponent(current.report.runId)}` : ''}`);
</script>

<svelte:head><title>Report PDF{projectName ? ` · ${projectName}` : ''} · Water Management</title></svelte:head>

<main class="page report-job" aria-busy={phase === 'loading'}>
	<header class="head">
		<h1>Catchment report PDF</h1>
		{#if phase === 'loaded' && (projectName || runLabel)}
			<p class="muted context" data-testid="report-job-context">
				{#if projectName}<span>{projectName}</span>{/if}{#if projectName && runLabel}{' · '}{/if}{#if runLabel}<span>Run “{runLabel}”</span>{/if}
			</p>
		{/if}
	</header>

	{#if phase === 'loading'}
		<p class="muted" role="status">Loading…</p>
	{:else if phase === 'not-found'}
		<div class="alert alert-error" role="alert">
			This report doesn't exist any more, or you don't have access to its project. PDFs are kept for 7 days.
			<a href="{base}/">Back to projects</a>
		</div>
	{:else if phase === 'error'}
		<div class="alert alert-error" role="alert">
			The report could not be loaded: {error}
			<button type="button" class="btn btn-sm" onclick={() => load(projectId, jobId)}>Try again</button>
		</div>
	{:else if current && jobState}
		<section class="panel job" data-state={jobState} aria-labelledby="job-status-h">
			<h2 id="job-status-h" class="visually-hidden">Status</h2>
			<div class="status-row">
				<span class="pill pill-{jobState}">{STATE_WORD[jobState]}</span>
				<p class="status" role="status">{describeReport(current.report, false)}</p>
			</div>
			{#if current.report.createdAt}
				<p class="muted small">
					Asked for {fmtDate(current.report.createdAt, true)}{current.report.scheduled ? ' by a report schedule' : ''}.
					{#if isPending(jobState)}This page checks again every few seconds.{/if}
				</p>
			{/if}
			{#if current.url}
				<p class="download">
					<a class="btn btn-primary" href={current.url} rel="noopener">Download the PDF</a>
					<span class="muted small">PDFs are kept for 7 days.</span>
				</p>
			{:else if jobState === 'failed'}
				<p class="small">Open the report to make the PDF again, or print it from your browser.</p>
			{/if}
			<nav class="links" aria-label="Report links">
				<a href={reportHref}>Open the report in the app</a>
				<a href={runHref}>{current.report.runId ? 'Go to the run' : 'Go to Runs & results'}</a>
			</nav>
		</section>
	{/if}
</main>

<style>
	/* A status page: one card under the title, as wide as reads well. */
	.report-job {
		max-width: 52rem;
	}
	.head {
		margin: 0 0 1rem;
	}
	.head h1 {
		margin: 0;
		font-size: 1.75rem;
		line-height: 1.2;
	}
	.context {
		margin: 0.25rem 0 0;
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	.job > :last-child {
		margin-bottom: 0;
	}
	.status-row {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
		margin-bottom: 0.5rem;
	}
	.status {
		margin: 0;
		flex: 1 1 16rem;
		font-weight: 600;
	}
	/* The state in words (the colour only repeats it). */
	.pill {
		display: inline-block;
		padding: 0.1rem 0.55rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-2);
		font-size: 0.8rem;
		font-weight: 600;
	}
	.pill-done {
		background: var(--success-soft);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
		color: var(--success);
	}
	.pill-failed {
		background: var(--danger-soft);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--danger);
	}
	.pill-retrying {
		background: var(--warning-soft);
		border-color: color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
	}
	.download {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
	}
	.download .btn {
		min-height: 38px;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.25rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}
	/* 24 px targets (WCAG 2.5.8). */
	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
	@media (max-width: 640px) {
		.head h1 {
			font-size: 1.45rem;
		}
		.download .btn {
			flex: 1 1 100%;
			justify-content: center;
			min-height: 44px;
		}
	}
</style>
