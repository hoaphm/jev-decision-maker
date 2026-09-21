# Measure the select gates instead of guessing them

Status: accepted

The per-kind probability gates shipped as a guess (`read` 0.90, `edit`/`check` 0.95). Three measurement
batches showed the guess was the binding constraint, not the model: in the first valid sweep
(`docs/research/jev-effective-protocol-4/`, run-eKjtHU, 180 direct calls through the real resolver) the
`edit` gate committed 3 of 27 correct picks and `check` committed 24 of 30, while the answers themselves
were sound.

The gates are now `read` 0.90, `edit` 0.41, `check` 0.41, taken from that sweep under a rule frozen before
it ran: a threshold ships only if it holds precision ≥ 0.95 on train (30 select points per kind), and on a
hold-out the current gate failed to serve (20 points per kind) it commits at least 8 calls, at least 8 of
them correct, at precision ≥ 0.90, with a strictly better recall than the current gate. `read` keeps 0.90
because its hold-out was too thin to decide (7 committed against a floor of 8) — no verdict, no change.

Two consequences are recorded rather than smoothed over. First, the per-kind order is now inverted against
risk: the `edit` gate (files change) is looser than the `read` gate. That is a property of this fixture
set, not a policy anyone chose, and it is the strongest argument for the next protocol to decide the gates
on `confidence` — the axis TypeSafe documents for exactly this purpose — rather than on raw choice
probability. Second, the same batch found a client defect: the distribution sum was checked against a flat
0.001 while the endpoint rounds each probability to two decimals, so a valid answer summing to 0.99 was
rejected as `invalid_response`. The band is now `0.005 x n`, derived from that rounding.

Both changes are pinned by tests that derive their boundaries from `PROBABILITY_THRESHOLDS` rather than
restating them, and every measured number behind them lives in the run directory named above.
