// Ежедневный сбор позиций. Настройки (id приложения, название, список запросов) берутся из переменных окружения GitHub.
// Результат: data/positions.json { stores: { gplay: { "2026-10-11": { "<номер запроса>": позиция | null } } } }
//   число = место в первых 30; null = нет в первых 30; нет ключа = замер не удался
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'data', 'positions.json');
// Запросы лежат в секрете QUERIES_JSON (список строк), частотность по тем же номерам - в config/freq.json (список чисел)
const QUERIES = JSON.parse(process.env.QUERIES_JSON || readFileSync(join(here, '..', 'data', 'queries.local.json'), 'utf8'));
const FF = join(here, '..', 'config', 'freq.json');
const FREQ = existsSync(FF) ? JSON.parse(readFileSync(FF, 'utf8')) : [];
const NAME = process.env.APP_NAME, GP_ID = process.env.GP_ID, IOS_ID = Number(process.env.IOS_ID), RS_ID = process.env.RS_ID;
if (!NAME || !GP_ID || !IOS_ID || !RS_ID) throw new Error('не заданы переменные APP_NAME, GP_ID, IOS_ID, RS_ID');
const DEPTH = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const only = (process.argv[2] || process.env.ONLY || '').split(',').filter(Boolean);
process.on('unhandledRejection', (e) => console.log('unhandledRejection: ' + (e && e.message)));

async function retry(fn, tries = 3) {
  let err;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) { err = e; await sleep(1500 * i); }
  }
  throw err;
}

// Топ-30 выдачи по каждому запросу: TOP[магазин][номер запроса] = [{ id, name, us }]
const TOP = {};
const rec = (store, n, list) => { (TOP[store] ||= {})[n] = list; };

async function eachQuery(name, fn, delay) {
  const out = {};
  let failed = 0, streak = 0;
  for (let n = 0; n < QUERIES.length; n++) {
    try { out[n] = await retry(() => fn(QUERIES[n], n), 2); streak = 0; } catch (e) { failed++; streak++; if (failed === 1) console.log(name + ': первая ошибка: ' + e.message); }
    if (streak >= 6) { console.log(name + ': 6 ошибок подряд, магазин пропущен (источник недоступен)'); break; }
    if ((n + 1) % 20 === 0) console.log(`${name}: ${n + 1}/${QUERIES.length}, ошибок ${failed}`);
    await sleep(delay);
  }
  console.log(`${name}: ${Object.keys(out).length}/${QUERIES.length}, в топ-${DEPTH}: ${Object.values(out).filter((v) => v !== null).length}, ошибок ${failed}`);
  return out;
}

