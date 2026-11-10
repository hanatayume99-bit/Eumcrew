'use strict';
/* 음크루 프론트엔드 — 해시 라우팅 SPA, 외부 라이브러리 없음.
   사용자 입력은 항상 textContent로만 넣어서 XSS를 막습니다. */

const TYPES = {
  song: { path: 'songs', label: '노래', icon: '♪', write: '노래 올리기' },
  info: { path: 'info', label: '정보·팁', icon: '✦', write: '정보 쓰기' },
  job: { path: 'jobs', label: '구인구직', icon: '☺', write: '구인·구직 글쓰기' },
  qna: { path: 'qna', label: '질문답변', icon: '?', write: '질문하기' },
};
const PATH_TO_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [v.path, t]));
const SONG_KINDS = { original: '자작곡', cover: '커버', collab: '합작', remix: '리믹스' };
const JOB_KINDS = { hire: '구인', seek: '구직' };
const INFO_CATEGORIES = ['작곡', '작사', '편곡', '조교', '믹싱/마스터링', '보컬', '일러스트', '영상', '합작/행사', '기타'];
const ROLES = ['작곡', '작사', '편곡', '조교', '믹싱', '마스터링', '보컬', '일러스트', '영상', '기타'];
const MAX_IMAGES = 6;

let me = null;
let authReady = false; // /api/me 응답을 받은 뒤에 true
const imgUrl = (id) => `/img/${id}`;

/* ───────── 유틸 ───────── */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let pendingValue;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') pendingValue = v;
    else if (k === 'checked' || k === 'disabled') el[k] = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (pendingValue !== undefined) el.value = pendingValue;
  return el;
}

/* Render 무료 서버는 한동안 안 쓰면 잠들어서 첫 요청이 30초~1분 걸릴 수 있어요.
   그래서 기다리는 시간을 넉넉히 두고, 읽기 요청(GET)은 서버가 깨어나는 동안 몇 번 더 시도해요. */
const GET_TIMEOUT = 45000;
const SEND_TIMEOUT = 30000;
const RETRY_WAIT = [1500, 4000];
let inflight = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setBusy(delta) {
  inflight = Math.max(0, inflight + delta);
  document.body.classList.toggle('busy', inflight > 0); // 화면 맨 위 진행 막대
}

async function request(method, url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), method === 'GET' ? GET_TIMEOUT : SEND_TIMEOUT);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      const timeout = !!err && err.name === 'AbortError';
      const e = new Error(timeout ? '서버 응답이 늦어지고 있어요. 잠시 뒤에 다시 시도해 주세요.' : '인터넷 연결을 확인해 주세요.');
      e.status = 0;
      e.timeout = timeout;
      e.network = !timeout;
      throw e;
    }
    // 서버가 깨어나는 중이면 JSON 대신 안내용 HTML 페이지가 올 수 있어요
    const isHtml = /text\/html/.test(res.headers.get('content-type') || '');
    let data = {};
    if (!isHtml) {
      try {
        data = await res.json();
      } catch {}
    }
    if (isHtml || !res.ok) {
      const e = new Error(isHtml ? '서버가 아직 준비 중이에요. 잠시 뒤에 다시 시도해 주세요.' : data.error || '요청에 실패했어요.');
      e.status = isHtml && res.ok ? 503 : res.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function api(method, url, body) {
  setBusy(1);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(method, url, body);
      } catch (e) {
        const retryable = method === 'GET' && (e.network || [502, 503, 504].includes(e.status));
        if (!retryable || attempt >= RETRY_WAIT.length) throw e;
        await sleep(RETRY_WAIT[attempt]);
      }
    }
  } finally {
    setBusy(-1);
  }
}

/* 토스트: toast('메시지') = 성공, toast('메시지', true) = 오류, toast('메시지', 'info') = 안내 */
let toastTimer;
const hideToast = () => {
  document.getElementById('toast').className = '';
};
function toast(msg, kind) {
  const k = kind === true ? 'bad' : kind || 'ok';
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', { class: 'ti', 'aria-hidden': 'true' }, { ok: '✓', bad: '!', info: 'i' }[k] || '✓'), h('span', null, msg));
  t.setAttribute('role', k === 'bad' ? 'alert' : 'status');
  t.className = 'show ' + k;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, k === 'bad' ? 4500 : 2600);
}
document.getElementById('toast').addEventListener('click', hideToast);

/* 버튼을 누르면 글자를 바꾸고 돌아가는 표시를 보여 주면서 끝날 때까지 잠가요 (중복 클릭 방지) */
async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.textContent = old;
  }
}

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}일 전`;
  return new Date(ms).toLocaleDateString('ko-KR');
}

function ytId(u) {
  try {
    const x = new URL(u);
    let id = null;
    if (x.hostname === 'youtu.be') id = x.pathname.slice(1);
    else if (/(^|\.)youtube\.com$/.test(x.hostname)) {
      if (x.pathname === '/watch') id = x.searchParams.get('v');
      else {
        const m = x.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/);
        if (m) id = m[2];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};
const typeLink = (t, query = '') => `#/${TYPES[t].path}${query}`;

/* ───────── 빈 화면 · 오류 화면 · 로딩(스켈레톤) ───────── */
function emptyState({ icon = '📭', title, desc, actions = [], compact = false }) {
  return h(
    'div',
    { class: 'empty' + (compact ? ' compact' : '') },
    h('div', { class: 'empty-ic', 'aria-hidden': 'true' }, icon),
    h('div', { class: 'empty-title' }, title),
    desc ? h('p', { class: 'empty-desc' }, desc) : null,
    actions.length ? h('div', { class: 'row' }, actions) : null
  );
}

/* 오류가 나도 막다른 길이 되지 않게: 다시 시도 / 이전 화면 / 홈으로 버튼을 항상 줘요 */
function errorView(e) {
  let icon = '⚠️';
  let title = '문제가 생겼어요';
  let desc = e.message || '잠시 뒤에 다시 시도해 주세요.';
  if (e.network) [icon, title, desc] = ['📡', '인터넷 연결이 불안정해요', '연결을 확인한 뒤 다시 시도해 주세요.'];
  else if (e.timeout) [icon, title, desc] = ['⏳', '서버가 아직 깨어나는 중이에요', '무료 서버라 오랜만에 접속하면 첫 로딩이 느려요. 잠시 뒤에 다시 시도해 주세요.'];
  else if (e.status === 404) [icon, title] = ['🔍', '찾을 수 없어요'];
  else if (e.status === 401) [icon, title, desc] = ['🔒', '로그인이 필요해요', '로그인한 뒤에 이용할 수 있어요.'];
  else if (e.status === 403) [icon, title] = ['🚫', '권한이 없어요'];
  else if (e.status >= 500) [icon, title, desc] = ['🛠️', '서버가 잠시 불안정해요', '잠깐 뒤에 다시 시도해 주세요. 계속되면 운영진에게 알려 주세요.'];
  const retryable = e.network || e.timeout || e.status >= 500 || e.status === 0;
  return h(
    'div',
    { class: 'errbox', role: 'alert' },
    h('div', { class: 'empty-ic', 'aria-hidden': 'true' }, icon),
    h('h1', null, title),
    h('p', { class: 'muted' }, desc),
    h(
      'div',
      { class: 'row' },
      retryable ? h('button', { class: 'btn primary', type: 'button', onclick: () => render() }, '다시 시도') : null,
      e.status === 401 ? h('a', { class: 'btn primary', href: '#/login?next=' + encodeURIComponent(location.hash || '#/') }, '로그인') : null,
      history.length > 1 ? h('button', { class: 'btn', type: 'button', onclick: () => history.back() }, '← 이전 화면') : null,
      h('a', { class: 'btn', href: '#/' }, '홈으로')
    )
  );
}

const sk = (cls) => h('div', { class: 'skel ' + cls });
const skelCards = (n = 4, thumb = true) =>
  h('div', { class: 'cards' }, Array.from({ length: n }, () => h('div', { class: 'skel-card' }, h('div', { class: 'skel-lines' }, sk('line lg w70'), sk('line w40'), sk('line sm w50')), thumb ? sk('thumb') : null)));
const skelComments = () =>
  h('div', { class: 'skel-wrap' }, Array.from({ length: 2 }, () => h('div', { class: 'skel-comment' }, sk('line sm w30'), sk('line w80'))));

