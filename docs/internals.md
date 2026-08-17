# Inside Claude Code for VS Code

A teardown of version **2.1.233** (`anthropic.claude-code-2.1.233-win32-x64`). Everything below comes from the bundle itself: line numbers refer to a formatted `extension.js` (`prettier 3.x --parser babel`, 143,324 lines), signatures to the minified original. Minified identifiers are renamed on nearly every release — they are quoted to make a spot findable, not as stable names.

## Package contents

| File | Size | What it is |
|---|---:|---|
| `resources/native-binary/claude.exe` | 304 MB | the CLI itself — bun standalone + Authenticode |
| `webview/index.js` | 4.7 MB | UI: React 18.3.1, marked, parts of monaco |
| `extension.js` | 2.7 MB | the extension host (bun bundle) |
| `webview/index.css` | 378 KB | UI styles |
| `resources/audio-capture/*/audio-capture.node` | 498 KB | native module for dictation |

## Two activation paths

`activate()` (`thr`, line 142918) brings up two independent things:

1. **Native UI** — the webview/session manager (class `rZ`, line 139511): providers `claudeVSCodeSidebar`, `…SidebarSecondary`, `claudeVSCodeSessionsList`, the `claudeVSCodePanel` panel, 23 contributed commands, a status bar item, and the `_claude_vscode_fs_left/right/readonly` FS providers used for diffs.
2. **IDE MCP server** (tool registration `zNe`, line 142549; listener `BNe`, line 142827 — lines 142549–142861) — what a terminal-launched CLI talks to: HTTP+WebSocket on `127.0.0.1`, authorization via the `x-claude-code-ide-authorization` header (a random UUID), a lock file and the `CLAUDE_CODE_SSE_PORT` handoff.

MCP server tools: `openDiff`, `getDiagnostics`, `close_tab`, `closeAllDiffTabs`, `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `saveDocument`, `executeCode` (Jupyter). Notifications: `diagnostics_changed`, `log_event`.

## How Claude is launched

The extension embeds **Claude Agent SDK 0.3.232** (the same version published on npm as `@anthropic-ai/claude-agent-sdk`) and calls `query()` with a transport pointing at `claude.exe`:

```
--output-format stream-json --verbose --input-format stream-json
```

`spawnClaude` (line 138141, in class `fs` at line 137881) assembles the options:

- `systemPrompt: { type: "preset", preset: "claude_code", append: … }`
- `settingSources: ["user", "project", "local"]`
- `enableFileCheckpointing: true`
- hooks: `PreToolUse` — `Edit|Write|MultiEdit` (baseline snapshot) and `Edit|Write|Read` (autosave); `PostToolUse` — diagnostics collection
- `extraArgs: { debug, debug-to-stderr, enable-auth-status, no-chrome, replay-user-messages }`
- env: `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, `MCP_CONNECTION_NONBLOCKING=true`, `CLAUDE_CODE_ENABLE_TASKS=0`

The environment comes from `Dm()` (line 139477): `process.env` plus the `claudeCode.environmentVariables` setting. **It is frozen at spawn time** — a provider cannot be swapped inside a live process, the channel has to restart.

The assignment, minified, is injection point #3 (line 138215 formatted):

```js
f.pathToClaudeCodeExecutable=m,f.executableArgs=g,f.env=v;
```

Every identifier there is a minified local, and the minifier reshuffles them release to release — six spellings across eleven releases:

| Release | Assignment | Terminator |
|---|---|---|
| 2.1.220 | `f.env=w,g)` | `,<nodePath>)` |
| 2.1.221–2.1.223 | `f.env=x,_)` | `,<nodePath>)` |
| 2.1.224 | `f.env=b,g)` | `,<nodePath>)` |
| 2.1.226 | `f.env=x,g)` | `,<nodePath>)` |
| 2.1.227 | `f.env=b;` | `;` |
| 2.1.228 | `f.env=v;` | `;` |
| 2.1.229 | `f.env=v;` | `;` |
| 2.1.231–2.1.233 | `f.env=v;` | `;` |

2.1.227 is the one that changed the **shape**, not just the names. Up to 2.1.226 the three assignments were the condition of an `if`, with the node path as the last operand of the comma expression:

```js
if(f.pathToClaudeCodeExecutable=m,f.executableArgs=h,f.env=x,g)f.executable=g;
```

