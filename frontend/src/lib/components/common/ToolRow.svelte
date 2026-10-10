<!--
	A run-it-yourself tool that hasn't been run, as one row (issue #465): its
	name with its ⓘ, one line saying what it is for, and its action at the
	row's end (a Run button, or why it can't run). River & reserve's
	uncertainty bands, sensitivity runs, outcome matrix and seasonal outlook
	each show this until they have a result or the editor opens the form, so
	four paragraphs and forms don't push the water account down the page.
	The heading keeps the panel's ids, so the section's accessible name and a
	`#res-…` link's focus land on it as on the full panel.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';

	let {
		headingId,
		titleId,
		title,
		help,
		purpose,
		action
	}: {
		/** The h3's id (the full panel's). */
		headingId: string;
		/** The title span's id, when the section is labelled by the title alone. */
		titleId?: string;
		title: string;
		/** HelpTip key. */
		help: string;
		/** One line: what the tool answers. */
		purpose: string;
		/** The row's end: the Run button, or a short note why it can't run. */
		action: Snippet;
	} = $props();
</script>

<div class="tool-row" data-testid="tool-row">
	<h3 id={headingId}><span id={titleId}>{title}</span> <HelpTip key={help} /></h3>
	<p class="purpose">{purpose}</p>
	<div class="act">{@render action()}</div>
</div>

<style>
	.tool-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.35rem 1rem;
	}
	h3 {
		margin: 0;
		white-space: nowrap;
	}
	.purpose {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	.act {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}
	/* Narrow: the name and the action on the first line, what it is for under them. */
	@media (max-width: 760px) {
		.tool-row {
			grid-template-columns: minmax(0, 1fr) auto;
		}
		h3 {
			white-space: normal;
		}
		.purpose {
			grid-column: 1 / -1;
			grid-row: 2;
		}
	}
</style>