const collectors = {
  async gplay() {
    const gplay = (await import('google-play-scraper')).default;
    // Google Play режет запросы с адресов GitHub: идём через российский прокси, если он задан
    let local = null, requestOptions;
    if (process.env.PROXY_URL) {
      const { anonymizeProxy } = await import('proxy-chain');
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      local = await anonymizeProxy(process.env.PROXY_URL);
      requestOptions = { agent: { https: new HttpsProxyAgent(local) } };
      console.log('gplay: через прокси');
    }
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    return eachQuery('gplay', async (q, n) => {
      const r = await withTimeout(gplay.search({ term: q, lang: 'ru', country: 'ru', num: DEPTH, throttle: 2, requestOptions }), 20000);
      // у «фирменной» карточки в выдаче нет appId, ищем её по названию
      const isUs = (a) => a.appId === GP_ID || (!a.appId && (a.title || '').includes(NAME));
      const i = r.findIndex(isUs);
      rec('gplay', n, r.slice(0, DEPTH).map((a) => ({ id: a.appId || 't:' + a.title, name: a.title, us: isUs(a) })));
      return i >= 0 && i < DEPTH ? i + 1 : null;
    }, 300);
  },
  async appstore() {
    return eachQuery('appstore', async (q, n) => {
      const r = await fetch(`https://itunes.apple.com/ru/search?term=${encodeURIComponent(q)}&entity=software&limit=${DEPTH}&country=ru&lang=ru_ru`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const i = j.results.findIndex((a) => a.trackId === IOS_ID);
      rec('appstore', n, j.results.slice(0, DEPTH).map((a) => ({ id: String(a.trackId), name: a.trackName, us: a.trackId === IOS_ID })));
      return i >= 0 ? i + 1 : null;
    }, 1200);
  },
  async rustore() {
    return eachQuery('rustore', async (q, n) => {
      const r = await fetch(`https://backapi.rustore.ru/applicationData/apps?query=${encodeURIComponent(q)}&pageSize=${DEPTH}&pageNumber=0`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.code !== 'OK' || !j.body) throw new Error('bad payload');
      const i = (j.body.content || []).findIndex((a) => a.packageName === RS_ID);
      rec('rustore', n, (j.body.content || []).slice(0, DEPTH).map((a) => ({ id: a.packageName, name: a.appName, us: a.packageName === RS_ID })));
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
      return await eachQuery('appgallery', async (q, n) => {
        await page.goto('https://appgallery.huawei.com/search/' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 60000 });
        // у страницы строгая CSP: waitForFunction не работает, ждём обычным опросом
        let ready = false;
        for (let k = 0; k < 25 && !ready; k++) { ready = await page.evaluate(() => document.body.innerText.includes('Результаты для')); if (!ready) await sleep(1000); }
        if (!ready) throw new Error('выдача не загрузилась');
        await page.waitForTimeout(1500);
        const text = await page.evaluate(() => document.body.innerText);
        const names = (text.split('Результаты для')[1] || '').split('\n').slice(1).join('\n').split('Установить').map((b) => b.trim().split('\n')[0]).filter(Boolean);
        const i = names.findIndex((n) => n.includes(NAME));
        // у выдачи AppGallery есть только названия: по ним же считаем место среди конкурентов
        rec('appgallery', n, names.slice(0, DEPTH).map((t) => ({ id: 'ag:' + t, name: t, us: t.includes(NAME) })));
        return i >= 0 && i < DEPTH ? i + 1 : null;
      }, 700);
    } finally { await browser.close(); (await import('proxy-chain')).closeAnonymizedProxy(local, true); }
  },
};

// Место среди конкурентов: тот же индекс видимости, посчитанный для каждого приложения из топ-30 по нашим запросам
const WTAB = { 1: 100, 2: 60, 3: 40, 4: 28, 5: 20, 6: 15, 7: 11, 8: 8, 9: 6, 10: 5 };
const weight = (p) => (WTAB[p] != null ? WTAB[p] : p <= 20 ? 3 : p <= 30 ? 1 : 0);
const ALIAS = { 'com.wayout.wayout_food': 'Wayout', 'ai.calzen.caloriecounter': 'CalZen', '6733236996': 'CalZen', 'com.fatsecret.android': 'fatsecret', '347184248': 'fatsecret',
  'com.yazio.android': 'Yazio', '946099227': 'Yazio', 'com.sillens.shapeupclub': 'Lifesum', '286906691': 'Lifesum', 'com.mymealplanner.grechakura': 'EatFit',
  'ru.hikisoft.calories': 'ХиКи', '549217094': 'Arise', '477039928': 'Таблица калорийности', 'cz.psc.android.kaloricketabulky': 'Таблица калорийности',
  'com.foodwarz.mobile': 'FoodWarz', 'com.aiplate.bankr0t': 'AIplate', '1535815279': 'Foodbok', 'com.ai.calorie.tracker.fitory': 'Fitory', 'com.example.slim_pro': 'Slim Pro' };
const GEN = /(счёт?чик(и)?|калькулятор|подсчёт|подсчет|дневник|трекер)?\s*(калори[йяи]\w*|кбжу|бжу)|(^|\s)(ии|ai|от|и|с|по|фото|для|диета|питания|питание)(?=\s|$)/gi;
function shortName(id, name) {
  if (ALIAS[id]) return ALIAS[id];
  for (const chunk of (name || '').split(/\s*[:・—|+]\s*|\s+-\s+/)) {
    const r = chunk.replace(GEN, ' ').replace(/\s+/g, ' ').trim().replace(/^[ ,.-]+|[ ,.-]+$/g, '');
    if (r.length >= 3) return r.slice(0, 24);
  }
  return (name || '').slice(0, 24);
}
function marketOf(store) {
  const top = TOP[store]; if (!top) return null;
  const base = FREQ.reduce((a, f) => a + f * 100, 0); if (!base) return null;
  const V = {}, names = {};
  let used = 0;
  for (const [n, list] of Object.entries(top)) {
    if (!FREQ[n]) continue;
    used++;
    const seen = new Set();
    list.forEach((a, i) => {
      const key = a.us ? 'US' : a.id;
      if (seen.has(key)) return; seen.add(key);
      V[key] = (V[key] || 0) + FREQ[n] * weight(i + 1) / base * 100;
      (names[key] ||= {})[a.name] = ((names[key] || {})[a.name] || 0) + 1;
    });
  }
  const rank = Object.entries(V).sort((a, b) => b[1] - a[1]);
  const pos = rank.findIndex(([k]) => k === 'US') + 1;
  const nm = (k) => (k === 'US' ? NAME : shortName(k, Object.entries(names[k]).sort((a, b) => b[1] - a[1])[0][0]));
  const round = (v) => Math.round(v * 10) / 10;
  const topn = rank.slice(0, 5).map(([k, v]) => ({ name: nm(k), v: round(v), us: k === 'US' }));
  const ours = V.US || 0;
  if (pos > 5) topn.push({ name: nm('US'), v: round(ours), us: true, rank: pos });
  return { rank: pos || null, total: rank.filter(([, v]) => v > 0).length, v: round(ours), top: topn, queries: used };
}

const db = existsSync(DATA) ? JSON.parse(readFileSync(DATA, 'utf8')) : { stores: {} };
for (const name of Object.keys(collectors)) {
  if (only.length && !only.includes(name)) continue;
  if (name === 'gplay' && !only.includes('gplay')) { console.log('gplay: на GitHub не собираем (Google Play режет адреса GitHub), его снимает отдельная ежедневная задача'); continue; }
  // расписание запускает сбор несколько раз в сутки (GitHub иногда пропускает запуски): магазин, уже собранный сегодня, пропускаем
  if (!only.length && Object.keys((db.stores[name] || {})[date] || {}).length >= QUERIES.length * 0.9) { console.log(name + ': сегодня уже собрано'); continue; }
  try {
    const res = await collectors[name]();
    if (!res) continue;
    db.stores[name] ||= {};
    db.stores[name][date] = { ...(db.stores[name][date] || {}), ...res };
    const mk = marketOf(name);
    if (mk && mk.queries >= 50) { ((db.market ||= {})[name] ||= {})[date] = mk; console.log(name + ': место среди конкурентов ' + mk.rank + ' из ' + mk.total); }
    writeFileSync(DATA, JSON.stringify(db));
  } catch (e) { console.log(name + ': сбой магазина целиком: ' + e.message); }
}
db.updated = new Date().toISOString();
writeFileSync(DATA, JSON.stringify(db));
console.log('готово', date);
process.exit(0);