function skeletonKind(path) {
  if (path === '/') return 'home';
  if (/^\/post\//.test(path)) return 'post';
  if (/^\/u\//.test(path)) return 'profile';
  return 'list';
}
function skeletonFor(kind) {
  const wrap = (...kids) => h('div', { class: 'skel-wrap', 'aria-hidden': 'true' }, kids);
  if (kind === 'home') {
    return wrap(sk('hero-blk'), h('div', { class: 'statbar' }, Array.from({ length: 5 }, () => sk('stat-blk'))), sk('line lg w30'), skelCards(3));
  }
  if (kind === 'post') {
    return wrap(
      sk('line sm w20'),
      sk('line xl w80'),
      h('div', { class: 'skel-row' }, sk('circle'), h('div', { class: 'skel-lines' }, sk('line w30'), sk('line sm w40'))),
      sk('block'),
      sk('line lg w30'),
      skelComments()
    );
  }
  if (kind === 'profile') {
    return wrap(h('div', { class: 'skel-row' }, sk('circle lg'), h('div', { class: 'skel-lines' }, sk('line xl w40'), sk('line w60'))), sk('block'), sk('line lg w40'), skelCards(3));
  }
  return wrap(h('div', { class: 'skel-row between' }, sk('line xl w30'), sk('btn-blk')), sk('input-blk'), skelCards(5));
}

/* 로딩 표시: 0.2초 안에 끝나면 아무것도 안 보이고(깜빡임 방지), 더 걸리면 뼈대 화면,
   3.5초가 넘으면 "서버를 깨우는 중" 안내를 보여 줘요 */
let loadingTimers = [];
function showSkeleton(app, kind) {
  const old = app.querySelector(':scope > .wake');
  if (old && app.dataset.skel === kind) return old;
  const wake = h(
    'div',
    { class: 'wake', role: 'status', hidden: true },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('div', null, h('b', null, '서버를 깨우는 중이에요'), h('span', { class: 'small' }, '무료 서버라 오랜만에 접속하면 첫 로딩이 최대 1분쯤 걸려요. 조금만 기다려 주세요!'))
  );
  app.replaceChildren(wake, skeletonFor(kind));
  app.dataset.skel = kind;
  app.setAttribute('aria-busy', 'true');
  return wake;
}
function beginLoading(path, immediate = false) {
  endLoading();
  const app = document.getElementById('app');
  const kind = skeletonKind(path);
  let wake = null;
  const show = () => (wake = showSkeleton(app, kind));
  if (immediate) show();
  else loadingTimers.push(setTimeout(show, 200));
  loadingTimers.push(
    setTimeout(() => {
      if (!wake) show();
      wake.hidden = false;
    }, 3500)
  );
}
function endLoading() {
  loadingTimers.forEach(clearTimeout);
  loadingTimers = [];
  const app = document.getElementById('app');
  app.removeAttribute('aria-busy');
}

/* 로그아웃 (헤더·메뉴 공용) */
async function logout() {
  try {
    await api('POST', '/api/logout', {});
  } catch (e) {
    return toast('로그아웃하지 못했어요. 잠시 뒤에 다시 시도해 주세요.', true);
  }
  me = null;
  toast('로그아웃했어요.');
  go('#/');
}

/* ───────── 헤더 ───────── */
const APP_VERSION = 'v1.1.0-beta1';

function logoSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 30 20');
  svg.setAttribute('aria-hidden', 'true');
  [['10', 'ring-a'], ['20', 'ring-b']].forEach(([cx, cls]) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', '10'); c.setAttribute('r', '8');
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', '2.4');
    c.setAttribute('class', cls);
    svg.append(c);
  });
  return svg;
}

/* ───────── 사이드 메뉴 ───────── */
let menuEl = null;
let installEvent = null; // 안드로이드 크롬이 "설치 가능"이라고 알려 주면 여기에 담아 둬요
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
});

function onMenuKey(e) {
  if (!menuEl) return;
  if (e.key === 'Escape') return closeMenu();
  if (e.key !== 'Tab') return;
  // 메뉴 안에서만 Tab이 돌게 (키보드 사용자용)
  const items = [...menuEl.querySelectorAll('a[href], button:not([disabled]), summary')];
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
  else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
}

function closeMenu(restoreFocus = true) {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.body.classList.remove('menu-open');
  document.removeEventListener('keydown', onMenuKey);
  if (restoreFocus) {
    const btn = document.querySelector('.menu-btn');
    if (btn) btn.focus();
  }
}

/* 🎲 랜덤 추천: 아무 글이나 하나 열어 줘요 */
async function randomPick() {
  closeMenu(false);
  try {
    const r = await api('GET', '/api/random');
    go(`#/post/${r.id}`);
  } catch (e) {
    toast(e.message, true);
  }
}

