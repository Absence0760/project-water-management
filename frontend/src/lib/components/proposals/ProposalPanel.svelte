<!--
	The frame every map-proposal panel shares (issue #326 Part B; docs/ui.md,
	docs/maps.md "the map proposes, the modeller decides"): land cover in a
	unit's planted-areas drawer (crops/CroplandProposalsBox), the dams on Dams
	(dams/DamProposalsBox) and evaporation in Settings
	(settings/EvaporationProposal). It draws the heading and intro, the
	panel's own controls, a live notice that takes the keyboard after a Use
	(the Use button it replaces is gone), and the body: busy while loading,
	`data-ready` once loaded or failed, the failure with its reason and Try
	again, else the panel's own content. Each panel keeps its data, its rows,
	its Use and its words. Pinned by e2e/tests/proposal-panels.spec.ts and
	each panel's own spec.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';

	let {
		testid,
		prefix,
		id,
		variant,
		title,
		what,
		intro,
		controls,
		notice,
		loading,
		loaded,
		error,
		onretry,
		bodyGrid = false,
		children
	}: {
		/** The section's `data-testid`. */
		testid: string;
		/** The notice's and body's test ids: `<prefix>-notice`, `<prefix>-body`. */
		prefix: string;
		/** An anchor for the section (Settings links to it), if any. */
		id?: string;
		/** 'page' a panel on a page (Dams), 'drawer' a section at a drawer's foot (land cover), 'inline' a group inside a form's section (Settings). */
		variant: 'page' | 'drawer' | 'inline';
		title: string;
		/** What failed to load, in "The <what> couldn’t be loaded". */
		what: string;
		intro: Snippet;
		/** The panel's own pickers, above the notice (the unit on Dams). */
		controls?: Snippet;
		/** What the last Use did; null for none. */
		notice: string | null;
		loading: boolean;
		/** The panel has its data (the body content draws). */
		loaded: boolean;
		error: string | null;
		onretry: () => void;
		/** Lay the body out as a one-column grid with gaps (Settings' group), not as a block. */
		bodyGrid?: boolean;
		children: Snippet;
	} = $props();

	const uid = $props.id();
	let noticeEl = $state<HTMLParagraphElement | null>(null);

	/** After a Use: the button is gone or disabled, so the keyboard goes to what happened, not the top of the page. */
	export async function focusNotice(): Promise<void> {
		await tick();
		noticeEl?.focus();
	}
</script>

<section class="proposals {variant}" class:panel={variant === 'page'} {id} aria-labelledby="{uid}-h" data-testid={testid}>
	{#if variant === 'page'}
		<div class="panel-head"><h2 id="{uid}-h">{title}</h2></div>
	{:else}
		<h3 id="{uid}-h">{title}</h3>
	{/if}
	{@render intro()}

	{@render controls?.()}
	<!-- Always in the page, so a screen reader announces the text when it arrives. -->
	<!-- Every notice is a saved model or settings change: Run model lives on Runs & results, so the notice links there. -->
	<p class={notice ? 'alert alert-info slim' : 'visually-hidden'} role="status" tabindex="-1" bind:this={noticeEl} data-testid="{prefix}-notice">{#if notice}{notice} <a href="?tab=runs">Run the model</a> to see its effect.{/if}</p>
	<div class="body" class:grid={bodyGrid} aria-busy={loading} data-ready={!loading && (loaded || error !== null) ? 'true' : undefined} data-testid="{prefix}-body">
		{#if error}
			<p class="err" role="alert">The {what} couldn’t be loaded ({error}). <button type="button" class="btn btn-sm" onclick={onretry}>Try again</button></p>
		{:else if loaded}
			{@render children()}
		{/if}
	</div>
</section>

<style>
	.proposals {
		display: grid;
		/* One column no wider than its container: a table scrolls in its own box on a phone, the page doesn't. */
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		min-width: 0;
	}
	.page {
		margin: 0 0 1rem;
	}
	.page .panel-head h2 {
		font-size: 1.05rem;
	}
	.drawer {
		margin: 1rem 0 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		container-type: inline-size;
	}
	.drawer h3 {
		font-size: 1rem;
		margin: 0;
	}
	.inline {
		margin: 1rem 0 0;
	}
	.body {
		min-width: 0;
	}
	.body.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
		justify-items: start;
	}
	.body.grid > :global(*) {
		max-width: 100%;
	}
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.err {
		color: var(--danger);
		margin: 0;
	}
	/* In a drawer on a phone (its own container), Try again is a 44 px target like the rows' buttons. */
	@container (max-width: 30rem) {
		.drawer .err .btn {
			min-height: 44px;
			min-width: 44px;
		}
	}
</style>
