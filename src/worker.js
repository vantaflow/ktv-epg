/* KTV EPG API — Cloudflare Worker
 * EPG "sport" public agrégé (programme-tv.nouvelobs.com), normalisé par nom de
 * chaîne pour matcher les chaînes Xtream de KTV. Sert un JSON cache 30 min.
 *
 *   GET /sport            -> { day, source, tz, channels: { "beinsport1": [{st,en,title}], ... } }
 *   GET /epg?channel=beinsport1  -> { channel, cur, next }   (cur/next du moment)
 *   GET /health
 *
 * st/en = epoch UTC (secondes). Le client affiche en heure locale → conversion auto.
 */

const SUP_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SUP_LETTERS = { 'ᴴ':'h','ᴰ':'d','ᵁ':'u','ᴷ':'k','ᶠ':'f','ˢ':'s','ᴾ':'p','ᴿ':'r','ᴬ':'a','ᵂ':'w','ʰ':'h','ᵉ':'e','ᵛ':'v','ᶜ':'c','ᵖ':'p','ᵈ':'d','ᴺ':'n','ᴹ':'m','ᵃ':'a','ⁿ':'n','ᵗ':'t','ʜ':'h','ᴅ':'d' };
const NOISE = new Set(['hd','fhd','uhd','sd','4k','8k','hevc','h265','h264','raw','backup','vip','multi','full','plus','digital','mono','stereo','english','french','arabic','arabe','ar','en','fr','tr','hq','channel','tv','live','d','bk','lq','event','only','prime','fm','nm','ss','be','sa','us','uk','au','world','cup','stable','epl','f','direkte','exclusive','ppv','gold','next','new']);
const ALIASES = { sports:'sport', sptv:'sport', bn:'bein', bsport:'beinsport' };

// MÊME normalisation que KTV (main.js xmlNorm) — clés de chaînes alignées
function chanNorm(s) {
  let x = String(s || '').replace(/⚽/g, 'o').replace(/◉/g, ' ');
  x = x.split('').map((c) => SUP_LETTERS[c] || c).join('');
  x = x.replace(/^[^:|]{1,12}[:|]\s*/, '');
  x = x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (m) => SUP_DIGITS.indexOf(m));
  const k = x.split(/[^a-z0-9]+/).map((t) => ALIASES[t] || t).filter((t) => t && !NOISE.has(t)).join('');
  // "BEIN MAX 4" == "beIN SPORTS MAX 4" -> même clé
  return k.replace(/^beinmax(\d)/, 'beinsportmax$1');
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
const MONTHS_FR = { janvier:1,'février':2,fevrier:2,mars:3,avril:4,mai:5,juin:6,juillet:7,'août':8,aout:8,septembre:9,octobre:10,novembre:11,'décembre':12,decembre:12 };
function tzOffsetMs(tz, date) {
  const u = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const z = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  return u - z;
}
// Heure murale de Paris -> epoch UTC (secondes)
function parisEpoch(y, mo, d, hh, mm) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  return Math.floor((guess + tzOffsetMs('Europe/Paris', new Date(guess))) / 1000);
}

async function scrapeNouvelobs() {
  const res = await fetch('https://programme-tv.nouvelobs.com/sport/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) throw new Error('nouvelobs HTTP ' + res.status);
  const html = await res.text();
  const dm = /(\d{1,2})\s+([a-zàâéèêû]+)\s+(\d{4})/i.exec(html.replace(/<[^>]+>/g, ' '));
  const now = new Date();
  let y = now.getUTCFullYear(), mo = now.getUTCMonth() + 1, d = now.getUTCDate();
  if (dm && MONTHS_FR[dm[2].toLowerCase()]) { d = +dm[1]; mo = MONTHS_FR[dm[2].toLowerCase()]; y = +dm[3]; }
  const rowRe = /\/chaine\/[a-z0-9-]+\/"><img[^>]*alt="Programme ([^"]+)"[\s\S]*?>(\d{1,2})h(\d{2})<\/td>[\s\S]*?<td class="prog_autre[^"]*"><span[^>]*>(?:<a[^>]*>)?([^<]+)/g;
  const byChan = {};
  let m;
  while ((m = rowRe.exec(html))) {
    const chan = chanNorm(decodeEntities(m[1]));
    const st = parisEpoch(y, mo, d, +m[2], +m[3]);
    const title = decodeEntities(m[4]).replace(/\s+/g, ' ').trim();
    if (!chan || !title || !st) continue;
    (byChan[chan] = byChan[chan] || []).push({ st, title });
  }
  for (const chan of Object.keys(byChan)) {
    const l = byChan[chan].sort((a, b) => a.st - b.st);
    for (let i = 0; i < l.length; i++) l[i].en = i + 1 < l.length ? l[i + 1].st : l[i].st + 3 * 3600;
  }
  return { day: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, source: 'nouvelobs', tz: 'Europe/Paris', channels: byChan, builtAt: Math.floor(Date.now() / 1000) };
}

// Cache edge (par colo) 30 min, avec re-scrape en arrière-plan si périmé
async function getSport(ctx) {
  const cacheKey = new Request('https://ktv-epg/_cache/sport');
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();
  const data = await scrapeNouvelobs();
  const resp = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } });
  if (ctx) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  else await cache.put(cacheKey, resp.clone());
  return data;
}

const J = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=900' },
});

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/health') return J({ ok: true });
      if (url.pathname === '/sport') return J(await getSport(ctx));
      if (url.pathname === '/epg') {
        const key = chanNorm(url.searchParams.get('channel') || '');
        const data = await getSport(ctx);
        const list = (data.channels || {})[key] || null;
        if (!list) return J({ channel: key, cur: null, next: null });
        const now = Date.now() / 1000;
        return J({ channel: key, cur: list.find((p) => p.st <= now && now < p.en) || null, next: list.find((p) => p.st > now) || null });
      }
      if (url.pathname === '/' || url.pathname === '') return J({ name: 'ktv-epg', endpoints: ['/sport', '/epg?channel=', '/health'] });
      return J({ error: 'not found' }, 404);
    } catch (e) {
      return J({ error: String(e && e.message || e) }, 502);
    }
  },
  // Cron : rafraîchit le cache sport
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const data = await scrapeNouvelobs();
      const resp = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1800' } });
      await caches.default.put(new Request('https://ktv-epg/_cache/sport'), resp);
    })());
  },
};
