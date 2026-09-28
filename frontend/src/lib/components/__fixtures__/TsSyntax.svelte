<!--
	Guard fixture (never imported by the app): TypeScript syntax that svelte-check
	accepts but a broken compiler type-stripper can leak into the JS, which then
	fails `vite build` for every build (production and e2e alike). Loaded by
	tsSyntax.test.ts. Add a case here when a new TS form bites.
-->
<script lang="ts">
	// Optional parameters: svelte 5.56.0-5.56.3 printed `name?` (sveltejs/svelte#18455).
	function declared(name?: string): string {
		return name ?? 'none';
	}
	const arrow = (name?: string, n?: number): string => `${name ?? 'none'}:${n ?? 0}`;
	const obj = {
		method(name?: string): string {
			return name ?? 'none';
		}
	};
	class Holder {
		value?: string;
		read(name?: string): string {
			return this.value ?? name ?? 'none';
		}
	}
	async function later(name?: string): Promise<string> {
		return name ?? 'none';
	}

	const results = (): string[] => [declared(), arrow('a'), obj.method(), new Holder().read('b')];
	void later();
</script>

<p>{results().join(',')}</p>
