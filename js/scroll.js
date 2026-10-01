/* ==========================================================================
   Jivamukti Yoga München — scroll choreography (wave 3, S1)
   --------------------------------------------------------------------------
   Loaded with `defer` after GSAP 3.12 + ScrollTrigger (+ Lenis) from jsDelivr.
   Pairs with src/css/_staging-scroll.css.

   Ownership split with wave 2: motion.js owns reveal state (data-reveal /
   is-inview, opacity + clip on the element itself). This file owns scroll
   position — sticky columns, rails, the pinned tab narrative, parallax on the
   INNER <img> of a wrapper, reading progress and Lenis.

   Everything degrades to the wave-2 page: without this script, without GSAP,
   or with prefers-reduced-motion, html.has-scroll is never set and the CSS
   patterns that depend on it never fire.

   Attribute API
     data-scroll="sticky"   [data-scroll-fit]        CSS only, >= 992px
     data-scroll="rail"                              CSS + drag/keys, <= 767px
     data-scroll="parallax" [data-scroll-amount]     >= 992px, pointer: fine
     data-scroll="progress"                          all widths
   ========================================================================== */

(function () {
  'use strict';

  var root = document.documentElement;
  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  if (!('IntersectionObserver' in window) || !window.gsap || !window.ScrollTrigger) {
    return;
  }

  var gsap = window.gsap;
  var ScrollTrigger = window.ScrollTrigger;
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.config({ ignoreMobileResize: true });

  var PARALLAX_DEFAULT = 0.12;
  var PIN_SEGMENT = 0.8;          // viewport heights of scroll per tab segment
  var lenisInstance = null;

  if (!(reduceQuery && reduceQuery.matches)) {
    root.classList.add('has-scroll');
  }
  try {
    if (window.CSS && CSS.supports && CSS.supports('animation-timeline: scroll()')) {
      root.classList.add('has-scroll-timeline');
    }
  } catch (err) {
    /* CSS.supports with a descriptor is fine everywhere that has it */
  }

  /* ----------------------------------------------------------------------
     helpers
     ---------------------------------------------------------------------- */

  function each(list, fn) {
    Array.prototype.forEach.call(list, fn);
  }

  var refreshTimer = null;
  function refreshSoon(delay) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(function () {
      ScrollTrigger.refresh();
    }, delay || 120);
  }

  /* ----------------------------------------------------------------------
     1. Eyebrow underline draw — all widths, CSS transition, own observer.
     The eyebrows are not inside any wave-2 [data-reveal] block, so this
     cannot ride on is-inview.
     ---------------------------------------------------------------------- */

  function initEyebrows() {
    if (!root.classList.contains('has-scroll')) return;

    var nodes = [];
    var watched = [];
    var watchers = [];

    each(document.querySelectorAll('.u-eyebrow-text'), function (el) {
      if (el.closest('.nav_component, .nav_mobile_wrap, .gutschein_modal_overlay, .contact_modal_overlay')) {
        // Navigation and modal chrome does not animate; draw it immediately so
        // the clip-path never leaves it invisible.
        el.classList.add('is-drawn');
        return;
      }
      nodes.push(el);
      // A clip-path on the observed element zeroes its intersectionRatio in
      // Chrome, so watch the un-clipped wrapper around it instead.
      var watch = el.closest('.u-eyebrow-wrapper') || el.parentElement || el;
      var slot = watched.indexOf(watch);
      if (slot === -1) {
        watched.push(watch);
        watchers.push([el]);
      } else {
        watchers[slot].push(el);
      }
    });

    if (!nodes.length) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var slot = watched.indexOf(entry.target);
        if (slot !== -1) {
          watchers[slot].forEach(function (el) { el.classList.add('is-drawn'); });
        }
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.25, rootMargin: '0px 0px -5% 0px' });

    watched.forEach(function (el) { observer.observe(el); });

    // Failsafe: an eyebrow in a container that never intersects must never stay
    // clipped.
    window.setTimeout(function () {
      nodes.forEach(function (el) { el.classList.add('is-drawn'); });
    }, 4000);
  }

  /* ----------------------------------------------------------------------
     2. Horizontal rail — CSS does the scrolling; this adds the edge-fade
     state, pointer drag and keyboard access, and only while the row really
     overflows (i.e. at <= 767px).
     ---------------------------------------------------------------------- */

  function initRails() {
    each(document.querySelectorAll('[data-scroll="rail"]'), function (rail) {
      rail.classList.add('u-scroll-rail');

      function overflows() {
        return rail.scrollWidth - rail.clientWidth > 4;
      }

      function syncState() {
        var max = rail.scrollWidth - rail.clientWidth;
        var on = max > 4;
        rail.classList.toggle('is-rail-scrolled', on && rail.scrollLeft > 4);
        rail.classList.toggle('is-rail-end', !on || rail.scrollLeft >= max - 4);
        if (on) {
          if (!rail.hasAttribute('tabindex')) {
            rail.setAttribute('tabindex', '0');
            rail.setAttribute('role', 'group');
          }
        } else if (rail.getAttribute('tabindex') === '0') {
          rail.removeAttribute('tabindex');
          rail.removeAttribute('role');
        }
      }

      rail.addEventListener('scroll', syncState, { passive: true });
      window.addEventListener('resize', syncState);
      syncState();

      rail.addEventListener('keydown', function (event) {
        if (!overflows()) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        var step = rail.clientWidth * 0.82;
        event.preventDefault();
        rail.scrollBy({ left: event.key === 'ArrowRight' ? step : -step, behavior: 'smooth' });
      });

      // Drag to scroll, mouse/pen only — touch already scrolls natively, and
      // capturing the pointer on pointerdown would break tap-to-follow-link.
      var dragging = false;
      var startX = 0;
      var startLeft = 0;
      var travelled = 0;

      rail.addEventListener('pointerdown', function (event) {
        if (event.pointerType === 'touch' || !overflows()) return;
        dragging = true;
        travelled = 0;
        startX = event.clientX;
        startLeft = rail.scrollLeft;
      });

      rail.addEventListener('pointermove', function (event) {
        if (!dragging) return;
        var dx = event.clientX - startX;
        travelled = Math.max(travelled, Math.abs(dx));
        if (travelled > 4) {
          if (!rail.classList.contains('is-rail-dragging')) rail.classList.add('is-rail-dragging');
          if (rail.setPointerCapture && !rail.hasPointerCapture(event.pointerId)) {
            rail.setPointerCapture(event.pointerId);
          }
          rail.scrollLeft = startLeft - dx;
        }
      });

      function endDrag(event) {
        if (!dragging) return;
        dragging = false;
        rail.classList.remove('is-rail-dragging');
        if (event && rail.releasePointerCapture && rail.hasPointerCapture(event.pointerId)) {
          rail.releasePointerCapture(event.pointerId);
        }
        if (travelled > 8) {
          rail.addEventListener('click', swallowClick, true);
          window.setTimeout(function () {
            rail.removeEventListener('click', swallowClick, true);
          }, 0);
        }
        syncState();
      }

      function swallowClick(event) {
        event.preventDefault();
        event.stopPropagation();
      }

      rail.addEventListener('pointerup', endDrag);
      rail.addEventListener('pointercancel', endDrag);
      rail.addEventListener('pointerleave', endDrag);

      // Cards whose whole surface is a link start a native HTML5 drag, which
      // swallows the pointermove stream. Cancel it while we are scrubbing.
      rail.addEventListener('dragstart', function (event) {
        if (dragging) event.preventDefault();
      });
      rail.addEventListener('selectstart', function (event) {
        if (dragging && travelled > 4) event.preventDefault();
      });
    });
  }

  /* ----------------------------------------------------------------------
     3. Reading progress — CSS scroll() timeline where available, otherwise
     ScrollTrigger writes --scroll--progress.
     ---------------------------------------------------------------------- */

  function initProgress() {
    var nodes = document.querySelectorAll('[data-scroll="progress"]');
    if (!nodes.length || root.classList.contains('has-scroll-timeline')) return;

    ScrollTrigger.create({
      trigger: root,
      start: 'top top',
      end: 'bottom bottom',
      onUpdate: function (self) {
        var value = String(Math.round(self.progress * 1000) / 1000);
        each(nodes, function (node) {
          node.style.setProperty('--scroll--progress', value);
        });
      }
    });
  }

  /* ----------------------------------------------------------------------
     4. Parallax — moves the inner <img> only. The wrapper keeps whatever the
     wave-2 reveal does to it.
     ---------------------------------------------------------------------- */

  function initParallax() {
    var touched = [];
    each(document.querySelectorAll('[data-scroll="parallax"]'), function (wrap) {
      var image = wrap.querySelector('img');
      if (!image) return;
      var amount = parseFloat(wrap.getAttribute('data-scroll-amount'));
      if (!(amount > 0)) amount = PARALLAX_DEFAULT;

      wrap.classList.add('u-scroll-clip');
      touched.push({ wrap: wrap, image: image });

      var shift = function () {
        return (wrap.getBoundingClientRect().height * amount) / 2;
      };

      gsap.fromTo(image,
        { y: function () { return -shift(); }, scale: 1 + amount },
        {
          y: function () { return shift(); },
          ease: 'none',
          scrollTrigger: {
            trigger: wrap,
            start: 'top bottom',
            end: 'bottom top',
            scrub: true,
            invalidateOnRefresh: true,
            onToggle: function (self) {
              image.style.willChange = self.isActive ? 'transform' : '';
            }
          }
        });
    });

    return function cleanup() {
      touched.forEach(function (item) {
        item.wrap.classList.remove('u-scroll-clip');
        item.image.style.willChange = '';
        gsap.set(item.image, { clearProps: 'transform' });
      });
    };
  }

  /* ----------------------------------------------------------------------
     7. Lenis
     ---------------------------------------------------------------------- */

  function initLenis() {
    if (!window.Lenis) return null;

    var lenis = new window.Lenis({
      lerp: 0.1,
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1,
      syncTouch: false,
      autoRaf: false
    });
    lenisInstance = lenis;

    function onLenisScroll() {
      ScrollTrigger.update();
    }
    lenis.on('scroll', onLenisScroll);

    function tick(time) {
      lenis.raf(time * 1000);
    }
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    // Anchor links and the skip link keep working: hand them to Lenis so the
    // destination is the same one the browser would have jumped to.
    function onAnchorClick(event) {
      var link = event.target.closest ? event.target.closest('a[href^="#"]') : null;
      if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
      var hash = link.getAttribute('href');
      if (!hash || hash === '#' || hash.length < 2) return;
      var target = document.getElementById(hash.slice(1));
      if (!target) return;
      event.preventDefault();
      // project.css gives every [id] a scroll-margin-top that clears the fixed navbar.
      var margin = parseFloat(window.getComputedStyle(target).scrollMarginTop) || 120;
      lenis.scrollTo(target, { offset: -margin, duration: 0.9 });
      if (window.history && history.replaceState) {
        history.replaceState(null, '', hash);
      }
    }
    document.addEventListener('click', onAnchorClick);

    return function cleanup() {
      document.removeEventListener('click', onAnchorClick);
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.off('scroll', onLenisScroll);
      lenis.destroy();
      lenisInstance = null;
    };
  }

  /* ----------------------------------------------------------------------
     boot
     ---------------------------------------------------------------------- */

  function boot() {
    initEyebrows();
    initRails();
    initProgress();

    var mm = gsap.matchMedia();

    mm.add('(min-width: 992px) and (pointer: fine) and (prefers-reduced-motion: no-preference)', function () {
      var cleanups = [initLenis(), initParallax()];
      return function () {
        cleanups.forEach(function (fn) { if (fn) fn(); });
      };
    });

    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { refreshSoon(80); });
    }
    window.addEventListener('load', function () { refreshSoon(120); });
    each(document.images, function (image) {
      if (image.complete) return;
      image.addEventListener('load', function () { refreshSoon(200); }, { once: true });
    });
    // The mobile menu changes document height while it is open.
    document.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('.nav_button_wrap, .nav_mobile_menu_wrap a')) {
        refreshSoon(450);
      }
    });

    if (reduceQuery && reduceQuery.addEventListener) {
      reduceQuery.addEventListener('change', function (event) {
        if (event.matches) {
          root.classList.remove('has-scroll');
          each(document.querySelectorAll('.u-eyebrow-text'), function (el) {
            el.classList.add('is-drawn');
          });
        } else {
          root.classList.add('has-scroll');
        }
      });
    }
  }

  // The tab component binds its own DOMContentLoaded handler from an inline
  // script that is parsed before this deferred file, so it would otherwise run
  // after us. One task later is enough to be behind it.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      window.setTimeout(boot, 0);
    }, { once: true });
  } else {
    window.setTimeout(boot, 0);
  }
})();
