<script lang="ts">
	// Test fixture (frame.test.ts): stands in for the root layout, providing
	// `inFarmFrame` when given, then renders a probe that reports what it reads.
	import { provideFarmFrame } from '../frame';
	import FarmFrameProbe from './FarmFrameProbe.svelte';

	let { inFarmFrame, onread }: { inFarmFrame?: () => boolean; onread: (inFrame: () => boolean) => void } = $props();
	// svelte-ignore state_referenced_locally
	if (inFarmFrame) provideFarmFrame(inFarmFrame);
</script>

<FarmFrameProbe {onread} />
