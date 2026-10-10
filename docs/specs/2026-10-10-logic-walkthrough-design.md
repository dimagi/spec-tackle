# Logic walkthrough

**Status:** Draft, awaiting review.
**Builds on:** [Logic view](2026-10-08-logic-view-design.md)

## Goal

The Logic map shows the shape of a PR's behaviour, but not what happens to real data.
The walkthrough lets the reviewer pick an entry block, give it concrete inputs, and step
through the map one block at a time, seeing each block's input and output. Claude
proposes starting inputs, so there is always a happy-path example to begin with. The
reviewer edits them to try edge cases (empty, null, already submitted, wrong role) and
sees where the logic goes, or where it breaks.

Nothing is executed. Claude dry-runs the code: it reads the real functions behind each
block and works out what each step would receive and return. Values it can't get from
the code, such as database rows, API replies or the clock, it invents and marks as
assumed. Steps whose code would be dangerous to run for real are flagged, so the
reviewer sees what the PR could do to data and the outside world.

## Hard requirements

These are non-negotiable. A change that breaks either of them is a bug, whatever else it
gains.

### 1. Claude never executes code

Claude, and the server for it, must never run, import, evaluate, build, install or test
any code from the PR or its repository. This covers the change itself and everything
around it: scripts, tests, migrations, package hooks, Makefiles and notebooks. Every
value in a trace comes from reading the code.

It's enforced in layers, so no single slip can break it:

- **Tools.** The walkthrough uses the same `claude._options` as Ask Claude and the map.
  `tools` and `allowed_tools` are exactly `["Read", "Grep", "Glob"]`, so Bash, Write, Edit,
  NotebookEdit, WebFetch, WebSearch and Task don't exist in the session.
- **Guard.** The `PreToolUse` guard (`make_guard`) denies any tool not in that list, and any
  path outside the checkout, even if the tool list is ever widened by mistake.
- **No MCP servers.** `strict_mcp_config=True`, so a `.mcp.json` committed to the reviewed
  repo can't add tools.
- **Prompt.** The system prompt says plainly that Claude must not run or try to run
  anything, must work out every value by reading, and must use a `stopped` outcome rather
  than guess when reading isn't enough.
- **Server.** The walkthrough code path starts no processes other than the `git` commands
  `Checkouts` already runs. It never imports or evaluates repo files.
- **Tests.** A test pins the session's tool list and checks the guard denies Bash, Write,
  Edit, NotebookEdit, WebFetch and an MCP tool name (see Testing).

Widening the tool list for the walkthrough, or for any other Claude feature, needs a spec
change that addresses this section.

### 2. Dangerous code is flagged

When a step's code would be dangerous if it ran for real, Claude must flag it on that
step, even when the trace's inputs don't trigger the danger. For example, a delete that
only runs on another branch is still flagged on the step that holds it. A step is
dangerous when its code:

| Kind | Examples |
|---|---|
| `destructive` | Deletes or overwrites data: `DELETE`/`DROP`/`TRUNCATE`, bulk updates, removing files or directories, clearing caches or queues others rely on. |
| `external` | Has effects outside the system: sending email, SMS or push notifications, charging payments, calling webhooks or third-party APIs that change state, publishing messages. |
| `unsafe` | Is a security risk: shell commands or `eval`/`exec` built from input, SQL built by string formatting, deserialising untrusted data (`pickle`, `yaml.load`), paths built from input without checks, missing permission checks, secrets written to logs or responses. |
| `irreversible` | Can't be undone in some other way: schema migrations, data migrations, revoking access, rotating or deleting keys. |

Each flag names the kind and says, in a sentence, what the code does and where: "Calls
`Visit.objects.filter(owner=user).delete()` without a status filter (app/visits/services.py:142)."
Claude flags what it reads in the code. It must not leave a flag out because the danger
looks intended. The reviewer decides whether it's acceptable.

The panel always shows flags prominently. They're never hidden behind a toggle or
collapsed section (see The Walkthrough panel).

Like the map, the walkthrough is private: generated locally, stored locally, never sent
to GitHub.

## Decisions

