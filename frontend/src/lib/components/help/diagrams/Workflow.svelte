<!-- The setup workflow: the workspace tabs in order, the calibration loop and
     the what-if loop. Styles: ../Diagram.svelte. -->
<svg
	viewBox="0 0 852 230"
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

	<text class="m lbl" x="8" y="22">Set up, tab by tab</text>
	<rect class="box opt" x="706" y="11" width="22" height="14" rx="3" />
	<text class="m lbl" x="736" y="22">optional step</text>

	<rect class="box key" x="8" y="40" width="104" height="64" rx="6" />
	<text class="t" x="60" y="67" text-anchor="middle">1 · Project</text>
	<text class="s" x="60" y="85" text-anchor="middle">create or copy</text>

	<rect class="box" x="130" y="40" width="104" height="64" rx="6" />
	<text class="t" x="182" y="67" text-anchor="middle">2 · Network</text>
	<text class="s" x="182" y="83" text-anchor="middle">hydrological units</text>
	<text class="s" x="182" y="97" text-anchor="middle">and gauges</text>

	<rect class="box opt" x="252" y="40" width="104" height="64" rx="6" />
	<text class="t" x="304" y="67" text-anchor="middle">3 · Crops</text>
	<text class="s" x="304" y="85" text-anchor="middle">and demand</text>

	<rect class="box opt" x="374" y="40" width="104" height="64" rx="6" />
	<text class="t" x="426" y="67" text-anchor="middle">4 · Transfers</text>
	<text class="s" x="426" y="85" text-anchor="middle">dam to dam</text>

	<rect class="box" x="496" y="40" width="104" height="64" rx="6" />
	<text class="t" x="548" y="67" text-anchor="middle">5 · Data</text>
	<text class="s" x="548" y="85" text-anchor="middle">rain and flow</text>

	<rect class="box" x="618" y="40" width="104" height="64" rx="6" />
	<text class="t" x="670" y="67" text-anchor="middle">6 · Settings</text>
	<text class="s" x="670" y="85" text-anchor="middle">calibration, EWR</text>

	<rect class="box key" x="740" y="40" width="104" height="64" rx="6" />
	<text class="t" x="792" y="67" text-anchor="middle">7 · Run</text>
	<text class="s" x="792" y="85" text-anchor="middle">read the results</text>

	<path class="wire" d="M112 72 H128" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M234 72 H250" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M356 72 H372" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M478 72 H494" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M600 72 H616" marker-end="url(#wf-arrow)" />
	<path class="wire" d="M722 72 H738" marker-end="url(#wf-arrow)" />

	<path class="wire loop" d="M780 104 V140 H670 V106" marker-end="url(#wf-loop)" />
	<text class="s lbl" x="725" y="158" text-anchor="middle">calibrate, run again</text>

	<path class="wire loop" d="M820 104 V196 H60 V106" marker-end="url(#wf-loop)" />
	<text class="s lbl" x="440" y="214" text-anchor="middle">what-if: copy the project, change one thing, run, compare runs</text>
</svg>
