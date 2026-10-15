/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// DOM-free transcript state for the rc-gateway web viewer. A classic script
// (no import/export) so index.html can load it with a plain <script> tag and
// the vitest suite can load it in Node; either way it only assigns
// globalThis.TranscriptModel.
//
// Every operation mirrors the same-named function in index.html, minus the
// DOM: it edits an ordered list of plain item objects and tells subscribers
// what changed. A view renders (and virtualizes) the list.
//
// Events: creating an item emits { type: 'append', item }; later mutations of
// that item emit { type: 'update', item }; any removal, move, cut or clear
// emits { type: 'reset' } (the view re-reads `items`).
(function () {
  'use strict';

  // Strip terminal control chars (the daemon may emit them); keep \n and \t.
  function clean(t) {
    return typeof t === 'string'
      ? // eslint-disable-next-line no-control-regex
        t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      : '';
  }

  function strOr(v, d) {
    return typeof v === 'string' && v ? clean(v) : d;
  }

  var TERMINAL_TOOL_STATUSES = {
    completed: true,
    failed: true,
    cancelled: true,
  };

  function durationLabel(secs) {
    if (secs < 1) return '<1s';
    if (secs < 60) return Math.round(secs) + 's';
    return Math.floor(secs / 60) + 'm' + Math.round(secs % 60) + 's';
  }

  function createTranscriptModel(opts) {
    var now = (opts && opts.now) || Date.now;
    var items = [];
    var listeners = [];
    var nextId = 1;

    var curAsst = null;
    var curThought = null;
    var processingItem = null;
    var forkItem = null;
    var toolIndex = new Map(); // toolCallId -> tool item
    var subagentTypes = new Map(); // parentToolCallId -> child type label
    var subToolIndex = new WeakMap(); // sub -> Map(child toolCallId -> entry)

    // A listener (the view) that throws must never abort the mutation that
    // triggered it: operations assign pointers and edit `items` around their
    // emits, so an escaping error would leave state half-updated (a duplicate
    // assistant item on the next chunk, an orphaned live thought, an
    // uncleareable fork row). So every listener runs, errors are reported out
    // of band (reportError in browsers, console.error elsewhere) rather than
    // rethrown, and emit() itself never throws.
    function reportListenerError(err) {
      try {
        if (typeof globalThis.reportError === 'function')
          globalThis.reportError(err);
        else globalThis.console.error('transcript listener failed', err);
      } catch {
        // reporting must never throw into the model
      }
    }
    function emit(ev) {
      // Copy so a listener may unsubscribe while being notified.
      var ls = listeners.slice();
      for (var i = 0; i < ls.length; i++) {
        try {
          ls[i](ev);
        } catch (err) {
          reportListenerError(err);
        }
      }
    }
    function emitAppend(item) {
      emit({ type: 'append', item: item });
    }
    function emitUpdate(item) {
      emit({ type: 'update', item: item });
    }

    function newItem(kind, fields) {
      var item = { id: nextId++, kind: kind };
      for (var k in fields) item[k] = fields[k];
      return item;
    }
    function push(item) {
      items.push(item);
      emitAppend(item);
      return item;
    }
    // Remove without emitting; returns whether it was present.
    function detach(item) {
      var i = items.lastIndexOf(item);
      if (i < 0) return false;
      items.splice(i, 1);
      return true;
    }

    // ---- Processing indicator --------------------------------------------
    function hideProcessing() {
      var p = processingItem;
      processingItem = null;
      if (p && detach(p)) emit({ type: 'reset' });
    }
    function showProcessing() {
      hideProcessing();
      processingItem = push(newItem('processing', { startedAt: now() }));
    }

    // ---- Thoughts ---------------------------------------------------------
    // A thought block ends when any non-thought frame arrives. Whitespace-only
    // thoughts are dropped; the rest fold to a "Thought for N" header.
    function finishThought() {
      var t = curThought;
      curThought = null;
      if (!t) return;
      if (!t.text.trim()) {
        if (detach(t)) emit({ type: 'reset' });
        return;
      }
      var secs = Math.max(0, (now() - (t.startedAt || now())) / 1000);
      t.live = false;
      t.expanded = false;
      t.durLabel = durationLabel(secs);
      emitUpdate(t);
    }

    function resetTurn() {
      curAsst = null;
      finishThought();
      hideProcessing();
    }

    // ---- Plain rows -------------------------------------------------------
    function addUser(text) {
      resetTurn();
      push(newItem('user', { text: clean(text) }));
    }
    function appendAssistant(text) {
      finishThought();
      if (!curAsst) {
        curAsst = push(newItem('asst', { text: clean(text) }));
        return;
      }
      curAsst.text += clean(text);
      emitUpdate(curAsst);
    }
    function appendThought(text) {
      curAsst = null;
      if (!curThought) {
        curThought = push(
          newItem('thought', {
            text: clean(text),
            startedAt: now(),
            live: true,
            durLabel: null,
            expanded: false,
          }),
        );
        return;
      }
      curThought.text += clean(text);
      emitUpdate(curThought);
    }
    function addSystem(text, err) {
      resetTurn();
      push(newItem('system', { text: clean(text), err: !!err }));
    }

    // ---- Tools and subagents ---------------------------------------------
    function toolLabel(u, id, previous) {
      // A later status-only update may omit title/kind: keep the first name.
      return (
        strOr(u.title, '') || strOr(u.kind, '') || previous || id || 'tool'
      );
    }

    // Parent tool_call always precedes child frames: a parent the model has
    // not seen yields null and the child frame is dropped.
    function subagentOf(parentId) {
      var tool = toolIndex.get(parentId);
      if (!tool) return null;
      if (!tool.sub) {
        tool.sub = {
          startedAt: now(),
          endedAt: null,
          done: false,
          failed: false,
          type: subagentTypes.get(parentId) || '',
          text: '',
          tools: [],
        };
        subToolIndex.set(tool.sub, new Map());
      }
      return tool;
    }

    // Returns the tool item when something changed (caller emits).
    function settle(parentId, status) {
      var tool = toolIndex.get(parentId);
      var s = tool && tool.sub;
      if (!s || s.done) return null;
      s.done = true;
      s.failed = status === 'failed';
      s.endedAt = now();
      return tool;
    }
    function finishSubagent(parentId, status) {
      var tool = settle(parentId, status);
      if (tool) emitUpdate(tool);
    }
    function settleAllSubagents() {
      // A turn can't end while an Agent tool is still in flight: settle any
      // indicator whose terminal update never arrived.
      toolIndex.forEach(function (tool, pid) {
        finishSubagent(pid, 'completed');
      });
    }

    function setSubagentType(parentId, type) {
      var t = strOr(type, '');
      if (!parentId || !t || subagentTypes.has(parentId)) return;
      subagentTypes.set(parentId, t);
      // Only matters when the subagent row already exists without a type.
      var tool = toolIndex.get(parentId);
      if (tool && tool.sub && !tool.sub.type) {
        tool.sub.type = t;
        emitUpdate(tool);
      }
    }

    function appendSubagentText(parentId, text) {
      var tool = subagentOf(parentId);
      if (!tool) return;
      tool.sub.text += clean(text);
      emitUpdate(tool);
    }

    function upsertSubagentTool(u, parentId) {
      var tool = subagentOf(parentId);
      if (!tool) return;
      var id = strOr(u.toolCallId, '');
      var status = strOr(u.status, '');
      var idx = subToolIndex.get(tool.sub);
      var entry = id ? idx.get(id) : null;
      if (!entry) {
        entry = { id: id, label: '', status: '' };
        tool.sub.tools.push(entry);
        if (id) idx.set(id, entry);
      }
      entry.label = toolLabel(u, id, entry.label);
      entry.status = status;
      emitUpdate(tool);
    }

    function upsertTool(u) {
      resetTurn();
      var id = strOr(u.toolCallId, '');
      var status = strOr(u.status, '');
      var tool = id ? toolIndex.get(id) : null;
      if (tool) {
        tool.label = toolLabel(u, id, tool.label);
        tool.status = status;
      } else {
        tool = newItem('tool', {
          toolCallId: id,
          label: toolLabel(u, id, ''),
          status: status,
          sub: null,
        });
        if (id) toolIndex.set(id, tool);
      }
      // The parent agent tool reaching a terminal status settles the nested
      // subagent indicator.
      if (id && TERMINAL_TOOL_STATUSES[status]) settle(id, status);
      if (items.lastIndexOf(tool) < 0) push(tool);
      else emitUpdate(tool);
    }

    // ---- Fork row ---------------------------------------------------------
    function clearFork() {
      var f = forkItem;
      forkItem = null;
      if (f && detach(f)) emit({ type: 'reset' });
    }
    // Idempotent: re-calls for the same turn only re-position the row (a late
    // agent chunk may have started a newer assistant item).
    function placeFork(turn) {
      if (!curAsst || !turn) return;
      if (!forkItem || forkItem.turn !== turn) {
        clearFork();
        forkItem = push(
          newItem('fork', {
            turn: turn,
            mode: 'include',
            note: '',
            busy: false,
          }),
        );
        return;
      }
      var ai = items.lastIndexOf(curAsst);
      if (ai >= 0 && items[ai + 1] !== forkItem) {
        detach(forkItem);
        items.push(forkItem);
        emit({ type: 'reset' });
      }
    }

    // ---- Whole-transcript operations -------------------------------------
    function userTurns() {
      return items.filter(function (i) {
        return i.kind === 'user';
      });
    }

    function dropBookkeeping() {
      toolIndex.clear();
      subagentTypes.clear();
      curAsst = null;
      forkItem = null;
      processingItem = null;
    }

    // Remove the keep-th (0-based) user item and everything after it. Fewer
    // user items than that means nothing to cut. Bookkeeping, the fork row and
    // the processing item are cleared either way.
    function cutAtUserTurn(keep) {
      var users = userTurns();
      var cut = Number.isInteger(keep) && keep >= 0 && users.length > keep;
      if (cut) {
        var at = items.lastIndexOf(users[keep]);
        var dropped = items.splice(at);
        if (curThought && dropped.indexOf(curThought) >= 0) curThought = null;
      }
      var f = forkItem;
      var p = processingItem;
      dropBookkeeping();
      if (f) detach(f);
      if (p) detach(p);
      // A live thought that survived (no cut) folds like any turn reset.
      finishThought();
      emit({ type: 'reset' });
      return cut;
    }

    function clear() {
      items.splice(0, items.length);
      dropBookkeeping();
      curThought = null;
      emit({ type: 'reset' });
    }

    function touch(item) {
      emitUpdate(item);
    }

    function subscribe(fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }

    return {
      items: items,
      get curAsst() {
        return curAsst;
      },
      get forkItem() {
        return forkItem;
      },
      subscribe: subscribe,
      addUser: addUser,
      appendAssistant: appendAssistant,
      appendThought: appendThought,
      finishThought: finishThought,
      addSystem: addSystem,
      upsertTool: upsertTool,
      setSubagentType: setSubagentType,
      appendSubagentText: appendSubagentText,
      upsertSubagentTool: upsertSubagentTool,
      finishSubagent: finishSubagent,
      settleAllSubagents: settleAllSubagents,
      resetTurn: resetTurn,
      showProcessing: showProcessing,
      hideProcessing: hideProcessing,
      placeFork: placeFork,
      clearFork: clearFork,
      userTurns: userTurns,
      cutAtUserTurn: cutAtUserTurn,
      touch: touch,
      clear: clear,
    };
  }

  globalThis.TranscriptModel = {
    clean: clean,
    createTranscriptModel: createTranscriptModel,
  };
})();