function openMenu() {
  if (menuEl) return closeMenu();
  const link = (href, ic, label) => h('a', { class: 'mlink', href, onclick: () => closeMenu(false) }, h('span', { class: 'mic', 'aria-hidden': 'true' }, ic), label);
  const action = (ic, label, fn) => h('button', { class: 'mlink', type: 'button', onclick: fn }, h('span', { class: 'mic', 'aria-hidden': 'true' }, ic), label);

  const THEMES = [['', '기기 설정'], ['light', '라이트'], ['ivory', '아이보리'], ['gray', '그레이'], ['dark', '다크']];
  const curTheme = window.eumTheme ? window.eumTheme.get() : '';
  const themeRow = h(
    'div',
    { class: 'chips', role: 'radiogroup', 'aria-label': '테마' },
    THEMES.map(([v, label]) =>
      h(
        'button',
        {
          class: 'chip btnlike' + (v === curTheme ? ' on' : ''),
          type: 'button',
          role: 'radio',
          'aria-checked': String(v === curTheme),
          onclick: (e) => {
            if (window.eumTheme) window.eumTheme.set(v);
            for (const c of themeRow.children) {
              const on = c === e.currentTarget;
              c.classList.toggle('on', on);
              c.setAttribute('aria-checked', String(on));
            }
          },
        },
        label
      )
    )
  );

  const install = h(
    'details',
    { class: 'minstall' },
    h('summary', null, '📱 홈 화면에 추가'),
    h(
      'div',
      { class: 'small muted stack' },
      installEvent
        ? h(
            'button',
            {
              class: 'btn sm primary',
              type: 'button',
              onclick: async () => {
                const ev = installEvent;
                installEvent = null;
                closeMenu(false);
                try {
                  await ev.prompt();
                } catch {}
              },
            },
            '앱처럼 설치하기'
          )
        : null,
      h('p', null, '안드로이드 크롬: 오른쪽 위 ⋮ → “홈 화면에 추가”'),
      h('p', null, '아이폰 사파리: 아래 공유 버튼 → “홈 화면에 추가”')
    )
  );

  const account = me
    ? h(
        'div',
        { class: 'mgroup' },
        link(`#/u/${encodeURIComponent(me.username)}`, '☻', me.username),
        action('↩', '로그아웃', () => {
          closeMenu(false);
          return logout();
        })
      )
    : h('div', { class: 'mgroup' }, link('#/login', '☻', '로그인'), link('#/signup', '✚', '가입하기'));

  const panel = h(
    'aside',
    { class: 'menu', role: 'dialog', 'aria-modal': 'true', 'aria-label': '메뉴' },
    h('div', { class: 'row between' }, h('strong', { class: 'mtitle' }, '메뉴'), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': '메뉴 닫기', onclick: () => closeMenu() }, '✕')),
    account,
    h(
      'nav',
      { class: 'mgroup', 'aria-label': '게시판' },
      link('#/', '⌂', '홈'),
      link('#/songs', '♫', '노래'),
      link('#/info', '✦', '정보·팁'),
      link('#/jobs', '＋', '구인구직'),
      link('#/qna', '?', '질문답변'),
      link('#/members', '☻', '멤버'),
      link('#/search', '⌕', '검색')
    ),
    h('div', { class: 'mgroup' }, action('🎲', '랜덤 추천 글 보기', randomPick)),
    me
      ? h(
          'div',
          { class: 'mgroup' },
          h('div', { class: 'mlabel' }, '글쓰기'),
          link('#/write/song', '♫', '노래 올리기'),
          link('#/write/info', '✦', '정보 글쓰기'),
          link('#/write/job', '＋', '모집·구직 글쓰기'),
          link('#/write/qna', '?', '질문하기')
        )
      : null,
    h('div', { class: 'mgroup' }, h('div', { class: 'mlabel' }, '테마'), themeRow),
    install,
    h('div', { class: 'mfoot muted small' }, `이음크루 ${APP_VERSION}`)
  );
  menuEl = h('div', { class: 'menu-root' }, h('div', { class: 'menu-backdrop', onclick: () => closeMenu() }), panel);
  document.body.append(menuEl);
  document.body.classList.add('menu-open');
  document.addEventListener('keydown', onMenuKey);
  const firstLink = panel.querySelector('a.mlink');
  if (firstLink) firstLink.focus();
}

function renderHeader(path) {
  const top = document.getElementById('top');
  const cur = path.split('/')[1] || '';
  const mob = document.getElementById('mobnav');
  if (mob) {
    const item = (href, ic, label, on) => h('a', { href, class: on ? 'on' : '' }, h('span', { 'aria-hidden': 'true' }, ic), label);
    mob.replaceChildren(
      item('#/', '⌂', '홈', cur === ''),
      item('#/songs', '♫', '노래', cur === 'songs'),
      item('#/info', '✦', '정보', cur === 'info'),
      item('#/jobs', '＋', '모집', cur === 'jobs'),
      item('#/qna', '?', '질문', cur === 'qna'),
      item('#/search', '⌕', '검색', cur === 'search'),
      item(me ? `#/u/${encodeURIComponent(me.username)}` : authReady ? '#/login' : '#/me', '☻', me || !authReady ? '마이' : '로그인', cur === 'u' || cur === 'members' || cur === 'me' || cur === 'login' || cur === 'signup')
    );
  }
  const tab = (href, label, on) => h('a', { class: 'tab', href, 'aria-selected': on ? 'true' : 'false' }, label);
  top.replaceChildren(
    h(
      'div',
      { class: 'bar' },
      h('a', { class: 'logo', href: '#/', 'aria-label': '이음크루 홈' }, logoSvg(), h('span', null, '이음', h('b', null, '크루'))),
      h('span', { class: 'ver-badge', title: `이음크루 ${APP_VERSION}` }, APP_VERSION),
      h('span', { class: 'spacer' }),
      !authReady
        ? null // 로그인 여부를 아직 모르면 버튼을 비워 둬요 (로그인 버튼이 잠깐 보였다 사라지는 깜빡임 방지)
        : me
        ? [
            h('a', { class: 'btn sm ghost', href: `#/u/${encodeURIComponent(me.username)}` }, me.username),
            h('button', { class: 'btn sm ghost', type: 'button', onclick: logout }, '로그아웃'),
          ]
        : [h('a', { class: 'btn sm ghost', href: '#/login' }, '로그인'), h('a', { class: 'btn sm primary', href: '#/signup' }, '가입')],
      h('button', { class: 'btn sm ghost menu-btn', type: 'button', 'aria-label': '메뉴 열기', 'aria-haspopup': 'dialog', onclick: openMenu }, '☰')
    ),
    h(
      'nav',
      { class: 'tabs' },
      tab('#/', '홈', cur === ''),
      tab('#/songs', '노래', cur === 'songs'),
      tab('#/info', '정보·팁', cur === 'info'),
      tab('#/jobs', '구인구직', cur === 'jobs'),
      tab('#/qna', '질문답변', cur === 'qna'),
      tab('#/members', '멤버', cur === 'members' || cur === 'u' || cur === 'me'),
      tab('#/search', '🔍 검색', cur === 'search')
    )
  );
}

/* ───────── 카드 ───────── */
function postCard(p, { showType = false } = {}) {
  const meta = [h('span', { class: 'author' }, p.author.username), h('span', null, ago(p.created_at))];
  if (p.like_count) meta.push(h('span', null, `♥ ${p.like_count}`));
  if (p.comment_count) meta.push(h('span', null, `💬 ${p.comment_count}`));
  const chips = [];
  if (showType) chips.push(h('span', { class: 'chip' }, TYPES[p.type].label));
  if (p.type === 'qna') {
    chips.push(h('span', { class: 'chip acc' }, p.extra.category || '기타'));
    chips.push(h('span', { class: 'chip ' + (p.closed ? 'pink' : 'warn') }, p.closed ? '✔ 해결됨' : '답변 기다리는 중'));
  } else if (p.type === 'song') {
    chips.push(h('span', { class: 'chip acc' }, SONG_KINDS[p.extra.kind] || '노래'));
    if (p.extra.vocal) chips.push(h('span', { class: 'chip' }, `보컬 ${p.extra.vocal}`));
    if (p.extra.genre) chips.push(h('span', { class: 'chip' }, p.extra.genre));
  } else if (p.type === 'info') {
    chips.push(h('span', { class: 'chip acc' }, p.extra.category || '기타'));
  } else {
    chips.push(h('span', { class: 'chip ' + (p.extra.kind === 'hire' ? 'pink' : 'acc') }, JOB_KINDS[p.extra.kind] || ''));
    chips.push(h('span', { class: 'chip' }, p.extra.role));
    chips.push(h('span', { class: 'chip warn' }, '무페이'));
    if (p.closed) chips.push(h('span', { class: 'chip' }, '마감'));
    else if (p.extra.deadline) chips.push(h('span', { class: 'chip' }, `~${p.extra.deadline}`));
  }
  const main = [h('div', { class: 'title' }, p.title), h('div', { class: 'chips' }, chips), h('div', { class: 'meta' }, meta)];
  return h(
    'a',
    { class: 'card' + (p.closed && p.type === 'job' ? ' closed' : '') + (p.thumb ? ' has-thumb' : ''), href: `#/post/${p.id}` },
    p.thumb ? h('img', { class: 'thumb', src: imgUrl(p.thumb), alt: '', loading: 'lazy' }) : null,
    p.thumb ? h('div', { class: 'card-main' }, main) : main
  );
}

/* empty: 문장(string)이나 emptyState(...)로 만든 화면 */
const cards = (items, empty = '아직 글이 없어요.', opts) =>
  items.length ? h('div', { class: 'cards' }, items.map((p) => postCard(p, opts))) : empty && empty.nodeType ? empty : emptyState({ title: empty, compact: true });

/* ───────── 홈 ───────── */
function dday(deadline) {
  if (!deadline) return '';
  const d = Math.ceil((new Date(deadline + 'T23:59:59') - Date.now()) / 86400000);
  return d < 0 ? '마감' : d === 0 ? 'D-DAY' : `D-${d}`;
}

function projectCard(p) {
  const ex = p.extra || {};
  const tags = [ex.role, ...(p.tags || [])].filter(Boolean).slice(0, 4);
  const desc = (p.body || '').replace(/\s+/g, ' ').slice(0, 60);
  return h(
    'a',
    { class: 'card project', href: `#/post/${p.id}` },
    h(
      'div',
      { class: 'cover c' + (p.id % 3) },
      p.thumb ? h('img', { class: 'cover-img', src: imgUrl(p.thumb), alt: '', loading: 'lazy' }) : null,
      h('span', { class: 'status' }, JOB_KINDS[ex.kind] === '구직' ? '구직' : '모집중'),
      p.thumb ? null : h('span', { class: 'symbol', 'aria-hidden': 'true' }, '♫')
    ),
    h(
      'div',
      { class: 'pbody' },
      h('div', { class: 'title' }, p.title),
      h('div', { class: 'desc' }, desc),
      h('div', { class: 'chips' }, tags.map((t) => h('span', { class: 'chip' }, t)), h('span', { class: 'chip warn' }, '무페이')),
      h('div', { class: 'pfoot' }, h('span', null, '👤 ' + p.author.username), h('span', null, dday(ex.deadline) || ago(p.created_at)))
    )
  );
}

function workCard(p) {
  return h(
    'a',
    { class: 'card work', href: `#/post/${p.id}` },
    p.thumb
      ? h('img', { class: 'work-thumb', src: imgUrl(p.thumb), alt: '', loading: 'lazy' })
      : h('div', { class: 'work-icon', 'aria-hidden': 'true' }, ['♫', '◉', '♪', '♬'][p.id % 4]),
    h('div', { class: 'title' }, p.title),
    h('div', { class: 'muted small' }, '@' + p.author.username)
  );
}

const FEATURES = [
  ['🎵', '합작 프로젝트', '작곡, 작사, 보컬, 조교, 믹싱, 일러스트, 영상 등 다양한 분야의 창작자를 연결해요.'],
  ['🤝', '크리에이터 모집', '원하는 역할의 참가자를 직접 모집하고 새로운 팀을 만들어 보세요.'],
  ['📚', '창작 자료실', '보컬로이드, UTAU, 작곡, 믹싱 등 음악 제작에 필요한 정보를 공유해요.'],
];

async function pageHome() {
  const d = await api('GET', '/api/home');
  const head = (title, desc, href, more) =>
    h('div', { class: 'section-head' }, h('div', null, h('h2', null, title), desc ? h('div', { class: 'muted small' }, desc) : null), href ? h('a', { class: 'more', href }, more) : null);
  const stat = (n, label, href) => h('a', { class: 'stat', href }, h('b', null, String(n)), h('span', null, label));

  // 인기 / 최신 / 답변 필요 탭 (서버에서 한 번에 받아 와서 화면에서만 바꿔요)
  const feeds = [
    ['popular', '🔥 인기', d.popular, '아직 인기 글이 없어요.'],
    ['latest', '🆕 최신', d.latest, '아직 글이 없어요.'],
    ['needs', '🙋 답변 필요', d.needs, '답변을 기다리는 질문이 없어요. 👏'],
  ];
  let curFeed = d.popular.length ? 'popular' : 'latest';
  const panel = h('div', { role: 'tabpanel' });
  const tabRow = h('div', { class: 'chips', role: 'tablist', 'aria-label': '둘러보기' });
  const showFeed = (key) => {
    curFeed = key;
    for (const b of tabRow.children) {
      const on = b.dataset.key === key;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    const [, , items, empty] = feeds.find((f) => f[0] === key);
    panel.replaceChildren(
      cards(items, empty, { showType: true }),
      ...(key === 'needs' ? [h('p', { class: 'small' }, h('a', { href: typeLink('qna', '?open=1') }, '해결 안 된 질문 모두 보기 →'))] : [])
    );
  };
  for (const [key, label] of feeds) tabRow.append(h('button', { class: 'chip btnlike', type: 'button', role: 'tab', 'data-key': key, onclick: () => showFeed(key) }, label));
  showFeed(curFeed);

  return h(
    'div',
    null,
    h(
      'section',
      { class: 'hero' },
      h('div', { class: 'hero-label' }, '✦ MUSIC CREATOR COMMUNITY'),
      h('h1', null, '음악을 만드는 사람들을 ', h('span', null, '잇다.')),
      h('p', { class: 'muted' }, '작곡가부터 보컬, 일러스트레이터, 영상 제작자까지. 함께 음악을 만들고 새로운 프로젝트를 시작해 보세요.'),
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn primary', href: me ? '#/write/song' : '#/signup' }, me ? '노래 올리기' : '가입하고 시작하기'),
        h('a', { class: 'btn', href: me ? '#/write/job' : '#/jobs' }, me ? '프로젝트 모집하기' : '합작 찾아보기 →'),
        h('button', { class: 'btn ghost', type: 'button', onclick: randomPick, title: '아무 글이나 하나 열어 줘요' }, '🎲 랜덤 추천')
      )
    ),
    h(
      'div',
      { class: 'statbar', role: 'group', 'aria-label': '이음크루 현황' },
      stat(d.stats.members, '멤버', '#/members'),
      stat(d.stats.songs, '노래', typeLink('song')),
      stat(d.stats.infos, '정보·팁', typeLink('info')),
      stat(d.stats.qnas, '질문', typeLink('qna')),
      stat(d.stats.open_jobs, '모집 중', typeLink('job'))
    ),
    d.talk.length
      ? h('section', { class: 'section' }, head('💬 지금 이야기 중', '요즘 댓글이 오가는 글', null), cards(d.talk, '', { showType: true }))
      : null,
    h('section', { class: 'section' }, head('둘러보기', '', null), tabRow, panel),
    h(
      'section',
      { class: 'section' },
      head('🔥 지금 모집 중인 합작', '새로운 프로젝트에 참여해 보세요.', typeLink('job'), '전체 보기 →'),
      d.job.length
        ? h('div', { class: 'projects' }, d.job.slice(0, 3).map(projectCard))
        : emptyState({ icon: '🤝', title: '모집 중인 글이 아직 없어요', desc: '함께하고 싶은 프로젝트가 있다면 먼저 모집해 보세요.', actions: [h('a', { class: 'btn primary sm', href: me ? '#/write/job' : '#/signup' }, me ? '모집 글 쓰기' : '가입하고 모집하기')] })
    ),
    h(
      'section',
      { class: 'section' },
      head('🎧 최근 작업물', '이음크루에서 올라온 새로운 음악들', typeLink('song'), '더 보기 →'),
      d.song.length
        ? h('div', { class: 'works' }, d.song.slice(0, 4).map(workCard))
        : emptyState({ icon: '🎧', title: '첫 곡을 기다리고 있어요', desc: '만든 노래의 링크를 올려서 이음크루의 첫 작업물이 되어 보세요.', actions: [h('a', { class: 'btn primary sm', href: me ? '#/write/song' : '#/signup' }, me ? '노래 올리기' : '가입하고 올리기')] })
    ),
    h(
      'section',
      { class: 'section' },
      head('정보·팁', '', typeLink('info'), '더 보기 →'),
      cards(d.info.slice(0, 4), '첫 글을 기다리고 있어요!')
    ),
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', null, '이음크루에서 할 수 있는 것')),
      h('div', { class: 'features' }, FEATURES.map(([ic, t, p]) => h('article', { class: 'feature' }, h('div', { class: 'ficon', 'aria-hidden': 'true' }, ic), h('h3', null, t), h('p', { class: 'muted small' }, p))))
    )
  );
}