`resolveClaudeBinary()` used to fall back to `resources/claude-code/cli.js` run under `process.execPath`, and `nodePath` carried that interpreter. 2.1.227 dropped the fallback — the returned object is now just `{pathToClaudeCodeExecutable, executableArgs, env}` — and the whole `if(…)` wrapper went with it, leaving a bare comma-expression statement. Corroborating counts, 2.1.226 → 2.1.227: `nodePath` 3 → 1, `f.executable=` 1 → 0, `process.execPath` 2 → 0, `"cli.js"` 1 → 0. No behavioural loss on a Windows install: neither version ships `resources/claude-code/`, so that branch never fired.

A literal signature breaks on almost every update, and a structural one that assumes the `if` breaks here. Capturing the terminator whole and re-emitting it verbatim covers both shapes:

```js
/(\w+)\.pathToClaudeCodeExecutable=(\w+),\1\.executableArgs=(\w+),\1\.env=(\w+)(,\w+\)|;)/
```

One match in every release from 2.1.220 to 2.1.227. The terminator must stay *inside* the capture and be echoed unchanged — a character class like `[,;]` would match all seven too, but re-emitting only `;` would swallow the `g)` on the older bundles and produce an unbalanced `if(`.

The back-reference pins all three assignments to the same options object, and the resume session id is read back off that object (`resume:t` in the literal) rather than from the `spawnClaude` parameter, which is renamed just as often.

## The webview ↔ host protocol

Request/response with a `channelId`; dispatch lives in `processRequest` on the base class `lL` (line 127031, `processRequest` at 128070) with roughly 90 message types, and the session class `fs` overrides it (line 138069) for the handful it handles itself. The host sends `{type:"from-extension", message}` to the UI; the process stream arrives as `{type:"io_message", channelId, message, done}`.

Messages from the webview that matter to a patcher:

| Message | Carries | Used for |
|---|---|---|
| `launch_claude` | `channelId, cwd, resume, permissionMode, thinkingLevel` | intercepted right before the spawn to inject the profile |
| `close_channel` | `channelId` | clean process shutdown before a restart |
| `request.update_session_state` | `sessionId, state, title` | a **weak** hint of the tab's session — see below |
| `request.rename_tab` | `title, hasPendingPermissions, hasUnseenCompletion` | overwrites the tab title and icon |

### Two sources of the session id, and only one is safe to resume

The id a tab is *really* on is announced by the CLI itself: `system/init` in the `io_message` stream carries `session_id`, and `host.js` reads it by wrapping `webview.postMessage`. That is the **strong** source: the CLI has written that session, so it can be bound to a profile and handed back as `--resume`.

`update_session_state` also carries a `sessionId`, and it arrives earlier — but it is a **weak** source, for two reasons. It is emitted once more for the session that just *stopped* being active, so it can name a neighbouring tab. And on a tab that has not sent anything yet the page already holds a provisional id per channel: the CLI has written nothing under it, and resuming it is answered with `No conversation found with session ID …`. That was a real failure (2.1.233, five phantom `codex` bindings in `bindings.json`, all born this way): the host already refused to *bind* on a weak id, but it still echoed it in `ccx:state`, the page adopted it as `state.sessionId`, and `ccx:apply` handed it straight back as the id to resume.

So a weak id is kept on the host only — it still resolves the profile and the models — and never travels to the page: `stateFor` sends `sessionId: null` while `__ccxSessionWeak` is set, and `restartChannel` in the page resumes only from what the channel itself announced or was launched with, never from `state.sessionId`. A switch on a tab with nothing said in it therefore restarts **fresh** (the toast says so), and the first `system/init` binds the real session to the profile that was chosen. Nothing is lost, because there was nothing to keep.

**And even the strong source is early.** `system/init` proves the CLI *minted* the id, not that it *wrote* it: the transcript `<projects>/<slug>/<sessionId>.jsonl` appears on the first user turn. A session that is launched and dies before anyone types leaves an announced id and no file — and the extension's own `launchClaude()` passes `this.sessionId.value` on every relaunch of that tab, so from then on every restart repeats `--resume=<id>` → "No conversation found". Seven ids in the log had been launched that way (five of them from the weak path above, two from this one). Neither signal can decide this; the disk can. So `envFor` gets the options object as a third argument (injection point #3 now reads `envFor(env, opts.resume, opts)`) and clears `opts.resume` unless the transcript exists — the SDK builds `--resume=${w}` from that field after the assignment has run, so the spawn simply starts fresh. The check scans every project folder, because the id is unique and the slug is not ours to reconstruct.

