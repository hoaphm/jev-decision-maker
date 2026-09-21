# Use OMP-managed credentials with project-local activation

Status: accepted

The decision maker resolves OpenRouter credentials through OMP's runtime provider resolver instead of managing a duplicate key. It remains enabled per Git worktree: `/setup-jev enable` refuses an already tracked `.env`, otherwise adds one exact ignore rule before writing the local switch; explicit `enable --global` remains available. This deliberately replaces the previous environment-only credential rule; status checks only the cheap credential-presence path, while missing resolver capability or credentials return `missing_key` without a fallback or network request. Historical measurements remain invalid rather than being reclassified under this new boundary.