/* ───────── 목록 ───────── */
async function pageList(type, query) {
  const T = TYPES[type];
  const params = new URLSearchParams({ type });
  for (const k of ['q', 'tag', 'kind', 'category', 'role', 'sort', 'page', 'open']) if (query.get(k)) params.set(k, query.get(k));
  const d = await api('GET', '/api/posts?' + params);

  const nav = (patch) => {
    const n = new URLSearchParams(query);
    for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
    if (!('page' in patch)) n.delete('page');
    const s = n.toString();
    go(typeLink(type, s ? '?' + s : ''));
  };

  const search = h('input', { type: 'search', placeholder: `${T.label} 검색`, value: query.get('q') || '', maxlength: 50, 'aria-label': '검색' });
  const filters = [
    h(
      'form',
      { class: 'row', onsubmit: (e) => (e.preventDefault(), nav({ q: search.value.trim() })) },
      h('div', { class: 'grow' }, search),
      h('button', { class: 'btn', type: 'submit' }, '검색')
    ),
  ];

  const chipRow = (label, key, options) =>
    h(
      'div',
      { class: 'chips scroll', role: 'group', 'aria-label': label },
      h('button', { class: 'chip btnlike' + (!query.get(key) ? ' on' : ''), onclick: () => nav({ [key]: '' }) }, '전체'),
      options.map(([val, text]) => h('button', { class: 'chip btnlike' + (query.get(key) === val ? ' on' : ''), onclick: () => nav({ [key]: val }) }, text))
    );
  if (type === 'song') filters.push(chipRow('종류', 'kind', Object.entries(SONG_KINDS)));
  if (type === 'info') filters.push(chipRow('분류', 'category', INFO_CATEGORIES.map((c) => [c, c])));
  if (type === 'qna') {
    filters.push(chipRow('분류', 'category', INFO_CATEGORIES.map((c) => [c, c])));
    filters.push(
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: query.get('open') === '1', onchange: (e) => nav({ open: e.target.checked ? '1' : '' }) }),
        '아직 해결 안 된 질문만'
      )
    );
  }
  if (type === 'job') {
    filters.push(chipRow('구분', 'kind', Object.entries(JOB_KINDS)));
    filters.push(chipRow('분야', 'role', ROLES.map((r) => [r, r])));
    filters.push(
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: query.get('open') === '1', onchange: (e) => nav({ open: e.target.checked ? '1' : '' }) }),
        '모집 중인 글만'
      )
    );
  }
  const sort = h(
    'select',
    { 'aria-label': '정렬', value: query.get('sort') || '', onchange: (e) => nav({ sort: e.target.value }) },
    h('option', { value: '' }, '최신순'),
    h('option', { value: 'popular' }, '좋아요순'),
    h('option', { value: 'views' }, '조회순')
  );
  const tagNote = query.get('tag')
    ? h('div', { class: 'row' }, h('span', { class: 'chip acc' }, `#${query.get('tag')}`), h('button', { class: 'btn sm ghost', onclick: () => nav({ tag: '' }) }, '태그 해제'))
    : null;

  const pager =
    d.pages > 1
      ? h(
          'div',
          { class: 'pager' },
          h('button', { class: 'btn sm', disabled: d.page <= 1, onclick: () => nav({ page: String(d.page - 1) }) }, '이전'),
          h('span', { class: 'muted' }, `${d.page} / ${d.pages}`),
          h('button', { class: 'btn sm', disabled: d.page >= d.pages, onclick: () => nav({ page: String(d.page + 1) }) }, '다음')
        )
      : null;

  const writeHref = me ? `#/write/${type}` : '#/login?next=' + encodeURIComponent(`#/write/${type}`);
  const hasFilter = ['q', 'tag', 'kind', 'category', 'role', 'open'].some((k) => query.get(k));
  const emptyView = query.get('q')
    ? emptyState({
        icon: '🔍',
        title: `“${query.get('q')}”에 맞는 글이 없어요`,
        desc: '낱말을 줄이거나 다른 말로 찾아 보세요.',
        actions: [
          h('button', { class: 'btn sm', type: 'button', onclick: () => nav({ q: '' }) }, '검색어 지우기'),
          h('a', { class: 'btn sm', href: `#/search?q=${encodeURIComponent(query.get('q'))}` }, '전체에서 찾기'),
        ],
      })
    : hasFilter
    ? emptyState({ icon: '🗂️', title: '조건에 맞는 글이 없어요', desc: '필터를 바꾸거나 모두 해제해 보세요.', actions: [h('button', { class: 'btn sm', type: 'button', onclick: () => go(typeLink(type)) }, '필터 모두 해제')] })
    : emptyState({ icon: '✍️', title: `아직 ${T.label} 글이 없어요`, desc: '첫 글의 주인공이 되어 보세요!', actions: [h('a', { class: 'btn primary sm', href: writeHref }, T.write)] });

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('h1', null, T.label), h('a', { class: 'btn primary', href: writeHref }, T.write)),
    type === 'job' ? h('div', { class: 'notice' }, '이 게시판은 무페이 합작 전용이에요. 크레딧 표기나 수익 배분 여부는 글에 꼭 적어 주세요.') : null,
    type === 'qna' ? h('p', { class: 'muted small' }, '작곡·조교·믹싱 등 궁금한 걸 물어보고, 아는 건 댓글로 같이 답해 주세요. 질문자는 해결되면 "해결됨"으로 표시할 수 있어요.') : null,
    h('div', { class: 'filters' }, filters, tagNote, h('div', { class: 'row between' }, h('span', { class: 'muted small' }, `총 ${d.total}개`), sort)),
    query.get('q') ? h('p', { class: 'small' }, h('a', { href: `#/search?q=${encodeURIComponent(query.get('q'))}` }, '다른 게시판·멤버에서도 찾아보기 →')) : null,
    cards(d.items, emptyView),
    pager
  );
}

