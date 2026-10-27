import sys, h5py
f = h5py.File(sys.argv[1], 'r')
print('root attrs:', {k: (v.decode() if isinstance(v, bytes) else v) for k, v in f.attrs.items()})
for name, d in f.items():
    print(f'\n== {name} shape={d.shape} dtype={d.dtype} chunks={d.chunks} compression={d.compression} opts={d.compression_opts} shuffle={d.shuffle} filters={list(d._filters.keys()) if hasattr(d,"_filters") else None}')
    print('   fillvalue=', d.fillvalue)
    for k, v in d.attrs.items():
        if k in ('DIMENSION_LIST', 'REFERENCE_LIST'): continue
        print('  ', k, '=', v)
    if d.ndim == 1:
        print('   first/last:', d[:3], d[-3:])