## Traps found while patching

### `rename_tab` overwrites the icon

The handler (line 138094) **unconditionally** rewrites both title and icon:

```js
this.panelTab.title = e.request.title;
let r;
if (e.request.hasPendingPermissions) r = "claude-logo-pending.svg";
else if (e.request.hasUnseenCompletion) r = "claude-logo-done.svg";
else r = "claude-logo.svg";
this.panelTab.iconPath = ge.Uri.file(On.join(this.context.extensionPath, "resources", r));
```

It fires on every title change, so an icon set once gets wiped. The fix is to intercept the `iconPath` setter on the panel object and substitute all three stock logos — letting `claude-logo-done.svg` through would replace the provider icon with the stock one the moment a message arrives.

The two indicator variants are just the logo with a hole punched in the corner and a dot dropped into it (`cx=19.5 cy=4.5`, hole `r=6.5`, dot `r=4.5`, `#D97757` for done and `#3B82F6` for pending). The hook repeats that geometry over the profile icon and caches the result in `~/.claude/claudapter/icons/badged/<profile>-<state>.svg`, so the brand and the indicator both survive. The profile icon is embedded as a `data:` URI rather than referenced by path: a tab icon is painted as a CSS background, and an SVG in that mode may not load external resources.

The state the extension last asked for is remembered on the panel (`__ccxIconState`), because `decorate()` also repaints the icon on profile changes and would otherwise reset the indicator.

The hook is installed at the first `iconPath` assignment in `setupPanel` (line 139865) — injection point #2. It carries the same minified-name problem as #3, and 2.1.226 is where it bit: `light:a,dark:a` became `light:s,dark:s` and the literal signature stopped matching. The structural form anchors on the shape and on the `.webview.options=` that always follows, which is also what keeps the panel variable available — the injected call needs that one name:

```js
/(\w+)\.iconPath=\{light:(\w+),dark:\2\},(\1\.webview\.options=)/
```

### An existing session's panel cannot be reopened

`createPanel` (line 139803):

```js
createPanel(e, t, r) {
    if (e) {                              // e = sessionId
        let a = this.sessionPanels.get(e);
        if (a) {
            if ((a.reveal(), t))          // t = a prompt to seed — silently dropped
                It.window.showInformationMessage(
                    "Session is already open. Your prompt was not applied — enter it manually.",
                );
            return { startedInNewColumn: !1 };   // does NOT create a new panel
        }
    }
```

So `claude-vscode.editor.open` with a live `sessionId` only reveals the existing panel, and any prompt handed to it is dropped with a notice. The panel's `onDidDispose` (line 139941) does drop the entry from `sessionPanels`, so a *closed* session reopens cleanly — but there is no path that gives you a second panel on a session that is still open. The working approach for a provider switch is to restart the channel, not the panel.

### Channel shutdown is asynchronous

`close_channel` does not complete instantly: roughly 0.5 s pass between "Closing Claude on channel" and the channel actually being freed. Sending `launch_claude` on a timer before that returns `Channel already exists`, after which the host finishes killing the channel and the tab is left without a process (`Channel not found for io_message`). The trigger must be the **incoming** `close_channel`, not a timeout.

### Two host-kind lists, and only one of them matters

The CLI layers `~/.claude/settings.json`'s `env` block over the spawn environment and only filters
provider keys for hosts it treats as managed. That gate is `bIc` in the CLI bundle:

```js
bIc = new Set(["claude-desktop", "claude-desktop-3p", "local-agent"]);
function rj() { let e = J.CLAUDE_CODE_ENTRYPOINT; return e !== void 0 && bIc.has(e) }
```

`claude-vscode` is not in it, so nothing is filtered for the VS Code spawn and whatever sits in that
`env` block silently outranks the per-tab profile. `host.js` warns about that on a switch rather than
editing the user's file.

The trap is that the bundle keeps growing *other* entrypoint sets, and three of them now do contain
`claude-vscode`. By 2.1.229 there are four in total, and only the first is the settings filter:

