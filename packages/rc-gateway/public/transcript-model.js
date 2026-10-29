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

  // PlanEntryStatus is pending | in_progress | completed (plus failed on the
  // replay path). Only a completed entry leaves the to-do list.
  var PLAN_DONE_STATUSES = { completed: true };

  function durationLabel(secs) {
    if (secs < 1) return '<1s';
    if (secs < 60) return Math.round(secs) + 's';
    return Math.floor(secs / 60) + 'm' + Math.round(secs % 60) + 's';
  }

  // ---- User attachments (#197) ------------------------------------------------
  // A user message can be a content block that is not text: an image or file
  // the sender attached, carried either as a reference into the session's
  // attachment store ({ type, attachmentId, mimeType, size }), as inline bytes,
  // or as a resource link. Read off content.text these all came out empty and
  // drew a blank bubble. This turns one such block into a `part` the view can
  // draw, or null when the block is plain text (or nothing the viewer knows).
  //
  // Raster only for a thumbnail, for the reason addImage gives below: the
  // full-size view is a blob: document on this origin, so a sender-chosen
  // image/svg+xml must never reach it. Anything else is a file chip.
  var PART_IMAGE_TYPES = {
    'image/png': 1,
    'image/jpeg': 1,
    'image/jpg': 1,
    'image/gif': 1,
    'image/webp': 1,
    'image/avif': 1,
    'image/bmp': 1,
  };
  function isRecord(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function b64Bytes(b64) {
    var pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
  }
  function lastSegment(uri) {
    var tail = String(uri).split(/[?#]/)[0].split('/').pop();
    return tail || String(uri);
  }
  function userPartOf(content) {
    if (!isRecord(content)) return null;
    var type = content.type;
    var mime = strOr(content.mimeType, '').toLowerCase();
    var size =
      typeof content.size === 'number' && Number.isFinite(content.size)
        ? Math.max(0, content.size)
        : 0;
    var id = strOr(content.attachmentId, '');
    if (type === 'image' || type === 'resource') {
      if (id) {
        return {
          kind: type === 'image' && PART_IMAGE_TYPES[mime] ? 'image' : 'file',
          name: id,
          attachmentId: id,
          mimeType: mime,
          size: size,
        };
      }
      if (
        type === 'image' &&
        typeof content.data === 'string' &&
        content.data
      ) {
        var okType = !!PART_IMAGE_TYPES[mime];
        return {
          kind: okType ? 'image' : 'file',
          name: 'image',
          mimeType: mime,
          size: b64Bytes(content.data),
          data: okType ? content.data : undefined,
        };
      }
      var r = content.resource;
      if (type === 'resource' && isRecord(r) && typeof r.uri === 'string') {
        var body =
          typeof r.text === 'string'
            ? r.text.length
            : typeof r.blob === 'string'
              ? b64Bytes(r.blob)
              : 0;
        return {
          kind: 'file',
          name: clean(lastSegment(r.uri)),
          mimeType: strOr(r.mimeType, '').toLowerCase(),
          size: body,
        };
      }
      return null;
    }
    if (
      type === 'resource_link' &&
      typeof content.uri === 'string' &&
      content.uri
    ) {
      return {
        kind: 'file',
        name: strOr(content.name, clean(lastSegment(content.uri))),
        mimeType: mime,
        size: size,
      };
    }
    return null;
  }

  // #171. Whatever a user_message_chunk carries that is not text, as a part: a
  // block userPartOf can describe, else a chip that names its type, so a block
  // the viewer has no picture for (audio, a resource it cannot read) still says
  // that something was sent instead of drawing an empty bubble. Text, an empty
  // text and junk are null: the text path owns those.
  function userBlockOf(content) {
    var part = userPartOf(content);
    if (part) return part;
    if (!isRecord(content)) return null;
    var type = typeof content.type === 'string' ? clean(content.type) : '';
    if (!type || type === 'text' || typeof content.text === 'string') {
      return null;
    }
    return {
      kind: 'file',
      name: type + ' block',
      mimeType: strOr(content.mimeType, '').toLowerCase(),
      size: 0,
    };
  }

  // ---- A turn that failed (#199) ---------------------------------------------
  // The daemon publishes turn_error INSTEAD of turn_complete when a prompt
  // fails: a model request that dies mid-stream, a rate limit, a Stop hook that
  // outlasts the daemon's wait. The fields read are data.message and
  // data.errorKind (data.promptId and the envelope's originatorClientId are not
  // needed to draw it). The wording mirrors the attached TUI's turnErrorText
  // (projectDaemonEvent.ts), so a phone and a laptop watching one turn say the
  // same thing.
  function turnErrorText(data) {
    var d = isRecord(data) ? data : {};
    var message = strOr(
      typeof d.message === 'string' ? d.message.trim() : '',
      'unknown error',
    );
    return d.errorKind === 'model_stream_interrupted'
      ? 'The reply stopped: the connection to the model was lost (' +
          message +
          ').'
      : 'The turn failed: ' + message;
  }

  function createTranscriptModel(opts) {
    var now = (opts && opts.now) || Date.now;
    // A stored page is read newest to oldest, so a subagent's child frames can
    // land on a page whose parent Agent call is on an older one. The live model
    // drops those (nothing could ever attach them); the page reducer keeps them
    // so prependItems can attach them when the parent arrives (#202).
    var keepOrphans = !!(opts && opts.keepOrphans);
    var orphanSubs = new Map(); // parentToolCallId -> sub, parent not seen yet
    // Orphans carried by earlier pages that no row on screen has claimed yet.
    var pendingOrphans = new Map();
    var items = [];
    var listeners = [];
    var nextId = 1;

    var curAsst = null;
    var curThought = null;
    var processingItem = null;
    var forkItem = null;
    var planItem = null;
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
    // addUser hands back the item it created: the viewer needs a reference to
    // this exact message to mark it not sent when the POST carrying it turns
    // out to have been rejected.
    function addUser(text, time) {
      resetTurn();
      return push(newItem('user', { text: clean(text), time: time }));
    }
    // #197. One attachment of a user message. It joins the user row it belongs
    // to - the one just above, once the processing row is set aside - so a
    // text-and-picture message is one row, not two, and the rows that count
    // turns (fork, rewind) still see one message. With no user row to join it
    // opens a row of its own, which has no text. Returns { item, merged }.
    function addUserPart(part, time) {
      resetTurn();
      var last = items.length ? items[items.length - 1] : null;
      if (last && last.kind === 'user') {
        last.parts = (last.parts || []).concat([part]);
        emitUpdate(last);
        return { item: last, merged: true };
      }
      var item = push(newItem('user', { text: '', time: time, parts: [part] }));
      return { item: item, merged: false };
    }
    // #171. The text of a user message. The daemon echoes one chunk per block,
    // so a picture sent first opens a text-less row and its caption arrives
    // after it: the caption belongs in that row. Filling a row that already
    // has text would merge two prompts queued back to back, so only a row with
    // parts and no text takes it. Returns { item, merged } like addUserPart.
    function addUserChunk(text, time) {
      resetTurn();
      var last = items.length ? items[items.length - 1] : null;
      if (last && last.kind === 'user' && !last.text && last.parts) {
        last.text = clean(text);
        emitUpdate(last);
        return { item: last, merged: true };
      }
      return {
        item: push(newItem('user', { text: clean(text), time: time })),
        merged: false,
      };
    }
    function appendAssistant(text, time) {
      finishThought();
      var t = clean(text);
      if (!curAsst) {
        // A blank delta must not open a bubble. Every tool frame ends the turn
        // (upsertTool -> resetTurn), so the chunk right after a tool call
        // starts a new item, and the model streams whitespace and control
        // chars as their own chunks: without this guard each tool call leaves
        // an empty row. Same rule finishThought applies to a blank thought.
        // Once a bubble exists the delta is appended as-is, because real text
        // may legitimately be separated by whitespace.
        if (!t.trim()) return;
        // The bubble keeps the time it OPENED at, not the last delta's: this is
        // when the message was sent, and a later chunk must not move it.
        curAsst = push(newItem('asst', { text: t, time: time }));
        return;
      }
      curAsst.text += t;
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

    // #199. A turn that ended in turn_error: what was said so far stays (an
    // open assistant bubble is simply left as it is, a live thought folds, the
    // processing row goes), a subagent still running is settled as failed, and
    // ONE error row says why the turn stopped. `key` names the failure (the
    // prompt id, else the frame id): the same failure delivered twice, by a
    // replay that overlaps the live stream, adds its row once. Returns the row,
    // or null when this failure already has one.
    function failTurn(text, key) {
      resetTurn();
      var last = items.length ? items[items.length - 1] : null;
      if (
        key != null &&
        last &&
        last.kind === 'system' &&
        last.turnError &&
        last.errKey === key
      ) {
        return null;
      }
      toolIndex.forEach(function (tool, pid) {
        finishSubagent(pid, 'failed');
      });
      return push(
        newItem('system', {
          text: clean(text),
          err: true,
          turnError: true,
          errKey: key == null ? null : key,
        }),
      );
    }

    // ---- Assistant images ----------------------------------------------------
    // ACP carries an image the assistant produced as base64 inside the frame,
    // so showing it contacts no host the model names. That is the whole reason
    // this can render while a markdown image stays a hotlink: the rule the
    // viewer enforces is about who gets contacted, not about where bytes came
    // from. The bytes are still model-authored, so the type is checked against
    // a list rather than trusted.
    //
    // Raster only. The full-size view opens a blob: URL in a new tab, and a
    // blob document runs script in the gateway's own origin, so a model-chosen
    // image/svg+xml would be a same-origin script sink.
    var IMAGE_TYPES = {
      'image/png': 1,
      'image/jpeg': 1,
      'image/jpg': 1,
      'image/gif': 1,
      'image/webp': 1,
      'image/avif': 1,
      'image/bmp': 1,
    };

    // One frame must not be able to push an unbounded string into the DOM.
    // 3 MiB of image is above any screenshot the daemon realistically sends.
    var MAX_IMAGE_BYTES = 3 * 1024 * 1024;

    // Exact for valid base64, which is all the wire carries.
    function decodedBytes(b64) {
      var pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
    }

    function sizeLabel(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // The row is always created: a frame the viewer will not draw still says
    // what arrived, rather than leaving the reader to wonder whether the
    // assistant answered at all.
    function addImage(mimeType, data) {
      finishThought();
      // The image is its own row, so text that follows opens the next bubble.
      curAsst = null;
      var mime = strOr(mimeType, '').toLowerCase();
      var b64 = typeof data === 'string' ? data : '';
      var bytes = decodedBytes(b64);
      var item = newItem('image', {
        mime: mime,
        bytes: bytes,
        data: null,
        note: '',
      });
      if (!b64)
        item.note = 'image' + (mime ? ' ' + mime : '') + ' carried no data';
      else if (!IMAGE_TYPES[mime])
        item.note = 'image type ' + mime + ' is not one the viewer opens';
      else if (bytes > MAX_IMAGE_BYTES)
        item.note =
          'image ' +
          sizeLabel(bytes) +
          ' is over the ' +
          sizeLabel(MAX_IMAGE_BYTES) +
          ' limit';
      else item.data = b64;
      push(item);
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
    function newSub(parentId) {
      var sub = {
        startedAt: now(),
        endedAt: null,
        done: false,
        failed: false,
        type: subagentTypes.get(parentId) || '',
        text: '',
        tools: [],
      };
      subToolIndex.set(sub, new Map());
      return sub;
    }
    function subagentOf(parentId) {
      var tool = toolIndex.get(parentId);
      if (!tool) return null;
      if (!tool.sub) tool.sub = newSub(parentId);
      return tool;
    }
    // Where a child frame's text and tools go: the parent's row, or (for a page
    // reducer) a sub held aside for a parent that has not been seen. null when
    // the frame has nowhere to go. `tool` is null for a held-aside sub.
    function holderOf(parentId) {
      var tool = subagentOf(parentId);
      if (tool) return { tool: tool, sub: tool.sub };
      if (!keepOrphans || !parentId) return null;
      var sub = orphanSubs.get(parentId);
      if (!sub) {
        sub = newSub(parentId);
        orphanSubs.set(parentId, sub);
      }
      return { tool: null, sub: sub };
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
      var held = orphanSubs.get(parentId);
      if (held && !held.type) held.type = t;
    }

    function appendSubagentText(parentId, text) {
      var h = holderOf(parentId);
      if (!h) return;
      h.sub.text += clean(text);
      if (h.tool) emitUpdate(h.tool);
    }

    function upsertSubagentTool(u, parentId) {
      var h = holderOf(parentId);
      if (!h) return;
      var id = strOr(u.toolCallId, '');
      var status = strOr(u.status, '');
      var idx = subToolIndex.get(h.sub);
      if (!idx) {
        // A sub built on a page model and merged in: index what it holds.
        idx = new Map();
        h.sub.tools.forEach(function (e) {
          if (e.id) idx.set(e.id, e);
        });
        subToolIndex.set(h.sub, idx);
      }
      var entry = id ? idx.get(id) : null;
      if (!entry) {
        entry = { id: id, label: '', status: '' };
        h.sub.tools.push(entry);
        if (id) idx.set(id, entry);
      }
      entry.label = toolLabel(u, id, entry.label);
      // An update that names no status (a note, a rename) leaves the one the
      // call had; assigning '' made a running child read as not started.
      if (status) entry.status = status;
      if (h.tool) emitUpdate(h.tool);
    }

    // The call itself and what came back, kept verbatim for the view to render
    // when the row is expanded (#64). A start frame carries rawInput and an
    // empty content; a result frame carries content, or rawOutput when there is
    // no content; a status-only frame carries neither, so it must not clear what
    // is already there. An empty content is not a result: treating it as one
    // would leave every pending call showing an empty output.
    function toolResult(u) {
      if (Array.isArray(u.content) && u.content.length > 0) return u.content;
      return u.rawOutput === undefined ? undefined : u.rawOutput;
    }

    function upsertTool(u) {
      resetTurn();
      var id = strOr(u.toolCallId, '');
      var status = strOr(u.status, '');
      var input = u.rawInput;
      var result = toolResult(u);
      var tool = id ? toolIndex.get(id) : null;
      if (tool) {
        tool.label = toolLabel(u, id, tool.label);
        // #171: every Agent tool gets a status-less update
        // (subagentSessionReady); taking '' from it dropped [in_progress] for
        // the whole subagent run.
        if (status) tool.status = status;
        if (input !== undefined) tool.input = input;
        if (result !== undefined) tool.result = result;
      } else {
        tool = newItem('tool', {
          toolCallId: id,
          label: toolLabel(u, id, ''),
          status: status,
          sub: null,
          expanded: false,
        });
        if (input !== undefined) tool.input = input;
        if (result !== undefined) tool.result = result;
        if (id) toolIndex.set(id, tool);
        // Child frames that came before their parent's row on this page.
        var early = id ? orphanSubs.get(id) : undefined;
        if (early) {
          tool.sub = early;
          orphanSubs.delete(id);
        }
      }
      // The parent agent tool reaching a terminal status settles the nested
      // subagent indicator.
      if (id && TERMINAL_TOOL_STATUSES[status]) settle(id, status);
      if (items.lastIndexOf(tool) < 0) push(tool);
      else emitUpdate(tool);
    }

    // ---- To-do list (plan frames) ------------------------------------------
    // The daemon re-emits the whole list every time it changes, so this upserts
    // one row instead of leaving a block per frame (#65). A completed entry
    // leaves the visible list the way the CLI drops it, while the totals stay so
    // progress is still legible. Only 'completed' leaves: the replay path can
    // also carry 'failed', and dropping that would hide the one entry most worth
    // reading.
    function planTally(entries) {
      var open = [];
      var done = 0;
      for (var i = 0; i < entries.length; i++) {
        var text = entries[i] ? strOr(entries[i].content, '') : '';
        if (!text) continue;
        var status = strOr(entries[i].status, '');
        if (PLAN_DONE_STATUSES[status]) done++;
        else open.push({ text: text, status: status });
      }
      return { open: open, done: done, total: open.length + done };
    }

    // A frame that is empty or malformed changes nothing, so a session that
    // never plans never grows the row.
    function setPlan(entries) {
      if (!Array.isArray(entries) || entries.length === 0) return;
      var t = planTally(entries);
      if (t.total === 0) return;
      // Like every other row, a plan closes the thought before it: left open,
      // that thought kept timing until the next unrelated frame.
      finishThought();
      if (!planItem) {
        planItem = push(
          newItem('plan', { open: t.open, done: t.done, total: t.total }),
        );
        return;
      }
      planItem.open = t.open;
      planItem.done = t.done;
      planItem.total = t.total;
      emitUpdate(planItem);
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
      planItem = null;
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
      var pl = planItem;
      dropBookkeeping();
      if (f) detach(f);
      if (p) detach(p);
      // The to-do row is live state, but a rewind that never reached it leaves
      // it standing: keep pointing at it, or the next frame would push a second
      // row under the old one. If the cut did drop it, stay null and let the
      // next frame start a fresh one.
      if (pl && items.lastIndexOf(pl) >= 0) planItem = pl;
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

    // ---- Splicing stored history in front (#171) ---------------------------
    // Pages are read newest to oldest and each is reduced on a model of its
    // own, so three things a single pass would have handled are settled here,
    // where the rows meet the ones already on screen.
    //
    // A page can overlap what is drawn: the resume draws the replay, and the
    // first page asked for is the newest one, which that replay already holds.
    // Rows carry no record id the page could compare, so a run of rows at the
    // END of the page that equals a run already on screen is the same records.
    // A single row is not proof (a user who typed "yes" twice has two), so a
    // lone row only counts when it is the whole page.
    function rowKey(r) {
      switch (r.kind) {
        case 'user':
          return 'u|' + r.text + '|' + (r.parts ? r.parts.length : 0);
        case 'asst':
          return 'a|' + r.text;
        case 'thought':
          return 't|' + r.text;
        case 'system':
          return 's|' + r.text;
        case 'image':
          return 'i|' + r.mime + '|' + r.bytes;
        case 'tool':
          return r.toolCallId ? 'T|' + r.toolCallId : null;
        default:
          return null;
      }
    }
    // A tool row built from an update whose call is on another page: named by
    // its raw id, because nothing told it a title.
    function nameless(t) {
      return !t.label || t.label === 'tool' || t.label === t.toolCallId;
    }
    // Give a nameless row what the call's own row knows. The row already on
    // screen is the later one, so its status and result stand.
    // Fold a subagent's earlier frames (`from`, the older page) into the one
    // already held (`into`). The same frames can sit in both when a page
    // overlaps the live replay, so text `into` already holds is not doubled and
    // a child call is matched by its id.
    function mergeSub(into, from) {
      if (!from || from === into) return into;
      if (from.text && into.text.indexOf(from.text) < 0)
        into.text = from.text + into.text;
      var known = {};
      into.tools.forEach(function (t) {
        if (t.id) known[t.id] = t;
      });
      var older = [];
      from.tools.forEach(function (t) {
        var have = t.id ? known[t.id] : null;
        if (!have) older.push(t);
        else if (!have.label && t.label) have.label = t.label;
      });
      into.tools.splice.apply(into.tools, [0, 0].concat(older));
      subToolIndex.delete(into);
      if (!into.type) into.type = from.type;
      if (from.startedAt < into.startedAt) into.startedAt = from.startedAt;
      if (from.done && !into.done) {
        into.done = true;
        into.failed = from.failed;
        into.endedAt = from.endedAt;
      }
      return into;
    }
    function fillTool(into, from) {
      if (nameless(into) && !nameless(from)) into.label = from.label;
      if (into.input === undefined && from.input !== undefined)
        into.input = from.input;
      if (into.result === undefined && from.result !== undefined)
        into.result = from.result;
      if (!into.status && from.status) into.status = from.status;
      if (!into.sub && from.sub) into.sub = from.sub;
      else if (into.sub && from.sub) mergeSub(into.sub, from.sub);
    }
    // A user message split by a page boundary: the older page ends in the first
    // part of it, the row already on screen opens with the rest. The same two
    // shapes the live path joins (addUserPart, addUserChunk): a picture opening
    // a row of its own, or a caption arriving after a text-less picture row.
    function joinsAcross(last, first) {
      if (!last || !first || last.kind !== 'user' || first.kind !== 'user')
        return false;
      var lp = last.parts && last.parts.length;
      var fp = first.parts && first.parts.length;
      if (!first.text && fp) return true;
      return !!(first.text && !fp && !last.text && lp);
    }
    function absorb(last, first) {
      first.text = last.text || first.text;
      first.parts = (last.parts || []).concat(first.parts || []);
      if (typeof last.time === 'number') first.time = last.time;
      emitUpdate(first);
    }
    // Hand the child frames a newer page held for parents it did not have to
    // whichever row on screen is their parent, or keep them for a later page.
    function takeOrphans(orphans) {
      if (!orphans) return;
      for (var i = 0; i < orphans.length; i++) {
        var id = orphans[i].id;
        var sub = orphans[i].sub;
        var row = null;
        for (var k = 0; k < items.length && !row; k++) {
          if (items[k].kind === 'tool' && items[k].toolCallId === id)
            row = items[k];
        }
        if (row) {
          if (row.sub) mergeSub(row.sub, sub);
          else row.sub = sub;
          emitUpdate(row);
        } else if (pendingOrphans.has(id)) {
          mergeSub(pendingOrphans.get(id), sub);
        } else {
          pendingOrphans.set(id, sub);
        }
      }
    }
    // A row arriving on an older page may be the parent of held child frames.
    function claimOrphans(list) {
      if (!pendingOrphans.size) return;
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.kind !== 'tool' || !r.toolCallId) continue;
        var held = pendingOrphans.get(r.toolCallId);
        if (!held) continue;
        pendingOrphans.delete(r.toolCallId);
        r.sub = r.sub ? mergeSub(held, r.sub) : held;
      }
    }
    // Two rows are the same record unless both know when they were sent and
    // the times differ: a chat of "continue" and "ok" repeats its words, not
    // its minutes. A row with no time (the live replay stamps from the
    // envelope, which a stored page does not carry) cannot tell, so the words
    // decide.
    function sameRow(a, b) {
      var k = rowKey(a);
      if (k === null || k !== rowKey(b)) return false;
      return !(
        typeof a.time === 'number' &&
        typeof b.time === 'number' &&
        a.time !== b.time
      );
    }
    function sameRun(list, from, at) {
      for (var j = 0; j < list.length - from; j++) {
        if (!sameRow(list[from + j], items[at + j])) return false;
      }
      return true;
    }
    function trimOverlap(list) {
      for (var from = 0; from < list.length; from++) {
        var left = list.length - from;
        if (left < 2 && list.length > 1) break;
        var first = rowKey(list[from]);
        if (first === null) continue;
        for (var at = 0; at + left <= items.length; at++) {
          if (rowKey(items[at]) !== first || !sameRun(list, from, at)) continue;
          for (var j = 0; j < left; j++) {
            var on = items[at + j];
            if (on.kind === 'tool') {
              fillTool(on, list[from + j]);
              emitUpdate(on);
            }
          }
          return list.slice(0, from);
        }
      }
      return list;
    }

    // Stored history is built by a throwaway model, so its items carry that
    // model's ids. Re-key from this model's counter before splicing: the view
    // keys rows on item.id, and a duplicate key makes the virtualizer hand one
    // mounted row to two different items.
    //
    // `beforeSplice` runs only when rows will actually go in, just before they
    // do (the page anchors the reader there; anchoring for a splice that adds
    // nothing would leave a hold behind). Returns the number of rows added.
    function prependItems(list, beforeSplice) {
      var orphans = list && list.orphans;
      if (list && list.length) claimOrphans(list);
      takeOrphans(orphans);
      if (!list || !list.length) return 0;
      // The page's to-do list is older than the one on screen: the daemon
      // re-emits the whole list on every change, so only the newest stands.
      var havePlan = items.some(function (i) {
        return i.kind === 'plan';
      });
      list = list.filter(function (r) {
        return !(havePlan && r.kind === 'plan');
      });
      list = trimOverlap(list);
      // A call whose result is already on screen under its raw id: the row on
      // screen is adopted into the call's place, so it keeps its id and the
      // live updates that find it by tool id still reach it. A call already
      // drawn under its own name is just the same call twice.
      var adopted = [];
      var fresh = [];
      for (var n = 0; n < list.length; n++) {
        var r = list[n];
        var at = -1;
        if (r.kind === 'tool' && r.toolCallId) {
          for (var k = 0; k < items.length; k++) {
            if (
              items[k].kind === 'tool' &&
              items[k].toolCallId === r.toolCallId
            ) {
              at = k;
              break;
            }
          }
        }
        if (at < 0) {
          fresh.push(r);
          continue;
        }
        var on = items[at];
        var wasNameless = nameless(on);
        fillTool(on, r);
        if (wasNameless) {
          items.splice(at, 1);
          adopted.push(on);
          fresh.push(on);
        } else {
          emitUpdate(on);
        }
      }
      list = fresh;
      if (!list.length) return 0;
      var joins = joinsAcross(list[list.length - 1], items[0]);
      if (beforeSplice) beforeSplice();
      if (joins) {
        absorb(list[list.length - 1], items[0]);
        list = list.slice(0, -1);
        if (!list.length) return 0;
      }
      for (var i = 0; i < list.length; i++) {
        if (adopted.indexOf(list[i]) < 0) list[i].id = nextId++;
      }
      // Mutate in place. The view binds `var items = model.items` once, so a
      // reassigned array would leave it rendering a list the model no longer
      // holds.
      items.splice(0, 0, ...list);
      emit({ type: 'reset' });
      return list.length;
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
      get planItem() {
        return planItem;
      },
      subscribe: subscribe,
      addUser: addUser,
      addUserPart: addUserPart,
      addUserChunk: addUserChunk,
      appendAssistant: appendAssistant,
      appendThought: appendThought,
      finishThought: finishThought,
      addSystem: addSystem,
      failTurn: failTurn,
      addImage: addImage,
      setPlan: setPlan,
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
      prependItems: prependItems,
      heldSubagents: function () {
        var out = [];
        orphanSubs.forEach(function (sub, id) {
          out.push({ id: id, sub: sub });
        });
        return out;
      },
    };
  }

  // ---- Stored history (GET /session/:id/transcript) --------------------------
  // A stored page carries the same DaemonEvent envelope as the live stream, so
  // its frames already have the shape the viewer understands. They must not go
  // through the page's frame handler: that handler also drives live-only state
  // (the token footer, the processing indicator, the turn counters and the
  // scroll pin), and replaying old frames moves every one of them out from
  // under a reader who may be mid-turn. The load response can make that same
  // call only because clearTranscript() zeroes that state first.
  //
  // So stored frames are reduced here against a throwaway model and the caller
  // splices the result in front of the live items. Row shapes stay identical
  // because both paths drive the same operations above.
  //
  // user_message_chunk is drawn here and skipped by the live path, where the
  // prompt is echoed locally at send time: a stored page carries no echo, so
  // the reader's own messages only appear if this reducer draws them.
  //
  // The clock rides the same two ways. The live stream and the WAL stamp the
  // ENVELOPE (`_meta.serverTimestamp`); the daemon's stored page stamps the
  // update itself, as `_meta.timestamp` (epoch ms, from the record's own time):
  // on `data` for the flat shape, on `data.update` for the nested one. Reading
  // only the envelope drew every stored row without a time and folded every
  // historical thought to <1s (#171).
  function epochOf(t) {
    if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
    if (typeof t === 'string' && t) {
      var ms = Date.parse(t);
      return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
  }
  function stampOf(ev) {
    if (!isRecord(ev)) return 0;
    var at = epochOf(isRecord(ev._meta) && ev._meta.serverTimestamp);
    if (at) return at;
    var data = ev.data;
    if (!isRecord(data)) return 0;
    var inner = isRecord(data.update) ? data.update : data;
    var metas = [inner._meta, data._meta];
    for (var i = 0; i < metas.length; i++) {
      if (!isRecord(metas[i])) continue;
      at = epochOf(metas[i].timestamp) || epochOf(metas[i].serverTimestamp);
      if (at) return at;
    }
    return 0;
  }

  // The update rides two ways on a stored page: nested under data.update the way
  // a live frame carries it, or spread onto data itself. The SDK reads
  // data.update first and falls back to data (DaemonSessionClient.hydrateEvent),
  // so mirror that order rather than picking one; reading only the nested form
  // silently draws no rows from a flat page.
  function storedUpdate(ev) {
    var data = ev.data;
    if (!data || typeof data !== 'object') return null;
    var nested = data.update;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested;
    }
    return typeof data.sessionUpdate === 'string' ? data : null;
  }

  function applyStoredFrame(m, ev) {
    if (!ev || typeof ev !== 'object') return;
    // #199: a failed turn's terminal draws the same error row a live one does.
    if (ev.type === 'turn_error') {
      var d = isRecord(ev.data) ? ev.data : {};
      return m.failTurn(
        turnErrorText(d),
        typeof d.promptId === 'string' && d.promptId ? d.promptId : ev.id,
      );
    }
    if (ev.type !== 'session_update') return;
    var u = storedUpdate(ev);
    if (!u) return;
    var su = u.sessionUpdate;
    var text = u.content && u.content.text;
    var sentAt = stampOf(ev) || undefined;
    // Child frames belong to the parent Agent tool's row, not the transcript.
    var parentId =
      u._meta && typeof u._meta.parentToolCallId === 'string'
        ? u._meta.parentToolCallId
        : '';
    if (parentId) {
      m.setSubagentType(parentId, u._meta.subagentType);
      if (su === 'agent_message_chunk' && text)
        m.appendSubagentText(parentId, text);
      else if (su === 'tool_call' || su === 'tool_call_update')
        m.upsertSubagentTool(u, parentId);
      return;
    }
    if (su === 'user_message_chunk') {
      var part = userBlockOf(u.content);
      if (part) return m.addUserPart(part, sentAt);
      // A frame with nothing to say draws nothing (it was an empty bubble).
      if (typeof text !== 'string' || !text) return;
      return m.addUserChunk(text, sentAt);
    }
    if (su === 'agent_message_chunk') {
      if (u.content && u.content.type === 'image')
        return m.addImage(u.content.mimeType, u.content.data);
      if (text) m.appendAssistant(text, sentAt);
      return;
    }
    if (su === 'agent_thought_chunk' && text) return m.appendThought(text);
    if (su === 'tool_call' || su === 'tool_call_update') return m.upsertTool(u);
    if (su === 'plan') return m.setPlan(u.entries);
  }

  // Returns the rows one stored page renders, oldest first, built on a model
  // nothing else holds. The caller hands these to prependItems, which re-keys
  // them; the ids minted here are only ever this model's own.
  function replayStoredPage(events) {
    var list = Array.isArray(events) ? events : [];
    // A thought folds to a "Thought for Ns" header from the clock, and a stored
    // page brings no clock of its own: Date.now would date every historical
    // thought at the moment of the read and fold it to <1s. Feed the reducer
    // the frames' own timestamps instead, so the duration is the one the run
    // actually took.
    var stamp = 0;
    var m = createTranscriptModel({
      now: function () {
        return stamp || Date.now();
      },
      keepOrphans: true,
    });
    for (var i = 0; i < list.length; i++) {
      var t = stampOf(list[i]);
      if (t > stamp) stamp = t;
      applyStoredFrame(m, list[i]);
    }
    // The page can end inside a thought, which nothing then closes: on the live
    // path the next non-thought frame folds it.
    m.finishThought();
    // Child frames whose parent call is on an older page ride along, out of the
    // way of the rows (non-enumerable: a page compares and spreads as its rows).
    var orphans = m.heldSubagents();
    if (orphans.length)
      Object.defineProperty(m.items, 'orphans', { value: orphans });
    return m.items;
  }

  globalThis.TranscriptModel = {
    clean: clean,
    createTranscriptModel: createTranscriptModel,
    replayStoredPage: replayStoredPage,
    // The send time of one frame as the viewer reads it, or undefined (#202).
    frameStamp: function (ev) {
      return stampOf(ev) || undefined;
    },
    turnErrorText: turnErrorText,
    userPartOf: userPartOf,
    userBlockOf: userBlockOf,
  };
})();
