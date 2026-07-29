# Disclaimer

Read this before installing.

## What Claudapter does to your machine

It modifies files of the **installed** `anthropic.claude-code` extension in your VS Code
extensions directory: five short call sites are inserted into `extension.js` and
`webview/index.js`. Originals are backed up as `*.ccx-orig` and restored by
`npm run revert`.

Claudapter does **not** modify, bundle or redistribute any part of the Claude Code
extension or the Claude Code CLI. This repository contains only its own source code.

## Terms of use

The Claude Code extension is proprietary software — `© Anthropic PBC. All rights
reserved. Use is subject to the Legal Agreements outlined here:
https://code.claude.com/docs/en/legal-and-compliance` — and its terms generally
prohibit modification and reverse engineering. Patching an installed copy is at odds
with them.

Routing Claude Code through third-party providers, and in particular using a ChatGPT
subscription through the Codex OAuth client, may violate the terms of those services
as well. The subscription mode sends traffic to OpenAI's infrastructure using the
official Codex CLI client id from third-party software; that is the highest-risk part
of this project and the one most likely to affect an account.

**You are responsible for deciding whether your use complies with the agreements you
accepted.** The authors provide no warranty and accept no liability. Nothing here is
legal advice.

## What is not included

- No part of the Claude Code bundle, patched or otherwise.
- No provider logos or trademarks. `npm run favicons` downloads icons from provider
  sites to your machine at install time; those assets belong to their owners and are
  never committed here.
- No API keys or tokens. Credentials stay in `~/.claude/profiles/*.json` and
  `~/.claude/claudapter/chatgpt-auth.json` on your machine.

## Compatibility

Patch signatures are verified against the extension version stated in `package.json`.
On a different version the patcher reports which signature no longer matches and
stops without touching the files.
