/* ==========================================================================
   xp.js — the window manager and desktop shell.

   Architecture: every window already exists in the document as a
   <section data-window>. This script only ADDS chrome around that content and
   positions it. It never copies, clones, or re-authors a content node, so the
   resume exists exactly once in the DOM, and the print/no-JS view is the same
   nodes the windows are made of.

   State is the single source of truth; the DOM is rendered from it.
   ========================================================================== */
(function () {
'use strict';

var doc = document, root = doc.documentElement;
var Z_BASE = 100, Z_MAX = 890;
var MOBILE_Q = window.matchMedia('(max-width: 767px)');
var MOTION_Q = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- tiny helpers ---------- */
function el(tag, cls, html) {
  var n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
function svgUse(id, cls) {
  var s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  var u = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#' + id);
  s.appendChild(u);
  return s;
}
function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch (e) { /* private mode, blocked storage: preferences just don't persist */ }
  return null;
}
function reduceMotion() { return root.classList.contains('reduce-motion') || MOTION_Q.matches; }

/* ==========================================================================
   1. STATE
   ========================================================================== */
var wins = [];      // window records, document order
var byId = {};
var zTop = Z_BASE;
var focusedId = null;
var lastFocusOutside = null;   // element to restore focus to when a window closes

function rec(section) {
  var d = section.dataset;
  return {
    id: section.id,
    node: section,
    title: d.title || section.id,
    label: d.label || d.title || section.id,
    icon: 'icon-' + (d.icon || 'doc-text'),
    shell: d.shell || 'notepad',
    w: parseInt(d.w, 10) || 560,
    h: parseInt(d.h, 10) || 420,
    x: parseInt(d.x, 10) || 60,
    y: parseInt(d.y, 10) || 40,
    fixed: d.fixed === '1',
    onDesktop: d.desktop === '1',
    col: parseInt(d.col, 10) || 1,
    row: parseInt(d.row, 10) || 1,
    openOnLoad: d.open === '1',
    state: 'closed',            // closed | normal | minimized | maximized
    z: 0,
    pre: null,                  // geometry before maximize
    wasMax: false,              // was it maximized when minimized?
    chrome: null,
    tbBtn: null,
    dIcon: null
  };
}

/* ==========================================================================
   2. BUILD CHROME  (adds only; never touches content nodes)
   ========================================================================== */
var CAP = [
  { k: 'min', sym: 'ui-caption-minimize', name: 'Minimize' },
  { k: 'max', sym: 'ui-caption-maximize', name: 'Maximize' },
  { k: 'close', sym: 'ui-caption-close', name: 'Close' }
];

function buildWindow(w) {
  var s = w.node;
  // Compute status text NOW, while the content is still a child of the section.
  // After the move it lives in a detached subtree and would not be found.
  var statusText = statusFor(w);
  s.classList.add('window');
  s.setAttribute('role', 'region');           // non-modal: NOT a dialog, no aria-modal
  s.setAttribute('data-shell', w.shell);
  if (w.fixed) s.classList.add('is-fixed');
  s.hidden = true;

  /* --- title bar --- */
  var bar = el('div', 'title-bar');
  bar.appendChild(svgUse(w.icon, 'title-icon'));
  var t = el('span', 'title-text');
  t.textContent = w.title;
  t.setAttribute('aria-hidden', 'true');      // real name comes from aria-labelledby
  bar.appendChild(t);

  var ctrls = el('div', 'win-controls');
  ctrls.setAttribute('role', 'toolbar');
  ctrls.setAttribute('aria-label', 'Window controls');
  CAP.forEach(function (c) {
    if (w.fixed && c.k === 'max') return;
    var b = el('button', 'cap-btn cap-btn--' + c.k);
    b.type = 'button';
    b.dataset.cap = c.k;
    b.setAttribute('aria-label', c.name);
    b.appendChild(svgUse(c.sym));
    ctrls.appendChild(b);
    if (c.k === 'max') w.maxBtn = b;
  });
  bar.appendChild(ctrls);
  s.insertBefore(bar, s.firstChild);

  /* --- inner frame: everything below the caption --- */
  var inner = el('div', 'win-frame-inner');
  var body = el('div', 'win-body');

  // Move the existing content into the body. appendChild is a MOVE, not a copy.
  while (bar.nextSibling) {
    var n = bar.nextSibling;
    if (n === inner) break;
    body.appendChild(n);
  }

  if (s.dataset.menu) inner.appendChild(buildMenubar(s.dataset.menu));
  inner.appendChild(body);

  var status = el('div', 'win-status');
  var st1 = el('span');
  st1.textContent = statusText;
  status.appendChild(st1);
  var grip = el('span', 'win-gripper');
  grip.setAttribute('aria-hidden', 'true');
  status.appendChild(grip);
  inner.appendChild(status);

  s.appendChild(inner);

  /* --- shell-specific restructuring of the body --- */
  if (w.shell === 'explorer') shellExplorer(w, body);
  if (w.shell === 'tree') shellTree(w, body);
  if (w.shell === 'dialog') shellDialog(w, inner, body);
  if (w.shell === 'help') shellHelp(w, body);

  /* --- resize handles --- */
  if (!w.fixed) {
    ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].forEach(function (dir) {
      var h = el('div', 'rz rz-' + dir);
      h.dataset.rz = dir;
      s.appendChild(h);
    });
  }

  w.chrome = { bar: bar, body: body, status: st1 };
  return w;
}

/* Status text is derived from real content, never authored, so it can never
   drift out of sync with what the window actually shows. */
function statusFor(w) {
  var role = w.node.querySelector('.role');
  if (role) return role.textContent.replace(/\s+/g, ' ').trim();
  var n = w.node.querySelectorAll('.entry').length;
  if (n) return n + (n === 1 ? ' item' : ' items');
  var li = w.node.querySelectorAll('.tree-group > ul > li').length;
  if (li) return li + ' items';
  var topics = w.node.querySelectorAll('.topic').length;
  if (topics) return topics + ' topics';
  return w.label;
}

function buildMenubar(spec) {
  var mb = el('div', 'win-menubar');
  mb.setAttribute('role', 'menubar');
  spec.split(',').forEach(function (name) {
    var b = el('button');
    b.type = 'button';
    b.textContent = name.trim();
    b.dataset.menuName = name.trim();
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    mb.appendChild(b);
  });
  return mb;
}

/* Real menu contents. A menu bar that does nothing is a worse affordance than
   no menu bar, so every item here performs a genuine action. */
function menubarItems(name, w) {
  var body = w.chrome && w.chrome.body;
  switch (name) {
    case 'File': return [
      { label: 'Save As...', key: 'PDF', run: function () { downloadPdf(); } },
      { label: 'Print...', key: 'Ctrl+P', run: function () { window.print(); } },
      '-',
      { label: 'Exit', key: 'Esc', run: function () { WM.close(w.id); } }
    ];
    case 'Edit': return [
      { label: 'Select All', key: 'Ctrl+A', run: function () {
          if (!body) return;
          var r = doc.createRange();
          r.selectNodeContents(body);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } },
      { label: 'Find...', key: 'Ctrl+F', disabled: true }
    ];
    case 'Format': return [
      { label: (body && body.classList.contains('no-wrap') ? '✓ ' : '') + 'Word Wrap',
        run: function () { if (body) body.classList.toggle('no-wrap'); } }
    ];
    case 'View': return [
      { label: 'Status Bar', disabled: true },
      '-',
      { label: 'Display Properties...', run: function () { WM.open('win-display'); } }
    ];
    case 'Help': return [
      { label: 'Help and Support', key: 'F1', run: function () { WM.open('win-help'); } },
      '-',
      { label: 'About this site', run: function () { WM.open('win-help'); } }
    ];
  }
  return [{ label: '(nothing here)', disabled: true }];
}

function downloadPdf() {
  var a = doc.createElement('a');
  a.href = 'Resume.pdf';
  a.setAttribute('download', '');
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------- Explorer: blue task pane + content list ---------- */
function shellExplorer(w, body) {
  var split = el('div', 'explorer-split');
  var pane = el('aside', 'task-pane');
  var main = el('div', 'explorer-main');

  var box = el('div', 'task-pane-box');
  box.appendChild(el('h4', null, w.node.dataset.paneTitle || w.label));
  var inner = el('div');
  if (w.node.dataset.paneDetail) inner.appendChild(el('p', null, w.node.dataset.paneDetail));
  box.appendChild(inner);
  pane.appendChild(box);

  // "Other Places" — a real third navigation path, and authentic XP furniture.
  var other = el('div', 'task-pane-box');
  other.appendChild(el('h4', null, 'Other Places'));
  var ul = el('ul');
  wins.forEach(function (o) {
    if (o.id === w.id || o.node.dataset.nodoc === '1') return;
    var li = el('li');
    var b = el('button', 'task-link');
    b.type = 'button';
    b.dataset.open = o.id;
    b.appendChild(svgUse(o.icon));
    b.appendChild(el('span', null, o.label));
    li.appendChild(b);
    ul.appendChild(li);
  });
  other.appendChild(ul);
  pane.appendChild(other);

  // Move the real content into the main area — a move, never a copy. Snapshot
  // the child list first: mutating while walking firstChild skips nodes.
  [].slice.call(body.childNodes).forEach(function (n) {
    if (n.nodeType === 1 && (n.tagName === 'H1' || n.tagName === 'H2')) return; // heading stays
    main.appendChild(n);
  });
  split.appendChild(pane);
  split.appendChild(main);
  body.appendChild(split);   // heading is still body's first child, so order holds
  body.style.overflow = 'hidden';
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
}

/* ---------- Device Manager tree ---------- */
function shellTree(w, body) {
  var tree = body.querySelector('.tree');
  if (!tree) return;
  var rootRow = el('div', 'tree-root');
  rootRow.appendChild(svgUse('icon-computer'));
  rootRow.appendChild(el('span', null, tree.dataset.treeRoot || 'Computer'));
  tree.insertBefore(rootRow, tree.firstChild);

  tree.querySelectorAll('.tree-group').forEach(function (g) {
    g.setAttribute('aria-expanded', 'true');
    var h3 = g.querySelector(':scope > .tree-name');
    var name = h3 ? h3.textContent.trim() : 'Group';
    var head = el('div', 'tree-head');

    var tog = el('button', 'tree-toggle');
    tog.type = 'button';
    tog.appendChild(svgUse('ui-tree-collapse'));
    tog.setAttribute('aria-label', 'Collapse ' + name);
    head.appendChild(tog);

    var lab = el('button', 'tree-label');
    lab.type = 'button';
    lab.appendChild(svgUse('icon-' + (g.dataset.icon || 'gear')));
    if (h3) lab.appendChild(h3);          // MOVE the real heading, never copy it
    else lab.appendChild(el('span', null, name));
    head.appendChild(lab);

    g.insertBefore(head, g.firstChild);

    function toggle() {
      var open = g.getAttribute('aria-expanded') === 'true';
      g.setAttribute('aria-expanded', String(!open));
      tog.querySelector('use').setAttribute('href', open ? '#ui-tree-expand' : '#ui-tree-collapse');
      tog.setAttribute('aria-label', (open ? 'Expand ' : 'Collapse ') + name);
    }
    tog.addEventListener('click', toggle);
    lab.addEventListener('click', toggle);

    g.querySelectorAll(':scope > ul > li').forEach(function (li) {
      li.insertBefore(svgUse('icon-gear'), li.firstChild);
    });
  });
}

/* ---------- Dialog with a tab strip ---------- */
function shellDialog(w, inner, body) {
  var names = (w.node.dataset.tabs || '').split(',').filter(Boolean);
  if (!names.length) return;
  var strip = el('div', 'xp-tabstrip');
  strip.setAttribute('role', 'tablist');
  var panels = {};
  names.forEach(function (raw, i) {
    var name = raw.trim();
    var p = body.querySelector('[data-tab="' + name + '"]');
    if (!p) return;
    panels[name] = p;
    p.setAttribute('role', 'tabpanel');
    p.id = w.id + '-tab-' + i;
    p.hidden = i !== 0;

    var b = el('button');
    b.type = 'button';
    b.textContent = name;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === 0));
    b.setAttribute('aria-controls', p.id);
    b.tabIndex = i === 0 ? 0 : -1;
    strip.appendChild(b);
  });
  var tabs = [].slice.call(strip.children);
  function select(i) {
    tabs.forEach(function (b, j) {
      b.setAttribute('aria-selected', String(i === j));
      b.tabIndex = i === j ? 0 : -1;
      panels[b.textContent].hidden = i !== j;
    });
    tabs[i].focus();
  }
  strip.addEventListener('click', function (e) {
    var b = e.target.closest('[role=tab]');
    if (b) select(tabs.indexOf(b));
  });
  strip.addEventListener('keydown', function (e) {
    var i = tabs.indexOf(doc.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight') { select((i + 1) % tabs.length); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { select((i - 1 + tabs.length) % tabs.length); e.preventDefault(); }
    if (e.key === 'Home') { select(0); e.preventDefault(); }
    if (e.key === 'End') { select(tabs.length - 1); e.preventDefault(); }
  });
  inner.insertBefore(strip, inner.firstChild);
}

/* ---------- Help and Support: topic rail + reading pane ---------- */
function shellHelp(w, body) {
  var names = (w.node.dataset.topics || '').split(',').filter(Boolean);
  var split = el('div', 'help-split');
  var rail = el('nav', 'help-rail');
  rail.setAttribute('aria-label', 'Help topics');
  var main = el('div', 'help-main');

  rail.appendChild(el('h4', null, 'Pick a topic'));
  var ul = el('ul');
  var links = [], topics = [];

  names.forEach(function (raw, i) {
    var name = raw.trim();
    var t = body.querySelector('[data-topic="' + name + '"]');
    if (!t) return;
    t.hidden = i !== 0;
    topics.push(t);
    var li = el('li');
    var b = el('button', 'task-link');
    b.type = 'button';
    b.appendChild(svgUse('icon-help'));
    b.appendChild(el('span', null, name));
    b.setAttribute('aria-current', String(i === 0));
    li.appendChild(b);
    ul.appendChild(li);
    links.push(b);
  });
  rail.appendChild(ul);

  topics.forEach(function (t) { main.appendChild(t); });
  links.forEach(function (b, i) {
    b.addEventListener('click', function () {
      topics.forEach(function (t, j) { t.hidden = i !== j; });
      links.forEach(function (l, j) { l.setAttribute('aria-current', String(i === j)); });
      main.scrollTop = 0;
    });
  });

  split.appendChild(rail);
  split.appendChild(main);
  var head = body.querySelector(':scope > h1, :scope > h2');
  body.appendChild(split);
  if (head) body.insertBefore(head, split);
  body.style.overflow = 'hidden';
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
}

/* ==========================================================================
   3. GEOMETRY
   ========================================================================== */
function deskRect() {
  var d = doc.getElementById('desktop');
  return { w: d.clientWidth, h: d.clientHeight };
}

/* A window may hang off the left, right and bottom edge, exactly like real
   Windows. What has to stay reachable is a slice of TITLE BAR — not the box's
   top-left corner, which is all an unconditional Math.max(0, x) protects.
   Clamping the corner meant a wide window grabbed mid-caption stopped moving
   while the pointer kept going. */
var KEEP = 80;                       // px of caption that must stay on-desktop
function clampX(x, wpx, r) { return Math.max(KEEP - wpx, Math.min(x, r.w - KEEP)); }
function clampY(y, r)      { return Math.max(0, Math.min(y, r.h - 28)); }
function applyGeom(w) {
  var s = w.node;
  if (w.state === 'maximized' || MOBILE_Q.matches) {
    s.style.left = s.style.top = s.style.width = s.style.height = '';
    return;
  }
  var r = deskRect();
  var width = Math.min(w.w, Math.max(240, r.w - 8));
  var height = Math.min(w.h, Math.max(140, r.h - 8));
  // Clamp so the title bar is always reachable: never above 0, and always at
  // least 80px of the window's left edge on screen.
  var x = clampX(w.x, width, r);
  var y = clampY(w.y, r);
  /* Write the clamped result BACK into state. Previously this clamped into
     locals and rendered them while w.x/w.y kept the unclamped values, so state
     and DOM silently diverged — and beginDrag seeds its baseline from state, so
     the next drag started from a phantom origin and the window teleported. */
  w.x = x; w.y = y; w.w = width; w.h = height;
  s.style.left = x + 'px';
  s.style.top = y + 'px';
  s.style.width = width + 'px';
  s.style.height = height + 'px';
}
/* Overlap of the smaller window's area, 0..1. */
function occlusion(a, b) {
  var ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  var oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  return (ox * oy) / Math.min(a.w * a.h, b.w * b.h);
}

/* Windows are free to overlap — that is authentic, and with several large
   windows open it is unavoidable, since their combined area exceeds the
   desktop. What must not happen is a new window burying an existing one while
   an emptier spot was available.

   Testing origin proximity (the original rule) missed this completely: two wide
   windows can sit 150px apart and still hide 80% of each other. Walking a fixed
   cascade offset was no better — it stepped off the desktop and fell back to a
   position it never re-checked.

   So: score a list of candidate positions and take the best. Candidates are
   ordered by preference, and ties keep the earlier one, so a window that fits
   at its designed position stays there. */
function cascade(w) {
  var open = wins.filter(function (o) {
    return o !== w && (o.state === 'normal' || o.state === 'maximized');
  });
  if (!open.length) return;

  var r = deskRect();
  var maxX = Math.max(0, r.w - w.w), maxY = Math.max(0, r.h - w.h);
  var cand = [{ x: w.x, y: w.y }];                       // designed position first
  var i;
  for (i = 1; i <= 6; i++) cand.push({ x: w.x + i * 28, y: w.y + i * 26 });
  // Then the corners and centre, which are the emptiest spots once the middle
  // of the desktop is crowded.
  cand.push({ x: 0, y: 0 }, { x: maxX, y: 0 }, { x: 0, y: maxY }, { x: maxX, y: maxY },
             { x: Math.round(maxX / 2), y: Math.round(maxY / 2) });
  // A coarse grid as the last resort, so there is always something to find.
  for (var gx = 0; gx <= maxX; gx += 80) {
    for (var gy = 0; gy <= maxY; gy += 60) cand.push({ x: gx, y: gy });
  }

  var best = null, bestScore = Infinity;
  for (i = 0; i < cand.length; i++) {
    var c = {
      x: Math.max(0, Math.min(cand[i].x, maxX)),
      y: Math.max(0, Math.min(cand[i].y, maxY)),
      w: w.w, h: w.h
    };
    var worst = 0;
    for (var j = 0; j < open.length; j++) {
      var v = occlusion(open[j], c);
      if (v > worst) worst = v;
    }
    if (worst < bestScore) { bestScore = worst; best = c; }
    if (bestScore <= 0.35) break;              // good enough, keep the preference order
  }

  // A title bar must always be grabbable.
  w.x = clampX(best.x, w.w, r);
  w.y = clampY(best.y, r);
}

/* ==========================================================================
   4. WINDOW MANAGER API
   ========================================================================== */
var WM = {
  open: function (id, opts) {
    var w = byId[id];
    if (!w) return;
    if (w.state === 'closed') {
      if (!MOBILE_Q.matches) cascade(w);
      w.state = MOBILE_Q.matches ? 'maximized' : 'normal';
      w.node.hidden = false;
      if (!reduceMotion()) {
        w.node.classList.add('is-opening');
        setTimeout(function () { w.node.classList.remove('is-opening'); }, 200);
      }
    } else if (w.state === 'minimized') {
      w.state = w.wasMax ? 'maximized' : 'normal';
      w.wasMax = false;
      w.node.hidden = false;
    }
    applyGeom(w);
    WM.focus(id, opts && opts.silent);
    render();
  },

  close: function (id) {
    var w = byId[id];
    if (!w || w.state === 'closed') return;
    w.state = 'closed';
    w.node.hidden = true;
    if (focusedId === id) focusedId = null;
    render();
    // Focus must not be lost. Prefer the next window, else the invoking element.
    var next = wins.filter(function (o) { return o.state !== 'closed' && o.state !== 'minimized'; })
                   .sort(function (a, b) { return b.z - a.z; })[0];
    if (next) WM.focus(next.id);
    else if (lastFocusOutside && lastFocusOutside.isConnected) lastFocusOutside.focus();
    else doc.getElementById('start-button').focus();
    syncHash();
  },

  focus: function (id, silent) {
    var w = byId[id];
    if (!w || w.state === 'closed') return;
    if (w.state === 'minimized') {
      w.state = w.wasMax ? 'maximized' : 'normal';
      w.wasMax = false;
      w.node.hidden = false;
      applyGeom(w);
    }
    if (focusedId !== id) {
      // Monotonic counter, renormalized before it can overflow the band.
      if (++zTop > Z_MAX) {
        wins.slice().sort(function (a, b) { return a.z - b.z; })
            .forEach(function (o, i) { o.z = Z_BASE + i; });
        zTop = Z_BASE + wins.length;
      }
      w.z = zTop;
      w.node.style.zIndex = String(w.z);
      focusedId = id;
    }
    if (!silent) {
      // Move DOM focus into the window, but to the window itself rather than
      // its first link, so focus is not stolen into content unexpectedly.
      if (!w.node.contains(doc.activeElement)) {
        w.node.tabIndex = -1;
        w.node.focus({ preventScroll: true });
      }
    }
    render();
    syncHash();
  },

  minimize: function (id) {
    var w = byId[id];
    if (!w || w.state === 'closed') return;
    // Remember maximized-ness: Windows restores a minimized maximized window
    // back to maximized, not to its pre-maximize size.
    w.wasMax = (w.state === 'maximized');
    w.state = 'minimized';
    w.node.hidden = true;                       // out of the a11y tree and tab order
    if (focusedId === id) focusedId = null;
    render();
    var btn = w.tbBtn;
    if (btn) btn.focus();
  },

  toggleMaximize: function (id) {
    var w = byId[id];
    if (!w || w.fixed || w.state === 'closed') return;
    if (w.state === 'maximized') {
      if (w.pre) { w.x = w.pre.x; w.y = w.pre.y; w.w = w.pre.w; w.h = w.pre.h; }
      w.state = 'normal';
    } else {
      w.pre = { x: w.x, y: w.y, w: w.w, h: w.h };
      w.state = 'maximized';
    }
    applyGeom(w);
    WM.focus(id);
    render();
  },

  /* Taskbar semantics, matching real Windows exactly:
     clicking the focused window's button minimizes it; any other button
     focuses and restores. */
  taskbarClick: function (id) {
    var w = byId[id];
    if (!w) return;
    if (w.state === 'minimized' || focusedId !== id) WM.focus(id);
    else WM.minimize(id);
  },

  openOnly: function (id) {
    wins.forEach(function (w) { if (w.id !== id && w.state !== 'closed') WM.close(id === w.id ? null : w.id); });
    WM.open(id);
  }
};
window.XP = WM;

/* ==========================================================================
   5. RENDER  (derived entirely from state)
   ========================================================================== */
function render() {
  wins.forEach(function (w) {
    w.node.classList.toggle('is-focused', focusedId === w.id);
    w.node.classList.toggle('is-maximized', w.state === 'maximized');
    if (w.maxBtn) {
      var isMax = w.state === 'maximized';
      w.maxBtn.querySelector('use').setAttribute('href', isMax ? '#ui-caption-restore' : '#ui-caption-maximize');
      w.maxBtn.setAttribute('aria-label', isMax ? 'Restore' : 'Maximize');
    }
    if (w.dIcon) w.dIcon.classList.toggle('is-selected', selectedIcon === w.id);
  });
  renderTaskbar();
  var open = wins.some(function (w) { return w.state !== 'closed'; });
  doc.getElementById('desk-hint').hidden = open;
}

function renderTaskbar() {
  var host = doc.getElementById('task-buttons');
  wins.forEach(function (w) {
    var live = w.state !== 'closed';
    if (live && !w.tbBtn) {
      var b = el('button', 'tb-btn');
      b.type = 'button';
      b.dataset.task = w.id;
      b.appendChild(svgUse(w.icon));
      b.appendChild(el('span', null, w.label));
      b.tabIndex = -1;
      host.appendChild(b);
      w.tbBtn = b;
    } else if (!live && w.tbBtn) {
      w.tbBtn.remove();
      w.tbBtn = null;
    }
    if (w.tbBtn) {
      var active = focusedId === w.id && w.state !== 'minimized';
      w.tbBtn.classList.toggle('is-active', active);
      w.tbBtn.setAttribute('aria-pressed', String(active));
    }
  });
}

/* ==========================================================================
   6. DRAG + RESIZE  (pointer events, so touch and pen work identically)
   ========================================================================== */
/* Moving a window by writing left/top on every pointermove forces a layout and
   repaint of the whole window subtree each frame — visibly janky in the windows
   with the most nodes. So a move-drag runs entirely on a composited
   `transform`, and the offset is committed back into left/top only on release,
   which keeps state authoritative without paying layout per frame.
   A resize genuinely has to relayout, so it still writes width/height. Both
   modes write synchronously in the pointermove handler: Chrome already coalesces
   pointermove to frame cadence, so an extra requestAnimationFrame hop would only
   add a frame of lag and leave the window trailing the cursor. */
var drag = null, shield = null, dragRAF = 0;

function dragCursor(mode) {
  if (mode === 'move') return 'default';
  if (mode === 'n' || mode === 's') return 'ns-resize';
  if (mode === 'e' || mode === 'w') return 'ew-resize';
  if (mode === 'nw' || mode === 'se') return 'nwse-resize';
  return 'nesw-resize';
}

/* A full-viewport shield keeps one cursor for the whole gesture. Pointer
   capture means events still reach the window, so this only wins hit-testing
   for the cursor — and it stops hover states firing on content underneath. */
function makeShield() {
  if (shield) return shield;
  shield = el('div');
  shield.id = 'drag-shield';
  shield.hidden = true;
  doc.body.appendChild(shield);
  return shield;
}
function showShield(mode) {
  var sh = makeShield();
  sh.style.cursor = dragCursor(mode);
  sh.hidden = false;
}
function hideShield() { if (shield) shield.hidden = true; }

function beginDrag(e, w, mode) {
  if (e.button !== undefined && e.button !== 0) return;
  if (MOBILE_Q.matches) return;
  if (mode === 'move' && w.state === 'maximized') return;
  if (drag) endDrag();                       // never stack two gestures
  drag = {
    w: w, mode: mode, pid: e.pointerId,
    sx: e.clientX, sy: e.clientY,
    ox: w.x, oy: w.y, ow: w.w, oh: w.h,
    tx: w.x, ty: w.y, tw: w.w, th: w.h,
    r: deskRect(), started: false, dx: 0, dy: 0
  };
  /* Capture on the window element. The listener is delegated on document, so
     e.currentTarget is document here — which has no setPointerCapture, and
     capturing it silently failed. Without capture, a fast drag that outruns the
     cursor loses the pointer stream entirely. */
  drag.cap = w.node;
  try { w.node.setPointerCapture(e.pointerId); } catch (err) { drag.cap = null; }

  /* Promote to its own compositor layer NOW, on press, rather than on the first
     move. Creating a layer mid-gesture means the window has to be rasterized
     while the pointer is already moving, which reads as a stutter in the first
     few frames. Doing it on press spends that cost before any motion. The open
     animation also animates transform, and a running animation outranks an
     inline style, so it is dropped here too. */
  if (mode === 'move') {
    w.node.classList.remove('is-opening');
    w.node.style.willChange = 'transform';
  }
  /* Stop the native text-selection / image drag that otherwise competes with
     the move and makes it stutter. */
  e.preventDefault();
}

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.started) {
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;   // a click is not a drag
    drag.started = true;
    root.classList.add('is-dragging');
    showShield(drag.mode);
  }
  drag.dx = dx; drag.dy = dy;

  /* Coalesce to one write per frame. This costs NO latency: rAF callbacks run in
     the frame's animation phase, which is after input dispatch and before style
     and paint, so the value written here lands in the very same composite a
     synchronous write would have. What it removes is redundant work when the
     pointer reports faster than the display — Chrome already merges pointermove
     to frame cadence, but Firefox dispatches at device rate, so a high-polling
     mouse there produced several style writes per frame. */
  if (!dragRAF) dragRAF = requestAnimationFrame(paintDrag);
}

