// The tag layouts of the real files raster/cog.ts reads for WaPOR (issue
// #623) and Sentinel-1/2 (issue #624), as cogWrite.ts options, so the
// synthetic fixtures are laid out as the real files are, and what each real
// header held, which cogLayouts.test.ts holds the fixtures to.
//
// Read on 2026-10-29 (header and IFDs only, by HTTP range requests; no pixel
// value kept or committed) from one file of each:
//
//   WaPOR v3 L2-AETI-D   storage.googleapis.com/fao-gismgr-wapor-3-data/DATA/WAPOR-3/MAPSET/L2-AETI-D/WAPOR-3.L2-AETI-D.<YYYY-MM>-D<n>.tif (2025-09-D1)
//   Sentinel-1 RTC       deafrica-sentinel-1.s3.af-south-1.amazonaws.com/s1_rtc/<tile>/<YYYY>/<MM>/<DD>/<id>/s1_rtc_<id>_<tile>_<YYYY>_<MM>_<DD>_{VV,MASK}.tif (S35E019, 2026-09-05)
//   Sentinel-2 L2A C1    deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com/sentinel-2-c1-l2a/<zone>/<band>/<square>/<YYYY>/<M>/<scene>/{B03,B11,SCL}.tif (34HCH, 2026-09-01)
//
// All six are GDAL COGs: little-endian, GDAL's structural metadata before the
// first IFD (which is at byte 192, or 200 in the BigTIFF), every IFD before
// the data, a 4-byte size before each tile and its last 4 bytes repeated
// after it, overviews after the full image's IFD. What differs:
//
//   file        TIFF     samples  tile  compr.   pred.  planar  nodata  GDAL scale / offset   CRS, pixel           overviews
//   WaPOR AETI  BigTIFF  int16    512   LZW (5)  1      2       -9999   0.1 / 0               EPSG:4326, 1/1024°   10
//   S1 VV       classic  float32  256   DEFL (8) 3      2       nan     none                  EPSG:4326, 0.0002°   5
//   S1 MASK     classic  uint8    256   DEFL (8) 2      2       0       none                  EPSG:4326, 0.0002°   5
//   S2 B03      classic  uint16   1024  DEFL (8) 2      1       0       0.0001 / -0.1         EPSG:327xx, 10 m     4
//   S2 B11      classic  uint16   512   DEFL (8) 2      1       0       0.0001 / -0.1         EPSG:327xx, 20 m     4
//   S2 SCL      classic  uint8     512  DEFL (8) 2      1       0       none                  EPSG:327xx, 20 m     4
//
// The WaPOR file is the global grid (368 640 × 122 880, 180° W–180° E,
// 60° N–60° S), its ImageWidth and ImageLength LONG, its two tile tables
// (172 800 LONG8 each) after the first 16 KB; the S1 tile is 5000 × 5000
// (1°, corner on whole degrees); an S2 10 m band is 10 980 × 10 980 and its
// 20 m bands 5490 × 5490, on the MGRS square's corner, in the SOUTHERN UTM
// code (not WOfS's northern one). The S1 files add XResolution, YResolution
// (RATIONAL) and ResolutionUnit; the geographic files give their datum's
// ellipsoid in GeoDoubleParams and GeogCitation in GeoAsciiParams; the S2
// files give GTCitation and GeogCitation there. The S2 files' GDAL metadata
// also holds OVR_RESAMPLING_ALG and STATISTICS_* items (role-less, so the
// reader passes over them). PlanarConfiguration 2 on a one-band file is the
// same bytes as 1, and the reader takes it (it refused it before this check,
// which would have refused every WaPOR and Sentinel-1 file).
import type { CogSpec } from './cogWrite.js';

/** A layout: every cogWrite option but the grid and its samples. */
export type CogLayout = Omit<CogSpec, 'width' | 'height' | 'values' | 'epsg' | 'originX' | 'originY' | 'pixelSize'>;

/** What GDAL writes for a geographic WGS 84 grid besides the codes: the citation, and the ellipsoid. */
const GEOGRAPHIC_KEYS: Pick<CogLayout, 'geoAscii' | 'geoDoubles'> = { geoAscii: { 2049: 'WGS 84|' }, geoDoubles: { 2057: 6378137, 2059: 298.257223563 } };
/** GDAL's COG frame, common to all six. */
const GDAL_COG: CogLayout = { ghost: true, blockTrailer: true };

/** A WaPOR v3 L2-AETI-D dekad. */
export const WAPOR_LAYOUT: CogLayout = {
	...GDAL_COG,
	...GEOGRAPHIC_KEYS,
	bigTiff: true,
	compression: 5,
	predictor: 1,
	planar: 2,
	tile: 512,
	nodata: '-9999',
	longDims: true,
	scaleOffset: { scale: 0.1, offset: 0 },
	// The tile tables after the small values, past the reader's first read.
	tableGap: 0
};

/** A Sentinel-1 RTC tile's VV (gamma0, linear power). */
export const S1_VV_LAYOUT: CogLayout = { ...GDAL_COG, ...GEOGRAPHIC_KEYS, compression: 8, predictor: 3, planar: 2, tile: 256, nodata: 'nan', resolution: true };