/* ───────── 상세 ───────── */
async function pagePost(id) {
  const { post: p } = await api('GET', `/api/posts/${id}`);
  const canEdit = me && (me.id === p.author.id || me.is_admin);
  const T = TYPES[p.type];

  const likeBtn = h('button', {
    class: 'btn sm' + (p.liked ? ' on' : ''),
    onclick: async () => {
      if (!me) {
        toast('로그인하면 좋아요를 누를 수 있어요.', 'info');
        return go('#/login?next=' + encodeURIComponent(`#/post/${id}`));
      }
      if (likeBtn.disabled) return;
      likeBtn.disabled = true;
      try {
        const r = await api('POST', `/api/posts/${id}/like`, {});
        likeBtn.className = 'btn sm' + (r.liked ? ' on' : '');
        likeBtn.textContent = `♥ ${r.like_count}`;
        toast(r.liked ? '좋아요를 눌렀어요.' : '좋아요를 취소했어요.');
      } catch (e) {
        toast(e.message, true);
      } finally {
        likeBtn.disabled = false;
      }
    },
  }, `♥ ${p.like_count}`);

  const tags = p.tags.length
    ? h('div', { class: 'chips' }, p.tags.map((t) => h('a', { class: 'chip', href: typeLink(p.type, `?tag=${encodeURIComponent(t)}`) }, `#${t}`)))
    : null;

  const details = [];
  let media = null;
  const kv = (pairs) => {
    const rows = pairs.filter(([, v]) => v);
    return rows.length ? h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null;
  };
  const linkEl = (u, text) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer nofollow' }, text || u);

  if (p.type === 'song') {
    const yid = ytId(p.url);
    media = yid
      ? h('div', { class: 'embed' }, h('iframe', { src: `https://www.youtube-nocookie.com/embed/${yid}`, title: p.title, allow: 'accelerometer; encrypted-media; picture-in-picture', allowfullscreen: true, loading: 'lazy' }))
      : h('a', { class: 'listen', href: p.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, h('span', { class: 'play', 'aria-hidden': 'true' }, '▶'), h('span', null, h('b', null, '노래 들으러 가기'), h('span', { class: 'small' }, new URL(p.url).hostname.replace(/^www\./, ''))));
    details.push(kv([['종류', SONG_KINDS[p.extra.kind]], ['보컬', p.extra.vocal], ['장르', p.extra.genre], ['링크', yid ? linkEl(p.url) : null]]));
  } else if (p.type === 'info') {
    details.push(kv([['분류', p.extra.category], ['참고 링크', p.url ? linkEl(p.url) : null]]));
  } else if (p.type === 'qna') {
    details.push(kv([['분류', p.extra.category], ['상태', p.closed ? '✔ 해결됨' : '답변 기다리는 중'], ['참고 링크', p.url ? linkEl(p.url) : null]]));
  } else {
    details.push(
      h('div', { class: 'notice' }, '무페이 합작 글이에요. 크레딧·수익 배분은 글쓴이와 직접 정해 주세요.'),
      kv([
        ['구분', JOB_KINDS[p.extra.kind]],
        ['분야', p.extra.role],
        ['상태', p.closed ? '마감' : '모집 중'],
        ['마감일', p.extra.deadline],
        ['크레딧', p.extra.credit],
        ['연락', p.extra.contact],
        ['참고 링크', p.url ? linkEl(p.url) : null],
      ])
    );
  }

  const actions = [likeBtn];
  if (canEdit) {
    if (p.type === 'job' || p.type === 'qna') {
      const isQ = p.type === 'qna';
      actions.push(
        h('button', {
          class: 'btn sm',
          onclick: (ev) =>
            withBusy(ev.currentTarget, '처리 중…', async () => {
              try {
                await api('PUT', `/api/posts/${id}`, { ...p, closed: !p.closed });
                toast(isQ ? (p.closed ? '해결 표시를 뺐어요.' : '해결됨으로 표시했어요.') : p.closed ? '다시 모집해요.' : '마감 처리했어요.');
                render();
              } catch (e) {
                toast(e.message, true);
              }
            }),
        }, isQ ? (p.closed ? '해결 취소' : '✔ 해결됨으로 표시') : p.closed ? '다시 열기' : '마감하기')
      );
    }
    actions.push(
      h('a', { class: 'btn sm', href: `#/edit/${id}` }, '수정'),
      h('button', {
        class: 'btn sm danger',
        onclick: (ev) => {
          if (!confirm('이 글을 삭제할까요? 되돌릴 수 없어요.')) return;
          return withBusy(ev.currentTarget, '삭제 중…', async () => {
            try {
              await api('DELETE', `/api/posts/${id}`);
              toast('삭제했어요.');
              go(typeLink(p.type));
            } catch (e) {
              toast(e.message, true);
            }
          });
        },
      }, '삭제')
    );
  }

  const commentsBox = h('div', { id: 'comments', 'aria-busy': 'true' }, skelComments());
  loadComments(id, commentsBox, p.type === 'qna');
  const gallery = p.images.length
    ? h(
        'div',
        { class: 'gallery' + (p.images.length === 1 ? ' one' : '') },
        p.images.map((iid) => h('a', { href: imgUrl(iid), target: '_blank', rel: 'noopener noreferrer', 'aria-label': '사진 크게 보기' }, h('img', { src: imgUrl(iid), alt: `${p.title} 사진`, loading: 'lazy' })))
      )
    : null;

  return h(
    'article',
    null,
    h('p', { class: 'small' }, h('a', { href: typeLink(p.type) }, `← ${T.label}`)),
    h(
      'div',
      { class: 'post-head' },
      h('h1', null, p.title),
      h(
        'div',
        { class: 'byline' },
        avatar(p.author.username, true),
        h('div', null, h('a', { class: 'name', href: `#/u/${encodeURIComponent(p.author.username)}` }, p.author.username), h('div', { class: 'sub' }, `${ago(p.created_at)} · 조회 ${p.views}`))
      )
    ),
    media,
    details,
    gallery,
    p.body ? h('div', { class: 'body' }, p.body) : null,
    tags ? h('div', { class: 'stack' }, h('div'), tags) : null,
    h('div', { class: 'row' }, actions),
    h('h2', { class: 'comments-title' }, p.type === 'qna' ? '답변' : '댓글', h('span', { id: 'c-count', class: 'count' })),
    commentsBox
  );
}

/* 댓글 입력 폼 (새 댓글 / 답글 공용). forceSecret: 비밀 댓글에 다는 답글은 항상 비밀 */
function commentForm({ postId, parentId = null, placeholder, forceSecret = false, initial = '', onDone, onCancel }) {
  const ta = h('textarea', { maxlength: 1000, placeholder, 'aria-label': parentId ? '답글' : '댓글', value: initial });
  const secret = h('input', { type: 'checkbox', checked: forceSecret, disabled: forceSecret });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary' + (parentId ? ' sm' : ''), type: 'submit' }, parentId ? '답글 쓰기' : '댓글 쓰기');
  return h(
    'form',
    {
      class: 'stack' + (parentId ? ' reply-form' : ''),
      onsubmit: (e) => {
        e.preventDefault();
        err.textContent = '';
        return withBusy(btn, '등록 중…', async () => {
          try {
            await api('POST', `/api/posts/${postId}/comments`, { body: ta.value, parent_id: parentId, secret: secret.checked });
            toast(parentId ? '답글을 남겼어요.' : secret.checked ? '비밀 댓글을 남겼어요.' : '댓글을 남겼어요.');
            onDone();
          } catch (er) {
            err.textContent = er.message;
          }
        });
      },
    },
    ta,
    h('label', { class: 'check small' }, secret, forceSecret ? '🔒 비밀 댓글의 답글이라 비밀로 남아요' : '🔒 비밀 댓글 (글쓴이와 나만 볼 수 있어요)'),
    err,
    h('div', { class: 'row' }, btn, onCancel ? h('button', { class: 'btn sm ghost', type: 'button', onclick: onCancel }, '취소') : null)
  );
}

async function loadComments(postId, box, isQna = false) {
  try {
    const { comments } = await api('GET', `/api/posts/${postId}/comments`);
    const reload = () => loadComments(postId, box, isQna);
    const replies = new Map();
    for (const c of comments) if (c.parent_id) (replies.get(c.parent_id) || replies.set(c.parent_id, []).get(c.parent_id)).push(c);
    const roots = comments.filter((c) => !c.parent_id || !comments.some((x) => x.id === c.parent_id));

    const renderOne = (c, root) => {
      const isReply = c !== root;
      const slot = h('div');
      const canReply = me && !c.hidden;
      const who = h(
        'div',
        { class: 'who row' },
        c.hidden ? h('span', null, ago(c.created_at)) : h('a', { href: `#/u/${encodeURIComponent(c.author.username)}` }, c.author.username),
        c.hidden ? null : h('span', null, ago(c.created_at)),
        c.secret ? h('span', { class: 'chip warn' }, '🔒 비밀') : null,
        canReply
          ? h('button', {
              class: 'btn sm ghost',
              onclick: () =>
                slot.firstChild
                  ? slot.replaceChildren()
                  : slot.replaceChildren(
                      commentForm({
                        postId,
                        parentId: c.id,
                        placeholder: '답글을 남겨 보세요',
                        forceSecret: root.secret,
                        initial: isReply ? `@${c.author.username} ` : '',
                        onDone: reload,
                        onCancel: () => slot.replaceChildren(),
                      })
                    ),
            }, '답글')
          : null,
        me && !c.hidden && (me.id === c.author.id || me.is_admin)
          ? h('button', {
              class: 'btn sm ghost danger',
              onclick: (ev) => {
                const hasReplies = !isReply && (replies.get(c.id) || []).length;
                if (!confirm(hasReplies ? '댓글을 삭제할까요? 달린 답글도 함께 지워져요.' : '삭제할까요?')) return;
                return withBusy(ev.currentTarget, '삭제 중…', async () => {
                  try {
                    await api('DELETE', `/api/comments/${c.id}`);
                    toast('삭제했어요.');
                    reload();
                  } catch (e) {
                    toast(e.message, true);
                  }
                });
              },
            }, '삭제')
          : null
      );
      return h(
        'div',
        { class: 'comment' + (isReply ? ' reply' : '') },
        who,
        c.hidden ? h('p', { class: 'muted secret-note' }, '🔒 비밀 댓글이에요. 글쓴이와 댓글 쓴 사람만 볼 수 있어요.') : h('p', null, c.body),
        slot
      );
    };

    const list = roots.map((root) => h('div', { class: 'thread' }, renderOne(root, root), (replies.get(root.id) || []).map((r) => renderOne(r, root))));
    const form = me
      ? commentForm({ postId, placeholder: isQna ? '답변이나 댓글을 남겨 보세요' : '댓글을 남겨 보세요', onDone: reload })
      : h('p', { class: 'muted' }, h('a', { href: '#/login?next=' + encodeURIComponent(`#/post/${postId}`) }, '로그인'), '하면 댓글을 쓸 수 있어요.');
    const empty = emptyState({ icon: '💬', title: isQna ? '아직 답변이 없어요' : '아직 댓글이 없어요', desc: isQna ? '아는 만큼 도와 주세요!' : '첫 댓글을 남겨 보세요.', compact: true });
    box.removeAttribute('aria-busy');
    box.replaceChildren(...(list.length ? list : [empty]), form);
    const count = document.getElementById('c-count');
    if (count) count.textContent = comments.length ? String(comments.length) : '';
  } catch (e) {
    box.removeAttribute('aria-busy');
    box.replaceChildren(
      emptyState({
        icon: '📡',
        title: (isQna ? '답변' : '댓글') + '을 불러오지 못했어요',
        desc: e.message,
        compact: true,
        actions: [h('button', { class: 'btn sm primary', type: 'button', onclick: () => ((box.innerHTML = ''), box.append(skelComments()), loadComments(postId, box, isQna)) }, '다시 불러오기')],
      })
    );
  }
}

/* ───────── 사진 올리기 ───────── */
/* 브라우저에서 긴 변 1280px 이하 JPEG로 줄인 뒤 올려요 (서버 저장 공간 절약 + 업로드 빠르게) */
async function shrinkImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('이 사진은 열 수 없어요. JPG, PNG, GIF, WebP 사진을 올려 주세요.');
  }
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 투명 PNG가 검게 나오지 않게
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bmp, 0, 0, w, hgt);
  if (bmp.close) bmp.close();
  let quality = 0.86;
  let data = canvas.toDataURL('image/jpeg', quality);
  while (data.length > 1.9 * 1024 * 1024 && quality > 0.45) {
    quality -= 0.1;
    data = canvas.toDataURL('image/jpeg', quality);
  }
  return data;
}