| Set | Members | What it actually gates |
|---|---|---|
| `BLc` (`bIc` in 2.1.228) | desktop, desktop-3p, local-agent | **the settings.json env filter** — no `claude-vscode` |
| `nRs` (`xFa` in 2.1.228) | desktop, local-agent, vscode | delegating OAuth token refresh to the host |
| `AsS` — new in 2.1.229 | vscode, desktop, desktop-3p | deletes `CLAUDE_CODE_ENTRYPOINT` from a child env |
| `t1_` — new in 2.1.229 | vscode | whether disabled models are listed in the picker |

`AsS` is the dangerous lookalike: same three-member shape as `BLc`, two members in common, and it
does include `claude-vscode`. It is a different function entirely. Resolve these by their *use site*,
never by membership — grepping for `claude-desktop` and eyeballing the arrays gives the opposite
answer. Through 2.1.229 the settings filter is still `BLc`, consulted via `wj()`, and still excludes
`claude-vscode`, so the warning stands.

### The CLI does not remap `claude-fable-5` (2.1.232, still in 2.1.233)

Fable shipped as a model but not as a *family* in the two places the CLI remaps a requested model onto
the `ANTHROPIC_DEFAULT_*_MODEL` env vars. In `resources/native-binary/claude.exe`:

```js
function t5p(e){let t=Vw(e)?.family,
  r={opus:X.ANTHROPIC_DEFAULT_OPUS_MODEL,sonnet:X.ANTHROPIC_DEFAULT_SONNET_MODEL,haiku:X.ANTHROPIC_DEFAULT_HAIKU_MODEL},
  n=t!==void 0&&Object.hasOwn(r,t)?r[t]:void 0; …}
function Rci(e){if(e.startsWith("sonnet"))return"sonnet";if(e.startsWith("opus"))return"opus";if(e.startsWith("haiku"))return"haiku";return}
```

Neither `t5p`'s `r` object nor `Rci`'s prefix match knows `fable`, even though the model exists
elsewhere (`latest_per_family:{fable:"claude-fable-5", …}`). So `claude-opus-5` / `claude-sonnet-5` /
`claude-haiku-4-5` remap everywhere, but `claude-fable-5` only remaps through the adapter's
`profileModelRules` — i.e. only for profiles routed through `127.0.0.1:8787` (codex/openai). Direct
providers (`qwen`, `deepseek`, `glm`, `minimax`) send `claude-fable-5` verbatim and get a 400.

Decision: not worked around — waiting on an upstream fix. Re-check `t5p`/`Rci` in the CLI bundle on
each version bump; the day `fable:` appears in that `r` object, the direct providers recover it for free.

### The session is not reachable from the context object

Injection point #4 used to hand over only the command registry: `onRegistry(n, b)`. That is enough for
the menu entry, but not for anything that has to *talk to the conversation* — `send()`, `messages`,
`busy` and `lastServedModel` all live on the session, which is a different class (`MX`) from the
context object the registry hangs off (`t_e`). Enumerating `t_e` settles it: forty-odd members,
`forkConversation` and `renameTab` among them, and nothing session-shaped at all. So `ctx.activeSession`
— the obvious-looking read — is permanently `undefined`, and anything gated on it silently does nothing.
That is exactly how the compaction offer shipped broken: `canCompact()` returned false every time, so
the switch never asked, and the `lastServedModel` reset was dead on arrival for the same reason.

Both objects are in scope at the registration, so the signature became structural and passes the
session too:

```js
/let (\w+)=(\w+)\.modelSelection\.value,(\w+)=\w+\(\2\.claudeConfig\.value\),(\w+)=\w+\(\1,\2\.lastServedModel\.value,\3\);(\w+)\.commandRegistry\.registerAction\(\{id:"model"/
```

The three reads in front are what pin the capture to the session rather than to whatever else the
minifier happens to call `t`, and the back-references keep all three on one object. One match in
2.1.227–2.1.233, always `session=t, ctx=n`.

A DOM-level test cannot catch a mismatch here on its own — a fake context object carrying an
`activeSession` field passes while the real one has none, which is precisely how this got through the
first time. So the test also reads both sources and asserts that the patcher passes a third argument,
that the hook accepts it, and that the page never reads the session off the context object.

### Compacting before a switch rides on the stock `/compact`

