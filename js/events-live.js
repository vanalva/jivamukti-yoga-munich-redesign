/* ==========================================================================
   events-live.js — upcoming events from Eversports, live

   Fills the event lists in two places from the same data:
     - the events hero (events.html, three "doors")
     - the "Events" modal opened from the navbar on every page

   Source: the studio's public Eversports widget feed, the same endpoint and
   widget js/heroes.js reads for classes. No key, no server. What the studio
   publishes in Eversports shows up here on its own.

   Hooks (all optional, markup works without this script):
     data-jym-events-list="sessions|workshops|training"
         <ul> whose rows are replaced by live ones. Rows marked
         data-jym-keep stay (appended after the live rows). When the feed
         fails or has nothing for a group, the static rows are left as is.
     data-jym-link-class="events_card_link"
         on a list: class for its row links (default "door_link"); the note
         span gets the same class + "_note".
     data-jym-events-image="sessions|workshops|training"
         <img> that cross-fades, in random order, through the photos of that
         group's upcoming events. Its own src (the curated photo) shows first
         and stays in the rotation; it is also the fallback.
     data-jym-photos-only
         on such an <img>: skip flyers (the studio's Canva/Instagram exports,
         PNGs named "kopie-von-…ig-post…"). For images that carry text on top.
     data-jym-base="../"
         on an ancestor: path from the page to src/pages, so links work from
         nested pages (team/, event/, legal/). Defaults to "".

   Lists outside the modal load at once; the modal's load 2 s after page load
   (or on first hover/open, whichever comes first).
   ========================================================================== */
