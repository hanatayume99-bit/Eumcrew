'use strict';
/* 음크루 프론트엔드 — 해시 라우팅 SPA, 외부 라이브러리 없음.
   사용자 입력은 항상 textContent로만 넣어서 XSS를 막습니다. */

const TYPES = {
  song: { path: 'songs', label: '노래', icon: '♪', write: '노래 올리기' },
  info: { path: 'info', label: '정보·팁', icon: '✦', write: '정보 쓰기' },
  job: { path: 'jobs', label: '구인구직', icon: '☺', write: '구인·구직 글쓰기' },
};
const PATH_TO_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [v.path, t]));
const SONG_KINDS = { original: '자작곡', cover: '커버', collab: '합작', remix: '리믹스' };
const JOB_KINDS = { hire: '구인', seek: '구직' };
const INFO_CATEGORIES = ['작곡', '작사', '믹싱/마스터링', '보컬', '일러스트', '영상', '합작/행사', '기타'];
const ROLES = ['작곡', '작사', '편곡', '믹싱', '마스터링', '보컬', '일러스트', '영상', '기타'];

let me = null;

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

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = new Error(data.error || '요청에 실패했어요.');
    e.status = res.status;
    throw e;
  }
  return data;
}

let toastTimer;
function toast(msg, isBad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isBad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2400);
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

/* ───────── 헤더 ───────── */
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

function renderHeader(path) {
  const top = document.getElementById('top');
  const cur = path.split('/')[1] || '';
  const tab = (href, label, on) => h('a', { class: 'tab', href, 'aria-selected': on ? 'true' : 'false' }, label);
  top.replaceChildren(
    h(
      'div',
      { class: 'bar' },
      h('a', { class: 'logo', href: '#/', 'aria-label': '이음크루 홈' }, logoSvg(), h('span', null, '이음', h('b', null, '크루'))),
      h('span', { class: 'spacer' }),
      me
        ? [
            h('a', { class: 'btn sm ghost', href: `#/u/${encodeURIComponent(me.username)}` }, me.username),
            h(
              'button',
              {
                class: 'btn sm ghost',
                onclick: async () => {
                  await api('POST', '/api/logout', {});
                  me = null;
                  toast('로그아웃했어요.');
                  go('#/');
                },
              },
              '로그아웃'
            ),
          ]
        : [h('a', { class: 'btn sm ghost', href: '#/login' }, '로그인'), h('a', { class: 'btn sm primary', href: '#/signup' }, '가입')]
    ),
    h(
      'nav',
      { class: 'tabs' },
      tab('#/', '홈', cur === ''),
      tab('#/songs', '노래', cur === 'songs'),
      tab('#/info', '정보·팁', cur === 'info'),
      tab('#/jobs', '구인구직', cur === 'jobs'),
      tab('#/members', '멤버', cur === 'members' || cur === 'u' || cur === 'me')
    )
  );
}