The offer is a two-button toast; *Compact & switch* calls the page's own `session.send("/compact")` — the same thing the command menu's Compact entry does (`nn=()=>{i("/compact")}` in the composer). The CLI answers on the `io_message` stream with `{type:"system", subtype:"compact_boundary", compact_metadata:{trigger, pre_tokens}}`; the page already listens to that stream for `system/init`, so the boundary is the release for the restart. Two guards keep the switch from being held hostage: a boundary on another channel is ignored, and `COMPACT_WAIT_MS` (90 s) restarts uncompacted with a toast if none arrives. `send()` rejecting does the same at once. The offer itself is not asked when there is nothing to compact — no assistant turn yet, or a turn already running (`session.busy`) — and never on a fresh tab, which starts fresh with nothing to resume. `session.busy.value`, `session.messages.value` and `activeSession.value` are read off the app object the registry hook already hands over; none of them is patched.

### The stock model indicator names the last provider that answered

`Switch model… → <model>` in the command menu is the extension's own `modelIndicator`, fed by `session.lastServedModel`. That signal is written in `processMessage` from `e.message.model` on every assistant turn — and `loadFromMessages` runs `processMessage` over the whole transcript while seeding a resume, before the CLI has said a word. So after a provider switch the menu says, truthfully but misleadingly, which model the *old* provider answered with, until the new one answers. The stock reset is in the `system/init` branch and fires only when `session_id` changes, which a `--resume` never does. `performRestart` therefore clears `lastServedModel.value` on every switch, so the menu falls back to the selection.

### Menu ordering

The command registry (`class AX` in `webview/index.js`) sorts each section by a hard-coded id list; unknown ids fall to the end:

```js
if (t === "Model") {
    let r = ["model", "effort-level", "toggle-thinking", "switch-models-on-flag", "account-usage"];
    n.sort((s, a) => { /* indexOf, missing ones → r.length */ });
}
```

So the position of a custom entry is set by adding its id to that array, not by registration order.

### The session history carries no session id

The history row (`webview/index.js`, minified `ELt`, anchor `` className:`${bn.sessionItem}` ``) is a bare
`<button>` whose entire prop object is `{ref, className, onClick, onMouseMove, children}` — no `id`, no
`data-*`, no `title`, no `aria-label`. The session id exists only as the React key at the call site,
`Ue.sessionId.value ?? et`, and React never serialises keys to the DOM. `data-session-id` and
`data-session` have zero occurrences in the whole 4.6 MB bundle.

React writes `__reactFiber$<random>` onto every host node it creates, but that pointer is set at mount
(`createInstance`) and never refreshed — `commitWork` updates only `__reactProps$`. With double buffering,
`el[__reactFiber$…]` is therefore the *stale alternate* on roughly every other commit, so `memoizedProps`
cannot be trusted for scalar props. `createWorkInProgress` does copy `key` onto the alternate, which makes
`fiber.key` the one stale-proof read — and it is exactly the session id.

A non-UUID key is the array-index fallback: the session had no id when it rendered. Those rows are refused
outright, which also removes the only case that could yield a *wrong* session — two index-keyed rows
swapping positions and rebinding a reused fiber pair.

That refusal is what makes the *other* fallback safe. A row whose id resolves but carries no entry in
`bindings.json` ran on whatever `settings.json` said at the time, so it takes the mark of the profile that
matches `settings.json` now — the stock Claude logo on an untouched install. The host computes that once
(`fallbackIcon`) and withholds it entirely when `settings.json` names a base URL no profile describes,
because then the answer is genuinely unknown. The distinction that matters: an id that resolved but has no
binding is a session we can reason about, while an id that did not resolve is a row we cannot attach
anything to without risking the wrong session.

The icon is painted as a `::before` pseudo-element with `background-image:var(--ccx-icon)` rather than an
injected `<img>` child: React reconciles host children by index, and `className` is rewritten on every
`isActive`/`isFocused` change, so a class or a child node of ours would be wiped. `data-*` attributes and
inline `style` are not React-managed on that button and survive. The row is
`display:flex;align-items:center;gap:8px`, so the pseudo-element simply becomes its leading flex item.

The list is reachable at all because `resolveSessionListView` builds the sidebar view through the *same*
`getHtmlForWebview` as the chat panel — the injected script is already present in both surfaces, so this
needed no sixth injection point.

### CSP and loading your own script

`getHtmlForWebview` (line 140039) emits `script-src 'nonce-…'` (line 140070), and `localResourceRoots` is limited to the `webview/` and `resources/` directories inside the extension. An external file cannot be referenced by URI — hence the custom code is inlined into the HTML with their nonce, while the text itself is read from disk when the page is generated (so edits apply without re-patching).

