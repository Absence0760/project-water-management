# Writes the D2 finals layout (year, doy[366], lat, lon) and the daily layout (day, lat, lon) with zarr-python 3, float32 + gzip.
import sys, json, h5py, numpy as np, zarr, datetime as dt
from zarr.codecs import GzipCodec
f=h5py.File(sys.argv[1]); out=sys.argv[2]
lat=f['latitude'][:]; lon=f['longitude'][:]
i0,i1=np.searchsorted(lat,-35.5),np.searchsorted(lat,-8.0); j0,j1=np.searchsorted(lon,10.0),np.searchsorted(lon,41.0)
box=f['precip'][:,i0:i1,j0:j1].astype(np.float32); box[box==-9999]=np.nan
ny,nx=box.shape[1:]
root=zarr.open_group(out, mode='w', zarr_format=3)
fin=root.create_array('rnl', shape=(2,366,ny,nx), chunks=(1,366,20,20), dtype='float32', fill_value=np.nan, compressors=GzipCodec(level=6), dimension_names=('year','doy','lat','lon'))
fin.attrs.update({'firstYear': 2023, 'origin': {'lat': float(lat[i0]), 'lon': float(lon[j0])}, 'step': 0.05})
d0=(dt.date(2024,6,1)-dt.date(2024,1,1)).days
fin[1, d0:d0+30, :, :]=box
day=root.create_array('prelim', shape=(30,ny,nx), chunks=(1,110,124), dtype='float32', fill_value=np.nan, compressors=GzipCodec(level=6), dimension_names=('day','lat','lon'))
day[:]=box
# probe cells to check from Node: (lat idx, lon idx) incl. a sea cell and a chunk edge
probes=[(int(np.searchsorted(lat,a-1e-4))-i0, int(np.searchsorted(lon,o-1e-4))-j0) for a,o in [(-33.925,18.875),(-34.025,19.125),(-33.975,22.475)]]+[(0,0),(19,19),(20,20),(ny-1,nx-1)]
exp=[{'y':int(y),'x':int(x),'bits':box[:,y,x].view(np.uint32).tolist()} for y,x in probes]
json.dump({'d0':d0,'ny':ny,'nx':nx,'probes':exp}, open(out+'.expect.json','w'))
print('wrote', out, 'ny', ny, 'nx', nx, 'probes', probes)