/** A Sentinel-1 RTC tile's MASK (0 no data, 1 valid, 2 shadow or layover). */
export const S1_MASK_LAYOUT: CogLayout = { ...S1_VV_LAYOUT, predictor: 2, nodata: '0' };

/** What GDAL writes for a UTM grid besides the codes: the citations and the angular unit. */
const utmKeys = (epsg: number): Pick<CogLayout, 'geoAscii' | 'geoKeys'> => ({
	geoAscii: { 1026: `WGS 84 / UTM zone ${epsg % 100}${Math.floor(epsg / 100) === 327 ? 'S' : 'N'}|`, 2049: 'WGS 84|' },
	geoKeys: { 2054: 9102 }
});

/** Invented band statistics: the real files carry their own, which are data and stay out of the repo. */
const statistics = (resampling: string) => [
	{ name: 'OVR_RESAMPLING_ALG', value: resampling },
	{ name: 'STATISTICS_MAXIMUM', value: '4000', sample: 0 },
	{ name: 'STATISTICS_MEAN', value: '2000', sample: 0 },
	{ name: 'STATISTICS_MINIMUM', value: '1000', sample: 0 },
	{ name: 'STATISTICS_STDDEV', value: '500', sample: 0 },
	{ name: 'STATISTICS_VALID_PERCENT', value: '100', sample: 0 }
];

/** A Sentinel-2 L2A Collection 1 reflectance band (B03 at 10 m in 1024 tiles; B08 the same; B11 at 20 m in 512). */
export const s2BandLayout = (epsg: number, tile: 512 | 1024 = 1024): CogLayout => ({
	...GDAL_COG,
	...utmKeys(epsg),
	compression: 8,
	predictor: 2,
	tile,
	nodata: '0',
	metadata: statistics('AVERAGE'),
	scaleOffset: { scale: 0.0001, offset: -0.1 }
});

/** A Sentinel-2 L2A Collection 1 scene classification (SCL, 20 m). */
export const s2SclLayout = (epsg: number): CogLayout => ({ ...GDAL_COG, ...utmKeys(epsg), compression: 8, predictor: 2, tile: 512, nodata: '0', metadata: statistics('MODE') });

/** What one real file's header held (see the header): its first IFD's tags and their TIFF types, and the values the reader turns them into. */
export interface RealHeader {
	bigTiff: boolean;
	/** The full image's IFD: tag → TIFF field type. */
	tags: Record<number, number>;
	ifds: number;
	sampleType: 'int16' | 'uint8' | 'uint16' | 'float32';
	compression: 1 | 5 | 8;
	predictor: 1 | 2 | 3;
	tile: number;
	nodata: number;
	scale: number;
	offset: number;
}

const BASE_TAGS = { 256: 3, 257: 3, 258: 3, 259: 3, 262: 3, 277: 3, 284: 3, 317: 3, 322: 3, 323: 3, 324: 4, 325: 4, 339: 3, 33550: 12, 33922: 12, 34735: 3, 34737: 2, 42113: 2 };

export const REAL_HEADERS = {
	wapor: {
		bigTiff: true,
		tags: { ...BASE_TAGS, 256: 4, 257: 4, 324: 16, 325: 16, 34736: 12, 42112: 2 },
		ifds: 11,
		sampleType: 'int16',
		compression: 5,
		predictor: 1,
		tile: 512,
		nodata: -9999,
		scale: 0.1,
		offset: 0
	},
	s1Vv: {
		bigTiff: false,
		tags: { ...BASE_TAGS, 282: 5, 283: 5, 296: 3, 34736: 12 },
		ifds: 6,
		sampleType: 'float32',
		compression: 8,
		predictor: 3,
		tile: 256,
		nodata: Number.NaN,
		scale: 1,
		offset: 0
	},
	s1Mask: {
		bigTiff: false,
		tags: { ...BASE_TAGS, 282: 5, 283: 5, 296: 3, 34736: 12 },
		ifds: 6,
		sampleType: 'uint8',
		compression: 8,
		predictor: 2,
		tile: 256,
		nodata: 0,
		scale: 1,
		offset: 0
	},
	s2Green: { bigTiff: false, tags: { ...BASE_TAGS, 42112: 2 }, ifds: 5, sampleType: 'uint16', compression: 8, predictor: 2, tile: 1024, nodata: 0, scale: 0.0001, offset: -0.1 },
	s2Swir16: { bigTiff: false, tags: { ...BASE_TAGS, 42112: 2 }, ifds: 5, sampleType: 'uint16', compression: 8, predictor: 2, tile: 512, nodata: 0, scale: 0.0001, offset: -0.1 },
	s2Scl: { bigTiff: false, tags: { ...BASE_TAGS, 42112: 2 }, ifds: 5, sampleType: 'uint8', compression: 8, predictor: 2, tile: 512, nodata: 0, scale: 1, offset: 0 }
} as const satisfies Record<string, RealHeader>;
