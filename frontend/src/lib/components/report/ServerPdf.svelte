<!--
	The report page's server-side PDF (WP-2.15 Phase B; docs/ui.md § Report):
	"Generate PDF" and "Email me the PDF" queue a render of this run (its impact
	report when `against` names a baseline) in the background worker (the same
	page, in headless Chromium), then follow the
	job's status until the PDF is ready to download. Its own chunk: the report
	page loads it lazily. Helpers in ./serverPdf.ts.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { api } from '$lib/api';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { describeReport, isPending, type ReportStatus, reportsApi } from './serverPdf';

	let { projectId, runId, against = null }: { projectId: string; runId: string; against?: string | null } = $props();

	const reports = $derived(reportsApi(api, projectId));
	/** How often to ask while the worker has it. */
	const POLL_MS = 1500;

	let current = $state<ReportStatus | null>(null);
	let emailed = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	onDestroy(() => {
		stopped = true;
		clearTimeout(timer);
	});

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/** Consecutive failed status checks; after MAX_MISSES the polling stops (the buttons start over). */
	const MAX_MISSES = 5;
	let misses = $state(0);

	async function follow(jobId: string) {
		try {
			current = await reports.get(jobId);
			error = null;
			misses = 0;
		} catch (e) {
			misses++;
			error = `Could not check on the PDF: ${msg(e)}`;
			if (misses >= MAX_MISSES) {
				busy = false;
				return;
			}
		}
		if (!stopped && (!current || isPending(current.report.status))) timer = setTimeout(() => follow(jobId), POLL_MS);
	}

	async function start(email: boolean) {
		clearTimeout(timer);
		busy = true;
		error = null;
		current = null;
		misses = 0;
		emailed = email;
		try {
			const jobId = await reports.create({ runId, ...(against ? { against } : {}), email: email || undefined });
			await follow(jobId);
		} catch (e) {
			error = msg(e);
		} finally {
			busy = false;
		}
	}

	const pending = $derived(busy || (current !== null && isPending(current.report.status) && misses < MAX_MISSES));
</script>

<div class="server-pdf" data-state={current?.report.status ?? (busy ? 'starting' : 'idle')}>
	<button type="button" class="btn" disabled={pending} onclick={() => start(false)}>Generate PDF</button>
	<button type="button" class="btn" disabled={pending} onclick={() => start(true)}>Email me the PDF</button>
	<HelpTip key="report-pdf" label="About the report’s PDFs" />
	<p class="muted small" role="status">
		{#if current}{describeReport(current.report, emailed)}{:else if busy}Queueing the PDF…{/if}
	</p>
	{#if current?.url}
		<a class="btn btn-primary" href={current.url} rel="noopener">Download the generated PDF</a>
	{/if}
	{#if error}<p class="alert alert-error small" role="alert">{error}</p>{/if}
</div>

<style>
	.server-pdf {
		display: contents;
	}
	p {
		margin: 0;
	}
</style>