/* ───────── 카드 ───────── */
function postCard(p) {
  const meta = [h('span', null, p.author.username), h('span', null, ago(p.created_at))];
  if (p.like_count) meta.push(h('span', null, `♥ ${p.like_count}`));
  if (p.comment_count) meta.push(h('span', null, `💬 ${p.comment_count}`));
  const chips = [];
  if (p.type === 'song') {
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
  return h(
    'a',
    { class: 'card' + (p.closed ? ' closed' : ''), href: `#/post/${p.id}` },
    h('div', { class: 'title' }, p.title),
    h('div', { class: 'chips' }, chips),
    h('div', { class: 'meta' }, meta)
  );
}

const cards = (items, empty = '아직 글이 없어요.') =>
  items.length ? h('div', { class: 'cards' }, items.map(postCard)) : h('div', { class: 'empty' }, empty);

/* ───────── 홈 ───────── */
async function pageHome() {
  const d = await api('GET', '/api/home');
  const sec = (t) =>
    h(
      'section',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', null, TYPES[t].label), h('a', { class: 'btn sm', href: typeLink(t) }, '더 보기')),
      cards(d[t], t === 'job' ? '모집 중인 글이 아직 없어요.' : '첫 글을 기다리고 있어요!')
    );
  return h(
    'div',
    { class: 'stack' },
    h('div', null, h('h1', null, '같이 만들어요, 무페이 합작'), h('p', { class: 'muted' }, '자작곡과 커버를 나누고, 작업 팁을 모으고, 함께할 사람을 찾아요.')),
    h('p', { class: 'muted small' }, `멤버 ${d.stats.members} · 노래 ${d.stats.songs} · 모집 중 ${d.stats.open_jobs}`),
    h(
      'div',
      { class: 'row' },
      h('a', { class: 'btn primary', href: me ? '#/write/song' : '#/signup' }, me ? '노래 올리기' : '가입하고 시작하기'),
      h('a', { class: 'btn primary', href: me ? '#/write/job' : '#/signup' }, me ? '구인·구직 글쓰기' : '구인구직 보기')
    ),
    sec('song'),
    sec('job'),
    sec('info')
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
      { class: 'chips', role: 'group', 'aria-label': label },
      h('button', { class: 'chip btnlike' + (!query.get(key) ? ' on' : ''), onclick: () => nav({ [key]: '' }) }, '전체'),
      options.map(([val, text]) => h('button', { class: 'chip btnlike' + (query.get(key) === val ? ' on' : ''), onclick: () => nav({ [key]: val }) }, text))
    );
  if (type === 'song') filters.push(chipRow('종류', 'kind', Object.entries(SONG_KINDS)));
  if (type === 'info') filters.push(chipRow('분류', 'category', INFO_CATEGORIES.map((c) => [c, c])));
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

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'row between' },
      h('h1', null, T.label),
      h('a', { class: 'btn primary', href: me ? `#/write/${type}` : '#/login?next=' + encodeURIComponent(`#/write/${type}`) }, T.write)
    ),
    type === 'job' ? h('div', { class: 'notice' }, '이 게시판은 무페이 합작 전용이에요. 크레딧 표기나 수익 배분 여부는 글에 꼭 적어 주세요.') : null,
    h('div', { class: 'filters' }, filters, tagNote, h('div', { class: 'row between' }, h('span', { class: 'muted small' }, `총 ${d.total}개`), sort)),
    cards(d.items, '조건에 맞는 글이 없어요.'),
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
      if (!me) return go('#/login?next=' + encodeURIComponent(`#/post/${id}`));
      try {
        const r = await api('POST', `/api/posts/${id}/like`, {});
        likeBtn.className = 'btn sm' + (r.liked ? ' on' : '');
        likeBtn.textContent = `♥ ${r.like_count}`;
      } catch (e) {
        toast(e.message, true);
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
    if (p.type === 'job') {
      actions.push(
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            try {
              await api('PUT', `/api/posts/${id}`, { ...p, closed: !p.closed });
              toast(p.closed ? '다시 모집해요.' : '마감 처리했어요.');
              render();
            } catch (e) {
              toast(e.message, true);
            }
          },
        }, p.closed ? '다시 열기' : '마감하기')
      );
    }
    actions.push(
      h('a', { class: 'btn sm', href: `#/edit/${id}` }, '수정'),
      h('button', {
        class: 'btn sm danger',
        onclick: async () => {
          if (!confirm('이 글을 삭제할까요? 되돌릴 수 없어요.')) return;
          try {
            await api('DELETE', `/api/posts/${id}`);
            toast('삭제했어요.');
            go(typeLink(p.type));
          } catch (e) {
            toast(e.message, true);
          }
        },
      }, '삭제')
    );
  }

  const commentsBox = h('div', { id: 'comments' });
  loadComments(id, commentsBox);

  return h(
    'article',
    null,
    h('p', { class: 'small' }, h('a', { href: typeLink(p.type) }, `← ${T.label}`)),
    h(
      'div',
      { class: 'post-head' },
      h('h1', null, p.title),
      h('div', { class: 'row muted small' }, h('a', { href: `#/u/${encodeURIComponent(p.author.username)}` }, p.author.username), h('span', null, ago(p.created_at)), h('span', null, `조회 ${p.views}`))
    ),
    media,
    details,
    p.body ? h('div', { class: 'body' }, p.body) : null,
    tags ? h('div', { class: 'stack' }, h('div'), tags) : null,
    h('div', { class: 'row' }, actions),
    h('h2', { class: 'section-head' }, '댓글'),
    commentsBox
  );
}