| Question | Decision |
|---|---|
| What it's for | Both understanding (follow one example through) and bug hunting (try edge cases and see where it breaks). |
| How values are worked out | Claude reads the code and traces it by hand. Nothing in the PR is run; Claude keeps the same read-only tools as the map. See Hard requirements. |
| Dangerous code | Flagged per step, with a kind (`destructive`, `external`, `unsafe`, `irreversible`) and a one-sentence reason, whether or not the trace's inputs trigger it. |
| Granularity | Leaf by leaf. Leaves are where the real functions are. Blocks with steps inside are never steps themselves. |
| Entries | One entry per run. The reviewer picks an entry block, and the trace goes from there to an exit, an error, or a point where Claude stops. |
| When Claude runs | On demand. Opening an entry for the first time proposes inputs and traces them in one run. Editing inputs and pressing **Run** traces the new values. Map generation is unchanged. |
| Caching | Every trace is stored per login, map, entry and input values. Running the same values again is instant. |
| Inputs | A form with one field per input: name, Claude's note on what it is, and a JSON value. **Reset** restores Claude's starting values. |
| Where | A **Walkthrough** panel on the right of the Logic view, where the function panel opens. The chart stays visible beside it. |
| Path checking | The server doesn't check that each step follows an edge from the step before. Loops and exits from inside nested blocks make that check fragile. A step with no matching edge just doesn't highlight one. |

## Data model

```
Trace {
  id: str
  mapId: str
  entryId: str               # an entry block in the map
  inputs: Input[]            # the values this trace ran with
  steps: Step[]              # 1 to 60
  outcome: Outcome
  proposed: bool             # true for the trace of Claude's starting inputs
}

Input {
  name: str                  # e.g. "body", "request.user"; 1-60 characters, unique in the trace
  description: str           # one line on what it is; 1-120 characters
  value: JSON                # any JSON value, at most 4 KB serialised
}

Step {
  blockId: str               # a leaf of the map
  input: JSON                # the named values going in, at most 4 KB serialised
  output: JSON               # the named values coming out, at most 4 KB serialised;
                             # on an error step, the error, e.g. {"raises": "KeyError('location')"}
  note: str                  # what happened and why; 1-200 characters
  assumed?: str[]            # values Claude invented; at most 5, each 1-120 characters
  danger?: Danger[]          # what would be dangerous to run for real; at most 5
}

Danger {
  kind: "destructive" | "external" | "unsafe" | "irreversible"
  note: str                  # what the code does and where; 1-200 characters
}

Outcome {
  kind: "exit" | "error" | "stopped"
  message: str               # 1-300 characters, e.g. "Raised VisitAlreadySubmitted …"
}
```

Values Claude can't write as plain JSON, such as model instances, are written as strings
in a short readable form, for example `"Visit(id=7, status='open')"`.

### Validation

The server rejects a trace, and lists every problem it finds, when:

- the answer has no fenced JSON block, or the JSON doesn't parse;
- a required field is missing, or a value has the wrong type or isn't one of the allowed values;
- a string is empty or longer than its limit, or a JSON value is over 4 KB serialised;
- there are no steps or more than 60, or a step has more than 5 assumptions or more than 5
  danger flags;
- a danger flag's `kind` isn't one of the four kinds, or its note is empty or too long;
- a step's `blockId` isn't a leaf of this map;
- the first step isn't the entry block itself (when it is a leaf) or a leaf inside it;
- `outcome.kind` is `exit` but the last step isn't a leaf of kind `exit`;
- for a run with proposed inputs: there are no inputs, more than 12, or two share a name;
- for a run with the reviewer's inputs: the answer changes the inputs. These runs don't ask
  Claude to return inputs; the server stores the ones it was given.

One repair turn is allowed on invalid output, as for the map.

## Running a trace

1. Opening an entry sends `GET /api/logic/{map_id}/walkthrough?entry={entry_id}`. It returns:
   - `trace`: the trace of this entry used most recently, or null;
   - `starting`: the inputs of the entry's proposed trace, or null;
   - `running: true` while a run for this map and entry is going;
   - `error`: the last run's failure, when nothing is running.
2. When `starting` is null and nothing is running, the view sends
   `POST /api/logic/{map_id}/walkthrough` with `{ entry }` and no inputs, which starts a
   **proposing run**.
3. **Run** sends `POST /api/logic/{map_id}/walkthrough` with `{ entry, inputs: { name: value } }`.
   - The names must be exactly the names of the starting inputs. Otherwise the request fails with 400.
   - The server hashes the canonical JSON of the values (keys sorted). If a trace with that hash
     is stored for this login, map and entry, it returns `{ trace }` straight away and marks it
     as used now.
   - Otherwise it starts a **fixed-input run** and returns `{ running: true }`.
