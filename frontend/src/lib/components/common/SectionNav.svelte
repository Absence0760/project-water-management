<!--
	The "On this page" menu of a long workspace tab: a row of links that sticks
	under the app header and marks the section being read (scroll spy). A
	wrapping row on wide screens, one strip that scrolls sideways on phones.
	Groups sit apart by a wider gap; their names are for screen readers (each
	group is a list labelled by its name), since the page shows them as
	headings and names between the links wrap raggedly. While it is shown,
	in-page jumps and focus scrolling keep clear of it (WCAG 2.4.11).
-->
<script lang="ts">
	import { activeSectionId, type NavGroup } from './sectionNav';

	let { groups, label }: { groups: NavGroup[]; label: string } = $props();

	const uid = $props.id();
	const ids = $derived(groups.flatMap((g) => g.sections.map((s) => s.id)));
	let height = $state(0);
	let activeSection = $state<string | null>(null);
	let list = $state<HTMLUListElement>();

	// On a phone the menu is one sideways strip: keep the marked link in it in view.
	$effect(() => {
		const link = activeSection ? list?.querySelector<HTMLElement>(`a[href="#${activeSection}"]`) : null;
		if (!list || !link || list.scrollWidth <= list.clientWidth) return;
		const left = link.offsetLeft - list.offsetLeft;
		if (left < list.scrollLeft || left + link.offsetWidth > list.scrollLeft + list.clientWidth) {
			list.scrollLeft = left - 16;
		}
	});
	$effect(() => {
		const root = document.documentElement;
		const header = parseFloat(getComputedStyle(root).getPropertyValue('--header-h')) || 0;
		root.style.scrollPaddingTop = `${header + height + 12}px`;
		return () => {
			root.style.scrollPaddingTop = '';
		};
	});
	$effect(() => {
		const watched = ids;
		let frame = 0;
		const update = () => {
			frame = 0;
			const root = document.documentElement;
			// A section counts as reached once its top passes under the sticky menu.
			const line = (parseFloat(getComputedStyle(root).scrollPaddingTop) || 0) + 8;
			const tops = watched.flatMap((id) => {
				const el = document.getElementById(id);
				return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
			});
			activeSection = activeSectionId(tops, line, window.innerHeight + window.scrollY >= root.scrollHeight - 2);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', schedule);
		// Panels open, close and load their charts late, which moves every later section.
		const grow = new ResizeObserver(schedule);
		grow.observe(document.body);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', schedule);
			grow.disconnect();
		};
	});
</script>

<nav class="sections" aria-label={label} bind:clientHeight={height}>
	<span class="nav-h" aria-hidden="true">On this page</span>
	<ul class="groups" bind:this={list}>
		{#each groups as g, gi (gi)}
			<li>
				{#if g.label}<span class="visually-hidden" id="{uid}-g{gi}">{g.label}</span>{/if}
				<ul aria-labelledby={g.label ? `${uid}-g${gi}` : undefined}>
					{#each g.sections as sec (sec.id)}
						<li>
							<a href="#{sec.id}" aria-current={sec.id === activeSection ? 'location' : undefined}>
								{sec.label}{#if sec.problem}<span class="dot" aria-hidden="true"></span><span class="visually-hidden"> (has a problem)</span>{/if}
							</a>
						</li>
					{/each}
				</ul>
			</li>
		{/each}
	</ul>
</nav>

<style>
	.sections {
		position: sticky;
		top: var(--header-h);
		z-index: 15;
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0 0 1rem;
		padding: 0.45rem 0;
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}
	.nav-h {
		flex: none;
		align-self: flex-start;
		line-height: 30px;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	/* A group keeps its links together, and a gap wider than a link's sets it off from the next. */
	/* Positioned, so the groups' screen-reader names (absolutely placed) scroll
	   and clip with the phone strip instead of widening the page. */
	.groups {
		position: relative;
		column-gap: 1.1rem;
	}
	.groups > li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}
	a {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 30px;
		padding: 0 0.65rem;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		font-size: 0.8rem;
		color: var(--text-2);
		text-decoration: none;
		white-space: nowrap;
	}
	a:hover {
		border-color: var(--accent);
		color: var(--accent);
	}
	a[aria-current='location'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--danger);
	}
	/* Phones: one row that scrolls sideways inside the bar, never the page. */
	@media (max-width: 640px) {
		.nav-h {
			display: none;
		}
		.groups,
		.groups > li,
		.groups ul {
			flex-wrap: nowrap;
		}
		.groups {
			overflow-x: auto;
			scrollbar-width: none;
		}
		.groups > li,
		.groups ul {
			flex: none;
		}
		a {
			min-height: 36px;
		}
	}
</style>
