# Decision maker

Only when a `decision_maker` tool is present and a coding/debug step really forks into 2-5 distinct,
adequately supported options. The tool's own description carries the contract; this rule is the
policy for using it.

- Offer short candidates tied to evidence you already have. Do not reason out every option in full
  before asking, do not invent options to force a call, and do not call it for arithmetic or for a
  step that is obvious or required.
- Candidates must belong to the current task and the permissions you already hold.
- `status: "selected"` - carry out that candidate with your normal tools; do not relitigate the choice.
- `status: "main"` - keep reasoning yourself. A `deferred`/`uncertain` answer means the model would not
  commit; any other reason is a client-side failure. Neither is a question for the user.
- If new evidence invalidates a candidate, drop the earlier answer and re-decide.
- The answer is a suggestion, never authorization. It does not approve destructive, networked or
  account-changing actions.
