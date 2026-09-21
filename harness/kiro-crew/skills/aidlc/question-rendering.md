# Question Rendering — Kiro Crew harness annex

This annex binds the shared stage protocol's structured questions to Crew.
Fenced `question` blocks are input specifications, never chat output.

## Never echo the spec (non-negotiable)

Never echo, print, paste or quote a `question` fence or its field lines
(`prompt:`, `header:`, `multiSelect:`, `options:`, `label:`, `description:`).
Render the question as a card and numbered prose. This applies to every
structured-question site, including but not limited to approval gates, the
interaction-mode choice, the ladder prompt, halt-and-ask on Bolt failure,
consolidated-summary confirmation and the learnings gate.
Literal specification fences in framework files remain authoring input, not
content to show the user. Dropping the rendered choices or Other escape is a
protocol violation, not a style choice.

## Mechanism

Call **`ask_question` through `@kirocrew-core`** AND emit matching numbered prose
with a final `[OPTIONS: ...]` line in the same turn, then **END THE TURN**.
Finish the prose fallback, but make no further tool calls or workflow moves
until the next ordinary human message. The tool is non-blocking: its result is
a card request, never an answer. Do not poll, guess, re-ask or infer assent.
Cards can be dropped without an attached dashboard client, so always supply
the prose fallback. A non-dashboard response directs use of the trailer,
not continuation.

The card accepts 1–4 questions. Each has `question` (required, ≤500 characters),
`header` (optional, ≤50), `options` (1–6 entries with required `label` ≤200 and
optional `description` ≤500), and optional `multiSelect` (default false).
Map the specification's prompt to question. Header names the question site,
not a response key. Never send the raw fence as input or output.

### Illustrative mapping (input specification)

```question
prompt: "[Stage Name] complete. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide revision feedback
```

Render this with the same labels on the card and in prose, adding Other once:

```text
**Approval** — [Stage Name] complete. How would you like to proceed?

1. **Approve** — Continue to [next stage]
2. **Request Changes** — Provide revision feedback
3. **Other** — describe what you want instead

Reply with a number (or just tell me).
[OPTIONS: Approve | Request Changes | Other]
```

Use the directive's `next_stage` verbatim, or `Complete workflow` when null.
Never guess the next stage. This lifecycle example does not replace Plan Approval.

### Card/prose algorithm and capacity

1. Build visible choices once in source order. Bold the header and labels.
   If a recommendation exists, put it first with `(Recommended)` in its label.
   Number each genuinely different question afresh from 1; use unordered bullets
   for preceding summaries. Preserve the number-to-source mapping.
2. Keep labels identical across card, numbered prose and trailer, without
   numbers, Markdown markers or descriptions inside `options[].label` or the
   trailer. Never shorten protocol labels.
3. Append exactly one final Other when absent. Remap an existing file option
   `X. Other (please specify)` rather than duplicating it. The free-text card field
   does not replace that visible choice.
4. More than six choices must not be truncated. Split into at most four questions
   of at most six options, retaining original order/numbers and one final Other
   across parts, only when the original single-select meaning is preserved.
   Prefer prose-only for a single logical choice or approval. If splitting is
   ambiguous, explain: "There are more choices than fit on one card; all choices
   are listed below. Reply with the label you want."
5. More than four questions require smaller batches and a human turn between
   batches. Oversized fields stay complete in prose with a card-limit note,
   never silently shortened. Prefer one logical question per Slack message:
   trailer rendering splits only the final options line on `|`. For a dashboard
   batch, render each question in prose and put only the last question's labels
   in the final trailer; the card carries the complete batch. A literal `|` in
   a label or any unrepresentable trailer means explain the limit, preserve full
   prose and invite a label-word reply without a misleading trailer.
6. Persist the appropriate question state below BEFORE presentation. Then request
   the card, finish prose and END THE TURN. Only a real human reply permits answer
   persistence. Multi-select says "Reply with all numbers that apply (e.g. 1, 3)."

The card is presentation, not enforcement or durable pending-question storage.
There is no card answer receipt or server-side wait to query. Pending state comes
from question/decision records, engine Plan Approval asks or lifecycle state.
Slack uses trailer-only rendering; dashboard card delivery is a separate host
behavior. Neither proves a human approval receipt.

