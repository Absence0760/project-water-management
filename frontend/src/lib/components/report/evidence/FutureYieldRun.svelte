<script lang="ts">
	// § 8 Future yield's Run button on the draft evidence report (issue #621
	// slice 5; docs/ui.md § Evidence report): an editor queues the
	// `future_yield` job for this application run (POST …/future-yield) and
	// follows it, queued, running, failed or done, here; when it is done the
	// page reads the report again (onchange), so § 8 shows the result. The
	// newest job comes with GET …/future-yield, so a reload or another tab
	// picks it up. Cancel stops a waiting job at once and a running one at its
	// next step, before it stores anything (POST …/future-yield/:jobId/cancel,
	// 284_cancel_future_jobs). Never on a pack: a pack freezes § 8 as it was drafted.
	import { onDestroy, untrack } from 'svelte';
	import { api, type FutureYieldState } from '#lib/api/index.js';
	import { fmtDate } from '#lib/format/number.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import { cancellableJobStatus, jobStatus } from '#lib/components/yield/yield.js';

	let {
		projectId,
		runId,
		assessed,
		onchange
	}: {
		projectId: string;
		runId: string;
		/** Whether the report's § 8 has a result now (status ok). */
		assessed: boolean;
		/** The job finished: read the report again. */
		onchange: () => Promise<void> | void;
	} = $props();

	let fy = $state.raw<FutureYieldState | null>(null);
	let error = $state<string | null>(null);
	let starting = $state(false);
	/** The job this page asked to cancel, so a running one says it is stopping. */
	let cancelAskedFor = $state<string | null>(null);
	let cancelling = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	onDestroy(() => clearTimeout(timer));

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

	/** Read the newest result and job; while the job is queued or running, again in 1.5 s, and the report once it is done. */
	async function load(followed = false) {
		clearTimeout(timer);
		try {
			const s = await api.futureYield.get(projectId, runId);
			fy = s;
			if (jobStatus(s.job)?.busy) timer = setTimeout(() => load(true), 1500);
			else if (followed && s.job?.status === 'done') await onchange();
		} catch (e) {
			error = msg(e);
		}
	}
	$effect(() => {
		void projectId;
		void runId;
		untrack(() => load());
	});

	async function start() {
		starting = true;
		error = null;
		try {
			await api.futureYield.start(projectId, runId);
			await load(true);
		} catch (e) {
			error = msg(e);
		} finally {
			starting = false;
		}
	}

	async function cancel() {
		const job = fy?.job;
		if (!job) return;
		cancelling = true;
		error = null;
		try {
			await api.futureYield.cancel(projectId, runId, job.id);
			cancelAskedFor = job.id;
			await load();
		} catch (e) {
			error = msg(e);
		} finally {
			cancelling = false;
		}
	}

	const status = $derived(cancellableJobStatus(fy?.job ?? null, cancelAskedFor));
	/** The newest job's failure, unless a result was made after it. */
	const failed = $derived(status?.failed && fy?.job && (!fy.result || fy.job.createdAt > fy.result.createdAt) ? status.text : null);
</script>

<section class="board no-print" aria-labelledby="ev-future-h" data-testid="evidence-future-run">
	<p class="board-h"><span id="ev-future-h">§ 8 Future yield</span> <HelpTip key="future-climate" label="About the future climate" /></p>
	<p class="small muted">
		{#if assessed && fy?.result}
			Run {fmtDate(fy.result.createdAt)}{fy.result.createdBy ? ` by ${fy.result.createdBy}` : ''}. Run it again when the climate projections or this application run change; a pack
			drafted now freezes what § 8 shows.
		{:else}
			§ 8 hasn’t been run for this application run, so it reads “Not assessed”. It runs the baseline and the application again under each climate model’s change factors, about 40
			runs, in the background.
		{/if}
	</p>
	{#if status?.busy}
		<div class="job">
			<p class="small" role="status" data-testid="evidence-future-job">{status.text}</p>
			{#if status.canCancel}<button type="button" class="btn btn-sm" disabled={cancelling} onclick={cancel}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}
		</div>
		{#if fy?.job?.status === 'running' && fy.job.progress != null}<progress max="100" value={fy.job.progress} aria-label="Future yield progress">{fy.job.progress} %</progress>{/if}
	{:else}
		{#if status?.cancelled && !(fy?.result && fy.job && fy.result.createdAt > fy.job.createdAt)}<p class="small" role="status" data-testid="evidence-future-cancelled">The last run was cancelled.</p>{/if}
		<p>
			<button type="button" class="btn" disabled={starting || !fy} onclick={start}>{starting ? 'Queueing…' : assessed ? 'Run it again' : 'Run the future yield'}</button>
		</p>
	{/if}
	{#if failed}<p class="alert alert-error" role="alert" data-testid="evidence-future-failed">The future yield couldn’t be run. {failed}</p>{/if}
	{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
</section>

<style>
	.board {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		padding: 0.75rem 1rem;
		margin-bottom: 1.25rem;
	}
	.job {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	.job p {
		margin: 0;
	}
	.board-h {
		font-weight: 700;
		margin: 0 0 0.25rem;
	}
	@media print {
		.no-print {
			display: none !important;
		}
	}
</style>
