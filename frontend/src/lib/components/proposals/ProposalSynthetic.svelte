<!-- The warning every map-proposal panel shows over the repo's invented data (ProposalPanel.svelte). -->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	let { testid, subject, notWhat, forWhat }: { testid: string; subject: string; notWhat: string; forWhat: string } = $props();
</script>

<p class="alert alert-warning slim" data-testid={testid}>
	<strong>Synthetic test data.</strong> <HelpTip key="synthetic-data" /> {subject} loaded here is invented for development and tests, not {notWhat}. Never use it for a real {forWhat}.
</p>

<style>
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
</style>
