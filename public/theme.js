/* 테마 저장·적용. <head>에서 먼저 실행해서 화면이 번쩍이지 않게 해요. */
(function () {
  var KEY = 'eum-theme';
  var THEMES = ['', 'light', 'ivory', 'gray', 'dark']; // ''는 기기 설정 따르기
  function get() {
    try {
      var v = localStorage.getItem(KEY) || '';
      return THEMES.indexOf(v) > -1 ? v : '';
    } catch (e) {
      return '';
    }
  }
  function apply(v) {
    var root = document.documentElement;
    if (v) root.setAttribute('data-theme', v);
    else root.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }
  function set(v) {
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (e) {}
    apply(v);
  }
  window.eumTheme = { get: get, set: set, apply: apply };
  apply(get());
})();