function paintDrag() {
  dragRAF = 0;
  if (!drag || !drag.started) return;
  if (drag.mode === 'move') paintMove();
  else paintResize();
}

/* Writes only — never reads layout, so it cannot force a reflow.
   NO clamping here. The window tracks the pointer 1:1 for the whole gesture and
   is brought back inside the desktop once, on release. Clamping every frame
   pinned the window against the edge while the cursor kept travelling, then let
   it rejoin when the cursor came back — stick-slip that reads as both "doesn't
   follow the cursor" and "stutters, then jumps". */
function paintMove() {
  var d = drag, r = d.r;
  /* Clamp during the gesture, but with bounds that only bite at a real screen
     edge: the window may travel until just KEEP px of caption is left, exactly
     like dragging a window off the side in Windows. The original bug was
     clamping the window's own top-left corner to >= 0, which stopped a wide
     window hundreds of px before the cursor reached any edge.
     Clamping here rather than on release means the committed position always
     equals the rendered one, so releasing never snaps. */
  d.tx = clampX(d.ox + d.dx, d.ow, r);
  d.ty = clampY(d.oy + d.dy, r);
  d.w.node.style.transform =
    'translate3d(' + (d.tx - d.ox) + 'px,' + (d.ty - d.oy) + 'px,0)';
}

