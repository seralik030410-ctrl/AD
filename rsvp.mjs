import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dataDirectory = volume || (!onRailway ? fileURLToPath(new URL('./data/', import.meta.url)) : null);
const password = process.env.ADMIN_PASSWORD;
const sessionKey = randomBytes(32);
const sessionLifetime = 8 * 60 * 60 * 1000;
const cookieName = 'wedding_admin';
const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: onRailway, path: '/admin' };
const sha256 = text => createHash('sha256').update(text).digest();
const sign = text => createHmac('sha256', sessionKey).update(text).digest('hex');
const dateFormat = new Intl.DateTimeFormat('ru', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Dushanbe'
});

function readResponses() {
  try {
    return JSON.parse(readFileSync(join(dataDirectory, 'rsvps.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function saveResponse(response) {
  // A single Express instance handles these writes sequentially.
  const responses = readResponses();
  if (responses.some(saved => saved.id === response.id)) return;
  mkdirSync(dataDirectory, { recursive: true });
  const temporary = join(dataDirectory, 'rsvps.tmp');
  writeFileSync(temporary, JSON.stringify([...responses, response], null, 2), { mode: 0o600, flush: true });
  renameSync(temporary, join(dataDirectory, 'rsvps.json'));
}

function hasSession(req) {
  const cookie = req.headers.cookie?.split(/;\s*/).find(part => part.startsWith(cookieName + '='));
  const token = cookie?.slice(cookieName.length + 1);
  const match = token?.match(/^(\d+)\.([a-f0-9]{64})$/);
  if (!match) return false;
  const [, expires, signature] = match;
  return Number(expires) > Date.now() && timingSafeEqual(Buffer.from(signature), Buffer.from(sign(expires)));
}

const escaped = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = value => value.replace(/[&<>"']/g, character => escaped[character]);

function adminPage(content) {
  return `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ответы на приглашение</title>
<style>
body { margin:0; background:#f8f5ef; color:#433b34; font:16px/1.55 system-ui,sans-serif; }
main { width:min(900px,calc(100% - 32px)); margin:48px auto; }
h1 { font:normal clamp(32px,6vw,52px)/1.1 Georgia,serif; margin:16px 0 24px; }
h2 { margin:0 0 6px; font-size:18px; overflow-wrap:anywhere; }
header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; }
.card { background:#fffcf7; border:1px solid #d8cdc0; border-radius:16px; padding:22px; margin-bottom:12px; }
.login { max-width:380px; }
label { display:block; margin-bottom:8px; }
input { box-sizing:border-box; width:100%; border:1px solid #a89a8e; padding:10px; margin:0 0 16px; font:inherit; }
button { cursor:pointer; border:0; border-radius:8px; background:#625348; color:white; font:inherit; padding:10px 16px; }
a { color:#625348; }
.muted { color:#6e6258; }
.wishes { white-space:pre-wrap; overflow-wrap:anywhere; margin-bottom:0; }
.error { color:#9c352c; }
</style>
<main><a href="/">К приглашению</a>${content}</main>
</html>`;
}

function loginPage(message = '') {
  return adminPage(`<h1>Ответы на приглашение</h1>
<form class="card login" method="post" action="/admin/login">
  ${message ? `<p class="error" role="alert">${message}</p>` : ''}
  <label for="admin-password">Пароль</label>
  <input id="admin-password" name="password" type="password" required maxlength="256" autocomplete="current-password">
  <button type="submit">Войти</button>
</form>`);
}

function dashboard(responses) {
  const attending = responses.filter(response => response.attending === 'yes').length;
  const cards = responses.slice().reverse().map(response => `
<article class="card">
  <h2>${escapeHtml(response.name)}</h2>
  <span class="muted">${response.attending === 'yes' ? 'Придёт' : 'Не придёт'} · ${dateFormat.format(new Date(response.receivedAt))}</span>
  ${response.wishes ? `<p class="wishes">${escapeHtml(response.wishes)}</p>` : ''}
</article>`).join('');
  return adminPage(`
<header><h1>Ответы гостей</h1><form action="/admin/logout" method="post"><button type="submit">Выйти</button></form></header>
<p class="muted">Всего ${responses.length} · Придут ${attending} · Не придут ${responses.length - attending}</p>
${cards || '<p class="card">Ответов пока нет.</p>'}`);
}

export function mountRsvp(app) {
  app.post('/api/rsvp', express.json({ limit: '8kb' }), (req, res) => {
    if (!dataDirectory || !password) return res.status(503).json({ ok: false });
    const { id, name, attending, wishes } = req.body ?? {};
    if (!req.is('application/json') ||
        typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) ||
        typeof name !== 'string' || !name.trim() || name.length > 90 ||
        !['yes', 'no'].includes(attending) || typeof wishes !== 'string' || wishes.length > 700) {
      return res.status(400).json({ ok: false });
    }
    try {
      saveResponse({ id, name: name.trim(), attending, wishes: wishes.trim(), receivedAt: new Date().toISOString() });
      return res.json({ ok: true });
    } catch (error) {
      console.error('Could not save RSVP:', error.code ?? error.name);
      return res.status(503).json({ ok: false });
    }
  });

  const admin = express.Router();
  app.use('/admin', admin);
  admin.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    if (!password || !dataDirectory) return res.status(503).send(adminPage('<h1>Панель ещё не настроена</h1>'));
    next();
  });
  admin.get('/', (req, res) => {
    if (!hasSession(req)) return res.send(loginPage());
    try {
      return res.send(dashboard(readResponses()));
    } catch (error) {
      console.error('Could not read RSVPs:', error.code ?? error.name);
      return res.status(503).send(adminPage('<h1>Ответы временно недоступны</h1>'));
    }
  });

  let loginWindowEndsAt = 0;
  let failedLogins = 0;
  admin.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const now = Date.now();
    if (now >= loginWindowEndsAt) {
      loginWindowEndsAt = now + 60_000;
      failedLogins = 0;
    }
    if (failedLogins >= 10) {
      res.set('Retry-After', String(Math.ceil((loginWindowEndsAt - now) / 1000)));
      return res.status(429).send(loginPage('Слишком много попыток. Попробуйте через минуту.'));
    }
    const entered = req.body?.password;
    if (typeof entered !== 'string' || !timingSafeEqual(sha256(entered), sha256(password))) {
      failedLogins += 1;
      return res.status(401).send(loginPage('Неверный пароль.'));
    }
    const expires = String(now + sessionLifetime);
    res.cookie(cookieName, `${expires}.${sign(expires)}`, { ...cookieOptions, maxAge: sessionLifetime });
    return res.redirect(303, '/admin');
  });
  admin.post('/logout', (_req, res) => {
    res.clearCookie(cookieName, cookieOptions);
    res.redirect(303, '/admin');
  });
}