4. Runs go through `TurnRunner`, keyed `walk:{login}:{map_id}:{entry_id}`. There is one run per
   map and entry at a time. A POST while a run is going returns the running state without
   starting another.
5. The run gets the worktree of the **map's** head SHA from `Checkouts`, so stale maps can
   still be walked through. It builds the PR snapshot with `build_context`, as the map does.
6. Claude gets the snapshot, the map's JSON and the chosen entry, plus a walkthrough
   instruction:
   - proposing run: propose realistic inputs for this entry, the kind a typical request or
     call would have, then trace them;
   - fixed-input run: trace exactly these inputs, and don't change them;
   - for both:
     - never run, or try to run, any code; work out every value by reading;
     - go leaf by leaf, from the entry, and read the real functions behind each leaf;
     - list every value you made up under `assumed`;
     - flag every dangerous operation in a step's code under `danger`, using the four kinds
       and their examples, even when these inputs don't reach it, and even when it looks
       intended;
     - where the code would raise, end with an `error` outcome and the error as the last
       step's output;
     - if you can't tell what the code does next, end with a `stopped` outcome that says
       why, rather than guess;
   - answer with a single fenced `json` block.

   Tools, guard and system prompt setup are the same as for the map: Read, Grep and Glob in
   the checkout, no MCP servers (see Hard requirements, 1).
7. Progress events stream over `GET /api/logic/{map_id}/walkthrough/events?entry={entry_id}`
   (SSE), in the format the map uses. When nothing is running it ends at once with `idle`.
8. The answer is validated, with one repair turn. A second invalid answer ends the run with
   an `error` event ("Claude's walkthrough didn't pass validation: …") and stores nothing.
9. A valid trace is stored and the run ends with a `done` event carrying the trace id.
   `GET /api/logic/traces/{trace_id}` returns it. Only its owner can read it.

The walkthrough is only offered when the Logic view is (`available: true`). Every route
returns 404 for a map that belongs to another login.

## The Walkthrough panel

### Opening and closing

- A **⏵ Walkthrough** button sits in the Logic view toolbar, next to **Expand all** and
  **Collapse all**, whenever a map is showing, including a stale one. When the map has no
  entry blocks, the button is disabled, with the tooltip "This map has no entry blocks".
- It opens the panel on the right, about 40% of the width, in place of the function panel.
- × or Esc closes the panel and clears all walkthrough highlighting from the chart.
- The open panel and chosen entry are kept in the URL (`?view=logic&walk={entry_id}`), so a
  reload comes back to the same walkthrough.

### Layout, top to bottom

1. **Entry picker.** A select listing every block of kind `entry` in the map, at any level.
   Entries that are test blocks are listed only while "Show tests" is on. It starts on the
   first top-level entry.
   - **Danger summary.** When any step of the trace has a danger flag, a red banner sits
     below the picker: "⚠ 2 steps flagged as dangerous". It lists each flagged step's label
     and kinds, and clicking one jumps to that step. The banner stays on every step, so a
     flag is never missed by stepping past it.
2. **Inputs.** A collapsible section.
   - Its header always shows a summary: "Inputs ▸ 4 values · proposed by Claude", or
     "· edited" once a value differs from the starting values.
   - It's collapsed by default whenever a trace is showing. It opens by itself when there is
     no trace yet, or when a run failed before producing one.
   - Each input shows its name (monospace), its description, and a small JSON editor sized to
     the value. Invalid JSON gets a red border and "Not valid JSON" below it.
   - **Run** is disabled while any value is invalid or a run is going.
   - **Reset** restores the starting values and shows their trace.
3. **Stepper.** It stays visible at the top while the step card scrolls. It has **◀ Prev**,
   "Step 3 of 9", **Next ▶** and **↺** (back to step 1). ← and → also step, unless focus is
   in a text field or select.
