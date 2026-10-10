<!--
	The "Expected format" of the EWR and Reserve upload points (issue #455):
	the shared note (common/FormatHelp.svelte, docs/ui.md § Expected format)
	with what each part of a Desktop Reserve Model file fills, beside the file
	picker on Settings → the daily EWR at the outlet and on each Reserve rule
	table, and synthetic example files to download. `target` says which form
	the files fill; `context` tells two notes on one page apart for a screen
	reader. The words and files are ./drmFormat.ts's, which the File formats
	help page shows too.
-->
<script lang="ts">
	import FormatHelp from '$lib/components/common/FormatHelp.svelte';
	import { drmFormat, type DrmTarget } from './drmFormat';

	let { target, context }: { target: DrmTarget; context: string } = $props();
</script>

<FormatHelp format={drmFormat(target)} {context} />
