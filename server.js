require('dotenv').config();
const express    = require('express');
const crypto     = require('crypto');
const { Rcon }   = require('rcon-client');
const sqlite3    = require('better-sqlite3');
const path       = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Статика (index.html) ──────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── База данных (SQLite) ──────────────────────────────────────
const db = sqlite3('./orders.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    da_id       TEXT UNIQUE,        -- ID алерта DonationAlerts (защита от дублей)
    nick        TEXT NOT NULL,
    priv        TEXT NOT NULL,
    days        INTEGER NOT NULL,
    amount      REAL NOT NULL,
    status      TEXT DEFAULT 'pending', -- pending / done / error
    created_at  TEXT DEFAULT (datetime('now')),
    done_at     TEXT
  )
`);

// ── RCON helper ───────────────────────────────────────────────
async function sendRcon(command) {
  const rcon = new Rcon({
    host: process.env.RCON_HOST || '127.0.0.1',
    port: parseInt(process.env.RCON_PORT) || 25575,
    password: process.env.RCON_PASSWORD,
    timeout: 5000,
  });
  try {
    await rcon.connect();
    const res = await rcon.send(command);
    console.log(`[RCON] ${command}  →  ${res}`);
    await rcon.end();
    return res;
  } catch (err) {
    console.error('[RCON ERROR]', err.message);
    throw err;
  }
}

// ── Выдача привилегии ─────────────────────────────────────────
async function grantPrivilege(nick, priv, days) {
  const group = priv.toLowerCase();
  const cmd   = `lp user ${nick} parent addtemp ${group} ${days}d accumulate`;
  await sendRcon(cmd);
  console.log(`[GRANT] ${nick} → ${priv} x${days}d`);
}

// ── Цены (минимальные суммы для проверки) ─────────────────────
// Тарифы Clarity: 30d×1.0 | 60d×1.75 | 90d×2.4 | 180d×4.2
const PRICES = {
  wanderer: { 30: 99,  60: 173,  90: 238,  180: 416  }, // Скиталец
  oasis:    { 30: 199, 60: 348,  90: 478,  180: 836  }, // Оазис
  sheikh:   { 30: 349, 60: 611,  90: 838,  180: 1466 }, // Шейх
  sultan:   { 30: 599, 60: 1048, 90: 1438, 180: 2516 }, // Султан
};

function minPrice(priv, days) {
  return (PRICES[priv]?.[days] ?? Infinity) * 0.95; // допуск 5%
}

// ── Telegram Login верификация ────────────────────────────────
//
//  Telegram передаёт данные пользователя с HMAC-SHA256 подписью.
//  Клиент шлёт POST /auth/telegram с полями от Telegram Login Widget.
//  Бэкенд проверяет hash и возвращает { ok: true, user: {...} }.
//
//  BOT_TOKEN должен быть задан в .env как TG_BOT_TOKEN.
//
app.post('/auth/telegram', (req, res) => {
  const data = req.body;
  const { hash, ...fields } = data;

  if (!hash) return res.status(400).json({ error: 'no_hash' });

  const botToken = process.env.TG_BOT_TOKEN || '';
  if (!botToken) {
    // Если токен не настроен — принимаем без верификации (только dev!)
    console.warn('[AUTH] TG_BOT_TOKEN not set — skipping verification (dev mode)');
    return res.json({ ok: true, user: fields });
  }

  // Верификация по документации Telegram
  const crypto = require('crypto');
  const checkString = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  if (expectedHash !== hash) {
    console.warn('[AUTH] Invalid Telegram hash');
    return res.status(403).json({ error: 'invalid_hash' });
  }

  // Проверяем свежесть (не старше 1 суток)
  const authDate = parseInt(fields.auth_date || 0);
  if (Date.now() / 1000 - authDate > 86400) {
    return res.status(403).json({ error: 'auth_expired' });
  }

  res.json({ ok: true, user: fields });
});

// ── Webhook DonationAlerts ────────────────────────────────────
//
//  DonationAlerts шлёт POST на ваш URL.
//  Настройте webhook в кабинете: Settings → Integrations → Webhook.
//  URL: https://ваш-домен.ru/webhook/donationalerts
//
app.post('/webhook/donationalerts', async (req, res) => {
  try {
    const body = req.body;

    // 1. Верификация подписи (DA передаёт X-Donation-Secret)
    const secret   = req.headers['x-donation-secret'] || body.secret || '';
    const expected = process.env.DA_WEBHOOK_SECRET || '';
    if (expected && secret !== expected) {
      console.warn('[WEBHOOK] Bad secret');
      return res.status(403).json({ error: 'forbidden' });
    }

    // 2. Разбираем поля
    const daId    = String(body.id || body.donation_id || '');
    const amount  = parseFloat(body.amount || body.sum || 0);
    const comment = (body.comment || body.message || '').trim();
    const status  = (body.status || '').toLowerCase();

    console.log('[WEBHOOK]', { daId, amount, comment, status });

    // Принимаем только успешные алерты
    if (status && status !== 'success' && status !== '1' && status !== 'paid') {
      return res.json({ ok: false, reason: 'not_paid' });
    }

    // 3. Парсим comment: MC:<nick>:<priv>:<days>d
    const match = comment.match(/MC:([a-zA-Z0-9_]{3,16}):(\w+):(\d+)d/i);
    if (!match) {
      console.warn('[WEBHOOK] Неизвестный формат комментария:', comment);
      return res.json({ ok: false, reason: 'bad_comment' });
    }

    const nick = match[1];
    const priv = match[2].toLowerCase();
    const days = parseInt(match[3]);

    if (!['wanderer', 'oasis', 'sheikh', 'sultan'].includes(priv)) {
      return res.json({ ok: false, reason: 'unknown_priv' });
    }

    // 4. Проверка суммы
    const min = minPrice(priv, days);
    if (amount < min) {
      console.warn(`[WEBHOOK] Мало денег: ${amount} < ${min}`);
      return res.json({ ok: false, reason: 'insufficient_amount' });
    }

    // 5. Защита от дублей
    const existing = db.prepare('SELECT id FROM orders WHERE da_id = ?').get(daId);
    if (existing) {
      console.log('[WEBHOOK] Дубль, пропускаем:', daId);
      return res.json({ ok: true, duplicate: true });
    }

    // 6. Сохраняем в БД
    db.prepare(
      'INSERT INTO orders (da_id, nick, priv, days, amount, status) VALUES (?,?,?,?,?,?)'
    ).run(daId, nick, priv, days, amount, 'pending');

    // 7. Выдаём привилегию через RCON
    await grantPrivilege(nick, priv, days);

    // 8. Помечаем как выполнено
    db.prepare("UPDATE orders SET status='done', done_at=datetime('now') WHERE da_id=?")
      .run(daId);

    res.json({ ok: true });
  } catch (err) {
    console.error('[WEBHOOK FATAL]', err);
    try { db.prepare("UPDATE orders SET status='error' WHERE status='pending'").run(); } catch {}
    res.status(500).json({ error: 'internal' });
  }
});

// ── Ручная выдача (для тестов / повторной выдачи) ─────────────
//  POST /admin/grant  { secret, nick, priv, days }
app.post('/admin/grant', async (req, res) => {
  if (req.body.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { nick, priv, days } = req.body;
  try {
    await grantPrivilege(nick, priv, parseInt(days));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Статус заказов (для отладки) ──────────────────────────────
app.get('/admin/orders', (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
});

// ── Запуск ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✦ Clarity donate server запущен на порту ${PORT}`);
  console.log(`  Webhook URL: https://ВАШ-ДОМЕН/webhook/donationalerts`);
});
