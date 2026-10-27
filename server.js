'use strict';
/**
 * 이음크루 서버 — 외부 패키지 없이 Node 내장 기능만 사용 (Node 22.13+)
 *  - http: 서버 / @libsql/client: DB(Turso 또는 로컬 파일) / crypto: 비밀번호·세션
 * 실행: node server.js  (기본 http://localhost:3000)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');

const PORT = Number(process.env.PORT) || 3000;
// DB: TURSO_DATABASE_URL(+TURSO_AUTH_TOKEN)이 있으면 Turso(인터넷 DB), 없으면 로컬 파일(data.db)
const DB_URL = process.env.TURSO_DATABASE_URL || 'file:' + (process.env.DB_PATH || path.join(__dirname, 'data.db'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const PAGE_SIZE = 20;
const SESSION_DAYS = 30;

/* ───────────── DB ───────────── */
const db = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  roles TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  open_to_work INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('song','info','job')),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  extra TEXT NOT NULL DEFAULT '{}',
  views INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_type_created ON posts(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);
`;

/* await q(sql).get(...) / .all(...) / .run(...) — 모두 Promise를 돌려줘요 (await 필요) */
const q = (sql) => ({
  get: async (...args) => (await db.execute({ sql, args })).rows[0],
  all: async (...args) => [...(await db.execute({ sql, args })).rows],
  run: async (...args) => {
    const r = await db.execute({ sql, args });
    return { changes: r.rowsAffected, lastInsertRowid: r.lastInsertRowid };
  },
});
const ready = db.executeMultiple(SCHEMA);
const now = () => Date.now();

/* ───────────── 공통 유틸 ───────────── */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers['content-type'] || '';
    // 본문 없는 DELETE는 허용(브라우저가 Content-Type 없이 보냄). 그 외 변경 요청은 JSON만 받아서
    // 다른 사이트의 <form> 전송 같은 단순 요청을 막는다.
    const hasBody = req.headers['content-length'] > 0 || req.headers['transfer-encoding'];
    if (!(req.method === 'DELETE' && !hasBody) && !ctype.includes('application/json')) {
      return reject(new HttpError(415, 'JSON 요청만 받을 수 있어요.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '요청이 너무 커요.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(bad('잘못된 요청 형식이에요.'));
        resolve(v);
      } catch {
        reject(bad('JSON을 읽을 수 없어요.'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, salt, expectedHex) {
  const a = Buffer.from(hashPassword(pw, salt), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* 간단한 메모리 속도 제한 (IP + 구분키) */
const hits = new Map();
function rateLimit(req, bucket, max, windowMs) {
  // 배포(프록시 뒤)에서는 실제 방문자 IP가 X-Forwarded-For 첫 번째 값으로 와요.
  const fwd = SECURE_COOKIE ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || req.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`;
  const t = now();
  const rec = hits.get(key);
  if (!rec || t - rec.start > windowMs) {
    hits.set(key, { start: t, n: 1 });
    return;
  }
  rec.n += 1;
  if (rec.n > max) throw new HttpError(429, '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
}
setInterval(async () => {
  const t = now();
  for (const [k, v] of hits) if (t - v.start > 60 * 60 * 1000) hits.delete(k);
  try {
    await q('DELETE FROM sessions WHERE expires_at < ?').run(t);
  } catch (e) {
    console.error(e);
  }
}, 10 * 60 * 1000).unref();