## Mandatory consolidated-summary checkpoint

Apply only when `directive.ceremony.summary_confirmation === "on"`. Off omits this
checkpoint alone; ordinary questions, Plan Approval and lifecycle gates remain.
After file-backed Q&A, before any artifact, append/update
`## Consolidated Summary Confirmation` with summary, prompt,
both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag. Present Looks correct / Request changes / Other with matching
numbered prose and trailer.

Run the checkpoint-specific `aidlc-log.ts decision` from SKILL.md before presenting,
with exact `--questions-file`, stage and applicable `--unit` / `--single`.
END THE TURN. After the human replies, write the semantic choice their reply names,
then run the matching checkpoint-specific `aidlc-log.ts answer` with their reply
unchanged as one raw `--details` argv value. The engine reads their own words;
do not rewrite a number, typo, yes or feedback into fabricated human speech.

`[Answer]: Looks correct` and `[Answer]: Request changes` are semantic file values.
`[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`, and a self-selected answer
are invalid. Generate only when `[Answer]: Looks correct` is written and the
receipt command succeeds. On Request changes, supplied change text is feedback;
otherwise ask **"What should change?"** with concrete options and END THE TURN
before editing answers. Apply feedback, reset the tag and reconfirm. Bare Other
does not authorize generation: discuss and re-present the choices. When the engine
records nothing, follow its requested short clarification, END THE TURN and never
ask for a retyped label. Do not merge this stop with later review/learnings/gate.

## Three persistence paths (keep distinct)

1. **Ordinary questions:** log decision before presenting and answer after a human
   turn, preserving stage/unit/attempt identity. File A-E and X labels are storage
   labels: display numbers and map to stored labels; never ask for file letters.
   Preserve human input verbatim in logging. Typed engine asks use their own
   response route and never invented decisions or receipts.
2. **Summary confirmation:** exact questions-file-bound pair with
   `--checkpoint summary-confirmation` on both calls. Semantic file choice plus
   unchanged human reply supplies the receipt; presentation alone does not.
3. **Lifecycle gate:** `report --stage "<directive.stage>" --result awaiting-approval`
   precedes presentation. After the human reply, report approved/rejected with
   unchanged reply via `--user-input`. Supplied Request Changes feedback is used
   directly; a bare pick needs a separate feedback turn and `--reason`.
   Preserve Practices Discovery promotion and revision ordering in SKILL.md.
   Never use ordinary decision/answer logging for this gate. Bare Other or an
   engine request for clarification leaves it open.

### Plan Approval identity (engine-owned, not a lifecycle gate)

Follow Code Generation Steps 2–3 and the engine's `ask_type: "plan-approval"`.
Show `plan_approval.note`, every target's summary and plan path, and the supplied
choices (including I'll edit the files), then END THE TURN. After the real human
reply, run bare `next`. Never write an approval questions file, log answer,
fingerprint, challenge or receipt yourself. The same-session Crew UserPromptSubmit
adapter activates the engine human-turn hook, which interprets own-words replies,
including numbers, and records authority for the current question.

Grouped approval still binds each Unit separately. Named-Unit change feedback
revises that Unit and approves the others; ambiguous changes require the engine's
clarification rather than a guessed target. Nonhuman completion/batch/synthesis,
automatic continuation and resume notices never answer this question.

The current session-bound question and human response are the authority, not card
delivery, Markdown or audit text alone. Missing human input, stale identity or
missing hooks leaves generation blocked. Rejection does not authorize generation;
revise and re-present through current directives. Summary confirmation off does
not turn Plan Approval off. Only the person turns Plan Approval off; never do it
yourself or suggest it. Core policy switches and permission-vs-notification
limitations remain as documented; never forge authority to work around them.

Preserve every source choice plus one Other, not emergent options. Free text that
clearly names an option can resolve it; for typed engine checkpoints pass the
person's unchanged words and follow the engine's interpretation/refusal. Keep
protocol-fixed labels exact when localizing surrounding prose.
