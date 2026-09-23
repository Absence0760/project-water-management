<script lang="ts">
	// Split sign-in / register layout: a navy brand panel with the catchment
	// illustration on the left (a short band on phones), the form on the right.
	import type { Snippet } from 'svelte';
	import BrandMark from './BrandMark.svelte';
	import CatchmentScene from './CatchmentScene.svelte';

	let {
		title,
		subtitle,
		children,
		footer
	}: { title: string; subtitle?: string; children: Snippet; footer: Snippet } = $props();
</script>

<div class="auth">

	<main class="side-form">
		<div class="form-box">
			<div class="lockup">
				<BrandMark size={40} />
				<span>Water Management</span>
			</div>
			<h1>{title}</h1>
			{#if subtitle}<p class="muted intro">{subtitle}</p>{/if}
			{@render children()}
			<div class="footer">{@render footer()}</div>
		</div>
	</main>

	<!-- After the form in the DOM so the page's h1 comes first; shown on the left. -->
	<aside class="panel-brand" aria-label="About Water Management">
		<div class="art"><CatchmentScene /></div>
		<div class="copy">
			<p class="kicker">Water Management</p>
			<h2>Catchment water balance, from rainfall to river.</h2>
			<ul>
				<li>Model farms, dams and transfers on a river network.</li>
				<li>Run 40+ years of daily flows in seconds.</li>
				<li>Check the environmental flow requirement (EWR) against every farm's use.</li>
			</ul>
		</div>
	</aside>
</div>

<style>
	.auth {
		display: grid;
		grid-template-columns: minmax(0, 55fr) minmax(0, 45fr);
		min-height: 100vh;
		min-height: 100dvh;
	}
	.panel-brand {
		order: -1;
		overflow: hidden;
		background: #102a43;
		color: #d9e6f2;
		/* Keep the panel from pushing the form below the fold. */
		max-height: 100dvh;
		position: sticky;
		top: 0;
	}
	.art {
		position: absolute;
		inset: 0;
	}
	.copy {
		position: relative;
		max-width: 30rem;
		padding: clamp(2rem, 6vh, 4rem) clamp(1.5rem, 5vw, 4rem);
	}
	.kicker {
		margin: 0 0 0.75rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #36c6e0;
	}
	.copy h2 {
		font-family: var(--font-display);
		font-size: clamp(1.6rem, 2.6vw, 2.25rem);
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: #ffffff;
		margin: 0 0 1.25rem;
	}
	.copy ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.6rem;
		font-size: 0.95rem;
		color: #c5d3e1;
	}
	.copy li {
		position: relative;
		padding-left: 1.4rem;
	}
	.copy li::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0.45em;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #36c6e0;
	}
	.side-form {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2.5rem var(--gutter);
		background: var(--surface);
	}
	.form-box {
		width: 100%;
		max-width: 380px;
	}
	.lockup {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 2rem;
		font-family: var(--font-display);
		font-weight: 600;
		font-size: 1.35rem;
		letter-spacing: -0.01em;
		color: var(--brand-navy);
	}
	h1 {
		font-size: 1.75rem;
		margin-bottom: 0.35rem;
	}
	.intro {
		margin-bottom: 1.5rem;
	}
	.form-box :global(form) {
		margin-top: 1.25rem;
	}
	.form-box :global(.field > input),
	.form-box :global(.pw input) {
		width: 100%;
		min-height: 42px;
		padding: 0.5rem 0.7rem;
		font-size: 0.95rem;
	}
	.form-box :global(.field) {
		margin-bottom: 1rem;
	}
	.form-box :global(.btn-primary) {
		width: 100%;
		justify-content: center;
		min-height: 44px;
		margin-top: 0.5rem;
		font-size: 0.95rem;
	}
	.footer {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
		font-size: 0.9rem;
		color: var(--text-2);
	}
	/* Sits in running text: underline so it isn't told apart by colour alone. */
	.footer :global(a) {
		text-decoration: underline;
		font-weight: 500;
	}
	@media (prefers-color-scheme: dark) {
		.panel-brand {
			background: #0c2135;
		}
		.lockup {
			color: var(--text);
		}
	}
	@media (max-width: 900px) {
		.auth {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto 1fr;
		}
		.panel-brand {
			position: relative;
			height: 180px;
		}
		.copy {
			display: none;
		}
		.side-form {
			align-items: flex-start;
			padding-top: 1.75rem;
		}
		.lockup {
			margin-bottom: 1.25rem;
		}
	}
</style>
