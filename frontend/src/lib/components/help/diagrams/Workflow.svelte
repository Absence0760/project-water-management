<!-- The setup workflow: the workspace tabs in order (two rows, so it fits
     the guide's column whole from 1280 px), the calibration loop and the
     what-if loop. Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 660 284"
	role="img"
	aria-label="Seven steps in order: 1 create or copy a project; 2 network of hydrological units and gauges; 3 crops and demand, optional; 4 transfers, optional; 5 rainfall and flow data; 6 settings, calibration and EWR; 7 run and read the results. From the results, a short loop goes back to settings to calibrate and run again, and a long loop goes back to the project: copy it, change one thing, run and compare runs."
>
	<defs>
		<marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head" d="M0 0 L10 5 L0 10 z" />
		</marker>
		<marker id="wf-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
			<path class="head loop" d="M0 0 L10 5 L0 10 z" />
		</marker>
	</defs>

	<text class="m lbl" x="24" y="22">Set up, tab by tab</text>
	<rect class="box opt" x="534" y="11" width="22" height="14" rx="3" />
	<text class="m lbl" x="562" y="22">optional step</text>

	<rect class="box key" x="24" y="36" width="138" height="64" rx="6" />
	<text class="t" x="93" y="63" text-anchor="middle">1 · Project</text>
	<text class="s" x="93" y="81" text-anchor="middle">create or copy</text>

	<rect class="box" x="184" y="36" width="138" height="64" rx="6" />
	<text class="t" x="253" y="63" text-anchor="middle">2 · Network</text>
	<text class="s" x="253" y="79" text-anchor="middle">hydrological units</text>
	<text class="s" x="253" y="93" text-anchor="middle">and gauges</text>

	<rect class="box opt" x="344" y="36" width="138" height="64" rx="6" />
	<text class="t" x="413" y="63" text-anchor="middle">3 · Crops</text>
	<text class="s" x="413" y="81" text-anchor="middle">and demand</text>

	<rect class="box opt" x="504" y="36" width="138" height="64" rx="6" />
	<text class="t" x="573" y="63" text-anchor="middle">4 · Transfers</text>
	<text class="s" x="573" y="81" text-anchor="middle">dam to dam</text>

	<rect class="box" x="24" y="132" width="138" height="64" rx="6" />
	<text class="t" x="93" y="159" text-anchor="middle">5 · Data</text>
	<text class="s" x="93" y="177" text-anchor="middle">rain and flow</text>

	<rect class="box" x="184" y="132" width="138" height="64" rx="6" />
	<text class="t" x="253" y="159" text-anchor="middle">6 · Settings</text>
	<text class="s" x="253" y="177" text-anchor="middle">calibration, EWR</text>

	<rect class="box key" x="344" y="132" width="138" height="64" rx="6" />
	<text class="t" x="413" y="159" text-anchor="middle">7 · Run</text>
	<text class="s" x="413" y="177" text-anchor="middle">read the results</text>

	<path class="wire" d="M162 68 H182" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M322 68 H342" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M482 68 H502" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M573 100 V116 H93 V130" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M162 164 H182" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M322 164 H342" marker-end="url(#wf-arrow)" />

	<path class="wire loop" d="M393 196 V216 H253 V198" marker-end="url(#wf-loop)" />
	<text class="s lbl" x="323" y="236" text-anchor="middle">calibrate, run again</text>

	<path class="wire loop" d="M453 196 V252 H10 V68 H22" marker-end="url(#wf-loop)" />
	<text class="s lbl" x="236" y="272" text-anchor="middle">what-if: copy the project, change one thing, run, compare runs</text>
</svg>
