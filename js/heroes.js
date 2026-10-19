/* ==========================================================================
   HEROES — live class rows, the booking dock, the home aperture and the
   class-style deck.

   Class data comes from the same public Eversports endpoint the schedule
   widget on stundenplan.html uses (widget 747b62f2…, CORS open). It is
   undocumented: if it fails or changes shape, every list falls back to a link
   to the Stundenplan page, and the dock hides itself. Nothing on the page
   depends on it to be usable.

   Attribute API (all optional, all on plain elements):
     data-jym-board            wraps a list + studio buttons + title
     data-jym-list             <ul> that receives class rows
       data-count="4"          how many rows
       data-studio="all|L|G"   studio filter
       data-scope="next|day"   "day" = only the first day that still has classes
     data-jym-studio="L"       button inside a board, switches its list
     data-jym-title            text node, set to "Heute, Mittwoch" etc.
     data-jym-dock             the booking bubble (now line, book link, sheet)
     data-jym-next-of="Name"   text node, set to the next date of that class
     data-jym-next-at="L|G"    text node, set to the next class in that studio
     data-jym-cover            wrapper that gets .is-live once the aperture opens
     data-jym-aperture         tall section, drives --p from 0 to 1 on scroll
     data-jym-deck             stack of cards, cycles itself
     data-jym-planner          the week planner on stundenplan.html (days, filters, rows)
   ========================================================================== */
