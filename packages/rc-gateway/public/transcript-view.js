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
// fork mode, a turn's action note, subagent end time) lives on the item, so a
// row can be dropped and rebuilt at any time.
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
    file: 'assistant',
    'thought-live': 'thinking',
  };

  // Message, thought, and tool rows render the server frame timestamp when
  // present (#80, #268); rows without item.time omit .stamp rather than
  // reading this browser's clock.
  var STAMPED = { user: true, asst: true, file: true, thought: true };
  var STAMPED_SHAPES = {
    user: true,
    asst: true,
    file: true,
    thought: true,
    'thought-live': true,
    tool: true,
  };
  // Eastern by default, and the IANA name rather than 'EST': the abbreviation is
  // a fixed offset and would sit an hour out for the half the year EDT is in.
  var DEFAULT_STAMP_ZONE = 'America/New_York';
  // Formatters cached PER ZONE rather than in one shared slot. The zone is a
  // per-view preference now, so a single slot would let one view's zone decide
  // what another view renders. `false` means that zone is unusable.
  var stampFmts = new Map();
  function stampFormatter(zone) {
    if (stampFmts.has(zone)) return stampFmts.get(zone);
    var fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      // An unusable zone yields no stamp rather than a wrong one: a silently
      // mis-zoned time is the failure this whole feature exists to avoid.
      fmt = false;
    }
    stampFmts.set(zone, fmt);
    return fmt;
  }
  function stampText(item, zone) {
    var t = item && item.time;
    if (typeof t !== 'number' || !Number.isFinite(t)) return '';
    var fmt = stampFormatter(zone);
    return fmt ? fmt.format(new Date(t)) : '';
  }
  function syncRoleStamp(role, item, zone) {
    if (!role) return;
    var existing = role.querySelector('.stamp');
    var t = item && STAMPED[item.kind] ? stampText(item, zone) : '';
    if (t) {
      if (!existing) {
        existing = el('span', 'stamp');
        role.appendChild(existing);
      }
      setText(existing, ' \u00b7 ' + t);
    } else if (existing) {
      existing.remove();
    }
  }
  // The stamp rides the role line instead of getting a line of its own: a second
  // line per row would move every height the virtualizer has already cached.
  function roleLine(shape, item, zone) {
    var r = el('div', 'role', TEXT_ROLES[shape]);
    syncRoleStamp(r, item, zone);
    return r;
  }

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

  function recordMdFile(mdCtx, wsFile) {
    if (!mdCtx || !wsFile) return;
    var k = wsFile.key || wsFile.workspacePath || wsFile.name;
    if (!k || mdCtx.seen[k]) return;
    mdCtx.seen[k] = 1;
    mdCtx.files.push(wsFile);
  }

  // An element for a nesting-1 token, or null to let its children attach to
  // the parent unstyled (an unknown tag, or a link target we will not make).
  function mdElement(md, t, mdCtx) {
    if (!MD_TAGS[t.tag]) return null;
    if (t.type === 'link_open') {
      var href = mdAttrOf(t, 'href');
      if (href === null) return null;
      if (!MD_HREF.test(href) || !md.validateLink(href)) {
        var wsFile =
          mdCtx && typeof mdCtx.resolveWorkspaceFile === 'function'
            ? mdCtx.resolveWorkspaceFile(href)
            : null;
        if (!wsFile) return null;
        recordMdFile(mdCtx, wsFile);
        var wa = document.createElement('a');
        wa.setAttribute('href', '#');
        wa.className = 'md-ws-link';
        wa.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (mdCtx && typeof mdCtx.onDownloadFile === 'function') {
            mdCtx.onDownloadFile(wsFile, mdCtx.ownerItem);
          }
        });
        return wa;
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

  function mdLeaf(t, mdCtx) {
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
        // No img element in prose: model-authored text must not hotlink a URL
        // it names. If the target resolves to a workspace file, record it so
        // the assistant bubble's inline file strip renders its safe preview.
        if (mdCtx && typeof mdCtx.resolveWorkspaceFile === 'function') {
          var src = mdAttrOf(t, 'src');
          var wsImg = src ? mdCtx.resolveWorkspaceFile(src, t.content) : null;
          if (wsImg) recordMdFile(mdCtx, wsImg);
        }
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

  function mdWalk(md, tokens, parent, mdCtx) {
    var stack = [parent];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var at = stack[stack.length - 1];
      if (t.type === 'inline') {
        if (t.children) mdWalk(md, t.children, at, mdCtx);
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
        var node = t.hidden ? null : mdElement(md, t, mdCtx);
        if (node) {
          at.appendChild(node);
          stack.push(node);
        } else {
          stack.push(at);
        }
        continue;
      }
      var leaf = mdLeaf(t, mdCtx);
      if (leaf) at.appendChild(leaf);
    }
  }

  // Markdown text -> nodes, or null when the parser cannot read it (the caller
  // shows the text as typed instead).
  function renderMarkdown(md, text, mdCtx) {
    var tokens;
    try {
      tokens = md.parse(text, {});
    } catch {
      return null;
    }
    var frag = document.createDocumentFragment();
    mdWalk(md, tokens, frag, mdCtx);
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

  // The full-size target has to be a blob: URL, because the browser blocks a
  // top-level navigation to a data: one (measured, not assumed). Decoding lives
  // here rather than in the model so the model stays DOM-free. The URL is minted
  // at most once per item and never revoked: it is the same bytes the item
  // already holds, and revoking would break a tab the reader left open.
  function fullSizeUrl(item) {
    if (typeof URL !== 'function' || typeof URL.createObjectURL !== 'function')
      return '';
    try {
      var bin = atob(item.data);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: item.mime }));
    } catch {
      return '';
    }
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
    var pendingTop = false; // revealHeader() requested
    // A restorePlace() request: { item, top }, applied by the next pass that
    // runs while the scroller is rendered (see goToPlace).
    var pendingPlace = null;
    // #138. Find in conversation: { needle, ids: Set of item ids, active: item
    // | null } while a search is open, else null. The page owns the search (the
    // model finds the rows); the view only marks what is mounted.
    var find = null;
    var findStale = false; // a mounted row changed since the marks were drawn
    var findFirst = null; // the active row's first mark, for pendingFocus
    var pendingFocus = null; // revealItem(): bring this row's mark into view
    var quiet = false; // the current model event is that toggle's own touch
    // The zone THIS view renders message times in. Per-view rather than shared,
    // because the preference is the reader's and two views on one page can read
    // in different zones. Absent means the default, never no stamp.
    var stampZone =
      typeof opts.stampZone === 'string' && opts.stampZone
        ? opts.stampZone
        : DEFAULT_STAMP_ZONE;
    var restamp = false; // a zone change: rebuild the stamped rows on screen

    // ---- Bubbles ----------------------------------------------------------

    function buildText(m) {
      var item = m.item;
      var b = el('div', 'bubble ' + item.kind);
      m.role = roleLine(m.shape, item, stampZone);
      b.appendChild(m.role);
      var body = el('span');
      m.body = textRef(item.text);
      m.bodyBox = body;
      body.appendChild(m.body.node);
      b.appendChild(body);
      // The attachments of a user message (#197) sit between its text and its
      // not-sent marker. The box is always there for a user row and hidden
      // while empty, so a part added later has somewhere to go.
      m.partsBox = null;
      m.partsN = 0;
      m.filesBox = null;
      m.fileCards = null;
      m.mdFiles = null;
      if (item.kind === 'user') {
        m.partsBox = el('div', 'att-list');
        b.appendChild(m.partsBox);
      } else if (item.kind === 'asst') {
        m.filesBox = el('div', 'asst-files');
        m.filesBox.hidden = true;
        b.appendChild(m.filesBox);
      }
      // A user message the daemon never accepted keeps its echo but says so:
      // the row is already on screen when the POST is in flight, and removing
      // it would take everything after it with it.
      m.notSent = null;
      m.retry = null;
      if (item.kind === 'user') {
        m.notSent = el('span', 'not-sent');
        b.appendChild(m.notSent);
        // #184: the way to send it again sits where the failure is said. A
        // sibling of the marker rather than inside it, so the marker still
        // reads exactly what the daemon refused.
        m.retry = el('button', 'retry', 'retry');
        m.retry.type = 'button';
        m.retry.addEventListener('click', function () {
          if (opts.onRetry) opts.onRetry(item);
        });
        b.appendChild(m.retry);
      }
      if (m.notSent) patchUser(m);
      else if (item.kind === 'asst') syncAsstFiles(m);
      return b;
    }
    function patchUser(m) {
      syncRoleStamp(m.role, m.item, stampZone);
      syncTextNode(m.body, m.item.text);
      syncParts(m);
      var note = m.item.notSent ? 'not sent: ' + m.item.notSent : '';
      if (m.notSent.textContent !== note) m.notSent.textContent = note;
      m.notSent.hidden = !note;
      m.retry.hidden = !note;
    }

    // ---- Attachments of a user message (#197) ------------------------------
    // Parts only ever grow, so a sync appends the ones not drawn yet. The text
    // span is hidden (not emptied) while the message has no text, so an
    // attachment-only message does not carry a blank line above its picture.
    function syncParts(m) {
      var parts = m.item.parts || [];
      var hideBody = !m.item.text && parts.length > 0;
      if (m.bodyBox.hidden !== hideBody) m.bodyBox.hidden = hideBody;
      if (!m.partsBox) return;
      for (; m.partsN < parts.length; m.partsN++) {
        m.partsBox.appendChild(buildPart(parts[m.partsN]));
      }
      var hide = parts.length === 0;
      if (m.partsBox.hidden !== hide) m.partsBox.hidden = hide;
    }
    function partSizeLabel(n) {
      if (!n) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }
    function buildPart(part) {
      return part.kind === 'image' ? buildPartImage(part) : buildPartChip(part);
    }
    // A file, or an image type the viewer will not open: name, type and size.
    function buildPartChip(part) {
      var chip = el('div', 'att-chip');
      chip.appendChild(el('span', 'att-chip-name', part.name));
      var meta = [part.mimeType || 'file', partSizeLabel(part.size)]
        .filter(Boolean)
        .join(' \u00b7 ');
      chip.appendChild(el('span', 'att-chip-meta', meta));
      return chip;
    }
    // A picture. Inline bytes draw at once; a stored one is fetched through the
    // page (opts.loadAttachment, which holds the token and the session), and a
    // row rebuilt after it scrolled away reuses the url kept on the part. The
    // box has a set height until the picture lands, and the row is observed by
    // the virtualizer, so the new height is measured when it arrives.
    function buildPartImage(part) {
      var box = el('div', 'att-image');
      var a = el('a', 'att-link');
      // The viewer holds a live session, so full size never replaces it.
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      var img = el('img', 'att-thumb');
      img.setAttribute('alt', part.name);
      a.appendChild(img);
      box.appendChild(a);
      if (part.attachmentId) box.appendChild(el('div', 'att-name', part.name));

      function show(url) {
        img.setAttribute('src', url);
        a.setAttribute('href', url);
        box.classList.remove('att-loading');
      }
      function fail() {
        box.classList.remove('att-loading');
        a.remove();
        box.insertBefore(
          el('div', 'att-note', 'image unavailable'),
          box.firstChild,
        );
      }
      var retried = false;
      function load() {
        box.classList.add('att-loading');
        var pending;
        try {
          pending = opts.loadAttachment(part.attachmentId, part);
        } catch {
          return fail();
        }
        Promise.resolve(pending).then(function (r) {
          if (r && r.url) {
            part.url = r.url;
            show(r.url);
          } else fail();
        }, fail);
      }
      if (part.data) {
        img.setAttribute(
          'src',
          'data:' + part.mimeType + ';base64,' + part.data,
        );
        a.addEventListener('click', function () {
          if (a.getAttribute('href')) return;
          var url = fullSizeUrl({ data: part.data, mime: part.mimeType });
          if (url) a.setAttribute('href', url);
        });
      } else if (part.url) {
        show(part.url);
        // A url the page has since let go (it keeps a bounded number) is asked
        // for again, once.
        img.addEventListener('error', function () {
          if (retried || typeof opts.loadAttachment !== 'function') return;
          retried = true;
          delete part.url;
          load();
        });
      } else if (
        part.attachmentId &&
        typeof opts.loadAttachment === 'function'
      ) {
        load();
      } else {
        fail();
      }
      return box;
    }

    // An assistant row renders markdown. Its body is a block container rather
    // than the span a plain-text row holds, because markdown emits block
    // elements. Streaming costs a full re-render per pass instead of the tail
    // append the other text rows get: a growing row can change structure (`**
    // bold` becomes an element only when it closes), so the O(delta) append is
    // not available here. The pass is already batched to one rAF, and the
    // re-render is skipped entirely while the text is unchanged.
    // #184, #233. A finished turn's actions: Fork, Rewind, Copy. Mounted
    // inline in the assistant bubble's role line immediately after the stamp so
    // a reader does not scroll past a long reply to reach them; any status note
    // sits directly beneath the role line while non-empty.
    function buildActs(item) {
      var a = {
        box: el('span', 'turn-acts'),
        note: el('div', 'turn-acts-note'),
      };
      a.fork = el('button', 'act-fork', 'Fork');
      a.rewind = el('button', 'act-rewind', 'Rewind');
      a.copy = el('button', 'act-copy', 'Copy');
      [
        ['fork', a.fork],
        ['rewind', a.rewind],
        ['copy', a.copy],
      ].forEach(function (pair) {
        pair[1].type = 'button';
        pair[1].addEventListener('click', function () {
          if (opts.onTurnAct) opts.onTurnAct(pair[0], item);
        });
        a.box.appendChild(pair[1]);
      });
      patchActs(a, item);
      return a;
    }
    function patchActs(a, item) {
      var busy = !!item.busy;
      if (a.fork.disabled !== busy) a.fork.disabled = busy;
      var note = item.note || '';
      setText(a.note, note);
      a.note.hidden = !note;
    }
    function syncAsstActs(m) {
      var want = !!m.item.turnEnd;
      if (want && !m.acts && m.role) {
        m.acts = buildActs(m.item);
        m.role.appendChild(m.acts.box);
        m.bubble.insertBefore(m.acts.note, m.role.nextSibling);
      } else if (!want && m.acts) {
        m.acts.box.remove();
        m.acts.note.remove();
        m.acts = null;
      }
      if (m.acts) patchActs(m.acts, m.item);
    }

    var RASTER_MIME_RE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
    var RASTER_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
    function isRasterSpec(spec) {
      if (!spec) return false;
      var mime = String(spec.mimeType || '').toLowerCase();
      if (RASTER_MIME_RE.test(mime)) return true;
      if (mime && mime.indexOf('image/') === 0) return false; // e.g. svg+xml
      var target = String(spec.workspacePath || spec.name || '');
      return RASTER_EXT_RE.test(target);
    }
    function fileBadgeText(spec) {
      var target = String((spec && (spec.name || spec.workspacePath)) || '');
      var dot = target.lastIndexOf('.');
      if (dot > 0 && dot < target.length - 1) {
        var ext = target
          .slice(dot + 1)
          .replace(/[^a-z0-9]/gi, '')
          .toUpperCase();
        if (ext && ext.length <= 6) return ext;
      }
      var k = String((spec && spec.kind) || '').toUpperCase();
      return k && k !== 'OTHER' ? k.slice(0, 6) : 'FILE';
    }
    function partToFileSpec(part, index) {
      var uri = typeof part.uri === 'string' ? part.uri : '';
      var resolved =
        uri && typeof opts.resolveWorkspaceFile === 'function'
          ? opts.resolveWorkspaceFile(uri, part.name)
          : null;
      var wsPath = (resolved && resolved.workspacePath) || '';
      var name =
        part.name ||
        (resolved && resolved.name) ||
        (wsPath ? wsPath.split('/').pop() : 'file');
      return {
        key:
          (wsPath ? 'ws:' + wsPath : '') ||
          (part.attachmentId ? 'att:' + part.attachmentId : '') ||
          (uri ? 'uri:' + uri : '') ||
          'part:' + index + ':' + name,
        name: name,
        workspacePath: wsPath,
        uri: uri,
        attachmentId: part.attachmentId || '',
        mimeType: part.mimeType || (resolved && resolved.mimeType) || '',
        size: typeof part.size === 'number' ? part.size : 0,
        kind: part.kind || 'file',
        data: part.data,
        textData: part.textData,
        url: part.url,
      };
    }
    function buildFileThumb(spec) {
      var box = el('div', 'att-image asst-file-preview');
      var a = el('a', 'att-link');
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      var img = el('img', 'att-thumb');
      img.setAttribute('alt', spec.name || 'file preview');
      a.appendChild(img);
      box.appendChild(a);
      function show(url) {
        img.setAttribute('src', url);
        a.setAttribute('href', url);
        box.classList.remove('att-loading');
      }
      function fail() {
        box.hidden = true;
        box.classList.remove('att-loading');
      }
      if (spec.data) {
        var mime = RASTER_MIME_RE.test(spec.mimeType || '')
          ? spec.mimeType
          : 'image/png';
        img.setAttribute('src', 'data:' + mime + ';base64,' + spec.data);
        a.addEventListener('click', function () {
          if (a.getAttribute('href')) return;
          var u = fullSizeUrl({ data: spec.data, mime: mime });
          if (u) a.setAttribute('href', u);
        });
        return box;
      }
      if (spec.url) {
        show(spec.url);
        return box;
      }
      var loader = null;
      if (spec.attachmentId && typeof opts.loadAttachment === 'function') {
        loader = function () {
          return opts.loadAttachment(spec.attachmentId, spec);
        };
      } else if (
        spec.workspacePath &&
        typeof opts.loadWorkspaceThumb === 'function'
      ) {
        loader = function () {
          return opts.loadWorkspaceThumb(spec.workspacePath, spec);
        };
      }
      if (!loader) {
        box.hidden = true;
        return box;
      }
      box.classList.add('att-loading');
      try {
        Promise.resolve(loader()).then(function (r) {
          if (r && r.url) {
            spec.url = r.url;
            show(r.url);
          } else {
            fail();
          }
        }, fail);
      } catch {
        fail();
      }
      return box;
    }
    function canDownloadFileSpec(spec) {
      if (!spec) return false;
      if (spec.workspacePath) {
        return (
          typeof opts.onDownloadFile === 'function' ||
          typeof opts.onDownloadToolFile === 'function'
        );
      }
      if (
        spec.snapshotId ||
        spec.attachmentId ||
        spec.data ||
        typeof spec.textData === 'string'
      ) {
        return typeof opts.onDownloadFile === 'function';
      }
      return !!(spec.uri && /^https?:\/\//i.test(spec.uri));
    }
    function buildFileCard(spec, ownerItem) {
      var card = el('div', 'asst-file-card');
      var preview = isRasterSpec(spec) ? buildFileThumb(spec) : null;
      if (preview) card.appendChild(preview);
      var row = el('div', 'asst-file-row');
      var badge = el('span', 'asst-file-ext', fileBadgeText(spec));
      var info = el('div', 'asst-file-info');
      var nameEl = el('span', 'asst-file-name', '');
      var metaEl = el('span', 'asst-file-meta', '');
      info.appendChild(nameEl);
      info.appendChild(metaEl);
      row.appendChild(badge);
      row.appendChild(info);
      var extHref =
        !spec.workspacePath &&
        !spec.snapshotId &&
        !spec.attachmentId &&
        !spec.data &&
        typeof spec.textData !== 'string' &&
        spec.uri &&
        /^https?:\/\//i.test(spec.uri)
          ? spec.uri
          : '';
      var btn = null;
      var extLink = null;
      if (extHref) {
        extLink = el('a', 'tool-dl', 'Open');
        extLink.setAttribute('href', extHref);
        extLink.setAttribute('target', '_blank');
        extLink.setAttribute('rel', 'noopener noreferrer');
        row.appendChild(extLink);
      } else {
        btn = el('button', 'tool-dl', 'Download');
        btn.type = 'button';
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var cur = entry.spec;
          if (typeof opts.onDownloadFile === 'function') {
            opts.onDownloadFile(cur, ownerItem);
          } else if (
            cur.workspacePath &&
            typeof opts.onDownloadToolFile === 'function'
          ) {
            opts.onDownloadToolFile(ownerItem, cur.workspacePath);
          }
        });
        row.appendChild(btn);
      }
      card.appendChild(row);
      var note = el('div', 'tool-dl-note');
      note.hidden = true;
      card.appendChild(note);
      var entry = {
        key: spec.key || spec.workspacePath || spec.name,
        spec: spec,
        card: card,
        badge: badge,
        nameEl: nameEl,
        metaEl: metaEl,
        btn: btn,
        extLink: extLink,
        note: note,
      };
      patchFileCard(entry, spec, ownerItem);
      return entry;
    }
    function patchFileCard(entry, spec, ownerItem) {
      entry.spec = spec;
      var leaf =
        spec.name ||
        (spec.workspacePath
          ? spec.workspacePath.replace(/\/+$/, '').split('/').pop()
          : '') ||
        'file';
      setText(entry.badge, fileBadgeText(spec));
      setText(entry.nameEl, leaf);
      var metaBits = [];
      if (spec.workspacePath && spec.workspacePath !== leaf) {
        metaBits.push(spec.workspacePath);
      } else if (spec.mimeType) {
        metaBits.push(spec.mimeType);
      }
      var sz = partSizeLabel(spec.size || spec.sizeBytes || 0);
      if (sz) metaBits.push(sz);
      var metaStr = metaBits.join(' \u00b7 ');
      setText(entry.metaEl, metaStr);
      entry.metaEl.hidden = !metaStr;
      if (entry.btn) {
        var showBtn = canDownloadFileSpec(spec);
        entry.btn.hidden = !showBtn;
        var stateKey = spec.key || spec.workspacePath || leaf;
        var itemDl =
          ownerItem && ownerItem.fileDl && ownerItem.fileDl[stateKey];
        var busy = !!(itemDl ? itemDl.busy : ownerItem && ownerItem.dlBusy);
        var dlNote = itemDl
          ? itemDl.note || ''
          : (ownerItem && ownerItem.dlNote) || '';
        var label = busy ? 'Downloading...' : 'Download ' + leaf;
        if (entry.btn.textContent !== label) entry.btn.textContent = label;
        entry.btn.setAttribute('aria-label', 'Download ' + leaf);
        if (entry.btn.disabled !== busy) entry.btn.disabled = busy;
        setText(entry.note, dlNote);
        entry.note.hidden = !dlNote;
      }
    }
    function syncCardList(box, holder, list, ownerItem) {
      var prev = holder.cards || [];
      var byKey = new Map();
      for (var i = 0; i < prev.length; i++) {
        byKey.set(prev[i].key, prev[i]);
      }
      var next = [];
      var used = new Set();
      for (var j = 0; j < list.length; j++) {
        var spec = list[j];
        var k = spec.key || spec.workspacePath || spec.name || String(j);
        if (used.has(k)) continue;
        used.add(k);
        var existing = byKey.get(k);
        if (existing) {
          patchFileCard(existing, spec, ownerItem);
          next.push(existing);
        } else {
          next.push(buildFileCard(spec, ownerItem));
        }
      }
      prev.forEach(function (c) {
        if (!used.has(c.key)) c.card.remove();
      });
      var cursor = box.firstChild;
      for (var n = 0; n < next.length; n++) {
        if (next[n].card === cursor) {
          cursor = cursor.nextSibling;
        } else {
          box.insertBefore(next[n].card, cursor);
        }
      }
      holder.cards = next;
      var hide = next.length === 0;
      if (box.hidden !== hide) box.hidden = hide;
    }
    function collectAsstFiles(m) {
      var out = [];
      var seen = {};
      var parts = m.item.parts || [];
      for (var i = 0; i < parts.length; i++) {
        var ps = partToFileSpec(parts[i], i);
        if (!seen[ps.key]) {
          seen[ps.key] = 1;
          out.push(ps);
        }
      }
      var mdFiles = m.mdFiles || [];
      for (var j = 0; j < mdFiles.length; j++) {
        var mf = mdFiles[j];
        var mk = mf.key || ('ws:' + mf.workspacePath);
        if (!seen[mk]) {
          seen[mk] = 1;
          out.push(mf);
        }
      }
      return out;
    }
    function syncAsstFiles(m) {
      var list = collectAsstFiles(m);
      var bodyEl = m.mdBody || m.bodyBox;
      if (bodyEl) {
        var hideBody = !m.item.text && list.length > 0;
        if (bodyEl.hidden !== hideBody) bodyEl.hidden = hideBody;
      }
      if (!m.filesBox) return;
      if (!m.fileCards) m.fileCards = { cards: [] };
      syncCardList(m.filesBox, m.fileCards, list, m.item);
      if (list.length > 0 && typeof opts.onDiscoverFiles === 'function') {
        opts.onDiscoverFiles(list, m.item);
      }
    }

    function buildAsst(m) {
      var b = el('div', 'bubble asst');
      m.role = roleLine('asst', m.item, stampZone);
      b.appendChild(m.role);
      m.mdBody = el('div', 'md');
      m.mdText = null;
      m.mdFiles = null;
      b.appendChild(m.mdBody);
      m.filesBox = el('div', 'asst-files');
      m.filesBox.hidden = true;
      m.fileCards = { cards: [] };
      b.appendChild(m.filesBox);
      patchAsst(m);
      return b;
    }
    function patchAsst(m) {
      var text = m.item.text;
      if (m.mdText !== text) {
        m.mdText = text;
        var body = m.mdBody;
        while (body.firstChild) body.removeChild(body.firstChild);
        var mdCtx =
          typeof opts.resolveWorkspaceFile === 'function'
            ? {
                resolveWorkspaceFile: opts.resolveWorkspaceFile,
                onDownloadFile: opts.onDownloadFile,
                ownerItem: m.item,
                files: [],
                seen: {},
              }
            : null;
        var frag = text ? renderMarkdown(md, text, mdCtx) : null;
        m.mdFiles = mdCtx ? mdCtx.files : null;
        if (text) {
          // A text the parser cannot read is shown as typed, not dropped.
          body.appendChild(frag || document.createTextNode(text));
        }
      }
      syncAsstFiles(m);
    }

    function buildFileRow(m) {
      var b = el('div', 'bubble asst asst-file-bubble');
      m.role = roleLine('file', m.item, stampZone);
      b.appendChild(m.role);
      m.filesBox = el('div', 'asst-files');
      m.fileCards = { cards: [] };
      b.appendChild(m.filesBox);
      patchFileRow(m);
      return b;
    }
    function patchFileRow(m) {
      syncRoleStamp(m.role, m.item, stampZone);
      var list = m.item.file ? [m.item.file] : [];
      syncCardList(m.filesBox, m.fileCards, list, m.item);
    }

    function buildThought(m) {
      var item = m.item;
      var b = el('div', 'bubble thought');
      m.head = el('span', 'thought-head');
      m.headLead = document.createTextNode('');
      m.stamp = null;
      m.headMark = document.createTextNode('');
      m.head.appendChild(m.headLead);
      m.head.appendChild(m.headMark);
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
      var lead = '∴ Thought for ' + item.durLabel;
      if (m.headLead.data !== lead) m.headLead.data = lead;
      var t = stampText(item, stampZone);
      if (t) {
        if (!m.stamp) {
          m.stamp = el('span', 'stamp');
          m.head.insertBefore(m.stamp, m.headMark);
        }
        setText(m.stamp, ' \u00b7 ' + t);
      } else if (m.stamp) {
        m.stamp.remove();
        m.stamp = null;
      }
      var mark = hidden ? ' ▸' : ' ▾';
      if (m.headMark.data !== mark) m.headMark.data = mark;
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
      m.stamp = null;
      m.sub = null;
      m.fileActs = null;
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
          m.toolBody.insertBefore(m.st, m.stamp || m.mark);
        }
        setText(m.st, '  [' + item.status + ']');
      } else if (m.st) {
        m.st.remove();
        m.st = null;
      }
      var t = stampText(item, stampZone);
      if (t) {
        if (!m.stamp) {
          m.stamp = el('span', 'stamp');
          m.toolBody.insertBefore(m.stamp, m.mark);
        }
        setText(m.stamp, ' \u00b7 ' + t);
      } else if (m.stamp) {
        m.stamp.remove();
        m.stamp = null;
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
        if (!m.sub) m.sub = buildSub(m.bubble, m);
        patchSub(m.sub, item.sub, now);
      }
      var toolFiles = [];
      if (typeof opts.resolveToolFiles === 'function') {
        toolFiles = opts.resolveToolFiles(item) || [];
      } else if (typeof opts.toolDownloadPath === 'function') {
        var dlPath = opts.toolDownloadPath(item);
        if (dlPath) {
          toolFiles = [
            {
              key: 'ws:' + dlPath,
              name: dlPath.replace(/\/+$/, '').split('/').pop() || dlPath,
              workspacePath: dlPath,
            },
          ];
        }
      }
      if (toolFiles.length > 0) {
        if (!m.fileActs) {
          var box = el('div', 'tool-file-acts');
          m.bubble.appendChild(box);
          m.fileActs = { box: box, cards: [] };
        }
        syncCardList(m.fileActs.box, m.fileActs, toolFiles, item);
      } else if (m.fileActs) {
        m.fileActs.box.remove();
        m.fileActs = null;
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
    function buildSub(bubble, m) {
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
        // issue #110: stop ONE running child without throwing away the turn.
        // The ref is the parent tool's call id, which is what the daemon
        // matches against `task.toolUseId`; busy/note live on item.sub so a
        // row scrolled away and rebuilt still shows them (same contract as
        // the fork button's item.busy/item.note).
        ref: (m.item && m.item.toolCallId) || '',
        cancel: null,
        cancelNote: null,
        cost: null,
        costNote: null,
        trace: null,
      };
      head.appendChild(r.spin);
      head.appendChild(r.msg);
      head.appendChild(r.time);
      r.cancel = el('button', 'subagent-cancel', 'cancel');
      r.cancel.type = 'button';
      r.cancel.title = 'stop this subagent, keep the rest of the turn';
      r.cancel.addEventListener('click', function () {
        if (opts.onCancelSubagent) opts.onCancelSubagent(m.item);
      });
      r.cancelNote = el('span', 'subagent-cancel-note');
      head.appendChild(r.cancel);
      head.appendChild(r.cancelNote);
      // issue #110: what the child used. The stream carries no per-subagent
      // usage, so this read is the only way the number can reach the row.
      // Unlike cancel it stays offered once the child settles, because a
      // finished run's cost is the thing a reader most often wants.
      r.cost = el('button', 'subagent-cost', 'cost');
      r.cost.type = 'button';
      r.cost.title = 'what this subagent used, per the daemon';
      r.cost.addEventListener('click', function () {
        if (opts.onCostSubagent) opts.onCostSubagent(m.item);
      });
      r.costNote = el('span', 'subagent-cost-note');
      head.appendChild(r.cost);
      head.appendChild(r.costNote);
      // issue #110: open this child's trace (its steps in order, its stop) in
      // the page's agents sheet. Offered running or settled, like cost, and
      // only when the page says it can draw one (canTraceSubagent), so an old
      // gateway shows nothing new on the block.
      r.trace = el('button', 'subagent-trace', 'trace');
      r.trace.type = 'button';
      r.trace.title = 'what this subagent did, step by step';
      r.trace.hidden = true;
      r.trace.addEventListener('click', function () {
        if (opts.onTraceSubagent) opts.onTraceSubagent(m.item);
      });
      head.appendChild(r.trace);
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
      var st = stampText(s, stampZone);
      setText(
        r.time,
        ' \u00b7 ' + subDuration(s, now) + (st ? ' \u00b7 ' + st : ''),
      );
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
        setText(r.msg, who + (s.thinking ? 'thinking' : 'running'));
      }
      patchSubClock(r, s, now);
      // Only a child that is actually running can be stopped, and a row
      // rebuilt after settling must not offer it. busy/note come from the
      // page via item.sub, the same contract the fork button uses, so a row
      // scrolled away and rebuilt still shows the in-flight state.
      var stoppable = !s.done && !!r.ref;
      if (r.cancel.hidden !== !stoppable) r.cancel.hidden = !stoppable;
      var busy = !!s.cancelBusy;
      if (r.cancel.disabled !== busy) r.cancel.disabled = busy;
      setText(r.cancelNote, s.cancelNote || '');
      // Cost is offered whenever the row has a reference, running or settled,
      // and busy/note come from item.sub like cancel's, so a row scrolled
      // away and rebuilt still shows the number it already read.
      var priced = !!r.ref;
      if (r.cost.hidden !== !priced) r.cost.hidden = !priced;
      var costBusy = !!s.costBusy;
      if (r.cost.disabled !== costBusy) r.cost.disabled = costBusy;
      setText(r.costNote, s.costNote || '');
      var traceable =
        !!r.ref &&
        typeof opts.onTraceSubagent === 'function' &&
        (typeof opts.canTraceSubagent !== 'function' ||
          !!opts.canTraceSubagent());
      if (r.trace.hidden !== !traceable) r.trace.hidden = !traceable;
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
        var tst = stampText(t, stampZone);
        setText(
          r.tools[i],
          '🔧 ' +
            t.label +
            (t.status ? '  [' + t.status + ']' : '') +
            (tst ? ' \u00b7 ' + tst : ''),
        );
      }
      while (r.tools.length > s.tools.length) {
        var extra = r.tools.pop();
        if (extra && extra.parentNode) extra.parentNode.removeChild(extra);
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

    // The latest completed turn's actions (#184), on the model's fork row.
    // The include/empty choice the row used to carry as a select is asked on
    // tap now (the page's onTurnAct), and kept on the item as item.mode.
    // The page sets item.hideActs when another row sits between the fork row
    // and its answer; the answer then carries the strip and this draws none.
    function buildFork(m) {
      var wrap = el('div', 'bubble-fork');
      m.acts = buildActs(m.item);
      wrap.appendChild(m.acts.box);
      wrap.appendChild(m.acts.note);
      patchFork(m);
      return wrap;
    }
    function patchFork(m) {
      patchActs(m.acts, m.item);
      var hide = !!m.item.hideActs;
      if (m.bubble && m.bubble.hidden !== hide) m.bubble.hidden = hide;
    }

    function buildImage(m) {
      var item = m.item;
      var b = el('div', 'bubble image');
      // A frame the model will not draw still says what arrived.
      if (!item.data) {
        b.appendChild(el('div', 'image-note', item.note));
        return b;
      }
      var a = el('a', 'image-link');
      // The viewer holds a live session, so full size never replaces it -
      // same rule the markdown link branch applies.
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      var img = el('img', 'image-thumb');
      img.setAttribute('src', 'data:' + item.mime + ';base64,' + item.data);
      img.setAttribute('alt', 'assistant image');
      a.appendChild(img);
      b.appendChild(a);
      // The href is minted on the first tap rather than at mount: the browser
      // blocks a top-level navigation to a data: URL, so it has to be a blob:
      // one, and decoding a frame's bytes is not something a scroll past
      // should pay for. The click handler runs before the anchor's activation,
      // so the href set here is the one that same click follows.
      a.addEventListener('click', function () {
        if (a.getAttribute('href')) return;
        var url = fullSizeUrl(item);
        if (url) a.setAttribute('href', url);
      });
      if (typeof opts.onDownloadFile === 'function') {
        var imgExt = String(item.mime || 'image/png')
          .split('/')[1]
          .replace('jpeg', 'jpg');
        var imgName = 'assistant-image.' + (imgExt || 'png');
        var acts = el('div', 'image-file-acts');
        var dlBtn = el('button', 'tool-dl', 'Download ' + imgName);
        dlBtn.type = 'button';
        dlBtn.setAttribute('aria-label', 'Download ' + imgName);
        dlBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          opts.onDownloadFile(
            {
              key: 'inline:' + item.id,
              name: imgName,
              mimeType: item.mime || 'image/png',
              size: item.bytes || 0,
              data: item.data,
            },
            item,
          );
        });
        acts.appendChild(dlBtn);
        b.appendChild(acts);
      }
      return b;
    }

    var BUILD = {
      user: buildText,
      asst: md ? buildAsst : buildText,
      file: buildFileRow,
      image: buildImage,
      'thought-live': buildText,
      thought: buildThought,
      tool: buildTool,
      processing: buildProcessing,
      system: buildSystem,
      plan: buildPlan,
      fork: buildFork,
    };

    function build(m, now) {
      if (find) findStale = true;
      var old = m.bubble;
      m.acts = null;
      m.shape = shapeOf(m.item);
      var make = BUILD[m.shape] || buildSystem;
      m.bubble = make(m, now);
      if (old) m.row.replaceChild(m.bubble, old);
      else m.row.insertBefore(m.bubble, m.row.firstChild);
      if (m.item.kind === 'asst') syncAsstActs(m);
    }

    function patch(m, now) {
      if (find) findStale = true;
      if (shapeOf(m.item) !== m.shape) return build(m, now);
      switch (m.shape) {
        case 'user':
          return patchUser(m);
        case 'asst':
          // With no parser the row was built by buildText and holds a text
          // node, so it keeps the tail append.
          if (md) patchAsst(m);
          else {
            syncTextNode(m.body, m.item.text);
            syncAsstFiles(m);
          }
          return syncAsstActs(m);
        case 'file':
          return patchFileRow(m);
        case 'image':
          // The frame carries the whole image in one go, so there is nothing
          // to write after the build. Falling to the default would run
          // patchSystem and restyle the row as a system line.
          return;
        case 'thought-live':
          syncRoleStamp(m.role, m.item, stampZone);
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
      if (find) findStale = true;
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
          // Attachments (#197): a picture is capped at 240px by the page's CSS
          // plus its name line and gap; a chip is one line. A message with no
          // text draws no text line.
          var parts = item.parts || [];
          var partsH = 0;
          for (var pi = 0; pi < parts.length; pi++) {
            partsH += parts[pi].kind === 'image' ? 276 : 44;
          }
          return (
            38 +
            21 *
              ((item.text || !parts.length
                ? lineCount(item, item.text, perLine)
                : 0) +
                (item.notSent ? 1 : 0)) +
            partsH
          );
        case 'asst':
          // #233: inline .turn-acts grows the 16px role head to 36px (+20px).
          var aparts = item.parts || [];
          var apartsH = 0;
          for (var ai = 0; ai < aparts.length; ai++) {
            apartsH += isRasterSpec(aparts[ai]) ? 276 : 56;
          }
          return (
            38 +
            21 *
              (item.text || !aparts.length
                ? lineCount(item, item.text, perLine)
                : 0) +
            (item.turnEnd ? 20 : 0) +
            apartsH
          );
        case 'file':
          return 38 + (isRasterSpec(item.file) ? 276 : 56);
        case 'image':
          // A thumbnail is capped by the page's CSS at 240px of picture plus
          // the bubble's padding; a row saying it cannot be drawn is one line.
          return item.data
            ? typeof opts.onDownloadFile === 'function'
              ? 298
              : 256
            : 20;
        case 'thought':
          return item.durLabel != null && !item.expanded
            ? 37
            : 38 + 21 * lineCount(item, item.text, perLine);
        case 'tool':
          var tfiles =
            typeof opts.resolveToolFiles === 'function'
              ? opts.resolveToolFiles(item) || []
              : [];
          var tfilesH = 0;
          for (var ti = 0; ti < tfiles.length; ti++) {
            tfilesH += isRasterSpec(tfiles[ti]) ? 276 : 56;
          }
          return (
            (item.sub
              ? 70 +
                21 *
                  (item.sub.tools.length +
                    lineCount(item.sub, item.sub.text, perLine))
              : 37) +
            (item.expanded && toolHasDetail(item)
              ? 21 * lineCount(item, toolDetailText(item), perLine)
              : 0) +
            tfilesH
          );
        case 'system':
          return 20;
        case 'plan':
          return 20 + 21 * lineCount(item, planLines(item), perLine);
        case 'fork':
          return item.hideActs ? 0 : 30;
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

    // ---- Header row -----------------------------------------------------------
    // #190. A node the page wants above the first row, inside the list, so it
    // scrolls away with the rows instead of floating over whichever row is at
    // the top (the page's load-earlier and recap pills, and what the recap
    // and the side question open under them). virtual-core has no header row:
    // the only room it keeps above the first row is paddingStart, and it moves
    // no scroll position when that changes. So the header sits absolutely
    // positioned in that room (the render-all list's padding-top), a
    // ResizeObserver reports when its height changes, and the pass that
    // applies the new room keeps the reader's place itself:
    //  - at the top (scrollTop 0) nothing is held: the header is what the
    //    reader is looking at, and the rows move to make room for it;
    //  - near the end, the end is kept, as for any other change there;
    //  - anywhere else the row at the top edge is held where it was, the way
    //    a toggled thought is (keepHeld), so a header growing or shrinking
    //    above the viewport moves nothing the reader can see.
    // Not while a finger is on the transcript: a scroll write then fights the
    // finger (and on iOS ends its momentum), so the new room waits for the
    // gesture to end, as following the end does.
    var HEADER_GAP = 8; // between the header and the first row
    var header =
      opts.header && opts.header.nodeType === 1 ? opts.header : null;
    var headerHome = null; // where the node was, to put it back on destroy
    var headerRoom = 0; // px of room applied above the first row
    var headerObserver = null;
    if (header) {
      headerHome = {
        parent: header.parentNode,
        next: header.nextSibling,
        css: header.style.cssText,
      };
      header.style.position = 'absolute';
      header.style.top = '8px';
      header.style.left = '8px';
      header.style.right = '8px';
      header.style.margin = '0';
      if (!virtualizer) host.style.position = 'relative';
      host.insertBefore(header, host.firstChild);
    }
    function headerRoomNow() {
      var h = header.offsetHeight;
      return h > 0 ? h + HEADER_GAP : 0;
    }
    // The first slot a row may take in the host: after the header.
    function firstRowSlot() {
      return header && header.parentNode === host
        ? header.nextSibling
        : host.firstChild;
    }
    // Called at the start of a pass, before virtual-core lays the rows out
    // with the new room, so the place recorded here is still the one the
    // reader sees.
    function applyHeaderRoom() {
      // A hidden scroller measures the header 0: keep the room it had.
      if (!rendered()) return;
      if (!pendingTop && gestureActive()) return;
      var room = headerRoomNow();
      if (room === headerRoom) return;
      if (
        !pendingTop &&
        !pendingEnd &&
        !hold &&
        !pendingPlace &&
        !relayoutFrom &&
        scroller.scrollTop >= 1
      ) {
        if (nearBottom) pendingEnd = true;
        else {
          var place = readerRow();
          if (place.item) hold = place;
        }
      }
      headerRoom = room;
      if (virtualizer) vopts.paddingStart = 8 + room;
      else host.style.paddingTop = room + 'px';
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
        // DOM order follows item order (selection, a11y), the header first.
        var at = prev ? prev.nextSibling : firstRowSlot();
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
      var at = firstRowSlot();
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
    // on the node itself as well. A second finger comes down on a second node
    // and must not retire the first one's listener: the touchend that only the
    // detached first node can deliver would then be lost, the gesture would
    // never end, and the view would stop following for the rest of the run.
    var touchNodes = new Set();
    function gestureActive() {
      return touching || tailTimer !== null;
    }
    function trackedList() {
      var list = [];
      touchNodes.forEach(function (node) {
        list.push(node);
      });
      return list;
    }
    function dropTouchNode(node) {
      if (!touchNodes.has(node)) return;
      touchNodes.delete(node);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
    }
    function dropAllTouchNodes() {
      var list = trackedList();
      for (var i = 0; i < list.length; i++) dropTouchNode(list[i]);
    }
    // e.touches is the set of fingers still down, each still aimed at the node
    // it came down on, so a tracked node missing from it has lifted. A
    // synthetic event carries no touches at all, which reads as no fingers.
    function releaseLiftedNodes(e) {
      var down = (e && e.touches) || [];
      if (!down.length) {
        dropAllTouchNodes();
        return;
      }
      var list = trackedList();
      for (var i = 0; i < list.length; i++) {
        var stillDown = false;
        for (var t = 0; t < down.length; t++) {
          if (down[t].target === list[i]) {
            stillDown = true;
            break;
          }
        }
        if (!stillDown) dropTouchNode(list[i]);
      }
    }
    function onTouchStart(e) {
      // A second finger is the same gesture, so whether this gesture has
      // scrolled the transcript yet is already decided and stays.
      if (!touching) touchScrolled = false;
      touching = true;
      if (tailTimer !== null) clearTimeout(tailTimer);
      tailTimer = null;
      var node = e.target;
      if (
        node &&
        node !== scroller &&
        node.addEventListener &&
        !touchNodes.has(node)
      ) {
        touchNodes.add(node);
        node.addEventListener('touchend', onTouchEnd, { passive: true });
        node.addEventListener('touchcancel', onTouchEnd, { passive: true });
      }
    }
    function onTouchEnd(e) {
      if (!touching) return;
      releaseLiftedNodes(e);
      if (e.touches && e.touches.length) return;
      touching = false;
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

    // ---- Find in conversation (#138) ---------------------------------------
    // Marks are painted, never built: the CSS Custom Highlight API puts a
    // background behind ranges of the text that is already there, so no node is
    // added or split and no row changes height. A browser without it still gets
    // the row-level classes (a ring on the active row, a thin one on the rest),
    // which are box-shadows and move nothing either. A mark is best-effort: it
    // is drawn for the rows mounted now and again whenever one is built or
    // patched, and a match that spans two text nodes (a phrase across a bold
    // span) has its row marked but no range.
    var FIND_HIT = 'rc-find';
    var FIND_NOW = 'rc-find-active';
    var FIND_MAX_RANGES = 100; // per row
    function highlightRegistry() {
      try {
        return typeof CSS !== 'undefined' &&
          CSS &&
          CSS.highlights &&
          typeof Highlight === 'function'
          ? CSS.highlights
          : null;
      } catch {
        return null;
      }
    }
    function findNeedle(q) {
      return String(q == null ? '' : q)
        .trim()
        .toLowerCase();
    }
    function findRanges(root, needle) {
      var out = [];
      if (!root || !needle) return out;
      var walker = document.createTreeWalker(root, 4); // SHOW_TEXT
      for (var node = walker.nextNode(); node; node = walker.nextNode()) {
        var p = node.parentNode;
        // The role line, header stamps, turn actions and controls are not the
        // conversation's words; collapsed bodies are not drawn.
        if (
          p &&
          p.closest &&
          p.closest(
            '.role, .stamp, .turn-acts, .turn-acts-note, button, [hidden], .not-sent',
          )
        )
          continue;
        var data = node.data;
        var lower = data.toLowerCase();
        if (lower.length !== data.length) continue; // offsets would not line up
        for (
          var at = lower.indexOf(needle);
          at >= 0 && out.length < FIND_MAX_RANGES;
          at = lower.indexOf(needle, at + needle.length)
        ) {
          var r = document.createRange();
          r.setStart(node, at);
          r.setEnd(node, at + needle.length);
          out.push(r);
        }
        if (out.length >= FIND_MAX_RANGES) break;
      }
      return out;
    }
    function setRowClass(row, cls, on) {
      if (row.classList.contains(cls) !== on) row.classList.toggle(cls, on);
    }
    function paintFind() {
      findStale = false;
      findFirst = null;
      var reg = highlightRegistry();
      var all = [];
      var now = [];
      mounted.forEach(function (m) {
        var hit = !!find && find.ids.has(m.item.id);
        var active = hit && find.active === m.item;
        setRowClass(m.row, 'find-hit', hit);
        setRowClass(m.row, 'find-active', active);
        if (!hit || !reg) return;
        var ranges = findRanges(m.bubble, find.needle);
        for (var i = 0; i < ranges.length; i++) {
          if (active && i === 0) {
            now.push(ranges[i]);
            findFirst = ranges[i];
          } else {
            all.push(ranges[i]);
          }
        }
      });
      if (!reg) return;
      if (all.length) reg.set(FIND_HIT, new Highlight(...all));
      else reg.delete(FIND_HIT);
      if (now.length) reg.set(FIND_NOW, new Highlight(...now));
      else reg.delete(FIND_NOW);
    }
    // A row wholly inside the scroller's visible box.
    function rowInView(m) {
      var edge = scroller.getBoundingClientRect();
      var b = m.row.getBoundingClientRect();
      return b.top >= edge.top && b.bottom <= edge.bottom;
    }
    // revealItem() brought the row to the top; a tall row can still have its
    // mark off screen, so the first mark is brought into the box too.
    var FIND_MARGIN = 64;
    function refineFocus() {
      var item = pendingFocus;
      var m = mounted.get(item.id);
      if (!m) return; // not mounted yet: a later pass
      pendingFocus = null;
      if (!findFirst || !findFirst.startContainer.isConnected) return;
      var edge = scroller.getBoundingClientRect();
      var b = findFirst.getBoundingClientRect();
      if (b.top >= edge.top + 8 && b.bottom <= edge.bottom - 8) return;
      var drift = b.top - edge.top - FIND_MARGIN;
      if (virtualizer) virtualizer.scrollToOffset(scroller.scrollTop + drift);
      else scroller.scrollTop += drift;
      refreshNearBottom();
    }

    var structural = true;
    // The part of the last edge correction that a whole-pixel write could not
    // carry, and the element it was measured on.
    var edgeCarry = 0;
    var edgeAnchorNode = null;

    function pass() {
      rafId = 0;
      if (destroyed) return;
      var now = Date.now();
      // First of all: the place it holds is read off rows not yet moved.
      if (header) applyHeaderRoom();
      // Before any DOM write: virtual-core reads the current distance from
      // the end here to decide whether an append follows to the bottom.
      if (virtualizer) {
        vopts.count = items.length;
        virtualizer.setOptions(vopts);
      }
      var written = [];
      // A row whose box straddles the scroller's top edge can grow in its own
      // MIDDLE. The running Agent row puts its subagent text above the tool
      // rows the child collected, so every one of those slides down as the
      // text streams, and virtual-core cannot see it: its rule is per row and
      // this row is not wholly above the viewport. Record the first element
      // below the edge before the patch and undo whatever this pass moved it,
      // the way keepHeld() does for a toggled header. Not while a finger is
      // down: on iOS each write grows virtual-core's deferred correction (see
      // dropPendingCorrection), and the pass after the gesture re-anchors from
      // wherever the reader ended up. Not when the end or an explicit hold
      // already owns the position either; those run after this and win.
      var edgeKeep = null;
      if (virtualizer && !follow && !hold && !pendingEnd && !gestureActive()) {
        mounted.forEach(function (m, id) {
          if (edgeKeep || !m.row) return;
          if (!dirty.has(id) && !restamp) return;
          var box = m.row.getBoundingClientRect();
          var edge = scroller.getBoundingClientRect().top;
          if (!(box.top < edge && box.bottom > edge)) return;
          var node = firstBelowEdge(m.row, edge);
          if (!node) return;
          edgeKeep = { node: node, top: viewportTop(node) };
          if (node !== edgeAnchorNode) edgeCarry = 0;
          edgeAnchorNode = node;
        });
      }
      // A zone change rewrites the stamp text inside rows already on screen, and
      // the patchers cannot do it: patchUser only syncs the text and the not-sent
      // note, patchAsst only re-renders when the prose changed. So the bubble is
      // rebuilt whole, which is also what re-measures it through `written`.
      if (restamp) {
        restamp = false;
        mounted.forEach(function (m) {
          if (!STAMPED_SHAPES[m.shape]) return;
          build(m, now);
          written.push(m);
        });
      }
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
        if (pendingPlace && rendered()) goToPlace();
        if (written.length) measureRows(written, false);
        setSizerHeight();
        if (pendingEnd && scroller.clientHeight > 0) toEnd();
        // Measuring newly mounted rows can move the others or change which
        // rows are wanted: repeat (bounded) within this frame.
        for (var round = 0; round < 4; round++) {
          var changed = placeRows(now);
          if (pendingEnd && scroller.clientHeight > 0) toEnd();
          if (!changed) break;
        }
        // Applies followOnAppend / end anchoring for this update.
        virtualizer._willUpdate();
        // Read after the placement: whatever else this pass corrected (a row
        // above the viewport, a follow to the end) has already moved the
        // element, so what is left here is the shift inside the row.
        if (
          edgeKeep &&
          !hold &&
          !pendingEnd &&
          !follow &&
          edgeKeep.node.isConnected
        ) {
          // Ask for whole pixels only. A scroll offset is written to the
          // nearest whole pixel (measured: 43.4 reads back 43, and ten
          // separate += 0.4 writes land on 0), so a fractional correction is
          // silently refused. Refusing it here and carrying it to the next
          // pass keeps the reader exactly where they were instead of leaking
          // a fraction of a pixel per streamed chunk.
          var want = viewportTop(edgeKeep.node) - edgeKeep.top + edgeCarry;
          var whole = Math.round(want);
          if (whole !== 0)
            virtualizer.scrollToOffset(scroller.scrollTop + whole);
          edgeCarry = want - whole;
        }
      } else if (structural) {
        syncAllRows(now);
      }
      if (!virtualizer && pendingPlace && rendered()) goToPlace();
      structural = false;
      // A hidden scroller (display:none) keeps the request for later.
      if (scroller.clientHeight > 0) {
        if (pendingTop) {
          pendingTop = false;
          pendingEnd = false;
          follow = false;
          hold = null;
          if (virtualizer) virtualizer.scrollToOffset(0);
          else scroller.scrollTop = 0;
          refreshNearBottom();
        } else if (pendingEnd) {
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
        if (pendingFocus) {
          if (findStale || !findFirst) paintFind();
          refineFocus();
        }
      }
      if (findStale) paintFind();
      hold = null;
    }

    function viewportTop(node) {
      return (
        node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      );
    }

    // The first element inside `row` that lies wholly below the scroller's top
    // edge; document order is visual order within a row. An element that
    // straddles the edge is no use as an anchor: its own top is above the
    // edge, so a shift of the content above it leaves it where it is.
    function firstBelowEdge(row, edge) {
      var walker = document.createTreeWalker(
        row,
        NodeFilter.SHOW_ELEMENT,
        null,
      );
      var node = walker.nextNode(); // the row itself
      while (node) {
        if (node !== row) {
          var b = node.getBoundingClientRect();
          if (b.height > 0 && b.top >= edge) return node;
        }
        node = walker.nextNode();
      }
      return null;
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
    // `usable`, when given, limits the choice to rows whose item it accepts
    // (the page's saved place can only name a row it can find again).
    function readerPlace(usable) {
      if (nearBottom) return { end: true };
      return readerRow(usable);
    }
    // readerPlace() without the end: the row itself, wherever the reader is.
    function readerRow(usable) {
      var edge = scroller.getBoundingClientRect().top;
      var above = null;
      var below = null;
      mounted.forEach(function (m) {
        if (usable && !usable(m.item)) return;
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

    // Puts a row back at `top` px below the scroller's top edge (#182: a reload
    // returns the reader to where they were). The virtualized path jumps to
    // the row's estimated offset first, the way relayout() does, because a row
    // that far from the viewport is not mounted and keepHeld() can only
    // correct a row it can measure; the hold then removes whatever error the
    // estimate left once the rows around it are measured.
    function goToPlace() {
      var place = pendingPlace;
      pendingPlace = null;
      if (items.indexOf(place.item) < 0) return;
      pendingEnd = false;
      follow = false;
      if (virtualizer) {
        virtualizer.getTotalSize();
        var at = virtualizer.getOffsetForIndex(
          items.indexOf(place.item),
          'start',
        );
        if (at) {
          scroller.scrollTop = at[0] - place.top;
          virtualizer.scrollOffset = scroller.scrollTop;
        }
      }
      hold = { item: place.item, top: place.top, row: true };
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

    // #190. The header's height changed. Its observer reports after layout
    // and before paint, so the pass runs now rather than on the next frame:
    // a frame drawn in between would show a grown header over the first row.
    function onHeaderResize() {
      if (destroyed || !header || !rendered()) return;
      if (headerRoomNow() === headerRoom && !pendingTop) return;
      if (rafId) cancelAnimationFrame(rafId);
      pass();
    }
    if (header && typeof ResizeObserver === 'function') {
      headerObserver = new ResizeObserver(onHeaderResize);
      headerObserver.observe(header);
    }

    // Derive everything from the event and `items`: during an append the
    // model's own pointers (curAsst, forkItem, ...) may not be set yet.
    function onModelEvent(ev) {
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
    }
    var unsubscribe = model.subscribe(onModelEvent);

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
      // Called just before older rows are spliced in front of the list. Rows
      // arriving above the viewport leave the scroll position pointing at
      // different content, so the reader has to be put back where they were.
      // Only this pass may write the scroll position: virtual-core sums its
      // own corrections (see dropPendingCorrection), so a caller that set
      // scrollTop itself would be corrected a second time on top.
      anchorReader: function () {
        var place = readerPlace();
        if (place.end) pendingEnd = true;
        else if (place.item) pendingPlace = place;
      },
      // #182. Where the reader is, for a page that saves it across a reload:
      // { end: true } while following the end, else { item, top } for the
      // row at the top edge (see readerPlace), or { end: false } when no
      // mounted row qualifies.
      readerAnchor: function (usable) {
        return readerPlace(usable);
      },
      // #182. Puts `item`'s row `top` px below the top edge on the next pass.
      // Like anchorReader, the write happens inside the pass, so virtual-core's
      // own corrections are not applied a second time on top of it.
      restorePlace: function (item, top) {
        if (!item || typeof top !== 'number' || !isFinite(top)) return;
        pendingPlace = { item: item, top: top };
        schedule();
      },
      isNearBottom: function () {
        return nearBottom;
      },
      // #190. Scrolls to the top of the list, where the header row is: for a
      // control in the header the reader opened from somewhere else (the
      // recap from the ⋯ menu), or one whose opening grows the header under
      // them. The header's new height is applied in the same pass, unheld.
      revealHeader: function () {
        if (!header || destroyed) return;
        pendingTop = true;
        schedule();
      },
      // #138. Marks the rows of a search: spec is { query, ids, active } (the
      // rows that hold the query, as item ids, and the one being looked at),
      // or null to clear. Painting only; where the reader is does not change.
      setFind: function (spec) {
        if (destroyed) return;
        if (!spec || !findNeedle(spec.query)) {
          find = null;
          pendingFocus = null;
        } else {
          find = {
            needle: findNeedle(spec.query),
            ids: new Set(spec.ids || []),
            active: spec.active || null,
          };
        }
        findStale = true;
        schedule();
      },
      // #138. Puts a row where the reader will see it: left alone when it is
      // already wholly in view, else `top` px under the top edge (the existing
      // restorePlace path, so an unmounted row far away is reached the way a
      // reload reaches it), then its first mark is brought into view if the row
      // is taller than the box.
      // #129. `always` is for a reader who asked for this row by name (a turn
      // tapped in the index): it is put at `top` even when it is wholly in view,
      // because a tap that moved nothing reads as a tap that did nothing. A
      // search leaves a visible hit where it is.
      revealItem: function (item, top, always) {
        if (destroyed || !item || items.indexOf(item) < 0) return;
        pendingFocus = item;
        var m = mounted.get(item.id);
        if (always || !(m && rowInView(m))) {
          pendingPlace = {
            item: item,
            top: typeof top === 'number' && isFinite(top) ? top : FIND_MARGIN,
          };
        }
        schedule();
      },
      mountedCount: function () {
        return mounted.size;
      },
      // Applying a saved zone. Only a change costs anything: the same zone is a
      // no-op, so the page can call this on every boot without repainting a
      // transcript that is already rendered correctly.
      setStampZone: function (zone) {
        var next = typeof zone === 'string' && zone ? zone : DEFAULT_STAMP_ZONE;
        if (next === stampZone) return;
        stampZone = next;
        restamp = true;
        schedule();
      },
      // Instant zero-reload swap onto another session's TranscriptModel.
      // Unmounts the outgoing viewport rows, binds `model` and `items` to the
      // incoming model, and restores `place` (or pins to the end) in one pass.
      setModel: function (nextModel, place) {
        if (destroyed || !nextModel) return;
        if (nextModel === model) {
          if (
            place &&
            !place.end &&
            place.item &&
            items.indexOf(place.item) >= 0
          ) {
            pendingPlace = {
              item: place.item,
              top:
                typeof place.top === 'number' && isFinite(place.top)
                  ? place.top
                  : 0,
            };
          } else {
            pendingEnd = true;
            follow = true;
          }
          schedule();
          return;
        }
        unsubscribe();
        var oldIds = [];
        mounted.forEach(function (_, id) {
          oldIds.push(id);
        });
        for (var oi = 0; oi < oldIds.length; oi++) unmount(oldIds[oi]);
        if (virtualizer) virtualizer.measureElement(null);
        dirty.clear();
        live.clear();
        lineCache = new WeakMap();
        model = nextModel;
        items = model.items;
        unsubscribe = model.subscribe(onModelEvent);
        for (var mi = 0; mi < items.length; mi++) {
          if (isLive(items[mi])) live.add(items[mi]);
        }
        syncTimer();
        find = null;
        pendingFocus = null;
        findStale = true;
        hold = null;
        relayoutFrom = null;
        edgeCarry = 0;
        edgeAnchorNode = null;
        structural = true;
        if (
          place &&
          !place.end &&
          place.item &&
          items.indexOf(place.item) >= 0
        ) {
          pendingPlace = {
            item: place.item,
            top:
              typeof place.top === 'number' && isFinite(place.top)
                ? place.top
                : 0,
          };
          pendingEnd = false;
          follow = false;
        } else {
          pendingPlace = null;
          pendingEnd = true;
          follow = true;
          nearBottom = true;
        }
        if (virtualizer) {
          virtualizer.measure();
          vopts.count = items.length;
          virtualizer.setOptions(vopts);
          if (pendingEnd && scroller.clientHeight > 0) toEnd();
        }
        if (scroller.clientHeight > 0) {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
          pass();
        } else {
          schedule();
        }
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
        find = null;
        paintFind();
        scroller.removeEventListener('scroll', onScroll);
        if (boxResizeObserver) {
          boxResizeObserver.unobserve(scroller);
          boxResizeObserver = null;
        }
        if (headerObserver) {
          headerObserver.disconnect();
          headerObserver = null;
        }
        // The header goes back where the page had it, as it was styled: the
        // page still finds its controls by id after the view is gone.
        if (header) {
          header.style.cssText = headerHome.css;
          if (headerHome.parent) {
            headerHome.parent.insertBefore(
              header,
              headerHome.next && headerHome.next.parentNode === headerHome.parent
                ? headerHome.next
                : null,
            );
          } else {
            header.remove();
          }
        }
        scroller.removeEventListener('touchstart', onTouchStart);
        scroller.removeEventListener('touchend', onTouchEnd);
        scroller.removeEventListener('touchcancel', onTouchEnd);
        dropAllTouchNodes();
        if (unmountVirtualizer) unmountVirtualizer();
        host.remove();
        if (virtualizer) scroller.style.overflowAnchor = savedOverflowAnchor;
        mounted.clear();
        dirty.clear();
        live.clear();
      },
    };
  }

  globalThis.TranscriptView = {
    createTranscriptView: createTranscriptView,
    formatStamp: function (ms, zone) {
      return stampText({ time: ms }, zone || DEFAULT_STAMP_ZONE);
    },
  };
})();