Execution order: their inline flag script → our classic script → their bundle (`type="module"`, deferred). That lets our code call `acquireVsCodeApi()` first and replace the global with a proxy that sees every outgoing message. Unknown types are ignored by the UI — its listener only reacts to `type === "from-extension"`.

The same tag emits `img-src ${e.cspSource} data:`, and that `data:` is the only reason profile icons can be
inlined as base64 at all: `localResourceRoots` covers just `webview/` and `resources/` inside the extension,
so `~/.claude/profiles` can never be referenced by URI. `style-src` carries `'unsafe-inline'`, which is what
lets the injected `<style>` block work without a nonce. `font-src` has **no** `data:`, so an icon-font
strategy is not available. Note also that an SVG loaded through `<img src="data:…">` is an isolated
document: it does not inherit `currentColor` or any VS Code theme variable, and in percent-encoded form a
literal `#` truncates the URL. Brand marks are unaffected — they carry their own colours — but a
theme-coloured glyph would have to be an inline `<svg>` element instead.

## Non-Anthropic providers

The CLI has no OpenAI support: across the whole 24 MB bundle there is neither `chat/completions` nor `OPENAI_API_KEY`; the nine occurrences of `openai` are secret-scanner regexes and skill texts. Only the Anthropic API, Bedrock (`CLAUDE_CODE_USE_BEDROCK`) and Vertex (`CLAUDE_CODE_USE_VERTEX`) are supported — all on top of the Messages API.

The API surface an adapter actually has to cover (by occurrence count in the bundle):

| Surface | Occurrences | Note |
|---|---:|---|
| `v1/messages` | 64 | the main endpoint, SSE |
| `tool_use` | 1226 | without tools the CLI is useless |
| `cache_control` | 85 | strip it: OpenAI caching is implicit |
| `/v1/messages/count_tokens` | 14 | needed for the context indicator |
| `thinking_delta` | 15 | not reproducible across the bridge |

### The ChatGPT subscription protocol

