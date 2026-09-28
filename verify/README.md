# verify/ — independent reimplementation of the b023 model (IN PROGRESS)

The plan: write a second implementation of the b023 pipeline in Python, working
only from the workbook's cell formulas and named LAMBDAs. It must not read
`packages/engine/src`. Then run it against the TypeScript engine and the
workbook's computed values (`data/client-catchment/expected.json`), three ways.

## Current state (2026-09-23): spec extraction only, no implementation yet

Work stopped early at the end of the session. **Nothing here has been run
against the TS engine or the workbook yet, so nothing is verified.**

Done:

- `dumpwb.py`: dumps cell formulas, including array formulas, from a workbook.
  Usage: `python dumpwb.py <xlsm> <maxRows> [Sheet1,Sheet2]`. It needs openpyxl
  and opens the file read-only.
- The formulas below were read from `../project-water-management-source/Original/<client workbook>.xlsm`.
  They are the spec the Python implementation will follow.

Not done: the Python model (`model.py`), the TS runner, `diff.py`, the random
network generator, the example catchments, the three-way comparison, and
classifying any differences.

## Spec as read from the workbook

Rounding: ROUND means Excel ROUND, which rounds half away from zero on the
15-significant-digit decimal value. INT means floor.

**Flow data** (one row per day; row 20 is the init row, where S20 = baseFlowInitial and every other cell is blank = 0):

- `R` rain used: the first non-blank of catchment rain, CHIRPS, forecast. Keep it if it is above `rainThresholdMm`, else 0.
- `N` summer/winter: `fSorW2(month, Nprev, R, Rprev)`. Summer if `FIND(m&",", summerMonthsCsv&",")`. This is a substring match, so `[11]` also makes January summer. That is a quirk to test. Otherwise 0 if Nprev=0; else 0 if R ≥ winterToday; else 0 if Rprev ≥ winterNextDay; else 1.
- `V = fRainToFlow(R,N) = R>0 ? INT(a·R^b · areaTotal·1000 · (N?summer:winter)) : 0`.
- `S = fBaseFlow`: FB = `fRecede(Sprev, Tprev)`. On day 1, Sprev = S20 is not blank, so it recedes with index blank → 0. With L=1 and P=−1, the factor is 2·f1−f2, which is a quirk. Reset to FR if FR/FB > baseResetRatio, then ROUND 0.
- `fRecede(F,i)`: L=max(INT i,1), H=min(L+1,80), then `ROUND(F·(f[L]+(i−L)(f[H]−f[L])),0)`.
- `T = fRfIndex(S)`: L = min(MATCH(S,curve,−1) or 1 on #N/A, 79), H=L+1, then `max(1, ROUND(min(L+(S−c[L])/(c[H]−c[L]), daysMax),4))`.
- `U = fRecede(Yprev, Zprev)`. `W = fIndxAddedFlow(Wprev,T,V)`. `X = fRespAddedFlow(V,U,Xprev,Wprev)`. `Y = X>S?X:S`. `Z = X>S?W:T`.
- `AB` natural flow = `Y>0 ? Y : (ROUND(pitman·86400)>0 ? that : 0)`.
- `P` observed = `ROUND(flowKind m³/s · 86400, 0)`. `AF` EWR = `pragmatic[MOD(month+2,12)]`. `AK` = `AG−AF` when `AG−AF<0`, else 0.

**Fragmentation**: `runoff = ROUND(natural · share, 0)`, with share = area / areaTotal.
In the workbook, some Farm spec share cells are hard-coded to the area share whatever
the selected method. That only matters for non-area methods.

**Demand**:

- Crop gross (mm) = `ROUND(apan[m]·cf[m], 2)`.
- Farm gross (m³/d) = `ROUND(Σ area·gross/1000/days[m], 1)`, with Feb = 28.25.
- Net = `ROUND(MAX(0, gross − totalCropArea·eff/1000·R), 0)`, using the thresholded rain R.

**Farm sheet, row per day**:

- P14 = `ROUND(capacity,0)`, so a sub-m³ capacity becomes 0. Q16 = `ROUND(initPct·P14,0)`.
- `G=MIN(Qprev+M+O+K+J, F)`, `K=H−L`, `L=ROUND(H·pctUp,0)`, `M=ROUND(I·pctRunoff,0)`, `N=I−M`, `O=MIN(divert, L+N)`.
- `P=Qprev+M+O+K+J−G`, `Q=MIN(P,cap)`, `R=MAX(P−cap,0)`, `S=L+N−O`, `T=ROUND(G·ret,0)`, `U=R+S+T`, `W=F−G`.
- EWR columns: `AA=MIN(U−Z,0)` and `AB=MIN(AA−Σupstream AA,0)`.

**Transfers**: `fGetTrfVolCapped(Qprev,cap,minPct,max) = MIN(MAX(Qprev−cap·minPct,0),max)`, with months by `fIsMthIn`. It uses the same FIND substring match. The Transfers, Fragmented EWR, EWR shortfalls and Shortfalls sheets were not yet transcribed. They are further down the same `dumpwb.py` dump.
