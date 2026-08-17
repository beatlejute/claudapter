(function () {
    if (window.__ccx) return;

    var api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
    var rawPost = api ? api.postMessage.bind(api) : function () {};

    if (api) {
        var proxy = {
            postMessage: function (m) {
                trackOutgoing(m);
                return rawPost(m);
            },
            getState: api.getState.bind(api),
            setState: api.setState.bind(api),
        };
        window.acquireVsCodeApi = function () { return proxy; };
    }

    var state = { profiles: [], active: null, sessionId: null, bindings: {} };
    var icons = {};
    var fallback = null;
    var registry = null;
    var ctx = null;
    var jsx = null;
    var chip = null;
    var overlay = null;
    var launchByChannel = {};
    var sessionByChannel = {};
    var activeChannelId = null;
    var pendingRestart = null;

    function send(message) {
        rawPost(message);
    }

    function trackOutgoing(m) {
        if (!m || typeof m.type !== 'string') return;
        if (m.type === 'launch_claude') {
            activeChannelId = m.channelId;
            launchByChannel[m.channelId] = {
                channelId: m.channelId,
                cwd: m.cwd,
                resume: m.resume,
                permissionMode: m.permissionMode,
                thinkingLevel: m.thinkingLevel,
            };
            if (m.resume) noteSession(m.channelId, m.resume);
        } else if (m.type === 'io_message' && m.channelId) {
            activeChannelId = m.channelId;
        }
    }

    function noteSession(channelId, sessionId) {
        if (!sessionId) return;
        sessionByChannel[channelId] = sessionId;
        if (channelId === activeChannelId && sessionId !== state.sessionId) {
            state.sessionId = sessionId;
            send({ type: 'ccx:session', sessionId: sessionId });
        }
    }

    function syncAction() {
        if (!registry) return;
        var trailing = jsx && state.active
            ? jsx('span', { className: 'ccx-prov-tag', children: state.active })
            : undefined;
        try {
            registry.registerAction(
                {
                    id: 'ccx-provider',
                    label: 'Switch provider…',
                    description: 'Change API provider profile for this session',
                    trailingComponent: trailing,
                },
                'Model',
                openPicker
            );
        } catch (e) {
            console.warn('ccx: registerAction failed', e);
        }
    }

    function syncChip() {
        if (registry) {
            if (chip) chip.remove();
            chip = null;
            return;
        }
        if (!chip) {
            chip = document.createElement('button');
            chip.className = 'ccx-chip';
            chip.title = 'Claude provider';
            chip.onclick = openPicker;
            document.body.appendChild(chip);
        }
        chip.textContent = '⇄ ' + (state.active || 'subscription');
    }

    function closePicker() {
        if (overlay) overlay.remove();
        overlay = null;
    }

    function openPicker() {
        closePicker();
        overlay = document.createElement('div');
        overlay.className = 'ccx-overlay';
        overlay.onclick = function (e) {
            if (e.target === overlay) closePicker();
        };

        var box = document.createElement('div');
        box.className = 'ccx-box';

        var title = document.createElement('div');
        title.className = 'ccx-title';
        title.textContent = 'API provider';
        box.appendChild(title);

        var hint = document.createElement('div');
        hint.className = 'ccx-hint';
        hint.textContent = state.sessionId ? 'Bound to this session' : 'No active session yet — applies on next launch';
        box.appendChild(hint);

        state.profiles.forEach(function (p) {
            var row = document.createElement('div');
            row.className = 'ccx-row';
            row.onclick = function () {
                send({
                    type: 'ccx:apply',
                    sessionId: sessionByChannel[activeChannelId] || state.sessionId,
                    channelId: activeChannelId,
                    name: p.name,
                });
                closePicker();
            };
            var mark = document.createElement('span');
            mark.className = 'ccx-mark';
            mark.textContent = p.name === state.active ? '●' : '○';
            var name = document.createElement('span');
            name.textContent = p.name;
            var model = document.createElement('span');
            model.className = 'ccx-model';
            model.textContent = p.model || '—';
            row.append(mark, name, model);
            box.appendChild(row);
        });

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var onKey = function (e) {
            if (e.key === 'Escape') {
                closePicker();
                window.removeEventListener('keydown', onKey, true);
            }
        };
        window.addEventListener('keydown', onKey, true);
    }

    window.addEventListener('message', function (e) {
        var d = e.data;
        if (!d || typeof d.type !== 'string') return;

        if (d.type === 'from-extension') {
            var msg = d.message;
            if (!msg) return;
            if (msg.type === 'io_message' && msg.message) {
                var inner = msg.message;
                if (inner.type === 'system' && inner.subtype === 'init' && inner.session_id)
                    noteSession(msg.channelId, inner.session_id);
                if (inner.type === 'system' && inner.subtype === 'compact_boundary')
                    onCompactBoundary(msg.channelId);
            } else if (msg.type === 'close_channel' && pendingRestart && msg.channelId === pendingRestart.channelId) {
                var job = pendingRestart;
                pendingRestart = null;
                clearTimeout(job.timer);
                setTimeout(function () { doLaunch(job); }, 150);
            }
            return;
        }

        if (d.type === 'ccx:state') {
            state = {
                profiles: d.profiles || [],
                active: d.active || null,
                models: d.models || null,
                bindings: d.bindings || {},
                sessionId: d.sessionId || state.sessionId,
            };
            adoptAttachmentPrompts(d.attachmentPrompts);
            syncAction();
            syncChip();
            decorateModelPicker();
            decorateSessionList();
        } else if (d.type === 'ccx:icons') {
            icons = d.icons || {};
            fallback = d.fallback || null;
            decorateSessionList();
        } else if (d.type === 'ccx:applied') {
            if (d.sessionId && !state.sessionId) state.sessionId = d.sessionId;
            restartChannel(d.name);
        }
    });

    var ALIAS_BY_LABEL = [
        { test: /^Default\b/, key: 'opus' },
        { test: /^Opus\b/, key: 'opus' },
        { test: /^Fable\b/, key: 'fable' },
        { test: /^Sonnet\b/, key: 'sonnet' },
        { test: /^Haiku\b/, key: 'haiku' },
    ];

    function decorateModelPicker() {
        if (!state.models) {
            document.querySelectorAll('.ccx-model-tag').forEach(function (n) {
                n.remove();
            });
            return;
        }
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var pending = [];
        var node;
        while ((node = walker.nextNode())) {
            var text = node.nodeValue && node.nodeValue.trim();
            if (!text || text.length > 24) continue;
            for (var i = 0; i < ALIAS_BY_LABEL.length; i++) {
                if (!ALIAS_BY_LABEL[i].test.test(text)) continue;
                var model = state.models[ALIAS_BY_LABEL[i].key];
                if (model) pending.push({ node: node, model: model });
                break;
            }
        }
        pending.forEach(function (item) {
            var host = item.node.parentElement;
            if (!host || host.dataset.ccxModel === item.model) return;
            var old = host.querySelector(':scope > .ccx-model-tag');
            if (old) old.remove();
            var tag = document.createElement('span');
            tag.className = 'ccx-model-tag';
            tag.textContent = item.model;
            host.appendChild(tag);
            host.dataset.ccxModel = item.model;
        });
    }

    // The session id is nowhere in the DOM: the history row is a bare <button> whose entire prop object
    // is {ref, className, onClick, onMouseMove, children}, and the id exists only as the React key at the
    // call site. React writes __reactFiber$<random> onto every host node it creates, but that pointer is
    // set at mount and never refreshed — with double buffering it is the stale alternate about every other
    // commit, so memoizedProps cannot be trusted. createWorkInProgress does copy `key` onto the alternate,
    // which makes fiber.key the one stale-proof read — and it is exactly the session id.
    var CCX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    var fiberKey = null;

    function fiberKeyOf(node) {
        if (fiberKey && fiberKey in node) return fiberKey;
        var names = Object.keys(node);
        for (var i = 0; i < names.length; i++) {
            if (names[i].indexOf('__reactFiber$') === 0) {
                fiberKey = names[i];
                return fiberKey;
            }
        }
        return null;
    }

    // The session's own fields are signals — read through .value
    function signalValue(v) {
        try {
            return v && typeof v === 'object' && 'value' in v ? v.value : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // Two independent reads of the same value. A non-UUID key means the parent fell back to the array
    // index (the session had no id when it rendered), and a disagreement means the fiber is stale or
    // re-keyed — both give up, because a wrong provider icon is worse than none.
    function sessionIdOfRow(row) {
        var key = fiberKeyOf(row);
        var fiber = key ? row[key] : null;
        if (!fiber) return null;
        var fromKey = null;
        var fromProps = null;
        for (var d = 0; fiber && d < 4; d++, fiber = fiber.return) {
            if (!fromKey && typeof fiber.key === 'string' && CCX_UUID.test(fiber.key)) fromKey = fiber.key;
            if (!fromProps) {
                var session = fiber.memoizedProps && fiber.memoizedProps.session;
                var id = session && signalValue(session.sessionId);
                if (typeof id === 'string' && CCX_UUID.test(id)) fromProps = id;
            }
            if (fromKey && fromProps) break;
        }
        if (!fromKey) return null;
        if (fromProps && fromProps !== fromKey) return null;
        return fromKey;
    }

    function applyRowIcon(row) {
        var id = null;
        try {
            id = sessionIdOfRow(row);
        } catch (e) {
            id = null;
        }
        var name = (id && state.bindings && state.bindings[id]) || null;
        var uri = (name && icons[name]) || null;
        // A resolved session with no binding of its own ran on whatever settings.json said, so it takes
        // the host's fallback mark. An UNRESOLVED row takes nothing: guessing there could put a provider
        // on the wrong session, and a wrong icon is worse than none.
        var assumed = false;
        if (id && !uri && fallback && fallback.uri) {
            name = fallback.name;
            uri = fallback.uri;
            assumed = true;
        }
        var stamp = uri ? id + '|' + name + (assumed ? '|~' : '') : '';
        if (row.dataset.ccxRow === stamp) return;
        row.dataset.ccxRow = stamp;
        if (!uri) {
            row.removeAttribute('data-ccx-provider');
            row.style.removeProperty('--ccx-icon');
            row.removeAttribute('title');
            return;
        }
        // data-* and inline style survive React's commits; className does not — it is rewritten on every
        // isActive/isFocused change, so the icon must not hang off a class of ours
        row.setAttribute('data-ccx-provider', name);
        row.style.setProperty('--ccx-icon', 'url("' + uri + '")');
        row.title = 'Provider: ' + name + (assumed ? ' (default — not recorded for this session)' : '');
    }

    function decorateSessionList() {
        try {
            // The _<hash> suffix is a CSS-module content hash — match by prefix, never literally
            var rows = document.querySelectorAll('button[class*="sessionItem_"]');
            for (var i = 0; i < rows.length; i++) applyRowIcon(rows[i]);
        } catch (e) {
            /* an unrecognised list is a list without icons, not a broken webview */
        }
    }

    function watchPicker() {
        var timer = null;
        new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                decorateModelPicker();
                decorateSessionList();
                syncAttachmentPrompt();
                syncResumePrompt();
            }, 60);
        }).observe(document.body, { childList: true, subtree: true });
    }

    function toast(message) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        bar.textContent = message;
        document.body.appendChild(bar);
        setTimeout(function () { bar.remove(); }, 6000);
    }

    // --- Quote selection ---------------------------------------------------------------------
    //
    // VS Code draws the webview's Cut/Copy/Paste menu itself, and an extension can only add to it by
    // contributing `menus."webview/context"` in the extension manifest. Patching an installed
    // extension's package.json is not viable: the scanned manifest is cached against the mtime of
    // extensions.json, so the edit either does nothing or trips the "Extensions have been modified
    // on disk" error. What the page *can* do is pre-empt the menu entirely — VS Code's webview
    // preload leads its own handler with `if (e.defaultPrevented) return;`, so calling
    // preventDefault() means its menu is never even requested. That is the whole mechanism.
    //
    // It is used as narrowly as possible: only on a right-click inside a non-empty transcript
    // selection. Everywhere else the stock menu is left alone, so Cut/Copy/Paste in the composer
    // and everything outside the transcript keep working untouched.

    var menu = null;
    var selectionSnapshot = null;

    // The composer's own glyphs are transparent (`color:#0000`) — what the user reads is a sibling
    // mirror element React renders from state. Writing to the DOM without going through their input
    // path therefore produces text that is not stale but *invisible*, so every insert below is an
    // execCommand that fires their `oninput`.
    function composerEl() {
        return document.querySelector('[role="textbox"][aria-label="Message input"]');
    }

    // While a permission request is pending the app sets `display:none` on the composer's container.
    // execCommand refuses to edit a hidden contenteditable and returns false, so the item must not be
    // offered at all in that state — inserting "successfully" into an invisible box is worse.
    function composerReady() {
        var el = composerEl();
        return el && el.offsetParent !== null ? el : null;
    }

    function fencedLanguage(node) {
        var pre = node && node.nodeType === 1 ? node : node && node.parentElement;
        pre = pre && pre.closest ? pre.closest('pre') : null;
        if (!pre) return null;
        var code = pre.querySelector('code');
        var m = code && /(?:^|\s)language-([\w+-]+)/.exec(code.className || '');
        return { lang: m ? m[1] : '' };
    }

    // Selected transcript text is rendered output, not the original markdown — links and emphasis are
    // already flattened by the time it reaches us, and there is no reliable way back to the source.
    // Quoting what the user actually sees is the honest reading of "quote selection". Code is the one
    // case worth special-handling: a selection sitting inside a <pre> becomes a fence, because
    // blockquoting code destroys it.
    function quoteText(sel) {
        var text = sel.toString().replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        if (!text) return '';

        var fence = fencedLanguage(sel.anchorNode);
        if (fence && fencedLanguage(sel.focusNode)) {
            return '```' + fence.lang + '\n' + text + '\n```';
        }
        return text
            .split('\n')
            .map(function (line) {
                var trimmed = line.replace(/\s+$/, '');
                return trimmed ? '> ' + trimmed : '>';
            })
            .join('\n');
    }

    // One execCommand per line, with insertLineBreak between them. A single insertText carrying the
    // newlines is what the app itself uses for @-mentions, but it splits a multi-line payload into
    // <div> blocks and mangles the text; line-at-a-time lands it verbatim.
    function insertIntoComposer(el, text, trailingBreak) {
        el.focus();
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            if (i && !document.execCommand('insertLineBreak')) return false;
            if (lines[i] && !document.execCommand('insertText', false, lines[i])) return false;
        }
        // A trailing break would leave the caret before it rather than after, so the blank line the
        // user needs is inserted as the separator for whatever they type next.
        return trailingBreak === false ? true : document.execCommand('insertLineBreak');
    }

    // --- Attachment with no text ---------------------------------------------------------------
    //
    // An image alone cannot be sent. Submit starts with `let je = te.current?.textContent?.trim()||"";
    // if(!je) return;`, and the send button is `disabled: !busy && !canSendMessage` where
    // canSendMessage is `!!v.trim()` — so with an empty composer the button is genuinely disabled and
    // does not even emit a click. Intercepting the send is therefore impossible; the only way through
    // is to make the text non-empty, which is what enables their button by their own rule.
    //
    // The draft is written the moment the attachment appears rather than at submit time, so the user
    // sees exactly what will be sent and can edit or replace it before pressing Enter.

    // The wording follows the language from /config. host.js resolves ~/.claude/settings.json into
    // these four finished sentences and ships them in ccx:state, so this side only has to decide which
    // of them fits what is attached — and a /config change repaints them without a reload.
    //
    // These English defaults are what stays in place if a host that predates the field is loaded, and
    // are also what an unrecognised language resolves to. To reword any language, edit LANGUAGES in
    // host.js; this table is only the fallback.
    var ATTACHMENT_PROMPTS = {
        image: 'Analyse the image in the context of this conversation',
        images: 'Analyse the images in the context of this conversation',
        attachment: 'Analyse the attachment in the context of this conversation',
        attachments: 'Analyse the attachments in the context of this conversation',
    };

    // All or nothing: a half-filled table would mean one attachment count silently drops to English
    // while the rest are translated, which reads as a bug in the wording rather than in the message.
    function adoptAttachmentPrompts(next) {
        if (!next) return;
        var keys = ['image', 'images', 'attachment', 'attachments'];
        for (var i = 0; i < keys.length; i++) if (typeof next[keys[i]] !== 'string' || !next[keys[i]]) return;
        ATTACHMENT_PROMPTS = next;
        // The resume prompt rides on the same payload.
        if (typeof next.resume === 'string' && next.resume) RESUME_PROMPT = next.resume;
    }

    var promptedForAttachments = false;

    function attachmentChips() {
        var box = document.querySelector('[class*="attachedFilesContainer_"]');
        // Every chip carries its own remove button; counting those is steadier than counting children,
        // which would also pick up whatever wrapper the app decides to add around them.
        return box ? Array.prototype.slice.call(box.querySelectorAll('button[title="Remove attachment"]')) : [];
    }

    // A chip renders the thumbnail as an <img> only when the file is an image; a document gets an icon
    // component instead. That is the difference the wording needs.
    function attachmentNoun(chips) {
        var box = document.querySelector('[class*="attachedFilesContainer_"]');
        var images = box ? box.querySelectorAll('img[class*="thumbIcon_"]').length : 0;
        if (images === chips.length) return chips.length > 1 ? 'images' : 'image';
        return chips.length > 1 ? 'attachments' : 'attachment';
    }

    function syncAttachmentPrompt() {
        try {
            var chips = attachmentChips();
            if (!chips.length) {
                // Reset only when the last attachment is gone, so clearing the draft by hand does not
                // immediately get it written back — that would be the feature fighting the user.
                promptedForAttachments = false;
                return;
            }
            if (promptedForAttachments) return;

            var el = composerReady();
            if (!el || el.textContent.trim()) return;

            promptedForAttachments = true;
            insertIntoComposer(el, ATTACHMENT_PROMPTS[attachmentNoun(chips)], false);
        } catch (err) {
            console.warn('ccx: attachment prompt failed', err);
        }
    }

    // --- Resume after terminal state --------------------------------------------------------------
    //
    // When the model hits an error or the user interrupts, the conversation stops and the only way
    // forward is to type "continue" by hand. This injects that prompt automatically when the composer
    // is empty and one of those halt states is visible in the transcript.
    //
    // Two states, distinguished by their markup:
    //   - Error banner:      [class*="banner_"][data-color="error"]
    //   - Interrupt message: [class*="interruptedMessage_"]
    //
    // The prompt is injected once per terminal state. It resets when the state clears (the user sends
    // a message and the banner disappears), so the next terminal gets a fresh prompt.

    var RESUME_PROMPT = 'Continue from where you stopped';
    var promptedForResume = false;
    var lastResumeState = null;

    // An interrupt marker is transcript history: it stays in the DOM long after the conversation has
    // moved on, so its presence alone does not mean anything is halted NOW. It is a live halt only
    // while nothing renders after it — the moment an answer or a newer message follows, that
    // interrupt is a past event being displayed, not a state to resume.
    function interruptIsCurrent() {
        var halts = document.querySelectorAll('[class*="interruptedMessage_"]');
        if (!halts.length) return false;
        var halt = halts[halts.length - 1];
        if (halt.offsetParent === null) return false;
        var messages = document.querySelectorAll(
            '[data-testid="assistant-message"], [class*="userMessageContainer_"]',
        );
        if (!messages.length) return true;
        // querySelectorAll returns document order, so the last entry is the newest message. The halt
        // marker renders inside its own user-message container, so "inside the newest message" and
        // "nothing follows it" both mean the same thing: the halt is the end of the transcript.
        var last = messages[messages.length - 1];
        return last.contains(halt) || !(halt.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING);
    }

    // Check for the two halt states worth resuming: a real error (the 429 that hits a limit is an
    // error, so it lands here too) and a trailing user interrupt. Deliberately NOT the warning
    // banner — that one shows "you are approaching a limit" while the run is perfectly healthy, so
    // filling the composer there would read as the prompt interrupting a live conversation rather
    // than resuming a halted one.
    function detectTerminalState() {
        var errorBanner = document.querySelector('[class*="banner_"][data-color="error"]');
        if (errorBanner && errorBanner.offsetParent !== null) return 'error';
        if (interruptIsCurrent()) return 'interrupt';
        return null;
    }

    // The send button swaps its icon between send and stop: stopIcon_ only renders while the model is
    // generating. That is the difference between "the user just sent the prompt and the answer is on
    // its way" and "the run actually halted and is waiting" — the interrupt message stays in the
    // transcript either way, so it cannot tell them apart on its own.
    function modelBusy() {
        var stop = document.querySelector('[class*="stopIcon_"]');
        return Boolean(stop && stop.offsetParent !== null);
    }

    function syncResumePrompt() {
        try {
            var state = detectTerminalState();
            // While the model is generating there is nothing to resume — the run is in progress, not
            // halted. This also clears the flag from the last halt, so the next halt gets a prompt.
            if (!state || modelBusy()) {
                promptedForResume = false;
                lastResumeState = null;
                return;
            }

            // Idle and halted. Don't re-inject for the same halt, but do inject if the state changed
            // (e.g., the error cleared, then the user interrupted).
            if (promptedForResume && lastResumeState === state) return;

            var el = composerReady();
            if (!el || el.textContent.trim()) return;

            insertIntoComposer(el, RESUME_PROMPT, false);
            promptedForResume = true;
            lastResumeState = state;
        } catch (err) {
            console.warn('ccx: resume prompt failed', err);
        }
    }

    function closeMenu() {
        if (menu) menu.remove();
        menu = null;
        window.removeEventListener('keydown', onMenuKey, true);
        window.removeEventListener('scroll', closeMenu, true);
        window.removeEventListener('blur', closeMenu, true);
        document.removeEventListener('mousedown', onMenuOutside, true);
    }

    function onMenuKey(e) {
        if (e.key === 'Escape') closeMenu();
    }

    function onMenuOutside(e) {
        if (menu && !menu.contains(e.target)) closeMenu();
    }

    function menuItem(label, run) {
        var row = document.createElement('div');
        row.className = 'ccx-menu-item';
        row.textContent = label;
        row.onclick = function () {
            closeMenu();
            run();
        };
        return row;
    }

    function menuSeparator() {
        var row = document.createElement('div');
        row.className = 'ccx-menu-sep';
        return row;
    }

    function openMenu(x, y, items) {
        closeMenu();
        menu = document.createElement('div');
        menu.className = 'ccx-menu';
        // Without this the mousedown collapses the selection before the click handler reads it, and
        // the highlight disappears from under the menu while it is open.
        menu.onmousedown = function (e) { e.preventDefault(); };
        items.forEach(function (item) { menu.appendChild(item); });

        // Measure before showing, or the box paints once at the origin on its way to the cursor.
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        var w = menu.offsetWidth;
        var h = menu.offsetHeight;
        menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
        menu.style.visibility = '';

        window.addEventListener('keydown', onMenuKey, true);
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('blur', closeMenu, true);
        document.addEventListener('mousedown', onMenuOutside, true);
    }

    // --- Rewind ---------------------------------------------------------------------------------
    //
    // The app already does all of this. Its "Rewind to…" picker lists your own messages newest first
    // with the last one already selected, and confirming restores the file checkpoint, forks the
    // conversation at that message and puts its text back in the composer to edit. What it lacks is a
    // way in: the action sits in the command menu under "Context" and nothing points at it.
    //
    // So this adds the gesture, not the feature — the same action, run through the registry's own
    // executeCommand. Going through their action rather than their internals keeps the confirmation
    // dialog, and with it the summary of which files a rewind would touch.
    var REWIND_ACTION = 'rewind';

    function rewindAvailable() {
        if (!registry || typeof registry.executeCommand !== 'function') return false;
        // registerAction files the handler in commandActions under the action id, and executeCommand
        // is a silent no-op for an id that is gone. Ask first, so a renamed action means the item is
        // absent rather than present and dead.
        if (registry.commandActions && typeof registry.commandActions.has === 'function')
            return registry.commandActions.has(REWIND_ACTION);
        return Boolean(registry.findCommandByLabel && registry.findCommandByLabel('Rewind'));
    }

    function openRewind() {
        try {
            registry.executeCommand(REWIND_ACTION);
        } catch (err) {
            console.warn('ccx: rewind failed', err);
            toast('Could not open Rewind.');
        }
    }

    // Ctrl+Shift+Z. In a contenteditable that is redo, so the composer gives redo up for this — undo
    // is untouched, and what redo would restore there is a line of prose. It is a trade, not a free
    // key, which is also why the event is only swallowed when there is actually a picker to open.
    function onRewindKey(e) {
        if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
        if ((e.key || '').toLowerCase() !== 'z') return;
        if (!rewindAvailable()) return;
        e.preventDefault();
        e.stopPropagation();
        openRewind();
    }

    function rangeHasPoint(range, x, y) {
        var rects = range.getClientRects();
        for (var i = 0; i < rects.length; i++) {
            var r = rects[i];
            if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
        }
        return false;
    }

    // A right-click outside a selection collapses it before the contextmenu event, so the live
    // selection alone cannot answer "did they click inside their selection". The snapshot is taken on
    // the mousedown that precedes it — and is only trusted when the click actually landed on it,
    // otherwise a click elsewhere would quote text the user had left behind.
    function usableSelection(e) {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim()) return sel;
        if (selectionSnapshot && rangeHasPoint(selectionSnapshot, e.clientX, e.clientY)) {
            var restored = window.getSelection();
            restored.removeAllRanges();
            restored.addRange(selectionSnapshot);
            return restored;
        }
        return null;
    }

    function onContextMenu(e) {
        try {
            // Positive gate on the transcript container. Matching the CSS-module prefix is the same
            // approach the session-list icons use; it fails closed — a renamed module means the item
            // stops appearing, never that the app's own menus break.
            if (!e.target.closest || !e.target.closest('[class*="messagesContainer_"]')) return;
            // The app has its own menu on markdown links; leave that one to it.
            if (e.target.closest('a[href]')) return;

            var sel = usableSelection(e);
            var text = sel ? quoteText(sel) : '';
            var items = [];

            if (text) {
                var quote = menuItem('Quote selection', function () {
                    var el = composerReady();
                    if (!el) return toast('The composer is not available right now.');
                    if (!insertIntoComposer(el, text)) toast('Could not insert the quote.');
                });
                if (!composerReady()) quote.classList.add('ccx-menu-disabled');
                items.push(quote);
                // preventDefault took the stock Copy away with the rest of the menu, so it comes back
                // here. The webview iframe is granted clipboard-write, so this is the whole story.
                items.push(
                    menuItem('Copy', function () {
                        navigator.clipboard.writeText(sel.toString()).catch(function () {
                            toast('Could not copy the selection.');
                        });
                    }),
                );
            }

            // Reached with no selection too, which is the point: over a transcript the stock menu is
            // three inert entries, so replacing it costs nothing there. The composer is outside
            // messagesContainer_ and keeps its own menu, which is the one where Paste matters.
            if (rewindAvailable()) {
                if (items.length) items.push(menuSeparator());
                items.push(menuItem('Rewind…', openRewind));
            }
            if (!items.length) return;

            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, items);
        } catch (err) {
            console.warn('ccx: context menu failed', err);
        }
    }

    function watchSelection() {
        document.addEventListener(
            'mousedown',
            function (e) {
                if (e.button !== 2) {
                    selectionSnapshot = null;
                    return;
                }
                var sel = window.getSelection();
                selectionSnapshot =
                    sel && !sel.isCollapsed && sel.toString().trim() ? sel.getRangeAt(0).cloneRange() : null;
            },
            true,
        );
        // Capture phase: React binds its delegated listeners on #root, so this runs first, and
        // stopPropagation() here also keeps VS Code's own window-level handler from seeing the event.
        document.addEventListener('contextmenu', onContextMenu, true);
        // Same reason for the capture phase, and it has to be the window: the composer stops some keys
        // at its own handler, and the composer is exactly where you are when you want this.
        window.addEventListener('keydown', onRewindKey, true);
    }

    function restartChannel(name) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;

        // What is resumed has to be a session the CLI has actually written: the id it announced on
        // this channel (system/init) or the one this channel was launched to resume. state.sessionId
        // is deliberately not a fallback — on a tab that has not sent anything yet the page already
        // holds a provisional id, and resuming that gives "No conversation found with session ID".
        // A tab with nothing said in it has nothing to lose: it restarts fresh, and the first
        // system/init binds the real session to the profile.
        var resume = sessionByChannel[activeChannelId] || (launch && launch.resume) || undefined;

        // A tab with history is offered a compaction first. The prompt cache never survives a provider
        // change anyway — the next backend has never seen this prefix — so the first turn pays for the
        // whole transcript either way; sending the compact summary instead of the raw history is the
        // one lever that makes that first turn cheaper, and it also keeps a longer conversation inside
        // a smaller window on the other side. It is a question, not a default: compaction discards
        // detail the user may be about to rely on.
        if (resume && canCompact()) return offerCompaction(name, resume);
        performRestart(name, resume);
    }

    // --- Compact before switching -------------------------------------------------------------
    //
    // The compaction is the stock one: the page's own send() with "/compact", the same thing the
    // command menu does. The CLI answers with a system/compact_boundary on the io_message stream we
    // already listen to; that is the moment the summary is written and the restart can go ahead. If
    // it never arrives — the model is stuck, or the turn errors — the switch is not held hostage:
    // after COMPACT_WAIT_MS it restarts uncompacted and says so.
    var COMPACT_WAIT_MS = 90000;
    var pendingCompact = null;

    function activeSession() {
        var s = ctx && ctx.activeSession && ctx.activeSession.value;
        return s && typeof s.send === 'function' ? s : null;
    }

    // "Switch model… → <model>" in the command menu is the stock indicator of lastServedModel, which the
    // page fills from the model on the last assistant turn — and it fills it while REPLAYING history
    // for a resume (loadFromMessages → processMessage per item), before the CLI has said a word. So
    // after a provider switch it names the model the old provider answered with, until the new one
    // answers. The stock reset lives in system/init and fires only when the session id changes, which
    // a --resume never does. Cleared here instead, on every restart of a switch, so the menu shows the
    // selection rather than a ghost from the transcript.
    function forgetServedModel() {
        try {
            var s = activeSession();
            if (s && s.lastServedModel && 'value' in s.lastServedModel) s.lastServedModel.value = undefined;
        } catch (err) {
            /* an indicator we could not reset is a stale label, not a broken switch */
        }
    }

    function canCompact() {
        var s = activeSession();
        if (!s) return false;
        // Nothing to compact on a transcript with no assistant turn yet, and no point asking while a
        // turn is already running — the compaction would queue behind it.
        var msgs = s.messages && s.messages.value;
        var hasAssistant = Array.isArray(msgs) && msgs.some(function (m) { return m && m.type === 'assistant'; });
        var busy = s.busy && s.busy.value;
        return hasAssistant && !busy;
    }

    function offerCompaction(name, resume) {
        var bar = document.createElement('div');
        bar.className = 'ccx-toast';
        var text = document.createElement('span');
        text.textContent = 'Switching to "' + name + '". Compact the conversation first?';
        var yes = document.createElement('button');
        yes.className = 'ccx-toast-btn';
        yes.textContent = 'Compact & switch';
        var no = document.createElement('button');
        no.className = 'ccx-toast-btn ccx-toast-btn-quiet';
        no.textContent = 'Switch as is';
        bar.append(text, yes, no);
        document.body.appendChild(bar);
        var done = false;
        var settle = function (compact) {
            if (done) return;
            done = true;
            bar.remove();
            if (compact) compactThenRestart(name, resume);
            else performRestart(name, resume);
        };
        yes.onclick = function () { settle(true); };
        no.onclick = function () { settle(false); };
        // Left unanswered, the switch still happens — the profile was already applied on the host, and
        // a toast that quietly outlives the decision would leave the tab claiming one provider while
        // running another.
        setTimeout(function () { settle(false); }, 20000);
    }

    function compactThenRestart(name, resume) {
        var s = activeSession();
        if (!s) return performRestart(name, resume);
        toast('Compacting before switching to "' + name + '"…');
        var job = { name: name, resume: resume, channelId: activeChannelId };
        job.timer = setTimeout(function () {
            if (pendingCompact !== job) return;
            pendingCompact = null;
            toast('Compaction did not finish — switching to "' + name + '" as is.');
            performRestart(name, resume);
        }, COMPACT_WAIT_MS);
        pendingCompact = job;
        try {
            var r = s.send('/compact');
            if (r && typeof r.catch === 'function') r.catch(function () { onCompactFailed(job); });
        } catch (err) {
            onCompactFailed(job);
        }
    }

    function onCompactFailed(job) {
        if (pendingCompact !== job) return;
        pendingCompact = null;
        clearTimeout(job.timer);
        toast('Could not compact — switching to "' + job.name + '" as is.');
        performRestart(job.name, job.resume);
    }

    // Called from the io_message listener the moment the CLI reports the boundary
    function onCompactBoundary(channelId) {
        var job = pendingCompact;
        if (!job || job.channelId !== channelId) return;
        pendingCompact = null;
        clearTimeout(job.timer);
        // The boundary is reported before the turn is fully wound down; a short beat lets the summary
        // land in the transcript before the channel is closed on top of it.
        setTimeout(function () { performRestart(job.name, job.resume); }, 400);
    }

    function performRestart(name, resume) {
        var launch = launchByChannel[activeChannelId];
        var conn = ctx && ctx.comms && ctx.comms.connection && ctx.comms.connection.value;
        if (!activeChannelId || !conn || typeof conn.launchClaude !== 'function') {
            toast('Provider "' + name + '" will apply on the next session launch.');
            return;
        }
        if (pendingRestart) return;
        forgetServedModel();
        toast('Switching to "' + name + '" — ' + (resume ? 'restarting session…' : 'starting fresh…'));
        var job = {
            channelId: activeChannelId,
            conn: conn,
            resume: resume,
            cwd: launch && launch.cwd,
            permissionMode: launch && launch.permissionMode,
            thinkingLevel: launch && launch.thinkingLevel,
        };
        job.timer = setTimeout(function () {
            if (pendingRestart === job) {
                pendingRestart = null;
                doLaunch(job);
            }
        }, 6000);
        pendingRestart = job;
        send({ type: 'close_channel', channelId: job.channelId });
    }

    function doLaunch(job) {
        try {
            job.conn.launchClaude(job.channelId, job.resume, job.cwd, job.permissionMode, job.thinkingLevel);
        } catch (err) {
            console.error('ccx: relaunch failed', err);
            toast('Could not restart the session — start a new conversation.');
        }
    }

    window.__ccx = {
        onRegistry: function (host, jsxFactory) {
            if (registry || !host || !host.commandRegistry) return;
            ctx = host;
            registry = host.commandRegistry;
            jsx = jsxFactory;
            syncAction();
            syncChip();
        },
    };

    // styles
    var s = document.createElement('style');
    s.textContent = [
        '.ccx-chip{position:fixed;right:10px;bottom:8px;z-index:9999;font:11px var(--vscode-font-family);padding:2px 8px;border-radius:10px;cursor:pointer;color:var(--vscode-foreground);background:var(--vscode-badge-background);border:1px solid var(--vscode-widget-border, transparent)}',
        '.ccx-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}',
        '.ccx-box{min-width:280px;max-width:80vw;max-height:70vh;overflow:auto;padding:6px;border-radius:6px;font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border, var(--vscode-focusBorder));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-title{padding:6px 10px;opacity:.7;font-size:11px;text-transform:uppercase}',
        '.ccx-hint{padding:0 10px 6px;opacity:.55;font-size:11px}',
        '.ccx-row{display:flex;gap:8px;align-items:baseline;padding:6px 10px;border-radius:4px;cursor:pointer}',
        '.ccx-row:hover{background:var(--vscode-list-hoverBackground)}',
        '.ccx-mark{opacity:.7;width:1em}',
        '.ccx-model{margin-left:auto;opacity:.6;font-size:11px}',
        '.ccx-prov-tag{opacity:.7;font-size:11px;padding:1px 6px;border-radius:8px;background:var(--vscode-badge-background)}',
        '.ccx-model-tag{margin-left:6px;opacity:.55;font-size:10px;font-family:var(--vscode-editor-font-family, monospace)}',
        // The row is display:flex;align-items:center;gap:8px, so ::before simply becomes its leading flex
        // item and the flex:1 title still ellipsizes. No child node, so nothing for React to reconcile.
        'button[data-ccx-provider]::before{content:"";flex:0 0 auto;width:13px;height:13px;margin-right:-3px;border-radius:3px;background-image:var(--ccx-icon);background-size:contain;background-position:center;background-repeat:no-repeat;opacity:.9}',
        '.ccx-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:10001;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:6px;font:12px var(--vscode-font-family);color:var(--vscode-notifications-foreground, var(--vscode-foreground));background:var(--vscode-notifications-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-notificationCenter-border, var(--vscode-widget-border));box-shadow:0 4px 16px rgba(0,0,0,.4)}',
        '.ccx-toast-btn{font:12px var(--vscode-font-family);padding:3px 10px;border-radius:4px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:none}',
        '.ccx-toast-btn-quiet{color:var(--vscode-button-secondaryForeground, var(--vscode-foreground));background:var(--vscode-button-secondaryBackground, transparent);border:1px solid var(--vscode-button-border, var(--vscode-widget-border))}',
        '.ccx-toast-skip{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}',
        // Above the app's own .previewOverlay (z-index 1e4) and claudapter's toast, since it is opened
        // from a right-click that can land anywhere. Menu colours first, widget colours as the fallback.
        '.ccx-menu{position:fixed;z-index:10002;min-width:160px;padding:4px;border-radius:5px;font:13px var(--vscode-font-family);color:var(--vscode-menu-foreground, var(--vscode-foreground));background:var(--vscode-menu-background, var(--vscode-editorWidget-background));border:1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-focusBorder)));box-shadow:0 2px 12px rgba(0,0,0,.4)}',
        '.ccx-menu-item{padding:4px 22px 4px 10px;border-radius:3px;cursor:pointer;white-space:nowrap}',
        '.ccx-menu-item:hover{color:var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));background:var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground))}',
        '.ccx-menu-disabled{opacity:.45;pointer-events:none}',
        '.ccx-menu-sep{height:1px;margin:4px 6px;background:var(--vscode-menu-separatorBackground, var(--vscode-widget-border, rgba(128,128,128,.35)))}',
    ].join('');
    document.head.appendChild(s);

    send({ type: 'ccx:get' });
    // Listeners go on `document`, which exists before <body> does, so this does not wait for the DOM.
    // It also has to be registered before VS Code's preload hooks the frame, which is why the injected
    // script is a classic inline <script> rather than a module.
    watchSelection();
    if (document.body) {
        syncChip();
        decorateSessionList();
        watchPicker();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            syncChip();
            decorateSessionList();
            watchPicker();
        });
    }
})();