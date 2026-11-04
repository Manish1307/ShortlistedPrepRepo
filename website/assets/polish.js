// Home page: the sticky "Check my resume free" bar on phones, shown once the first screen (the hero) has scrolled out of view.
(function () {
  'use strict';
  var bar = document.getElementById('m-cta'), hero = document.querySelector('.dc-hero');
  if (!bar || !hero || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(function (entries) {
    var visible = entries[0].isIntersecting;
    bar.hidden = visible;
    document.body.classList.toggle('has-mcta', !visible);
  }, { threshold: 0 }).observe(hero);
})();
