<script lang="ts">
	// An email address that wraps at its natural break points (before "@",
	// after ".", "-", "_", "+") instead of mid-word on a narrow screen. A single
	// part still too long for the line breaks anywhere as a last resort.
	import { emailParts } from '$lib/format/email';

	let { email }: { email: string } = $props();
</script>

<span class="email-text">{#each emailParts(email) as part, i (i)}{part}<wbr />{/each}</span>

<style>
	.email-text {
		overflow-wrap: anywhere;
	}
</style>