function imagePicker(initialIds = [], initialThumb = null) {
  let ids = [...initialIds];
  let thumb = ids.includes(initialThumb) ? initialThumb : ids[0] ?? null;
  let busy = 0;
  const tiles = h('div', { class: 'tiles' });
  const msg = h('div', { class: 'hint' });
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr-only', 'aria-label': '사진 고르기' });
  const addBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => input.click() }, '+ 사진 추가');

  const draw = () => {
    if (!ids.includes(thumb)) thumb = ids[0] ?? null;
    tiles.replaceChildren(
      ...ids.map((id) =>
        h(
          'div',
          { class: 'tile' + (id === thumb ? ' is-thumb' : '') },
          h('img', { src: imgUrl(id), alt: '올린 사진' }),
          h(
            'div',
            { class: 'tile-btns' },
            h('button', { class: 'btn sm' + (id === thumb ? ' primary' : ''), type: 'button', onclick: () => ((thumb = id), draw()) }, id === thumb ? '✓ 대표' : '대표로'),
            h('button', { class: 'btn sm ghost danger', type: 'button', 'aria-label': '사진 빼기', onclick: () => ((ids = ids.filter((x) => x !== id)), draw()) }, '✕')
          )
        )
      ),
      ...(busy ? [h('div', { class: 'tile loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), '올리는 중…')] : [])
    );
    addBtn.disabled = ids.length + busy >= MAX_IMAGES;
    msg.textContent = ids.length
      ? '“대표”로 고른 사진이 목록 썸네일로 쓰여요. 글을 저장해야 사진이 반영돼요.'
      : '사진은 자동으로 줄여서 올려요. JPG·PNG·GIF·WebP 가능.';
  };

  input.addEventListener('change', async () => {
    const files = [...input.files].slice(0, MAX_IMAGES - ids.length - busy);
    input.value = '';
    if (!files.length) return toast(`사진은 최대 ${MAX_IMAGES}장까지예요.`, true);
    for (const file of files) {
      busy++;
      draw();
      try {
        const data = await shrinkImage(file);
        const r = await api('POST', '/api/images', { data });
        ids.push(r.id);
        if (thumb === null) thumb = r.id;
      } catch (e) {
        toast(e.message, true);
      } finally {
        busy--;
        draw();
      }
    }
  });
  draw();
  return {
    el: h('div', { class: 'img-picker' }, tiles, h('div', { class: 'row' }, addBtn, input), msg),
    value: () => ({ images: ids, thumb }),
    uploading: () => busy > 0,
  };
}

/* ───────── 글쓰기/수정 ───────── */
async function pageWrite(type, editId) {
  if (!me) return go('#/login?next=' + encodeURIComponent(location.hash));
  let post = { title: '', body: '', url: '', tags: [], extra: {}, closed: false };
  if (editId) {
    post = (await api('GET', `/api/posts/${editId}`)).post;
    type = post.type;
    if (!(me.id === post.author.id || me.is_admin)) throw Object.assign(new Error('이 글을 수정할 권한이 없어요.'), { status: 403 });
  }
  if (!TYPES[type]) throw Object.assign(new Error('없는 글 종류예요.'), { status: 404 });
  const ex = post.extra || {};

  const f = {};
  const field = (key, label, el, hint) => {
    f[key] = el;
    return h('div', { class: 'field' }, h('label', { for: 'f-' + key }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
  };
  const inp = (key, attrs) => h('input', { id: 'f-' + key, type: 'text', ...attrs });
  const sel = (key, options, value) =>
    h('select', { id: 'f-' + key, value }, options.map(([v, t]) => h('option', { value: v }, t)));

  const fields = [];
  fields.push(field('title', '제목', inp('title', { maxlength: 100, value: post.title, required: true })));

  if (type === 'song') {
    fields.push(
      field('url', '노래 링크', inp('url', { type: 'url', maxlength: 500, value: post.url, required: true, placeholder: 'https://youtu.be/…' }), '유튜브 링크는 바로 재생할 수 있게 보여 드려요. 그 밖의 사이트(니코동, 사운드클라우드 등)는 링크 버튼으로 보여요.'),
      field('kind', '종류', sel('kind', Object.entries(SONG_KINDS), ex.kind || 'original')),
      field('vocal', '보컬 (선택)', inp('vocal', { maxlength: 50, value: ex.vocal || '', placeholder: '예: 보컬로이드 이름, 가수 이름' })),
      field('genre', '장르 (선택)', inp('genre', { maxlength: 30, value: ex.genre || '' })),
      field('body', '소개 (선택)', h('textarea', { id: 'f-body', maxlength: 5000, value: post.body, placeholder: '곡 설명, 참여한 사람들(크레딧) 등' }))
    );
  } else if (type === 'info') {
    fields.push(
      field('category', '분류', sel('category', INFO_CATEGORIES.map((c) => [c, c]), ex.category || '기타')),
      field('body', '내용', h('textarea', { id: 'f-body', maxlength: 10000, value: post.body, required: true })),
      field('url', '참고 링크 (선택)', inp('url', { type: 'url', maxlength: 500, value: post.url }))
    );
  } else if (type === 'qna') {
    fields.push(
      field('category', '분류', sel('category', INFO_CATEGORIES.map((c) => [c, c]), ex.category || '기타')),
      field('body', '질문 내용', h('textarea', { id: 'f-body', maxlength: 10000, value: post.body, required: true, placeholder: '어떤 상황인지, 지금까지 해 본 것, 어떤 도움이 필요한지 적어 주세요. 사용하는 프로그램 이름도 있으면 좋아요.' })),
      field('url', '참고 링크 (선택)', inp('url', { type: 'url', maxlength: 500, value: post.url }), '막힌 부분을 보여 주는 영상·곡 링크 등')
    );
  } else {
    fields.push(
      h('div', { class: 'notice' }, '무페이 합작 전용 게시판이에요. 크레딧 표기와 수익 배분 여부를 꼭 적어 주세요.'),
      field('kind', '구분', sel('kind', Object.entries(JOB_KINDS), ex.kind || 'hire')),
      field('role', '분야', sel('role', ROLES.map((r) => [r, r]), ex.role || ROLES[0])),
      field('body', '상세 내용', h('textarea', { id: 'f-body', maxlength: 10000, value: post.body, required: true, placeholder: '어떤 작업인지, 일정, 원하는 분위기 등' })),
      field('credit', '크레딧/수익 안내 (선택)', inp('credit', { maxlength: 100, value: ex.credit || '', placeholder: '예: 영상 설명란에 크레딧 표기, 수익 없음' })),
      field('contact', '연락 방법', inp('contact', { maxlength: 200, value: ex.contact || '', required: true, placeholder: '디스코드 ID, 이메일, 오픈채팅 링크 등' }), '글은 누구나 볼 수 있으니 공개해도 괜찮은 연락처만 적어 주세요.'),
      field('deadline', '마감일 (선택)', h('input', { id: 'f-deadline', type: 'date', value: ex.deadline || '' })),
      field('url', '포트폴리오/참고 링크 (선택)', inp('url', { type: 'url', maxlength: 500, value: post.url }))
    );
    if (editId) {
      f.closed = h('input', { type: 'checkbox', id: 'f-closed', checked: post.closed });
      fields.push(h('label', { class: 'check', for: 'f-closed' }, f.closed, '마감 처리'));
    }
  }
  const picker = imagePicker(post.images || [], post.thumb);
  fields.push(field('tags', '태그 (선택)', inp('tags', { value: post.tags.join(', '), placeholder: '쉼표로 구분, 최대 5개' })));
  fields.push(h('div', { class: 'field' }, h('label', null, `사진 (선택, 최대 ${MAX_IMAGES}장)`), picker.el));

  const err = h('div', { class: 'err' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, editId ? '저장' : '올리기');
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        err.textContent = '';
        if (picker.uploading()) {
          err.textContent = '사진을 올리는 중이에요. 잠깐만 기다려 주세요.';
          return;
        }
        const val = (k) => (f[k] ? f[k].value : '');
        const extra =
          type === 'song'
            ? { kind: val('kind'), vocal: val('vocal'), genre: val('genre') }
            : type === 'info' || type === 'qna'
            ? { category: val('category') }
            : { kind: val('kind'), role: val('role'), contact: val('contact'), credit: val('credit'), deadline: val('deadline') };
        const pics = picker.value();
        const payload = {
          type,
          title: val('title'),
          body: val('body'),
          url: val('url'),
          tags: val('tags'),
          extra,
          images: pics.images,
          thumb: pics.thumb,
          closed: f.closed ? f.closed.checked : !!(editId && type === 'qna' && post.closed),
        };
        return withBusy(submit, editId ? '저장 중…' : '올리는 중…', async () => {
          try {
            const r = editId ? await api('PUT', `/api/posts/${editId}`, payload) : await api('POST', '/api/posts', payload);
            toast(editId ? '저장했어요.' : '올렸어요!');
            go(`#/post/${editId || r.id}`);
          } catch (er) {
            err.textContent = er.message;
            toast(er.message, true);
          }
        });
      },
    },
    fields,
    err,
    h('div', { class: 'row' }, submit, h('a', { class: 'btn ghost', href: editId ? `#/post/${editId}` : typeLink(type) }, '취소'))
  );
  return h('div', null, h('h1', null, editId ? '글 수정' : TYPES[type].write), form);
}

/* ───────── 로그인/가입 ───────── */
function pageAuth(mode, query) {
  const isSignup = mode === 'signup';
  const next = query.get('next') && query.get('next').startsWith('#/') ? query.get('next') : '#/';
  const name = h('input', { type: 'text', id: 'a-name', autocomplete: 'username', maxlength: 20, required: true });
  const pw = h('input', { type: 'password', id: 'a-pw', autocomplete: isSignup ? 'new-password' : 'current-password', maxlength: 100, required: true });
  const err = h('div', { class: 'err' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, isSignup ? '가입하기' : '로그인');
  return h(
    'div',
    { class: 'narrow' },
    h('h1', null, isSignup ? '가입하기' : '로그인'),
    h(
      'form',
      {
        class: 'form',
        onsubmit: (e) => {
          e.preventDefault();
          err.textContent = '';
          return withBusy(btn, isSignup ? '가입하는 중…' : '로그인하는 중…', async () => {
            try {
              const r = await api('POST', isSignup ? '/api/signup' : '/api/login', { username: name.value, password: pw.value });
              me = r.user;
              toast(isSignup ? '환영해요!' : '반가워요!');
              go(next);
            } catch (er) {
              err.textContent = er.message;
            }
          });
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'a-name' }, '닉네임'), name, isSignup ? h('div', { class: 'hint' }, '2~20자, 한글·영문·숫자·_ . - 사용 가능') : null),
      h('div', { class: 'field' }, h('label', { for: 'a-pw' }, '비밀번호'), pw, isSignup ? h('div', { class: 'hint' }, '8자 이상') : null),
      err,
      btn
    ),
    h('p', { class: 'muted center' }, isSignup ? '이미 계정이 있나요? ' : '처음이세요? ', h('a', { href: isSignup ? '#/login' : '#/signup' }, isSignup ? '로그인' : '가입하기'))
  );
}

/* ───────── 프로필 ───────── */
const avatar = (name, small) => h('div', { class: 'avatar' + (small ? ' sm' : '') }, [...name][0].toUpperCase());

async function pageProfile(username) {
  const { user: u, posts } = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  const mine = me && me.id === u.id;
  const songs = posts.filter((p) => p.type === 'song');
  const others = posts.filter((p) => p.type !== 'song');
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'profile-head' },
      avatar(u.username),
      h(
        'div',
        { class: 'grow' },
        h('h1', null, u.username, u.is_admin ? h('span', { class: 'chip warn' }, '운영진') : null),
        h('div', { class: 'chips' }, u.open_to_work ? h('span', { class: 'chip pink' }, '합작 가능') : null, u.roles.map((r) => h('span', { class: 'chip acc' }, r))),
        h('div', { class: 'muted small' }, `${new Date(u.created_at).toLocaleDateString('ko-KR')} 가입`)
      ),
      mine ? h('a', { class: 'btn sm', href: '#/me' }, '프로필 수정') : null
    ),
    u.bio ? h('div', { class: 'body' }, u.bio) : h('p', { class: 'muted' }, mine ? '아직 소개가 없어요. 프로필 수정에서 소개를 적어 보세요.' : '아직 소개가 없어요.'),
    u.links.length
      ? h('ul', { class: 'link-list' }, u.links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, `↗ ${l.label}`))))
      : null,
    h(
      'section',
      { class: 'section' },
      h('h2', null, `포트폴리오 · 노래 ${songs.length}`),
      cards(songs, emptyState({ icon: '🎧', title: '아직 올린 노래가 없어요', desc: mine ? '만든 노래를 올리면 포트폴리오로 모여요.' : '', actions: mine ? [h('a', { class: 'btn primary sm', href: '#/write/song' }, '노래 올리기')] : [], compact: true }))
    ),
    h('section', { class: 'section' }, h('h2', null, '쓴 글'), cards(others, emptyState({ icon: '📝', title: '아직 쓴 글이 없어요', compact: true })))
  );
}

