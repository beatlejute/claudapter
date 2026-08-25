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

    var state = { profiles: [], active: null, sessionId: null, bindings: {}, selectedModel: null, effortLevel: null };
    var icons = {};
    var fallback = null;
    var registry = null;
    var ctx = null;
    // The session object (messages, busy, lastServedModel, send) — a different class from the context
    // object, and not reachable from it, so injection point #4 hands it over separately. Re-set on
    // every registration, which the app re-runs whenever the model selection changes, so a tab that
    // swaps its session object is followed rather than remembered.
    var sessionObj = null;
    var jsx = null;
    var chip = null;
    var overlay = null;
    var launchByChannel = {};
    var sessionByChannel = {};
    var activeChannelId = null;
    var pendingRestart = null;
    var searchSetter = null;
    var searchSeq = 0;
    var searchDebounceTimer = null;
    var spellcheckSeq = 0;
    var spellcheckTimer = null;
    // Delegated runs reported by the host, newest last, and the per-frame open/closed state. Both
    // live here rather than in the DOM: React owns the nodes a frame hangs off and re-creates them
    // freely, so anything remembered inside one is lost on the next commit.
    var agentRuns = [];
    var frameOpen = {};
    var frameTouched = {};
    var claimedRuns = {};
    // The last progress the app reported for a task-style subagent, by tool_use id. Kept because the
    // app DELETES its entry the moment the task ends (handleTaskNotification), and a frame that blanks
    // itself exactly when the run finishes is the one moment it is worth reading.
    var taskSnapshots = {};
    var spellcheckComposer = null;
    var spellcheckText = '';
    var spellcheckUnknown = new Set();
    var spellcheckSuggestions = {};
    // uuid -> epoch ms, straight from the session's .jsonl. The page's own message.timestamp cannot be
    // trusted for anything but a live turn: its class defaults that field to Date.now(), and replayed
    // history is rebuilt without one, so a resumed transcript reports "now" for every past message.
    var messageTimes = {};
    var messageTimesSession = null;
    // The pinned session ids, mirrored from the host. Two consumers: the row marks, drawn from the
    // DOM side, and the session list's own ordering, which only ever sees what pushPinned() hands
    // to its state setter — the component re-reads nothing on its own.
    var pinnedIds = new Set();
    var pinSetter = null;
    var pinPushed = null;

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
                selectedModel: d.selectedModel || null,
                effortLevel: d.effortLevel || null,
                sessionId: d.sessionId || state.sessionId,
            };
            adoptAttachmentPrompts(d.attachmentPrompts);
            adoptPinned(d.pinnedSessions);
            // Retracted uuids arrive from the host; a session change resets the set, otherwise the
            // host's list merges in (the host only ever adds, so local in-flight additions survive).
            if (state.sessionId !== hiddenSession) {
                hiddenSession = state.sessionId;
                hiddenUuids = new Set();
                pendingRetractBefore = null;
                pendingRetractText = null;
                pendingRetractIdx = -1;
                pendingRetractResponse = false;
            }
            if (Array.isArray(d.hiddenMessages))
                for (var hi = 0; hi < d.hiddenMessages.length; hi++) hiddenUuids.add(d.hiddenMessages[hi]);
            syncAction();
            syncChip();
            decorateModelPicker();
            decorateModelAndEffort();
            decorateSessionList();
            decorateTranscript();
            decorateAgentFrames();
            applyHidden();
        } else if (d.type === 'ccx:icons') {
            icons = d.icons || {};
            fallback = d.fallback || null;
            decorateSessionList();
        } else if (d.type === 'ccx:applied') {
            if (d.sessionId && !state.sessionId) state.sessionId = d.sessionId;
            restartChannel(d.name);
        } else if (d.type === 'ccx:searchResults') {
            // A later keystroke may already have moved past this — only the newest request's answer counts.
            if (d.seq !== searchSeq || !searchSetter) return;
            searchSetter(d.matches && d.matches.length ? new Set(d.matches) : null);
        } else if (d.type === 'ccx:spellcheckResult') {
            applySpellcheckResult(d);
        } else if (d.type === 'ccx:timestampsResult') {
            if (d.sessionId !== messageTimesSession) return;
            messageTimes = d.times || {};
            decorateTranscript();
        } else if (d.type === 'ccx:agentRuns') {
            // Inert data for a read-only frame. It is never written into the composer, never sent
            // back to the host, and never handed to the app's own session object — the tab's context
            // is the tool call and its result, and that is all it stays.
            agentRuns = Array.isArray(d.runs) ? d.runs : [];
            claimedRuns = {};
            decorateAgentFrames();
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

    // The indicator is an inert DOM sibling in the composer's toolbar row, restored after React commits
    // by the existing observer. Changing model and effort stays the job of the stock controls and slash
    // commands.
    function selectedModelLabel(model) {
        if (typeof model !== 'string' || !model.trim()) return 'Auto';
        // the session signals carry the raw selection, context suffix and all ("opus[1m]") — the chip
        // shows the family name, so the [1m]-style marker is stripped before the alias lookup
        var value = model.trim().replace(/\[[^\]]*\]$/, '').trim();
        var aliases = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
        return aliases[value.toLowerCase()] || value;
    }

    function liveUltracode() {
        return sessionField('ultracodeEnabled') === true;
    }

    // The values the composer actually shows are the session's live signals, not settings.json — that
    // file only holds the defaults, so it names whatever chat last changed /model or /effort, which is
    // exactly the "not this chat" complaint. A fresh session reports undefined until the user picks, and
    // the picker renders that as "Auto".
    function sessionField(name) {
        var s = sessionObj;
        try {
            var v = s && s[name];
            return v && typeof v === 'object' && 'value' in v ? v.value : undefined;
        } catch (e) {
            return undefined;
        }
    }

    // The model THIS chat is actually on: the explicit pick first, then what actually ran. settings.json
    // is deliberately not consulted — its `model` is a global default, not this session's value, and
    // surfacing it is exactly the "not this chat" complaint.
    function liveModel() {
        var sources = ['modelSelection', 'lastServedModel', 'currentMainLoopModel'];
        for (var i = 0; i < sources.length; i++) {
            var m = sessionField(sources[i]);
            if (typeof m === 'string' && m.trim() && m.trim() !== 'default' && m.trim() !== 'auto')
                return m.trim();
        }
        return null;
    }

    function liveEffort() {
        var e = sessionField('effortLevel');
        return typeof e === 'string' && e.trim() ? e.trim() : null;
    }

    // The label belongs in the composer's toolbar row, left of the mode picker ("Auto"), not on a line
    // of its own — a bare child of the fieldset gets stretched into a full-width bar by its column flex.
    // The row always ends with the submit button, and the mode picker is the node right before it, so
    // inserting before that sibling lands the label beside "Auto" in the same flex row. When the row is
    // missing the fieldset itself is the fallback anchor.
    function findIndicatorAnchor() {
        var composers = document.querySelectorAll('fieldset[data-permission-mode]');
        for (var i = 0; i < composers.length; i++) {
            var composer = composers[i];
            if (composer.offsetParent === null) continue;
            var send = composer.querySelector('button[type="submit"]');
            if (send && send.parentElement)
                return { parent: send.parentElement, before: send.previousElementSibling || send };
            return { parent: composer, before: null };
        }
        return null;
    }

    function describeEl(el) {
        if (!el) return null;
        return {
            tag: el.tagName,
            cls: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
            text: (el.textContent || '').trim().slice(0, 60),
            perm: el.getAttribute ? el.getAttribute('data-permission-mode') : null,
            spark: el.getAttribute ? el.getAttribute('data-spark') : null,
        };
    }

    // Throttled, capped diagnostic: the settled DOM is what matters, not the first paint, so this
    // re-fires (debounced) a handful of times and the last one is the truth.
    function debugDump(reason) {
        if (!sessionObj) return;
        window.__ccxDumpN = (window.__ccxDumpN || 0) + 1;
        if (window.__ccxDumpN > 25) return;
        var fieldsets = [];
        document.querySelectorAll('fieldset[data-permission-mode]').forEach(function (f) {
            fieldsets.push({
                visible: f.offsetParent !== null,
                cls: typeof f.className === 'string' ? f.className.slice(0, 120) : '',
                perm: f.getAttribute('data-permission-mode'),
                spark: f.getAttribute('data-spark'),
                legends: Array.prototype.map.call(f.querySelectorAll('legend'), describeEl),
            });
        });
        var permEls = [];
        document.querySelectorAll('[data-permission-mode]').forEach(function (el) {
            permEls.push(describeEl(el));
        });
        var labels = [];
        var wanted = ['Auto', 'Default', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'xhigh', 'max'];
        document.querySelectorAll('body *').forEach(function (el) {
            if (labels.length >= 40 || el.offsetParent === null) return;
            if (el.children && el.children.length > 0) return;
            var t = (el.textContent || '').trim();
            if (!t) return;
            var hit = false;
            for (var i = 0; i < wanted.length; i++) {
                if (t === wanted[i] || t.indexOf('Effort:') === 0) { hit = true; break; }
            }
            if (!hit) return;
            var r = el.getBoundingClientRect();
            labels.push({
                tag: el.tagName,
                cls: typeof el.className === 'string' ? el.className.slice(0, 100) : '',
                text: t.slice(0, 40),
                x: Math.round(r.x),
                y: Math.round(r.y),
            });
        });
        var cfg = null;
        try {
            var c = sessionObj.config && sessionObj.config.value;
            if (c) cfg = { modelSetting: c.modelSetting, modelCount: c.models ? c.models.length : 0 };
        } catch (e) {}
        send({
            type: 'ccx:debug',
            n: window.__ccxDumpN,
            reason: reason,
            dump: {
                modelSelection: sessionField('modelSelection'),
                lastServedModel: sessionField('lastServedModel'),
                currentMainLoopModel: sessionField('currentMainLoopModel'),
                effortLevel: liveEffort(),
                ultracodeEnabled: liveUltracode(),
                permissionMode: sessionField('permissionMode'),
                fastModeState: sessionField('fastModeState'),
                settingsModel: state.selectedModel,
                settingsEffort: state.effortLevel,
                profile: state.active,
                config: cfg,
                fieldsets: fieldsets,
                permEls: permEls,
                labels: labels,
            },
        });
    }

    var debugDumpTimer = null;
    function scheduleDebugDump(reason) {
        clearTimeout(debugDumpTimer);
        debugDumpTimer = setTimeout(function () { debugDump(reason); }, 700);
    }

    function decorateModelAndEffort() {
        scheduleDebugDump('decorate');
        var model = liveModel();
        var label =
            selectedModelLabel(model) + ' · ' + (liveUltracode() ? 'ultracode' : liveEffort() || 'Auto');
        var anchor = findIndicatorAnchor();
        var indicators = document.querySelectorAll('.ccx-model-effort');
        for (var i = 0; i < indicators.length; i++) {
            if (!anchor || indicators[i].parentElement !== anchor.parent) indicators[i].remove();
        }
        if (!anchor) return;

        var indicator = anchor.parent.querySelector(':scope > .ccx-model-effort');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'ccx-model-effort';
            indicator.title = 'Selected model and reasoning effort';
            if (anchor.before) anchor.parent.insertBefore(indicator, anchor.before);
            else anchor.parent.appendChild(indicator);
        }
        indicator.textContent = label;
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
            for (var i = 0; i < rows.length; i++) {
                applyRowIcon(rows[i]);
                applyRowPin(rows[i]);
            }
        } catch (e) {
            /* an unrecognised list is a list without icons, not a broken webview */
        }
    }

    // --- Pinned sessions ----------------------------------------------------------------------
    //
    // The history list is ordered by the app, by recency, and re-derived on every render — so a pin
    // cannot be a DOM move: the next commit would undo it. It is a sort instead, applied where the
    // list is computed (injection point #7), which puts the row above the rest for the app's own
    // keyboard navigation too, not just visually.
    //
    // Ordering has to reach the component as state or nothing re-renders when a pin is toggled, so
    // the patch declares a state pair for it and hands the setter over here, the same way content
    // search does. The page stays the owner of the value; the state pair is what makes it visible.
    function adoptPinned(list) {
        if (!Array.isArray(list)) return;
        var next = new Set();
        for (var i = 0; i < list.length; i++) if (typeof list[i] === 'string' && list[i]) next.add(list[i]);
        pinnedIds = next;
        pushPinned();
    }

    function samePins(a, b) {
        if (!a || !b || a.size !== b.size) return false;
        var values = a.values();
        for (var v = values.next(); !v.done; v = values.next()) if (!b.has(v.value)) return false;
        return true;
    }

    // A fresh Set every time, because that identity is the whole re-render signal — but only when
    // the membership actually changed, or every state push would re-render the list for nothing.
    function pushPinned() {
        if (!pinSetter || samePins(pinPushed, pinnedIds)) return;
        pinPushed = new Set(pinnedIds);
        pinSetter(pinPushed);
    }

    // Called from the component's own render, on every render — hence the identity guard: writing
    // state from inside a render is what it exists to avoid, and the setter is stable across them.
    function onPinState(setter) {
        if (setter === pinSetter) return;
        pinSetter = setter;
        pinPushed = null;
        setTimeout(pushPinned, 0);
    }

    // A stable partition, not a comparator: pinned rows move to the top as a block and keep the
    // list's own recency order inside it, so pinning one session never reorders the others.
    //
    // The second argument is what the component last received. Before the first push it is null and
    // the page's own copy stands in — it is authoritative either way, and the two only differ for
    // the one render between a toggle and the state write landing.
    function pinSort(list, fromState) {
        try {
            var pins = fromState && typeof fromState.has === 'function' ? fromState : pinnedIds;
            if (!pins || !pins.size || !list || !list.length) return list;
            var top = [];
            var rest = [];
            for (var i = 0; i < list.length; i++) {
                var session = list[i];
                var id = session && session.sessionId && session.sessionId.value;
                (id && pins.has(id) ? top : rest).push(session);
            }
            return top.length && rest.length ? top.concat(rest) : list;
        } catch (e) {
            /* an unrecognised list is an unsorted list, not a broken history panel */
            return list;
        }
    }

    function togglePin(sessionId) {
        if (!sessionId) return;
        var pinned = !pinnedIds.has(sessionId);
        // Optimistic: the host echoes the authoritative list back on the next ccx:state, but the row
        // has to move now, not a round trip later.
        if (pinned) pinnedIds.add(sessionId);
        else pinnedIds.delete(sessionId);
        pushPinned();
        decorateSessionList();
        send({ type: 'ccx:pinSession', sessionId: sessionId, pinned: pinned });
    }

    var PIN_PATHS = [
        'M12 17v5',
        'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    ];

    // Built node by node rather than through innerHTML: the webview runs under a content policy that
    // can treat a markup string as a script sink, and this needs no markup to begin with.
    function pinGlyph() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '12');
        svg.setAttribute('height', '12');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        for (var i = 0; i < PIN_PATHS.length; i++) {
            var path = document.createElementNS(ns, 'path');
            path.setAttribute('d', PIN_PATHS[i]);
            svg.appendChild(path);
        }
        return svg;
    }

    // Unlike the provider mark this cannot be a pseudo-element — it has to be clickable — so it is a
    // real child, appended last so it lands past the time column. React owns the row's other
    // children and reconciles them by position; an extra trailing node is outside that list, and the
    // observer pass puts it back at the end if a commit ever does move it.
    function applyRowPin(row) {
        var id = null;
        try {
            id = sessionIdOfRow(row);
        } catch (e) {
            id = null;
        }
        var pin = row.querySelector(':scope > .ccx-pin');
        // An unresolved row has no id to pin, and pinning the wrong session is worse than not
        // offering it — the same rule the provider icon follows.
        if (!id) {
            if (pin) pin.remove();
            return;
        }
        if (!pin) {
            pin = document.createElement('span');
            pin.className = 'ccx-pin';
            pin.setAttribute('role', 'button');
            pin.appendChild(pinGlyph());
            // The row is itself a <button> that opens the session, and the list runs its own
            // selection handling off mousedown — neither may see this one.
            pin.onmousedown = function (e) {
                e.preventDefault();
                e.stopPropagation();
            };
            pin.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                togglePin(pin.dataset.ccxSession || '');
            };
            row.appendChild(pin);
        } else if (row.lastElementChild !== pin) {
            row.appendChild(pin);
        }
        // Read back at click time rather than closed over: a row's DOM node is reused when the list
        // re-keys, and a captured id would then pin whatever used to sit in that slot.
        pin.dataset.ccxSession = id;
        var pinned = pinnedIds.has(id);
        pin.dataset.ccxPinned = pinned ? '1' : '0';
        pin.title = pinned ? 'Unpin from the top of the list' : 'Pin to the top of the list';
    }

    // --- Message timestamps, chat-app style --------------------------------------------------
    //
    // Each transcript turn is rendered from a `message` prop — {type, uuid, content, timestamp, …} —
    // carried straight from the .jsonl line that produced it, which is not otherwise exposed anywhere
    // in the DOM or in ccx:state. The same fiber read as sessionIdOfRow gets it: no signal unwrapping
    // needed here, `message` is a plain object, not a signal.
    //
    // Written as data-* + a CSS pseudo-element, the same way the session-list provider mark is: a real
    // child node risks React's own reconciliation of that bubble (most of all the assistant one, which
    // keeps re-rendering while a turn is still streaming) clobbering it on the next commit, where a
    // data attribute on the node React already owns survives untouched.
    // 'timestamp' in message alone is not enough to trust an object found this way — walking up through
    // memoized props of intermediate wrappers can surface something else entirely that happens to carry
    // a field of that name (a live status/notification object, for one, which is exactly why every
    // bubble was showing the same near-current time instead of its own). A transcript message has this
    // whole shape together; nothing else plausibly does.
    function isTranscriptMessage(message) {
        return (
            message &&
            typeof message === 'object' &&
            (message.type === 'user' || message.type === 'assistant') &&
            typeof message.uuid === 'string' &&
            Array.isArray(message.content) &&
            message.timestamp !== undefined &&
            message.timestamp !== null
        );
    }

    function messagePropOf(node) {
        var key = fiberKeyOf(node);
        var fiber = key ? node[key] : null;
        // Deeper than sessionIdOfRow's four hops — that one only has to clear the registry component;
        // this has to clear whatever wraps the specific content-block renderer inside a turn, which
        // varies with how many layers a given block type (text, tool use, thinking) happens to add.
        for (var d = 0; fiber && d < 10; d++, fiber = fiber.return) {
            var message = fiber.memoizedProps && fiber.memoizedProps.message;
            if (isTranscriptMessage(message)) return message;
        }
        return null;
    }

    function formatMessageTime(date) {
        try {
            return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
        } catch (e) {
            return '';
        }
    }

    function dayKey(date) {
        return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
    }

    // "Today" / "Yesterday" through Intl.RelativeTimeFormat rather than a hand-rolled table — it is
    // already locale-correct, and every language this needs it in is one the runtime already knows.
    function formatDaySeparator(date) {
        var today = new Date();
        var diffDays = Math.round(
            (new Date(today.getFullYear(), today.getMonth(), today.getDate()) -
                new Date(date.getFullYear(), date.getMonth(), date.getDate())) /
                86400000
        );
        if (diffDays === 0 || diffDays === 1) {
            try {
                return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-diffDays, 'day');
            } catch (e) {
                /* fall through to a plain date */
            }
        }
        try {
            var opts =
                date.getFullYear() === today.getFullYear()
                    ? { day: 'numeric', month: 'long' }
                    : { day: 'numeric', month: 'long', year: 'numeric' };
            return new Intl.DateTimeFormat(undefined, opts).format(date);
        } catch (e) {
            return date.toDateString();
        }
    }

    // The .jsonl is fetched once per session. Live turns are not in it yet and do not need to be:
    // a message created in this page during this session carries a real Date.now() from its own
    // construction, so the in-page value is right for exactly the messages the file lacks.
    function ensureMessageTimes() {
        var id = state.sessionId;
        if (!id || id === messageTimesSession) return;
        messageTimesSession = id;
        messageTimes = {};
        send({ type: 'ccx:timestamps', sessionId: id });
    }

    function messageDate(message) {
        if (!message) return null;
        var ms = message.uuid ? messageTimes[message.uuid] : undefined;
        var date = ms ? new Date(ms) : message.timestamp ? new Date(message.timestamp) : null;
        return date && !isNaN(date.getTime()) ? date : null;
    }

    // Real child nodes, not pseudo-elements. An assistant bubble has BOTH of its pseudo-element slots
    // spoken for by the app itself: `.timelineMessage_:before` is the coloured status dot, and
    // `.timelineMessage_:after` is the vertical timeline rail — with `top:18px` on the first message of
    // a run, `height:18px` on the last, and `display:none` on a lone one. Generating content into
    // either slot silently replaces that, which is what first stretched the rail and then lost it
    // outright. Nothing about them may be touched, so the timestamp needs nodes of its own.
    //
    // Appended rather than prepended: React reconciles by walking references it already holds, and an
    // unknown node at the end stays out of the way of its insertBefore calls. Position is decided in
    // CSS instead — the time is absolute, the date pill uses flex `order` — so neither depends on where
    // in the child list it actually sits. If a commit does drop one, the MutationObserver pass puts it
    // back within its 60 ms debounce.
    function ensureLabel(node, className, tag) {
        for (var i = 0; i < node.children.length; i++)
            if (node.children[i].className === className) return node.children[i];
        var el = document.createElement(tag);
        el.className = className;
        node.appendChild(el);
        return el;
    }

    function dropLabel(node, className) {
        for (var i = 0; i < node.children.length; i++)
            if (node.children[i].className === className) {
                node.children[i].remove();
                return;
            }
    }

    function decorateTranscript() {
        try {
            ensureMessageTimes();
            // Same selector interruptIsCurrent() already reads the transcript with — document order,
            // both message kinds.
            var nodes = document.querySelectorAll('[data-testid="assistant-message"], [class*="userMessageContainer_"]');
            var prevDay = null;
            // Some bubbles render a second matching container inside themselves, and both fibers lead to
            // the same message — decorating both printed the same time twice, one directly under the
            // other. Document order guarantees an ancestor is seen before its descendant, so keeping the
            // outermost of each nest is enough.
            var decorated = [];
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                var nested = false;
                for (var j = 0; j < decorated.length; j++)
                    if (decorated[j].contains(node)) {
                        nested = true;
                        break;
                    }
                var date = nested ? null : messageDate(messagePropOf(node));
                if (!date) {
                    delete node.dataset.ccxTime;
                    delete node.dataset.ccxDate;
                    dropLabel(node, 'ccx-msg-time');
                    dropLabel(node, 'ccx-msg-date');
                    continue;
                }
                decorated.push(node);
                var time = formatMessageTime(date);
                // The attribute is what opens the gutter in CSS; the node is what fills it.
                if (node.dataset.ccxTime !== time) node.dataset.ccxTime = time;
                var timeEl = ensureLabel(node, 'ccx-msg-time', 'span');
                if (timeEl.textContent !== time) timeEl.textContent = time;
                var key = dayKey(date);
                if (key !== prevDay) {
                    var label = formatDaySeparator(date);
                    if (node.dataset.ccxDate !== label) node.dataset.ccxDate = label;
                    var dateEl = ensureLabel(node, 'ccx-msg-date', 'div');
                    if (dateEl.textContent !== label) dateEl.textContent = label;
                } else if (node.dataset.ccxDate) {
                    delete node.dataset.ccxDate;
                    dropLabel(node, 'ccx-msg-date');
                }
                prevDay = key;
            }
        } catch (e) {
            /* no timestamps is a plainer transcript, not a broken one */
        }
    }

    // --- Live subagent frames ------------------------------------------------------------------
    //
    // A delegated run is invisible while it happens. A native subagent renders as a fold with a tool
    // count, and a run_agent call as a spinner; in both cases the one thing that would say whether it
    // is working or stuck — what the agent is actually doing — is the thing not shown.
    //
    // The two sources are different but the frame is the same. A native subagent's whole conversation
    // is already in this page: its turns arrive on the same stream as everything else, tagged with the
    // tool_use id of the Task call that started them (`parentToolUseId` on a streamed or replayed
    // assistant turn, `sdkParentToolUseId` on one rebuilt from the SDK envelope), and the app files
    // them into `session.messages` and then declines to draw them. Nothing has to be fetched for that
    // one; it is a rendering job. A run_agent call is a separate process, so its lines come from the
    // host, which follows the agent's own transcript.
    //
    // Neither path feeds anything back: a frame is an inert sibling node inside the tool-call block,
    // built from data the page already has or was handed, and the parent turn never learns it exists.
    var TASK_TOOLS = { Task: 1, Agent: 1 };
    var MCP_AGENT_TOOL = 'mcp__claudapter-agents__run_agent';

    // The tool_use block is not in the DOM either — the div only carries a hashed class name. It is a
    // prop of the component that renders it (`content`, a wrapper whose own `.content` is the raw
    // block), which is the same walk messagePropOf already does for a turn, one level further in.
    function toolUseOf(node) {
        var key = fiberKeyOf(node);
        var fiber = key ? node[key] : null;
        for (var d = 0; fiber && d < 8; d++, fiber = fiber.return) {
            var props = fiber.memoizedProps;
            if (!props) continue;
            var candidates = [props.content, props.block, props.toolUse];
            for (var i = 0; i < candidates.length; i++) {
                var c = candidates[i];
                if (!c || typeof c !== 'object') continue;
                var raw = c.type === 'tool_use' ? c : c.content;
                if (raw && raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string')
                    return { block: raw, wrapper: c };
            }
        }
        return null;
    }

    // A wrapper exposes its tool result as a signal; its presence is what "this run has ended" means
    // for a native subagent, which reports no state of its own.
    function toolFinished(wrapper) {
        try {
            var result = wrapper && wrapper.toolResult;
            return Boolean(result && 'value' in result ? result.value : result);
        } catch (e) {
            return false;
        }
    }

    function blockOf(entry) {
        try {
            var raw = entry && entry.content;
            return raw && typeof raw === 'object' && typeof raw.type === 'string' ? raw : null;
        } catch (e) {
            return null;
        }
    }

    // A native subagent reaches the page in one of two shapes, and which one depends on how the
    // harness ran it.
    //
    // Inline, it is a conversation: its turns arrive on this tab's stream tagged with the tool_use id,
    // and messagesFor() below reads them whole. Run as a *task* (`task_type: "local_agent"` — what the
    // Agent tool does here, in the foreground as well as in the background), its turns never reach the
    // page at all; they go to the task's own output file. What the page gets instead is a progress
    // feed — `system/task_started|task_progress|task_notification` — which the app files into a
    // `subagentTasks` map and then reads only to count them for telemetry.
    //
    // So the task shape gives a summary, not a transcript: the last few tool names, a one-line summary
    // and running totals. That is what a frame can show for it, and it is still the difference between
    // "working" and "stuck".
    function taskFor(toolUseId) {
        var tasks = sessionField('subagentTasks');
        try {
            if (tasks && typeof tasks.forEach === 'function')
                tasks.forEach(function (t) {
                    if (t && t.toolUseId === toolUseId) taskSnapshots[toolUseId] = t;
                });
        } catch (e) {
            /* an unreadable map is one source missing, not a broken frame */
        }
        return taskSnapshots[toolUseId] || null;
    }

    function taskEvents(task) {
        var events = [];
        if (typeof task.prompt === 'string' && task.prompt.trim()) events.push({ k: 'prompt', t: task.prompt.slice(0, 1200) });
        var tools = task.recentTools;
        if (Array.isArray(tools)) for (var i = 0; i < tools.length; i++) if (tools[i]) events.push({ k: 'tool', n: String(tools[i]) });
        if (typeof task.summary === 'string' && task.summary.trim()) events.push({ k: 'text', t: task.summary.slice(0, 1200) });
        return events;
    }

    // The same shape the host sends for a delegated run, built here from the page's own messages, so
    // one renderer covers every source.
    function messagesFor(toolUseId) {
        var messages = sessionField('messages');
        if (!Array.isArray(messages)) return null;
        var events = [];
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            if (!m) continue;
            var parent = m.parentToolUseId || m.sdkParentToolUseId;
            if (parent !== toolUseId) continue;
            var content = m.content;
            if (!Array.isArray(content)) continue;
            for (var j = 0; j < content.length; j++) {
                var raw = blockOf(content[j]);
                if (!raw) continue;
                if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.trim())
                    events.push({ k: m.type === 'user' ? 'prompt' : 'text', t: raw.text.slice(0, 1200) });
                else if (raw.type === 'thinking') events.push({ k: 'thinking' });
                else if (raw.type === 'tool_use') events.push({ k: 'tool', n: String(raw.name || 'tool'), t: toolArgument(raw.input) });
                else if (raw.type === 'tool_result') events.push({ k: 'result', ok: !raw.is_error });
            }
        }
        return events.slice(-160);
    }

    // Messages first: where they exist they are the whole conversation, which no progress feed can
    // match. The task snapshot is what is left when the turns went somewhere this page cannot see.
    function nativeEvents(toolUseId, task) {
        var fromMessages = messagesFor(toolUseId);
        if (fromMessages === null) return task ? taskEvents(task) : null;
        if (fromMessages.length) return fromMessages;
        return task ? taskEvents(task) : fromMessages;
    }

    function toolArgument(input) {
        if (!input || typeof input !== 'object') return '';
        var keys = ['file_path', 'command', 'pattern', 'path', 'query', 'url', 'prompt', 'description'];
        for (var i = 0; i < keys.length; i++) {
            var v = input[keys[i]];
            if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        return '';
    }

    // An MCP server never sees the tool_use id of the call that reached it, so the manifest cannot
    // name the block it belongs to. The prompt can: it is the same string on both sides, and it is
    // already on screen. Where two live runs carry the same prompt the newest unclaimed one wins,
    // which is the only answer that keeps two identical calls from sharing one frame.
    function runForPrompt(prompt) {
        if (typeof prompt !== 'string' || !prompt.trim()) return null;
        var best = null;
        for (var i = 0; i < agentRuns.length; i++) {
            var run = agentRuns[i];
            // A run with a parent was started by another agent, not by this tab: it belongs inside
            // its parent's frame and must never be adopted by a block of its own.
            if (run.parent || claimedRuns[run.session]) continue;
            var a = run.prompt || '';
            var b = prompt;
            var n = Math.min(a.length, b.length);
            if (!n || a.slice(0, n) !== b.slice(0, n)) continue;
            if (!best || (run.startedAt || 0) >= (best.startedAt || 0)) best = run;
        }
        if (best) claimedRuns[best.session] = true;
        return best;
    }

    function span(ms) {
        if (!ms || ms < 0) return '';
        var s = Math.round(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        return m + 'm ' + (s % 60) + 's';
    }

    // A run the tab started can itself delegate, and then it spends the whole time dispatching while
    // its child does the work — the frame would truthfully show almost nothing. So a child's lines are
    // folded into its parent's frame, under a header of their own, and the parent's own note counts
    // the whole tree rather than just its own two tool calls.
    function withChildren(run, depth) {
        var events = (run.events || []).slice();
        if (depth >= 2) return events;
        for (var i = 0; i < agentRuns.length; i++) {
            var child = agentRuns[i];
            if (!child.parent || child.parent !== run.session) continue;
            claimedRuns[child.session] = true;
            events.push({ k: 'child', run: child });
            events = events.concat(withChildren(child, depth + 1));
        }
        return events;
    }

    function eventLine(e) {
        if (e.k === 'child') {
            var meta = runMeta(e.run);
            return { cls: 'ccx-agent-child', text: meta.title + ' — ' + meta.note };
        }
        if (e.k === 'tool') return { cls: 'ccx-agent-tool', text: e.t ? e.n + ' ' + e.t : e.n };
        if (e.k === 'thinking') return { cls: 'ccx-agent-thinking', text: 'thinking' };
        if (e.k === 'result') return null;
        if (e.k === 'prompt') return { cls: 'ccx-agent-prompt', text: e.t };
        return { cls: 'ccx-agent-text', text: e.t };
    }

    function ensureChild(parent, className, tag) {
        for (var i = 0; i < parent.children.length; i++)
            if (parent.children[i].className === className) return parent.children[i];
        var el = document.createElement(tag || 'div');
        el.className = className;
        parent.appendChild(el);
        return el;
    }

    // The frame is appended to the tool-call div rather than inserted anywhere particular, for the
    // reason the timestamps already are: React reconciles that subtree by references it holds, and an
    // unknown node at the end stays clear of its insertBefore calls. If a commit does drop it, the
    // observer puts it back on the next pass.
    function paintFrame(host, id, open, meta, events) {
        var frame = ensureChild(host, 'ccx-agent-frame');
        frame.dataset.ccxOpen = open ? '1' : '0';
        frame.dataset.ccxState = meta.state;

        var head = ensureChild(frame, 'ccx-agent-head');
        if (!head.dataset.ccxWired) {
            head.dataset.ccxWired = '1';
            head.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                // Read the current state off the node rather than the closure: this listener is wired
                // once and every later paint has its own `meta`.
                frameOpen[id] = frame.dataset.ccxOpen !== '1';
                frameTouched[id] = true;
                decorateAgentFrames();
            });
        }
        var caret = ensureChild(head, 'ccx-agent-caret', 'span');
        caret.textContent = open ? '▾' : '▸';
        var title = ensureChild(head, 'ccx-agent-title', 'span');
        if (title.textContent !== meta.title) title.textContent = meta.title;
        var note = ensureChild(head, 'ccx-agent-note', 'span');
        if (note.textContent !== meta.note) note.textContent = meta.note;

        var body = ensureChild(frame, 'ccx-agent-body');
        if (!open || !events) {
            body.textContent = '';
            return;
        }
        // Rebuilt only when the tail actually changed: this runs on every observer pass, and rewriting
        // the body each time would fight the user's own scrolling inside it.
        var stamp = meta.note + '|' + String(events.length) + '|' + (events.length ? JSON.stringify(events[events.length - 1]) : '');
        if (body.dataset.ccxStamp === stamp) return;
        body.dataset.ccxStamp = stamp;
        var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        body.textContent = '';
        if (!events.length) {
            var idle = document.createElement('div');
            idle.className = 'ccx-agent-idle';
            idle.textContent = meta.running ? 'starting…' : 'nothing was recorded for this run';
            body.appendChild(idle);
        }
        for (var i = 0; i < events.length; i++) {
            var line = eventLine(events[i]);
            if (!line) continue;
            var row = document.createElement('div');
            row.className = line.cls;
            row.textContent = line.text;
            body.appendChild(row);
        }
        // Only follow the tail for a reader who was already at it. Someone who scrolled back to read
        // an earlier line in a live frame should not be yanked forward by the next one.
        if (atBottom) body.scrollTop = body.scrollHeight;
    }

    function dropFrame(host) {
        for (var i = 0; i < host.children.length; i++)
            if (host.children[i].className === 'ccx-agent-frame') {
                host.children[i].remove();
                return;
            }
    }

    // Open while it runs, closed once it has answered — the answer itself is the tool result right
    // below. A frame the reader has touched keeps whatever they chose.
    function frameIsOpen(id, running) {
        return frameTouched[id] ? Boolean(frameOpen[id]) : running;
    }

    function nativeMeta(block, running, events, task) {
        var input = block.input || {};
        var name = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'subagent';
        var description = typeof input.description === 'string' && input.description ? input.description : task && task.description;
        // The task's own totals beat anything counted here: they cover the whole run, including the
        // tool calls whose names never made it into the last-three list.
        var usage = task && task.usage;
        var counted = 0;
        if (events) for (var i = 0; i < events.length; i++) if (events[i].k === 'tool') counted++;
        var tools = usage && usage.toolUses ? usage.toolUses : counted;
        // Grouped the same way the delegated run's own report groups its totals ('en-US', not the
        // runtime locale), so two frames side by side read as one thing.
        var tokens = usage && usage.totalTokens ? Number(usage.totalTokens).toLocaleString('en-US') + ' tok' : '';
        return {
            running: running,
            state: running ? 'running' : 'done',
            title: name + (description ? ' · ' + description : ''),
            note: [running ? 'running' : 'done', tools ? tools + ' tool calls' : '', tokens].filter(Boolean).join(' · '),
        };
    }

    function runMeta(run, tree) {
        var running = run.state === 'running';
        var elapsed = span((running ? Date.now() : run.finishedAt || Date.now()) - (run.startedAt || 0));
        var tools = 0;
        if (tree) for (var i = 0; i < tree.length; i++) if (tree[i].k === 'tool') tools++;
        return {
            running: running,
            state: run.state,
            title: (run.profile || 'agent') + (run.model ? ' · ' + run.model : ''),
            note: [running ? 'running' : run.state, elapsed, tools ? tools + ' tool calls' : '', run.tokens || '', (run.error || '').slice(0, 80)]
                .filter(Boolean)
                .join(' · '),
        };
    }

    // The host posts only when a run's tail actually changes, which is right for the body and wrong
    // for the clock: an agent that thinks for a minute without writing anything would leave the frame
    // reading the same elapsed time, which is indistinguishable from a frame that has died. So a
    // running frame repaints itself once a second regardless of what the host has to say.
    function watchRunningFrames() {
        // Guarded rather than assumed: the page is booted headless by the test harnesses, and a
        // missing timer here would take the whole bootstrap — every other decoration with it — down.
        if (typeof setInterval !== 'function') return;
        setInterval(function () {
            for (var i = 0; i < agentRuns.length; i++)
                if (agentRuns[i].state === 'running') {
                    decorateAgentFrames();
                    return;
                }
        }, 1000);
    }

    function decorateAgentFrames() {
        try {
            claimedRuns = {};
            var nodes = document.querySelectorAll('[class*="toolUse_"]');
            for (var i = 0; i < nodes.length; i++) {
                var host = nodes[i];
                var found = toolUseOf(host);
                var block = found && found.block;
                if (!block) {
                    dropFrame(host);
                    continue;
                }
                if (TASK_TOOLS[block.name]) {
                    var running = !toolFinished(found.wrapper);
                    var open = frameIsOpen(block.id, running);
                    // The body is the whole cost of this pass: filling it means walking every message
                    // in the transcript looking for the ones tagged with this call, and this runs on
                    // every commit. A closed frame is not worth that, and a transcript full of old
                    // Task calls is exactly where it would add up.
                    // Read on every pass, open or closed: the app throws the entry away when the task
                    // ends, so a frame that only looked while it was open would miss the final state.
                    var task = taskFor(block.id);
                    var events = open ? nativeEvents(block.id, task) : null;
                    // Nothing readable at all means the session object is not reachable this commit —
                    // leaving the previous frame alone beats blanking it on a transient miss.
                    if (open && !events) continue;
                    paintFrame(host, block.id, open, nativeMeta(block, running, events, task), events);
                } else if (block.name === MCP_AGENT_TOOL) {
                    var run = runForPrompt(block.input && block.input.prompt);
                    if (!run) {
                        dropFrame(host);
                        continue;
                    }
                    var tree = withChildren(run, 0);
                    paintFrame(host, block.id, frameIsOpen(block.id, run.state === 'running'), runMeta(run, tree), tree);
                } else {
                    dropFrame(host);
                }
            }
        } catch (e) {
            /* a missing frame is a plainer tool call, not a broken transcript */
        }
    }

    function watchPicker() {
        var timer = null;
        new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(function () {
                decorateModelPicker();
                decorateModelAndEffort();
                decorateSessionList();
                decorateTranscript();
                decorateAgentFrames();
                applyHidden();
                watchComposerSpellcheck();
                syncAttachmentPrompt();
                syncResumePrompt();
            }, 60);
        }).observe(document.body, { childList: true, subtree: true });
        watchRunningFrames();
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

    // VS Code starts this webview with Chromium spellchecking disabled, and Claude Code's own checker
    // only decorates its terminal UI. The host therefore checks a bounded list of Russian words with
    // local Hunspell. Custom Highlight ranges decorate the React-owned source nodes without wrapping or
    // editing them, which keeps the app's input state, selection and undo history intact.
    function clearSpellcheckHighlights() {
        if (window.CSS && CSS.highlights) CSS.highlights.delete('ccx-spelling');
    }

    function spellcheckTokens(el) {
        var text = el.textContent || '';
        var tokens = [];
        var match;
        var words = /[А-Яа-яЁё]{2,}/g;
        while ((match = words.exec(text))) {
            var word = match[0].toLowerCase();
            tokens.push({ word: word, start: match.index, end: match.index + match[0].length });
        }
        return { text: text, tokens: tokens };
    }

    function spellcheckTextNodes(el) {
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var nodes = [];
        var start = 0;
        var node;
        while ((node = walker.nextNode())) {
            var end = start + node.nodeValue.length;
            nodes.push({ node: node, start: start, end: end });
            start = end;
        }
        return nodes;
    }

    function spellcheckPoint(nodes, offset) {
        for (var i = 0; i < nodes.length; i++) {
            if (offset <= nodes[i].end) return { node: nodes[i].node, offset: offset - nodes[i].start };
        }
        return null;
    }

    function spellcheckOffsetAtPoint(el, x, y) {
        var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
        if (!range && document.caretPositionFromPoint) {
            var position = document.caretPositionFromPoint(x, y);
            if (position) {
                range = document.createRange();
                range.setStart(position.offsetNode, position.offset);
                range.collapse(true);
            }
        }
        if (!range || !el.contains(range.startContainer)) return null;
        var before = document.createRange();
        before.selectNodeContents(el);
        before.setEnd(range.startContainer, range.startOffset);
        return before.toString().length;
    }

    function spellcheckTokenAtPoint(el, x, y) {
        var offset = spellcheckOffsetAtPoint(el, x, y);
        if (offset === null) return null;
        var tokens = spellcheckTokens(el).tokens;
        for (var i = 0; i < tokens.length; i++) {
            if (offset >= tokens[i].start && offset <= tokens[i].end && spellcheckUnknown.has(tokens[i].word)) {
                return tokens[i];
            }
        }
        return null;
    }

    function replaceSpellcheckToken(el, token, replacement) {
        var point = spellcheckPoint(spellcheckTextNodes(el), token.start);
        var end = spellcheckPoint(spellcheckTextNodes(el), token.end);
        if (!point || !end) return false;
        var range = document.createRange();
        range.setStart(point.node, point.offset);
        range.setEnd(end.node, end.offset);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        el.focus();
        return document.execCommand('insertText', false, replacement);
    }

    function onComposerSpellcheckContextMenu(e) {
        var el = composerEl();
        if (!el || !el.contains(e.target) || el !== spellcheckComposer || (el.textContent || '') !== spellcheckText) return;
        var token = spellcheckTokenAtPoint(el, e.clientX, e.clientY);
        var suggestions = token && Array.isArray(spellcheckSuggestions[token.word]) ? spellcheckSuggestions[token.word] : [];
        if (!suggestions.length) return;
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, suggestions.slice(0, 5).map(function (suggestion) {
            return menuItem(suggestion, function () {
                if (!replaceSpellcheckToken(el, token, suggestion)) toast('Не удалось заменить слово.');
            });
        }));
    }

    function applySpellcheckResult(result) {
        if (result.seq !== spellcheckSeq || !Array.isArray(result.unknown)) return;
        var el = spellcheckComposer;
        if (!el || el !== composerEl() || (el.textContent || '') !== spellcheckText) return;

        spellcheckUnknown = new Set(result.unknown.map(function (word) { return word.toLowerCase(); }));
        spellcheckSuggestions = result.suggestions && typeof result.suggestions === 'object' ? result.suggestions : {};
        if (!window.CSS || !CSS.highlights || typeof Highlight !== 'function') return;
        var unknown = spellcheckUnknown;
        var tokens = spellcheckTokens(el).tokens;
        var nodes = spellcheckTextNodes(el);
        var ranges = [];
        for (var i = 0; i < tokens.length; i++) {
            if (!unknown.has(tokens[i].word)) continue;
            var start = spellcheckPoint(nodes, tokens[i].start);
            var end = spellcheckPoint(nodes, tokens[i].end);
            if (!start || !end) continue;
            var range = document.createRange();
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            ranges.push(range);
        }
        if (ranges.length) CSS.highlights.set('ccx-spelling', new Highlight(...ranges));
        else clearSpellcheckHighlights();
    }

    function runSpellcheck() {
        var el = composerReady();
        clearSpellcheckHighlights();
        if (!el) return;
        var parsed = spellcheckTokens(el);
        if (!parsed.tokens.length) return;
        var words = [];
        var seen = new Set();
        for (var i = 0; i < parsed.tokens.length && words.length < 200; i++) {
            if (seen.has(parsed.tokens[i].word)) continue;
            seen.add(parsed.tokens[i].word);
            words.push(parsed.tokens[i].word);
        }
        spellcheckComposer = el;
        spellcheckText = parsed.text;
        send({ type: 'ccx:spellcheck', seq: ++spellcheckSeq, words: words });
    }

    function queueSpellcheck() {
        clearTimeout(spellcheckTimer);
        spellcheckUnknown = new Set();
        spellcheckSuggestions = {};
        clearSpellcheckHighlights();
        spellcheckTimer = setTimeout(runSpellcheck, 450);
    }

    function watchComposerSpellcheck() {
        var el = composerEl();
        if (!el || el.dataset.ccxSpellcheck) return;
        el.dataset.ccxSpellcheck = '1';
        el.addEventListener('input', queueSpellcheck);
        el.addEventListener('contextmenu', onComposerSpellcheckContextMenu, true);
        el.addEventListener('compositionstart', function () {
            clearTimeout(spellcheckTimer);
            clearSpellcheckHighlights();
        });
        el.addEventListener('compositionend', queueSpellcheck);
        queueSpellcheck();
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
        // The resume and retract prompts ride on the same payload.
        if (typeof next.resume === 'string' && next.resume) RESUME_PROMPT = next.resume;
        if (typeof next.retract === 'string' && next.retract) RETRACT_TEMPLATE = next.retract;
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
    // When the model hits an error, a hard usage limit, or the user interrupts, the conversation stops
    // and the only way forward is to type "continue" by hand. This injects that prompt automatically
    // when the composer is empty and one of those halt states is visible.
    //
    // Four states, distinguished by their markup:
    //   - Error banner:      [class*="banner_"][data-color="error"]
    //   - Interrupt message: [class*="interruptedMessage_"]
    //   - Usage limit hit:   a [data-color="warning"] banner whose text begins "You've hit your"
    //   - Request failure:   the newest assistant turn whose text begins "API Error:"
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

    // Check for the halt states worth resuming: a real error (a 429 rate limit is an error, so it
    // lands here too), a trailing user interrupt, a hard usage limit, and a request-level failure.
    // The usage limit shares the warning-banner colour with the soft "approaching a limit" notice, so
    // it is told apart by wording (see hitLimitNotice), not by colour — "Approaching …" and "You've
    // used N% of …" mean the run is still healthy and must not fill the composer.
    function detectTerminalState() {
        var errorBanner = document.querySelector('[class*="banner_"][data-color="error"]');
        if (errorBanner && errorBanner.offsetParent !== null) return 'error';
        if (interruptIsCurrent()) return 'interrupt';
        if (hitLimitNotice()) return 'limit';
        if (failedTurnIsCurrent()) return 'failed';
        return null;
    }

    // "You've hit your <limit> · resets …" is a hard block — the request was rejected and nothing can
    // be sent until the reset time. It renders as a warning banner, the same colour as the soft
    // "approaching a limit" notice, so wording is the only honest discriminator. The string is
    // hardcoded English in the bundle (not localised), which keeps the text match stable across
    // /config languages.
    function hitLimitNotice() {
        var banners = document.querySelectorAll('[class*="banner_"][data-color="warning"]');
        for (var i = 0; i < banners.length; i++) {
            var banner = banners[i];
            if (banner.offsetParent === null) continue;
            if (/You've hit your\b/i.test(banner.textContent || '')) return true;
        }
        return false;
    }

    // A request-level failure ("API Error: Request rejected (429) …") lands in the transcript as an
    // ordinary assistant turn whose text is the error, not as a banner — the error-banner selector
    // above never sees it. The prefix is the CLI's own hardcoded English, so the match is stable.
    // Only the newest turn counts: once a later message follows, the failure is a past event, not a
    // state to resume.
    function failedTurnIsCurrent() {
        var s = activeSession();
        var msgs = s && s.messages && s.messages.value;
        if (!Array.isArray(msgs) || !msgs.length) return false;
        var last = msgs[msgs.length - 1];
        if (!last || last.type !== 'assistant') return false;
        return /^API Error:/.test(messageText(last));
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

    // --- Retract the last message -------------------------------------------------------------
    //
    // The stock "Rewind to…" picker restores a file checkpoint, forks the conversation and puts the
    // text back in the composer — a fork, which is exactly what this replaces. Retracting keeps the
    // session: the erroneous message and the assistant's answer to it are hidden from the transcript,
    // and the agent is told — under the hood, in a user turn that is hidden the moment it renders —
    // that the message was a mistake and should be ignored. The turn stays in the .jsonl, so the agent
    // keeps the context; only the view drops it. The hidden uuids are persisted per session on the
    // host, so a resume re-hides them and content search skips them.
    var RETRACT_TEMPLATE = 'The message «%s» was a mistake — ignore it and your response to it.';
    var RETRACT_QUOTE_LEN = 200;
    var hiddenUuids = new Set();
    var hiddenSession = null;
    // The retract accounts for two more turns than the one being retracted: the hidden "ignore it"
    // instruction, and the assistant's answer to it (which would otherwise dangle as an orphan reply
    // to nothing). The instruction's uuid is only knowable once send() has appended the turn, so these
    // fields track the search until both turns are found and hidden.
    var pendingRetractBefore = null;      // messages.value index where the instruction turn should land
    var pendingRetractText = null;        // the instruction text, a backstop if the index shifts
    var pendingRetractIdx = -1;           // the instruction turn's index, once found
    var pendingRetractResponse = false;   // true while the instruction's answer is still to hide

    function messageText(m) {
        if (!m || !Array.isArray(m.content)) return '';
        var parts = [];
        for (var i = 0; i < m.content.length; i++) {
            var b = m.content[i];
            // A message's content is an array of the app's block wrappers (class Bp), not the raw
            // blocks — the raw block sits one level down at block.content ({type:"text", text}). The
            // string branch guards the app's older string-content shape (its LX constructor).
            var block = b && b.content;
            if (typeof block === 'string') { parts.push(block); continue; }
            if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
        return parts.join('\n');
    }

    // The last message the user actually sent — the one "taking back the last message" refers to.
    // isSynthetic marks the app's own injected turns, which are not the user's to retract.
    function lastUserMessage() {
        var s = activeSession();
        if (!s) return null;
        var msgs = s.messages && s.messages.value;
        if (!Array.isArray(msgs)) return null;
        for (var i = msgs.length - 1; i >= 0; i--) {
            var m = msgs[i];
            // A retracted turn is already accounted for — the previous message is the one the user
            // gets to take back next.
            if (m && m.type === 'user' && !m.isSynthetic && !isInterruptTurn(m) && !(m.uuid && hiddenUuids.has(m.uuid)))
                return { index: i, uuid: m.uuid, text: messageText(m) };
        }
        return null;
    }

    // An interruption is not a user message: when the user stops a turn (or the retract interrupts it),
    // the CLI records it as an ordinary type:"user" turn whose text is one of these markers — with no
    // isSynthetic flag at all, so the isSynthetic check above does not catch it. "Taking back the last
    // message" must reach past the interruption to the message the user actually sent.
    function isInterruptTurn(m) {
        if (!m || m.type !== 'user') return false;
        var t = messageText(m);
        return t === '[Request interrupted by user]' || t === '[Request interrupted by user for tool use]';
    }

    // A busy session is retractable too — retractLastMessage interrupts the running turn first — so
    // the only thing that makes the gesture inert is a session with nothing to take back.
    function canRetract() {
        var s = activeSession();
        if (!s) return false;
        return lastUserMessage() !== null;
    }

    function persistHidden(uuids) {
        if (!uuids || !uuids.length) return;
        send({ type: 'ccx:hideMessages', sessionId: state.sessionId, uuids: uuids });
    }

    function hideNow(uuids) {
        var fresh = [];
        for (var i = 0; i < uuids.length; i++) {
            if (typeof uuids[i] === 'string' && !hiddenUuids.has(uuids[i])) {
                hiddenUuids.add(uuids[i]);
                fresh.push(uuids[i]);
            }
        }
        if (fresh.length) persistHidden(fresh);
        applyHidden();
    }

    // Pull the erroneous message back into the composer for editing — this is the "edit the last
    // message" half of the gesture. Writing textContent directly replaces whatever draft was already
    // there (retract means "rewrite that message", not "append to what I was typing"), and matches the
    // app's own setInputText (`st`): it assigns ne.current.textContent = ae and syncs the draft signal.
    // execCommand must NOT be used here: insertText on a contenteditable="plaintext-only" box only
    // lands when a live, collapsed selection is in place, and the select-all + delete that would clear
    // the old draft leaves that selection invalid — insertText then reports success while the DOM stays
    // empty, so the field reads blank. A direct textContent write always lands; the synthetic input
    // below makes the app's onInput (`os`) read it back and sync the draft signal, so the app's
    // "clear the composer when the draft is empty" effect (`if(ne.current&&v==="")…`) does not wipe it.
    function replaceComposerText(text) {
        var el = composerReady();
        if (!el) return false;
        el.focus();
        el.textContent = text;
        var range = document.createRange();
        var sel = window.getSelection();
        if (sel) {
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        if (typeof el.dispatchEvent === 'function') {
            var evt;
            try {
                evt = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text });
            } catch (err) {
                evt = null;
            }
            if (!evt) {
                try { evt = new Event('input', { bubbles: true }); } catch (err2) { evt = null; }
            }
            if (evt) el.dispatchEvent(evt);
        }
        return true;
    }

    // The retract proper, run once the session is idle. Busy turns take a different route (they are
    // interrupted first), so this entry point assumes nothing about the agent's state.
    function doRetract(s) {
        var last = lastUserMessage();
        if (!last) return toast('Nothing to retract.');

        // Everything from the erroneous message to the end of the list is the failed exchange: the
        // message itself and whatever the agent answered to it.
        var msgs = s.messages.value;
        var toHide = [];
        for (var i = last.index; i < msgs.length; i++) {
            var m = msgs[i];
            if (m && typeof m.uuid === 'string') toHide.push(m.uuid);
        }
        var quote = (last.text || '').replace(/\s+/g, ' ').trim();
        if (quote.length > RETRACT_QUOTE_LEN) quote = quote.slice(0, RETRACT_QUOTE_LEN) + '…';
        var instruction = RETRACT_TEMPLATE.replace('%s', quote || '…');

        hideNow(toHide);
        // Put the message back in the composer so it can be corrected and re-sent; the instruction
        // below is what tells the agent to ignore the old copy it still holds in context.
        if (last.text && !replaceComposerText(last.text))
            toast('Retracted — paste the message text into the composer to resend.');

        // The instruction's own uuid is only knowable once send() has appended the turn. applyHidden
        // resolves it the moment the turn lands — here, when the send settles, and again from the DOM
        // observer — and then hides the instruction's answer the moment it appears. The pending state
        // is cleared by applyHidden, not by the send resolving, so the turn can never outlive its own
        // hiding.
        pendingRetractBefore = msgs.length;
        pendingRetractText = instruction;

        var sent;
        try {
            sent = s.send(instruction);
        } catch (err) {
            pendingRetractBefore = null;
            pendingRetractText = null;
            toast('Could not retract the message.');
            return;
        }
        if (sent && typeof sent.then === 'function') {
            sent.then(
                function () { applyHidden(); },
                function () {
                    pendingRetractBefore = null;
                    pendingRetractText = null;
                    toast('Could not retract the message.');
                },
            );
            // If the turn never materialises (a send that settles in an unusual way), let the pending
            // state expire rather than hide an unrelated later message.
            window.setTimeout(function () {
                if (pendingRetractBefore !== null) {
                    pendingRetractBefore = null;
                    pendingRetractText = null;
                }
            }, 30000);
        }
    }

    function retractLastMessage() {
        var s = activeSession();
        if (!s) return toast('No active session.');
        if (!(s.busy && s.busy.value)) { doRetract(s); return; }

        // A turn is streaming. Retracting mid-stream is unsafe, but not because anything would break
        // here — the failure is downstream: the instruction would be appended while the old response
        // is still finalising, so the "first assistant message after the instruction" scan would find
        // that old response instead of the instruction's own answer, and the instruction's answer
        // could not be hidden. So the running turn is interrupted first (the same session.interrupt
        // the stop button and Escape use), then the retract waits for the partial response to settle
        // into messages.value before proceeding. busy clears when the CLI's result arrives, so polling
        // it is the ground truth; the timer bounds the wait in case the CLI never answers.
        if (typeof s.interrupt !== 'function') { toast('Wait for the current response before retracting.'); return; }
        try { s.interrupt(); } catch (err) { toast('Wait for the current response before retracting.'); return; }
        toast('Stopping the current response…');
        var waited = 0;
        (function poll() {
            if (s.busy && s.busy.value === false) { doRetract(s); return; }
            waited += 150;
            if (waited >= 10000) {
                toast('Could not stop the current response in time — retract again once it finishes.');
                return;
            }
            window.setTimeout(poll, 150);
        })();
    }

    // Three jobs, called from the DOM observer and from ccx:state. First it accounts for the retract's
    // own turns — the hidden "ignore it" instruction, then the assistant's answer to it — by finding
    // their uuids in messages.value the moment they appear; then it hides every message whose uuid is
    // in the set. Hiding rides on a data attribute rather than inline style, the same way the
    // timestamps do — an assistant bubble keeps re-rendering while a turn streams.
    function applyHidden() {
        var s = activeSession();
        var msgs = s && s.messages && s.messages.value;
        if (pendingRetractBefore !== null && Array.isArray(msgs)) {
            for (var fi = pendingRetractBefore; fi < msgs.length; fi++) {
                var m = msgs[fi];
                if (!m || m.type !== 'user' || typeof m.uuid !== 'string') continue;
                // The turn lands exactly where the retract left off; the text check is a backstop for
                // any array reshuffling between the capture and the append.
                if (fi !== pendingRetractBefore && messageText(m) !== pendingRetractText) continue;
                pendingRetractIdx = fi;
                pendingRetractBefore = null;
                pendingRetractText = null;
                pendingRetractResponse = true;
                if (!hiddenUuids.has(m.uuid)) {
                    hiddenUuids.add(m.uuid);
                    persistHidden([m.uuid]);
                }
                break;
            }
        }
        if (pendingRetractResponse && Array.isArray(msgs)) {
            for (var ai = pendingRetractIdx + 1; ai < msgs.length; ai++) {
                var a = msgs[ai];
                if (!a || typeof a.uuid !== 'string') continue;
                if (a.type === 'assistant') {
                    pendingRetractResponse = false;
                    if (!hiddenUuids.has(a.uuid)) {
                        hiddenUuids.add(a.uuid);
                        persistHidden([a.uuid]);
                    }
                    break;
                }
            }
        }
        try {
            var nodes = document.querySelectorAll('[data-testid="assistant-message"], [class*="userMessageContainer_"]');
            var seen = [];
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i];
                var msg = messagePropOf(node);
                if (!msg) continue;
                // Document order puts an ancestor before its descendant, so keeping only the
                // outermost node of each message hides the whole bubble once, the way the timestamp
                // pass keeps the outermost bubble for its label.
                var nested = false;
                for (var j = 0; j < seen.length; j++)
                    if (seen[j].contains(node)) { nested = true; break; }
                if (nested) continue;
                seen.push(node);
                if (msg.uuid && hiddenUuids.has(msg.uuid)) node.setAttribute('data-ccx-hidden', '');
                else node.removeAttribute('data-ccx-hidden');
            }
        } catch (e) {
            /* a message that cannot be hidden is one that stays visible */
        }
    }

    // Ctrl+Shift+Z. In a contenteditable that is redo, so the composer gives redo up for this — undo
    // is untouched, and what redo would restore there is a line of prose. It is a trade, not a free
    // key, which is also why the event is only swallowed when there is actually a message to retract.
    function onRetractKey(e) {
        if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
        if ((e.key || '').toLowerCase() !== 'z') return;
        if (!canRetract()) return;
        e.preventDefault();
        e.stopPropagation();
        retractLastMessage();
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
            if (activeSession()) {
                if (items.length) items.push(menuSeparator());
                items.push(menuItem('Retract last message', retractLastMessage));
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
        window.addEventListener('keydown', onRetractKey, true);
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
        // The context object (class `t_e`) has no route to the session at all — the session is class
        // `MX`, and reading an `activeSession` field off the context was the bug: always undefined, so
        // canCompact() said no and the offer never appeared. It arrives through injection point #4.
        var s = sessionObj;
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

    // --- Search sessions by content ------------------------------------------------------------
    //
    // The stock search box matches only a row's title and git branch, both already sitting in the
    // page. Matching the conversation itself needs the transcript, which the page does not hold for
    // rows outside the active tab — so title/branch matching stays instant and client-side, and a
    // query additionally goes to the host, which greps each visible session's file on disk and
    // reports back which ones actually contain it. The session list patch (injection point #4) hands
    // over the candidate ids and a setter for the result; this only debounces the request and the
    // response, so a fast typist does not fire one lookup per keystroke.
    //
    // Every call clears the previous result immediately, before scheduling anything: without that, a
    // stale Set from the last query would keep matching sessions under the new one for as long as the
    // debounce takes to resolve.
    function onSearchState(setter) {
        searchSetter = setter;
    }

    function onSearchQuery(query, sessionIds) {
        clearTimeout(searchDebounceTimer);
        var mySeq = ++searchSeq;
        if (searchSetter) searchSetter(null);
        var q = (query || '').trim();
        if (!q) return;
        searchDebounceTimer = setTimeout(function () {
            send({ type: 'ccx:searchContent', query: q, sessionIds: sessionIds || [], seq: mySeq });
        }, 250);
    }

    window.__ccx = {
        onRegistry: function (host, jsxFactory, session) {
            // The session is refreshed even when the rest is already wired: this hook fires on every
            // re-registration, and only the first one gets past the guard below.
            if (session) sessionObj = session;
            if (registry || !host || !host.commandRegistry) return;
            ctx = host;
            registry = host.commandRegistry;
            jsx = jsxFactory;
            syncAction();
            syncChip();
        },
        onSearchState: onSearchState,
        onSearchQuery: onSearchQuery,
        onPinState: onPinState,
        pinSort: pinSort,
        retract: retractLastMessage,
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
        // A frame is a block inside the tool-call node, not a floating panel: it has to read as part of
        // that call, and it has to survive the app's own reconciliation of the subtree it sits in.
        '.ccx-agent-frame{margin:4px 0 2px;border:1px solid var(--vscode-widget-border, rgba(128,128,128,.35));border-radius:6px;overflow:hidden;font:11px var(--vscode-font-family)}',
        '.ccx-agent-head{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;background:var(--vscode-editorWidget-background, rgba(128,128,128,.08));user-select:none}',
        '.ccx-agent-head:hover{background:var(--vscode-list-hoverBackground, rgba(128,128,128,.16))}',
        '.ccx-agent-caret{flex:0 0 auto;width:10px;opacity:.6}',
        '.ccx-agent-title{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.95}',
        '.ccx-agent-note{margin-left:auto;flex:0 0 auto;opacity:.55;font-size:10px;white-space:nowrap}',
        // Capped and scrollable rather than free to grow: a long run would otherwise push the rest of
        // the turn off the screen every time it printed a line.
        '.ccx-agent-frame[data-ccx-open="0"] .ccx-agent-body{display:none}',
        '.ccx-agent-body{max-height:220px;overflow:auto;padding:4px 8px 6px;display:flex;flex-direction:column;gap:2px;font-family:var(--vscode-editor-font-family, monospace);font-size:10.5px;line-height:1.45}',
        '.ccx-agent-frame[data-ccx-state="running"] .ccx-agent-caret{opacity:1}',
        '.ccx-agent-tool{opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.ccx-agent-tool::before{content:"> ";opacity:.6}',
        '.ccx-agent-thinking{opacity:.4;font-style:italic}',
        '.ccx-agent-thinking::before{content:"* ";font-style:normal}',
        // The delegated prompt and the agent's own text read differently on purpose: one is what it was
        // asked, the other is what it is saying back.
        '.ccx-agent-prompt{opacity:.5;white-space:pre-wrap;padding-left:8px;border-left:2px solid var(--vscode-widget-border, rgba(128,128,128,.35))}',
        '.ccx-agent-text{opacity:.9;white-space:pre-wrap}',
        // A nested run gets a rule of its own rather than an indent: the lines under it are the work,
        // and burying them a level deep is what made them hard to find in the first place.
        '.ccx-agent-child{margin:4px 0 2px;padding:2px 0 2px 6px;border-left:2px solid var(--vscode-textLink-foreground, currentColor);opacity:.8;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.ccx-agent-child::before{content:"↳ ";font-style:normal;opacity:.7}',
        '.ccx-agent-idle{opacity:.45;font-style:italic}',
        '.ccx-model-effort{display:inline-flex;align-items:center;flex:0 0 auto;padding:0 8px;border-radius:8px;background:var(--vscode-badge-background, transparent);color:var(--vscode-descriptionForeground, var(--vscode-foreground));font:11px var(--vscode-font-family);line-height:18px;opacity:.9;pointer-events:none;user-select:none;white-space:nowrap}',
        // The row is display:flex;align-items:center;gap:8px, so ::before simply becomes its leading flex
        // item and the flex:1 title still ellipsizes. No child node, so nothing for React to reconcile.
        'button[data-ccx-provider]::before{content:"";flex:0 0 auto;width:13px;height:13px;margin-right:-3px;border-radius:3px;background-image:var(--ccx-icon);background-size:contain;background-position:center;background-repeat:no-repeat;opacity:.9}',
        // A fixed slot on every row, hidden rather than absent, so nothing shifts when a row is
        // hovered. Only a pinned row keeps it lit once the pointer leaves.
        '.ccx-pin{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;margin-right:-2px;border-radius:4px;cursor:pointer;visibility:hidden;color:var(--app-secondary-foreground, var(--vscode-descriptionForeground, var(--vscode-foreground)))}',
        'button[class*="sessionItem_"]:hover .ccx-pin,button[class*="sessionItem_"][class*="focused_"] .ccx-pin,.ccx-pin[data-ccx-pinned="1"]{visibility:visible}',
        '.ccx-pin[data-ccx-pinned="1"]{color:var(--app-link-foreground, var(--vscode-textLink-foreground, var(--vscode-foreground)))}',
        '.ccx-pin[data-ccx-pinned="1"] svg{fill:currentColor;fill-opacity:.22}',
        '.ccx-pin:hover{background:var(--app-ghost-button-hover-background, var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)));color:var(--app-primary-foreground, var(--vscode-foreground))}',
        // A gutter, not a line of its own: pinned into the left margin the time sits beside the
        // message's opening line and costs no height at all, which is what the stock tool-call rows
        // already look like — rail, dot, time, content.
        //
        // Note what is NOT here: any ::before or ::after on the message itself. Both slots belong to
        // the app — `.timelineMessage_:before` is the status dot, `.timelineMessage_:after` is the
        // vertical rail (top:18px first in a run, height:18px last, display:none when alone). Writing
        // to either replaces it, which stretched the rail and then lost it. The labels are real child
        // nodes instead, and every stock rule about the rail keeps applying untouched.
        // border-box, so the 84px gutter is carved out of the width the bubble already had instead of
        // being added to it. A user bubble is a shrink-to-fit inline-block (and width:100% in sticky
        // mode) whose inner box is max-width:100%: with content-box sizing the padding grows the whole
        // container past the panel, which pushed the right edge of every user message off screen.
        '[data-ccx-time]{box-sizing:border-box;max-width:100%;padding-left:84px}',
        // Absolute labels keep the stock message layout and timeline untouched. A date-bearing bubble
        // reserves a small header inside itself, so the separator never floats over the previous bubble.
        '.ccx-msg-time{position:absolute;left:24px;top:8px;width:52px;height:1.5em;display:flex;align-items:center;white-space:nowrap;font-size:11px;line-height:1;opacity:.55;font-variant-numeric:tabular-nums;user-select:none;pointer-events:none}',
        '.ccx-msg-date{position:absolute;left:50%;top:4px;transform:translateX(-50%);width:fit-content;max-width:90%;white-space:nowrap;margin:0;padding:2px 10px;border-radius:10px;font-size:11px;text-align:center;opacity:.6;background:var(--vscode-badge-background);user-select:none}',
        // The date occupies this bubble's header; the time then stays beside the first content line.
        '[data-ccx-date]{padding-top:34px}',
        '[data-ccx-date] .ccx-msg-time{top:42px}',
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
        // The composer glyphs are transparent because the app paints a sibling mirror. A Custom Highlight
        // still paints this text decoration in the input layer, without changing React-owned markup.
        '::highlight(ccx-spelling){background-color:rgba(255,85,85,.16);text-decoration-line:underline;text-decoration-style:wavy;text-decoration-color:#ff5555;text-decoration-thickness:1px}',
        // A retracted message (and the hidden "ignore it" turn) is dropped by a data attribute rather
        // than an inline style, so a React re-render of the bubble cannot bring it back.
        '[data-ccx-hidden]{display:none !important}',
    ].join('');
    document.head.appendChild(s);

    send({ type: 'ccx:get' });
    // Listeners go on `document`, which exists before <body> does, so this does not wait for the DOM.
    // It also has to be registered before VS Code's preload hooks the frame, which is why the injected
    // script is a classic inline <script> rather than a module.
    watchSelection();
    if (document.body) {
        syncChip();
        decorateModelAndEffort();
        decorateSessionList();
        decorateTranscript();
        watchComposerSpellcheck();
        watchPicker();
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            syncChip();
            decorateModelAndEffort();
            decorateSessionList();
            decorateTranscript();
            watchComposerSpellcheck();
            watchPicker();
        });
    }
})();