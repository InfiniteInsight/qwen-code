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
  // Wrapped lines of `text` at `perLine` characters a line. Bubbles keep
  // newlines (white-space: pre-wrap), so each one starts a new line: a
  // list or a code block is many short lines, not a few long ones.
  function countLines(text, perLine) {
    var n = 0;
    var from = 0;
    for (;;) {
      var nl = text.indexOf('\n', from);
      var len = (nl < 0 ? text.length : nl) - from;
      n += Math.max(1, Math.ceil(len / perLine));
      if (nl < 0) return n;
      from = nl + 1;
    }
  }

  // ---- Markdown ---------------------------------------------------------
  // Assistant text is markdown; the terminal renders it (ConversationMessages
  // uses MarkdownDisplay), so the viewer showing it as literal characters is a
  // parity gap (#93). The parser is the vendored markdown-it bundle, and its
  // token stream is walked here into createElement/textContent calls: no HTML
  // string is ever built, so the safety of the output does not depend on the
  // parser's escaping. Two token-level properties carry that, and
  // src/vendorMarkdownIt.test.ts pins both: with html:false raw HTML arrives as
  // a text token rather than an html_block/html_inline, and a javascript:/data:
  // link target never arrives as a link at all.
  var MD_TAGS = {
    p: 1,
    h1: 1,
    h2: 1,
    h3: 1,
    h4: 1,
    h5: 1,
    h6: 1,
    ul: 1,
    ol: 1,
    li: 1,
    blockquote: 1,
    pre: 1,
    code: 1,
    em: 1,
    strong: 1,
    s: 1,
    del: 1,
    a: 1,
    table: 1,
    thead: 1,
    tbody: 1,
    tr: 1,
    th: 1,
    td: 1,
    hr: 1,
    br: 1,
  };
  // Only an absolute target of these schemes is made into a link. A relative
  // one would resolve against the gateway's own origin, which the model does
  // not own and the reader did not ask to visit.
  var MD_HREF = /^(?:https?:|mailto:)/i;

  function mdAttrOf(t, name) {
    var attrs = t.attrs || [];
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i][0] === name) return attrs[i][1];
    }
    return null;
  }

  // Table alignment is the one attribute copied off a token that is not a link.
  // markdown-it puts it in a style attribute on th/td and nowhere else.
  // src/vendorMarkdownIt.test.ts pins that a cell can carry no other attribute
  // and that its value is always a text-align, which is what makes copying the
  // whole value, rather than parsing the alignment back out of it, safe.
  var MD_CELL_TAGS = { th: 1, td: 1 };

  // An element for a nesting-1 token, or null to let its children attach to
  // the parent unstyled (an unknown tag, or a link target we will not make).
  function mdElement(md, t) {
    if (!MD_TAGS[t.tag]) return null;
    if (t.type === 'link_open') {
      var href = mdAttrOf(t, 'href');
      if (href === null || !MD_HREF.test(href) || !md.validateLink(href)) {
        return null;
      }
      var a = document.createElement('a');
      a.setAttribute('href', href);
      // The viewer holds a live session; a link must not navigate it away.
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return a;
    }
    var node = document.createElement(t.tag);
    if (MD_CELL_TAGS[t.tag]) {
      var style = mdAttrOf(t, 'style');
      if (style !== null) node.setAttribute('style', style);
    }
    return node;
  }

  function mdLeaf(t) {
    switch (t.type) {
      case 'code_inline':
        return el('code', '', t.content);
      case 'fence':
      case 'code_block':
        // The language rides in t.info, which is model-authored and
        // unvalidated; markdown-it's own renderer puts it in a class name, so
        // this does not. `pre code` is enough to style a block.
        var pre = el('pre');
        pre.appendChild(el('code', '', t.content));
        return pre;
      case 'hr':
        return el('hr');
      case 'hardbreak':
      case 'softbreak':
        // A soft break keeps the source's line: the text tokens hold no
        // newlines, so this is what keeps the rendered height matching the
        // raw-text line count that estimate() uses.
        return el('br');
      case 'image':
        // No img element: model-authored text must not fetch a URL it names.
        return t.content ? document.createTextNode(t.content) : null;
      case 'html_block':
      case 'html_inline':
        // Unreachable with html:false (pinned by the vendor test). Text here
        // anyway, so a parser change cannot turn this into an injection path.
        return t.content ? document.createTextNode(t.content) : null;
      default:
        // text, and any leaf type a future parser adds: its literal content.
        return t.content ? document.createTextNode(t.content) : null;
    }
  }

  function mdWalk(md, tokens, parent) {
    var stack = [parent];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var at = stack[stack.length - 1];
      if (t.type === 'inline') {
        if (t.children) mdWalk(md, t.children, at);
        continue;
      }
      if (t.nesting === -1) {
        // Pops whatever the matching open pushed, including the parent it
        // pushed for a skipped element, so the stack stays balanced.
        stack.pop();
        continue;
      }
      if (t.nesting === 1) {
        // A tight list's paragraph is hidden: markdown-it emits no element for
        // it but still emits the inline token between, so its children go to
        // the parent.
        var node = t.hidden ? null : mdElement(md, t);
        if (node) {
          at.appendChild(node);
          stack.push(node);
        } else {
          stack.push(at);
        }
        continue;
      }
      var leaf = mdLeaf(t);
      if (leaf) at.appendChild(leaf);
    }
  }

  // Markdown text -> nodes, or null when the parser cannot read it (the caller
  // shows the text as typed instead).
  function renderMarkdown(md, text) {
    var tokens;
    try {
      tokens = md.parse(text, {});
    } catch {
      return null;
    }
    var frag = document.createDocumentFragment();
    mdWalk(md, tokens, frag);
    return frag;
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
    // The page hands in the vendored markdown-it bundle the way it hands in
    // virtual-core. Without it (404, blocked, a bundle that will not start),
    // assistant text stays plain: the pre-#93 behaviour, not a blank row.
    var md = null;
    if (opts.markdownIt && typeof opts.markdownIt.MarkdownIt === 'function') {
      try {
        md = new opts.markdownIt.MarkdownIt({
          html: false,
          linkify: false,
          typographer: false,
        });
      } catch {
        md = null;
      }
    }
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
      // A user message the daemon never accepted keeps its echo but says so:
      // the row is already on screen when the POST is in flight, and removing
      // it would take everything after it with it.
      m.notSent = null;
      if (item.kind === 'user') {
        m.notSent = el('span', 'not-sent');
        b.appendChild(m.notSent);
      }
      if (m.notSent) patchUser(m);
      return b;
    }
    function patchUser(m) {
      syncTextNode(m.body, m.item.text);
      var note = m.item.notSent ? 'not sent: ' + m.item.notSent : '';
      if (m.notSent.textContent !== note) m.notSent.textContent = note;
      m.notSent.hidden = !note;
    }

    // An assistant row renders markdown. Its body is a block container rather
    // than the span a plain-text row holds, because markdown emits block
    // elements. Streaming costs a full re-render per pass instead of the tail
    // append the other text rows get: a growing row can change structure (`**
    // bold` becomes an element only when it closes), so the O(delta) append is
    // not available here. The pass is already batched to one rAF, and the
    // re-render is skipped entirely while the text is unchanged.
    function buildAsst(m) {
      var b = el('div', 'bubble asst');
      b.appendChild(el('div', 'role', TEXT_ROLES.asst));
      m.mdBody = el('div', 'md');
      m.mdText = null;
      b.appendChild(m.mdBody);
      patchAsst(m);
      return b;
    }
    function patchAsst(m) {
      var text = m.item.text;
      if (m.mdText === text) return;
      m.mdText = text;
      var body = m.mdBody;
      while (body.firstChild) body.removeChild(body.firstChild);
      var frag = renderMarkdown(md, text);
      // A text the parser cannot read is shown as typed, not dropped.
      body.appendChild(frag || document.createTextNode(text));
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
      var item = m.item;
      var b = el('div', 'bubble tool');
      m.bubble = b;
      m.toolBody = el('span', 'tool-head');
      // keepHeld() looks the clicked line up as m.head, so the hold set below
      // would find nothing and the row would drift when the detail opened.
      m.head = m.toolBody;
      m.toolLabel = document.createTextNode('');
      m.toolBody.appendChild(m.toolLabel);
      // The chevron is the only hint that the row opens; a call whose frames
      // carried neither input nor result has nothing to open, so it gets none.
      m.mark = el('span', 'tool-mark');
      m.toolBody.appendChild(m.mark);
      m.detail = null;
      m.toolBody.addEventListener('click', function () {
        if (!toolHasDetail(item)) return;
        // Same hold the thought header uses: the tapped line stays where it is
        // while the detail opens below it, instead of yanking to the bottom.
        hold = { item: item, top: viewportTop(m.toolBody) };
        item.expanded = !item.expanded;
        quiet = true;
        try {
          model.touch(item);
        } finally {
          quiet = false;
        }
      });
      b.appendChild(m.toolBody);
      m.st = null;
      m.sub = null;
      patchTool(m, now);
      return b;
    }
    function toolHasDetail(item) {
      return item.input !== undefined || item.result !== undefined;
    }
    // The detail is rendered as text rather than as structured DOM: it is read
    // once, and a bounded text block cannot grow an unbounded row. An ACP
    // ToolCallContent is a content / diff / terminal union.
    var MAX_DETAIL = 4000;
    function jsonish(v) {
      try {
        return JSON.stringify(v, null, 1);
      } catch {
        return String(v);
      }
    }
    function contentText(c) {
      if (typeof c === 'string') return c;
      if (!c || typeof c !== 'object') return jsonish(c);
      if (c.type === 'content') {
        var inner = c.content;
        if (inner && inner.type === 'text' && typeof inner.text === 'string')
          return inner.text;
        return '[' + ((inner && inner.type) || 'content') + ']';
      }
      if (c.type === 'diff') {
        return (
          String(c.path || '') +
          '\n-' +
          (typeof c.oldText === 'string' ? c.oldText : '') +
          '\n+' +
          (typeof c.newText === 'string' ? c.newText : '')
        );
      }
      if (c.type === 'terminal') return '[terminal]';
      return jsonish(c);
    }
    function valueText(v) {
      if (Array.isArray(v)) return v.map(contentText).join('\n');
      if (typeof v === 'string') return v;
      return jsonish(v);
    }
    function clip(s) {
      return s.length > MAX_DETAIL
        ? s.slice(0, MAX_DETAIL) + '\n... ' + (s.length - MAX_DETAIL) + ' more'
        : s;
    }
    // Memoised on the item: virtual-core re-estimates every unmeasured row each
    // time it rebuilds its layout, and a large rawInput (a big write, say) must
    // not be stringified once per append.
    var detailCache = new WeakMap();
    function toolDetailText(item) {
      var c = detailCache.get(item);
      if (c && c.input === item.input && c.result === item.result)
        return c.text;
      var parts = [];
      if (item.input !== undefined)
        parts.push('call\n' + valueText(item.input));
      if (item.result !== undefined)
        parts.push('result\n' + valueText(item.result));
      var text = clip(parts.join('\n\n'));
      detailCache.set(item, {
        input: item.input,
        result: item.result,
        text: text,
      });
      return text;
    }
    function patchTool(m, now) {
      var item = m.item;
      var label = '🔧 ' + item.label;
      if (m.toolLabel.data !== label) m.toolLabel.data = label;
      if (item.status) {
        if (!m.st) {
          m.st = el('span', 'st');
          m.toolBody.insertBefore(m.st, m.mark);
        }
        setText(m.st, '  [' + item.status + ']');
      } else if (m.st) {
        m.st.remove();
        m.st = null;
      }
      var open = !!item.expanded && toolHasDetail(item);
      setText(m.mark, toolHasDetail(item) ? (open ? ' ▾' : ' ▸') : '');
      if (open) {
        if (!m.detail) {
          m.detail = el('div', 'tool-detail');
          m.bubble.appendChild(m.detail);
        }
        var text = toolDetailText(item);
        if (m.detail.textContent !== text) m.detail.textContent = text;
        m.detail.hidden = false;
      } else if (m.detail) {
        m.detail.hidden = true;
      }
      if (item.sub) {
        if (!m.sub) m.sub = buildSub(m.bubble);
        patchSub(m.sub, item.sub, now);
      }
    }

    // ---- To-do row ---------------------------------------------------------
    // One row for the whole session, rewritten by each plan frame. Completed
    // entries leave the list and live on in the count, the way the CLI drops
    // them. The list is bounded so a 200-entry plan cannot make one unbounded
    // row, and the row says how many are off screen rather than leaving them
    // off silently.
    var MAX_PLAN_ROWS = 6;
    var PLAN_MARKS = { pending: '▫', in_progress: '▸', failed: '✕' };
    function planLines(item) {
      var open = item.open || [];
      var lines = [
        item.done > 0
          ? '☐ ' + item.done + ' of ' + item.total + ' done'
          : '☐ ' + item.total + ' open',
      ];
      var shown = open.slice(0, MAX_PLAN_ROWS);
      for (var i = 0; i < shown.length; i++) {
        lines.push((PLAN_MARKS[shown[i].status] || '▫') + ' ' + shown[i].text);
      }
      if (open.length > shown.length) {
        lines.push('▸ ' + (open.length - shown.length) + ' more');
      }
      return lines.join('\n');
    }
    function buildPlan(m) {
      var b = el('div', 'bubble plan');
      b.appendChild(el('div', 'role', 'to-do'));
      m.planBody = el('span', 'plan-list');
      b.appendChild(m.planBody);
      patchPlan(m);
      return b;
    }
    function patchPlan(m) {
      var text = planLines(m.item);
      if (m.planBody.textContent !== text) m.planBody.textContent = text;
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

    // "Fork from here" under a completed assistant turn. The view stores the
    // chosen transcript mode on the item (item.mode) and reports the button
    // click (onFork) and, if the page asks, the mode change (onForkMode);
    // the page writes busy/note back and touches the item.
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
      asst: md ? buildAsst : buildText,
      'thought-live': buildText,
      thought: buildThought,
      tool: buildTool,
      processing: buildProcessing,
      system: buildSystem,
      plan: buildPlan,
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
          return patchUser(m);
        case 'asst':
          // With no parser the row was built by buildText and holds a text
          // node, so it keeps the tail append.
          return md ? patchAsst(m) : syncTextNode(m.body, m.item.text);
        case 'thought-live':
          return syncTextNode(m.body, m.item.text);
        case 'thought':
          return patchThought(m);
        case 'tool':
          return patchTool(m, now);
        case 'plan':
          return patchPlan(m);
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
    var lastWidth = 0; // the scroller's last non-zero width
    var relayoutFrom = null; // the reader's place when the width changed

    // virtual-core estimates every row it has not measured each time it
    // rebuilds its layout (on every append), so a text's line count is
    // kept per item (or subagent) until the text or the width changes.
    var lineCache = new WeakMap(); // item or sub -> { text, perLine, n }
    function lineCount(owner, text, perLine) {
      if (!text) return 1;
      var c = lineCache.get(owner);
      if (!c || c.text !== text || c.perLine !== perLine) {
        c = { text: text, perLine: perLine, n: countLines(text, perLine) };
        lineCache.set(owner, c);
      }
      return c.n;
    }

    // Rough per-kind heights for rows never measured yet (wrapped text at
    // ~8 px per character of the bubble width, ~21 px per line).
    function estimate(item) {
      if (!item) return 40;
      var rect = virtualizer && virtualizer.scrollRect;
      var width = rect && rect.width ? rect.width : 600;
      var perLine = Math.max(16, Math.floor(((width - 16) * 0.92 - 20) / 8));
      switch (item.kind) {
        case 'user':
          return (
            38 +
            21 * (lineCount(item, item.text, perLine) + (item.notSent ? 1 : 0))
          );
        case 'asst':
          return 38 + 21 * lineCount(item, item.text, perLine);
        case 'thought':
          return item.durLabel != null && !item.expanded
            ? 37
            : 38 + 21 * lineCount(item, item.text, perLine);
        case 'tool':
          return (
            (item.sub
              ? 70 +
                21 *
                  (item.sub.tools.length +
                    lineCount(item.sub, item.sub.text, perLine))
              : 37) +
            (item.expanded && toolHasDetail(item)
              ? 21 * lineCount(item, toolDetailText(item), perLine)
              : 0)
          );
        case 'system':
          return 20;
        case 'plan':
          return 20 + 21 * lineCount(item, planLines(item), perLine);
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
        // Also notes width changes (a phone rotating, a window resized; a
        // hidden scroller reports 0, which is not one): see relayout().
        // This observer reports before virtual-core's row observer reacts
        // to the new row heights (it was created first), so the reader's
        // place is still the one they were reading.
        observeElementRect: function (instance, cb) {
          return core.observeElementRect(instance, function (rect) {
            if (rect.width) {
              if (lastWidth && rect.width !== lastWidth && !relayoutFrom) {
                relayoutFrom = readerPlace();
                schedule();
              }
              lastWidth = rect.width;
            }
            cb(rect);
          });
        },
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
      try {
        virtualizer = new core.Virtualizer(vopts);
        // When a row changes height while the view is not at the end,
        // virtual-core's default moves the scroll position by the change
        // for any row that starts above the viewport, to keep what is below
        // it in place. For the answer that is still streaming, with the
        // reader inside it, that carried the reader along with the text
        // appended below them. Correct only for rows wholly above the
        // viewport (as browser scroll anchoring does), and still never
        // while the reader scrolls backward (as the default). Staying at
        // the end while the last row grows is decided before this rule.
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = function (
          item,
          delta,
          instance,
        ) {
          return (
            item.end <= scroller.scrollTop &&
            instance.scrollDirection !== 'backward'
          );
        };
        unmountVirtualizer = virtualizer._didMount();
        virtualizer._willUpdate();
      } catch (err) {
        // Leave the scroller as it was (no observers, no sizer), so the
        // caller can retry with virtualCore: null.
        if (unmountVirtualizer) unmountVirtualizer();
        host.remove();
        scroller.style.overflowAnchor = savedOverflowAnchor;
        throw err;
      }
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
    // by measureElement(row)). Only the hidden case is ours; the rest is
    // virtual-core's default measureElement: the observer's border box if
    // there is one, else (a call without an entry, its synchronous path)
    // the size already known for the row, else offsetHeight. measureRows()
    // below sets real heights itself where that known size may be stale.
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
    // Touch events stay aimed at the node the finger came down on. If that
    // node leaves the DOM mid-touch (a live bubble folded, a row unmounted),
    // its touchend no longer bubbles to the scroller, so it is listened to
    // on the node itself as well.
    var touchNode = null;
    function gestureActive() {
      return touching || tailTimer !== null;
    }
    function untrackTouchNode() {
      if (!touchNode) return;
      touchNode.removeEventListener('touchend', onTouchEnd);
      touchNode.removeEventListener('touchcancel', onTouchEnd);
      touchNode = null;
    }
    function onTouchStart(e) {
      touching = true;
      touchScrolled = false;
      if (tailTimer !== null) clearTimeout(tailTimer);
      tailTimer = null;
      untrackTouchNode();
      var node = e.target;
      if (node && node !== scroller && node.addEventListener) {
        touchNode = node;
        node.addEventListener('touchend', onTouchEnd, { passive: true });
        node.addEventListener('touchcancel', onTouchEnd, { passive: true });
      }
    }
    function onTouchEnd(e) {
      if (!touching || (e.touches && e.touches.length)) return;
      touching = false;
      untrackTouchNode();
      // virtual-core follows the finger with its own touchstart/touchend
      // listeners on the scroller and ignores touchcancel. An end it does
      // not get as a touchend (a cancel, or one from a node no longer in
      // the scroller) would leave it holding back its scroll corrections
      // on iOS until some later touch ends: hand it one.
      if (e.type !== 'touchend' || !scroller.contains(e.target)) {
        scroller.dispatchEvent(new Event('touchend'));
      }
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
        if (relayoutFrom && rendered()) relayout();
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

    // The scroller's width changed. virtual-core keeps every measured height
    // until that row is measured again, so rows measured at the old width
    // would be corrected only once scrolled back into view, which moves the
    // text (it does not compensate while the reader scrolls backward).
    // Instead drop all measurements (rows not mounted fall back to their
    // estimate), re-measure the mounted rows now, and put the reader back
    // where they were when the width changed (see readerPlace).
    function relayout() {
      var place = relayoutFrom;
      relayoutFrom = null;
      virtualizer.measure();
      var list = [];
      mounted.forEach(function (m) {
        list.push(m);
      });
      measureRows(list, false);
      if (place.end) {
        pendingEnd = true;
      } else if (place.item) {
        // The old scroll offset points somewhere else in the new layout.
        // Go to the row's new position now, and tell virtual-core at once
        // (it otherwise learns the offset from the next scroll event, as
        // its own setOptions does), so this pass mounts the rows around it;
        // keepHeld() then corrects what measuring them shifts.
        var index = items.indexOf(place.item);
        virtualizer.getTotalSize(); // lays out with the new sizes
        var at =
          index < 0 ? null : virtualizer.getOffsetForIndex(index, 'start');
        if (at) {
          scroller.scrollTop = at[0] - place.top;
          virtualizer.scrollOffset = scroller.scrollTop;
        }
        if (!hold) hold = place;
      }
    }
    // The end when following it; otherwise the last row starting at or
    // above the top edge (else the first one below it) and its offset from
    // the edge. Row tops are still the old layout's here: only heights have
    // reflowed to the new width.
    function readerPlace() {
      if (nearBottom) return { end: true };
      var edge = scroller.getBoundingClientRect().top;
      var above = null;
      var below = null;
      mounted.forEach(function (m) {
        var y = m.row.getBoundingClientRect().top - edge;
        var place = { item: m.item, top: y, row: true };
        if (y <= 0) {
          if (!above || y > above.top) above = place;
        } else if (!below || y < below.top) {
          below = place;
        }
      });
      return above || below || { end: false };
    }

    // Put a toggled thought's header back where the user clicked it, undoing
    // any shift this pass caused (virtual-core keeps a growing row's bottom
    // in place when the view sits at the end); after a width change, the
    // same for the row at the top edge.
    function keepHeld() {
      var m = mounted.get(hold.item.id);
      var node = m && (hold.row ? m.row : m.head);
      if (node && node.isConnected) {
        var drift = viewportTop(node) - hold.top;
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

    // The degraded path re-pins when the box itself changes height (#74).
    // virtual-core re-anchors on every append, so the virtualized path does not
    // need this; the render-all fallback writes its scroll position once and
    // consumes `follow`, and a box resize is not a scroll event, so nothing
    // re-arms it. Measured at a 720px window over a 301-item replay: the box went
    // 351 -> 180 as the composer's contents arrived, then 180 -> 106 as
    // #session-footer and #convo-switch above it filled in, all after the write,
    // leaving the reader 74px short of the newest message.
    // The test is arithmetic and not a threshold. A pure height change moves
    // gapPx() by exactly the height lost, so a gap no larger than the loss is a
    // reader who was at the end and is being left short by the layout. A larger
    // gap is a reader who had scrolled up to read, and they are left where they
    // are: this must not become a thing that yanks a reader who is not at the end.
    var lastBoxHeight = 0;
    function onBoxResize() {
      if (virtualizer || destroyed) return;
      var h = scroller.clientHeight;
      var lost = lastBoxHeight - h;
      lastBoxHeight = h;
      if (lost <= 0) return;
      var gap = gapPx();
      if (gap > 1 && gap <= lost + 1) toEnd();
      refreshNearBottom();
    }
    var boxResizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      boxResizeObserver = new ResizeObserver(onBoxResize);
      boxResizeObserver.observe(scroller);
      lastBoxHeight = scroller.clientHeight;
    }

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
        if (boxResizeObserver) {
          boxResizeObserver.unobserve(scroller);
          boxResizeObserver = null;
        }
        scroller.removeEventListener('touchstart', onTouchStart);
        scroller.removeEventListener('touchend', onTouchEnd);
        scroller.removeEventListener('touchcancel', onTouchEnd);
        untrackTouchNode();
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
