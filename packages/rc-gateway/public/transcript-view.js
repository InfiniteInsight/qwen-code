/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Renderer for the rc-gateway web viewer's transcript. A classic script (no
// import/export) loaded with a plain <script> tag; it only assigns
// globalThis.TranscriptView.
//
// The model (transcript-model.js) owns the ordered list of items; the view
// renders it into a scroll container. With a virtual-core bundle it mounts
// only the rows near the viewport (a `.vsizer` holding absolutely positioned
// `.vrow`s); with `virtualCore: null` it renders every item in normal flow.
// Each row holds exactly the bubble DOM the page's stylesheet expects
// (`.bubble.user`, `.thought-head`, `.subagent-head`, ...). Structural styles
// (sizer, rows) are inline; cosmetics stay in the page's CSS.
//
// All DOM writes happen in one requestAnimationFrame pass: model events only
// record what changed. Every piece of UI state a row shows (thought expanded,
// fork mode, subagent end time) lives on the item, so a row can be dropped
// and rebuilt at any time.
(function () {
  'use strict';

  var NEAR_BOTTOM_PX = 80;
  // After a finger that moved the transcript lifts, iOS may keep scrolling
  // (momentum); virtual-core waits this long before treating it as settled.
  var GESTURE_TAIL_MS = 150;
  var ROW_FLOW = 'display:flex;flex-direction:column;';
  var ROW_VIRTUAL =
    'position:absolute;top:0;left:8px;right:8px;' +
    ROW_FLOW +
    'transform:translateY(0px);';
  var ROW_PLAIN = ROW_FLOW + 'margin:8px;';
  var TEXT_ROLES = {
    user: 'you',
    asst: 'assistant',
    'thought-live': 'thinking',
  };

  function clock(secs) {
    return secs >= 60
      ? Math.floor(secs / 60) + 'm' + (secs % 60) + 's'
      : secs + 's';
  }
  function elapsed(from, to) {
    return clock(Math.max(0, Math.floor((to - from) / 1000)));
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }
  // Streaming path: append only the new tail to the existing text node.
  function syncTextNode(ref, text) {
    if (text === ref.text) return;
    if (text.length > ref.text.length && text.startsWith(ref.text)) {
      ref.node.appendData(text.slice(ref.text.length));
    } else {
      ref.node.data = text;
    }
    ref.text = text;
  }
  function textRef(text) {
    return { node: document.createTextNode(text), text: text };
  }
  function lineCount(text, perLine) {
    return Math.max(1, Math.ceil((text ? text.length : 0) / perLine));
  }

  function shapeOf(item) {
    if (item.kind === 'thought') {
      return item.durLabel == null ? 'thought-live' : 'thought';
    }
    return item.kind;
  }
  // Items with a running clock: the processing row and unfinished subagents.
  function isLive(item) {
    return (
      item.kind === 'processing' ||
      (item.kind === 'tool' && !!item.sub && !item.sub.done)
    );
  }

  function createTranscriptView(opts) {
    var model = opts.model;
    var scroller = opts.scroller;
    var core =
      opts.virtualCore && typeof opts.virtualCore.Virtualizer === 'function'
        ? opts.virtualCore
        : null;
    var items = model.items;

    var mounted = new Map(); // item.id -> row entry
    var dirty = new Set(); // ids of mounted rows to patch
    var live = new Set(); // items whose time text ticks
    var timer = null;
    var clocksDue = false;
    var pendingEnd = false; // scrollToEnd() requested
    var rafId = 0;
    var destroyed = false;

    var nearBottom = gapPx() < NEAR_BOTTOM_PX;
    // Re-pin after the next pass: content changed while near the bottom.
    var follow = nearBottom;
    // A user expand/collapse of a thought: { item, top } where `top` is the
    // clicked header's offset in the viewport. The next pass keeps it there.
    var hold = null;
    var quiet = false; // the current model event is that toggle's own touch

    // ---- Bubbles ----------------------------------------------------------

    function buildText(m) {
      var item = m.item;
      var b = el('div', 'bubble ' + item.kind);
      b.appendChild(el('div', 'role', TEXT_ROLES[m.shape]));
      var body = el('span');
      m.body = textRef(item.text);
      body.appendChild(m.body.node);
      b.appendChild(body);
      return b;
    }

    function buildThought(m) {
      var item = m.item;
      var b = el('div', 'bubble thought');
      m.head = el('span', 'thought-head');
      m.thoughtBody = el('span', 'thought-body', item.text);
      // Like the old head.onclick: the header stays where it is and the
      // body opens (or closes) below it; this never scrolls to the bottom.
      m.head.addEventListener('click', function () {
        hold = { item: item, top: viewportTop(m.head) };
        item.expanded = !item.expanded;
        quiet = true;
        try {
          model.touch(item);
        } finally {
          quiet = false;
        }
      });
      b.appendChild(m.head);
      b.appendChild(m.thoughtBody);
      patchThought(m);
      return b;
    }
    function patchThought(m) {
      var item = m.item;
      var hidden = !item.expanded;
      if (m.thoughtBody.hidden !== hidden) m.thoughtBody.hidden = hidden;
      setText(
        m.head,
        '∴ Thought for ' + item.durLabel + (hidden ? ' ▸' : ' ▾'),
      );
      setText(m.thoughtBody, item.text);
    }

    function buildTool(m, now) {
      var b = el('div', 'bubble tool');
      m.bubble = b;
      m.toolBody = el('span');
      m.toolLabel = document.createTextNode('');
      m.toolBody.appendChild(m.toolLabel);
      b.appendChild(m.toolBody);
      m.st = null;
      m.sub = null;
      patchTool(m, now);
      return b;
    }
    function patchTool(m, now) {
      var item = m.item;
      var label = '🔧 ' + item.label;
      if (m.toolLabel.data !== label) m.toolLabel.data = label;
      if (item.status) {
        if (!m.st) {
          m.st = el('span', 'st');
          m.toolBody.appendChild(m.st);
        }
        setText(m.st, '  [' + item.status + ']');
      } else if (m.st) {
        m.st.remove();
        m.st = null;
      }
      if (item.sub) {
        if (!m.sub) m.sub = buildSub(m.bubble);
        patchSub(m.sub, item.sub, now);
      }
    }

    // Subagent activity nested in the parent tool bubble: head (status, live
    // timer), the child's text, then its tool rows.
    function buildSub(bubble) {
      var host = el('div', 'subagent');
      var head = el('div', 'subagent-head');
      var r = {
        host: host,
        head: head,
        spin: el('span'),
        msg: el('span'),
        time: el('span', 'subagent-time'),
        text: null,
        textBody: null,
        tools: [],
      };
      head.appendChild(r.spin);
      head.appendChild(r.msg);
      head.appendChild(r.time);
      host.appendChild(head);
      bubble.appendChild(host);
      return r;
    }
    function subDuration(s, now) {
      // A finished run shows a fixed duration (endedAt), so a row rebuilt
      // later reads the same as when it finished.
      return elapsed(
        s.startedAt,
        s.done && s.endedAt != null ? s.endedAt : now,
      );
    }
    function patchSubClock(r, s, now) {
      setText(r.time, ' · ' + subDuration(s, now));
    }
    function patchSub(r, s, now) {
      var who = s.type ? 'subagent ' + s.type + ' ' : 'subagent ';
      if (s.done) {
        setText(r.spin, s.failed ? '✖ ' : '✔ ');
        setText(
          r.msg,
          who + (s.failed ? 'failed' : 'done') + ' in ' + subDuration(s, now),
        );
      } else {
        setText(r.spin, '⏳ ');
        setText(r.msg, who + 'running');
      }
      patchSubClock(r, s, now);
      if (s.text && !r.text) {
        r.text = el('div', 'subagent-text');
        r.textBody = textRef('');
        r.text.appendChild(r.textBody.node);
        r.host.insertBefore(r.text, r.head.nextSibling);
      }
      if (r.text) syncTextNode(r.textBody, s.text);
      for (var i = 0; i < s.tools.length; i++) {
        var t = s.tools[i];
        if (!r.tools[i]) {
          r.tools[i] = el('div', 'subtool');
          r.host.appendChild(r.tools[i]);
        }
        setText(
          r.tools[i],
          '🔧 ' + t.label + (t.status ? '  [' + t.status + ']' : ''),
        );
      }
    }

    function buildProcessing(m, now) {
      var b = el('div', 'bubble processing');
      b.appendChild(el('span', 'proc-spin', '⏳ '));
      b.appendChild(el('span', null, 'thinking'));
      m.time = el('span', 'proc-time');
      b.appendChild(m.time);
      patchProcessing(m, now);
      return b;
    }
    function patchProcessing(m, now) {
      setText(m.time, ' · ' + elapsed(m.item.startedAt, now));
    }

    function buildSystem(m) {
      var b = el('div');
      patchSystem(m, b);
      return b;
    }
    function patchSystem(m, b) {
      var cls = 'system' + (m.item.err ? ' err' : '');
      if (b.className !== cls) b.className = cls;
      setText(b, m.item.text);
    }

    // "Fork from here" under a completed assistant turn. The view only
    // reports clicks; the page writes busy/note back and touches the item.
    function buildFork(m) {
      var item = m.item;
      var b = el('div', 'bubble-fork');
      m.btn = el('button', null, 'Fork from here');
      m.btn.type = 'button';
      m.mode = el('select');
      m.mode.title = 'transcript mode for the fork';
      ['include', 'empty'].forEach(function (val) {
        var o = el('option', null, val);
        o.value = val;
        m.mode.appendChild(o);
      });
      m.note = el('span');
      m.note.style.cssText = 'color:#9aa0a6;font-size:0.72rem;margin-left:6px';
      m.btn.addEventListener('click', function () {
        if (opts.onFork) opts.onFork(item);
      });
      m.mode.addEventListener('change', function () {
        item.mode = m.mode.value;
        if (opts.onForkMode) opts.onForkMode(item, m.mode.value);
      });
      b.appendChild(m.btn);
      b.appendChild(m.mode);
      b.appendChild(m.note);
      patchFork(m);
      return b;
    }
    function patchFork(m) {
      var item = m.item;
      var busy = !!item.busy;
      if (m.btn.disabled !== busy) m.btn.disabled = busy;
      if (item.mode && m.mode.value !== item.mode) m.mode.value = item.mode;
      setText(m.note, item.note || '');
    }

    var BUILD = {
      user: buildText,
      asst: buildText,
      'thought-live': buildText,
      thought: buildThought,
      tool: buildTool,
      processing: buildProcessing,
      system: buildSystem,
      fork: buildFork,
    };

    function build(m, now) {
      var old = m.bubble;
      m.shape = shapeOf(m.item);
      var make = BUILD[m.shape] || buildSystem;
      m.bubble = make(m, now);
      if (old) m.row.replaceChild(m.bubble, old);
      else m.row.appendChild(m.bubble);
    }

    function patch(m, now) {
      if (shapeOf(m.item) !== m.shape) return build(m, now);
      switch (m.shape) {
        case 'user':
        case 'asst':
        case 'thought-live':
          return syncTextNode(m.body, m.item.text);
        case 'thought':
          return patchThought(m);
        case 'tool':
          return patchTool(m, now);
        case 'processing':
          return patchProcessing(m, now);
        case 'fork':
          return patchFork(m);
        default:
          return patchSystem(m, m.bubble);
      }
    }

    // Only the ticking text of live rows (the shared 1 s interval). Rows
    // written to are added to `written`.
    function patchClocks(now, written) {
      live.forEach(function (item) {
        var m = mounted.get(item.id);
        if (!m || m.shape !== shapeOf(item)) return;
        if (item.kind === 'processing') patchProcessing(m, now);
        else if (m.sub && item.sub) patchSubClock(m.sub, item.sub, now);
        else return;
        written.push(m);
      });
    }

    function mount(item, now) {
      var row = el('div', 'vrow');
      row.style.cssText = virtualizer ? ROW_VIRTUAL : ROW_PLAIN;
      row.setAttribute('data-id', String(item.id));
      var m = {
        item: item,
        row: row,
        bubble: null,
        shape: '',
        index: -1,
        y: 0,
      };
      build(m, now);
      mounted.set(item.id, m);
      return m;
    }
    function unmount(id) {
      var m = mounted.get(id);
      mounted.delete(id);
      dirty.delete(id);
      m.row.remove();
    }

    // ---- Container ----------------------------------------------------------

    var host;
    var virtualizer = null;
    var vopts = null;
    var unmountVirtualizer = null;
    var savedOverflowAnchor = '';

    // Rough per-kind heights for rows never measured yet (wrapped text at
    // ~8 px per character of the bubble width, ~21 px per line).
    function estimate(item) {
      if (!item) return 40;
      var rect = virtualizer && virtualizer.scrollRect;
      var width = rect && rect.width ? rect.width : 600;
      var perLine = Math.max(16, Math.floor(((width - 16) * 0.92 - 20) / 8));
      switch (item.kind) {
        case 'user':
        case 'asst':
          return 38 + 21 * lineCount(item.text, perLine);
        case 'thought':
          return item.durLabel != null && !item.expanded
            ? 37
            : 38 + 21 * lineCount(item.text, perLine);
        case 'tool':
          return item.sub
            ? 70 +
                21 * (item.sub.tools.length + lineCount(item.sub.text, perLine))
            : 37;
        case 'system':
          return 20;
        case 'fork':
          return 24;
        default:
          return 37;
      }
    }

    if (core) {
      host = el('div', 'vsizer');
      host.style.cssText = 'position:relative;width:100%;height:0px;';
      scroller.appendChild(host);
      // virtual-core compensates scroll position itself; the browser's
      // scroll anchoring would apply the same correction twice.
      savedOverflowAnchor = scroller.style.overflowAnchor;
      scroller.style.overflowAnchor = 'none';
      vopts = {
        count: items.length,
        getScrollElement: function () {
          return scroller;
        },
        estimateSize: function (i) {
          return estimate(items[i]);
        },
        // Between a removal and the next pass the count can be stale.
        getItemKey: function (i) {
          var it = items[i];
          return it ? it.id : -1 - i;
        },
        initialOffset: function () {
          return scroller.scrollTop;
        },
        observeElementRect: core.observeElementRect,
        observeElementOffset: core.observeElementOffset,
        scrollToFn: core.elementScroll,
        measureElement: measureRow,
        gap: 8,
        paddingStart: 8,
        paddingEnd: 8,
        overscan: 8,
        anchorTo: 'end',
        followOnAppend: true,
        scrollEndThreshold: NEAR_BOTTOM_PX,
        onChange: function () {
          schedule();
        },
      };
      virtualizer = new core.Virtualizer(vopts);
      unmountVirtualizer = virtualizer._didMount();
      virtualizer._willUpdate();
    } else {
      host = el('div', 'vlist');
      scroller.appendChild(host);
    }

    function setSizerHeight() {
      var h = virtualizer.getTotalSize() + 'px';
      if (host.style.height !== h) host.style.height = h;
    }

    // While the scroller is not rendered (display:none on it or an
    // ancestor: another tab, the raw-JSON view) every row measures 0.
    // Recording that would collapse the sizer and the browser would clamp
    // the scroll position, so hidden rows keep their known size.
    function rendered() {
      return scroller.getClientRects().length > 0;
    }
    // virtual-core's measureElement option (used by its ResizeObserver and
    // by measureElement(row)); otherwise the same as its default.
    function measureRow(row, entry, instance) {
      var index = instance.indexFromElement(row);
      var known = instance.itemSizeCache.get(
        instance.options.getItemKey(index),
      );
      if (!row.getClientRects().length) {
        return known !== undefined ? known : estimate(items[index]);
      }
      var box = entry && entry.borderBoxSize && entry.borderBoxSize[0];
      if (box) return Math.round(box.blockSize);
      if (!entry && known !== undefined) return known;
      return row.offsetHeight;
    }

    // Measure rows in the same pass that changed them, so positions, the
    // sizer and any scroll correction land before paint (the ResizeObserver
    // would only report them after it). virtual-core applies its correction
    // (e.g. staying at the end while the last row grows) inside resizeItem,
    // so the sizer is grown first: a correction must not be clamped by a
    // sizer that still has the old total.
    function measureRows(list, fresh) {
      if (!rendered()) {
        // Only register new rows; they are measured once shown again.
        if (fresh) {
          for (var f = 0; f < list.length; f++) {
            virtualizer.measureElement(list[f].row);
          }
        }
        return;
      }
      var cache = virtualizer.itemSizeCache; // item.id -> measured height
      var heights = [];
      var grow = 0;
      for (var i = 0; i < list.length; i++) {
        heights.push(list[i].row.offsetHeight);
        grow += Math.max(0, heights[i] - (cache.get(list[i].item.id) || 0));
      }
      if (grow > 0) {
        host.style.height = virtualizer.getTotalSize() + grow + 'px';
      }
      for (var j = 0; j < list.length; j++) {
        var m = list[j];
        // New rows register with virtual-core's ResizeObserver, which keeps
        // measuring them; its own first measurement would reuse the size
        // cached from an earlier mount, so the real height is set as well.
        if (fresh) virtualizer.measureElement(m.row);
        // A stale index (items moved since the row was placed) is left to
        // the ResizeObserver once placeRows has refreshed data-index.
        if (items[m.index] === m.item) {
          virtualizer.resizeItem(m.index, heights[j]);
        }
      }
      setSizerHeight();
    }

    // Mount/unmount/position the rows virtual-core wants; returns whether
    // new rows were mounted (their measurement may move the others).
    function placeRows(now) {
      var want = virtualizer.getVirtualItems();
      var keep = new Set();
      for (var i = 0; i < want.length; i++) {
        var it = items[want[i].index];
        if (it) keep.add(it.id);
      }
      var removed = false;
      mounted.forEach(function (m, id) {
        if (!keep.has(id)) {
          unmount(id);
          removed = true;
        }
      });
      // Let virtual-core drop its references to detached rows.
      if (removed) virtualizer.measureElement(null);
      var fresh = [];
      var prev = null;
      for (var j = 0; j < want.length; j++) {
        var v = want[j];
        var item = items[v.index];
        if (!item) continue;
        var m = mounted.get(item.id);
        if (!m) {
          m = mount(item, now);
          fresh.push(m);
        }
        if (m.index !== v.index) {
          m.index = v.index;
          m.row.setAttribute('data-index', String(v.index));
        }
        if (m.y !== v.start) {
          m.y = v.start;
          m.row.style.transform = 'translateY(' + v.start + 'px)';
        }
        // DOM order follows item order (selection, a11y).
        var at = prev ? prev.nextSibling : host.firstChild;
        if (m.row !== at) host.insertBefore(m.row, at);
        prev = m.row;
      }
      if (fresh.length) measureRows(fresh, true);
      return fresh.length > 0;
    }

    // Render-all fallback: every item, in model order, in normal flow.
    function syncAllRows(now) {
      var ids = new Set();
      for (var i = 0; i < items.length; i++) ids.add(items[i].id);
      mounted.forEach(function (m, id) {
        if (!ids.has(id)) unmount(id);
      });
      var at = host.firstChild;
      for (var j = 0; j < items.length; j++) {
        var m = mounted.get(items[j].id) || mount(items[j], now);
        if (m.row === at) at = at.nextSibling;
        else host.insertBefore(m.row, at);
      }
    }

    function gapPx() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    }

    function toEnd() {
      if (virtualizer) virtualizer.scrollToEnd();
      else scroller.scrollTop = scroller.scrollHeight;
    }

    // On iOS WebKit (detected by user agent) virtual-core does not apply its
    // scroll corrections while a finger is down or the scroller is
    // scrolling: it sums them in the private _iosDeferredAdjustment and
    // replays the sum once everything has settled. The sum only fits the
    // position it was computed at. Once the reader has scrolled away from
    // the end, or the view is at the end anyway, replaying it would move
    // the reader (back toward the bottom, or up from the end). The field is
    // checked by src/vendorVirtualCore.test.ts.
    function dropPendingCorrection() {
      if (virtualizer && virtualizer._iosDeferredAdjustment) {
        virtualizer._iosDeferredAdjustment = 0;
      }
    }

    // ---- Touch gestures -------------------------------------------------------
    // While a finger is on the transcript the view does not write the scroll
    // position to follow new content: that would fight the finger, and on
    // iOS each write keeps virtual-core's pending correction growing (see
    // above). Following resumes when the gesture is over: at once if the
    // finger never moved the transcript, or GESTURE_TAIL_MS after it lifts
    // (iOS momentum) if it did.
    var touching = false;
    var touchScrolled = false; // the transcript scrolled during this touch
    var tailTimer = null;
    function gestureActive() {
      return touching || tailTimer !== null;
    }
    function onTouchStart() {
      touching = true;
      touchScrolled = false;
      if (tailTimer !== null) clearTimeout(tailTimer);
      tailTimer = null;
    }
    function onTouchEnd(e) {
      if (!touching || (e.touches && e.touches.length)) return;
      touching = false;
      if (touchScrolled) {
        tailTimer = setTimeout(function () {
          tailTimer = null;
          schedule();
        }, GESTURE_TAIL_MS);
      } else {
        schedule();
      }
    }
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchend', onTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', onTouchEnd, { passive: true });

    var structural = true;

    function pass() {
      rafId = 0;
      if (destroyed) return;
      var now = Date.now();
      // Before any DOM write: virtual-core reads the current distance from
      // the end here to decide whether an append follows to the bottom.
      if (virtualizer) {
        vopts.count = items.length;
        virtualizer.setOptions(vopts);
      }
      var written = [];
      dirty.forEach(function (id) {
        var m = mounted.get(id);
        if (!m) return;
        patch(m, now);
        written.push(m);
      });
      dirty.clear();
      if (clocksDue) {
        clocksDue = false;
        patchClocks(now, written);
      }
      if (virtualizer) {
        if (written.length) measureRows(written, false);
        setSizerHeight();
        // Measuring newly mounted rows can move the others or change which
        // rows are wanted: repeat (bounded) within this frame.
        for (var round = 0; round < 3; round++) {
          if (!placeRows(now)) break;
        }
        // Applies followOnAppend / end anchoring for this update.
        virtualizer._willUpdate();
      } else if (structural) {
        syncAllRows(now);
      }
      structural = false;
      // A hidden scroller (display:none) keeps the request for later.
      if (scroller.clientHeight > 0) {
        if (pendingEnd) {
          pendingEnd = false;
          follow = false;
          hold = null;
          toEnd();
          // Already at the end (e.g. the content just shrank to fit, as
          // after a clear): the scroll position does not change, so no
          // scroll event reports that the view is at the bottom now.
          refreshNearBottom();
        } else if (hold) {
          follow = false;
          keepHeld();
        } else if (follow && !gestureActive()) {
          follow = false;
          if (nearBottom && gapPx() > 1) toEnd();
        }
        if (virtualizer && gapPx() <= 1) dropPendingCorrection();
      }
      hold = null;
    }

    function viewportTop(node) {
      return (
        node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      );
    }

    // Put a toggled thought's header back where the user clicked it, undoing
    // any shift this pass caused (virtual-core keeps a growing row's bottom
    // in place when the view sits at the end).
    function keepHeld() {
      var m = mounted.get(hold.item.id);
      if (m && m.head && m.head.isConnected) {
        var drift = viewportTop(m.head) - hold.top;
        if (Math.abs(drift) > 0.5) {
          if (virtualizer) {
            virtualizer.scrollToOffset(scroller.scrollTop + drift);
          } else {
            scroller.scrollTop += drift;
          }
        }
      }
      // The view may no longer reach the end (or may again): the scroll
      // position can come out unchanged, so no scroll event says so.
      refreshNearBottom();
    }

    function schedule() {
      if (!rafId && !destroyed) rafId = requestAnimationFrame(pass);
    }

    // ---- Clock ----------------------------------------------------------------

    function syncTimer() {
      if (live.size && !timer && !destroyed) {
        timer = setInterval(function () {
          clocksDue = true;
          schedule();
        }, 1000);
      } else if (!live.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    // ---- Wiring ---------------------------------------------------------------

    function refreshNearBottom() {
      var nb = gapPx() < NEAR_BOTTOM_PX;
      if (!nb) follow = false;
      if (nb !== nearBottom) {
        nearBottom = nb;
        // Corrections pending from while the view sat at the end must not
        // pull the reader back there (see dropPendingCorrection).
        if (!nb) dropPendingCorrection();
        if (opts.onNearBottomChange) opts.onNearBottomChange(nb);
      }
    }
    function onScroll() {
      if (touching) touchScrolled = true;
      refreshNearBottom();
    }
    scroller.addEventListener('scroll', onScroll, { passive: true });

    // Derive everything from the event and `items`: during an append the
    // model's own pointers (curAsst, forkItem, ...) may not be set yet.
    var unsubscribe = model.subscribe(function (ev) {
      if (ev.type === 'append') {
        structural = true;
        if (isLive(ev.item)) live.add(ev.item);
      } else if (ev.type === 'update') {
        if (mounted.has(ev.item.id)) dirty.add(ev.item.id);
        if (isLive(ev.item)) live.add(ev.item);
        else live.delete(ev.item);
      } else {
        structural = true;
        live.forEach(function (it) {
          if (!isLive(it) || items.lastIndexOf(it) < 0) live.delete(it);
        });
      }
      // A thought toggle is the user's own action, not new content.
      if (nearBottom && !quiet) follow = true;
      syncTimer();
      schedule();
    });

    for (var i = 0; i < items.length; i++) {
      if (isLive(items[i])) live.add(items[i]);
    }
    syncTimer();
    schedule();

    return {
      scrollToEnd: function () {
        pendingEnd = true;
        schedule();
      },
      followIfPinned: function () {
        if (!nearBottom) return;
        follow = true;
        schedule();
      },
      isNearBottom: function () {
        return nearBottom;
      },
      mountedCount: function () {
        return mounted.size;
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (timer) clearInterval(timer);
        timer = null;
        if (tailTimer !== null) clearTimeout(tailTimer);
        tailTimer = null;
        unsubscribe();
        scroller.removeEventListener('scroll', onScroll);
        scroller.removeEventListener('touchstart', onTouchStart);
        scroller.removeEventListener('touchend', onTouchEnd);
        scroller.removeEventListener('touchcancel', onTouchEnd);
        if (unmountVirtualizer) unmountVirtualizer();
        host.remove();
        if (virtualizer) scroller.style.overflowAnchor = savedOverflowAnchor;
        mounted.clear();
        dirty.clear();
        live.clear();
      },
    };
  }

  globalThis.TranscriptView = { createTranscriptView: createTranscriptView };
})();