function paintResize() {
  var d = drag, s = d.w.node, r = d.r;
  var m = d.mode, minW = 260, minH = 150;
  var nx = d.ox, ny = d.oy, nw = d.ow, nh = d.oh;
  if (m.indexOf('e') > -1) nw = Math.max(minW, Math.min(d.ow + d.dx, r.w - d.ox));
  if (m.indexOf('s') > -1) nh = Math.max(minH, Math.min(d.oh + d.dy, r.h - d.oy));
  if (m.indexOf('w') > -1) {
    nw = Math.min(Math.max(minW, d.ow - d.dx), d.ox + d.ow);
    nx = Math.max(0, d.ox + (d.ow - nw));
  }
  if (m.indexOf('n') > -1) {
    nh = Math.min(Math.max(minH, d.oh - d.dy), d.oy + d.oh);
    ny = Math.max(0, d.oy + (d.oh - nh));
  }
  d.tx = nx; d.ty = ny; d.tw = nw; d.th = nh;
  s.style.left = nx + 'px'; s.style.top = ny + 'px';
  s.style.width = nw + 'px'; s.style.height = nh + 'px';
}

function endDrag(e) {
  if (!drag) return;
  if (e && e.pointerId !== undefined && e.pointerId !== drag.pid) return;
  var d = drag;
  drag = null;
  if (dragRAF) { cancelAnimationFrame(dragRAF); dragRAF = 0; }
  try { if (d.cap) d.cap.releasePointerCapture(d.pid); } catch (err) {}

  if (!d.started) {
    d.w.node.style.willChange = '';   // a press that never became a drag
  } else {
    var s = d.w.node;
    if (d.mode === 'move') {
      // Clamp ONCE, here, so the gesture itself is never decoupled from the
      // cursor. Use the latest delta rather than the last painted frame: a
      // release landing before a pending rAF would otherwise lose a frame of
      // travel.
      // paintMove already clamped, so this is the same value that is on screen:
      // commit is a no-op visually and cannot snap.
      d.w.x = d.tx;
      d.w.y = d.ty;
      s.style.left = d.w.x + 'px';
      s.style.top = d.w.y + 'px';
      s.style.transform = '';
      /* Force the recalc now so the transform removal and the new left/top are
         applied together. Without this the element kept its old composited
         transform for a frame while left/top had already moved, so every drag
         ended with the window snapping from its pre-release position to the
         committed one — a visible jump at the end of the gesture. */
      void s.offsetWidth;
      /* Release the layer only on the NEXT frame. Dropping will-change in the
         same task tears the layer down while that swap is still settling, which
         is what made the stale transform visible in the first place. */
      requestAnimationFrame(function () {
        if (!drag || drag.w !== d.w) s.style.willChange = '';
      });
    } else {
      d.w.x = d.tx; d.w.y = d.ty; d.w.w = d.tw; d.w.h = d.th;
      s.style.willChange = '';
    }
  }
  root.classList.remove('is-dragging');
  hideShield();
}