async function loadComments(postId, box) {
  try {
    const { comments } = await api('GET', `/api/posts/${postId}/comments`);
    const list = comments.map((c) =>
      h(
        'div',
        { class: 'comment' },
        h('div', { class: 'who row' }, h('a', { href: `#/u/${encodeURIComponent(c.author.username)}` }, c.author.username), h('span', null, ago(c.created_at)),
          me && (me.id === c.author.id || me.is_admin)
            ? h('button', {
                class: 'btn sm ghost danger',
                onclick: async () => {
                  if (!confirm('댓글을 삭제할까요?')) return;
                  try {
                    await api('DELETE', `/api/comments/${c.id}`);
                    loadComments(postId, box);
                  } catch (e) {
                    toast(e.message, true);
                  }
                },
              }, '삭제')
            : null),
        h('p', null, c.body)
      )
    );
    const ta = h('textarea', { maxlength: 1000, placeholder: '댓글을 남겨 보세요', 'aria-label': '댓글' });
    const err = h('div', { class: 'err' });
    const form = me
      ? h(
          'form',
          {
            class: 'stack',
            onsubmit: async (e) => {
              e.preventDefault();
              err.textContent = '';
              try {
                await api('POST', `/api/posts/${postId}/comments`, { body: ta.value });
                loadComments(postId, box);
              } catch (er) {
                err.textContent = er.message;
              }
            },
          },
          ta,
          err,
          h('button', { class: 'btn primary', type: 'submit' }, '댓글 쓰기')
        )
      : h('p', { class: 'muted' }, h('a', { href: '#/login?next=' + encodeURIComponent(`#/post/${postId}`) }, '로그인'), '하면 댓글을 쓸 수 있어요.');
    box.replaceChildren(...(list.length ? list : [h('p', { class: 'muted' }, '첫 댓글을 남겨 보세요.')]), form);
  } catch (e) {
    box.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}

/* ───────── 글쓰기/수정 ───────── */
async function pageWrite(type, editId) {
  if (!me) return go('#/login?next=' + encodeURIComponent(location.hash));
  let post = { title: '', body: '', url: '', tags: [], extra: {}, closed: false };
  if (editId) {
    post = (await api('GET', `/api/posts/${editId}`)).post;
    type = post.type;
    if (!(me.id === post.author.id || me.is_admin)) throw new Error('수정 권한이 없어요.');
  }
  if (!TYPES[type]) throw new Error('없는 글 종류예요.');
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
  fields.push(field('tags', '태그 (선택)', inp('tags', { value: post.tags.join(', '), placeholder: '쉼표로 구분, 최대 5개' })));

  const err = h('div', { class: 'err' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, editId ? '저장' : '올리기');
  const form = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        const val = (k) => (f[k] ? f[k].value : '');
        const extra =
          type === 'song'
            ? { kind: val('kind'), vocal: val('vocal'), genre: val('genre') }
            : type === 'info'
            ? { category: val('category') }
            : { kind: val('kind'), role: val('role'), contact: val('contact'), credit: val('credit'), deadline: val('deadline') };
        const payload = { type, title: val('title'), body: val('body'), url: val('url'), tags: val('tags'), extra, closed: f.closed ? f.closed.checked : false };
        try {
          const r = editId ? await api('PUT', `/api/posts/${editId}`, payload) : await api('POST', '/api/posts', payload);
          toast(editId ? '저장했어요.' : '올렸어요!');
          go(`#/post/${editId || r.id}`);
        } catch (er) {
          err.textContent = er.message;
          submit.disabled = false;
        }
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
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          btn.disabled = true;
          try {
            const r = await api('POST', isSignup ? '/api/signup' : '/api/login', { username: name.value, password: pw.value });
            me = r.user;
            toast(isSignup ? '환영해요!' : '반가워요!');
            go(next);
          } catch (er) {
            err.textContent = er.message;
            btn.disabled = false;
          }
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
    u.bio ? h('div', { class: 'body' }, u.bio) : h('p', { class: 'muted' }, '아직 소개가 없어요.'),
    u.links.length
      ? h('ul', { class: 'link-list' }, u.links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, `↗ ${l.label}`))))
      : null,
    h('section', { class: 'section' }, h('h2', null, `포트폴리오 · 노래 ${songs.length}`), cards(songs, '아직 올린 노래가 없어요.')),
    h('section', { class: 'section' }, h('h2', null, '쓴 글'), cards(others, '아직 쓴 글이 없어요.'))
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

  return h(
    'div',
    null,
    h('h1', null, '프로필 수정'),
    h(
      'form',
      {
        class: 'form',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          save.disabled = true;
          const links = [...linkBox.querySelectorAll('.link-row')]
            .map((row) => {
              const [a, b] = row.querySelectorAll('input');
              return { label: a.value, url: b.value };
            })
            .filter((l) => l.label.trim() || l.url.trim());
          try {
            const r = await api('PUT', '/api/me', { bio: bio.value, roles: [...roles], links, open_to_work: open.checked });
            me = r.user;
            toast('저장했어요.');
            go(`#/u/${encodeURIComponent(me.username)}`);
          } catch (er) {
            err.textContent = er.message;
            save.disabled = false;
          }
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
        onsubmit: async (e) => {
          e.preventDefault();
          pwErr.textContent = '';
          try {
            await api('POST', '/api/me/password', { current: pwCur.value, next: pwNew.value });
            pwCur.value = pwNew.value = '';
            toast('비밀번호를 바꿨어요.');
          } catch (er) {
            pwErr.textContent = er.message;
          }
        },
      },
      h('h2', null, '비밀번호 변경'),
      h('div', { class: 'field' }, h('label', { for: 'pw-cur' }, '현재 비밀번호'), pwCur),
      h('div', { class: 'field' }, h('label', { for: 'pw-new' }, '새 비밀번호 (8자 이상)'), pwNew),
      pwErr,
      h('button', { class: 'btn', type: 'submit' }, '변경')
    )
  );
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
        { class: 'chips' },
        h('button', { class: 'chip btnlike' + (!query.get('role') ? ' on' : ''), onclick: () => nav({ role: '' }) }, '전체'),
        ROLES.map((r) => h('button', { class: 'chip btnlike' + (query.get('role') === r ? ' on' : ''), onclick: () => nav({ role: r }) }, r))
      ),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!query.get('open'), onchange: (e) => nav({ open: e.target.checked ? '1' : '' }) }), '합작 가능한 멤버만')
    ),
    members.length
      ? h(
          'div',
          { class: 'cards' },
          members.map((m) =>
            h(
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
            )
          )
        )
      : h('div', { class: 'empty' }, '조건에 맞는 멤버가 없어요.')
  );
}

