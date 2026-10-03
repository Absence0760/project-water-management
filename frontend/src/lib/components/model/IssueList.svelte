<script lang="ts">
	// The model's problems in one area, above its page or grid. `links`: each
	// problem about one item links to where it is fixed (the node's sheet, the
	// crop's sheet, the transfer's card); off in scenario override mode, whose
	// model isn't the one those pages edit.
	import { issueHref, type ModelIssue } from '$lib/model/validate';
	let { issues, area, links = false }: { issues: ModelIssue[]; area: ModelIssue['area']; links?: boolean } = $props();
	const mine = $derived(issues.filter((i) => i.area === area));
</script>

{#if mine.length}
	<div class="alert alert-warning" role="status">
		<strong>Fix before saving:</strong>
		<ul>
			{#each mine as issue, i (i)}<li>{#if links && issue.itemId}<a href={issueHref(issue)} data-sveltekit-noscroll>{issue.message}</a>{:else}{issue.message}{/if}</li>{/each}
		</ul>
	</div>
{/if}
