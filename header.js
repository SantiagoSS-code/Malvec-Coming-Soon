// Malvec Header — cross-browser resilient

(function () {
  'use strict';

  // Use DOMContentLoaded with a fallback for in-app browsers that may fire late
  var ready = function (fn) {
    if (document.readyState !== 'loading') {
      fn();
    } else {
      document.addEventListener('DOMContentLoaded', fn, false);
    }
  };

  ready(function () {
    var navbar = document.getElementById('navbar');
    if (!navbar) return;

    // ── Scroll class toggle (passive for perf) ────────────────
    var ticking = false;
    var onScroll = function () {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(function () {
          navbar.classList.toggle('scrolled', window.scrollY > 20);
          ticking = false;
        });
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Set initial state
    onScroll();

    // ── Active link tracking ──────────────────────────────────
    var links = navbar.querySelectorAll('.nav-links a');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function () {
        for (var j = 0; j < links.length; j++) {
          links[j].classList.remove('active');
        }
        this.classList.add('active');
      }, false);
    }
  });
})();


