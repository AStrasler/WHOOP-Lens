# Contributing: cooperative branch workflow

Several AI agents (Codex, Grok WHOOP Lens, Cursor agents) and the owner work in
this repository. Every commit is authored and committed as the repository owner
and is unsigned. **The commit author does not show which AI wrote a change.**
Use PR comments, not git metadata, to establish who did what.

## Roles
- **Codex** is the technical lead and the mandatory reviewer.
- **Implementing agents** investigate, fix issues on branches, test and request review.
- **The owner** approves merges, releases, production settings and member contact.

## Before starting
1. `git fetch origin` and compare the branch head with the PR's latest head.
2. Read the PR's most recent comments. If another agent announced ownership
   and hasn't released the branch, don't push to it. Comment on the PR or open a
   separate branch instead.

## Taking a branch
3. Post `Taking branch <name> (<agent name>)` on the PR before your first push.
4. Make focused commits that name the issue (RB-xxx) and the review finding they address.

## Pushing
5. Immediately before pushing, fetch again and confirm the remote head is still
   the parent of your commit. If it moved, stop, rebase locally, retest and
   re-announce.
6. Never force-push. Never amend or rebase commits already pushed.

## Review and handoff
7. Request `@codex review` on the **final** head only, with a short brief.
   Don't post a request while one is pending for the same head.
8. Reply to each review thread with the fixing commit. Re-request review on the new head.
9. When done, post the final head and `Branch released` on the PR.
10. Missing, pending or skipped CI is not a pass. Don't describe a change as
    Codex-approved without a completed review on that exact head.

## Never without explicit owner approval
Merging, deploying or releasing, and changing production settings, schedules, DNS,
routes, bindings, credentials or data. Also contacting members, and closing or reopening PRs.