4. **Step card.**
   - The block's kind icon and label.
   - The note.
   - **Danger** flags, above everything else after the note. Each is a red box with "⚠", the
     kind ("Destructive", "External effect", "Unsafe", "Irreversible") and the note.
   - **Assumed** chips, one per assumption, styled as warnings, with a tooltip: "Claude
     couldn't read this from the code, so it assumed it."
   - **Input** and **Output** as formatted JSON. In the output, top-level keys that are new,
     or whose value differs from the input, are highlighted. When input and output aren't
     both objects, the whole output is highlighted if it differs.
   - **Show code**, which opens the function panel for the block. The function panel then
     has a "← Back to walkthrough" link that returns to the same step.
   - On the last step, the outcome. It's green for an exit ("Reached exit: …"), red for an
     error, and grey for stopped, with the message.

### States

| State | Shows |
|---|---|
| Proposing | The entry picker, and a progress card with Claude's latest activity. "Private: runs on your machine with your Claude Code. Takes a minute or two." |
| Ready | Inputs (collapsed), stepper and step card. |
| Tracing new inputs | The previous trace stays visible, with a progress card above the stepper. **Run** is disabled. |
| Failed | The error and **Try again**. The previous trace, if there is one, stays visible below. |

Leaving the tab or reloading during a run rejoins it, as the map does.

### On the chart

While the panel is open with a trace:

- **Expanding.** Every block that contains a step of the trace is expanded, all at once when
  the trace loads, so the chart is laid out once rather than on every step. This is on top
  of the reviewer's saved expanded set and isn't saved. Closing the panel goes back to the
  saved set. Blocks that were dragged return to the ELK layout, as with any expand or collapse.
- **Current step.** Its card gets a strong blue ring and a badge with its step number.
- **Visited steps.** Their cards get a light ring and a step-number badge. A leaf visited
  more than once, such as in a loop, shows its latest step number up to the current step.
- **Edges taken.** Edges between consecutive steps up to the current one are drawn thicker
  and in the accent colour, with their labels. For steps `a` then `b`, the edge is the one
  from `a`'s ancestor to `b`'s ancestor in the lowest list that holds both (an ancestor here
  includes the block itself). If there's no such edge, nothing is highlighted.
- **Danger.** A leaf with a danger flag in the trace gets a red "⚠" badge on its card from
  the moment the trace loads, before it's reached. Its `aria-label` and tooltip add
  "flagged as dangerous: <kinds>".
- **Off the path.** Blocks with no step at or inside them, and edges not on the path, are
  dimmed. The path is shown even when its blocks are tests and tests are hidden.
- **Clicking.** Clicking a visited block, or pressing Enter on it, jumps to its latest step at
  or before the furthest step reached. Other blocks open the function panel as usual.
  Ctrl/⌘-click still expands and collapses.

The walkthrough is drawn as extra data on the same React Flow nodes and edges: a `walk`
field with `current`, `visited`, `step`, `dim` and `danger` (the kinds). It doesn't change
the layout code.

## Storage

```sql
CREATE TABLE logic_traces (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  map_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,       -- sha256 of the canonical JSON of {name: value}
  inputs TEXT NOT NULL,           -- JSON of Input[]
  steps TEXT NOT NULL,            -- JSON of Step[]
  outcome TEXT NOT NULL,          -- JSON of Outcome
  proposed INTEGER NOT NULL,      -- 1 for the trace of Claude's starting inputs
  used_at TEXT NOT NULL,          -- set on creation and on every cache hit
  UNIQUE (login, map_id, entry_id, input_hash)
);
```

- It's migration 6 in `store.py`.
- "Most recently used" is the highest `used_at` for the login, map and entry.
- `save_logic_map` replaces the row when a map is regenerated for the same SHA, which gives it
  a new id. In that case it deletes the old id's traces in the same transaction. Traces of
  maps for older SHAs are kept along with their maps.

## Frontend structure

- `lib/walkthrough.ts`: pure functions with no React:
  - `entries(blocks, showTests)`;
  - `pathAncestors(blocks, trace)`: the blocks to expand;
  - `takenEdges(blocks, steps, upTo)`;
  - `changedKeys(input, output)`;
  - `stepForBlock(steps, blockId, reached)`;
  - `dangerSteps(steps)`: the flagged steps for the banner;
  - `walkMarks(...)`: the per-node `walk` data.
- `pages/logic/WalkthroughPanel.tsx`: the panel, with its own small components for the input
  form, stepper and step card.
- `api/queries.ts` and `api/types.ts`: the walkthrough query, run mutation and SSE
  subscription, following the map's pattern.
- `LogicView.tsx` decides which panel is open (function or walkthrough). `FlowChart.tsx` takes
  the `walk` marks and draws them.

## Privacy and safety