async function pageEditProfile() {
  if (!me) return go('#/login?next=' + encodeURIComponent('#/me'));
  const bio = h('textarea', { id: 'p-bio', maxlength: 500, value: me.bio, placeholder: '어떤 음악을 하는지, 어떤 합작을 하고 싶은지 적어 보세요.' });
  const roles = new Set(me.roles);
  const roleChips = ROLES.map((r) => {
    const b = h('button', { type: 'button', class: 'chip btnlike' + (roles.has(r) ? ' on' : ''), onclick: () => (roles.has(r) ? roles.delete(r) : roles.add(r), b.classList.toggle('on')) }, r);
    return b;
  });
  const open = h('input', { type: 'checkbox', id: 'p-open', checked: me.open_to_work });
  const linkBox = h('div');
  const addLinkRow = (l = { label: '', url: '' }) =>
    linkBox.append(
      h('div', { class: 'link-row' }, h('input', { type: 'text', maxlength: 20, placeholder: '이름 (예: 유튜브)', value: l.label, 'aria-label': '링크 이름' }), h('input', { type: 'url', maxlength: 500, placeholder: 'https://…', value: l.url, 'aria-label': '링크 주소' }))
    );
  (me.links.length ? me.links : [{ label: '', url: '' }]).forEach(addLinkRow);
  const err = h('div', { class: 'err' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, '저장');

  const pwCur = h('input', { type: 'password', id: 'pw-cur', autocomplete: 'current-password', maxlength: 100 });
  const pwNew = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password', maxlength: 100 });
  const pwErr = h('div', { class: 'err' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, '변경');

  return h(
    'div',
    null,
    h('h1', null, '프로필 수정'),
    h(
      'form',
      {
        class: 'form',
        onsubmit: (e) => {
          e.preventDefault();
          err.textContent = '';
          const links = [...linkBox.querySelectorAll('.link-row')]
            .map((row) => {
              const [a, b] = row.querySelectorAll('input');
              return { label: a.value, url: b.value };
            })
            .filter((l) => l.label.trim() || l.url.trim());
          return withBusy(save, '저장 중…', async () => {
            try {
              const r = await api('PUT', '/api/me', { bio: bio.value, roles: [...roles], links, open_to_work: open.checked });
              me = r.user;
              toast('저장했어요.');
              go(`#/u/${encodeURIComponent(me.username)}`);
            } catch (er) {
              err.textContent = er.message;
            }
          });
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'p-bio' }, '소개'), bio),
      h('div', { class: 'field' }, h('label', null, '하는 일'), h('div', { class: 'chips' }, roleChips)),
      h('label', { class: 'check field', for: 'p-open' }, open, '합작 제안을 받고 있어요 (멤버 목록에 먼저 보여요)'),
      h('div', { class: 'field' }, h('label', null, '링크 (최대 5개)'), linkBox, h('button', { type: 'button', class: 'btn sm', onclick: () => linkBox.querySelectorAll('.link-row').length < 5 && addLinkRow() }, '+ 링크 추가')),
      err,
      save
    ),
    h(
      'form',
      {
        class: 'form stack',
        onsubmit: (e) => {
          e.preventDefault();
          pwErr.textContent = '';
          return withBusy(pwBtn, '바꾸는 중…', async () => {
            try {
              await api('POST', '/api/me/password', { current: pwCur.value, next: pwNew.value });
              pwCur.value = pwNew.value = '';
              toast('비밀번호를 바꿨어요.');
            } catch (er) {
              pwErr.textContent = er.message;
            }
          });
        },
      },
      h('h2', null, '비밀번호 변경'),
      h('div', { class: 'field' }, h('label', { for: 'pw-cur' }, '현재 비밀번호'), pwCur),
      h('div', { class: 'field' }, h('label', { for: 'pw-new' }, '새 비밀번호 (8자 이상)'), pwNew),
      pwErr,
      pwBtn
    )
  );
}

/* ───────── 검색 ───────── */
function memberCard(m) {
  return h(
    'a',
    { class: 'card', href: `#/u/${encodeURIComponent(m.username)}` },
    h(
      'div',
      { class: 'member' },
      avatar(m.username, true),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'title' }, m.username),
        h('div', { class: 'chips' }, m.open_to_work ? h('span', { class: 'chip pink' }, '합작 가능') : null, m.roles.map((r) => h('span', { class: 'chip acc' }, r))),
        h('div', { class: 'meta' }, h('span', null, `노래 ${m.song_count}`), m.bio ? h('span', null, m.bio.slice(0, 40) + (m.bio.length > 40 ? '…' : '')) : null)
      )
    )
  );
}

