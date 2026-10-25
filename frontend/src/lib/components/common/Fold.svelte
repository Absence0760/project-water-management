<!--
	The app's one fold (ui-playbook.md § 2, "Rarely changed settings fold into their values"): a native
	<details class="fold"> whose summary is one line naming the group and its current values, a disclosure
	chevron before it and a named action after it ("Change", "Change the limits", "Rebase…"; "Hide" while
	open; "Show" with `readonly`, for a viewer who can change nothing inside; aria-hidden, since the summary
	announces expanded/collapsed). With `problem` (the default) the line
	shows "needs fixing" while a field inside is aria-invalid (app.css `.fold:has([aria-invalid='true'])`),
	so a closed fold never hides one; a fold that holds no checked field (a statement, a rule in words)
	passes `problem={false}`. Its fields stay in the page while closed, so Find a setting finds them and
	opens it (SectionNav `jump`). The look is app.css's `.fold` (one copy); e2e opens one with `openFold`
	(e2e/support/settings.ts).

	Open state: `bind:open` to drive it, `open` + `ontoggle` to keep it elsewhere (the node sheet's remembered
	folds), or `atDefaults` for a group that starts closed only while everything inside is at its default
	(read once when it mounts, so a value put back to its default while it is open never shuts it under the
	cursor). `body`: 'grid' lays the children out as the fold's field grid, 'stack' as a column of headed
	groups or cards, 'none' leaves the children as they are (a fieldset, a table helper).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		name,
		line,
		// No fallback: a caller may bind a list's entry that is still undefined (a Reserve rule table's fold).
		open = $bindable(),
		atDefaults,
		change = 'Change',
		hide = 'Hide',
		readonly = false,
		problem = true,
		body = 'grid',
		spaced = false,
		class: klass = '',
		testid,
		lineTestid,
		lineId,
		lineClass,
		ontoggle,
		after,
		children
	}: {
		/** The group's name, ending in a colon: "Search:", "Default limits:". None when the line says it all. */
		name?: string;
		/** Its current values, one line (from a pure helper, unit-tested). */
		line: string;
		open?: boolean;
		/** Every value inside is its default: the fold starts closed, otherwise open. */
		atDefaults?: boolean;
		/** The closed line's action. */
		change?: string;
		/** The open line's action (a translated page passes its own word). */
		hide?: string;
		/** A viewer can't change anything inside: the closed line's action reads "Show", never "Change…" (issue #586, C10). */
		readonly?: boolean;
		/** Say "needs fixing" on the line while a field inside is aria-invalid. */
		problem?: boolean;
		body?: 'grid' | 'stack' | 'none';
		/** A fold that stands as its own group in a panel: a little room above and below. */
		spaced?: boolean;
		class?: string;
		testid?: string;
		/** A test id for the line of values, for a spec to read it. */
		lineTestid?: string;
		/** An id for the line, for a field inside to name it as its description. */
		lineId?: string;
		/** A class for the line (a caller's `:global(…)` style: an ellipsis on a long line). */
		lineClass?: string;
		ontoggle?: (e: Event) => void;
		/** More of the summary after the line (visually hidden words for the accessible name). */
		after?: Snippet;
		children: Snippet;
	} = $props();

	// Read once: a fold that shut itself the moment the last value went back to its default would pull the
	// field being edited out from under the cursor.
	// svelte-ignore state_referenced_locally
	if (atDefaults !== undefined) open = !atDefaults;
</script>

<details class="fold {klass}" class:spaced data-testid={testid} bind:open {ontoggle}>
	<summary
		>{#if name}<span class="fold-name">{name}</span>{' '}{/if}<span id={lineId} class="fold-line {lineClass ?? ''}" data-testid={lineTestid}>{line}</span>{@render after?.()}{#if problem}<span
				class="fold-problem">needs fixing</span
			>{/if}<span class="fold-change" aria-hidden="true">{open ? hide : readonly ? 'Show' : change}</span></summary
	>
	{#if body === 'none'}
		{@render children()}
	{:else}
		<div class={body === 'grid' ? 'fold-body' : 'fold-stack'}>{@render children()}</div>
	{/if}
</details>

<style>
	.spaced {
		margin: 0.25rem 0 0.5rem;
	}
</style>