These are the same guarantees as the Logic view:

- nothing is sent to GitHub;
- nothing in the PR is executed, by Claude or by the server (see Hard requirements, 1);
- Claude gets read-only file tools confined to the checkout, and no MCP servers;
- the reviewer's input values go into the prompt verbatim;
- the GitHub token reaches git only through `GIT_CONFIG_*`;
- traces are readable only by their owner.

Input values, notes and JSON are shown as plain React text, never as HTML.

## Out of scope

- Actually running the PR's code, or its tests.
- Comparing the trace against the base branch's behaviour.
- Describing inputs in plain language for Claude to turn into values.
- Several entries in one trace.
- Editing a value partway through a trace and continuing from there.
- Sharing traces, or posting them to the PR.
- Checking that consecutive steps follow the map's edges.

## Testing

**pytest** (uses the existing fake ask, so no real Claude runs):

- Never executing code:
  - the options the walkthrough passes to the SDK have `tools` and `allowed_tools` equal to
    exactly `["Read", "Grep", "Glob"]`, `strict_mcp_config=True`, and the guard hook;
  - the guard denies Bash, Write, Edit, NotebookEdit, WebFetch, WebSearch, Task and an
    `mcp__…` tool name;
  - the walkthrough system prompt contains the never-run instruction and the four danger
    kinds;
  - a walkthrough run starts no subprocess other than through `Checkouts` (patch
    `asyncio.create_subprocess_exec` and `subprocess` and check they're unused by the run
    itself, with the worktree already present).
- Validation:
  - it accepts a good proposing answer and a good fixed-input answer;
  - it rejects every case listed under Validation, with a readable list of problems;
  - danger flags are kept with their kinds and notes, and an unknown kind is rejected.
- Running:
  - a proposing run stores a trace with `proposed` set, and the events end with `done`;
  - a fixed-input run stores the given inputs, not any Claude returned;
  - an invalid first answer causes exactly one repair turn, then succeeds;
  - a second invalid answer ends with `error` and stores nothing;
  - a second POST during a run returns the running state and starts nothing;
  - the run uses the map's head SHA, not the PR's current head.
- Caching:
  - posting values already traced returns the trace without starting a run, and updates `used_at`;
  - the same values with keys in another order hit the same cache entry;
  - input names that don't match the starting inputs return 400.
- `GET …/walkthrough`: returns nothing, the starting inputs with the latest trace, `running`,
  or the last error.
- Another login gets 404 from every route, including `GET /api/logic/traces/{id}`.
- Regenerating a map for the same SHA deletes the old map's traces.

**vitest:**

- `lib/walkthrough`:
  - `entries` lists nested entries and hides test entries;
  - `pathAncestors` returns every block containing a step;
  - `takenEdges` finds edges between siblings, between blocks in different groups, and none
    for a repeated leaf or a missing edge;
  - `changedKeys` covers new keys, changed values, unchanged values, and non-object values;
  - `stepForBlock` picks the latest visit at or before the furthest step reached.
- `WalkthroughPanel`:
  - each state in the States table;
  - Next, Prev, ↺ and the arrow keys, with the keys ignored while typing;
  - invalid JSON disables Run;
  - Reset restores the starting values;
  - the Inputs section is collapsed with a trace and open without one, and its summary
    shows "edited";
  - the assumed chips and each outcome kind;
  - danger flags on the step card, and the danger banner on every step, with its links
    jumping to the flagged steps;
  - no danger banner when nothing is flagged;
  - Show code opens the function panel, and Back returns to the same step.
- `LogicView`:
  - opening a trace expands its blocks without changing the saved set;
  - closing restores the saved set and clears the marks;
  - clicking a visited block jumps to its step;
  - flagged leaves show the ⚠ badge before they're reached;
  - `?walk=` survives a reload.

**Playwright** (the fake ask returns a canned trace):

- open the walkthrough, and see the proposed inputs and step 1 highlighted;
- step to the end, and see the edges taken and the outcome;
- see the danger banner and the ⚠ badge for a canned flagged step, and jump to it;
- edit an input, run it, and see the new trace;
- run the same values again, and see the cached trace with no progress card.

**Manual:** walk through a real PR on the reviewer's own server, once with the proposed
inputs and once with an edge case, to judge whether the traces are accurate and useful.
Include a PR with a known destructive or external call, and check that it's flagged.
