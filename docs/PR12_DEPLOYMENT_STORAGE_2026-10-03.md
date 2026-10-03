# PR 12 release and Oracle VPS storage

Owner authorization: "Deploy PR12 and report storage". Measurements below are
from the running Oracle VPS on 2026-10-03, after the production workflow's
cleanup. They do not describe unused Oracle account quota or unattached volumes.

## Release evidence

- PR: https://github.com/tejashendre/AI-paper-trading-agent/pull/12
- Tested head: `bda2b7dcae7a2b7fd1b6f5fb0c1b8b80588ca17c`.
- Pre-merge CI and read-only VPS/live-market preflight: run `37125878277`, success.
- Merge commit: `732454394a39c178dbf2fae5970223731fe91525`.
- Production deployment: https://github.com/tejashendre/AI-paper-trading-agent/actions/runs/37126563513, success.
- Deployment checks: 396/396 upgrade tests; strategy audit 156 passed, 0 warnings,
  0 failures; VPS live audit 175 passed, 0 warnings, 0 failures.
- Public status reports that exact commit and `PAPER_ONLY`. Dashboard, swing,
  XSEC and Redis are healthy. All three application images carry the exact
  merge revision, and their source manifests match the clean VPS Git checkout:
  `d6c44ef4e617ffbbbb55427766dbd56022638250d42ec20e7b5ed61d6568edfa`,
  131 files, 1,904,589 bytes.
- Live scans advanced after deployment. At 13:48:12 UTC, scan 3049 was 29.9
  seconds old, ERROR was 0 and no result had `vetoCode: OPERATOR_FREEZE`.
- Research capacity is 8192; labels per sweep are capped at 48 within the
  existing 45-second deadline. Rejected observations were 0 at 13:45:12 UTC.
- Book rebalance was not overdue. `node scripts/health-monitor.mjs` exited 0.
- Ledger verified: 57 files, 14,453 events, valid chain, no errors at the
  additional post-release check. The manual BTC position was visible in the
  deployment audit; public history still showed 88 AI trades and 17 manual
  trades. All nine feed rows reported GOOD and BYBIT_LINEAR at 13:53:38 UTC.
- Final 30-minute checkpoint passed at 14:09:21 UTC (19:39:21 IST), over
  thirty minutes after deployment verification and cleanup finished. Scan
  3070 was 49.29 seconds old, ERROR 0, OPERATOR_FREEZE rows 0; research queue
  4123/8192, rejectedNew 0; book rebalance overdue false. Health monitor also
  exited 0 at the final verification. Research rejection counts were zero at
  every recorded sample; strategy admission and promotion gates remain intact.
- Observation detail: the temporary local probe's extra non-future timestamp
  assertion stopped twice at the instant a scan completed, on ages of -0.271
  and -0.512 seconds. The HTTP server Date was about a second ahead of the
  laptop. The observer now waits one second after receiving responses before
  applying the same assertions: scan age at least zero and below 120 seconds,
  exact commit, zero errors/rejections/freeze rows and no overdue rebalance.
  No production code or threshold changed. These were subsecond clock
  differences, not stale scans, scan errors or failed deployments.

## Disk capacity and usage

Read-only `lsblk -b` confirmed the disk allocation at 13:46:19 UTC; the final
`df -B1 /` sample below is from 14:07:46 UTC:

| Measurement | Bytes | GiB | Decimal GB |
| --- | ---: | ---: | ---: |
| Attached boot disk | 53,687,091,200 | 50.00 | 53.69 |
| Usable root filesystem | 51,837,394,944 | 48.28 | 51.84 |
| Used by the complete VPS | 12,892,729,344 | 12.01 | 12.89 |
| Available to applications | 38,927,888,384 | 36.25 | 38.93 |

Usage was 25%. Filesystem metadata, boot partitions and reserved space explain
why allocated capacity differs from application-available capacity.

The production workflow's original "Disk After" output at 13:39:20 UTC was:

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        49G   13G   37G  25% /
```

## Project images and separate data

Two Docker Compose projects are running: the bot with four services and n8n
with three. Image sizes below are the Docker-reported image sizes from
`docker image ls` and `docker system df -v`. File and volume sizes are physical
allocated bytes from `du -sx -B1`, sampled at 13:46:19 UTC. Live volume sizes
can fluctuate as persistence runs. A GB here is 1,000,000,000 bytes.

| Project / item | Image size | Separate files and data |
| --- | ---: | --- |
| Bot app image `quant-trader:7324543...` | 745 MB | One image shared by dashboard, swing and XSEC |
| Bot Redis `redis:7-alpine` | 58.7 MB | Redis volume 40.0 MB |
| Bot project directory | None | 595.1 MB, including 570.8 MB of data |
| n8n `2.36.8` | 2.36 GB | n8n data volume 32.1 MB |
| n8n PostgreSQL `17.11-alpine3.24` | 415 MB | Active database volume 167.3 MB |
| n8n Cloudflare tunnel `2026.8.1` | 104 MB | No separate application data volume |
| n8n project directory | None | 494.9 MB, almost entirely existing backups |
| Existing unused n8n PostgreSQL volume | None | 72.5 MB preserved |

The bot app image plus Redis image total about 804 MB. The three n8n images
total about 2.88 GB. Do not multiply the bot image by its three app containers.
These are image and file measurements, not an exact attribution of all physical
Docker storage to each project.

Docker uses the containerd image store, which keeps compressed image content
and extracted layers. Shared layers and Docker's accounting also mean the
individual image rows are not a replacement for total disk usage. Docker
reported 4.681 GB immediately after cleanup and 4.682 GB at 14:07:46 UTC for
all five active images. See the official
[containerd storage explanation](https://docs.docker.com/engine/storage/containerd/#disk-space-usage)
and [image size definitions](https://docs.docker.com/reference/cli/docker/system/df/).

## Retained storage and cleanup

- The bot's 595.1 MB project folder includes 393.8 MB of deploy backups,
  10.2 MB of reset backup, 143.9 MB of the earlier release recovery copy,
  8.2 MB of ledger files, 4.7 MB of research and 9.3 MB of release-preflight
  evidence. These components are already inside the folder total.
- The three retained deploy backups include the verified full ledger copy
  made before PR 11's compaction. PR 12's small ledger did not need another
  compaction. Account, trade and learning records remain preserved.
- Workflow cleanup reclaimed 104.8 MB from an unused image and 1.251 GB of
  unused build cache. The five remaining images all have running containers.
- After cleanup, Docker still reported 1.231 GB of active, non-reclaimable
  build cache. Do not call this deployment cache-free or claim that all cache
  was removed.
- Shared operating-system storage includes 1.94 GB of logs, mainly 1.86 GB of
  system journal, and 153 MB of package cache. These are included in the VPS
  used-space figure, not additional to it.
- No manual pruning of volumes, n8n backups, recovery data or financial history
  was performed during this verification.

This release fixes research observation capacity. It does not establish future
profitability or authorize promotion of strategies that lack forward evidence.
