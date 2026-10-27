import sys, json, time, numpy as np, icechunk, xarray as xr
t0=time.time()
storage = icechunk.s3_storage(bucket='dynamical-ucsb-chc-chirps', prefix='ucsb-chc-chirps-analysis-final/v0.1.0.icechunk', region='us-west-2', anonymous=True)
repo = icechunk.Repository.open(storage)
sess = repo.readonly_session('main')
ds = xr.open_zarr(sess.store, chunks=None)
print(ds)
v = list(ds.data_vars)[0] if 'precipitation_surface' not in ds else 'precipitation_surface'
da = ds[v]; print('var', v, da.dtype, da.encoding.get('chunks'), da.encoding.get('compressors'), da.encoding.get('filters'))
picked = json.load(open(sys.argv[1]))
out=[]
for p in picked:
    x = da.sel(time=p['day'], latitude=p['lat'], longitude=p['lon'], method='nearest')
    val = float(x.values); out.append({**p, 'dyn': val, 'dyn_lat': float(x.latitude), 'dyn_lon': float(x.longitude)})
print('elapsed', round(time.time()-t0,1))
json.dump(out, open(sys.argv[2],'w'), indent=1)
for o in out: 
    rel = abs(o['dyn']-o['nc'])/o['nc'] if o['nc'] else abs(o['dyn'])
    print(o['day'], o['lat'], o['lon'], o['nc'], o['dyn'], f"rel={rel:.5f}", o['dyn_lat'], o['dyn_lon'])
