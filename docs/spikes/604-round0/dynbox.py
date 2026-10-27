import sys, time, h5py, numpy as np, icechunk, xarray as xr
f=h5py.File(sys.argv[1]); lat=f['latitude'][:]; lon=f['longitude'][:]
i0,i1=np.searchsorted(lat,-35.5),np.searchsorted(lat,-8.0); j0,j1=np.searchsorted(lon,10.0),np.searchsorted(lon,41.0)
nc=f['precip'][:,i0:i1,j0:j1].astype(np.float32)
t0=time.time()
s=icechunk.s3_storage(bucket='dynamical-ucsb-chc-chirps',prefix='ucsb-chc-chirps-analysis-final/v0.1.0.icechunk',region='us-west-2',anonymous=True)
ds=xr.open_zarr(icechunk.Repository.open(s).readonly_session('main').store,chunks=None)
da=ds.precipitation_surface.sel(time=slice('2024-06-01','2024-06-30'), latitude=slice(float(lat[i1-1])+1e-3, float(lat[i0])-1e-3), longitude=slice(float(lon[j0])-1e-3, float(lon[j1-1])+1e-3))
dyn=(da.values[:, ::-1, :]*np.float32(86400)).astype(np.float32)  # dynamical is north-up
print('read', dyn.shape, 'in', round(time.time()-t0,1), 's')
land_nc = nc!=-9999; land_dyn=~np.isnan(dyn)
print('mask agree:', bool((land_nc==land_dyn).all()), 'land cell-days', int(land_nc.sum()))
a=nc[land_nc]; b=dyn[land_nc]
print('exact equal', int((a==b).sum()), 'of', a.size)
wet=a>=1.0
rel=np.abs(b[wet]-a[wet])/a[wet]
print('wet (>=1mm) cell-days', int(wet.sum()), 'rel diff %: median', np.median(rel)*100, 'p99', np.percentile(rel,99)*100, 'max', rel.max()*100)
absd=np.abs(b-a); print('abs diff mm: max', float(absd.max()), 'p99', float(np.percentile(absd,99)))
print('box total mm nc', float(a.sum()), 'dyn', float(b.sum()), 'rel %', float((b.sum()-a.sum())/a.sum()*100))