async function pageSearch(query) {
  const text = (query.get('q') || '').trim();
  const type = query.get('type') || ''; // '' = 전체, song/info/job/qna/members
  const nav = (patch) => {
    const n = new URLSearchParams(query);
    for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
    if (!('page' in patch)) n.delete('page');
    go('#/search?' + n.toString());
  };
  const input = h('input', { type: 'search', placeholder: '제목, 내용, 태그, 닉네임, 보컬로이드 이름…', value: text, maxlength: 50, 'aria-label': '검색어' });
  const form = h(
    'form',
    { class: 'row', onsubmit: (e) => (e.preventDefault(), go('#/search' + (input.value.trim() ? `?q=${encodeURIComponent(input.value.trim())}` : ''))) },
    h('div', { class: 'grow' }, input),
    h('button', { class: 'btn primary', type: 'submit' }, '검색')
  );
  const head = h('div', null, h('h1', null, '검색'), form);
  if (!text) {
    setTimeout(() => input.focus(), 0);
    return h(
      'div',
      null,
      head,
      emptyState({
        icon: '🔍',
        title: '무엇을 찾고 있나요?',
        desc: '노래·정보·구인구직·질문과 멤버를 한 번에 찾아요. 낱말을 띄어 쓰면 모두 들어 있는 글만 나와요. (예: 조교 우타우)',
        actions: ['조교', '믹싱', '일러스트'].map((w) => h('a', { class: 'chip btnlike', href: `#/search?q=${encodeURIComponent(w)}` }, w)),
      })
    );
  }

  const postParams = new URLSearchParams({ q: text });
  if (type && type !== 'members') postParams.set('type', type);
  if (query.get('page')) postParams.set('page', query.get('page'));
  const [d, mem] = await Promise.all([api('GET', '/api/posts?' + postParams), api('GET', '/api/members?' + new URLSearchParams({ q: text }))]);
  const c = d.counts || { song: 0, info: 0, job: 0, qna: 0 };
  const all = c.song + c.info + c.job + c.qna;
  const tabs = [
    ['', '전체', all],
    ['song', '노래', c.song],
    ['info', '정보·팁', c.info],
    ['job', '구인구직', c.job],
    ['qna', '질문답변', c.qna],
    ['members', '멤버', mem.members.length],
  ];
  const tabRow = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': '검색 범위' },
    tabs.map(([val, label, n]) => h('button', { class: 'chip btnlike' + (type === val ? ' on' : ''), onclick: () => nav({ type: val }) }, `${label} ${n}`))
  );

  let body;
  if (type === 'members') {
    body = mem.members.length ? h('div', { class: 'cards' }, mem.members.map(memberCard)) : emptyState({ icon: '🙋', title: '맞는 멤버가 없어요', desc: '닉네임이나 하는 일로 다시 찾아 보세요.' });
  } else {
    const pager =
      d.pages > 1
        ? h(
            'div',
            { class: 'pager' },
            h('button', { class: 'btn sm', disabled: d.page <= 1, onclick: () => nav({ page: String(d.page - 1) }) }, '이전'),
            h('span', { class: 'muted' }, `${d.page} / ${d.pages}`),
            h('button', { class: 'btn sm', disabled: d.page >= d.pages, onclick: () => nav({ page: String(d.page + 1) }) }, '다음')
          )
        : null;
    body = h(
      'div',
      { class: 'stack' },
      cards(d.items, '', { showType: !type }),
      pager,
      !type && d.page === 1 && mem.members.length
        ? h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, `멤버 ${mem.members.length}`), h('a', { class: 'more', href: '#/search?' + new URLSearchParams({ q: text, type: 'members' }) }, '모두 보기 →')), h('div', { class: 'cards' }, mem.members.slice(0, 3).map(memberCard)))
        : null
    );
    if (!d.items.length && !(!type && mem.members.length)) {
      body = emptyState({
        icon: '🔍',
        title: `“${text}”에 맞는 결과가 없어요`,
        desc: '낱말을 줄이거나, 띄어쓰기를 빼고 다시 찾아 보세요.',
        actions: type ? [h('button', { class: 'btn sm', type: 'button', onclick: () => nav({ type: '' }) }, '전체에서 찾기')] : [],
      });
    } else if (!d.items.length) {
      body = h('div', { class: 'stack' }, emptyState({ icon: '🙋', title: '맞는 글은 없고, 멤버만 찾았어요', compact: true }), body);
    }
  }
  return h('div', null, head, h('div', { class: 'filters' }, tabRow), body);
}

/* ───────── 멤버 목록 ───────── */
async function pageMembers(query) {
  const params = new URLSearchParams();
  if (query.get('role')) params.set('role', query.get('role'));
  if (query.get('open')) params.set('open', '1');
  const { members } = await api('GET', '/api/members?' + params);
  const nav = (patch) => {
    const n = new URLSearchParams(query);
    for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
    const s = n.toString();
    go('#/members' + (s ? '?' + s : ''));
  };
  return h(
    'div',
    null,
    h('h1', null, '멤버'),
    h(
      'div',
      { class: 'filters' },
      h(
        'div',
        { class: 'chips scroll' },
        h('button', { class: 'chip btnlike' + (!query.get('role') ? ' on' : ''), onclick: () => nav({ role: '' }) }, '전체'),
        ROLES.map((r) => h('button', { class: 'chip btnlike' + (query.get('role') === r ? ' on' : ''), onclick: () => nav({ role: r }) }, r))
      ),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!query.get('open'), onchange: (e) => nav({ open: e.target.checked ? '1' : '' }) }), '합작 가능한 멤버만')
    ),
    members.length
      ? h(
          'div',
          { class: 'cards' },
          members.map(memberCard)
        )
      : emptyState({ icon: '🙋', title: '조건에 맞는 멤버가 없어요', desc: '하는 일이나 “합작 가능” 조건을 바꿔 보세요.', actions: [h('button', { class: 'btn sm', type: 'button', onclick: () => go('#/members') }, '필터 모두 해제')] })
  );
}

/* ───────── 라우터 ───────── */
function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const i = raw.indexOf('?');
  return { path: i < 0 ? raw : raw.slice(0, i), query: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
}

let renderSeq = 0;
let showingNetError = false; // 연결이 돌아오면 자동으로 다시 불러오기 위해 기억해 둬요
async function render() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  closeMenu(false);
  renderHeader(path);
  const app = document.getElementById('app');
  beginLoading(path);
  showingNetError = false;
  let m;
  try {
    let node;
    if (path === '/') node = await pageHome();
    else if ((m = path.match(/^\/(songs|info|jobs|qna)$/))) node = await pageList(PATH_TO_TYPE[m[1]], query);
    else if ((m = path.match(/^\/post\/(\d+)$/))) node = await pagePost(m[1]);
    else if ((m = path.match(/^\/write\/(song|info|job|qna)$/))) node = await pageWrite(m[1], null);
    else if ((m = path.match(/^\/edit\/(\d+)$/))) node = await pageWrite(null, m[1]);
    else if (path === '/login') node = pageAuth('login', query);
    else if (path === '/signup') node = pageAuth('signup', query);
    else if (path === '/me') node = await pageEditProfile();
    else if (path === '/members') node = await pageMembers(query);
    else if (path === '/search') node = await pageSearch(query);
    else if ((m = path.match(/^\/u\/([^/]+)$/))) node = await pageProfile(decodeURIComponent(m[1]));
    else node = errorView({ status: 404, message: '없는 주소예요. 주소가 맞는지 확인하거나 홈에서 다시 찾아 보세요.' });
    if (seq !== renderSeq) return; // 더 최근 이동이 있으면 무시
    endLoading();
    if (node) {
      app.replaceChildren(node);
      delete app.dataset.skel;
      window.scrollTo(0, 0);
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    endLoading();
    showingNetError = !!(e.network || e.timeout);
    app.replaceChildren(errorView(e));
    delete app.dataset.skel;
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('offline', () => toast('인터넷 연결이 끊겼어요.', true));
window.addEventListener('online', () => {
  toast('다시 연결됐어요.');
  if (showingNetError) render(); // 연결 오류 화면이었다면 자동으로 다시 불러와요
});
window.addEventListener('unhandledrejection', () => toast('문제가 생겼어요. 잠시 뒤에 다시 시도해 주세요.', true));
document.getElementById('skip').addEventListener('click', (e) => {
  e.preventDefault(); // 주소의 #app 이 화면 이동으로 오해되지 않게 직접 포커스만 옮겨요
  document.getElementById('app').focus();
});
if (window.eumTheme) window.eumTheme.apply(window.eumTheme.get()); // 글꼴·CSS가 로드된 뒤 주소창 색 맞추기
(async () => {
  // 서버가 잠들어 있으면 /api/me 응답이 오래 걸려요. 기다리는 동안 바로 뼈대 화면을 보여 줘요.
  const { path } = parseHash();
  renderHeader(path);
  beginLoading(path, true);
  try {
    me = (await api('GET', '/api/me')).user;
  } catch {}
  authReady = true;
  render();
})();