(function () {
  var ENDPOINT = 'https://graphql-widget-master.production.eversports.cloud/api/graphql';
  var WIDGET = '747b62f2-a622-479c-8f7f-8570df044af6';
  var CACHE_KEY = 'jym-classes-v3';
  var CACHE_MS = 10 * 60 * 1000;
  var TZ = 'Europe/Berlin';
  var DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  var SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var STUDIO = { L: 'Lehel', G: 'Glockenbach' };
  var STUDIO_IMG = { L: 'assets/images/munich/studio-lehel.webp', G: 'assets/images/munich/studio.webp' };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var QUERY = 'query JymNext($widgetId: ID!, $timeRange: TimeRangeInput, $first: Int) {' +
    ' widget(id: $widgetId) { ... on WidgetActivitySchedule {' +
    ' activities(activityGroupPublicationStates: [ACTIVE, VIEW_ONLY], timeRange: $timeRange, first: $first, isArchived: false) {' +
    ' nodes { start end isCancelled detailsPageURL limited { freeSpots totalSpots }' +
    ' activityGroup { name category { name } venue { name } imagesV2(first: 1) { nodes { url(size: X_LARGE) } } } teacher { name } } } } } }';

  /* ---------------------------------------------------------------- data */

  var ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var timeFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  var dowFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function ymd(d) { return ymdFmt.format(d); }
  function dayOffset(d) {
    var a = new Date(ymd(new Date()) + 'T00:00:00Z');
    var b = new Date(ymd(d) + 'T00:00:00Z');
    return Math.round((b - a) / 86400000);
  }
  function dayWord(d, lower) {
    var off = dayOffset(d);
    var w = off === 0 ? 'Heute' : off === 1 ? 'Morgen' : DAYS[DOW[dowFmt.format(d)]];
    return lower && off < 2 ? w.toLowerCase() : w;
  }
  function dayShort(d) {
    var off = dayOffset(d);
    return off === 0 ? 'Heute' : off === 1 ? 'Morgen' : SHORT[DOW[dowFmt.format(d)]];
  }

  /* "Jivamukti Open / Level III" -> name + level; drops "(+5€ …)" notes.
     Online classes keep their venue in Eversports; they get studio "O". */
  function normalise(n) {
    var raw = (n.activityGroup && n.activityGroup.name || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
    var parts = raw.split(/\s*\/{1,2}\s*/);
    var venue = (n.activityGroup.venue && n.activityGroup.venue.name) || '';
    var cat = n.activityGroup.category ? n.activityGroup.category.name : '';
    var online = /online/i.test(cat);
    var start = new Date(n.start);
    var end = new Date(n.end);
    return {
      start: start,
      end: end,
      minutes: Math.round((end - start) / 60000),
      name: parts[0].replace(/^Online\s+/i, '').replace(/\s+/g, ' '),
      level: (parts[1] || '').replace(/\s+/g, ' '),
      online: online,
      studio: online ? 'O' : /lehel/i.test(venue) ? 'L' : /glockenbach/i.test(venue) ? 'G' : '',
      teacher: n.teacher ? n.teacher.name.replace(/\s+/g, ' ').trim() : '',
      free: n.limited ? n.limited.freeSpots : null,
      url: n.detailsPageURL || 'stundenplan.html',
      /* the image the studio set for this class in Eversports (its studio photo) */
      image: n.activityGroup.imagesV2 && n.activityGroup.imagesV2.nodes[0] ? n.activityGroup.imagesV2.nodes[0].url : ''
    };
  }

  function revive(items) {
    return items.map(function (x) { x.start = new Date(x.start); x.end = new Date(x.end); return x; });
  }

  /* All non-cancelled activities between two dates, cached per range for the
     session. One retry: the endpoint occasionally answers a burst with an error
     that carries no CORS header, which the browser reports as a network failure. */
  var ranges = {};
  function fetchRange(start, end, key) {
    if (ranges[key]) return ranges[key];
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY + ':' + key) || 'null');
      if (c && Date.now() - c.t < CACHE_MS) { ranges[key] = Promise.resolve(revive(c.items)); return ranges[key]; }
    } catch (e) { /* storage blocked: fetch instead */ }
    var body = JSON.stringify({
      operationName: 'JymNext',
      query: QUERY,
      variables: { widgetId: WIDGET, first: 500, timeRange: { start: start.toISOString(), end: end.toISOString() } }
    });
    function request() {
      return fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    ranges[key] = request()
      .catch(function () { return new Promise(function (ok) { window.setTimeout(ok, 1500); }).then(request); })
      .then(function (json) {
        var items = json.data.widget.activities.nodes
          .filter(function (n) { return !n.isCancelled; })
          .map(normalise)
          .filter(function (x) { return x.studio; });
        items.sort(function (a, b) { return a.start - b.start; });
        try { sessionStorage.setItem(CACHE_KEY + ':' + key, JSON.stringify({ t: Date.now(), items: items })); } catch (e) { /* ignore */ }
        return items;
      });
    ranges[key].catch(function () { delete ranges[key]; });
    return ranges[key];
  }

  /* The heroes: in-studio classes from now to nine days ahead. */
  var feed = null;
  function loadClasses() {
    if (feed) return feed;
    var now = new Date();
    feed = fetchRange(new Date(now - 3600000), new Date(+now + 9 * 86400000), 'next-' + ymd(now))
      .then(function (items) { return items.filter(function (x) { return !x.online; }); });
    return feed;
  }

  function upcoming(items, opts) {
    var now = Date.now();
    var list = items.filter(function (x) {
      return x.start.getTime() > now && (!opts.studio || opts.studio === 'all' || x.studio === opts.studio);
    });
    if (opts.scope === 'day' && list.length) {
      var first = ymd(list[0].start);
      list = list.filter(function (x) { return ymd(x.start) === first; });
    }
    return list.slice(0, opts.count || 4);
  }

  /* ----------------------------------------------------------- rendering */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function rowHTML(x, withDay, compact) {
    var meta = [x.level, STUDIO[x.studio], compact ? '' : x.teacher].filter(Boolean).join(' · ');
    var spots = x.free !== null && x.free <= 8 ? '<span class="jym_row_spots">' + (x.free === 0 ? 'Ausgebucht' : 'Noch ' + x.free + ' Plätze') + '</span>' : '';
    var day = withDay && dayOffset(x.start) > 0 ? '<span class="jym_row_day">' + dayShort(x.start) + '</span>' : '';
    return '<li class="jym_row_item"><a class="jym_row' + (compact ? ' is-compact' : '') + '" href="' + esc(x.url) + '" target="_blank" rel="noopener">' +
      '<span class="jym_row_time">' + timeFmt.format(x.start) + day + '</span>' +
      '<span class="jym_row_main"><span class="jym_row_name">' + esc(x.name) + '</span>' +
      '<span class="jym_row_meta">' + esc(meta) + spots + '</span></span>' +
      (compact ? '' : '<span class="jym_row_cta">Buchen</span><span class="jym_row_go"><svg viewBox="0 0 66 70" fill="none" aria-hidden="true" class="u-svg arrow_icon is-row"><path d="M17 2L50 34.9999L17 68" class="u-path"></path></svg></span>') + '</a></li>';
  }

  function skeleton(n) {
    var h = '';
    for (var i = 0; i < n; i++) h += '<li class="jym_row_item is-loading"><span class="jym_row_ghost"></span></li>';
    return h;
  }

  var FALLBACK = '<li class="jym_row_item"><a class="jym_row is-fallback" href="stundenplan.html">' +
    '<span class="jym_row_main"><span class="jym_row_name">Alle Klassen im Stundenplan</span>' +
    '<span class="jym_row_meta">Lehel und Glockenbach, die ganze Woche</span></span>' +
    '<span class="jym_row_cta">Öffnen</span></a></li>';

  function renderList(list, items) {
    var opts = {
      count: +list.getAttribute('data-count') || 4,
      studio: list.getAttribute('data-studio') || 'all',
      scope: list.getAttribute('data-scope') || 'next',
      compact: list.hasAttribute('data-compact')
    };
    var rows = upcoming(items, opts);
    list.innerHTML = rows.length ? rows.map(function (x) { return rowHTML(x, opts.scope !== 'day', opts.compact); }).join('') : FALLBACK;
    var board = list.closest('[data-jym-board]');
    var title = board && board.querySelector('[data-jym-title]');
    if (title) {
      title.textContent = rows.length
        ? dayWord(rows[0].start) + ', ' + DAYS[DOW[dowFmt.format(rows[0].start)]]
        : 'Stundenplan';
      if (rows.length && dayOffset(rows[0].start) > 1) title.textContent = DAYS[DOW[dowFmt.format(rows[0].start)]];
    }
    return rows;
  }

  function initLists() {
    var lists = document.querySelectorAll('[data-jym-list]');
    var nexts = document.querySelectorAll('[data-jym-next-of]');
    var ats = document.querySelectorAll('[data-jym-next-at]');
    var docks = document.querySelectorAll('[data-jym-dock]');
    if (!lists.length && !nexts.length && !ats.length && !docks.length) return;

    Array.prototype.forEach.call(lists, function (list) {
      list.innerHTML = skeleton(+list.getAttribute('data-count') || 4);
    });

    loadClasses().then(function (items) {
      Array.prototype.forEach.call(lists, function (list) { renderList(list, items); });

      Array.prototype.forEach.call(document.querySelectorAll('[data-jym-board]'), function (board) {
        var list = board.querySelector('[data-jym-list]');
        board.addEventListener('click', function (e) {
          var b = e.target.closest('[data-jym-studio]');
          if (!b || !list) return;
          Array.prototype.forEach.call(board.querySelectorAll('[data-jym-studio]'), function (x) {
            x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
            x.classList.toggle('is-active', x === b);
          });
          list.setAttribute('data-studio', b.getAttribute('data-jym-studio'));
          renderList(list, items);
        });
      });

      Array.prototype.forEach.call(nexts, function (el) {
        var key = el.getAttribute('data-jym-next-of').toLowerCase();
        /* exact class name first ("Jivamukti Open" is not "Jivamukti Open English") */
        var ahead = items.filter(function (x) { return x.start > Date.now(); });
        var hit = ahead.filter(function (x) { return x.name.toLowerCase() === key; })[0] ||
          ahead.filter(function (x) { return x.name.toLowerCase().indexOf(key) === 0; })[0];
        if (!hit) return;
        el.textContent = 'Nächste: ' + dayWord(hit.start, true) + ' ' + timeFmt.format(hit.start) + ', ' + STUDIO[hit.studio];
        var card = el.closest('[data-jym-card]');
        var dur = card && card.querySelector('[data-jym-duration]');
        if (dur) dur.textContent = hit.minutes + ' Min';
        var link = card && card.querySelector('[data-jym-book]');
        if (link) { link.href = hit.url; link.target = '_blank'; link.rel = 'noopener'; }
        /* The card shows the image the studio uses for that class in Eversports,
           so the picture always matches the class the button books. */
        var img = card && card.querySelector('[data-jym-image]');
        /* No image in Eversports for that class: fall back to our photo of the
           studio it runs in, so picture and studio never disagree. */
        var src = hit.image || STUDIO_IMG[hit.studio];
        if (img && src) { img.src = src; img.removeAttribute('srcset'); img.alt = 'Studio ' + STUDIO[hit.studio]; }
      });

      Array.prototype.forEach.call(ats, function (el) {
        var hit = upcoming(items, { count: 1, studio: el.getAttribute('data-jym-next-at') })[0];
        if (hit) el.textContent = 'Nächste Klasse: ' + dayWord(hit.start, true) + ' ' + timeFmt.format(hit.start) + ', ' + hit.name;
      });

      Array.prototype.forEach.call(docks, function (dock) {
        var first = upcoming(items, { count: 1 })[0];
        if (!first) { dock.hidden = true; return; }
        var now = dock.querySelector('[data-jym-dock-now]');
        if (now) now.textContent = dayWord(first.start) + ' ' + timeFmt.format(first.start) + ' · ' + first.name + ' · ' + STUDIO[first.studio];
        var book = dock.querySelector('[data-jym-dock-book]');
        if (book) { book.href = first.url; book.target = '_blank'; book.rel = 'noopener'; }
      });
    }).catch(function () {
      Array.prototype.forEach.call(lists, function (list) { list.innerHTML = FALLBACK; });
      Array.prototype.forEach.call(docks, function (dock) {
        var now = dock.querySelector('[data-jym-dock-now]');
        if (now) now.textContent = 'Klassen in Lehel und Glockenbach';
      });
    });
  }

  /* ---------------------------------------------------------------- dock */

  function initDocks() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-jym-dock]'), function (dock) {
      var toggle = dock.querySelector('[data-jym-dock-toggle]');
      if (!toggle) return;
      function set(open) {
        dock.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      toggle.addEventListener('click', function () { set(!dock.classList.contains('is-open')); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
      document.addEventListener('click', function (e) { if (!dock.contains(e.target)) set(false); });
    });
  }

  /* ------------------------------------------------------------ aperture */

  function initAperture() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-jym-aperture]'), function (sec) {
      var host = sec.closest('[data-jym-cover]');
      function apply(p) {
        sec.style.setProperty('--p', p.toFixed(4));
        sec.classList.toggle('is-open', p > 0.85);
        if (host) host.classList.toggle('is-live', p > 0.8);
      }
      if (reduceMotion) { sec.classList.add('is-static'); apply(1); return; }
      var ticking = false;
      function update() {
        ticking = false;
        var run = sec.offsetHeight - window.innerHeight;
        if (run <= 0) { apply(1); return; }
        apply(Math.min(1, Math.max(0, -sec.getBoundingClientRect().top / (run * 0.8))));
      }
      window.addEventListener('scroll', function () {
        if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
      }, { passive: true });
      window.addEventListener('resize', update);
      update();
    });
  }

  /* ---------------------------------------------------------------- deck */

  function initDecks() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-jym-deck]'), function (root) {
      var cards = Array.prototype.slice.call(root.querySelectorAll('[data-jym-card]'));
      var count = root.querySelector('[data-jym-deck-count]');
      var i = 0;
      var timer = null;
      if (!cards.length) return;
      function lay() {
        cards.forEach(function (el, k) {
          var d = (k - i + cards.length) % cards.length;
          el.style.zIndex = String(cards.length - d);
          el.setAttribute('aria-hidden', d === 0 ? 'false' : 'true');
          el.inert = d !== 0;
          el.style.opacity = d > 2 ? '0' : '1';
          el.style.transform = d === 0 ? 'none' : 'translateY(' + (-d * 1.1) + 'rem) scale(' + (1 - d * 0.05) + ')';
          el.style.filter = d === 0 ? 'none' : 'brightness(' + (1 - d * 0.12) + ')';
        });
        if (count) count.textContent = (i + 1) + ' / ' + cards.length;
      }
      function step(n) { i = (i + n + cards.length) % cards.length; lay(); }
      function restart() {
        if (reduceMotion) return;
        window.clearInterval(timer);
        timer = window.setInterval(function () { step(1); }, 5000);
      }
      var next = root.querySelector('[data-jym-deck-next]');
      var prev = root.querySelector('[data-jym-deck-prev]');
      if (next) next.addEventListener('click', function () { step(1); restart(); });
      if (prev) prev.addEventListener('click', function () { step(-1); restart(); });
      root.addEventListener('mouseenter', function () { window.clearInterval(timer); });
      root.addEventListener('mouseleave', restart);
      root.addEventListener('focusin', function () { window.clearInterval(timer); });
      root.classList.add('is-ready');
      lay();
      restart();
    });
  }

  /* ------------------------------------------------------------- planner */

  /* "Level II-III" -> [2, 3]; "All Level" / no level -> [1, 2, 3]. */
  function levels(text) {
    if (!text || /all/i.test(text)) return [1, 2, 3];
    var found = (text.match(/\b(III|II|I)\b/g) || []).map(function (r) { return r.length; });
    if (!found.length) return [1, 2, 3];
    var lo = Math.min.apply(null, found);
    var hi = Math.max.apply(null, found);
    var out = [];
    for (var i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  /* Calendar arithmetic on Berlin dates, done on UTC noon to dodge DST. */
  function ymdAdd(day, n) {
    var d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function mondayOf(day) {
    var dow = DOW[dowFmt.format(new Date(day + 'T12:00:00Z'))];
    return ymdAdd(day, -((dow + 6) % 7));
  }
  var MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

  /* Every colour the widget paints (activity cards, the selected day, buttons)
     comes from inline style attributes, so attribute selectors reach them all. */
  var WIDGET_SKIN = [
    ':host, *, *::before, *::after { font-family: "Montserrat", Helvetica, Arial, sans-serif !important; }',
    '* { --btn-bg-primary: #e68600 !important; --btn-text-primary: #191a1c !important; }',
    '[style*="background-color"] { background-color: #fbf8f3 !important; color: #191a1c !important;',
    '  border-left: 3px solid #e68600 !important; border-radius: 0.5rem !important; box-shadow: none !important; }',
    '[style*="background-color"] svg { fill: currentColor !important; }',
    'button[style*="background-color"], [aria-selected="true"][style*="background-color"] { background-color: #e68600 !important;',
    '  color: #191a1c !important; border-left-width: 0 !important; border-radius: 100vw !important; }',
    '.rounded-lg { border-radius: 0.5rem !important; }',
    'button { border-radius: 100vw !important; }'
  ].join('\n');

  /* The official widget, loaded only when our feed fails, then skinned: its
     shadow root is open, so a stylesheet can be dropped in once it renders. */
  function loadWidget(box) {
    box.hidden = false;
    box.innerHTML = '<div data-eversports-widget-id="' + WIDGET + '"></div>';
    var s = document.createElement('script');
    s.type = 'module';
    s.src = 'https://widget-static.eversports.io/loader.js';
    document.body.appendChild(s);
    var tries = 0;
    var timer = window.setInterval(function () {
      var host = Array.prototype.filter.call(box.querySelectorAll('*'), function (e) { return e.shadowRoot; })[0];
      if (host || ++tries > 60) window.clearInterval(timer);
      if (host && !host.shadowRoot.querySelector('style[data-jym-skin]')) {
        var st = document.createElement('style');
        st.setAttribute('data-jym-skin', '');
        st.textContent = WIDGET_SKIN;
        host.shadowRoot.appendChild(st);
      }
    }, 250);
  }

  function initPlanner() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-jym-planner]'), function (board) {
      var list = board.querySelector('[data-jym-plan-list]');
      var daysEl = board.querySelector('[data-jym-plan-days]');
      var weekEl = board.querySelector('[data-jym-plan-week]');
      var prev = board.querySelector('[data-jym-plan-prev]');
      var next = board.querySelector('[data-jym-plan-next]');
      var fallback = board.parentNode.querySelector('[data-jym-plan-fallback]');
      var today = ymd(new Date());
      var state = { week: 0, day: today, studio: 'all', level: 'all', items: [], showPast: false, teacher: '', teacherLabel: '', agenda: null, agendaAll: false };
      var MAX_WEEKS = 3;

      /* Teacher filter: "?teacher=Katja%20Schwarz" (the "Zum Kursplan" buttons on
         the team cards link here that way). Matched against the Eversports teacher
         name, ignoring case and apostrophes ("Jessina O'Connell" is entered both
         with and without one). Shared classes ("Andrea & Eleonora",
         "Petros & Friends") count for each first name in them. */
      function norm(s) {
        return String(s || '').toLowerCase().replace(/['’`´]/g, '').replace(/\s+/g, ' ').trim();
      }
      function teaches(x) {
        if (!state.teacher) return true;
        var t = norm(x.teacher);
        if (t === state.teacher) return true;
        return t.indexOf('&') !== -1 && t.split(/\s*&\s*/).indexOf(state.teacher.split(' ')[0]) !== -1;
      }

      function weekDays() {
        var mon = ymdAdd(mondayOf(today), state.week * 7);
        var out = [];
        for (var i = 0; i < 7; i++) out.push(ymdAdd(mon, i));
        return out;
      }

      function visible(day) {
        return state.items.filter(function (x) {
          return ymd(x.start) === day &&
            (state.studio === 'all' || x.studio === state.studio) &&
            (state.level === 'all' || levels(x.level).indexOf(+state.level) !== -1) &&
            teaches(x);
        });
      }

      /* A teacher filter swaps the week view for a list: all of that teacher's
         classes in the next four weeks, grouped by date. Studio and level still
         apply. The day tabs and week arrows hide while it is on. */
      var navEl = board.querySelector('.plan_nav');
      /* display, not [hidden]: the planner CSS sets display on both, which beats the attribute */
      function setAgenda(on) {
        daysEl.style.display = on ? 'none' : '';
        if (navEl) navEl.style.display = on ? 'none' : '';
      }
      var AGENDA_FIRST = 8;
      function renderAgenda() {
        setAgenda(true);
        if (!state.agenda) { list.innerHTML = skeleton(5).replace(/jym_row_item/g, 'plan_row'); return; }
        var now = Date.now();
        var rows = state.agenda.filter(function (x) {
          return x.end.getTime() > now &&
            (state.studio === 'all' || x.studio === state.studio) &&
            (state.level === 'all' || levels(x.level).indexOf(+state.level) !== -1) &&
            teaches(x);
        });
        weekEl.textContent = 'Nächste 4 Wochen · ' + rows.length + (rows.length === 1 ? ' Klasse' : ' Klassen');
        if (!rows.length) {
          list.innerHTML = '<li class="plan_empty">' + esc(state.teacherLabel) +
            ' hat in den nächsten 4 Wochen in dieser Auswahl keine Klasse. Probier ein anderes Studio oder Level.</li>';
          return;
        }
        var total = rows.length;
        if (!state.agendaAll && total > AGENDA_FIRST) rows = rows.slice(0, AGENDA_FIRST);
        var html = '';
        var lastDay = '';
        rows.forEach(function (x) {
          var d = ymd(x.start);
          if (d !== lastDay) {
            var dt = new Date(d + 'T12:00:00Z');
            var off = dayOffset(x.start);
            html += '<li class="plan_date">' + (off === 0 ? 'Heute · ' : off === 1 ? 'Morgen · ' : '') +
              DAYS[DOW[dowFmt.format(dt)]] + ', ' + dt.getUTCDate() + '. ' + MONTHS[dt.getUTCMonth()] + '</li>';
            lastDay = d;
          }
          html += row(x);
        });
        if (rows.length < total) {
          html += '<li class="plan_more"><button type="button" class="plan_more_button" data-jym-plan-all>Alle ' +
            total + ' Klassen anzeigen</button></li>';
        }
        list.innerHTML = html;
      }

      function renderDays() {
        if (state.teacher) { renderAgenda(); return; }
        setAgenda(false);
        var days = weekDays();
        daysEl.innerHTML = days.map(function (d) {
          var dt = new Date(d + 'T12:00:00Z');
          var n = visible(d).length;
          var past = d < today;
          return '<button type="button" role="tab" class="plan_day' + (d === state.day ? ' is-active' : '') +
            (d === today ? ' is-today' : '') + (past ? ' is-past' : '') +
            '" aria-selected="' + (d === state.day) + '" data-day="' + d + '"' + (past ? ' disabled' : '') + '>' +
            '<span class="plan_day_name">' + SHORT[DOW[dowFmt.format(dt)]] + '</span>' +
            '<span class="plan_day_num">' + (+d.slice(8)) + '</span>' +
            '<span class="plan_day_count">' + (past ? '' : n + (n === 1 ? ' Klasse' : ' Klassen')) + '</span></button>';
        }).join('');
        var a = new Date(days[0] + 'T12:00:00Z');
        var z = new Date(days[6] + 'T12:00:00Z');
        weekEl.textContent = (state.week === 0 ? 'Diese Woche · ' : '') + a.getUTCDate() + '.' +
          (a.getUTCMonth() === z.getUTCMonth() ? '' : ' ' + MONTHS[a.getUTCMonth()]) + '–' + z.getUTCDate() + '. ' + MONTHS[z.getUTCMonth()];
        prev.disabled = state.week === 0;
        next.disabled = state.week >= MAX_WEEKS;
      }

      function row(x) {
        var past = x.end.getTime() < Date.now();
        var meta = [x.level, x.online ? 'Online' : STUDIO[x.studio], x.teacher].filter(Boolean).join(' · ');
        var spots = !past && x.free !== null && x.free <= 8
          ? '<span class="plan_row_spots">' + (x.free === 0 ? 'Ausgebucht' : 'Noch ' + x.free + ' Plätze') + '</span>' : '';
        return '<li class="plan_row' + (past ? ' is-past' : '') + '">' +
          '<span class="plan_row_time">' + timeFmt.format(x.start) + '<span class="plan_row_end">' + timeFmt.format(x.end) + '</span></span>' +
          '<span class="plan_row_main"><span class="plan_row_name">' + esc(x.name) + '</span>' +
          '<span class="plan_row_meta">' + esc(meta) + spots + '</span></span>' +
          (past ? '<span class="plan_row_state">Vorbei</span>'
                : '<a class="plan_row_book" href="' + esc(x.url) + '" target="_blank" rel="noopener" aria-label="' +
                  esc(x.name + ' um ' + timeFmt.format(x.start) + ' buchen') + '">Buchen</a>') +
          '</li>';
      }

      /* Finished classes fold away behind a button, so the list opens on what
         can still be booked. */
      function renderList() {
        if (state.teacher) return;               // the agenda renders itself
        var rows = visible(state.day);
        var now = Date.now();
        var done = rows.filter(function (x) { return x.end.getTime() < now; });
        var open = rows.filter(function (x) { return x.end.getTime() >= now; });
        if (!rows.length) {
          list.innerHTML = state.teacher
            ? '<li class="plan_empty">An diesem Tag unterrichtet ' + esc(state.teacherLabel) + ' in dieser Auswahl keine Klasse. Probier einen anderen Tag oder eine andere Woche.</li>'
            : '<li class="plan_empty">An diesem Tag gibt es in dieser Auswahl keine Klasse. Probier ein anderes Studio, Level oder einen anderen Tag.</li>';
          return;
        }
        var html = (state.showPast ? rows : open).map(row).join('');
        if (!open.length && !state.showPast) html = '<li class="plan_empty">Heute gibt es in dieser Auswahl keine weiteren Klassen.</li>';
        if (done.length && !state.showPast) {
          html += '<li class="plan_more"><button type="button" class="plan_more_button" data-jym-plan-past>' +
            done.length + (done.length === 1 ? ' frühere Klasse' : ' frühere Klassen') + ' heute anzeigen</button></li>';
        }
        list.innerHTML = html;
      }

      function load() {
        if (state.teacher) {
          renderAgenda();
          return loadRoster(true).then(function (items) {
            state.agenda = items;
            renderAgenda();
          });
        }
        var days = weekDays();
        list.innerHTML = skeleton(5).replace(/jym_row_item/g, 'plan_row');
        var start = new Date(days[0] + 'T00:00:00Z');
        start.setUTCDate(start.getUTCDate() - 1);
        var end = new Date(days[6] + 'T23:59:59Z');
        end.setUTCDate(end.getUTCDate() + 1);
        return fetchRange(start, end, 'week-' + days[0]).then(function (items) {
          state.items = items;
          if (state.week === 0 && state.day === today) {
            var left = visible(today).filter(function (x) { return x.end.getTime() > Date.now(); });
            if (!left.length && days.indexOf(ymdAdd(today, 1)) !== -1) state.day = ymdAdd(today, 1);
          }
          renderDays();
          renderList();
        });
      }

      function fail() {
        board.hidden = true;
        if (fallback) loadWidget(fallback);
      }

      daysEl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-day]');
        if (!b || b.disabled) return;
        state.day = b.getAttribute('data-day');
        state.showPast = false;
        renderDays();
        renderList();
      });
      Array.prototype.forEach.call(board.querySelectorAll('[data-jym-plan-filter]'), function (group) {
        var key = group.getAttribute('data-jym-plan-filter');
        group.addEventListener('click', function (e) {
          var b = e.target.closest('[data-v]');
          if (!b) return;
          Array.prototype.forEach.call(group.querySelectorAll('[data-v]'), function (x) {
            x.classList.toggle('is-active', x === b);
            x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
          });
          state[key] = b.getAttribute('data-v');
          if (key === 'studio') syncStudioName();
          renderDays();
          renderList();
        });
      });
      function go(delta) {
        state.week = Math.max(0, Math.min(MAX_WEEKS, state.week + delta));
        state.day = state.week === 0 ? today : weekDays()[0];
        load().catch(fail);
      }
      list.addEventListener('click', function (e) {
        if (e.target.closest('[data-jym-plan-all]')) { state.agendaAll = true; renderAgenda(); return; }
        if (!e.target.closest('[data-jym-plan-past]')) return;
        state.showPast = true;
        renderList();
      });
      prev.addEventListener('click', function () { go(-1); });
      next.addEventListener('click', function () { go(1); });

      /* Name the selected studio wherever the section asks for it:
           data-jym-plan-studio-name  -> "Lehel"
           data-jym-plan-studio-sub   -> its address (hidden when there is none) */
      var STUDIO_LABEL = {
        all: ['Alle Studios', 'Lehel & Glockenbach'],
        L: ['Lehel', 'Robert-Koch-Str. 13, 80538 München'],
        G: ['Glockenbach', 'Müllerstr. 33, Rückhaus, 80469 München'],
        O: ['Online', '']
      };
      var scope = board.closest('section') || document;
      function syncStudioName() {
        var label = STUDIO_LABEL[state.studio] || STUDIO_LABEL.all;
        /* With a teacher filter the title names the teacher, the line below the studio. */
        var name = state.teacher ? state.teacherLabel : label[0];
        var sub = state.teacher ? label[0] : label[1];
        Array.prototype.forEach.call(scope.querySelectorAll('[data-jym-plan-studio-eyebrow]'), function (el) {
          el.textContent = state.teacher ? 'Klassen von' : 'Studio';
        });
        Array.prototype.forEach.call(scope.querySelectorAll('[data-jym-plan-studio-name]'), function (el) {
          el.textContent = name;
        });
        Array.prototype.forEach.call(scope.querySelectorAll('[data-jym-plan-studio-sub]'), function (el) {
          el.textContent = sub;
          el.hidden = !sub;
        });
      }

      /* Teacher picker: a "Lehrer*in" button in the filter row that opens a
         searchable list of everyone teaching in the next four weeks (read from
         the same Eversports feed, so it never needs editing). Choosing a name
         filters the planner, jumps to that teacher's next class and puts
         ?teacher= in the URL, the same link the team cards use. */
      var filters = board.querySelector('.plan_filters');
      var picker = null;

      function setUrlTeacher(name) {
        if (!window.history || !history.replaceState) return;
        var q = window.location.search.replace(/([?&])teacher=[^&#]*&?/, '$1').replace(/[?&]$/, '');
        if (name) q += (q ? '&' : '?') + 'teacher=' + encodeURIComponent(name);
        history.replaceState(null, '', window.location.pathname + q + window.location.hash);
      }

      function setTeacher(name) {
        state.teacher = norm(name);
        state.teacherLabel = name;
        state.agendaAll = false;
        state.week = 0;
        state.day = today;
        state.showPast = false;
        setUrlTeacher(name);
        syncStudioName();
        syncPicker();
        load().catch(fail);
      }

      function syncPicker() {
        if (!picker) return;
        var label = picker.querySelector('[data-jym-teacher-label]');
        var clear = picker.querySelector('[data-jym-teacher-clear]');
        var toggle = picker.querySelector('[data-jym-teacher-toggle]');
        label.textContent = state.teacher ? state.teacherLabel : 'Lehrer*in';
        toggle.classList.toggle('is-active', !!state.teacher);
        clear.hidden = !state.teacher;
      }

      /* Everyone teaching in the next four weeks, one entry per person:
         spellings differing only in apostrophes merge, shared classes
         ("Andrea & Eleonora") are counted for each of the named teachers. */
      /* One request for the next four weeks feeds both the teacher list and
         the teacher agenda. loadRoster(true) returns the classes themselves. */
      var roster = null;
      var rosterItems = null;
      function loadRoster(raw) {
        if (!rosterItems) {
          var from = new Date();
          rosterItems = fetchRange(from, new Date(+from + 28 * 86400000), 'roster-' + today);
          rosterItems.catch(function () { rosterItems = null; });
        }
        if (raw) return rosterItems;
        if (roster) return roster;
        roster = rosterItems.then(function (items) {
          var byKey = {};
          items.forEach(function (x) {
            if (!x.teacher || x.teacher.indexOf('&') !== -1) return;
            var key = norm(x.teacher);
            var t = byKey[key] || (byKey[key] = { name: x.teacher, count: 0, names: {} });
            t.count += 1;
            t.names[x.teacher] = (t.names[x.teacher] || 0) + 1;
          });
          return Object.keys(byKey).map(function (k) {
            var t = byKey[k];
            /* most used spelling wins ("Jessina O'Connell" over "Jessina OConnell") */
            t.name = Object.keys(t.names).sort(function (a, b) { return t.names[b] - t.names[a]; })[0];
            return t;
          }).sort(function (a, b) { return a.name.localeCompare(b.name, 'de'); });
        });
        roster.catch(function () { roster = null; });
        return roster;
      }

      function buildPicker() {
        if (!filters) return;
        picker = document.createElement('div');
        picker.className = 'jym_seg plan_teacher';
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-label', 'Lehrer*in');
        picker.innerHTML =
          '<button type="button" class="jym_seg_button plan_teacher_toggle" data-jym-teacher-toggle aria-haspopup="listbox" aria-expanded="false">' +
            '<span data-jym-teacher-label>Lehrer*in</span><span class="plan_teacher_caret" aria-hidden="true">▾</span></button>' +
          '<button type="button" class="jym_seg_button plan_teacher_clear" data-jym-teacher-clear aria-label="Lehrer*in-Filter entfernen" hidden>×</button>' +
          '<div class="plan_teacher_panel" data-jym-teacher-panel hidden>' +
            '<input type="search" class="plan_teacher_search" data-jym-teacher-search placeholder="Name suchen" aria-label="Lehrer*in suchen" autocomplete="off">' +
            '<ul class="plan_teacher_list" role="listbox" aria-label="Lehrer*innen" data-jym-teacher-list><li class="plan_teacher_empty">Lädt …</li></ul>' +
          '</div>';
        filters.insertBefore(picker, filters.firstChild);

        var toggle = picker.querySelector('[data-jym-teacher-toggle]');
        var clear = picker.querySelector('[data-jym-teacher-clear]');
        var panel = picker.querySelector('[data-jym-teacher-panel]');
        var search = picker.querySelector('[data-jym-teacher-search]');
        var listEl = picker.querySelector('[data-jym-teacher-list]');
        var all = [];

        function renderOptions() {
          var q = norm(search.value);
          var hits = all.filter(function (t) { return !q || norm(t.name).indexOf(q) !== -1; });
          var html = q ? '' : '<li><button type="button" class="plan_teacher_option" role="option" data-teacher="">Alle Lehrer*innen</button></li>';
          html += hits.map(function (t) {
            return '<li><button type="button" class="plan_teacher_option' + (norm(t.name) === state.teacher ? ' is-active' : '') +
              '" role="option" data-teacher="' + esc(t.name) + '">' + esc(t.name) +
              '<span class="plan_teacher_count">' + t.count + (t.count === 1 ? ' Klasse' : ' Klassen') + '</span></button></li>';
          }).join('');
          listEl.innerHTML = html || '<li class="plan_teacher_empty">Keine Lehrer*in gefunden.</li>';
        }

        function open() {
          panel.hidden = false;
          toggle.setAttribute('aria-expanded', 'true');
          search.value = '';
          search.focus();
          loadRoster().then(function (r) { all = r; renderOptions(); })
            .catch(function () { listEl.innerHTML = '<li class="plan_teacher_empty">Liste gerade nicht verfügbar.</li>'; });
        }
        function close() {
          panel.hidden = true;
          toggle.setAttribute('aria-expanded', 'false');
        }

        toggle.addEventListener('click', function () { if (panel.hidden) open(); else close(); });
        clear.addEventListener('click', function () { setTeacher(''); });
        search.addEventListener('input', renderOptions);
        listEl.addEventListener('click', function (e) {
          var b = e.target.closest('[data-teacher]');
          if (!b) return;
          close();
          setTeacher(b.getAttribute('data-teacher'));
        });
        /* Enter picks the first match; arrows move through the list; Esc closes. */
        picker.addEventListener('keydown', function (e) {
          var opts = Array.prototype.slice.call(listEl.querySelectorAll('[data-teacher]'));
          var i = opts.indexOf(document.activeElement);
          if (e.key === 'Escape') { close(); toggle.focus(); }
          else if (e.key === 'Enter' && document.activeElement === search && opts.length) {
            e.preventDefault(); opts[0].click();
          } else if (e.key === 'ArrowDown' && opts.length) {
            e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)].focus();
          } else if (e.key === 'ArrowUp' && opts.length) {
            e.preventDefault(); if (i <= 0) search.focus(); else opts[i - 1].focus();
          }
        });
        document.addEventListener('click', function (e) { if (!picker.contains(e.target)) close(); });
      }

      buildPicker();

      /* Teacher from the URL (team cards link here with ?teacher=). */
      var wantedTeacher = (/[?&]teacher=([^&#]+)/.exec(window.location.search) || [])[1];
      if (wantedTeacher) {
        var teacherName = decodeURIComponent(wantedTeacher.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
        if (teacherName) {
          state.teacher = norm(teacherName);
          state.teacherLabel = teacherName;
        }
      }
      syncPicker();

      /* Starting studio: "?studio=lehel|glockenbach|online" in the URL (the
         studio pages link here that way), else the tab marked active in the
         markup. Only a studio this board has a tab for is accepted. */
      var studioGroup = board.querySelector('[data-jym-plan-filter="studio"]');
      if (studioGroup) {
        var wanted = (/[?&]studio=([^&#]+)/.exec(window.location.search) || [])[1];
        var code = { lehel: 'L', glockenbach: 'G', online: 'O', l: 'L', g: 'G', o: 'O' }[(wanted || '').toLowerCase()];
        var pick = (code && studioGroup.querySelector('[data-v="' + code + '"]')) ||
          studioGroup.querySelector('[data-v].is-active');
        if (pick) {
          Array.prototype.forEach.call(studioGroup.querySelectorAll('[data-v]'), function (x) {
            x.classList.toggle('is-active', x === pick);
            x.setAttribute('aria-pressed', x === pick ? 'true' : 'false');
          });
          state.studio = pick.getAttribute('data-v');
        }
      }
      syncStudioName();

      renderDays();
      load().catch(fail);
    });
  }

  function init() {
    initLists();
    initDocks();
    initAperture();
    initDecks();
    initPlanner();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
