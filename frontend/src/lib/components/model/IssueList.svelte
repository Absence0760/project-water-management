<script lang="ts">
	import type { ModelIssue } from '$lib/model/validate';
	let { issues, area }: { issues: ModelIssue[]; area: ModelIssue['area'] } = $props();
	const mine = $derived(issues.filter((i) => i.area === area));
</script>

{#if mine.length}
	<div class="alert alert-warning" role="status">
		<strong>Fix before saving:</strong>
		<ul>
			{#each mine as issue, i (i)}<li>{issue.message}</li>{/each}
		</ul>
	</div>
{/if}
