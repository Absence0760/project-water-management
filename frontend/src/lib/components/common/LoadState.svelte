<script lang="ts">
	// Standard loading / error / empty wrapper. Renders children only once
	// loading has finished without an error and the data isn't empty.
	//
	// Try again takes itself out of the page (the loading line replaces the
	// error), which dropped the focus on <body>: the next Tab started again from
	// the top of the page (WCAG 2.4.3, issue #586 R4-D). So the focus follows
	// the retry: onto the loading line while it loads, then onto the new
	// Try again if it failed again, else onto the panel's heading (the state
	// that replaced the focused control: ui-playbook § Focus).
	import type { Snippet } from 'svelte';
	import { retryLanding } from './loadState';

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

	let statusEl: HTMLElement | undefined = $state();
	let alertEl: HTMLElement | undefined = $state();
	let retryEl: HTMLButtonElement | undefined = $state();
	/** Where Try again was: set by its click, cleared once the retry has settled and the focus is placed. */
	let retried: Element | null = null;
	/** The Try again that was pressed: until a new one replaces it, the retry hasn't failed again yet. */
	let pressed: HTMLElement | null = null;

	function onretry() {
		retried = alertEl?.parentElement ?? null;
		pressed = retryEl ?? null;
		retry?.();
	}

	$effect(() => {
		// Runs after the DOM shows the new state (loading, error, empty or the content).
		const settled = !loading;
		const failed = !!error;
		void statusEl;
		void retryEl;
		if (!retried) return;
		if (!settled) {
			if (statusEl?.isConnected) statusEl.focus();
			return;
		}
		if (failed) {
			// The new alert's button (bound once it is drawn: this runs again then).
			const target = retryEl ?? alertEl;
			if (!target?.isConnected || target === pressed) return;
			retried = pressed = null;
			target.focus();
			return;
		}
		const from = retried;
		retried = pressed = null;
		retryLanding(from)?.focus();
	});
</script>

{#if loading}
	<div class="state" role="status" aria-live="polite" tabindex="-1" bind:this={statusEl}>
		<span class="spinner" aria-hidden="true"></span> Loading…
	</div>
{:else if error}
	<div class="alert alert-error" role="alert" tabindex="-1" bind:this={alertEl}>
		{error}
		{#if retry}
			<button type="button" class="btn btn-sm" onclick={onretry} bind:this={retryEl}>Try again</button>
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
	/* Focused only by a retry (above), never by Tab: no ring round the whole line. */
	.state:focus,
	.alert:focus {
		outline: none;
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
