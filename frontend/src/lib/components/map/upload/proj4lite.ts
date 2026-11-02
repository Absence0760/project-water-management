// proj4 with only the projections a shapefile's .prj is likely to name here
// (docs/maps.md § Shapefiles and KML): Transverse Mercator (the
// Hartebeesthoek94 Lo zones), UTM, Albers equal-area (South Africa's
// national Albers, land cover), Lambert conformal conic and Lambert
// azimuthal equal-area; proj4's core adds longitude/latitude and Mercator
// (Web Mercator) itself. Its package entry registers about thirty, which
// made the shapefile reader one 47 KB gzipped chunk, over the 42 KB a chunk
// may weigh (scripts/guards/check_web_bundle_budget.mjs). A .prj naming any
// other is refused as unreadable, with how to reproject it.
import core from 'proj4/lib/core.js';
import Proj from 'proj4/lib/Proj.js';
import aea from 'proj4/lib/projections/aea.js';
import etmerc from 'proj4/lib/projections/etmerc.js';
import laea from 'proj4/lib/projections/laea.js';
import lcc from 'proj4/lib/projections/lcc.js';
import tmerc from 'proj4/lib/projections/tmerc.js';
import utm from 'proj4/lib/projections/utm.js';

for (const p of [tmerc, etmerc, utm, aea, lcc, laea]) Proj.projections.add(p);

export { core as proj4, Proj };
