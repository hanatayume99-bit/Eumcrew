'use strict';
/* 통합 테스트: 임시 DB로 서버를 띄우고 실제 HTTP 요청으로 주요 흐름을 확인합니다.  실행: node test.js */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eumcrew-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const { server, ready } = require('./server');

let base;
let passed = 0;
const failures = [];

function client() {
  let cookie = '';
  return async (method, url, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
}

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    failures.push(name);
    console.log('  ✗', name, '\n     ', e.message.split('\n').slice(0, 6).join(' | '));
  }
}

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const A = client(); // 첫 가입자 = 운영진
  const B = client();
  const anon = client();
  let songId, infoId, jobId, commentId;

  console.log('회원');
  await t('가입하면 로그인 상태가 되고, 첫 가입자는 운영진', async () => {
    const r = await A('POST', '/api/signup', { username: '시유팬', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.is_admin, true);
    const me = await A('GET', '/api/me');
    assert.equal(me.json.user.username, '시유팬');
  });
  await t('두 번째 가입자는 운영진이 아님', async () => {
    const r = await B('POST', '/api/signup', { username: 'composer_B', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.is_admin, false);
  });
  await t('닉네임 중복(대소문자 무시)은 409', async () => {
    const r = await anon('POST', '/api/signup', { username: 'COMPOSER_b', password: 'password123' });
    assert.equal(r.status, 409);
  });
  await t('짧은 비밀번호·이상한 닉네임은 400', async () => {
    assert.equal((await anon('POST', '/api/signup', { username: 'okname', password: 'short' })).status, 400);
    assert.equal((await anon('POST', '/api/signup', { username: '<script>', password: 'password123' })).status, 400);
  });
  await t('틀린 비밀번호는 401, 맞으면 로그인', async () => {
    const c = client();
    assert.equal((await c('POST', '/api/login', { username: '시유팬', password: 'wrong-password' })).status, 401);
    assert.equal((await c('POST', '/api/login', { username: '시유팬', password: 'password123' })).status, 200);
  });
  await t('비밀번호는 평문으로 저장되지 않음', async () => {
    const { q } = require('./server');
    const row = await q('SELECT pw_hash, pw_salt FROM users WHERE id = 1').get();
    assert.ok(row.pw_hash.length === 128 && !row.pw_hash.includes('password123'));
  });

  console.log('게시글');
  await t('로그인 없이 글쓰기는 401', async () => {
    const r = await anon('POST', '/api/posts', { type: 'info', title: 'x', body: 'y' });
    assert.equal(r.status, 401);
  });
  await t('노래 글 등록 (유튜브 링크)', async () => {
    const r = await A('POST', '/api/posts', {
      type: 'song',
      title: '첫 자작곡',
      url: 'https://youtu.be/dQw4w9WgXcQ',
      body: '믹싱 연습곡이에요',
      tags: '시유, 발라드, #보컬로이드',
      extra: { kind: 'original', vocal: '시유', genre: '발라드' },
    });
    assert.equal(r.status, 201);
    songId = r.json.id;
  });
  await t('javascript: 같은 위험한 링크는 거절', async () => {
    const r = await A('POST', '/api/posts', { type: 'song', title: 'x', url: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
  });
  await t('정보 글 등록 + 분류 검증', async () => {
    const ok = await B('POST', '/api/posts', { type: 'info', title: '믹싱 입문 팁', body: '컴프레서는 천천히', extra: { category: '믹싱/마스터링' }, tags: ['믹싱'] });
    assert.equal(ok.status, 201);
    infoId = ok.json.id;
    const badCat = await B('POST', '/api/posts', { type: 'info', title: 'x', body: 'y', extra: { category: '이상한분류' } });
    assert.equal(badCat.status, 400);
  });
  await t('구인 글 등록 (연락처 필수)', async () => {
    const missing = await B('POST', '/api/posts', { type: 'job', title: '일러스트 구해요', body: '상세', extra: { kind: 'hire', role: '일러스트' } });
    assert.equal(missing.status, 400);
    const ok = await B('POST', '/api/posts', {
      type: 'job',
      title: '일러스트 구해요',
      body: '앨범 아트 한 장 부탁드려요',
      extra: { kind: 'hire', role: '일러스트', contact: 'discord: composer_B', credit: '영상에 크레딧 표기', deadline: '2026-12-31' },
    });
    assert.equal(ok.status, 201);
    jobId = ok.json.id;
    const badDate = await B('POST', '/api/posts', { type: 'job', title: 't', body: 'b', extra: { kind: 'seek', role: '믹싱', contact: 'x', deadline: '내일' } });
    assert.equal(badDate.status, 400);
  });
  await t('태그는 최대 5개', async () => {
    const r = await A('POST', '/api/posts', { type: 'info', title: 't', body: 'b', tags: 'a,b,c,d,e,f' });
    assert.equal(r.status, 400);
  });

  console.log('목록·검색');
  await t('유형별 목록과 태그·종류 필터', async () => {
    assert.equal((await anon('GET', '/api/posts?type=song')).json.total, 1);
    const byTag = await anon('GET', '/api/posts?type=song&tag=' + encodeURIComponent('발라드'));
    assert.equal(byTag.json.items.length, 1);
    assert.deepEqual(byTag.json.items[0].tags, ['시유', '발라드', '보컬로이드']);
    assert.equal((await anon('GET', '/api/posts?type=song&kind=cover')).json.total, 0);
    assert.equal((await anon('GET', '/api/posts?type=job&kind=hire&open=1')).json.total, 1);
    assert.equal((await anon('GET', '/api/posts?type=job&role=' + encodeURIComponent('일러스트'))).json.total, 1);
  });
  await t('검색: 제목/본문 일치, %와 _ 는 문자 그대로 취급', async () => {
    assert.equal((await anon('GET', '/api/posts?q=' + encodeURIComponent('컴프레서'))).json.total, 1);
    assert.equal((await anon('GET', '/api/posts?q=%25')).json.total, 0);
    // '_'가 와일드카드였다면 글 3개가 전부 나왔을 거예요. 닉네임 composer_B 의 글 2개만 나오면 문자 그대로 찾은 것.
    assert.equal((await anon('GET', '/api/posts?q=_')).json.total, 2);
  });
  await t('잘못된 type은 400', async () => {
    assert.equal((await anon('GET', '/api/posts?type=hack')).status, 400);
  });
  await t('홈 요약', async () => {
    const r = await anon('GET', '/api/home');
    assert.equal(r.json.stats.members, 2);
    assert.equal(r.json.stats.songs, 1);
    assert.equal(r.json.stats.open_jobs, 1);
  });

  console.log('상세·좋아요·댓글');
  await t('조회수는 남이 볼 때만 증가', async () => {
    const before = (await anon('GET', `/api/posts/${songId}`)).json.post.views;
    const own = (await A('GET', `/api/posts/${songId}`)).json.post.views;
    assert.equal(own, before); // 글쓴이 본인 조회는 증가 없음
    const other = (await B('GET', `/api/posts/${songId}`)).json.post.views;
    assert.equal(other, before + 1);
  });
  await t('좋아요 토글', async () => {
    assert.equal((await anon('POST', `/api/posts/${songId}/like`, {})).status, 401);
    const on = await B('POST', `/api/posts/${songId}/like`, {});
    assert.deepEqual([on.json.liked, on.json.like_count], [true, 1]);
    assert.equal((await B('GET', `/api/posts/${songId}`)).json.post.liked, true);
    const off = await B('POST', `/api/posts/${songId}/like`, {});
    assert.deepEqual([off.json.liked, off.json.like_count], [false, 0]);
  });
  await t('댓글 작성·목록·권한', async () => {
    assert.equal((await anon('POST', `/api/posts/${songId}/comments`, { body: 'hi' })).status, 401);
    assert.equal((await B('POST', `/api/posts/${songId}/comments`, { body: '   ' })).status, 400);
    const c = await B('POST', `/api/posts/${songId}/comments`, { body: '<b>좋은 곡이에요</b>' });
    assert.equal(c.status, 201);
    commentId = c.json.id;
    const list = await anon('GET', `/api/posts/${songId}/comments`);
    assert.equal(list.json.comments[0].body, '<b>좋은 곡이에요</b>'); // 서버는 원문 그대로, 화면에서 textContent로 표시
    const third = client();
    await third('POST', '/api/signup', { username: 'third', password: 'password123' });
    assert.equal((await third('DELETE', `/api/comments/${commentId}`)).status, 403);
  });

  console.log('수정·삭제 권한');
  await t('남의 글 수정/삭제는 403, 본인은 가능', async () => {
    const edit = { type: 'info', title: '수정됨', body: '새 내용', extra: { category: '기타' } };
    assert.equal((await B('PUT', `/api/posts/${songId}`, { ...edit, url: 'https://youtu.be/dQw4w9WgXcQ' })).status, 403);
    assert.equal((await B('DELETE', `/api/posts/${songId}`)).status, 403);
    const ok = await B('PUT', `/api/posts/${infoId}`, edit);
    assert.equal(ok.status, 200);
    assert.equal((await anon('GET', `/api/posts/${infoId}`)).json.post.title, '수정됨');
  });
  await t('구인 글 마감 처리 → 홈/모집중 필터에서 빠짐', async () => {
    const p = (await B('GET', `/api/posts/${jobId}`)).json.post;
    assert.equal((await B('PUT', `/api/posts/${jobId}`, { ...p, closed: true })).status, 200);
    assert.equal((await anon('GET', '/api/posts?type=job&open=1')).json.total, 0);
    assert.equal((await anon('GET', '/api/home')).json.stats.open_jobs, 0);
  });
  await t('운영진은 남의 댓글을 지울 수 있음', async () => {
    assert.equal((await A('DELETE', `/api/comments/${commentId}`)).status, 200);
    assert.equal((await anon('GET', `/api/posts/${songId}/comments`)).json.comments.length, 0);
  });

  console.log('프로필·멤버');
  await t('프로필 수정과 링크 검증', async () => {
    const bad = await B('PUT', '/api/me', { bio: 'x', roles: ['작곡'], links: [{ label: 'a', url: 'ftp://x' }] });
    assert.equal(bad.status, 400);
    const ok = await B('PUT', '/api/me', { bio: '작곡하는 사람', roles: ['작곡', '믹싱'], links: [{ label: '유튜브', url: 'https://youtube.com/@x' }], open_to_work: true });
    assert.equal(ok.status, 200);
    const prof = await anon('GET', '/api/users/' + encodeURIComponent('composer_B'));
    assert.deepEqual(prof.json.user.roles, ['작곡', '믹싱']);
    assert.equal(prof.json.user.open_to_work, true);
    assert.equal(prof.json.posts.length, 2);
    assert.equal(prof.json.user.pw_hash, undefined);
  });
  await t('멤버 목록 필터', async () => {
    assert.equal((await anon('GET', '/api/members?role=' + encodeURIComponent('믹싱'))).json.members.length, 1);
    assert.equal((await anon('GET', '/api/members?open=1')).json.members.length, 1);
    assert.equal((await anon('GET', '/api/members')).json.members.length, 3);
  });
  await t('비밀번호 변경 후 새 비밀번호로만 로그인', async () => {
    assert.equal((await B('POST', '/api/me/password', { current: 'nope-nope', next: 'newpassword1' })).status, 403);
    assert.equal((await B('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' })).status, 200);
    const c = client();
    assert.equal((await c('POST', '/api/login', { username: 'composer_B', password: 'password123' })).status, 401);
    assert.equal((await c('POST', '/api/login', { username: 'composer_B', password: 'newpassword1' })).status, 200);
  });

  console.log('보안·정적 파일');
  await t('다른 출처의 변경 요청은 403, JSON 아니면 415', async () => {
    const r = await A('POST', '/api/posts', { type: 'info', title: 't', body: 'b' }, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    const r2 = await A('POST', '/api/posts', 'type=info', { 'Content-Type': 'text/plain' });
    assert.equal(r2.status, 415);
  });
  await t('쿠키는 HttpOnly + SameSite', async () => {
    const r = await client()('POST', '/api/login', { username: '시유팬', password: 'password123' });
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
  });
  await t('보안 헤더(CSP 등)', async () => {
    const r = await anon('GET', '/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  await t('정적 파일 제공 + SPA 경로는 index.html', async () => {
    const home = await anon('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /이음크루/);
    assert.equal((await anon('GET', '/app.js')).status, 200);
    assert.equal((await anon('GET', '/style.css')).status, 200);
    assert.match((await anon('GET', '/post/1')).text, /<main id="app"/);
  });
  await t('경로 탐색(../)은 막힘', async () => {
    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json']) {
      const r = await anon('GET', p);
      assert.ok(![200].includes(r.status) || !r.text.includes('DatabaseSync'), `${p} 노출됨`);
    }
  });
  await t('없는 API는 404', async () => {
    assert.equal((await anon('GET', '/api/nothing')).status, 404);
    assert.equal((await anon('GET', '/api/posts/9999')).status, 404);
  });

  console.log('검색');
  await t('여러 낱말은 모두 들어 있어야 하고, 태그·보컬·장르·닉네임도 찾음', async () => {
    assert.equal((await anon('GET', '/api/posts?q=' + encodeURIComponent('발라드 시유팬'))).json.total, 1); // 장르/태그 + 글쓴이
    assert.equal((await anon('GET', '/api/posts?q=' + encodeURIComponent('#보컬로이드'))).json.total, 1); // # 붙여도 OK
    assert.equal((await anon('GET', '/api/posts?q=' + encodeURIComponent('발라드 없는낱말'))).json.total, 0);
    assert.equal((await anon('GET', '/api/posts?q=' + encodeURIComponent('일러스트'))).json.total, 1); // 제목·분야
  });
  await t('검색 결과에 게시판별 개수가 같이 옴', async () => {
    const r = await anon('GET', '/api/posts?q=' + encodeURIComponent('일러스트'));
    assert.deepEqual(r.json.counts, { song: 0, info: 0, job: 1, qna: 0 });
    assert.equal((await anon('GET', '/api/posts?type=job&q=' + encodeURIComponent('일러스트'))).json.total, 1);
    assert.equal((await anon('GET', '/api/posts?type=song&q=' + encodeURIComponent('일러스트'))).json.total, 0);
  });
  await t('제목에 검색어가 들어간 글이 먼저', async () => {
    await A('POST', '/api/posts', { type: 'info', title: '잡담', body: '컴프레서 얘기를 해요', extra: { category: '기타' } });
    await A('POST', '/api/posts', { type: 'info', title: '컴프레서 가이드', body: '설명', extra: { category: '믹싱/마스터링' } });
    const r = await anon('GET', '/api/posts?q=' + encodeURIComponent('컴프레서'));
    assert.equal(r.json.items[0].title, '컴프레서 가이드');
    assert.equal(r.json.items.length, 2); // 제목에 있는 글 + 본문에만 있는 글
  });
  await t('멤버 검색 (닉네임·소개)', async () => {
    assert.equal((await anon('GET', '/api/members?q=' + encodeURIComponent('composer'))).json.members.length, 1);
    assert.equal((await anon('GET', '/api/members?q=' + encodeURIComponent('작곡하는'))).json.members.length, 1);
    assert.equal((await anon('GET', '/api/members?q=' + encodeURIComponent('없는사람'))).json.members.length, 0);
  });

  console.log('댓글 답글·비밀댓글');
  const C = client();
  await C('POST', '/api/signup', { username: 'stranger', password: 'password123' });
  await t('답글: 답글에 답해도 원댓글 아래로 붙고, 원댓글을 지우면 답글도 사라짐', async () => {
    const root = (await B('POST', `/api/posts/${songId}/comments`, { body: '원댓글' })).json.id;
    const r1 = (await C('POST', `/api/posts/${songId}/comments`, { body: '답글', parent_id: root })).json.id;
    const r2 = (await A('POST', `/api/posts/${songId}/comments`, { body: '답글의 답글', parent_id: r1 })).json.id;
    const list = (await anon('GET', `/api/posts/${songId}/comments`)).json.comments;
    assert.equal(list.find((c) => c.id === r1).parent_id, root);
    assert.equal(list.find((c) => c.id === r2).parent_id, root);
    assert.equal((await B('POST', `/api/posts/${songId}/comments`, { body: 'x', parent_id: 99999 })).status, 404);
    assert.equal((await B('DELETE', `/api/comments/${root}`)).status, 200);
    assert.equal((await anon('GET', `/api/posts/${songId}/comments`)).json.comments.length, 0);
  });
  await t('다른 글의 댓글에는 답글을 달 수 없음', async () => {
    const other = (await A('POST', '/api/posts', { type: 'info', title: '다른 글', body: 'b', extra: { category: '기타' } })).json.id;
    const c = (await B('POST', `/api/posts/${other}/comments`, { body: '여기 댓글' })).json.id;
    assert.equal((await B('POST', `/api/posts/${songId}/comments`, { body: '엉뚱한 답글', parent_id: c })).status, 404);
  });
  await t('비밀댓글: 남에게는 내용·작성자가 서버에서부터 안 내려감', async () => {
    const id = (await B('POST', `/api/posts/${songId}/comments`, { body: '비밀 내용입니다', secret: true })).json.id;
    for (const who of [anon, C]) {
      const c = (await who('GET', `/api/posts/${songId}/comments`)).json;
      const mine = c.comments.find((x) => x.id === id);
      assert.deepEqual([mine.secret, mine.hidden, mine.body, mine.author], [true, true, '', null]);
      assert.ok(!JSON.stringify(c).includes('비밀 내용입니다'));
    }
    for (const who of [B, A]) {
      // 쓴 사람, 글쓴이(=운영진) 는 볼 수 있음
      const mine = (await who('GET', `/api/posts/${songId}/comments`)).json.comments.find((x) => x.id === id);
      assert.deepEqual([mine.hidden, mine.body], [false, '비밀 내용입니다']);
    }
  });
  await t('비밀댓글에는 권한 있는 사람만 답글, 답글도 비밀로 고정', async () => {
    const list = (await A('GET', `/api/posts/${songId}/comments`)).json.comments;
    const secretId = list.find((c) => c.secret).id;
    assert.equal((await C('POST', `/api/posts/${songId}/comments`, { body: '엿보기', parent_id: secretId })).status, 403);
    const rep = await A('POST', `/api/posts/${songId}/comments`, { body: '글쓴이의 답', parent_id: secretId, secret: false });
    assert.equal(rep.status, 201);
    const asB = (await B('GET', `/api/posts/${songId}/comments`)).json.comments.find((c) => c.id === rep.json.id);
    assert.deepEqual([asB.secret, asB.hidden, asB.body], [true, false, '글쓴이의 답']); // 원댓글 쓴 사람은 읽음
    const asC = (await C('GET', `/api/posts/${songId}/comments`)).json.comments.find((c) => c.id === rep.json.id);
    assert.deepEqual([asC.hidden, asC.body], [true, '']);
  });
  await t('공개 댓글에 단 비밀 답글: 원댓글 쓴 사람은 보고, 제3자는 못 봄', async () => {
    const root = (await C('POST', `/api/posts/${songId}/comments`, { body: '공개 질문' })).json.id;
    const rep = (await B('POST', `/api/posts/${songId}/comments`, { body: '귓속말', parent_id: root, secret: true })).json.id;
    const asC = (await C('GET', `/api/posts/${songId}/comments`)).json.comments.find((c) => c.id === rep);
    assert.equal(asC.body, '귓속말'); // 원댓글 쓴 사람
    const asAnon = (await anon('GET', `/api/posts/${songId}/comments`)).json.comments.find((c) => c.id === rep);
    assert.equal(asAnon.hidden, true);
  });

  console.log('사진·대표 이미지');
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let img1, img2, imgPost;
  await t('사진 올리기: 로그인 필요, 이미지 파일만 허용', async () => {
    assert.equal((await anon('POST', '/api/images', { data: PNG })).status, 401);
    assert.equal((await B('POST', '/api/images', { data: Buffer.from('<script>alert(1)</script>').toString('base64') })).status, 400);
    assert.equal((await B('POST', '/api/images', { data: '' })).status, 400);
    const ok = await B('POST', '/api/images', { data: 'data:image/png;base64,' + PNG });
    assert.equal(ok.status, 201);
    img1 = ok.json.id;
    img2 = (await B('POST', '/api/images', { data: PNG })).json.id;
  });
  await t('올린 사진은 /img/번호 로 이미지로 보임 (형식은 파일 내용으로 판단)', async () => {
    const r = await anon('GET', `/img/${img1}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.match(r.headers.get('cache-control'), /max-age/);
    assert.equal((await anon('GET', '/img/999999')).status, 404);
  });
  await t('큰 사진은 거절', async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1.6 * 1024 * 1024)]);
    assert.equal((await B('POST', '/api/images', { data: big.toString('base64') })).status, 413);
  });
  await t('글에 사진을 붙이고 대표 이미지를 고름 (모든 글 종류)', async () => {
    const r = await B('POST', '/api/posts', { type: 'info', title: '사진 글', body: '본문', extra: { category: '기타' }, images: [img1, img2], thumb: img2 });
    assert.equal(r.status, 201);
    imgPost = r.json.id;
    const p = (await anon('GET', `/api/posts/${imgPost}`)).json.post;
    assert.deepEqual(p.images, [img1, img2]);
    assert.equal(p.thumb, img2);
    const inList = (await anon('GET', '/api/posts?type=info')).json.items.find((x) => x.id === imgPost);
    assert.equal(inList.thumb, img2); // 목록에도 썸네일이 내려옴
    const noThumb = (await B('POST', '/api/posts', { type: 'song', title: '곡', url: 'https://youtu.be/dQw4w9WgXcQ', images: [] })).json.id;
    assert.equal((await anon('GET', `/api/posts/${noThumb}`)).json.post.thumb, null);
  });
  await t('남이 올린 사진·이미 다른 글에 쓴 사진·7장 이상은 못 붙임', async () => {
    const mine = (await A('POST', '/api/images', { data: PNG })).json.id;
    assert.equal((await B('POST', '/api/posts', { type: 'info', title: 't', body: 'b', images: [mine] })).status, 400);
    assert.equal((await C('POST', '/api/posts', { type: 'info', title: 't', body: 'b', images: [img1] })).status, 400);
    assert.equal((await B('POST', '/api/posts', { type: 'info', title: 't', body: 'b', images: [1, 2, 3, 4, 5, 6, 7] })).status, 400);
    assert.equal((await B('POST', '/api/posts', { type: 'info', title: 't', body: 'b', images: ['x'] })).status, 400);
  });
  await t('수정: images를 안 보내면 유지, 빼면 사진도 삭제', async () => {
    const keep = await B('PUT', `/api/posts/${imgPost}`, { title: '사진 글 2', body: '본문', extra: { category: '기타' } });
    assert.equal(keep.status, 200);
    assert.deepEqual((await anon('GET', `/api/posts/${imgPost}`)).json.post.images, [img1, img2]);
    await B('PUT', `/api/posts/${imgPost}`, { title: '사진 글 2', body: '본문', extra: { category: '기타' }, images: [img1], thumb: 12345 });
    const p = (await anon('GET', `/api/posts/${imgPost}`)).json.post;
    assert.deepEqual([p.images, p.thumb], [[img1], img1]); // 엉뚱한 thumb이면 첫 사진
    assert.equal((await anon('GET', `/img/${img2}`)).status, 404);
  });
  await t('글을 지우면 사진도 함께 삭제', async () => {
    assert.equal((await B('DELETE', `/api/posts/${imgPost}`)).status, 200);
    assert.equal((await anon('GET', `/img/${img1}`)).status, 404);
  });

  console.log('질문답변·조교');
  let qnaId;
  await t('조교 분류로 정보 글 / 질문 글 등록', async () => {
    assert.equal((await A('POST', '/api/posts', { type: 'info', title: '조교 입문', body: '튜닝 팁', extra: { category: '조교' } })).status, 201);
    assert.equal((await A('POST', '/api/posts', { type: 'info', title: '편곡 팁', body: '팁', extra: { category: '편곡' } })).status, 201);
    const r = await C('POST', '/api/posts', { type: 'qna', title: '조교 어떻게 하나요?', body: '피치 곡선이 어색해요', extra: { category: '조교' }, tags: '우타우' });
    assert.equal(r.status, 201);
    qnaId = r.json.id;
    assert.equal((await C('POST', '/api/posts', { type: 'qna', title: 't', body: '' })).status, 400);
    assert.equal((await C('POST', '/api/posts', { type: 'qna', title: 't', body: 'b', extra: { category: '엉터리' } })).status, 400);
  });
  await t('질문은 질문답변 목록에만 나오고 정보·팁에는 안 섞임', async () => {
    const qna = (await anon('GET', '/api/posts?type=qna')).json;
    assert.deepEqual(qna.items.map((x) => x.id), [qnaId]);
    assert.equal(qna.items[0].type, 'qna');
    assert.ok(!(await anon('GET', '/api/posts?type=info')).json.items.some((x) => x.id === qnaId));
    assert.equal((await anon('GET', '/api/posts?type=qna&category=' + encodeURIComponent('조교'))).json.total, 1);
    assert.equal((await anon('GET', '/api/posts?type=info&category=' + encodeURIComponent('조교'))).json.total, 1); // 정보 글 1개만
    assert.equal((await anon('GET', `/api/posts/${qnaId}`)).json.post.type, 'qna');
    assert.equal((await anon('GET', '/api/home')).json.qna.length, 1);
  });
  await t('질문 해결됨 표시 → 미해결 필터에서 빠짐, 남은 못 바꿈', async () => {
    const p = (await C('GET', `/api/posts/${qnaId}`)).json.post;
    assert.equal((await B('PUT', `/api/posts/${qnaId}`, { ...p, closed: true })).status, 403);
    assert.equal((await C('PUT', `/api/posts/${qnaId}`, { ...p, closed: true })).status, 200);
    assert.equal((await anon('GET', '/api/posts?type=qna&open=1')).json.total, 0);
    const after = (await anon('GET', `/api/posts/${qnaId}`)).json.post;
    assert.equal(after.closed, true);
    assert.equal(after.type, 'qna'); // 수정해도 질문 글로 유지
  });
  await t('질문에도 답변(댓글)·검색·프로필 노출', async () => {
    assert.equal((await B('POST', `/api/posts/${qnaId}/comments`, { body: '피치를 직접 그려 보세요' })).status, 201);
    assert.equal((await anon('GET', '/api/posts?q=' + encodeURIComponent('우타우'))).json.counts.qna, 1);
    const prof = await anon('GET', '/api/users/stranger');
    assert.equal(prof.json.posts[0].type, 'qna');
  });

  console.log('홈 구성·랜덤 추천·웹앱');
  await t('홈: 현황 숫자와 인기/최신/답변 필요/지금 이야기 중 묶음', async () => {
    const h = (await anon('GET', '/api/home')).json;
    assert.deepEqual(Object.keys(h.stats).sort(), ['infos', 'members', 'open_jobs', 'qnas', 'songs']);
    assert.equal(h.stats.qnas, 1);
    assert.ok(h.stats.songs >= 1 && h.stats.members >= 4);
    for (const k of ['talk', 'popular', 'latest', 'needs']) assert.ok(Array.isArray(h[k]), k);
    assert.ok(h.latest.length > 0 && h.latest.length <= 6);
    // 지금 이야기 중: 방금 댓글이 달린 질문이 들어 있고, 최근 댓글 순
    assert.ok(h.talk.some((p) => p.id === qnaId));
    assert.ok(h.talk.length <= 4);
    // 마감된 구인글은 최신에서 빠짐
    assert.ok(!h.latest.some((p) => p.type === 'job' && p.closed));
  });
  await t('답변 필요: 해결 안 된 질문만, 댓글 적은 순', async () => {
    assert.equal((await anon('GET', '/api/home')).json.needs.length, 0); // 위에서 해결됨 처리했으니 0
    const open1 = (await C('POST', '/api/posts', { type: 'qna', title: '아직 해결 전', body: '도와 주세요', extra: { category: '믹싱/마스터링' } })).json.id;
    const open2 = (await C('POST', '/api/posts', { type: 'qna', title: '댓글 있는 질문', body: '도와 주세요', extra: { category: '기타' } })).json.id;
    await B('POST', `/api/posts/${open2}/comments`, { body: '답변' });
    const needs = (await anon('GET', '/api/home')).json.needs.map((p) => p.id);
    assert.deepEqual(needs, [open1, open2]); // 댓글 0개인 질문이 먼저
  });
  await t('인기: 좋아요 많은 글이 앞', async () => {
    const pop = (await anon('GET', '/api/home')).json.popular;
    assert.ok(pop.length > 0);
    for (let i = 1; i < pop.length; i++) assert.ok(pop[i - 1].like_count >= pop[i].like_count);
  });
  await t('랜덤 추천: 글 하나를 돌려주고, 종류 지정 가능', async () => {
    const r = await anon('GET', '/api/random');
    assert.equal(r.status, 200);
    assert.ok((await anon('GET', `/api/posts/${r.json.id}`)).json.post);
    const q2 = await anon('GET', '/api/random?type=qna');
    assert.equal((await anon('GET', `/api/posts/${q2.json.id}`)).json.post.type, 'qna');
    assert.equal((await anon('GET', '/api/random?type=hack')).status, 400);
  });
  await t('웹앱 설치 파일: manifest·아이콘·테마 스크립트가 올바른 형식으로 제공됨', async () => {
    const m = await anon('GET', '/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type'), /application\/manifest\+json/);
    const man = JSON.parse(m.text);
    assert.equal(man.display, 'standalone');
    for (const icon of man.icons) assert.equal((await anon('GET', icon.src)).status, 200, icon.src);
    assert.equal((await anon('GET', '/theme.js')).status, 200);
    assert.match((await anon('GET', '/')).text, /rel="manifest"/);
  });

  console.log('삭제·로그아웃');
  await t('글 삭제 시 댓글·좋아요도 함께 삭제', async () => {
    await B('POST', `/api/posts/${infoId}/comments`, { body: '자기 댓글' });
    await B('POST', `/api/posts/${infoId}/like`, {});
    assert.equal((await B('DELETE', `/api/posts/${infoId}`)).status, 200);
    const { q } = require('./server');
    assert.equal((await q('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(infoId)).n, 0);
    assert.equal((await q('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(infoId)).n, 0);
  });
  await t('로그아웃하면 세션이 무효화', async () => {
    assert.equal((await A('POST', '/api/logout', {})).status, 200);
    assert.equal((await A('GET', '/api/me')).json.user, null);
    assert.equal((await A('POST', '/api/posts', { type: 'info', title: 't', body: 'b' })).status, 401);
  });

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed}개 통과, ${failures.length}개 실패`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
