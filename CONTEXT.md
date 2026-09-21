# JEV Decision Maker

Experimental omp integration that asks a TypeSafe System One model (Jev, via OpenRouter) to judge the
next steps the main agent already proposed at a coding/debug branch point - picking one, or rating all
of them against one rubric. It ships as an omp plugin: the tool is `src/decision-maker.ts`, the usage
policy is `rules/decision-maker.md`, and the measurement protocol and results live under
`docs/research/`.

## Language

**Decision maker**:
The component that judges coding/debug steps the main agent already proposed at a branch point: it
either selects one (`select`) or rates them all against one rubric (`score`). It is not a planner, not
an executor and not an authority.
_Avoid_: decider, router, agent selector

**Branch point**:
A moment where at least two different steps are each adequate next moves. A required or obvious step
is not a branch point.
_Avoid_: fork, decision node, choice

**Return to main**:
Refusing to select and handing the reasoning back to the main agent, without substituting another
model's answer for Jev's.
_Avoid_: fallback, escalation, defer-to-human

**Step selection**:
One Choice question: which of the supplied candidates is the best next step. The reported probability is
relative to the other candidates, so a high value means "best of these", not "correct".
_Avoid_: ranking, routing

**Rubric scoring**:
One independent Score question per candidate, all sharing one state and one ordered rubric in a single
request. Each candidate is rated on its own merits, so scores are not a comparison the model was asked to
settle and no winner is implied.
_Avoid_: grading, ranking, judging panel

**Score**:
The probability-weighted index of the rubric levels (`0 .. levels-1`). It orders candidates against that
rubric; it is not a percentage, not a probability of correctness, and not comparable across rubrics.
_Avoid_: confidence, rating value, quality metric

**Confidence**:
A statistic derived from the shape of the answer's own distribution. Low confidence means the model did
not concentrate its belief; it is not a second, independent check on the answer.
_Avoid_: certainty score, accuracy estimate

**Project-local opt-in**:
An activation choice that enables the decision maker in one Git worktree without enabling it in other worktrees.
_Avoid_: machine-wide enablement

**Global opt-in**:
An explicit activation choice that enables the decision maker in every OMP session using the same agent configuration.
_Avoid_: default activation

**OMP-managed credential**:
An OpenRouter credential resolved by OMP's provider configuration and exposed to an extension at runtime, rather than stored or configured by the decision maker.
_Avoid_: plugin-managed key, duplicated credential
