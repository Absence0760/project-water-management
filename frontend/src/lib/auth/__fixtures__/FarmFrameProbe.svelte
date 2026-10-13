<script lang="ts">
	// Test fixture (frame.test.ts): reports the reader a page under the root layout gets.
	import { farmFrameReader } from '../frame';

	let { onread }: { onread: (inFrame: () => boolean) => void } = $props();
	// svelte-ignore state_referenced_locally
	onread(farmFrameReader());
</script>