/* ───────────── 입력 검증 ───────────── */
function str(v, field, { min = 0, max = 1000, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${field} 형식이 올바르지 않아요.`);
  v = v.replace(/\r\n/g, '\n').trim();
  if ((required || min > 0) && v.length < Math.max(min, 1)) throw bad(`${field}을(를) 입력해 주세요.`);
  if (v.length > max) throw bad(`${field}은(는) ${max}자 이하로 써 주세요.`);
  return v;
}

function cleanUrl(v, field, { required = false } = {}) {
  const s = str(v, field, { max: 500, required });
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${field}이(가) 올바른 주소가 아니에요.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad(`${field}은(는) http(s) 주소만 쓸 수 있어요.`);
  return u.toString();
}

function cleanTags(v) {
  if (v === undefined || v === null || v === '') return [];
  let arr = v;
  if (typeof v === 'string') arr = v.split(/[,#\n]/);
  if (!Array.isArray(arr)) throw bad('태그 형식이 올바르지 않아요.');
  const out = [];
  for (const t of arr) {
    if (typeof t !== 'string') continue;
    const s = t.replace(/["\\]/g, '').trim().slice(0, 20);
    if (s && !out.includes(s)) out.push(s);
  }
  if (out.length > 5) throw bad('태그는 최대 5개까지 달 수 있어요.');
  return out;
}

const SONG_KINDS = ['original', 'cover', 'collab', 'remix'];
const JOB_KINDS = ['hire', 'seek'];
const INFO_CATEGORIES = ['작곡', '작사', '믹싱/마스터링', '보컬', '일러스트', '영상', '합작/행사', '기타'];

function validatePost(type, b) {
  const post = { title: str(b.title, '제목', { required: true, max: 100 }), tags: cleanTags(b.tags) };
  const ex = b.extra && typeof b.extra === 'object' && !Array.isArray(b.extra) ? b.extra : {};
  if (type === 'song') {
    post.url = cleanUrl(b.url, '노래 링크', { required: true });
    post.body = str(b.body, '소개', { max: 5000 });
    const kind = ex.kind || 'original';
    if (!SONG_KINDS.includes(kind)) throw bad('노래 종류가 올바르지 않아요.');
    post.extra = { kind, vocal: str(ex.vocal, '보컬', { max: 50 }), genre: str(ex.genre, '장르', { max: 30 }) };
  } else if (type === 'info') {
    post.url = cleanUrl(b.url, '참고 링크');
    post.body = str(b.body, '내용', { required: true, max: 10000 });
    const category = ex.category || '기타';
    if (!INFO_CATEGORIES.includes(category)) throw bad('분류가 올바르지 않아요.');
    post.extra = { category };
  } else {
    post.url = cleanUrl(b.url, '참고 링크(포트폴리오 등)');
    post.body = str(b.body, '상세 내용', { required: true, max: 10000 });
    const kind = ex.kind;
    if (!JOB_KINDS.includes(kind)) throw bad('구인/구직 구분을 골라 주세요.');
    const deadline = str(ex.deadline, '마감일', { max: 10 });
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw bad('마감일은 YYYY-MM-DD 형식으로 써 주세요.');
    post.extra = {
      kind,
      role: str(ex.role, '분야', { required: true, max: 30 }),
      contact: str(ex.contact, '연락 방법', { required: true, max: 200 }),
      credit: str(ex.credit, '크레딧/수익 안내', { max: 100 }),
      deadline,
    };
  }
  return post;
}

/* ───────────── 직렬화 ───────────── */
const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    bio: u.bio,
    roles: parseJson(u.roles, []),
    links: parseJson(u.links, []),
    open_to_work: !!u.open_to_work,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  };
}

function postView(r) {
  return {
    id: Number(r.id),
    type: r.type,
    title: r.title,
    body: r.body,
    url: r.url,
    tags: parseJson(r.tags, []),
    extra: parseJson(r.extra, {}),
    views: r.views,
    closed: !!r.closed,
    created_at: r.created_at,
    updated_at: r.updated_at,
    author: { id: r.user_id, username: r.username },
    like_count: r.like_count,
    comment_count: r.comment_count,
    liked: !!r.liked,
  };
}

const POST_SELECT = `
  SELECT p.*, u.username,
    (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
    EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
  FROM posts p JOIN users u ON u.id = p.user_id`;

const escLike = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/* ───────────── 인증 ───────────── */
async function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = await q(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha256(token), now());
  return row || null;
}

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    now() + maxAge * 1000
  );
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}

const needLogin = (ctx) => {
  if (!ctx.user) throw new HttpError(401, '로그인이 필요해요.');
  return ctx.user;
};

/* ───────────── API 라우트 ───────────── */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/:([a-z]+)/gi, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '/?$'
  );
  routes.push({ method, re, keys, handler });
};

/* 회원 */
route('POST', '/api/signup', async (ctx) => {
  rateLimit(ctx.req, 'signup', 10, 60 * 60 * 1000);
  const username = str(ctx.body.username, '닉네임', { required: true, min: 2, max: 20 });
  if (!/^[0-9A-Za-z가-힣_.\-]+$/.test(username)) throw bad('닉네임은 한글, 영문, 숫자, _ . - 만 쓸 수 있어요.');
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  if (password.length < 8 || password.length > 100) throw bad('비밀번호는 8자 이상 100자 이하로 해 주세요.');
  if (await q('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, '이미 쓰고 있는 닉네임이에요.');
  const salt = crypto.randomBytes(16).toString('hex');
  const isFirst = (await q('SELECT COUNT(*) AS n FROM users').get()).n === 0;
  const info = await q(
    'INSERT INTO users (username, pw_salt, pw_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(username, salt, hashPassword(password, salt), isFirst ? 1 : 0, now());
  const id = Number(info.lastInsertRowid);
  const cookie = await startSession(ctx.res, id);
  return { status: 201, headers: { 'Set-Cookie': cookie }, data: { user: publicUser(await q('SELECT * FROM users WHERE id = ?').get(id)) } };
});

route('POST', '/api/login', async (ctx) => {
  rateLimit(ctx.req, 'login', 20, 10 * 60 * 1000);
  const username = typeof ctx.body.username === 'string' ? ctx.body.username.trim() : '';
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  const u = await q('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !verifyPassword(password, u.pw_salt, u.pw_hash)) throw new HttpError(401, '닉네임 또는 비밀번호가 맞지 않아요.');
  return { headers: { 'Set-Cookie': await startSession(ctx.res, u.id) }, data: { user: publicUser(u) } };
});

route('POST', '/api/logout', async (ctx) => {
  const token = parseCookies(ctx.req).sid;
  if (token) await q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  return {
    headers: { 'Set-Cookie': `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}` },
    data: { ok: true },
  };
});

route('GET', '/api/me', async (ctx) => ({ user: ctx.user ? publicUser(ctx.user) : null }));

route('PUT', '/api/me', async (ctx) => {
  const me = needLogin(ctx);
  const b = ctx.body;
  const bio = str(b.bio, '소개', { max: 500 });
  const rolesIn = Array.isArray(b.roles) ? b.roles : [];
  if (rolesIn.length > 8) throw bad('분야는 최대 8개까지 고를 수 있어요.');
  const roles = [...new Set(rolesIn.map((r) => str(r, '분야', { max: 12 })).filter(Boolean))];
  const linksIn = Array.isArray(b.links) ? b.links : [];
  if (linksIn.length > 5) throw bad('링크는 최대 5개까지 넣을 수 있어요.');
  const links = linksIn
    .filter((l) => l && (l.url || l.label))
    .map((l) => ({ label: str(l.label, '링크 이름', { max: 20 }) || '링크', url: cleanUrl(l.url, '링크 주소', { required: true }) }));
  await q('UPDATE users SET bio = ?, roles = ?, links = ?, open_to_work = ? WHERE id = ?').run(
    bio,
    JSON.stringify(roles),
    JSON.stringify(links),
    b.open_to_work ? 1 : 0,
    me.id
  );
  return { user: publicUser(await q('SELECT * FROM users WHERE id = ?').get(me.id)) };
});

route('POST', '/api/me/password', async (ctx) => {
  const me = needLogin(ctx);
  rateLimit(ctx.req, 'pw', 10, 10 * 60 * 1000);
  const cur = typeof ctx.body.current === 'string' ? ctx.body.current : '';
  const next = typeof ctx.body.next === 'string' ? ctx.body.next : '';
  if (!verifyPassword(cur, me.pw_salt, me.pw_hash)) throw new HttpError(403, '현재 비밀번호가 맞지 않아요.');
  if (next.length < 8 || next.length > 100) throw bad('새 비밀번호는 8자 이상 100자 이하로 해 주세요.');
  const salt = crypto.randomBytes(16).toString('hex');
  await q('UPDATE users SET pw_salt = ?, pw_hash = ? WHERE id = ?').run(salt, hashPassword(next, salt), me.id);
  const keep = parseCookies(ctx.req).sid;
  await q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(me.id, sha256(keep || ''));
  return { ok: true };
});

route('GET', '/api/users/:username', async (ctx) => {
  const u = await q('SELECT * FROM users WHERE username = ?').get(ctx.params.username);
  if (!u) throw new HttpError(404, '없는 사용자예요.');
  const rows = await q(`${POST_SELECT} WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 100`).all(ctx.user ? ctx.user.id : 0, u.id);
  return { user: publicUser(u), posts: rows.map(postView) };
});

route('GET', '/api/members', async (ctx) => {
  const where = [];
  const params = [];
  if (ctx.query.get('role')) {
    where.push(`u.roles LIKE ? ESCAPE '\\'`);
    params.push(`%"${escLike(ctx.query.get('role').replace(/["\\]/g, ''))}"%`);
  }
  if (ctx.query.get('open') === '1') where.push('u.open_to_work = 1');
  const rows = await q(
    `SELECT u.*, (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.type = 'song') AS song_count
     FROM users u ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY u.open_to_work DESC, song_count DESC, u.created_at DESC LIMIT 60`
  ).all(...params);
  return { members: rows.map((r) => ({ ...publicUser(r), song_count: r.song_count })) };
});

