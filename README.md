# Claudapter

> Switch API providers from inside the Claude Code UI — per tab, without touching global settings.
> The project version mirrors the extension version its patch signatures were verified against: **2.1.233**.

**Claude Code for VS Code** can switch *models* within one provider, but not the provider itself. Changing it means editing `~/.claude/settings.json` by hand, and the change is global for every session.

Claudapter moves that switch into the UI and makes it **per tab**: one tab can run on Anthropic, another on DeepSeek, a third on your ChatGPT subscription.

## Screenshots

| | |
|---|---|
| ![Command menu — "Switch provider…" entry](images/2.jpg) | ![Profile picker with provider list](images/3.jpg) |
| *"Switch provider…" appears as the first entry in the Model section of the command menu* | *Each profile from `~/.claude/profiles/` is listed with its actual upstream model* |
| ![Switched to deepseek — tab icon, badge, model label](images/4.jpg) | ![Running on DeepSeek V4 Pro](images/1.jpg) |
| *The active profile name appears in the badge; the model picker shows the real upstream model* | *Same tab — answer from DeepSeek V4 Pro, 1M context* |

| |
|---|
| ![Session history, each row marked with its provider icon](images/5.jpg) |
| *The session history: every past session carries the icon of the provider it actually ran on. A session with no recorded provider falls back to whatever `settings.json` points at.* |

## What you get

- **"Switch provider…"** — the first entry in the *Model* section of the command menu, showing the active profile.
- **Profile picker** — reads `~/.claude/profiles/*.json` and lists each profile with its model.
- **Per-tab switching** — the `claude` process restarts on the same channel with `resume`, so the conversation history survives. Other tabs are untouched. On a tab that has not sent anything yet there is nothing to resume, so it starts fresh instead — the toast says which.
- **Tab icon per provider** — the extension's own pending/done indicators keep working: the dot is drawn over the provider icon instead of replacing it.
- **Provider icon in the session history** — every past session carries its provider's brand mark, in the history list and in the sessions sidebar. A session with no recorded binding ran on whatever `settings.json` said, so it shows that profile's mark — the stock Claude logo on an untouched install.
- **Real model names** in the model picker: `Opus (1M context) → deepseek-v4-pro`, `Sonnet → deepseek-reasoner`.
- **Quote selection** — right-click selected text in the transcript and the quote lands in the composer, blockquoted, ready to type after. A selection inside a code block becomes a fenced block instead.
- **Send an image with no text** — attaching a file to an empty composer writes a short prompt into it (`Analyse the image in the context of this conversation`, agreeing with what is actually attached), which is what makes the send button light up. It is a normal draft: edit it, replace it, or just press Enter. The wording follows `language` from `/config`; to reword a language, edit its row in `LANGUAGES` in [src/host.js](src/host.js).
- **Non-Anthropic providers** through a bundled protocol adapter: OpenAI, OpenRouter, Groq, Together, Ollama — and the ChatGPT Plus/Pro subscription.

## Requirements

- Node.js ≥ 18 (no dependencies — nothing to `npm install`)
- The `anthropic.claude-code` extension installed (verified against **2.1.233**; the signatures also match 2.1.220–2.1.232)
- Profiles in `~/.claude/profiles/*.json`:

```json
{
    "env": {
        "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "sk-...",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-reasoner",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-chat"
    }
}
```

A profile with an empty `env` (for example `claude.json`) means the Anthropic subscription.

## Install

```bash
node scripts/install.mjs
```

It copies the runtime into `~/.claude/claudapter`, patches the installed extension and drops template profiles. Then run **Developer: Reload Window** in VS Code.

| Command | Action |
|---|---|
| `npm run setup` | install runtime + apply patch |
| `npm run status` | show whether the files are patched |
| `npm run revert` | restore the extension from backup |
| `npm run apply` | patch only (runtime already installed) |
| `npm test` | adapter tests, both protocol modes |

The patch is always applied on top of the `*.ccx-orig` backup, so re-running it is idempotent.

## Profile icons

An icon lives **next to its profile and shares its name**:

```
~/.claude/profiles/
├── deepseek.json
├── deepseek.png     ← icon for this profile
├── glm.json
└── glm.svg
```

Resolution order:

