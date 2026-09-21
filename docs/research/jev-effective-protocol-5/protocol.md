# Protocol v5 — sáu repeat, probability song song confidence

Status: frozen before paid request. Reuses exactly `docs/research/jev-effective-protocol-2/cases.json` (30 forks); no fixture edit.

## Goal

Run the same 30 forks six times so `read` gets a 20-point hold-out and `edit`/`check` get a second sample. Sweep the product probability gate and a parallel descriptive confidence gate. Confidence never writes product thresholds in v5; a confidence gate requires a new protocol.

## Plan

- 30 forks × 6 `select` repeats = 180 calls; 30 `score` calls = **210 requests**. Repeat-major: all forks at repeat 1, then 2…6, then score.
- Train: repeats 1–4 (40 points/kind). Hold-out: repeats 5–6 (20 points/kind).
- Probability grid: 0.40..0.99 by 0.01. Confidence grid: 0.20..0.99 by 0.01.
- Health gate: first 10 calls; any non-2xx stops immediately. `health` = null/5xx, `rejected` = 4xx. Five non-2xx in a row stops the tail. Unsent local failures do not advance the streak. 
- `invalid_response` bodies are captured via `Response.clone()`, bounded to 2000 characters and redacted before artifact write.

## Probability rule

Per kind: train needs committed ≥5, precision ≥0.95, and tau strictly above the grid floor. Choose the smallest valid tau. Hold-out accepts only with committed ≥8, correct ≥8, precision ≥0.90 and recall strictly above recall at the current threshold. If current committed is zero, recall comparison is undecidable. Coverage must be train 40 and hold-out 20 per kind. `clientFailures > 3` or `authoringErrors > 0` invalidates the batch.

## Confidence rule

Run the same sweep over confidence using a descriptive current baseline of 0.50. Print its curve and verdict separately. Confidence is **not** a shippable product verdict in v5; no product code is changed from this axis.

## Freeze and artifacts

`freeze.json` hashes this file, the v2 case file, runner, grids, repeat split, current thresholds, metric rules and body-capture flag. Artifacts go under `docs/research/jev-effective-protocol-5/runs/run-*`. A batch with invalid transport/contract health produces no threshold change; its body section is the diagnostic deliverable.

Command: `bun docs/research/jev-effective-protocol-2/runner.ts --v5`
