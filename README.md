# site-generator-fast-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/k9233462-arch/site-generator-fast-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/k9233462-arch/site-generator-fast-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in replacement for makefun-site 1.0.0. It returns exactly the output tree makefun-site's build returns for a site — every page's index.html, the index and tag pages, build-report.txt and each static file, byte for byte, with makefun-site's own front matter, template dialect, Markdown subset, slug rule and report — but it computes it with fused single-pass scanners instead of token objects, plain-run slicing instead of per-character escaping, and memoised slug and date work, so it runs several times faster. solve.js exports run(input); main.ts is the harness driver that answers every case in /input/cases.json into /output/answers.json.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=zbp4x2kk&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
