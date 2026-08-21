# Claudapter

> Switch API providers from inside the Claude Code UI — per tab, without touching global settings.
> The project version mirrors the extension version its patch signatures were verified against: **2.1.238**.

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
- **Compact before switching** — on a tab with history the switch first asks *Compact & switch* / *Switch as is*. The prompt cache never survives a provider change, so the first turn on the new backend pays for the whole transcript either way; sending the compact summary instead of the raw history is what makes it cheaper, and it keeps a long conversation inside a smaller window on the other side. It is a question, not a default — compaction discards detail. Left unanswered it switches as is; if the compaction never reports back it switches as is after 90 s. A tab with nothing to compact is never asked.
- **Tab icon per provider** — the extension's own pending/done indicators keep working: the dot is drawn over the provider icon instead of replacing it.
- **Provider icon in the session history** — every past session carries its provider's brand mark, in the history list and in the sessions sidebar. A session with no recorded binding ran on whatever `settings.json` said, so it shows that profile's mark — the stock Claude logo on an untouched install.
- **Pinned sessions** — hover a row in the session history and click the pin: it moves to the top of the list and stays there, above everything else, however old it gets. A search still applies — a pinned row that no longer matches is filtered out like any other, and the ones that do match keep their place at the front. The pins live in `~/.claude/claudapter/pinned.json` and are shared by every tab.
- **Real model names** in the model picker: `Opus (1M context) → deepseek-v4-pro`, `Sonnet → deepseek-reasoner`.
- **Message timestamps** — every turn in the transcript gets a small local time, chat-app style, and a date separator ("Today", "Yesterday", or the date) wherever the day changes. Read straight off each message's own `.jsonl` timestamp, so it reflects when the turn actually happened, not when it rendered.
- **Quote selection** — right-click selected text in the transcript and the quote lands in the composer, blockquoted, ready to type after. A selection inside a code block becomes a fenced block instead.
- **Local spellcheck with correction suggestions** — Russian words are checked locally with Hunspell. Misspellings receive a red wavy underline; right-click one to choose a correction. Only bounded, de-duplicated words leave the webview, and no draft text is sent over the network.
- **Model and effort chip** — a small read-only chip in the composer's toolbar row, left of the mode picker: the model and reasoning effort this session is actually running (`Opus · xhigh`, or `· ultracode` when ultracode is selected). It reads the session's live signals, not `settings.json` — that file only holds the global defaults and would name the wrong chat.
- **Send an image with no text** — attaching a file to an empty composer writes a short prompt into it (`Analyse the image in the context of this conversation`, agreeing with what is actually attached), which is what makes the send button light up. It is a normal draft: edit it, replace it, or just press Enter. The wording follows `language` from `/config`; to reword a language, edit its row in `LANGUAGES` in [src/host.js](src/host.js).
- **Non-Anthropic providers** through a bundled protocol adapter: OpenAI, OpenRouter, Groq, Together, Ollama — and the ChatGPT Plus/Pro subscription.

## Requirements

- Node.js ≥ 18 (no dependencies — nothing to `npm install`)
- The `anthropic.claude-code` extension installed (verified against **2.1.238**; the signatures also match 2.1.220–2.1.235)
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

**Sending one subagent to another provider.** A session is bound to one upstream by its profile, but a subagent can override that per-request through its `model:` field, which the proxy reads before routing:

```markdown
---
name: my-codex-agent
model: "@codex"                 # route to the codex upstream, default (sonnet) model
# or
model: "@deepseek:claude-opus-4-8"   # route to deepseek, resolve that model by deepseek's rules
---
```

The `@<upstream>` name must be a key in the proxy's `upstreams` (the same names as the URL path segments); an unknown one 404s. The `<model>` after the colon is resolved by the target profile's `ANTHROPIC_DEFAULT_*` / `modelOverrides` rules, or passed through untouched when it is not a `claude-*` id.

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

## Delegating a task to another provider

A session is bound to one provider for its whole life, and a subagent cannot change that: its frontmatter has no `env` and no endpoint field, so it always inherits the parent's `ANTHROPIC_BASE_URL` and credentials. The one place a provider can still change is where a process is born — the same lever this project already pulls per tab.

`src/mcp/agent-server.mjs` is a stdio MCP server that does exactly that for a delegated task: it spawns `claude -p` with the environment of a profile from `~/.claude/profiles` and returns the answer as a tool result.

```bash
npm run setup          # copies the server into ~/.claude/claudapter/mcp
npm run mcp:install    # registers it with Claude Code at user scope
npm run mcp:status     # what is registered
npm run mcp:remove     # unregister
```

