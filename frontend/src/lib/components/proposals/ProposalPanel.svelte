<!--
	The frame every map-proposal panel shares (issue #326 Part B; docs/ui.md,
	docs/maps.md "the map proposes, the modeller decides"): land cover in a
	unit's planted-areas drawer (crops/CroplandProposalsBox), the dams on Dams
	(dams/DamProposalsBox) and evaporation in Settings
	(settings/EvaporationProposal). It draws the heading (with an action at
	its right, if given) and intro, the panel's own controls, a live notice that takes the keyboard after a Use
	(the Use button it replaces is gone), and the body: busy while loading,
	`data-ready` once loaded or failed, the failure with its reason and Try
	again, else the panel's own content. Each panel keeps its data, its rows,
	its Use and its words. With `fold`, everything under the heading folds to
	one line of the panel's values (common/Fold.svelte; the Dams page's,
	inside the picked dam's chart panel). Pinned by
	e2e/tests/proposal-panels.spec.ts and each panel's own spec.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import Fold from '$lib/components/common/Fold.svelte';

	let {
		testid,
		prefix,
		id,
		variant,
		title,
		helpKey,
		what,
		intro,
		controls,
		actions,
		notice,
		loading,
		loaded,
		error,
		onretry,
		bodyGrid = false,
		fold,
		open = $bindable(),
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
		/** A glossary id for a HelpTip beside the heading, if any. */
		helpKey?: string;
		/** What failed to load, in "The <what> couldn’t be loaded". */
		what: string;
		intro: Snippet;
		/** The panel's own pickers, above the notice (the unit on Dams). */
		controls?: Snippet;
		/** An action in the heading's row, at its right (Settings' Use, which saves straight away). */
		actions?: Snippet;
		/** What the last Use did; null for none. */
		notice: string | null;
		loading: boolean;
		/** The panel has its data (the body content draws). */
		loaded: boolean;
		error: string | null;
		onretry: () => void;
		/** Lay the body out as a one-column grid with gaps (Settings' group), not as a block. */
		bodyGrid?: boolean;
		/** Fold everything under the heading into one line of values (the unit's name, what is proposed), with its action. */
		fold?: { name?: string; line: string; change: string };
		/** The fold's open state (with `fold`). */
		open?: boolean;
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

{#snippet inner()}
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
{/snippet}

<section class="proposals {variant}" class:panel={variant === 'page'} {id} aria-labelledby="{uid}-h" data-testid={testid}>
	{#if variant === 'page'}
		<div class="panel-head"><h2 id="{uid}-h">{title}{#if helpKey}{' '}<HelpTip key={helpKey} />{/if}</h2>{@render actions?.()}</div>
	{:else if actions}
		<div class="head">
			<h3 id="{uid}-h">{title}{#if helpKey}{' '}<HelpTip key={helpKey} />{/if}</h3>
			<div class="actions">{@render actions()}</div>
		</div>
	{:else}
		<h3 id="{uid}-h">{title}{#if helpKey}{' '}<HelpTip key={helpKey} />{/if}</h3>
	{/if}
	{#if fold}
		<Fold name={fold.name} line={fold.line} change={fold.change} problem={false} body="stack" class="proposal-fold" lineTestid="{prefix}-line" bind:open>
			{@render inner()}
		</Fold>
	{:else}
		{@render inner()}
	{/if}
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
	/* The heading and its action on one row, the action at the right (under it in a narrow column). */
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem 1rem;
	}
	.head h3 {
		margin: 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.6rem;
	}
	.body {
		min-width: 0;
	}
	/* Folded, the body is the fold's: its groups keep the panel's gap. */
	.proposals :global(.proposal-fold .fold-stack) {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.6rem;
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