1. `<profile>.png` or `<profile>.svg` next to the profile;
2. empty `env` (Anthropic subscription) without an icon — the stock Claude logo;
3. otherwise a generated badge: a circle with the first letter, colour derived from the name.

No icons ship with this repository. To fetch provider favicons based on each profile's `ANTHROPIC_BASE_URL`:

```bash
npm run favicons     # writes <profile>.png|svg straight into ~/.claude/profiles
```

Whatever fails to download simply falls back to the generated badge.

The last step of that chain downscales every PNG to 32 px on the long side (`npm run icons:shrink` on its own). Icons are inlined into the webview as base64 and render at 13 px, so a 640×640 favicon would otherwise carry about 1,600× the pixels it ever shows — on the profiles here this cut the inlined payload from 62 KB to 25 KB. A file that cannot be decoded is left exactly as it was.

## OpenAI and the ChatGPT subscription

Claude Code speaks only the Anthropic Messages API — the CLI has no OpenAI support at all (verified against the bundle: neither `chat/completions` nor `OPENAI_API_KEY` appears anywhere). So the project ships a local adapter in `src/proxy` that translates protocols and runs in two modes:

| Mode | Protocol | What you pay with | Upstream in the profile |
|---|---|---|---|
| **A. API key** | Chat Completions | per token | `/openai`, `/openrouter`, `/groq`, `/together`, `/ollama` |
| **B. ChatGPT subscription** | Responses API | Plus/Pro subscription | `/codex` |
| A+. OpenAI key over Responses | Responses API | per token | `/openai-responses` |

The adapter starts itself when such a profile is selected: the host sees `127.0.0.1` in `ANTHROPIC_BASE_URL` and spawns it if the port is closed. To run it manually: `npm run proxy`.

### Mode A: your own key

`npm run setup` drops a template at `~/.claude/profiles/openai.json` — put your key into `ANTHROPIC_AUTH_TOKEN` and set the models. The key travels in the request header from the CLI and is forwarded upstream, so there is nowhere else to store it.

For other providers just change the path segment: `http://127.0.0.1:8787/openrouter`, `/groq`, `/ollama`. The list and addresses live in `src/proxy/server.mjs` (`DEFAULTS.upstreams`) and can be overridden by `~/.claude/claudapter/proxy.json`.

### Mode B: ChatGPT subscription

```bash
npm run login:chatgpt     # OAuth PKCE: browser → localhost:1455 → tokens
npm run auth:status       # check the session and its expiry
```

Tokens are stored in `~/.claude/claudapter/chatgpt-auth.json` and refreshed automatically. If the Codex CLI is already installed and signed in, this step is unnecessary — the adapter picks up `~/.codex/auth.json`.

The template profile is `codex.json`. Requests go to `https://chatgpt.com/backend-api/codex/responses` with `Authorization: Bearer` and `chatgpt-account-id`.

**Limitations of mode B** — inherent to any such bridge, not to this implementation: Anthropic server-side tools are not proxied, hidden reasoning does not become thinking blocks, the available models depend on the account, and the opus/sonnet/haiku slots are mapped by hand in the profile. The Codex backend always streams and accepts only its own `instructions`, so the Claude Code system prompt is moved into the first input message.

**Keeping the agent loop running.** Two consequences of that last point cost the agent its persistence, and both are handled in `translate-responses.mjs`:

- the harness prompt ends up at the far end of a growing input as an ordinary user turn, outweighed by everything after it — so a short restatement of the agent rules is appended next to the live turn whenever the request carries tools (a title or classifier request, which has none, gets nothing extra);
- the model plans inside reasoning items that the visible answer never carries, and `store: false` leaves the backend no copy — so the proxy keeps them itself, keyed by the `call_id`s of the response they came with, asks for them back with `include: ["reasoning.encrypted_content"]`, and replays them ahead of the items they produced. A backend that refuses the replay gets one retry without it.

Without either, the model answers conversationally and ends its turn by announcing a step instead of taking it.

### Corporate proxies and geo-blocking

Node does **not** read `HTTP_PROXY` on its own — it needs the `--use-env-proxy` flag (already wired into the `login:chatgpt`, `proxy` and `diag` scripts). Without it the request goes direct and OpenAI answers `403 unsupported_country_region_territory`.

The adapter that VS Code starts automatically reads its variables from the `env` section of `~/.claude/claudapter/proxy.json` (see `templates/proxy.example.json`):

