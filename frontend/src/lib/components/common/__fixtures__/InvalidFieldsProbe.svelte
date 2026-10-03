<script lang="ts">
	// Test fixture (invalidFieldsScope.test.ts): reports the registry a NumberInput here would register with.
	import { useInvalidFields, type InvalidFields } from '../invalidFields.svelte';

	let { onfound }: { onfound: (f: InvalidFields) => void } = $props();
	// svelte-ignore state_referenced_locally
	onfound(useInvalidFields());
</script>