Then, in any tab: *"ask deepseek to review this file"* — Claude calls `run_agent` with `profile: "deepseek"`, and the run goes out on DeepSeek's endpoint and key while the tab stays where it was.

Two tools are exposed:

- **`list_profiles`** — every profile, its endpoint, and the model each family alias maps to.
- **`run_agent`** — `profile` and `prompt` are required; `agent`, `model`, `effort`, `mode`, `cwd` and `timeout_ms` are optional.

Notes worth knowing before relying on it:

- **The delegated agent shares no context** with the calling session — the prompt has to carry every fact it needs. It reads files itself, so paths are usually enough.
- **`mode` defaults to `read`** (Read, Grep, Glob, WebFetch, WebSearch). `write` auto-accepts file edits, `full` bypasses permission checks — the provider on the other end is not the one you are watching, so the default stays read-only.
- **`model` defaults to the `sonnet` alias**, which each profile maps through its own `ANTHROPIC_DEFAULT_SONNET_MODEL`. A literal id is sent to the provider untouched.
- **Credentials never cross.** The calling session's `ANTHROPIC_*` variables are stripped before the profile's own are applied — including for the subscription profile, whose empty `env` would otherwise inherit whatever the caller was using.
- **Delegation depth is capped at 2**, so an agent can delegate once and no further.
- **A refusing provider is reported, not waited out.** An exhausted balance or a spent quota comes back as `429`, which the CLI treats as retryable and backs off on until the timeout kills the task — fifteen minutes to learn nothing. One `max_tokens: 1` call goes out first, and a refusal is returned in the provider's own words in about a second (*"Insufficient balance. Please recharge."*, *"Your token-plan 1-week quota has been exhausted"*). A probe that times out or cannot connect never blocks the run — it proves nothing the real attempt will not find out itself. Set `CLAUDAPTER_SKIP_PREFLIGHT=1` to turn it off.
- The run is recorded in `bindings.json`, so it carries its provider's icon in the session history like any tab.

## How it works

The logic lives **outside** the extension, in `~/.claude/claudapter`. Only eight short calls are injected into the bundle, so editing the UI needs no re-patching — a window reload is enough.

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
| 4 | `webview/index.js` | *structural* — the three reads before `registerAction({id:"model"` | their command registry, jsx factory **and the session object** |
| 5 | `webview/index.js` | `["model","effort-level",…]` | ordering of the *Model* section |
| 6 | `webview/index.js` | *structural* — the session list's `[query,setQuery]=ne(""),[renaming,…]=ne(null),refs=ge(new Map)` | two more state pairs — content-search results and pinned ids — and hands both setters over |
| 7 | `webview/index.js` | *structural* — the title/branch filter expression that follows it | ORs in a content match, sorts pinned rows to the front, and exposes the unfiltered row list globally |
| 8 | `webview/index.js` | `onChange:(e)=>J(e.target.value),placeholder:"Search sessions…"` | forwards every keystroke to the host-side transcript search |

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

### Resuming after an error, limit, or interrupt

When the model stops mid-run — an error banner, a hard usage limit, a request-level failure, or the
user pressing Stop — the conversation halts and the only way forward is to type "continue" by hand.
Claudapter injects that prompt automatically when the composer is empty and one of those halt states
is visible:

```js
[class*="banner_"][data-color="error"]                        // error banner (a 429 rate limit lands here too)
[class*="interruptedMessage_"]                                // user interrupt
[class*="banner_"][data-color="warning"] matching "You've hit your"  // subscription limit hit
newest assistant turn whose text begins "API Error:"          // request-level failure (no banner)
```

The `data-color="warning"` banner carries two different notices, so wording is the discriminator:
"*You've hit your* session/weekly limit · resets …" is a hard block and gets the prompt, while
"*Approaching* …" and "*You've used N% of* …" mean the run is still healthy and are left alone. The
notice is hardcoded English in the bundle, so the text match holds in every `/config` language.

A request-level failure — `API Error: Request rejected (429) · upstream 429: {…usage_limit_reached…}` —
arrives as an ordinary assistant turn whose text is the error, not as a banner, so the banner selector
never sees it. Claudapter reads the newest turn from the transcript and matches its leading
`API Error:`, a prefix the CLI itself hardcodes in English. Once a later message follows, the failure
is a past event rather than a state to resume, so the prompt is not injected.

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
*Quote selection* and *Copy* appear only when something is selected; *Retract last message* always does.

This is the project's only dependency on VS Code rather than on the extension, so it is on the
re-verification list: `resources/app/out/vs/workbench/contrib/webview/browser/pre/index.html`. If that
early-return ever goes away the failure is two menus at once, not a loud error.

