<script lang="ts">
	// The Project page's two-step sign-in panel (204_mfa_opt_in; docs/ui.md §
	// The Project page): owners only, beside the members and share links it
	// protects. The switch is auth-extras/RequireTwoStep.svelte, shared with
	// the team settings.
	import { api, type Project } from '$lib/api';
	import RequireTwoStep from '$lib/components/auth-extras/RequireTwoStep.svelte';

	let { project, onProjectChange }: { project: Project; onProjectChange: (p: Project) => void } = $props();

	async function save(next: boolean) {
		onProjectChange(await api.projects.update(project.id, { requireMfa: next }));
	}
</script>

<section class="panel" aria-labelledby="project-two-step-h">
	<div class="panel-head"><h2 id="project-two-step-h">Two-step sign-in</h2></div>
	<RequireTwoStep
		scope="project"
		on={project.requireMfa ?? false}
		effective={project.mfaRequired ?? project.requireMfa ?? false}
		teamName={project.team?.name ?? null}
		canChange
		{save}
	/>
</section>
