<script lang="ts">
	// Standard loading / error / empty wrapper. Renders children only once
	// loading has finished without an error and the data isn't empty.
	import type { Snippet } from 'svelte';

	let {
		loading,
		error = null,
		empty = false,
		emptyText = 'Nothing here yet.',
		retry,
		children,
		emptyAction
	}: {
		loading: boolean;
		error?: string | null;
		empty?: boolean;
		emptyText?: string;
		retry?: () => void;
		children: Snippet;
		emptyAction?: Snippet;
	} = $props();
</script>

{#if loading}
	<div class="state" role="status" aria-live="polite">
		<span class="spinner" aria-hidden="true"></span> Loading…
	</div>
{:else if error}
	<div class="alert alert-error" role="alert">
		{error}
		{#if retry}
			<button type="button" class="btn btn-sm" onclick={retry}>Try again</button>
		{/if}
	</div>
{:else if empty}
	<div class="state empty">
		<p>{emptyText}</p>
		{#if emptyAction}{@render emptyAction()}{/if}
	</div>
{:else}
	{@render children()}
{/if}

<style>
	.state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		padding: 2.5rem 1rem;
		color: var(--text-muted);
		text-align: center;
	}
	.state[role='status'] {
		flex-direction: row;
		justify-content: center;
	}
	.empty {
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.empty p {
		margin: 0;
	}
	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--border-strong);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.alert .btn {
		margin-left: 0.75rem;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
</style>