### Local spellcheck and correction menu

The composer has a local Russian spellchecker backed by Hunspell. VS Code starts its Electron webviews with native Chromium spellchecking disabled, so Claudapter checks the words without changing the React-owned composer DOM:

1. the webview extracts only unique Russian words from the current draft;
2. the extension host checks them with the local `hunspell -a` process and the configured dictionary;
3. misspellings are drawn with the CSS Custom Highlight API;
4. right-clicking an underlined word opens up to five Hunspell suggestions;
5. choosing a suggestion replaces only that word through the composer's normal `input` path.

The feature is disabled unless `spellcheck.enabled` is explicitly `true` in `~/.claude/settings.json`:

```json
{
    "spellcheck": {
        "enabled": true,
        "checker": "hunspell",
        "language": "ru_RU"
    }
}
```

Install Hunspell and the `ru_RU` dictionary separately. On Windows, the runtime looks first for `hunspell.exe` in `%LOCALAPPDATA%\\Microsoft\\WinGet\\Links` and otherwise falls back to `PATH`. Checking is local-only: the full draft is never sent to a network service or written to the debug log. If Hunspell is unavailable or times out, spellcheck fails closed and normal composer input remains unchanged.

### Model and effort chip

The composer's toolbar row ends with the submit button, and the mode picker ("Auto") is the node right
before it, so the chip is inserted before that sibling — in the same flex row, left of "Auto", where it
cannot overlap the history or new-chat buttons. React owns the row, so the existing MutationObserver
re-inserts the chip after any commit that drops it.

The values are the session object's live signals: `modelSelection`, falling back to `lastServedModel`
and `currentMainLoopModel` for the model; `effortLevel` and `ultracodeEnabled` for the effort side.
`settings.json` is deliberately not consulted — its `model` is a global default, and showing it is
exactly the "not this chat" complaint. The `[1m]` context suffix is stripped before the family alias
lookup, so `opus[1m]` renders as `Opus`, and an ultracode selection replaces the effort level in the
label.

### Taking back the last message

The stock *Rewind to…* picker restores a file checkpoint, **forks** the conversation and puts the text
back in the composer to edit. Claudapter replaces that with a **retract** that keeps the session: the
erroneous message and the assistant's answer to it are hidden from the transcript, the text is pulled
back into the composer to correct and re-send, and the agent is told — under the hood, in a user turn
that is itself hidden — that the message was a mistake and should be ignored. The turns stay in the
transcript (the agent keeps the context); only the view drops them.

The gesture is **Ctrl+Shift+Z**, and *Retract last message* in the right-click menu. Retracting:

1. hides the last user message and whatever the agent answered to it;
2. puts that message's text back into the composer, so it can be corrected and re-sent;
3. sends the agent a hidden English instruction — *«<message>» was a mistake, ignore it and your
   response to it* — and hides that turn **and** the assistant's answer to it, so no retract machinery
   ever shows in the chat;
4. the answer you see next is the agent's response to your corrected message.

The hidden uuids are persisted per session in `~/.claude/claudapter/hidden-messages.json`, so a resume
re-hides them, and content search skips them. Retracting while a turn is still running interrupts it
first (the same stop the button and Escape trigger), waits for the partial response to settle, then
retracts — so a message can be taken back the moment the answer starts going wrong.

Two costs worth knowing. Ctrl+Shift+Z is **redo** inside the composer, and that is what it gives up;
Ctrl+Z is untouched. And recalling the text alone needs none of this — **↑** in an empty composer
already cycles your previous messages, without touching the conversation.

### Searching sessions by content

The stock search box in the session list only matches a row's title and git branch, both already
computed client-side. A query that names something you actually *said* usually is not either, so this
adds a second, lazy pass: once the title/branch filter comes up short (or a query is simply typed),
the ids currently on screen are sent to the extension host, which greps each one's `.jsonl` transcript
on disk and reports back which ones actually contain it — no JSON parsing, the query sits in the
encoded message text either way. The two passes merge: a row shows up if it matches on title, branch,
**or** content.

It stays out of the hot path deliberately. Typing is debounced 250ms before anything is sent, every
new keystroke clears the previous result immediately so a stale match never lingers under a new query,
and each session's transcript text is cached on disk mtime so re-searching an unchanged session costs
nothing. Only the **Local** tab is covered — remote/cloud sessions have no on-disk transcript to grep.

### Pinning a session to the top