```json
{ "env": { "HTTPS_PROXY": "http://user:pass@host:3128", "NODE_EXTRA_CA_CERTS": "/path/to/corp-ca.cer" } }
```

`NODE_EXTRA_CA_CERTS` is required when the proxy re-signs TLS.

The reverse direction matters too: the `claude` process inherits `HTTP_PROXY` from VS Code and would route even `127.0.0.1` through the corporate proxy. Claudapter therefore injects `NO_PROXY=127.0.0.1,localhost` whenever the upstream is local — otherwise the CLI reports `API error: Connection error`.

`proxy.json` **overrides** the environment, it does not fall back to it — `host.js` spawns the adapter
with `{...process.env, ...proxy.json.env}`, so an entry there wins over whatever the shell or VS Code
had. A stale host or port in that file therefore breaks the adapter while every other tool on the
machine still works, and the CLI reports it only as `502 upstream unreachable: fetch failed`.

Route diagnostics in one command:

```bash
npm run diag     # probes sign-in and the adapter upstream over the adapter's own route
```

It reports the effective values, marks the ones `proxy.json` shadowed, and re-execs itself with that
environment before probing — `--use-env-proxy` reads the proxy variables once at startup, so testing
the adapter's route from a shell that has different ones would otherwise give a false all-clear.

`400 Missing parameter` = the route works; `403 unsupported_country` = the request bypassed the proxy.

If `~/.claude/claudapter/proxy.log` shows `error 403 upstream 403: <html>`, the adapter was started before `proxy.json` existed and is going out directly. Kill the process listening on that port; VS Code will start a new one with the variables applied.

## How it works

The logic lives **outside** the extension, in `~/.claude/claudapter`. Only five short calls are injected into the bundle, so editing the UI needs no re-patching — a window reload is enough.

```
VS Code extension host                     webview (UI)
┌──────────────────────────┐               ┌─────────────────────────┐
│ extension.js (patched)   │               │ index.js (patched)      │
│  ├─ getHtmlForWebview ───┼── inline ────▶│  webview.js             │
│  ├─ setupPanel           │               │   ├─ menu entry         │
│  ├─ spawnClaude: env ◀───┼── profile ────┤   ├─ profile picker     │
│  └─ onDidReceiveMessage ◀┼── ccx:apply ──┤   ├─ model labels       │
│         host.js          │               │   └─ history row icons  │
│  bindings.json (session → profile)       └─────────────────────────┘
└──────────────────────────┘
```

### Injection points

| # | File | Anchor | Purpose |
|---|---|---|---|
| 1 | `extension.js` | `<script nonce="${u}" src="${a}" type="module">` | inline `webview.js` with their nonce + the `ccx:*` channel |
| 2 | `extension.js` | `…iconPath={light:…,dark:…},….webview.options=` in `setupPanel` | intercept the tab icon |
| 3 | `extension.js` | `…pathToClaudeCodeExecutable=…,…env=…` + its terminator, in `spawnClaude` | **substitute `ANTHROPIC_*` when the process starts** |
| 4 | `webview/index.js` | `n.commandRegistry.registerAction({id:"model"` | access their command registry and jsx factory |
| 5 | `webview/index.js` | `["model","effort-level",…]` | ordering of the *Model* section |

### Sending an attachment on its own

Claude Code will not send a file without text. Submit opens with

```js
let je = te.current?.textContent?.trim() || "";
if (!je) return;
```

and the send button is `disabled: !busy && !canSendMessage`, where `canSendMessage` is `!!v.trim()`.
A disabled button emits no click at all, so there is nothing to intercept — the only way through is
to make the text non-empty, which satisfies their own rule and lights the button up.

So the draft is written when the attachment appears, not when the user tries to send: that way what
will be sent is visible and editable beforehand. It is only written into an *empty* composer, and it
is not written again until the last attachment is removed — otherwise clearing the draft by hand
would immediately get it back, which is the feature arguing with the user.

The wording follows `language` in `~/.claude/settings.json` — what `/config` writes — so the draft is
in the language the answer will be in. All twenty languages the CLI resolves are covered, in every
shape it accepts the setting (`russian`, `русский`, `ru`, `ru-RU`); anything else falls back to
English, exactly as the CLI does. It also follows what is attached: *image* or *attachment*, singular
or plural.

