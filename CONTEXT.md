# JEV Decision Maker

Experimental omp integration that asks a TypeSafe System One model (Jev, via OpenRouter) to pick
one of the next steps the main agent already proposed at a coding/debug branch point. It ships as an
omp plugin: the tool is `src/decision-maker.ts`, the usage policy is `rules/decision-maker.md`, and
the measurement protocol and results live under `docs/research/`.

## Language

**Decision maker**:
The component that selects one coding/debug step from the options the main agent supplies at a branch
point. It is not a planner and not an executor.
_Avoid_: decider, router, agent selector

**Branch point**:
A moment where at least two different steps are each adequate next moves. A required or obvious step
is not a branch point.
_Avoid_: fork, decision node, choice

**Return to main**:
Refusing to select and handing the reasoning back to the main agent, without substituting another
model's answer for Jev's.
_Avoid_: fallback, escalation, defer-to-human

**Project-local opt-in**:
An activation choice that enables the decision maker in one Git worktree without enabling it in other worktrees.
_Avoid_: machine-wide enablement

**Global opt-in**:
An explicit activation choice that enables the decision maker in every OMP session using the same agent configuration.
_Avoid_: default activation

**OMP-managed credential**:
An OpenRouter credential resolved by OMP's provider configuration and exposed to an extension at runtime, rather than stored or configured by the decision maker.
_Avoid_: plugin-managed key, duplicated credential
