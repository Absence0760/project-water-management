<script lang="ts">
	// An email address that wraps at its natural break points (before "@",
	// after ".", "-", "_", "+") instead of mid-word on a narrow screen. A single
	// part still too long for the line breaks anywhere as a last resort.
	//
	// With `breakAfter` (the team page's members, issue #520) it wraps only
	// before the "@" and after those characters ("." there), and at the "@"
	// first: the name and the domain are each an inline block (and so is every
	// part inside them), so a line breaks inside one only when it is wider than
	// the line, never after a hyphen the browser would otherwise break at. Not
	// the default, since an inline block may leave a sentence's closing "." on a
	// line of its own (the confirm-email banner).
	import { emailGroups, emailParts } from '$lib/format/email';

	/** Wrap only after these characters (and before the "@"), the "@" first. */
	let { email, breakAfter }: { email: string; breakAfter?: string } = $props();
</script>

{#if breakAfter === undefined}
	<span class="email-text">{#each emailParts(email) as part, i (i)}{part}<wbr />{/each}</span>
{:else}
	<span class="email-text"
		>{#each emailGroups(email, breakAfter) as group, g (g)}<span class="unit group"
				>{#each group as part, i (i)}<span class="unit part">{part}</span><wbr />{/each}</span
			><wbr />{/each}</span
	>
{/if}

<style>
	.email-text {
		overflow-wrap: anywhere;
	}
	.unit {
		display: inline-block;
		max-width: 100%;
	}
</style>
