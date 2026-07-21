---
name: github
description: Work with GitHub repositories, issues, pull requests, checks, branches, worktrees, commits, and pushes.
---

# GitHub work

Use `git` for repository operations and `gh` for GitHub issues, pull requests, checks, and HTTPS
credentials. Before pushing, verify `gh auth status`; if Git authentication is not configured, run
`gh auth setup-git`. Never put a token in a remote URL or output.

Repo handling:

- Use `/workspace` as the working root.
- Reuse an existing checkout when it matches the requested repo.
- Clone missing repos under `/workspace/{repo}`.
- Inspect repository files locally. Use `gh issue view` or `gh pr view` for GitHub context; use web
  search only when the checkout and GitHub CLI cannot provide the needed information.
- For pull-request work, keep the canonical checkout as the base and create a dedicated branch and
  worktree before editing.
- Do not overwrite unrelated dirty changes.
- Remember durable repo location/default-branch facts when useful.

For PR work:

- Inspect the issue or PR before editing.
- Treat requests to create, open, post, submit, or prepare a PR as requests to complete the full
  workflow: branch and worktree, edit, validate, commit, push, and `gh pr create`.
- Stop at a local commit only when the user explicitly asks for local or PR-ready changes without
  pushing, or when authentication or permissions block publication.
- Commit only relevant files.
- Verify the pushed branch and include the pull-request URL and validation results in the final
  message.
