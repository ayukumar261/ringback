---
name: ticket
description: Fix an fp ticket with a worktree agent, verify it, and schedule a "Review ready" email for 6:00 AM Pacific the next morning. Use when the user runs /ticket RGBK-xxx or asks to have a ticket fixed in a worktree.
---

# /ticket

Usage: `/ticket <fp-issue-id> [--now]`

Runs the whole loop for one fp ticket. Load the ticket, mark it in-progress, fix it in an isolated worktree with a subagent, verify, then send Ayush a "Review ready" email held until 6:00 AM Pacific the next morning. `--now` sends immediately instead.

The ticket stays in-progress at the end. Only Ayush moves it to done after reviewing.

## Steps

### 1. Load and claim

```bash
fp context <id>
fp issue update --status in-progress <id>
```

Read the description and the file list. If the ticket has no description or no "Done when" line, stop and tell the user before spawning anything.

### 2. Spawn the worktree agent

Use the Agent tool with `subagent_type: general-purpose` and `isolation: worktree`. Build the prompt from this shape, pasting the ticket description and its bullets verbatim.

```
Fix fp issue <id> in the ringback repo. You are working in a fresh git worktree. Start by running `fp context <id>`.

Issue summary: "<title>". <description>

Scope from the ticket:
<bullets verbatim>

Done when <done-when line>.

Working rules for this repo:
- Read the existing code in every file the ticket names before changing anything, and match the conventions already there.
- Code comments are one plain sentence with no semicolons, colons, em dashes, or parentheticals.
- Do not run `fp comment` or change the ticket status. The main session owns the ticket.
- Do not run `git commit` or `git push`. Leave the changes uncommitted in the worktree and suggest a commit breakdown at the end.
- Verify with the package's own tooling. Go: `go build ./...`, `go vet ./...`, `go test ./...`, gofmt on touched files. TypeScript: the package's test, check-types, and lint scripts. Say plainly if any step could not be run.
- Do not widen scope. If you touch something the ticket did not ask for, call it out in the report.

Finish with a report containing: the worktree path and branch, one paragraph describing the bug, one bullet per symbol you added or changed, each verification command and its result, anything you could not verify and why, any scope expansion, and a suggested commit breakdown with one line per commit and the files in each.
```

Run it in the background and wait for the completion notification. Do not touch the worktree while the agent is running.

### 3. Confirm the report

From the worktree the agent names, gather the numbers yourself. Do not trust the agent's counts.

```bash
cd <worktree> && git status --short && git diff --numstat
wc -l <each untracked file>
```

Re-run the package's test command once in the worktree so the verification table reflects a run you saw.

### 4. Fill the email

Templates live beside this file. Read both, then fill every placeholder.

- `template.html` is the design. Do not change fonts, sizes, spacing, or colors. Only replace placeholder text and add or remove rows.
- `template.txt` is the plain-text twin. Keep it in step with the HTML.

Placeholder guide:

| Placeholder | Fill with |
| --- | --- |
| `{{DATE}}` | Today in the form `7 September 2026` |
| `{{ID}}` | The fp id, for example `RGBK-quzkruxq` |
| `{{TITLE}}` | The ticket title without its leading number, for example `Mix DTMF Beeps Into the Recording` |
| `{{WORKTREE}}` | Absolute worktree path |
| `{{BRANCH}}` | Worktree branch name |
| `{{BUG}}` | One or two sentences on what was broken and why, in plain words |
| `{{CHANGES}}` | One paragraph per symbol. The symbol name in a `font-weight:600` span, then what it does. Three to five paragraphs. |
| `{{FILE_ROWS}}` | One table row per file, paths relative to the package's `internal/` or `src/` root. New files show `new` and a line count. Changed files show `+added` and `−removed` with a real minus sign. |
| `{{FILE_COUNT}}`, `{{ADDED}}`, `{{REMOVED}}` | Totals across all files including new ones |
| `{{VERIFY_ROWS}}` | One row per verification step. Left cell is the command or check, right cell is the result in plain words. Include a row for anything not run and say why. |
| `{{REVIEW_ITEMS}}` | Three to five numbered items. What a reviewer should actually check, ordered by risk. Always end with the ticket's "Done when" test as the last item. |
| `{{COMMANDS}}` | `cd <worktree> && git diff`, then one `git add ... && git commit -m "..."` per suggested commit, then `fp issue update --status done <id>` |

The lede stays as written unless the ticket was not fully implemented, in which case say what is missing in one sentence.

### 5. Pick the send time

Hold until the next 6:00 AM in Pacific time. If it is already past 6:00 AM today, that means tomorrow.

```bash
TZ=America/Los_Angeles bash -c 'if [ "$(date +%H%M)" -lt 0600 ]; then date "+%Y-%m-%dT06:00:00%z"; else date -v+1d "+%Y-%m-%dT06:00:00%z"; fi' | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/'
```

Pass that ISO string as `scheduledAt`. Never pass natural language like "tomorrow at 6am". Resend resolves it against UTC and can land a day late.

If the user passed `--now`, omit `scheduledAt`.

### 6. Send and verify

Send with the Resend MCP `send-email` tool.

- `to`: `["ayukumar261@gmail.com"]`
- `subject`: `Review ready: <id>`
- `html` and `text` from step 4
- `idempotencyKey`: `ringback-ticket-<id>-<YYYY-MM-DD>`
- `tags`: `[{"name":"project","value":"ringback"},{"name":"kind","value":"review-ready"}]`

Then call `get-email` with the returned id and check two things. Status is `scheduled` (or `delivered` with `--now`). The scheduled timestamp matches the time you computed, shown in UTC. If either is wrong, `cancel-email` and send again.

### 7. Report

Tell the user in a few lines: the worktree path, whether tests passed, when the email will land, and that the ticket is in-progress until they review.

## Rules

- Never run `fp comment`. Status updates are the only ticket writes.
- Never commit, push, or merge. The worktree branch is Ayush's to land.
- One skill run handles one ticket. If given several ids, run them one at a time.
- If the agent reports a failing build or test, still send the email but change the lede to say so and put the failure at the top of the verification table. Do not hide it.
