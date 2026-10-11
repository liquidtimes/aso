// Ежедневный сбор позиций. Настройки (id приложения, название, список запросов) берутся из переменных окружения GitHub.
// Результат: data/positions.json { stores: { gplay: { "2026-10-11": { "<номер запроса>": позиция | null } } } }
//   число = место в первых 30; null = нет в первых 30; нет ключа = замер не удался
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'data', 'positions.json');
const QUERIES = JSON.parse(process.env.QUERIES_JSON || readFileSync(join(here, '..', 'data', 'queries.local.json'), 'utf8'));
const NAME = process.env.APP_NAME, GP_ID = process.env.GP_ID, IOS_ID = Number(process.env.IOS_ID), RS_ID = process.env.RS_ID;
if (!NAME || !GP_ID || !IOS_ID || !RS_ID) throw new Error('не заданы переменные APP_NAME, GP_ID, IOS_ID, RS_ID');
const DEPTH = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const only = (process.argv[2] || '').split(',').filter(Boolean);

async function retry(fn, tries = 3) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { err = e; await sleep(1500 * i); }
  }
  throw err;
}

async function eachQuery(name, fn, delay) {
  const out = {};
  let failed = 0;
  for (let n = 0; n < QUERIES.length; n++) {
    try { out[n] = await retry(() => fn(QUERIES[n]), name === 'appgallery' ? 2 : 3); } catch (e) { failed++; if (failed === 1) console.log(name + ': первая ошибка: ' + e.message); }
    if ((n + 1) % 20 === 0) console.log(`${name}: ${n + 1}/${QUERIES.length}, ошибок ${failed}`);
    await sleep(delay);
  }
  console.log(`${name}: ${Object.keys(out).length}/${QUERIES.length}, в топ-${DEPTH}: ${Object.values(out).filter((v) => v !== null).length}, ошибок ${failed}`);
  return out;
}

const collectors = {
  async gplay() {
    const gplay = (await import('google-play-scraper')).default;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    return eachQuery('gplay', async (q) => {
      const r = await withTimeout(gplay.search({ term: q, lang: 'ru', country: 'ru', num: DEPTH, throttle: 2 }), 30000);
      // у «фирменной» карточки в выдаче нет appId, ищем её по названию
      const i = r.findIndex((a) => a.appId === GP_ID || (!a.appId && (a.title || '').includes(NAME)));
      return i >= 0 && i < DEPTH ? i + 1 : null;
    }, 300);
  },
  async appstore() {
    return eachQuery('appstore', async (q) => {
      const r = await fetch(`https://itunes.apple.com/ru/search?term=${encodeURIComponent(q)}&entity=software&limit=${DEPTH}&country=ru&lang=ru_ru`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const i = j.results.findIndex((a) => a.trackId === IOS_ID);
      return i >= 0 ? i + 1 : null;
    }, 1200);
  },
  async rustore() {
    return eachQuery('rustore', async (q) => {
      const r = await fetch(`https://backapi.rustore.ru/applicationData/apps?query=${encodeURIComponent(q)}&pageSize=${DEPTH}&pageNumber=0`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.code !== 'OK' || !j.body) throw new Error('bad payload');
      const i = (j.body.content || []).findIndex((a) => a.packageName === RS_ID);
      return i >= 0 ? i + 1 : null;
    }, 400);
  },
  // Эта выдача открывается только с российских адресов: нужен прокси в секрете PROXY_URL (http:// или socks5://логин:пароль@адрес:порт)
  async appgallery() {
    const proxyUrl = process.env.PROXY_URL;
    if (!proxyUrl) { console.log('appgallery: пропуск, PROXY_URL не задан'); return null; }
    const { chromium } = await import('playwright');
    // Chromium не умеет socks5 с логином: поднимаем локальный прокси без пароля, который ходит через указанный
    const { anonymizeProxy } = await import('proxy-chain');
    const local = await anonymizeProxy(proxyUrl);
    const browser = await chromium.launch({ proxy: { server: local } });
    const page = await (await browser.newContext({ locale: 'ru-RU' })).newPage();
    try {
      return await eachQuery('appgallery', async (q) => {
        await page.goto('https://appgallery.huawei.com/search/' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => document.body.innerText.includes('Результаты для'), null, { timeout: 25000 });
        await page.waitForTimeout(1500);
        const text = await page.evaluate(() => document.body.innerText);
        const names = (text.split('Результаты для')[1] || '').split('\n').slice(1).join('\n').split('Установить').map((b) => b.trim().split('\n')[0]).filter(Boolean);
        const i = names.findIndex((n) => n.includes(NAME));
        return i >= 0 && i < DEPTH ? i + 1 : null;
      }, 700);
    } finally { await browser.close(); (await import('proxy-chain')).closeAnonymizedProxy(local, true); }
  },
};

const db = existsSync(DATA) ? JSON.parse(readFileSync(DATA, 'utf8')) : { stores: {} };
for (const name of Object.keys(collectors)) {
  if (only.length && !only.includes(name)) continue;
  try {
    const res = await collectors[name]();
    if (!res) continue;
    db.stores[name] ||= {};
    db.stores[name][date] = { ...(db.stores[name][date] || {}), ...res };
    writeFileSync(DATA, JSON.stringify(db));
  } catch (e) { console.log(name + ': сбой магазина целиком: ' + e.message); }
}
db.updated = new Date().toISOString();
writeFileSync(DATA, JSON.stringify(db));
console.log('готово', date);