Reverse-engineered from the open source of [claudex](https://github.com/pilc80/claudex) (Rust):

- OAuth PKCE: `client_id = app_EMoamEEZ73f0CkXaXp7hrann`, issuer `https://auth.openai.com`, token endpoint `/oauth/token`, scope `openid profile email offline_access`, `code_challenge_method=S256`, `id_token_add_organizations=true`
- the callback must be exactly `http://localhost:1455/auth/callback`
- backend `https://chatgpt.com/backend-api/codex/responses`, headers `Authorization: Bearer` and `chatgpt-account-id`
- `account_id` is extracted from the `id_token` (claim `https://api.openai.com/auth`)
- existing Codex CLI tokens live in `~/.codex/auth.json` (`tokens.access_token` / `refresh_token` / `account_id`)
- the backend accepts only its own `instructions` and always streams, so the system prompt has to travel as the first `input` message
- `session_id` is what ties a request to a conversation; a fresh uuid per request tells the backend every turn is a new one and invalidates any replayed `reasoning` item, so it is derived from the opening messages instead

### Why the agent used to stop mid-task

Three separate things ended a turn early, all of them invisible in the transcript — no error, a well-formed `end_turn`, and an agent that quietly gave up:

| Cause | What it looked like | Fix |
|---|---|---|
| the harness prompt sits at input position 1 as a user turn, thirty items behind the live one | the model answers conversationally, announcing a step instead of taking it | a restatement of the agent rules appended after the last turn, when the request carries tools |
| reasoning items never come back (`store: false`, nothing to carry them through the CLI's history) | the model re-derives its intent from its own prose each request and drops work it had committed to | `include: ["reasoning.encrypted_content"]` plus a proxy-side store keyed by `call_id`, replayed ahead of the items it produced |
| an SSE that ends without `response.completed` | `finish()` closed it as a normal answer: `stop_reason: end_turn`, no retry | a stream without a terminal event is reported as an error |

The first two are prompt-shaped and degrade gracefully; the third is a protocol bug and was the one that could stop an agent with no trace at all.

### Full authorize parameter set

```
response_type=code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
redirect_uri=http://localhost:1455/auth/callback
scope=openid profile email offline_access
code_challenge=<PKCE S256>
code_challenge_method=S256
id_token_add_organizations=true
codex_cli_simplified_flow=true
originator=<client identifier>
state=<random>
```

The official Codex CLI additionally requests `api.connectors.read api.connectors.invoke` and supports `allowed_workspace_id`. The short scope is enough.

### OAuth and networking traps (each one cost a separate investigation)

**`cmd /c start` splits the URL on `&`.** The classic way to open a browser on Windows breaks any OAuth URL: only the first parameter reaches the browser and OpenAI answers `missing_required_parameter`. Measured against a local server:

| method | parameters delivered |
|---|---|
| `cmd /c start "" <url>` | **1** (`tag`) |
| `cmd /c start "" "<url>"` | request never arrived |
| `rundll32 url.dll,FileProtocolHandler <url>` | **6** — all of them |

A diagnostic trap: the error looks like a missing-parameter problem, which tempts you to "fix" it by adding fields that were already there.

**Node does not read `HTTP_PROXY`.** It needs the `--use-env-proxy` flag (Node 24+). Without it, from a geo-blocked region every OpenAI request returns `403 unsupported_country_region_territory`; with it the same request answers on the merits (`400 Missing parameter 'redirect_uri'`). The flag is required both for the login flow and for the adapter — including the instance the extension spawns.

**`NO_PROXY` for the local upstream.** The `claude` process inherits the proxy variables and tries to reach `127.0.0.1:8787` through the corporate proxy. Measured: `fetch('http://127.0.0.1:8787/health')` with `HTTP_PROXY` set → `fetch failed`; with `NO_PROXY=127.0.0.1,localhost` → `200`. In the CLI log this shows up as `API error (attempt N/11): undefined Connection error`.

**403 HTML instead of JSON** from `chatgpt.com` means the request bypassed the proxy (Cloudflare/geo), not that the body was malformed. Verified: 0, 5 and 30 tools, with and without `User-Agent: codex_cli_rs` and `openai-beta` — every combination returns `200` once the route is correct.

**`process.exit()` with active handles** crashes Node on Windows with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`. Use `process.exitCode` instead.

**A streaming backend does not make every answer a stream.** The codex backend only streams, so the adapter always sends `stream: true` upstream — but the caller's own `stream` flag decides what goes back. Answering `stream: false` with `text/event-stream` is not a protocol error the SDK reports: it sees a non-JSON content type, hands the raw body back as a **string**, and the failure surfaces far away as `TypeError: undefined is not an object (evaluating 'z.usage.input_tokens')`. What breaks is the auto-mode permission classifier, which asks this way — it fails closed, so every `Edit` is denied with "retry guidance" while the main streamed conversation keeps working. Symptom to recognise: the model starts explaining that the environment is temporarily unable to modify files, and `proxy.log` shows no error at all.

### Responses API vs Chat Completions

| | Chat Completions | Responses |
|---|---|---|
| history | `messages[]` | `input[]` with `message` / `function_call` / `function_call_output` items |
| assistant text | `content` | `content: [{type:"output_text"}]` |
| tools | `{type:"function", function:{name,...}}` | flat: `{type:"function", name, parameters}` |
| tool result | `role:"tool"` + `tool_call_id` | `function_call_output` + `call_id` |
| streaming | anonymous chunks with `delta` | named `response.*` events |
| tool arguments | `tool_calls[].function.arguments` deltas | `response.function_call_arguments.delta` |

Both formats collapse into the same Anthropic events: `message_start` → `content_block_start/delta/stop` (`text_delta`, `input_json_delta`) → `message_delta` (`stop_reason`, usage) → `message_stop`.

## Native binary

`claude.exe` is a bun standalone executable (319,026,336 bytes): `/$bunfs/root/` and `B:/~BUN/root/` markers, the `---- Bun! ----` trailer at offset 319,015,421, followed by ~10 KB of Authenticode signature. The CLI's JS bundle sits there **in the clear**: a contiguous UTF-8 region at `283,720,669..310,250,408` (25.30 MB) starting with `// @bun @bytecode @bun-cjs (function(exports, require, module, …)`. Two much smaller bundles of the same shape follow it at `310,250,441` and `310,252,643` — the loaders for `image-processor.node` and `audio-capture.node`.

Offsets move on every release; locating the region by scanning forward from the `// @bun @bytecode @bun-cjs` marker while the bytes stay valid UTF-8 text is what actually survives an update.
