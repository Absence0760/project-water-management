<script lang="ts">
	// The breadcrumb over each help subpage's title (a guide, the glossary,
	// search): where the page sits in help, with the way back to the overview.
	// The last step is the page itself (aria-current); a step with no href is
	// a group of the help contents, not a page.
	let { trail }: { trail: { label: string; href?: string }[] } = $props();
</script>

<nav aria-label="Breadcrumb" class="crumbs">
	<ol>
		{#each trail as step, i (i)}
			<li aria-current={i === trail.length - 1 && trail.length > 1 ? 'page' : undefined}>
				{#if step.href}<a href={step.href}>{step.label}</a>{:else}{step.label}{/if}
			</li>
		{/each}
	</ol>
</nav>

<style>
	ol {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		margin: 0 0 1rem;
		padding: 0;
		list-style: none;
		font-size: 0.875rem;
	}
	li:not(:last-child)::after {
		content: '›';
		margin-left: 0.35rem;
		color: var(--text-muted);
	}
	[aria-current='page'] {
		color: var(--text-muted);
	}
	/* 24 px targets (WCAG 2.2 SC 2.5.8). */
	a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}
</style>