`host.js` resolves the setting and sends the four finished sentences over `ccx:state`, so a `/config`
change repaints them without a reload — `settings.json` is already watched. To reword a language,
edit its row in `LANGUAGES` in `src/host.js`; the copy in `src/webview.js` is only the fallback for a
host too old to send the field.

### Resuming after an error or interrupt

When the model stops mid-run — an error banner or the user pressing Stop — the conversation halts and
the only way forward is to type "continue" by hand. Claudapter injects that prompt automatically when
the composer is empty and one of those halt states is visible:

```js
[class*="banner_"][data-color="error"]        // error banner (a 429 rate limit lands here too)
[class*="interruptedMessage_"]                // user interrupt
```

Deliberately absent: the `data-color="warning"` banner. That one is "you are *approaching* a limit"
while the run is healthy, so filling the composer there would inject into a live conversation rather
than resume a halted one.

The prompt follows `language` from `/config` (20 languages, same as the attachment prompt). It
resets when the terminal state clears, so the next error gets a fresh prompt.

### The context menu

The Cut/Copy/Paste menu over a webview is VS Code's own, and the only supported way to add to it is a
`menus."webview/context"` contribution in the *extension's* manifest. Editing an installed extension's
package.json is not an option — the scanned manifest is cached against the mtime of `extensions.json`,
so the edit is either ignored or trips VS Code's "Extensions have been modified on disk" error.

The page can pre-empt the menu instead. VS Code's webview preload leads its own handler with
`if (e.defaultPrevented) return;`, so calling `preventDefault()` means its menu is never requested.
Claudapter does that only for a right-click inside the transcript and draws its own menu there;
everywhere else — the composer included — the stock menu is untouched, which is what matters, because
the composer is where Paste means something. Over a transcript the stock entries are inert anyway.
Because the suppression takes the stock **Copy** with it, the replacement menu carries Copy itself.
*Quote selection* and *Copy* appear only when something is selected; *Rewind…* always does.

This is the project's only dependency on VS Code rather than on the extension, so it is on the
re-verification list: `resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html`. If that
early-return ever goes away the failure is two menus at once, not a loud error.

### Taking back the last message

The extension already has all of this, and claudapter adds no part of it. Its *Rewind to…* picker
lists your own messages newest first with the last one selected, and confirming restores the file
checkpoint, forks the conversation at that message and puts its text back in the composer to edit:

```js
C = await session.rewindCode(uuid)                          // files
app.forkConversation(sessionId, promptText, resumeAtMessageId)  // history, and the text to edit
```

What it lacked was a way in — the action lives in the command menu under *Context*. So claudapter
adds the gesture only: **Ctrl+Shift+Z**, and *Rewind…* in the right-click menu. Both call
`registry.executeCommand('rewind')` on the command registry the provider chip is already registered
against, so no new signature is involved and their confirmation dialog — including the summary of
which files a rewind would touch — is still the thing that decides.

Two costs worth knowing. Ctrl+Shift+Z is **redo** inside the composer, and that is what it gives up;
Ctrl+Z is untouched. And the action id `rewind` is their code, not ours: if it is renamed, the menu
item disappears and the key goes back to redo, which `npm run apply` reports as a NOTE rather than
letting it pass unnoticed.

Recalling the text alone needs none of this — **↑** in an empty composer already cycles your previous
messages, without touching the conversation.

A detailed teardown of the extension is in [docs/internals.md](docs/internals.md).

### Choosing the profile at launch

`envFor(baseEnv, resumeSessionId)` in `host.js`:

1. `pendingProfile` — the tab's profile, captured by intercepting `launch_claude` right before the spawn;
2. the binding for `sessionId` from `bindings.json`;
3. otherwise the environment is left alone (whatever `settings.json` says).

Keys "owned" by profiles are computed as the union of every `env` across `~/.claude/profiles/*.json`, and they are wiped on every switch so no leftovers from the previous provider leak through.

### Storage

- `~/.claude/claudapter/bindings.json` — `{ sessionId: profileName }`, survives VS Code restarts. It is also what the history list reads to mark each row; a session that was never launched through Claudapter has no entry and falls back to the profile matching `settings.json`.
- the tab's profile in memory — for the window between choosing a provider and the session being created
- `~/.claude/settings.json` is **never modified**