(function () {
  var ENDPOINT = 'https://graphql-widget-master.production.eversports.cloud/api/graphql';
  var WIDGET = '747b62f2-a622-479c-8f7f-8570df044af6';
  var CACHE_KEY = 'jym-events-v2';
  var CACHE_MS = 10 * 60 * 1000;
  var TZ = 'Europe/Berlin';
  var WINDOWS = 3;            // 3 x 30 days ahead; the API caps a request at 500 rows
  var SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /* Workshops come without a booking URL in the feed (Eversports books them
     through its separate workshop flow), so they link to our own event page. */
  var WORKSHOP_PAGES = [
    [/breathwork/i, 'event/breathwork-reihe-2026.html'],
    [/foundations\s+harmonium/i, 'event/foundations-harmonium-workshop.html'],
    [/advanced\s+harmonium/i, 'event/advanced-harmonium-kurs.html']
  ];

  var QUERY = 'query JymEvents($widgetId: ID!, $timeRange: TimeRangeInput, $first: Int) {' +
    ' widget(id: $widgetId) { ... on WidgetActivitySchedule {' +
    ' activities(activityGroupPublicationStates: [ACTIVE, VIEW_ONLY], timeRange: $timeRange, first: $first, isArchived: false) {' +
    ' nodes { start isCancelled detailsPageURL activityGroup { name category { name } venue { name }' +
    ' imagesV2(first: 1) { nodes { url(size: MEDIUM) } } } } } } } }';

  var ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var dmFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  var dowFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });

  function ymd(d) { return ymdFmt.format(d); }
  function dm(d) { return dmFmt.format(d); }                       // "17.10." (de-DE adds the dot)
  function dayShort(d) { return SHORT[DOW[dowFmt.format(d)]]; }   // "Sa"

  /* ------------------------------------------------------------------ data */

  function kindOf(category) {
    var c = (category || '').toLowerCase();
    if (c === 'sessions') return 'sessions';
    if (c === 'workshop') return 'workshops';
    if (c.indexOf('ausbildung') !== -1) return 'training';
    return null;    // classes, online, meditation, kirtan: not events here
  }

  function studioOf(venue) {
    return /lehel/i.test(venue) ? 'Lehel' : /glockenbach/i.test(venue) ? 'Glockenbach' : '';
  }

  /* "Saturday Sessions: Yin XL // Level I - III (+5€ …)" -> "Yin XL" */
  function cleanName(raw, kind) {
    var s = (raw || '').replace(/\s*\(.*?\)\s*/g, ' ');
    s = s.split(/\s+\/{1,2}\s+/)[0];
    if (kind === 'sessions') s = s.replace(/^(saturday|sunday)\s+sessions:\s*/i, '').replace(/^special:\s*/i, '');
    s = s.replace(/\s+mit\s+.*$/i, '');                           // "… mit Felicia Walker": teacher is on the event page
    if (kind === 'workshops') s = s.replace(/^(.*?\bworkshop)\b.*$/i, '$1');   // drop the subtitle after "Workshop"
    s = s.replace(/\s+/g, ' ').trim();
    /* SHOUTED words as entered in Eversports -> Title case */
    return s.replace(/\b([A-ZÄÖÜ]{3,})\b/g, function (w) { return w.charAt(0) + w.slice(1).toLowerCase(); });
  }

  function request(start, end) {
    var body = JSON.stringify({
      operationName: 'JymEvents',
      query: QUERY,
      variables: { widgetId: WIDGET, first: 500, timeRange: { start: start.toISOString(), end: end.toISOString() } }
    });
    function once() {
      return fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (json) { return json.data.widget.activities.nodes; });
    }
    /* One retry: the endpoint sometimes answers a burst without CORS headers. */
    return once().catch(function () {
      return new Promise(function (ok) { window.setTimeout(ok, 1500); }).then(once);
    });
  }

  var feed = null;
  function load() {
    if (feed) return feed;
    try {
      var c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (c && Date.now() - c.t < CACHE_MS) {
        feed = Promise.resolve(c.items.map(function (x) { x.start = new Date(x.start); return x; }));
        return feed;
      }
    } catch (e) { /* storage blocked: fetch instead */ }

    /* One window after another: the endpoint rejects bursts of parallel requests. */
    var now = new Date();
    var parts = [];
    var chain = Promise.resolve();
    for (var i = 0; i < WINDOWS; i++) {
      (function (i) {
        chain = chain.then(function () {
          return request(new Date(+now + i * 30 * 86400000), new Date(+now + (i + 1) * 30 * 86400000))
            .then(function (nodes) { parts.push(nodes); });
        });
      })(i);
    }
    feed = chain.then(function () {
      var items = [];
      parts.forEach(function (nodes) {
        nodes.forEach(function (n) {
          if (n.isCancelled || !n.activityGroup) return;
          var kind = kindOf(n.activityGroup.category && n.activityGroup.category.name);
          if (!kind) return;
          items.push({
            kind: kind,
            start: new Date(n.start),
            name: cleanName(n.activityGroup.name, kind),
            studio: studioOf(n.activityGroup.venue && n.activityGroup.venue.name),
            url: n.detailsPageURL || '',
            /* the image the studio set for this event in Eversports (often its flyer) */
            image: n.activityGroup.imagesV2 && n.activityGroup.imagesV2.nodes[0] ? n.activityGroup.imagesV2.nodes[0].url : ''
          });
        });
      });
      items.sort(function (a, b) { return a.start - b.start; });
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), items: items })); } catch (e) { /* ignore */ }
      return items;
    });
    feed.catch(function () { feed = null; });
    return feed;
  }

  /* Rows per group: [{ label, note, href }] */
  function rowsFor(kind, items, base) {
    var now = Date.now();
    var mine = items.filter(function (x) { return x.kind === kind; });

    if (kind === 'sessions') {
      return mine.filter(function (x) { return x.start.getTime() > now; }).slice(0, 3).map(function (x) {
        return {
          label: x.name,
          note: dayShort(x.start) + ' ' + dm(x.start) + (x.studio ? ' · ' + x.studio : ''),
          href: x.url || base + 'events.html#events-list'
        };
      });
    }

    if (kind === 'workshops') {
      /* The same workshop can be listed twice (once per booking flow): one row
         per day and first word, preferring the entry that carries a URL. */
      var seen = {};
      var out = [];
      mine.forEach(function (x) {
        if (x.start.getTime() <= now) return;
        var key = ymd(x.start) + '|' + x.name.split(' ')[0].toLowerCase();
        if (seen[key]) { if (!seen[key].url && x.url) seen[key].url = x.url; return; }
        seen[key] = x;
        out.push(x);
      });
      return out.slice(0, 3).map(function (x) {
        var page = '';
        WORKSHOP_PAGES.forEach(function (m) { if (!page && m[0].test(x.name)) page = base + m[1]; });
        return { label: x.name, note: dm(x.start), href: page || x.url || base + 'events.html#events-list' };
      });
    }

    if (kind === 'training') {
      /* A training is many dated sessions: show it once, first–last day. */
      var byName = {};
      var order = [];
      mine.forEach(function (x) {
        var g = byName[x.name];
        if (!g) { g = byName[x.name] = { name: x.name, first: x.start, last: x.start }; order.push(g); }
        if (x.start < g.first) g.first = x.start;
        if (x.start > g.last) g.last = x.start;
      });
      return order.filter(function (g) { return g.last.getTime() > now; }).slice(0, 2).map(function (g) {
        return {
          label: g.name,
          note: ymd(g.first) === ymd(g.last) ? dm(g.first) : dm(g.first) + '–' + dm(g.last),
          href: base + '75hr-training.html'
        };
      });
    }
    return [];
  }

  /* ------------------------------------------------------------- render */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function rowHTML(r, cls) {
    var ext = /^https?:/i.test(r.href) ? ' target="_blank" rel="noopener"' : '';
    return '<li><a href="' + esc(r.href) + '"' + ext + ' class="' + cls + '">' + esc(r.label) +
      ' <span class="' + cls + '_note">' + esc(r.note) + '</span></a></li>';
  }

  function fill(list, items) {
    var holder = list.closest('[data-jym-base]');
    var base = holder ? holder.getAttribute('data-jym-base') : '';
    var rows = rowsFor(list.getAttribute('data-jym-events-list'), items, base);
    if (!rows.length) return;    // nothing upcoming: keep the static rows
    var keep = Array.prototype.slice.call(list.querySelectorAll('[data-jym-keep]'));
    var cls = list.getAttribute('data-jym-link-class') || 'door_link';
    list.innerHTML = rows.map(function (r) { return rowHTML(r, cls); }).join('');
    keep.forEach(function (li) { list.appendChild(li); });
    list.setAttribute('data-jym-live', '');
  }

  /* ------------------------------------------------------ rotating images */

  var ROTATE_MS = 5000;
  var FADE_MS = 1200;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var rotators = 0;
  /* Flyers have their own headline and copy baked in; under a text overlay
     they turn into noise. They are Canva/Instagram exports: PNG, "ig-post". */
  var FLYER = /\.png(?:$|\?)|ig-post|kopie-von/i;

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* Photos of the group's upcoming events, one per distinct image, shuffled.
     The image already in the markup (the curated photo) stays in the pool. */
  function poolFor(img, items) {
    var kind = img.getAttribute('data-jym-events-image');
    var now = Date.now();
    var photosOnly = img.hasAttribute('data-jym-photos-only');
    var seen = {};
    var pool = [];
    items.forEach(function (x) {
      if (x.kind !== kind || !x.image || seen[x.image]) return;
      if (photosOnly && FLYER.test(x.image)) return;
      if (kind !== 'training' && x.start.getTime() <= now) return;
      seen[x.image] = true;
      pool.push(x.image);
    });
    return shuffle(pool);
  }

  /* Cross-fade through the pool. A second layer (same classes + is-next) sits on
     top of the original <img>; each step loads the next photo into whichever of
     the two is hidden, then fades the top layer in or out to reveal it. */
  function rotate(base, items) {
    var events = poolFor(base, items);
    if (!events.length) return;
    base.setAttribute('data-jym-live', '');
    var curated = base.getAttribute('src');

    if (reduceMotion) {                       // no animation: one random photo, stays put
      var pick = events[0];
      base.onerror = function () { base.onerror = null; base.src = curated; };
      base.src = pick;
      return;
    }

    var pool = events.concat([curated]);       // curated photo shows first, then cycles
    var top = base.cloneNode(false);
    top.removeAttribute('data-jym-events-image');
    top.removeAttribute('data-jym-live');
    top.removeAttribute('data-jym-photos-only');
    top.removeAttribute('src');
    top.alt = '';
    top.setAttribute('aria-hidden', 'true');
    top.classList.add('is-next');
    base.parentNode.insertBefore(top, base.nextSibling);

    var i = 0;
    var topShown = false;
    var busy = false;
    var visible = true;

    function step() {
      if (busy || !visible || document.hidden) return;
      var url = pool[i++ % pool.length];
      var target = topShown ? base : top;      // load into the hidden one
      if (target.getAttribute('src') === url) return;
      busy = true;
      var probe = new Image();
      probe.onload = function () {
        target.src = url;
        var swap = function () {
          topShown = !topShown;
          top.classList.toggle('is-in', topShown);
          window.setTimeout(function () { busy = false; }, FADE_MS);
        };
        if (target.decode) target.decode().then(swap, swap); else swap();
      };
      probe.onerror = function () { busy = false; };   // skip a broken image
      probe.src = url;
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }).observe(base.parentNode);
    }

    /* Stagger the cards so they do not all change at once. */
    var offset = (rotators++ % 3) * Math.round(ROTATE_MS / 3);
    window.setTimeout(function () {
      step();
      window.setInterval(step, ROTATE_MS);
    }, ROTATE_MS / 2 + offset);
  }

  function render(lists, imgs) {
    if (!lists.length && !imgs.length) return;
    load().then(function (items) {
      lists.forEach(function (list) { fill(list, items); });
      imgs.forEach(function (img) { rotate(img, items); });
    }).catch(function () { /* feed down: the static rows and images stay */ });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('gutscheinModal');
    function pick(sel, wantModal) {
      return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function (el) {
        return !!(modal && modal.contains(el)) === wantModal;
      });
    }
    var LIST = '[data-jym-events-list]';
    var IMG = 'img[data-jym-events-image]';

    render(pick(LIST, false), pick(IMG, false));

    var modalLists = pick(LIST, true);
    var modalImgs = pick(IMG, true);
    if (modalLists.length || modalImgs.length) {
      var done = false;
      var open = function () { if (!done) { done = true; render(modalLists, modalImgs); } };
      Array.prototype.forEach.call(document.querySelectorAll('a[href="#gutschein"]'), function (a) {
        a.addEventListener('click', open);
        a.addEventListener('pointerenter', open);   // warm up on hover, so it is filled on open
      });
      /* The feed can take a few seconds: start quietly once the page is idle, so
         the modal is usually live before anyone opens it. Cached per session. */
      window.addEventListener('load', function () { window.setTimeout(open, 2000); });
    }
  });
})();
