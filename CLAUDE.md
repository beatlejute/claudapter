# Working in this repository

## Branches

Two kinds of branch exist here, and nothing else is kept:

- **`main`** — where the work happens. Commit straight onto it. No feature
  branches, no pull requests, no merge commits; `main` always tracks the newest
  Claude Code version the signatures were verified against.
- **`v<version>`** — one per supported Claude Code release, pointing at the last
  commit that still works with it, so an older extension stays usable. Written
  once when adapting to that release and never developed on. See
  *Version branches* in [README.md](README.md).

Anything else is rubbish: a `feat/…`, a branch named after whatever it was
trying, a leftover from an experiment. Delete it locally and on `origin` as
soon as its commits are in `main`.

Never create a branch to hold ordinary work, and never leave one behind after
merging. Do not offer a pull request — the change goes on `main` and gets
pushed.

Before deleting any branch, check that `main` already contains it
(`git branch --merged main`, and `git branch -d`, never `-D`). A release
branch is kept even when it is *not* merged — that is the whole point of it.