// pointercancel matters: without it a drag can leak and stick to the cursor.
doc.addEventListener('pointermove', moveDrag);
doc.addEventListener('pointerup', endDrag);
doc.addEventListener('pointercancel', endDrag);
// Losing capture (Esc, another gesture, the tab going away) must also end it.
doc.addEventListener('lostpointercapture', function (e) {
  if (drag && e.pointerId === drag.pid) endDrag(e);
});

/* ---------- keyboard move / size modes (the WCAG 2.2 drag alternative) ---------- */
var kbMode = null;
function enterKbMode(w, mode) {
  kbMode = { w: w, mode: mode, x: w.x, y: w.y, wd: w.w, ht: w.h };
  announce((mode === 'move' ? 'Move' : 'Size') + ' mode. Arrow keys to ' +
           (mode === 'move' ? 'move' : 'resize') + ', Enter to accept, Escape to cancel.');
  w.node.classList.add('is-kbmode');
  w.node.focus({ preventScroll: true });
}
function exitKbMode(commit) {
  if (!kbMode) return;
  var w = kbMode.w;
  if (!commit) { w.x = kbMode.x; w.y = kbMode.y; w.w = kbMode.wd; w.h = kbMode.ht; applyGeom(w); }
  w.node.classList.remove('is-kbmode');
  announce(commit ? 'Done.' : 'Cancelled.');
  kbMode = null;
}
function kbNudge(key, shift) {
  var w = kbMode.w, step = shift ? 1 : 12, r = deskRect();
  if (kbMode.mode === 'move') {
    // Same bounds as a pointer drag, so keyboard Move can reach every position
    // dragging can. Previously this clamped the box corner to >= 0, which meant
    // a window could be dragged off the left edge but never moved back there
    // with the keyboard.
    if (key === 'ArrowLeft')  w.x = clampX(w.x - step, w.w, r);
    if (key === 'ArrowRight') w.x = clampX(w.x + step, w.w, r);
    if (key === 'ArrowUp')    w.y = clampY(w.y - step, r);
    if (key === 'ArrowDown')  w.y = clampY(w.y + step, r);
  } else {
    if (key === 'ArrowLeft') w.w = Math.max(260, w.w - step);
    if (key === 'ArrowRight') w.w = Math.min(r.w - w.x, w.w + step);
    if (key === 'ArrowUp') w.h = Math.max(150, w.h - step);
    if (key === 'ArrowDown') w.h = Math.min(r.h - w.y, w.h + step);
  }
  applyGeom(w);
}