## After a Claude Code update

VS Code installs the new version into a separate folder, so the patch is gone. Re-run `node scripts/install.mjs` and reload the window. If the signatures changed in the new bundle, the patcher stops with an explicit error naming the mismatch instead of corrupting anything.

`scripts/apply-patch.mjs` warns when the installed extension version differs from the one in `package.json`, but it is only a warning — a signature that still matches is still applied. The minified locals are the fragile part, so injection point #3 matches the *shape* of the assignment rather than the names; the other four are anchored to string literals that survive minification.

### Version branches

`main` always tracks the newest extension version the signatures were verified against. Every supported version also has its own `v<version>` branch pointing at the last commit that works with it, so an older extension stays usable — check out the branch that matches your install:

| Branch | Extension | What the minifier called the locals |
|---|---|---|
| `main` | 2.1.233 — newest | `f.env=v;`, `light:s,dark:s` |
| `v2.1.233` | 2.1.233 | `f.env=v;`, `light:s,dark:s` |
| `v2.1.232` | 2.1.232 | `f.env=v;`, `light:s,dark:s` |
| `v2.1.231` | 2.1.231 | `f.env=v;`, `light:s,dark:s` |
| `v2.1.229` | 2.1.229 | `f.env=v;`, `light:s,dark:s` |
| `v2.1.228` | 2.1.228 | `f.env=v;`, `light:s,dark:s` |
| `v2.1.227` | 2.1.227 | `f.env=b;`, `light:s,dark:s` |
| `v2.1.226` | 2.1.226 | `f.env=x,g)`, `light:s,dark:s` |
| `v2.1.224` | 2.1.224 | `f.env=b,g)`, `light:a,dark:a` |
| `v2.1.223` | 2.1.223 | `f.env=x,_)`, `light:a,dark:a` |
| `v2.1.222` | 2.1.222 | `f.env=x,_)`, `light:a,dark:a` |
| `v2.1.221` | 2.1.221 | `f.env=x,_)`, `light:a,dark:a` |
| `v2.1.220` | 2.1.220 | `f.env=w,g)`, `light:a,dark:a` |

One commit can serve several versions, and each branch differs from `main` only by its version stamp — the code is the same because injection points #2 and #3 match the *shape* of the assignment rather than the names in it. Both structural signatures are re-checked against every bundle still on disk at update time. VS Code garbage-collects retired extension folders, so the older ones eventually stop being verifiable locally — 2.1.220 through 2.1.226 were gone by the 2.1.228 update, and by 2.1.233 the sweep was 2.1.227 through 2.1.233. Their branches stay pinned to the commit that was verified against them.

Renames alone have never cost a signature change. 2.1.227 did, though — it dropped the bundled-node fallback, which deleted the `if(…)` wrapper around #3 and left the assignment ending in `;` instead of `,<nodePath>)`. The signature now captures that terminator and echoes it back verbatim, so one pattern still covers every release in the table.

When adapting to a new release: verify the signatures against it, bump `package.json`, this README and [docs/internals.md](docs/internals.md) on `main`, then tag the result with a fresh `v<version>` branch.

## Diagnostics

`~/.claude/claudapter/debug.log` records `launch_claude`, `ccx:apply` and `envFor` (profile, session, `ANTHROPIC_BASE_URL`).

To confirm a provider really took effect, look at **Output → Claude VSCode**: the spawn logs `ccx: spawning with profile "…"`, and the CLI itself prints the `ANTHROPIC_BASE_URL` it resolved.

## Known limitations

- **This modifies a proprietary bundle.** The extension is `© Anthropic PBC, All rights reserved`; patching the installed files is at odds with its terms. Everything is reversible via `npm run revert`, but distributing a patched bundle is not an option — see [DISCLAIMER.md](DISCLAIMER.md).
- **Switching providers requires a process restart.** `env` is fixed when `claude` spawns, so the switch restarts the channel (with `resume`, so history is kept).
- **Log noise.** The extension logs `Unknown message: [object Object]` for every `ccx:*` message — its handler does not know these types. Harmless.
- **Model entry names** come from the CLI's own catalog and cannot be renamed, so real model names are appended as a separate label.
- **Session binding** appears only after the first response in a session — before that the id does not exist yet.
