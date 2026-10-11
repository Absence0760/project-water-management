<!--
	A group of settings that usually stays at its defaults, as one line of its current values that opens to
	edit them (ui-playbook.md § 2, "Settings at their defaults are one line"). The shared `.fold` markup in
	app.css, plus: it starts closed only while everything inside is at its default (`atDefaults`, read once
	when it mounts, so a value changed while it is open never shuts it), and its closed line ends with a
	named action ("Change the limits"). A native <details>: the fields stay in the page, so Find a setting
	finds them and opens it (SectionNav `jump`), and "needs fixing" shows on the line while a field inside
	is aria-invalid. Callers: Settings → Rain gaps, Data quality and the WR2012 check's judging.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		name,
		line,
		atDefaults,
		change = 'Change',
		stack = false,
		testid,
		children
	}: {
		/** The group's name, ending in a colon: "Default limits:". */
		name: string;
		/** Its current values, one line (from a pure helper, unit-tested). */
		line: string;
		/** Every value inside is its default: the fold starts closed. */
		atDefaults: boolean;
		/** The closed line's action, aria-hidden (the summary announces expanded/collapsed). */
		change?: string;
		/** The body stacks its children (headed groups, cards) instead of the fold's field grid. */
		stack?: boolean;
		testid?: string;
		children: Snippet;
	} = $props();

	// Read once: a fold that shut itself the moment the last value went back to its default would pull the
	// field being edited out from under the cursor.
	// svelte-ignore state_referenced_locally
	let open = $state(!atDefaults);
</script>

<details class="fold defaults-fold" data-testid={testid} bind:open>
	<summary>
		<span class="fold-name">{name}</span>
		<span>{line}</span>
		<span class="fold-problem">needs fixing</span>
		<span class="fold-change" aria-hidden="true">{open ? 'Hide' : change}</span>
	</summary>
	<div class={stack ? 'defaults-body' : 'fold-body'}>{@render children()}</div>
</details>

<style>
	.defaults-fold {
		margin: 0.25rem 0 0.5rem;
	}
	.defaults-body {
		padding: 0.25rem 0 0.4rem;
	}
</style>
