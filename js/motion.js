(function () {
  var root = document.documentElement;
  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var canAnimate = 'IntersectionObserver' in window && !(reduceQuery && reduceQuery.matches);
  var observer = null;
  var parseObserver = null;
  var marked = [];
  var markedSet = new WeakSet();

  if (!canAnimate) {
    return;
  }

  root.classList.add('has-motion');

  var targetSelector = [
    '.u-heading',
    '.u-text',
    '.u-rich-text',
    '.u-button-wrapper',
    '.feature_card_wrap',
    '.about_cta_image',
    '.about_cta_content',
    '.carousel_wrap',
    '.quote_section .u-container',
    '.price_card',
    'details',
    '.accordion_item',
    '.studio_card',
    '.class-style_card',
    '.blog_card',
    '.contact_form',
    '.fullwidth_photo',
    '.u-image-wrapper'
  ].join(',');
  var excludedSelector = [
    '.nav_component',
    '.nav_mobile_wrap',
    '.marquee_section',
    '.marquee_wrap',
    '.method_video_hero',
    '.schedule_eversports_wrap',
    '[data-eversports-widget-id]',
    'footer'
  ].join(',');

  function isElement(value) {
    return value && value.nodeType === 1;
  }

  function isInsideHero(element) {
    return Boolean(element.closest('.u-min-height-screen, .hero_simple, .page_hero, [class*="hero"]'));
  }

  function isAllowedTarget(element) {
    if (!isElement(element) || !element.matches(targetSelector)) {
      return false;
    }
    if (element.closest(excludedSelector)) {
      return false;
    }
    if (element.matches('input, textarea, select, button, label, option')) {
      return false;
    }
    if (element.matches('.u-rich-text') && element.closest('.u-heading')) {
      return false;
    }
    if (element.matches('.u-image-wrapper') && isInsideHero(element)) {
      return false;
    }
    return true;
  }

  function collectTargets(scope) {
    var list = [];
    if (isAllowedTarget(scope)) {
      list.push(scope);
    }
    if (scope.querySelectorAll) {
      Array.prototype.forEach.call(scope.querySelectorAll(targetSelector), function (element) {
        if (isAllowedTarget(element)) {
          list.push(element);
        }
      });
    }
    return list;
  }

  function preferOuterTargets(targets) {
    var unique = [];
    targets.forEach(function (target) {
      if (unique.indexOf(target) === -1) {
        unique.push(target);
      }
    });
    return unique.filter(function (target) {
      return !unique.some(function (candidate) {
        return candidate !== target && candidate.contains(target);
      });
    });
  }

  function setSiblingIndexes(targets) {
    var groups = [];
    targets.forEach(function (target) {
      var parent = target.parentElement;
      if (parent && groups.indexOf(parent) === -1) {
        groups.push(parent);
      }
    });
    groups.forEach(function (parent) {
      var index = 0;
      targets.forEach(function (target) {
        if (target.parentElement === parent) {
          target.style.setProperty('--reveal-index', Math.min(index, 8));
          index += 1;
        }
      });
    });
  }

  function reveal(element) {
    element.classList.add('is-inview');
  }

  function revealAboveFold() {
    var height = window.innerHeight || root.clientHeight;
    marked.forEach(function (element) {
      if (!element.classList.contains('is-inview') && element.getBoundingClientRect().top < height) {
        reveal(element);
        if (observer) {
          observer.unobserve(element);
        }
      }
    });
  }

  function markTargets(scope) {
    var targets = preferOuterTargets(collectTargets(scope || document));
    if (!targets.length) {
      return;
    }
    setSiblingIndexes(targets);
    targets.forEach(function (target) {
      if (markedSet.has(target)) {
        return;
      }
      target.setAttribute('data-reveal', '');
      markedSet.add(target);
      marked.push(target);
      if (observer) {
        observer.observe(target);
      }
    });
  }

  function startParseObserver() {
    if (!('MutationObserver' in window)) {
      return;
    }
    parseObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        Array.prototype.forEach.call(mutation.addedNodes, function (node) {
          if (isElement(node)) {
            markTargets(node);
          }
        });
      });
    });
    parseObserver.observe(root, {
      childList: true,
      subtree: true
    });
  }

  function stopParseObserver() {
    if (parseObserver) {
      parseObserver.disconnect();
      parseObserver = null;
    }
  }

  function initObserver() {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.12,
      rootMargin: '0px 0px -8% 0px'
    });
  }

  function observeMarked() {
    if (!observer) {
      return;
    }
    marked.forEach(function (element) {
      if (!element.classList.contains('is-inview')) {
        observer.observe(element);
      }
    });
  }

  function revealAllRemaining() {
    marked.forEach(function (element) {
      if (!element.classList.contains('is-inview')) {
        reveal(element);
      }
    });
  }

  function pruneNestedDuplicates() {
    // Parse-time marking runs once per MutationObserver batch, scoped to whatever
    // node that batch added. preferOuterTargets() only dedupes nesting *within*
    // one batch, so an ancestor marked in an earlier batch (e.g. .carousel_wrap,
    // inserted empty) and descendants marked in a later batch (its children,
    // appended afterward, e.g. .u-heading/.u-text inside .carousel_slide_content)
    // both end up with data-reveal. Once the document is fully parsed (onReady),
    // do one authoritative global pass and demote any target still contained by
    // another target: strip data-reveal so it renders at rest, matching "reveal
    // only the outer one, never both".
    var deduped = preferOuterTargets(marked);
    if (deduped.length === marked.length) {
      return;
    }
    marked.forEach(function (element) {
      if (deduped.indexOf(element) !== -1) {
        return;
      }
      element.removeAttribute('data-reveal');
      element.classList.remove('is-inview');
      element.style.removeProperty('--reveal-index');
      if (observer) {
        observer.unobserve(element);
      }
      markedSet.delete(element);
    });
    marked = deduped;
  }

  function onReady() {
    initObserver();
    markTargets(document);
    pruneNestedDuplicates();
    observeMarked();
    window.requestAnimationFrame(revealAboveFold);
    window.setTimeout(revealAboveFold, 2500);
    stopParseObserver();
  }

  startParseObserver();
  markTargets(document);
  document.addEventListener('DOMContentLoaded', onReady, { once: true });
  window.addEventListener('pageshow', revealAboveFold);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      revealAboveFold();
    }
  });

  if (reduceQuery && reduceQuery.addEventListener) {
    reduceQuery.addEventListener('change', function (event) {
      if (event.matches) {
        root.classList.remove('has-motion');
        revealAllRemaining();
        stopParseObserver();
      }
    });
  }
})();
