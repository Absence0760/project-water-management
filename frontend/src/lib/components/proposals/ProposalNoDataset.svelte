<!-- "Nothing is loaded" in a map-proposal panel, with the operator's loader (ProposalPanel.svelte; docs/maps.md). -->
<script lang="ts">
	let { testid, what, consequence, command }: { testid: string; what: string; consequence: string; command: string } = $props();
</script>

<p class="alert alert-info slim" data-testid={testid}>
	No {what} is loaded, so {consequence}. The operator loads one with <code>{command}</code> (docs/maps.md).
</p>

<style>
	.slim {
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
</style>