/* 게시글 */
route('GET', '/api/home', async (ctx) => {
  const uid = ctx.user ? ctx.user.id : 0;
  const out = {};
  for (const t of ['song', 'info', 'job']) {
    const where = t === 'job' ? `p.type = ? AND p.closed = 0` : `p.type = ?`;
    out[t] = (await q(`${POST_SELECT} WHERE ${where} ORDER BY p.created_at DESC LIMIT 5`).all(uid, t)).map(postView);
  }
  out.stats = {
    members: (await q('SELECT COUNT(*) AS n FROM users').get()).n,
    songs: (await q(`SELECT COUNT(*) AS n FROM posts WHERE type = 'song'`).get()).n,
    open_jobs: (await q(`SELECT COUNT(*) AS n FROM posts WHERE type = 'job' AND closed = 0`).get()).n,
  };
  return out;
});

route('GET', '/api/posts', async (ctx) => {
  const sp = ctx.query;
  const where = [];
  const params = [];
  const type = sp.get('type');
  if (type) {
    if (!['song', 'info', 'job'].includes(type)) throw bad('type이 올바르지 않아요.');
    where.push('p.type = ?');
    params.push(type);
  }
  const text = (sp.get('q') || '').trim().slice(0, 50);
  if (text) {
    where.push(`(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')`);
    params.push(`%${escLike(text)}%`, `%${escLike(text)}%`);
  }
  const tag = (sp.get('tag') || '').replace(/["\\]/g, '').trim().slice(0, 20);
  if (tag) {
    where.push(`p.tags LIKE ? ESCAPE '\\'`);
    params.push(`%"${escLike(tag)}"%`);
  }
  const kind = sp.get('kind');
  if (kind) {
    where.push(`json_extract(p.extra, '$.kind') = ?`);
    params.push(kind);
  }
  const cat = sp.get('category');
  if (cat) {
    where.push(`json_extract(p.extra, '$.category') = ?`);
    params.push(cat);
  }
  const role = (sp.get('role') || '').trim().slice(0, 30);
  if (role) {
    where.push(`json_extract(p.extra, '$.role') = ?`);
    params.push(role);
  }
  if (sp.get('open') === '1') where.push('p.closed = 0');
  const sort = sp.get('sort');
  const order =
    sort === 'popular' ? 'like_count DESC, p.created_at DESC' : sort === 'views' ? 'p.views DESC, p.created_at DESC' : 'p.created_at DESC';
  const page = Math.max(1, parseInt(sp.get('page'), 10) || 1);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await q(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`).get(...params)).n;
  const rows = await q(`${POST_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(
    ctx.user ? ctx.user.id : 0,
    ...params,
    PAGE_SIZE,
    (page - 1) * PAGE_SIZE
  );
  return { items: rows.map(postView), total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
});

route('GET', '/api/posts/:id', async (ctx) => {
  const id = parseInt(ctx.params.id, 10);
  const row = await q(`${POST_SELECT} WHERE p.id = ?`).get(ctx.user ? ctx.user.id : 0, id);
  if (!row) throw new HttpError(404, '글을 찾을 수 없어요.');
  if (!ctx.user || ctx.user.id !== row.user_id) await q('UPDATE posts SET views = views + 1 WHERE id = ?').run(id);
  const post = postView(row);
  if (!ctx.user || ctx.user.id !== row.user_id) post.views += 1;
  return { post };
});

route('POST', '/api/posts', async (ctx) => {
  const me = needLogin(ctx);
  rateLimit(ctx.req, 'post', 30, 60 * 60 * 1000);
  const type = ctx.body.type;
  if (!['song', 'info', 'job'].includes(type)) throw bad('글 종류가 올바르지 않아요.');
  const p = validatePost(type, ctx.body);
  const t = now();
  const info = await q(
    `INSERT INTO posts (type, user_id, title, body, url, tags, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(type, me.id, p.title, p.body, p.url, JSON.stringify(p.tags), JSON.stringify(p.extra), t, t);
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
});

route('PUT', '/api/posts/:id', async (ctx) => {
  const me = needLogin(ctx);
  const id = parseInt(ctx.params.id, 10);
  const row = await q('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '글을 찾을 수 없어요.');
  if (row.user_id !== me.id && !me.is_admin) throw new HttpError(403, '수정 권한이 없어요.');
  const p = validatePost(row.type, ctx.body);
  const closed = row.type === 'job' ? (ctx.body.closed ? 1 : 0) : 0;
  await q('UPDATE posts SET title=?, body=?, url=?, tags=?, extra=?, closed=?, updated_at=? WHERE id=?').run(
    p.title,
    p.body,
    p.url,
    JSON.stringify(p.tags),
    JSON.stringify(p.extra),
    closed,
    now(),
    id
  );
  return { id };
});

route('DELETE', '/api/posts/:id', async (ctx) => {
  const me = needLogin(ctx);
  const id = parseInt(ctx.params.id, 10);
  const row = await q('SELECT user_id FROM posts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '글을 찾을 수 없어요.');
  if (row.user_id !== me.id && !me.is_admin) throw new HttpError(403, '삭제 권한이 없어요.');
  await db.batch(
    [
      { sql: 'DELETE FROM comments WHERE post_id = ?', args: [id] },
      { sql: 'DELETE FROM likes WHERE post_id = ?', args: [id] },
      { sql: 'DELETE FROM posts WHERE id = ?', args: [id] },
    ],
    'write'
  );
  return { ok: true };
});

route('POST', '/api/posts/:id/like', async (ctx) => {
  const me = needLogin(ctx);
  const id = parseInt(ctx.params.id, 10);
  if (!await q('SELECT 1 FROM posts WHERE id = ?').get(id)) throw new HttpError(404, '글을 찾을 수 없어요.');
  const had = await q('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(id, me.id);
  if (had) await q('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(id, me.id);
  else await q('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').run(id, me.id);
  const n = (await q('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id)).n;
  return { liked: !had, like_count: n };
});

/* 댓글 */
route('GET', '/api/posts/:id/comments', async (ctx) => {
  const id = parseInt(ctx.params.id, 10);
  const rows = await q(
    `SELECT c.id, c.body, c.created_at, c.user_id, u.username
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 500`
  ).all(id);
  return { comments: rows.map((r) => ({ id: Number(r.id), body: r.body, created_at: r.created_at, author: { id: r.user_id, username: r.username } })) };
});

route('POST', '/api/posts/:id/comments', async (ctx) => {
  const me = needLogin(ctx);
  rateLimit(ctx.req, 'comment', 60, 60 * 60 * 1000);
  const id = parseInt(ctx.params.id, 10);
  if (!await q('SELECT 1 FROM posts WHERE id = ?').get(id)) throw new HttpError(404, '글을 찾을 수 없어요.');
  const body = str(ctx.body.body, '댓글', { required: true, max: 1000 });
  const info = await q('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(id, me.id, body, now());
  return { status: 201, data: { id: Number(info.lastInsertRowid) } };
});

route('DELETE', '/api/comments/:id', async (ctx) => {
  const me = needLogin(ctx);
  const id = parseInt(ctx.params.id, 10);
  const row = await q('SELECT user_id FROM comments WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, '댓글을 찾을 수 없어요.');
  if (row.user_id !== me.id && !me.is_admin) throw new HttpError(403, '삭제 권한이 없어요.');
  await q('DELETE FROM comments WHERE id = ?').run(id);
  return { ok: true };
});

/* ───────────── 정적 파일 ───────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.includes('\0')) throw bad('잘못된 경로예요.');
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, '접근할 수 없어요.');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(rel)) throw new HttpError(404, '파일이 없어요.');
    file = path.join(PUBLIC_DIR, 'index.html'); // SPA 진입점
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    // 파일이 없거나 읽기 실패해도 서버가 죽지 않게 해요
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('파일을 찾을 수 없어요.');
  });
  stream.pipe(res);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://i.ytimg.com; " +
    "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
    "frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none'; form-action 'self'",
};

/* ───────────── 서버 ───────────── */
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    await ready;
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청이에요.');
      return serveStatic(req, res, pathname);
    }

    /* CSRF 방어: 변경 요청은 같은 출처에서만 */
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating) {
      const origin = req.headers.origin;
      if (origin) {
        let ok = false;
        try {
          ok = new URL(origin).host === req.headers.host;
        } catch {}
        if (!ok) throw new HttpError(403, '허용되지 않는 출처예요.');
      }
    }

    let matched = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      matched = { r, params };
      break;
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? '허용되지 않는 요청이에요.' : '없는 API예요.');

    const ctx = {
      req,
      res,
      params: matched.params,
      query: url.searchParams,
      user: await currentUser(req),
      body: mutating ? await readJson(req) : {},
    };
    const out = await matched.r.handler(ctx);
    if (out && out.data !== undefined) sendJson(res, out.status || 200, out.data, out.headers || {});
    else sendJson(res, 200, out);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: '서버 오류가 났어요.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`이음크루가 http://localhost:${PORT} 에서 실행 중이에요.`));
}

module.exports = { server, q, ready };