The list is ordered by the app, by recency, and re-derived from scratch on every render — so a pin
cannot be a DOM move: the next commit would undo it. It is a **sort**, applied at the same place
injection point #7 already sits, on the list the app is about to render. That list is also the one it
builds its keyboard-navigation index from, so arrow keys keep agreeing with what is on screen, and
the order survives every re-render because it *is* part of the render.

Search and pinning compose in the only way that makes sense: the sort runs on whatever survived the
filter. With an empty query that is every session, so the pins sit at the very top; with a query it is
the matching ones, so a pinned session that does not match is not shown — a pin is a position, not an
exemption.

Ordering has to reach the component as state or nothing re-renders when a pin is toggled, which is why
injection point #6 declares a state pair for it and hands the setter to the page. The page stays the
owner of the value — the host's `pinned.json` is the record, every tab is told about a change, and the
row moves optimistically on the click rather than a round trip later. The control itself is a real
child node appended to the row (a pseudo-element could not be clicked), restored by the same observer
pass that draws the provider icons if a commit ever moves it.

A detailed teardown of the extension is in [docs/internals.md](docs/internals.md).

### Choosing the profile at launch

`envFor(baseEnv, resumeSessionId)` in `host.js`:

1. `pendingProfile` — the tab's profile, captured by intercepting `launch_claude` right before the spawn;
2. the binding for `sessionId` from `bindings.json`;
3. otherwise the environment is left alone (whatever `settings.json` says).

Keys "owned" by profiles are computed as the union of every `env` across `~/.claude/profiles/*.json`, and they are wiped on every switch so no leftovers from the previous provider leak through.

### Storage

- `~/.claude/claudapter/bindings.json` — `{ sessionId: profileName }`, survives VS Code restarts. It is also what the history list reads to mark each row; a session that was never launched through Claudapter has no entry and falls back to the profile matching `settings.json`.
- `~/.claude/claudapter/pinned.json` — the session ids pinned to the top of the history list, in the order they were pinned. Shared by every tab; an entry is dropped when its session is deleted.
- the tab's profile in memory — for the window between choosing a provider and the session being created
- `~/.claude/settings.json` is **never modified**

## After a Claude Code update

VS Code installs the new version into a separate folder, so the patch is gone. Re-run `node scripts/install.mjs` and reload the window. If the signatures changed in the new bundle, the patcher stops with an explicit error naming the mismatch instead of corrupting anything.

`scripts/apply-patch.mjs` warns when the installed extension version differs from the one in `package.json`, but it is only a warning — a signature that still matches is still applied. The minified locals are the fragile part, so most points match the *shape* of the code around them rather than the names; only #1 and #5 are anchored to string literals that survive minification unchanged.

### Version branches

`main` always tracks the newest extension version the signatures were verified against. Every supported version also has its own `v<version>` branch pointing at the last commit that works with it, so an older extension stays usable — check out the branch that matches your install:

| Branch | Extension | What the minifier called the locals |
|---|---|---|
| `main` | 2.1.238 — newest | `h.env=y;`, `light:s,dark:s` |
| `v2.1.238` | 2.1.238 | `h.env=y;`, `light:s,dark:s` |
| `v2.1.235` | 2.1.235 | `f.env=v;`, `light:s,dark:s` |
| `v2.1.234` | 2.1.234 | `f.env=v;`, `light:s,dark:s` |
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

One commit can serve several versions, and each branch differs from `main` only by its version stamp — the code is the same because injection points #2 and #3 match the *shape* of the assignment rather than the names in it. Both structural signatures are re-checked against every bundle still on disk at update time. VS Code garbage-collects retired extension folders, so the older ones eventually stop being verifiable locally — 2.1.220 through 2.1.226 were gone by the 2.1.228 update, and by 2.1.233 the sweep was 2.1.227 through 2.1.233 — at the 2.1.238 update only 2.1.235 and 2.1.238 were still there. Their branches stay pinned to the commit that was verified against them.

Renames alone have never cost **these two** a signature change — but they have cost others. 2.1.238 renamed the session list's `useRef` alias (`ge` → `_e`), which was the one hook alias injection point #6 still hardcoded, and that signature stopped matching until it was captured like the rest. 2.1.227 is the other kind of break — it dropped the bundled-node fallback, which deleted the `if(…)` wrapper around #3 and left the assignment ending in `;` instead of `,<nodePath>)`. The signature now captures that terminator and echoes it back verbatim, so one pattern still covers every release in the table.

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
- **Pinning inside session groups.** When the list is showing groups, the app renders every group before the ungrouped rows and pinning cannot cross that boundary — a pinned session rises to the top of its own section, not above the groups. Ungrouped lists, which is what the panel shows until groups are created, put pins at the very top.
