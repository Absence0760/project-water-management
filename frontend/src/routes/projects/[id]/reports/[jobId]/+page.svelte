<script lang="ts">
	// Where an emailed report link lands (WP-2.15 Phase B; docs/ui.md §
	// Report): /projects/:id/reports/:jobId. Signed out, the layout sends the
	// reader to sign in and back. A member sees the PDF's status and, once it
	// is ready, a fresh download link (pre-signed, an hour); anyone else gets
	// the workspace's not-found message, so a forwarded email opens nothing.
	import { onDestroy, untrack } from 'svelte';
	import { base } from '$app/paths';
	import { page } from '$app/state';
	import { api, ApiError } from '$lib/api';
	import { describeReport, isPending, type ReportStatus, reportsApi } from '$lib/components/report/serverPdf';
	import { fmtDate } from '$lib/format/number';

	const projectId = $derived(page.params.id ?? '');
	const jobId = $derived(page.params.jobId ?? '');

	let current = $state<ReportStatus | null>(null);
	let phase = $state<'loading' | 'loaded' | 'not-found' | 'error'>('loading');
	let error = $state('');
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
	$effect(() => {
		const id = projectId;
		const job = jobId;
		untrack(() => load(id, job));
	});
</script>

<svelte:head><title>Report PDF · Water Management</title></svelte:head>

<main class="page" aria-busy={phase === 'loading'}>
	<h1>Catchment report PDF</h1>
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
	{:else if current}
		<p role="status">{describeReport(current.report, false)}</p>
		{#if current.report.createdAt}
			<p class="muted">
				Asked for {fmtDate(current.report.createdAt, true)}{current.report.scheduled ? ' by a report schedule' : ''}.
			</p>
		{/if}
		{#if current.url}
			<p><a class="btn btn-primary" href={current.url} rel="noopener">Download the PDF</a></p>
			<p class="muted small">The download link works for an hour; open this page again for a new one.</p>
		{/if}
		<p>
			<a href="{base}/projects/{projectId}/report{current.report.runId ? `?run=${current.report.runId}` : ''}">Open the report in the app</a>
		</p>
	{/if}
</main>

<style>
	.small {
		font-size: 0.8rem;
	}
</style>