/* ==========================================================================
   7. MENUS  (window menu / desktop context menu)
   ========================================================================== */
var menuEl = null;
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}
function openMenu(items, x, y, returnTo) {
  closeMenu();
  var m = el('div', 'xp-menu');
  m.setAttribute('role', 'menu');
  items.forEach(function (it) {
    if (it === '-') { m.appendChild(doc.createElement('hr')); return; }
    var b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = it.label;
    if (it.key) b.appendChild(el('span', 'mi-key', it.key));
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    else b.addEventListener('click', function () { closeMenu(); it.run(); });
    m.appendChild(b);
  });
  doc.body.appendChild(m);
  var r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  menuEl = m;
  m._returnTo = returnTo;
  var first = m.querySelector('button:not([aria-disabled])');
  if (first) first.focus();

  m.addEventListener('keydown', function (e) {
    var btns = [].slice.call(m.querySelectorAll('button:not([aria-disabled])'));
    var i = btns.indexOf(doc.activeElement);
    if (e.key === 'ArrowDown') { btns[(i + 1) % btns.length].focus(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { btns[(i - 1 + btns.length) % btns.length].focus(); e.preventDefault(); }
    if (e.key === 'Escape') { closeMenu(); if (returnTo && returnTo.isConnected) returnTo.focus(); e.preventDefault(); }
  });
}

function windowMenu(w, x, y, returnTo) {
  var isMax = w.state === 'maximized';
  openMenu([
    { label: 'Restore', disabled: !isMax, run: function () { WM.toggleMaximize(w.id); } },
    { label: 'Move', key: 'Arrows', disabled: isMax || MOBILE_Q.matches, run: function () { enterKbMode(w, 'move'); } },
    { label: 'Size', key: 'Arrows', disabled: isMax || w.fixed || MOBILE_Q.matches, run: function () { enterKbMode(w, 'size'); } },
    '-',
    { label: 'Minimize', run: function () { WM.minimize(w.id); } },
    { label: 'Maximize', disabled: isMax || w.fixed, run: function () { WM.toggleMaximize(w.id); } },
    '-',
    { label: 'Close', key: 'Esc', run: function () { WM.close(w.id); } }
  ], x, y, returnTo);
}

/* ==========================================================================
   8. SHELL: desktop, icons, taskbar, start menu, tray
   ========================================================================== */
var selectedIcon = null;

function buildShell() {
  var chrome = el('div');
  chrome.id = 'chrome';

  /* --- desktop + wallpaper --- */
  var desk = el('div');
  desk.id = 'desktop';
  desk.innerHTML =
    '<div class="wp-cloud wp-cloud--a" aria-hidden="true"></div>' +
    '<div class="wp-cloud wp-cloud--b" aria-hidden="true"></div>' +
    '<div class="wp-cloud wp-cloud--c" aria-hidden="true"></div>' +
    '<div class="wp-haze" aria-hidden="true"></div>' +
    '<svg class="wp-hill" viewBox="0 0 1440 300" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<defs>' +
        '<linearGradient id="hillBody" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#a8d24f"/><stop offset=".06" stop-color="#8fc63f"/>' +
          '<stop offset=".18" stop-color="#74b23a"/><stop offset=".42" stop-color="#55963a"/>' +
          '<stop offset=".70" stop-color="#3d7c31"/><stop offset="1" stop-color="#2b5f26"/>' +
        '</linearGradient>' +
        '<radialGradient id="hillSun" cx=".40" cy="0" r=".85">' +
          '<stop offset="0" stop-color="#eafaa8" stop-opacity=".40"/>' +
          '<stop offset=".45" stop-color="#cdeb72" stop-opacity=".15"/>' +
          '<stop offset="1" stop-color="#8fc63f" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="hillCorner" x1="0" y1="0" x2=".55" y2="1">' +
          '<stop offset="0" stop-color="#12330e" stop-opacity="0"/>' +
          '<stop offset="1" stop-color="#12330e" stop-opacity=".38"/>' +
        '</linearGradient>' +
        // explicit filter region is mandatory: the default clips the blur and
        // leaves a hard line where the filter output ends.
        '<filter id="hillSoft" x="-5%" y="-10%" width="110%" height="130%" color-interpolation-filters="sRGB">' +
          '<feGaussianBlur stdDeviation="0.9"/>' +
        '</filter>' +
      '</defs>' +
      '<g filter="url(#hillSoft)">' +
        '<path id="blissHill" fill="url(#hillBody)" d="M0 120C150 104 300 74 470 62C560 56 640 56 740 66C900 82 1090 100 1260 108C1340 112 1395 114 1440 116L1440 300L0 300Z"/>' +
        '<use href="#blissHill" fill="url(#hillSun)"/>' +
        '<use href="#blissHill" fill="url(#hillCorner)"/>' +
      '</g>' +
    '</svg>';

  /* --- desktop icons --- */
  var grid = el('ul');
  grid.id = 'icon-grid';
  grid.setAttribute('aria-label', 'Desktop');
  var deskWins = wins.filter(function (w) { return w.onDesktop; });
  var maxRow = 1;
  deskWins.forEach(function (w) {
    var li = el('li');
    li.style.setProperty('--c', w.col);   // the <li> is the grid item
    li.style.setProperty('--r', w.row);
    var b = el('button', 'dicon');
    b.type = 'button';
    b.dataset.open = w.id;
    b.appendChild(svgUse(w.icon));
    b.appendChild(el('span', null, w.label));
    b.tabIndex = -1;
    li.appendChild(b);
    grid.appendChild(li);
    w.dIcon = b;
    maxRow = Math.max(maxRow, w.row);
  });
  // The PDF sits at position 2, directly under About: "read it here" and
  // "take it with you" presented as one adjacent choice.
  var pdfLi = el('li');
  pdfLi.style.setProperty('--c', 1);
  pdfLi.style.setProperty('--r', 2);
  var pdf = el('a', 'dicon');
  pdf.href = 'Resume.pdf';
  pdf.setAttribute('download', '');
  pdf.appendChild(svgUse('icon-doc-pdf'));
  pdf.appendChild(el('span', null, 'Resume.pdf'));
  pdf.tabIndex = -1;
  pdfLi.appendChild(pdf);
  grid.appendChild(pdfLi);
  grid.style.setProperty('--icon-rows', Math.max(maxRow, 2));
  desk.appendChild(grid);
  if (deskWins[0]) deskWins[0].dIcon.tabIndex = 0;

  /* --- empty-desktop hint --- */
  var hint = el('div');
  hint.id = 'desk-hint';
  hint.setAttribute('role', 'note');
  hint.innerHTML = '<b>Nothing is open.</b>Double-click an icon to open it, or use the Start menu.';
  hint.hidden = true;
  desk.appendChild(hint);

  chrome.appendChild(desk);

  /* --- taskbar --- */
  var tb = el('div');
  tb.id = 'taskbar';
  tb.setAttribute('role', 'toolbar');
  tb.setAttribute('aria-label', 'Taskbar');

  var start = el('button');
  start.id = 'start-button';
  start.type = 'button';
  start.setAttribute('aria-expanded', 'false');
  start.setAttribute('aria-haspopup', 'menu');
  start.appendChild(svgUse('icon-windows-flag'));
  start.appendChild(el('span', null, 'start'));
  tb.appendChild(start);

  var ql = el('div');
  ql.id = 'quick-launch';
  ql.setAttribute('role', 'group');
  ql.setAttribute('aria-label', 'Quick Launch');
  // Quick Launch holds the three highest-value recruiter actions, always
  // visible at any width. About is not here — it opens on load and already has
  // a desktop icon and a pinned Start item.
  var qlAbout = el('button', 'ql-btn');
  qlAbout.type = 'button';
  qlAbout.dataset.open = 'win-experience';
  qlAbout.appendChild(svgUse('icon-briefcase'));
  qlAbout.appendChild(el('span', null, 'Experience'));
  qlAbout.tabIndex = -1;
  var qlPdf = el('a', 'ql-btn');
  qlPdf.href = 'Resume.pdf';
  qlPdf.setAttribute('download', '');
  qlPdf.appendChild(svgUse('icon-doc-pdf'));
  qlPdf.appendChild(el('span', null, 'Download PDF'));
  qlPdf.tabIndex = -1;
  var qlMail = el('button', 'ql-btn');
  qlMail.type = 'button';
  qlMail.dataset.open = 'win-contact';
  qlMail.appendChild(svgUse('icon-mail'));
  qlMail.appendChild(el('span', null, 'Contact'));
  qlMail.tabIndex = -1;
  ql.appendChild(qlAbout); ql.appendChild(qlPdf); ql.appendChild(qlMail);
  tb.appendChild(ql);

  var tasks = el('div');
  tasks.id = 'task-buttons';
  tasks.setAttribute('role', 'group');
  tasks.setAttribute('aria-label', 'Open windows');
  tb.appendChild(tasks);

  var tray = el('div');
  tray.id = 'tray';
  var trayHelp = el('button', 'tray-icon');
  trayHelp.type = 'button';
  trayHelp.dataset.open = 'win-help';
  trayHelp.setAttribute('aria-label', 'Help and Support');
  trayHelp.appendChild(svgUse('icon-help'));
  trayHelp.tabIndex = -1;
  var trayDisp = el('button', 'tray-icon');
  trayDisp.type = 'button';
  trayDisp.dataset.open = 'win-display';
  trayDisp.setAttribute('aria-label', 'Display Properties');
  trayDisp.appendChild(svgUse('icon-computer'));
  trayDisp.tabIndex = -1;
  var clock = el('span');
  clock.id = 'tray-clock';
  clock.tabIndex = -1;
  tray.appendChild(trayHelp); tray.appendChild(trayDisp); tray.appendChild(clock);
  tb.appendChild(tray);

  chrome.appendChild(tb);
  chrome.appendChild(buildStartMenu());
  chrome.appendChild(buildBalloon());

  var live = el('div', 'vh');
  live.id = 'live-status';
  live.setAttribute('aria-live', 'polite');
  chrome.appendChild(live);

  doc.body.appendChild(chrome);

  var skip = el('a', 'skip-link');
  skip.href = '#taskbar';
  skip.textContent = 'Skip to taskbar';
  doc.body.insertBefore(skip, doc.body.firstChild.nextSibling);

  startClock();
}

function buildStartMenu() {
  var m = el('div');
  m.id = 'start-menu';
  m.hidden = true;
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', 'Start menu');

  var head = el('div', 'sm-header');
  var av = el('div', 'sm-avatar');
  av.appendChild(svgUse('icon-user'));
  head.appendChild(av);
  var who = el('div');
  who.appendChild(el('div', 'sm-name', 'Diego Andre Gomez Ruiz'));
  who.appendChild(el('div', 'sm-role', 'Software Developer'));
  head.appendChild(who);
  m.appendChild(head);

  var cols = el('div', 'sm-cols');
  var left = el('div', 'sm-left');
  var right = el('div', 'sm-right');

  // Pinned: the two highest-value actions.
  var pinned = el('div', 'sm-pinned');
  var pAbout = smItem(wins.filter(function (w) { return w.id === 'win-about'; })[0], 'Start here');
  if (pAbout) pinned.appendChild(pAbout);
  var pPdf = el('a', 'sm-item');
  pPdf.href = 'Resume.pdf';
  pPdf.setAttribute('download', '');
  pPdf.setAttribute('role', 'menuitem');
  pPdf.appendChild(svgUse('icon-doc-pdf'));
  pPdf.appendChild(el('span', null, '<b>Download Resume</b><small>PDF</small>'));
  pinned.appendChild(pPdf);
  left.appendChild(pinned);
  left.appendChild(el('hr', 'sm-sep'));

  // Everything else in the manifest, so the Start menu alone reaches it all.
  wins.forEach(function (w) {
    if (w.id === 'win-about' || w.node.dataset.nodoc === '1') return;
    left.appendChild(smItem(w));
  });

  // Right column: authentic XP associations, pointed at honest destinations.
  [['My Computer', 'icon-computer', 'win-skills'],
   ['Control Panel', 'icon-gear', 'win-display'],
   ['Help and Support', 'icon-help', 'win-help']].forEach(function (r) {
    var b = el('button', 'sm-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.dataset.open = r[2];
    b.appendChild(svgUse(r[1]));
    b.appendChild(el('span', null, r[0]));
    right.appendChild(b);
  });
  right.appendChild(el('hr', 'sm-sep'));
  [['GitHub', 'icon-globe', 'https://github.com/DA-Gomez'],
   ['LinkedIn', 'icon-globe', 'https://www.linkedin.com/in/diego-andre-gomez-ruiz'],
   ['Email', 'icon-mail', 'mailto:diangoru@my.yorku.ca']].forEach(function (r) {
    var a = el('a', 'sm-item');
    a.href = r[2];
    a.setAttribute('role', 'menuitem');
    if (r[2].indexOf('http') === 0) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    a.appendChild(svgUse(r[1]));
    a.appendChild(el('span', null, r[0]));
    right.appendChild(a);
  });

  cols.appendChild(left);
  cols.appendChild(right);
  m.appendChild(cols);

  var foot = el('div', 'sm-footer');
  var print = el('button', 'sm-item');
  print.type = 'button';
  print.setAttribute('role', 'menuitem');
  print.id = 'sm-print';
  print.appendChild(svgUse('icon-doc-text'));
  print.appendChild(el('span', null, 'Print Resume'));
  foot.appendChild(print);
  m.appendChild(foot);

  return m;
}
function smItem(w, sub) {
  if (!w) return null;
  var b = el('button', 'sm-item');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.dataset.open = w.id;
  b.appendChild(svgUse(w.icon));
  var s = el('span');
  s.innerHTML = '<b>' + w.label + '</b>' + (sub ? '<small>' + sub + '</small>' : '');
  b.appendChild(s);
  return b;
}

function buildBalloon() {
  var b = el('div');
  b.id = 'balloon';
  b.hidden = true;
  b.setAttribute('role', 'status');
  b.appendChild(svgUse('icon-info', 'balloon-icon'));
  b.appendChild(el('div', null,
    '<b>Everything here is also in the Start menu.</b>' +
    'Double-click a desktop icon to open it, or select it and press Enter.'));
  var x = el('button', 'balloon-close');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close notification');
  x.appendChild(svgUse('ui-caption-close'));
  b.appendChild(x);
  return b;
}

function startClock() {
  var c = doc.getElementById('tray-clock');
  function tick() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    c.textContent = h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
    c.title = d.toDateString();
  }
  tick();
  setInterval(tick, 15000);
}

function announce(msg) {
  var l = doc.getElementById('live-status');
  if (l) l.textContent = msg;
}

/* ==========================================================================
   9. START MENU open/close
   ========================================================================== */
function setStart(open) {
  var m = doc.getElementById('start-menu'), b = doc.getElementById('start-button');
  m.hidden = !open;
  b.setAttribute('aria-expanded', String(open));
  if (open) {
    var bal = doc.getElementById('balloon');
    if (bal) bal.hidden = true;      // never let the tip cover the menu it points at
    if (!reduceMotion()) {
      m.classList.add('is-opening');
      setTimeout(function () { m.classList.remove('is-opening'); }, 180);
    }
    var first = m.querySelector('.sm-item');
    if (first) first.focus();
  }
}
function startOpen() { return !doc.getElementById('start-menu').hidden; }

/* ==========================================================================
   10. HASH ROUTING — one URL works with and without JS
   ========================================================================== */
var hashLock = false;
function syncHash() {
  if (hashLock) return;
  var id = focusedId;
  var want = id ? '#' + id : '';
  if (want && location.hash !== want) {
    hashLock = true;
    try { history.replaceState(null, '', want); } catch (e) { }
    hashLock = false;
  }
}
function readHash() {
  var id = location.hash.replace(/^#/, '');
  return byId[id] ? id : null;
}

/* ==========================================================================
   11. THEME / SCALE / MOTION preferences
   ========================================================================== */
function applyPrefs() {
  var th = store('xp.theme') || 'luna';
  var fs = store('xp.fontsize') || 'normal';
  var rm = store('xp.motion') === '1';
  if (th !== 'luna') root.setAttribute('data-theme', th); else root.removeAttribute('data-theme');
  if (fs !== 'normal') root.setAttribute('data-fontsize', fs); else root.removeAttribute('data-fontsize');
  root.classList.toggle('reduce-motion', rm);
  var t = doc.querySelector('input[name=xp-theme][value="' + th + '"]');
  if (t) t.checked = true;
  var f = doc.querySelector('input[name=xp-fontsize][value="' + fs + '"]');
  if (f) f.checked = true;
  var m = doc.getElementById('opt-motion');
  if (m) m.checked = rm;
  wins.forEach(applyGeom);
}

/* ==========================================================================
   12. EVENT WIRING
   ========================================================================== */
function wire() {
  /* --- anything with data-open opens that window --- */
  doc.addEventListener('click', function (e) {
    var o = e.target.closest('[data-open]');
    if (o) {
      if (o.classList.contains('dicon') && e.detail === 1 && !MOBILE_Q.matches) return; // wait for dblclick
      lastFocusOutside = o;
      setStart(false);
      WM.open(o.dataset.open);
      return;
    }
    var task = e.target.closest('[data-task]');
    if (task) { WM.taskbarClick(task.dataset.task); return; }
    var cap = e.target.closest('.cap-btn');
    if (cap) {
      var w = byId[cap.closest('.window').id];
      if (cap.dataset.cap === 'close') WM.close(w.id);
      if (cap.dataset.cap === 'min') WM.minimize(w.id);
      if (cap.dataset.cap === 'max') WM.toggleMaximize(w.id);
      return;
    }
    var mbBtn = e.target.closest('.win-menubar button');
    if (mbBtn) {
      var mw = byId[mbBtn.closest('.window').id];
      var r = mbBtn.getBoundingClientRect();
      openMenu(menubarItems(mbBtn.dataset.menuName, mw), r.left, r.bottom, mbBtn);
      return;
    }
    if (e.target.closest('#start-button')) { setStart(!startOpen()); return; }
    if (e.target.closest('#sm-print')) { setStart(false); window.print(); return; }
    if (e.target.closest('.balloon-close')) {
      doc.getElementById('balloon').hidden = true;
      try { sessionStorage.setItem('xp.balloon', '1'); } catch (err) {}
      return;
    }
    // clicks outside dismiss transient surfaces
    if (!e.target.closest('#start-menu') && !e.target.closest('#start-button')) setStart(false);
    if (!e.target.closest('.xp-menu')) closeMenu();
    if (!e.target.closest('.dicon')) { selectedIcon = null; render(); }
  });

  /* --- desktop icons: single-click selects, double-click opens --- */
  doc.addEventListener('mousedown', function (e) {
    var ic = e.target.closest('.dicon');
    if (ic && ic.dataset.open) { selectedIcon = ic.dataset.open; render(); }
  });
  doc.addEventListener('dblclick', function (e) {
    var ic = e.target.closest('.dicon[data-open]');
    if (ic) { lastFocusOutside = ic; WM.open(ic.dataset.open); }
    var bar = e.target.closest('.title-bar');
    if (bar && !e.target.closest('.cap-btn')) {
      WM.toggleMaximize(bar.closest('.window').id);
    }
  });

  /* --- focus a window on any pointer press inside it --- */
  doc.addEventListener('pointerdown', function (e) {
    var win = e.target.closest('.window');
    if (win) {
      var w = byId[win.id];
      if (w && focusedId !== w.id) WM.focus(w.id, true);
      var bar = e.target.closest('.title-bar');
      if (bar && !e.target.closest('.cap-btn')) beginDrag(e, w, 'move');
      var rz = e.target.closest('[data-rz]');
      if (rz) beginDrag(e, w, rz.dataset.rz);
    }
  });

  /* --- right-click: window menu on a title bar, Properties on the desktop --- */
  doc.addEventListener('contextmenu', function (e) {
    var bar = e.target.closest('.title-bar');
    if (bar) {
      e.preventDefault();
      windowMenu(byId[bar.closest('.window').id], e.clientX, e.clientY, doc.activeElement);
      return;
    }
    if (e.target.id === 'desktop' || e.target.closest('#icon-grid') === null && e.target.closest('#desktop')) {
      e.preventDefault();
      openMenu([
        { label: 'Arrange Icons By', disabled: true },
        { label: 'Refresh', run: function () { wins.forEach(applyGeom); } },
        '-',
        { label: 'Print Resume', run: function () { window.print(); } },
        '-',
        { label: 'Properties', run: function () { WM.open('win-display'); } }
      ], e.clientX, e.clientY, doc.activeElement);
    }
  });

  /* --- global keyboard --- */
  doc.addEventListener('keydown', function (e) {
    /* keyboard move/size mode owns the arrows while active */
    if (kbMode) {
      if (e.key.indexOf('Arrow') === 0) { kbNudge(e.key, e.shiftKey); e.preventDefault(); return; }
      if (e.key === 'Enter') { exitKbMode(true); e.preventDefault(); return; }
      if (e.key === 'Escape') { exitKbMode(false); e.preventDefault(); return; }
    }

    /* Ctrl+Esc must be tested before plain Esc, or it never reaches its branch. */
    if (e.key === 'Escape' && e.ctrlKey) {
      setStart(!startOpen());
      if (!startOpen()) doc.getElementById('start-button').focus();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (menuEl) { closeMenu(); return; }
      if (startOpen()) { setStart(false); doc.getElementById('start-button').focus(); return; }
      if (focusedId) { WM.close(focusedId); e.preventDefault(); }
      return;
    }
    if (e.key === ' ' && e.altKey) {   /* Alt+Space: the window system menu */
      if (focusedId) {
        var w = byId[focusedId];
        var r = w.chrome.bar.getBoundingClientRect();
        windowMenu(w, r.left + 4, r.bottom, doc.activeElement);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Tab' && e.altKey) {   /* Alt+Tab: next window */
      var live = wins.filter(function (w) { return w.state !== 'closed'; });
      if (live.length) {
        var i = live.findIndex(function (w) { return w.id === focusedId; });
        WM.focus(live[(i + 1) % live.length].id);
      }
      e.preventDefault();
      return;
    }

    /* roving arrow navigation inside the icon grid and the taskbar */
    var ic = e.target.closest('.dicon');
    if (ic && e.key.indexOf('Arrow') === 0) {
      var icons = [].slice.call(doc.querySelectorAll('.dicon'));
      var i = icons.indexOf(ic);
      var d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
      var next = icons[(i + d + icons.length) % icons.length];
      icons.forEach(function (n) { n.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
      if (next.dataset.open) { selectedIcon = next.dataset.open; render(); }
      e.preventDefault();
      return;
    }
    var tbBtn = e.target.closest('#taskbar button, #taskbar a, #tray-clock');
    if (tbBtn && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      var stops = [].slice.call(doc.querySelectorAll(
        '#start-button, #quick-launch .ql-btn, #task-buttons .tb-btn, .tray-icon, #tray-clock'));
      var j = stops.indexOf(tbBtn);
      var nx = stops[(j + (e.key === 'ArrowRight' ? 1 : -1) + stops.length) % stops.length];
      stops.forEach(function (n) { if (n.id !== 'start-button') n.tabIndex = -1; });
      nx.tabIndex = 0;
      nx.focus();
      e.preventDefault();
    }
  });

  /* --- Enter/Space on a desktop icon --- */
  doc.addEventListener('keyup', function (e) {
    var ic = e.target.closest('.dicon[data-open]');
    if (ic && (e.key === 'Enter' || e.key === ' ')) { lastFocusOutside = ic; WM.open(ic.dataset.open); }
  });

  /* --- preference controls --- */
  doc.addEventListener('change', function (e) {
    var t = e.target;
    if (t.name === 'xp-theme') { store('xp.theme', t.value); applyPrefs(); }
    if (t.name === 'xp-fontsize') { store('xp.fontsize', t.value); applyPrefs(); }
    if (t.id === 'opt-motion') { store('xp.motion', t.checked ? '1' : '0'); applyPrefs(); }
  });

  /* --- viewport changes: re-clamp every window --- */
  var rt;
  window.addEventListener('resize', function () {
    if (drag) endDrag();       // applyGeom would fight the drag transform
    clearTimeout(rt);
    rt = setTimeout(function () { wins.forEach(applyGeom); }, 90);
  });
  MOBILE_Q.addEventListener('change', function () { wins.forEach(applyGeom); render(); });

  window.addEventListener('hashchange', function () {
    var id = readHash();
    if (id && byId[id].state === 'closed') WM.open(id);
    else if (id) WM.focus(id);
  });
}

/* ==========================================================================
   13. BOOT
   ========================================================================== */
function boot() {
  var sections = [].slice.call(doc.querySelectorAll('section[data-window]'));
  if (!sections.length) throw new Error('no windows in document');

  sections.forEach(function (s) {
    var w = rec(s);
    wins.push(w);
    byId[w.id] = w;
  });
  wins.forEach(buildWindow);

  buildShell();
  applyPrefs();
  wire();

  // A deep link wins over the default, so a shared #win-projects link lands
  // on projects with nothing else in the way.
  var deep = readHash();
  if (deep) WM.open(deep);
  else {
    var first = wins.filter(function (w) { return w.openOnLoad; })[0];
    if (first) WM.open(first.id);
  }
  render();

  // One balloon, once per session, never blocking, no motion if reduced.
  var shown = null;
  try { shown = sessionStorage.getItem('xp.balloon'); } catch (e) {}
  if (!shown && !MOBILE_Q.matches) {
    setTimeout(function () {
      var b = doc.getElementById('balloon');
      if (!b || startOpen() || menuEl || MOBILE_Q.matches) return;
      b.hidden = false;
      if (!reduceMotion()) {
        b.classList.add('is-opening');
        setTimeout(function () { b.classList.remove('is-opening'); }, 200);
      }
      setTimeout(function () { b.hidden = true; }, 11000);
    }, 1400);
  }

  root.classList.add('js-ready');
}

/* teardown: if boot throws we must leave a readable document, not a broken
   desktop. Removing .js reverts every desktop-scoped rule at once. */
function teardown() {
  var c = doc.getElementById('chrome');
  if (c) c.remove();
  doc.querySelectorAll('.window').forEach(function (s) {
    s.classList.remove('window', 'is-focused', 'is-maximized');
    s.removeAttribute('style');
    s.hidden = false;
    var bar = s.querySelector(':scope > .title-bar');
    var inner = s.querySelector(':scope > .win-frame-inner');
    var body = s.querySelector('.win-body');
    if (body) while (body.firstChild) s.appendChild(body.firstChild);
    if (bar) bar.remove();
    if (inner) inner.remove();
    s.querySelectorAll('.rz').forEach(function (h) { h.remove(); });
  });
}

if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go);
else go();

function go() {
  try { boot(); }
  catch (err) {
    root.classList.remove('js', 'js-ready');
    try { teardown(); } catch (e2) {}
    console.error('[xp] enhancement aborted, falling back to document', err);
  }
}

})();
