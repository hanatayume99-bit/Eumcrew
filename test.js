'use strict';
/* 통합 테스트: 임시 DB로 서버를 띄우고 실제 HTTP 요청으로 주요 흐름을 확인합니다.  실행: node test.js */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eumcrew-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
const { server } = require('./server');

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
    const { db } = require('./server');
    const row = db.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = 1').get();
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
    assert.equal((await anon('GET', '/api/posts?q=_')).json.total, 0);
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
    assert.match((await anon('GET', '/post/1')).text, /<main id="app">/);
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

  console.log('삭제·로그아웃');
  await t('글 삭제 시 댓글·좋아요도 함께 삭제', async () => {
    await B('POST', `/api/posts/${infoId}/comments`, { body: '자기 댓글' });
    await B('POST', `/api/posts/${infoId}/like`, {});
    assert.equal((await B('DELETE', `/api/posts/${infoId}`)).status, 200);
    const { db } = require('./server');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(infoId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(infoId).n, 0);
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
