import sys, json, h5py, numpy as np, datetime as dt
f = h5py.File(sys.argv[1], 'r')
lat = f['latitude'][:]; lon = f['longitude'][:]; t = f['time'][:]
days = [(dt.date(1980,1,1)+dt.timedelta(days=int(x))).isoformat() for x in t]
print('days', days[0], '..', days[-1], len(days))
cells = [(-33.925,18.875),(-33.375,19.325),(-33.975,22.475),(-32.175,18.875),(-34.025,19.125)]
idx = [(int(np.argmin(abs(lat-a))), int(np.argmin(abs(lon-o)))) for a,o in cells]
for (a,o),(i,j) in zip(cells, idx): print(a,o,'->',lat[i],lon[j])
p = f['precip']
series = np.array([[p[d,i,j] for (i,j) in idx] for d in range(len(t))])
wet = np.argsort(-series.sum(axis=1))[:3]
pick = sorted(set(list(wet)+[int(np.argmin(series.sum(axis=1)))]))
out = []
for d in pick:
    for (a,o),(i,j),v in zip(cells, idx, series[d]):
        out.append({'day': days[d], 'lat': a, 'lon': o, 'nc': float(v), 'nc_bits': int(np.float32(v).view(np.uint32))})
json.dump(out, open(sys.argv[2],'w'), indent=1)
print(len(out), 'cell-days'); [print(r) for r in out]
