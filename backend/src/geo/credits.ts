// Licensed data's credit on a stored map feature (docs/maps.md § Sources,
// docs/legal/map-data-licences.md § 5.3): which features carry data a
// licence asks the map to credit wherever it is shown.

/**
 * JRC Global Surface Water's attribution for a published map (its download
 * page). bin/tiles-dev.sh writes it as the water archive's attribution, and
 * tracing a dam writes the archive's attribution into the feature's
 * description (geo/routes.ts tracedMethod). The frontend's
 * `JRC_WATER_STATEMENT` (lib/components/legal/dataCredits.ts), word for word
 * (dataCredits.test.ts).
 */
export const JRC_WATER_STATEMENT = 'Source: EC JRC/Google';

/**
 * Whether a feature's description says its outline was traced from JRC
 * Global Surface Water (Copernicus Delegated Regulation 1159/2013 Art. 8: name
 * the source, say it was modified). A trace from the synthetic raster names
 * no source and is credited nothing.
 */
export const jrcTraced = (description: unknown): boolean => typeof description === 'string' && description.includes(JRC_WATER_STATEMENT);