/* ───────── 라우터 ───────── */
function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const i = raw.indexOf('?');
  return { path: i < 0 ? raw : raw.slice(0, i), query: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  renderHeader(path);
  const app = document.getElementById('app');
  let m;
  try {
    let node;
    if (path === '/') node = await pageHome();
    else if ((m = path.match(/^\/(songs|info|jobs)$/))) node = await pageList(PATH_TO_TYPE[m[1]], query);
    else if ((m = path.match(/^\/post\/(\d+)$/))) node = await pagePost(m[1]);
    else if ((m = path.match(/^\/write\/(song|info|job)$/))) node = await pageWrite(m[1], null);
    else if ((m = path.match(/^\/edit\/(\d+)$/))) node = await pageWrite(null, m[1]);
    else if (path === '/login') node = pageAuth('login', query);
    else if (path === '/signup') node = pageAuth('signup', query);
    else if (path === '/me') node = await pageEditProfile();
    else if (path === '/members') node = await pageMembers(query);
    else if ((m = path.match(/^\/u\/([^/]+)$/))) node = await pageProfile(decodeURIComponent(m[1]));
    else node = h('p', { class: 'muted center pad' }, '없는 페이지예요. ', h('a', { href: '#/' }, '홈으로'));
    if (seq !== renderSeq) return; // 더 최근 이동이 있으면 무시
    if (node) {
      app.replaceChildren(node);
      window.scrollTo(0, 0);
    }
  } catch (e) {
    if (seq !== renderSeq) return;
    app.replaceChildren(h('p', { class: 'center pad' }, e.status === 404 ? '찾을 수 없어요.' : e.message, ' ', h('a', { href: '#/' }, '홈으로')));
  }
}

window.addEventListener('hashchange', render);
(async () => {
  try {
    me = (await api('GET', '/api/me')).user;
  } catch {}
  render();
})();
