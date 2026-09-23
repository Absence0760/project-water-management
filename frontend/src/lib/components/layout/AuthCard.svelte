<script lang="ts">
	import type { Snippet } from 'svelte';
	import BrandMark from './BrandMark.svelte';
	let { title, children, footer }: { title: string; children: Snippet; footer: Snippet } = $props();
</script>

<main class="auth">
	<div class="card">
		<div class="lockup">
			<BrandMark size={44} />
			<span>Water Management</span>
		</div>
		<h1>{title}</h1>
		<p class="muted intro">Catchment water-balance modelling — farms, dams, irrigation and EWR.</p>
		{@render children()}
		<div class="footer">{@render footer()}</div>
	</div>
</main>

<style>
	.auth {
		display: flex;
		justify-content: center;
		padding: 8vh var(--gutter) 2rem;
	}
	.card {
		width: 100%;
		max-width: 380px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		padding: 1.5rem;
	}
	.lockup {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 1.25rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.5rem;
		color: var(--brand-ink);
	}
	@media (prefers-color-scheme: dark) {
		.lockup {
			color: var(--text);
		}
	}
	.intro {
		font-size: 0.85rem;
		margin-bottom: 1.25rem;
	}
	.footer {
		margin-top: 1rem;
		font-size: 0.875rem;
		color: var(--text-2);
	}
	.card :global(input) {
		width: 100%;
	}
	.card :global(.btn-primary) {
		width: 100%;
		justify-content: center;
		margin-top: 0.25rem;
	}
</style>
