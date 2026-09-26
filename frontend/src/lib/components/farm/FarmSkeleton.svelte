<script lang="ts">
	// Loading (design §6.5, board 5): skeleton cards the height of the real
	// ones, so nothing shifts when the figures arrive; one visually hidden
	// status line, and after 3 s "Slow signal?". The page sets aria-busy on
	// <main> (FarmShell's `busy`).
	import { onMount } from 'svelte';
	import { stateText } from './cards';

	let slow = $state(false);
	onMount(() => {
		const t = setTimeout(() => (slow = true), 3000);
		return () => clearTimeout(t);
	});
</script>

<p class="visually-hidden" role="status">{stateText('loading')}</p>
{#each [180, 150, 260, 200] as h, i (i)}
	<div class="skeleton" style:height="{h}px" aria-hidden="true">
		<span style:width="55%"></span>
		<span style:width="35%" class="tall"></span>
		<span style:width="80%"></span>
	</div>
{/each}
{#if slow}<p class="slow">{stateText('slow')}</p>{/if}

<style>
	.skeleton {
		padding: 16px;
		border-radius: 8px;
		background: var(--surface);
		border: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.skeleton span {
		display: block;
		height: 14px;
		border-radius: 4px;
		background: var(--surface-sunken);
	}
	.skeleton .tall {
		height: 36px;
	}
	.slow {
		color: var(--text-2);
		text-align: center;
	}
	@media (prefers-reduced-motion: no-preference) {
		.skeleton span {
			animation: pulse 1.6s ease-in-out infinite;
		}
		@keyframes pulse {
			50% {
				opacity: 0.5;
			}
		}
	}
</style>
