<!--
	"Check reproduction" (roadmap WP-3.1, docs/ui.md § Reproduction): re-run the
	shown run from its stored inputs with today's engine, on the server, and say
	whether every result comes out the same. Its own chunk, loaded with the
	Notes & evidence group.
-->
<script lang="ts">
	import { api, type Reproduction, type RunMeta } from '$lib/api';
	import { differenceText, reproductionHeadline } from './reproduce';

	let { projectId, run, nodeName }: { projectId: string; run: RunMeta; nodeName: (id: string) => string | undefined } = $props();

	const uid = $props.id();
	let checking = $state(false);
	let result = $state<Reproduction | null>(null);
	let error = $state<string | null>(null);
	const headline = $derived(result ? reproductionHeadline(result) : null);

	async function check() {
		checking = true;
		error = null;
		try {
			result = await api.runs.reproduce(projectId, run.id);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			checking = false;
		}
	}
</script>

<section aria-labelledby="{uid}-h" data-testid="reproduce">
	<h3 id="{uid}-h">Reproduction</h3>
	{#if run.reproducible === false}
		<p class="muted">
			This run was made before runs stored their input series, so it can't be re-run from them. Only hashes of its inputs were kept,
			which show whether they changed but not what they were.
		</p>
	{:else}
		<p class="muted small">
			This run's input series are stored with it, so it can be re-run exactly as it was, whatever has happened to the project's data
			since. Checking re-runs it on the server with today's engine and compares every result and daily output.
		</p>
		<button type="button" class="btn btn-sm" onclick={check} disabled={checking}>{checking ? 'Checking…' : 'Check reproduction'}</button>
	{/if}
	<div role="status" aria-live="polite">
		{#if headline && result}
			<p class="alert {headline.tone === 'ok' ? 'alert-info' : headline.tone === 'warn' ? 'alert-warning' : 'alert-error'}" data-testid="reproduce-result">
				{headline.text}
			</p>
			{#if result.differences.length}
				<ul class="diffs" aria-label="Differences">
					{#each result.differences as d, i (i)}<li>{differenceText(d, nodeName)}</li>{/each}
				</ul>
				{#if result.truncated}<p class="muted small">And {result.truncated} more.</p>{/if}
			{/if}
		{/if}
	</div>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
</section>

<style>
	.small {
		font-size: 0.85rem;
	}
	p {
		max-width: 90ch;
	}
	.diffs {
		margin: 0.25rem 0 0;
		padding-left: 1.2rem;
		max-width: 90ch;
		font-size: 0.9rem;
	}
	[role='status'] .alert {
		margin-top: 0.5rem;
	}
</style>
