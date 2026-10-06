/**
 * ChatClaud — сервер для Render
 * Env: GROQ_KEY, MISTRAL_API_KEY, HF_TOKEN, NOVA_URL, NOVA_API_TOKEN,
 *      PLUS_BOT_SECRET, ADMIN_SECRET, NETLIFY_DEPLOY_TOKEN, PORT
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const ROOT = __dirname;

const PLUS_FILE = path.join(ROOT, 'data', 'plus-grants.json');
function readPlusStore() {
  try {
    if (!fs.existsSync(PLUS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PLUS_FILE, 'utf8') || '{}');
  } catch (e) { return {}; }
}
function writePlusStore(obj) {
  try {
    const dir = path.dirname(PLUS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PLUS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { console.error('plus store write', e.message); }
}
function normalizeUsername(u) {
  return String(u || '').trim().replace(/^@/, '').toLowerCase();
}

// Provider key helpers. Keep these defined in the server itself so /api/chat
// never depends on another file or an older server build.
function groqKeys() {
  const out = [];
  const seen = new Set();
  const names = [
    'GROQ_KEY', 'GROQ_KEY_1', 'GROQ_KEY_2', 'GROQ_KEY_3',
    'GROQ_API_KEY', 'GROQ_API_KEY_1', 'GROQ_API_KEY_2'
  ];
  for (const name of names) {
    const v = String(process.env[name] || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// Normalize chat messages for every provider.
// IMPORTANT: /api/chat uses this before calling Groq/Mistral/HF.
// Without this helper every provider fails with ReferenceError, while /api/health still looks healthy.
function normalizeChatMessages(messages, system) {
  const embeddedSystem = (messages || []).find((m) => m && m.role === 'system');
  const sys = system || (embeddedSystem && embeddedSystem.content) ||
    'Ты ChatClaud. Отвечай на языке пользователя. Не упоминай внутренние API, ключи и служебные детали. Никогда не выдумывай URL; только из поиска Nova.';
  return [{ role: 'system', content: String(sys).slice(0, 8000) }].concat(
    (messages || []).slice(-20).filter((m) => m && m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 8000),
    }))
  );
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
  else res.end(JSON.stringify(body));
}

const PROVIDER_TIMEOUT_MS = 45000;
function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = Object.assign({}, options, { signal: controller.signal });
  if (options && options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return fetch(url, request).finally(() => clearTimeout(timer));
}

function publicProviderError(error) {
  return String(error && error.message || error || 'unknown error')
    .replace(/sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
}

/* ========== Fetch URL helpers ========== */
function isSafeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' || host.endsWith('.local') ||
      host === '0.0.0.0' || host === '::' || host === '::1' ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
      /^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host) ||
      /^fe80:/i.test(host)
    ) return false;
    return true;
  } catch (e) { return false; }
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;/g, '—');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

function extractMeta(html, name) {
  const re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:name|property)=["\']' + name + '["\']', 'i');
  const m = String(html).match(re) || String(html).match(re2);
  return m ? m[1].slice(0, 500) : '';
}

function youtubeVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([\w-]{11})/,
    /youtube\.com\/watch\?.*v=([\w-]{11})/
  ];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchYouTube(videoId) {
  const result = {
    type: 'youtube', videoId, title: '', description: '', channel: '',
    duration: '', views: '', subtitles: '',
    url: 'https://www.youtube.com/watch?v=' + videoId
  };
  try {
    const oe = await fetch('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + videoId + '&format=json');
    if (oe.ok) {
      const j = await oe.json();
      result.title = j.title || '';
      result.channel = j.author_name || '';
    }
  } catch (e) {}
  try {
    const pageRes = await fetch('https://www.youtube.com/watch?v=' + videoId, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'ru,en;q=0.9'
      }
    });
    const html = await pageRes.text();
    let m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (m) result.description = m[1];
    m = html.match(/"viewCount"\s*:\s*"(\d+)"/);
    if (m) result.views = m[1];
    m = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    if (m && !result.channel) result.channel = m[1];
    m = html.match(/"captionTracks"\s*:\s*(\[[\s\S]*?\])/);
    if (m) {
      try {
        const tracks = JSON.parse(m[1]);
        let track = tracks.find(t => t.languageCode && t.languageCode.startsWith('ru'))
                 || tracks.find(t => t.languageCode && t.languageCode.startsWith('en'))
                 || tracks[0];
        if (track && track.baseUrl) {
          const capRes = await fetch(track.baseUrl);
          const capXml = await capRes.text();
          const lines = [...capXml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(x =>
            x[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/\n/g,' ')
          );
          result.subtitles = lines.join(' ').slice(0, 8000);
        }
      } catch (e) {}
    }
  } catch (e) {}
  return result;
}

async function fetchOembed(url) {
  const tests = [
    { re: /vk\.com\/video/, api: 'https://vk.com/oembed?url=' + encodeURIComponent(url) + '&format=json' },
    { re: /rutube\.ru\/video/, api: 'https://rutube.ru/api/oembed/?url=' + encodeURIComponent(url) + '&format=json' },
    { re: /vimeo\.com\/\d+/, api: 'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(url) },
  ];
  for (const s of tests) {
    if (s.re.test(url)) {
      try {
        const r = await fetch(s.api);
        if (r.ok) return await r.json();
      } catch (e) {}
    }
  }
  return null;
}

async function fetchUrlContent(cleanUrl, maxLength) {
  maxLength = maxLength || 12000;
  const ytId = youtubeVideoId(cleanUrl);
  if (ytId) {
    const yt = await fetchYouTube(ytId);
    return {
      ok: true, type: 'video', source: 'youtube', url: cleanUrl,
      title: yt.title, description: yt.description, channel: yt.channel,
      duration: yt.duration, views: yt.views,
      subtitles: yt.subtitles ? yt.subtitles.slice(0, 8000) : '',
      hasSubtitles: !!yt.subtitles
    };
  }
  const oe = await fetchOembed(cleanUrl);
  if (oe) {
    return {
      ok: true, type: 'video', source: 'oembed', url: cleanUrl,
      title: oe.title || '', description: oe.description || '',
      channel: oe.author_name || '', thumbnail: oe.thumbnail_url || ''
    };
  }
  const r = await fetch(cleanUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ChatClaudBot/1.0; +https://chatclaud.onrender.com)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru,en;q=0.9'
    },
    redirect: 'follow'
  });
  if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, url: cleanUrl };
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('text/html') && !ct.includes('text/plain')) {
    return { ok: true, type: 'file', url: cleanUrl, contentType: ct, message: 'Не HTML' };
  }
  const html = await r.text();
  const title = extractTitle(html);
  const description = extractMeta(html, 'description') || extractMeta(html, 'og:description');
  const fullText = htmlToText(html);
  return {
    ok: true, type: 'page', url: cleanUrl, title, description,
    text: fullText.slice(0, maxLength), fullLength: fullText.length,
    truncated: fullText.length > maxLength
  };
}

/* ========== Nova ========== */
async function novaRequest(p, body) {
  const configuredBase = (process.env.NOVA_URL || process.env.NOVA_BASE || 'https://nova-brawser.onrender.com').replace(/\/$/, '');
  const base = configuredBase;
  const token = process.env.NOVA_API_TOKEN || process.env.NOVA_AIP_TOKEN || process.env.API_TOKEN || '';
  if (!base) throw new Error('NOVA_URL not set');
  const ctrl = new AbortController();
  const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 90000);
  try {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Token': token,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(function () { return ''; });
      throw new Error('nova http ' + res.status + ': ' + String(txt).slice(0, 200));
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ========== Video search + Nova link ========== */
function extractPlainUserText(text) {
  let t = String(text || '');
  t = t.split(/Live web results/i)[0];
  t = t.split(/\[Данные поиска\]/i)[0];
  t = t.split(/\[Ссылка на /i)[0];
  t = t.split(/\[Соцсеть/i)[0];
  t = t.split(/\[фото\]/i)[0];
  t = t.split(/\[ФАЙЛ\]/i)[0];
  const uq = t.split(/User question:\s*/i);
  if (uq.length > 1) t = uq[uq.length - 1];
  t = t.replace(/^\s*User question:\s*/i, '');
  t = t.replace(/\(use these facts[\s\S]*$/i, '');
  t = t.replace(/https?:\/\/[^\s]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
}
function isVideoQuery(text) {
  const t = extractPlainUserText(text).toLowerCase();
  if (!t || t.length < 3) return false;
  return /(найди|поищи|покажи|хочу|нужно|дай|скинь).{0,40}(видео|ролик|клип|youtube|ютуб)/i.test(t)
    || /(видео|ролик|клип|youtube|ютуб).{0,40}(найди|поищи|покажи|про)/i.test(t)
    || /^(видео|ролик)\s+/i.test(t);
}
function cleanVideoQuery(text) {
  let t = extractPlainUserText(text);
  t = t.replace(/^(найди|поищи|покажи|включи|открой|загугли|ищи|мне|ка|пожалуйста)\s+/ig, '');
  t = t.replace(/\b(видео|ролик|клип|youtube|ютуб|интересное|новое|свежее)\b/gi, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 120);
}
async function serperVideos(query) {
  try {
    const data = await novaRequest('/api/search', { q: query, type: 'videos' });
    if (data && (data.videos || data.organic)) return data;
  } catch (e) {}
  const key = process.env.SERPER_KEY || '';
  if (!key) throw new Error('no video search');
  const r = await fetch('https://google.serper.dev/videos', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 5 }),
  });
  if (!r.ok) throw new Error('serper http ' + r.status);
  return r.json();
}
function buildVideoReply(query, data) {
  const items = (data && data.videos) || [];
  if (!items.length) {
    return { text: 'По запросу «' + query + '» видео не найдено. Уточни формулировку.', query, source: 'videos' };
  }
  let out = 'Нашёл видео по запросу «' + query + '»:\n\n';
  items.slice(0, 5).forEach((it, i) => {
    const title = (it.title || '').trim() || '(без названия)';
    const link = (it.link || it.url || '').trim();
    const src = (it.source || it.channel || '').trim();
    out += (i + 1) + '. ' + title + '\n';
    if (src) out += '   ' + src + '\n';
    if (link) out += '   ' + link + '\n';
    out += '\n';
  });
  out += 'Могу уточнить поиск или разобрать конкретную ссылку.';
  return { text: out, query, source: 'videos' };
}
async function handleVideoSearch(message) {
  if (!isVideoQuery(message)) return null;
  const q = cleanVideoQuery(message);
  if (!q || q.length < 2) return null;
  if (/user question|live web|данные поиска|use these facts|cite domains/i.test(q)) return null;
  try {
    const data = await serperVideos(q);
    return buildVideoReply(q, data);
  } catch (e) {
    return null;
  }
}

const MAX_BODY_BYTES = 14 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* Rate: hard limit → exactly +3 hours from the moment of block (e.g. 13:00 → 16:00) */
const RATE_FREE_HARD = 50;
const RATE_PLUS_HARD = 100;
const RATE_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const rateMap = new Map();
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}
function checkRate(req, isPlus) {
  const ip = clientIp(req);
  const now = Date.now();
  const hard = isPlus ? RATE_PLUS_HARD : RATE_FREE_HARD;
  let e = rateMap.get(ip);
  if (!e) {
    e = { count: 0, blockedUntil: 0, windowStarted: now };
    rateMap.set(ip, e);
  }
  // cooldown expired → reset counter
  if (e.blockedUntil && now >= e.blockedUntil) {
    e.count = 0;
    e.blockedUntil = 0;
    e.windowStarted = now;
  }
  if (e.blockedUntil && now < e.blockedUntil) {
    const waitMin = Math.max(1, Math.ceil((e.blockedUntil - now) / 60000));
    const unlockAt = new Date(e.blockedUntil).toISOString();
    return { ok: false, left: 0, waitMin, count: e.count, hard, plus: !!isPlus, unlockAt, tier: 'blocked' };
  }
  e.count += 1;
  if (e.count > hard) {
    e.blockedUntil = now + RATE_COOLDOWN_MS;
    const waitMin = Math.ceil(RATE_COOLDOWN_MS / 60000);
    const unlockAt = new Date(e.blockedUntil).toISOString();
    return { ok: false, left: 0, waitMin, count: e.count, hard, plus: !!isPlus, unlockAt, tier: 'hard' };
  }
  let tier = 'ok';
  if (!isPlus) {
    if (e.count >= 35) tier = 'warn35';
    else if (e.count >= 20) tier = 'warn20';
  } else {
    if (e.count >= 70) tier = 'warn70';
    else if (e.count >= 50) tier = 'warn50';
  }
  return {
    ok: true,
    left: Math.max(0, hard - e.count),
    waitMin: 0,
    count: e.count,
    hard,
    plus: !!isPlus,
    unlockAt: null,
    tier
  };
}
const RATE_LIMIT = RATE_FREE_HARD;

function hfKeys() {
  const out = [];
  const seen = new Set();
  const push = (v) => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } };
  ['HF_KEY','HF_KEY2','HF_KEY_1','HF_KEY_2','HF_KEY_3','HF_TOKEN','HUGGINGFACE_KEY','HUGGINGFACE_KEY_2','HUGGINGFACE_TOKEN'].forEach(k => push(process.env[k]));
  Object.keys(process.env).forEach(k => { if (/^HF_/i.test(k) || /HUGGINGFACE/i.test(k)) push(process.env[k]); });
  return out;
}
async function hfVision(imageDataUrl, prompt) {
  const keys = hfKeys();
  if (!keys.length) throw new Error('no hf vision');
  const models = [
    'zai-org/GLM-4.5V:fastest',
    'Qwen/Qwen2.5-VL-72B-Instruct:fastest',
    'Qwen/Qwen2.5-VL-32B-Instruct:fastest',
    'meta-llama/Llama-3.2-90B-Vision-Instruct:fastest',
  ];
  const visionPrompt = prompt || 'Опиши изображение по-русски.';
  let lastErr = 'empty';
  for (const key of keys) {
    for (const model of models) {
      try {
        const res = await fetchWithTimeout('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({
            model, max_tokens: 400,
            messages: [{ role: 'user', content: [
              { type: 'text', text: visionPrompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ]}],
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = (data.error && (data.error.message || data.error)) || ('HF ' + res.status);
          continue;
        }
        const t = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (t && String(t).trim().length > 8) return { text: String(t).trim(), provider: 'hf-vis:' + model };
      } catch (e) { lastErr = e.message || String(e); }
    }
  }
  throw new Error(String(lastErr));
}


async function hfTranscribe(audioBuffer, mimeType, language) {
  const keys = hfKeys();
  if (!keys.length) throw new Error('HF_TOKEN не задан');
  const models = [
    'openai/whisper-large-v3',
    'openai/whisper-large-v3-turbo',
  ];
  let lastErr = 'HF transcription empty';
  for (const key of keys) {
    for (const model of models) {
      try {
        const headers = { Authorization: 'Bearer ' + key, 'Content-Type': mimeType || 'audio/webm' };
        const url = 'https://router.huggingface.co/hf-inference/models/' + encodeURIComponent(model);
        const res = await fetchWithTimeout(url, { method: 'POST', headers, body: audioBuffer }, 90000);
        const data = await res.json().catch(async () => ({ text: await res.text().catch(() => '') }));
        if (!res.ok) {
          lastErr = (data && (data.error || data.message)) || ('HF ASR ' + res.status);
          continue;
        }
        const text = typeof data === 'string' ? data : (data.text || (data[0] && data[0].text) || '');
        if (text && String(text).trim()) return { text: String(text).trim(), provider: 'hf-asr:' + model };
      } catch (e) { lastErr = e.message || String(e); }
    }
  }
  throw new Error(String(lastErr).slice(0, 240));
}

async function groqChat(messages, system, reasoning = false) {
  const keys = groqKeys();
  if (!keys.length) throw new Error('no groq');
  const primary = String(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim() || 'openai/gpt-oss-120b';
  const models = [primary, 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'].filter(function(m,i,a){return m && a.indexOf(m)===i;});
  const sys = system || 'Ты ChatClaud. Отвечай на языке пользователя. Не раскрывай название модели, провайдера, API, ключи или внутреннюю инфраструктуру. Если спрашивают кто ты — отвечай: «Я ChatClaud». Будь очень точным, проверяй логику и не выдумывай факты.';
  const msgs = normalizeChatMessages((messages || []).slice(-20), sys).map(m => ({ role:m.role, content:String(m.content||'').slice(0,9000) }));
  let lastErr='empty';
  for (const key of keys) for (const model of models) {
    try {
      const body={model,messages:msgs,max_completion_tokens:reasoning?12000:8000,temperature:reasoning?0.45:0.55,top_p:0.95,include_reasoning:false};
      if (model.startsWith('openai/gpt-oss-')) body.reasoning_effort = reasoning ? 'high' : 'medium';
      const res=await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)},55000);
      const data=await res.json().catch(()=>({}));
      if(!res.ok){lastErr=(data.error&&data.error.message)||('groq '+res.status);continue;}
      const t=data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content;
      if(t&&String(t).trim()) return {text:sanitizeProviderIdentity(String(t).trim()),provider:'chatclaud'};
      lastErr='empty response';
    } catch(e){lastErr=e.message||String(e)}
  }
  throw new Error(String(lastErr).slice(0,220));
}
function sanitizeProviderIdentity(text){
  let s=String(text||'');
  s=s.replace(/\b(OpenAI|GPT(?:-?OSS)?|Claude|Anthropic|Gemini|Google AI|Grok|xAI|Llama|Meta AI|Mistral|Groq|DeepSeek|Copilot|OpenRouter|Hugging\s*Face|HF)\b/gi,'ChatClaud');
  s=s.replace(/\b(as an? (AI|language model) (made by|from|by|powered by) [^.\n]+)/gi,'as ChatClaud');
  s=s.replace(/\b(I('m| am) (an? )?(AI )?(assistant|model) (from|by|built by) [^.\n]+)/gi,"I'm ChatClaud");
  s=s.replace(/\b(my training (data|cutoff)|knowledge cutoff)[^.\n]*/gi,'I use current ChatClaud knowledge and live search when available');
  return s;
}

const CC_SYSTEM = `You are ChatClaud — independent AI by milanmichaimilan / ChatClaud.
Today is October 5, 2026 (use real current date when asked; never invent September 13 2026 unless search says so).
Never claim to be OpenAI, GPT, Claude, Anthropic, Gemini, Google, Grok, xAI, Llama, Meta, Mistral, Groq, DeepSeek, Copilot, OpenRouter or any third-party API.
If asked who you are: "I'm ChatClaud."
Match user language (English or Russian).
When Live web results are provided, USE them, prefer facts from those sources, and mention links when helpful.
Commands: /search /find /img /veo /plus /settings.
Be direct and useful.`;


function mistralKeys() {
  const out = [];
  const seen = new Set();
  const names = [
    'MISTRAL_API_KEY', 'MISTRAL_API_KEY_1', 'MISTRAL_API_KEY_2',
    'MISTRAL_KEY', 'MISTRAL_KEY_1', 'MISTRAL_KEY_2',
    'MINSTRAL_API_KEY', 'MINSTRAL_KEY', 'MINSTRAL_AIP_KEY'
  ];
  for (const name of names) {
    const v = String(process.env[name] || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

async function mistralChat(messages, system) {
  const keys = mistralKeys();
  if (!keys.length) throw new Error('no mistral');
  const configured = String(process.env.MISTRAL_MODEL || '').trim();
  const models = [configured, 'mistral-medium-latest', 'mistral-small-latest', 'mistral-large-latest']
    .filter((m, i, a) => m && a.indexOf(m) === i);
  const sys = system || 'Ты ChatClaud. Отвечай на языке пользователя. Помни контекст диалога.';
  const msgs = [{ role: 'system', content: sys }].concat(
    (messages || []).slice(-20).filter((m) => m && m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 5000),
    }))
  );
  let lastErr = 'empty';
  for (const key of keys) {
    for (const model of models) try {
      const res = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages: msgs, max_tokens: 8000, temperature: 0.5 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = (data.error && (data.error.message || data.error)) || ('mistral ' + res.status);
        console.log('[mistral] key ending ...' + key.slice(-4), 'model', model, '-> HTTP', res.status, JSON.stringify(data).slice(0, 200));
        continue;
      }
      const t = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (t && String(t).trim()) return { text: String(t).trim(), provider: 'mistral:' + model };
    } catch (e) { lastErr = e.message || String(e); }
  }
  throw new Error(String(lastErr).slice(0, 200));
}

async function hfChat(messages, system) {
  const keys = typeof hfKeys === 'function' ? hfKeys() : [
    process.env.HF_KEY || process.env.HF_KEY2 || process.env.HF_KEY_1 || '',
    process.env.HF_KEY_2 || process.env.HF_KEY2 || '',
  ].filter(Boolean);
  if (!keys.length) throw new Error('no hf');

  // только chat-compatible на router.huggingface.co
  const models = [
    'deepseek-ai/DeepSeek-R1:fastest',
    'openai/gpt-oss-120b:fastest',
    'Qwen/Qwen2.5-72B-Instruct:fastest',
    'meta-llama/Llama-3.3-70B-Instruct:fastest',
    'Qwen/Qwen2.5-32B-Instruct:fastest',
  ];

  const msgs = normalizeChatMessages(
    (messages || []).slice(-20),
    system || 'Ты ChatClaud. Сентябрь 2026. Помни диалог. Отвечай на языке пользователя.'
  ).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }));

  let lastErr = 'empty';
  for (let ki = 0; ki < keys.length; ki++) {
    for (let mi = 0; mi < models.length; mi++) {
      try {
        const res = await fetchWithTimeout('https://router.huggingface.co/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keys[ki] },
          body: JSON.stringify({ model: models[mi], messages: msgs, max_tokens: 1200, temperature: 0.55 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = (data.error && (data.error.message || data.error)) || ('HF ' + res.status);
          continue;
        }
        const t = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (t && String(t).trim()) return { text: String(t).trim(), provider: 'hf:' + models[mi] };
      } catch (e) { lastErr = e.message || String(e); }
    }
  }
  throw new Error(String(lastErr).slice(0, 200));
}



async function hfEnhancePrompt(userPrompt, kind) {
  const keys = hfKeys();
  if (!keys.length) return userPrompt;
  const sys = kind === 'video'
    ? 'Expand this into a detailed cinematic video prompt in English. Motion, camera, lighting. Max 80 words. Output ONLY the prompt.'
    : 'Expand this into a detailed photorealistic image prompt in English. 8k, sharp. Max 70 words. Output ONLY the prompt.';
  const models = [
    process.env.HF_PROMPT_MODEL || 'HuggingFaceH4/zephyr-7b-beta',
    'mistralai/Mistral-7B-Instruct-v0.2',
  ];
  for (const key of keys) {
    for (const model of models) {
      try {
        const r = await fetch('https://api-inference.huggingface.co/models/' + model, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: sys + '\n\nUser: ' + userPrompt + '\n\nPrompt:',
            parameters: { max_new_tokens: 120, temperature: 0.7, return_full_text: false },
          }),
        });
        if (!r.ok) continue;
        const data = await r.json();
        let t = '';
        if (Array.isArray(data) && data[0] && data[0].generated_text) t = data[0].generated_text;
        else if (data.generated_text) t = data.generated_text;
        t = String(t || '').replace(/^Prompt:\s*/i, '').trim();
        if (t.length > 15) return t.slice(0, 500);
      } catch (e) {}
    }
  }
  return userPrompt;
}

async function hfTextToImage(prompt, opts) {
  const keys = hfKeys();
  if (!keys.length) throw new Error('HF keys not set');
  const model = (opts && opts.model) || process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell';
  const w = (opts && opts.width) || 768;
  const h = (opts && opts.height) || 1344;
  let lastErr = '';
  for (const key of keys) {
    try {
      const r = await fetch('https://api-inference.huggingface.co/models/' + model, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { width: w, height: h, num_inference_steps: 4 },
        }),
      });
      if (!r.ok) {
        lastErr = await r.text().catch(() => 'hf ' + r.status);
        continue;
      }
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await r.json();
        if (j.error) { lastErr = j.error; continue; }
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 500) { lastErr = 'empty image'; continue; }
      const b64 = 'data:image/jpeg;base64,' + buf.toString('base64');
      return { url: b64, model };
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new Error(String(lastErr).slice(0, 180) || 'HF image failed');
}


/* ========== Runway Imagine (image + video) ========== */
function runwayKey() {
  return process.env.RUNWAYML_API_SECRET || process.env.RUNWAY_API_KEY || process.env.RUNWAY_KEY || '';
}
const RUNWAY_BASE = 'https://api.dev.runwayml.com';
const RUNWAY_VER = '2024-11-06';

async function runwayFetch(path, body) {
  const key = runwayKey();
  if (!key) throw new Error('Runway key not configured');
  const r = await fetch(RUNWAY_BASE + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'X-Runway-Version': RUNWAY_VER,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error || data.message || data.failure || ('Runway HTTP ' + r.status);
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
    err.statusCode = r.status;
    throw err;
  }
  return data;
}

async function runwayGetTask(id) {
  const key = runwayKey();
  if (!key) throw new Error('Runway key not configured');
  const r = await fetch(RUNWAY_BASE + '/v1/tasks/' + encodeURIComponent(id), {
    headers: {
      Authorization: 'Bearer ' + key,
      'X-Runway-Version': RUNWAY_VER,
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || 'task poll failed');
  return data;
}

async function runwayWaitTask(id, maxMs) {
  const deadline = Date.now() + (maxMs || 180000);
  let last = null;
  while (Date.now() < deadline) {
    last = await runwayGetTask(id);
    const st = String(last.status || '').toUpperCase();
    if (st === 'SUCCEEDED' || st === 'SUCCESS') return last;
    if (st === 'FAILED' || st === 'CANCELLED') {
      throw new Error(last.failure || last.failureCode || 'Generation failed');
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('Generation timed out');
}

/** Daily limits free: 5 images, 2 videos (by IP) */
const imagineUsage = new Map();
function imagineDayKey(ip, kind) {
  const d = new Date().toISOString().slice(0, 10);
  return d + '|' + kind + '|' + (ip || 'x');
}
function checkImagineLimit(ip, kind, isPlus) {
  const max = kind === 'video' ? (isPlus ? 15 : 2) : (isPlus ? 50 : 5);
  const k = imagineDayKey(ip, kind);
  const n = imagineUsage.get(k) || 0;
  if (n >= max) return { ok: false, left: 0, max, used: n };
  return { ok: true, left: max - n, max, used: n };
}
function bumpImagine(ip, kind) {
  const k = imagineDayKey(ip, kind);
  imagineUsage.set(k, (imagineUsage.get(k) || 0) + 1);
}


async function webSearch(q, type) {
  const query = String(q || '').trim().slice(0, 300);
  if (query.length < 2) return { text: '', sources: [], type: type || 'search' };

  const searchType = ['videos', 'images', 'news', 'search'].includes(type) ? type : 'search';
  const parts = [];
  const sources = [];

  // 1) NOVA primary — real sites + live data
  try {
    const data = await novaRequest('/api/search', { q: query, type: searchType });
    const items = (data && (data.organic || data.results || data.videos || data.images || data.news)) || [];
    if (data && data.answer) parts.push({ title: 'Summary', text: data.answer, url: '', src: 'nova' });
    (Array.isArray(items) ? items : []).slice(0, 10).forEach((r) => {
      parts.push({
        title: r.title || r.name || '',
        text: r.snippet || r.description || r.content || r.text || r.date || '',
        url: r.link || r.url || '',
        src: 'nova',
        imageUrl: r.imageUrl || r.thumbnailUrl || r.image || '',
      });
    });
  } catch (e) {
    console.warn('[search] nova', e.message);
  }

  // 2) Tavily fallback only if Nova weak
  const tavily = process.env.TAVILY_KEY || process.env.TAVILY_API_KEY || '';
  if (tavily && searchType === 'search' && parts.length < 2) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavily,
          query,
          search_depth: 'basic',
          include_answer: true,
          max_results: 5,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.answer) parts.push({ title: 'Summary', text: data.answer, url: '', src: 'tavily' });
        (data.results || []).forEach((r) => {
          parts.push({
            title: r.title || '',
            text: r.content || r.snippet || '',
            url: r.url || '',
            src: 'tavily',
          });
        });
      }
    } catch (e) {
      console.warn('[search] tavily', e.message);
    }
  }

  // 3) Serper last
  const serper = process.env.SERPER_KEY || '';
  if (serper && parts.length < 2) {
    try {
      const endpoints = {
        search: 'https://google.serper.dev/search',
        videos: 'https://google.serper.dev/videos',
        images: 'https://google.serper.dev/images',
        news: 'https://google.serper.dev/news',
      };
      const res = await fetch(endpoints[searchType] || endpoints.search, {
        method: 'POST',
        headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 6, gl: 'us', hl: 'en' }),
      });
      if (res.ok) {
        const data = await res.json();
        const items =
          (searchType === 'videos' && data.videos) ||
          (searchType === 'images' && data.images) ||
          (searchType === 'news' && data.news) ||
          data.organic || [];
        (items || []).forEach((r) => {
          parts.push({
            title: r.title || '',
            text: r.snippet || r.description || r.date || '',
            url: r.link || r.url || '',
            src: 'serper',
          });
        });
      }
    } catch (e) {}
  }

  parts.forEach((p) => {
    if (p.url && sources.length < 10) sources.push({ title: p.title || p.url, url: p.url, src: p.src || 'web' });
  });

  let text = parts
    .map((p, i) => {
      let line = i + 1 + '. ' + (p.title || '');
      if (p.url) line += '\n' + p.url;
      if (p.text) line += '\n' + String(p.text).slice(0, 240);
      return line;
    })
    .join('\n\n')
    .slice(0, 5500);

  if (!text) text = 'Nothing found for this query.';
  return { text, sources, count: parts.length, type: searchType, query };
}


function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
  };
  return map[ext] || 'application/octet-stream';
}

function safeJoin(root, reqPath) {
  try {
    const rootResolved = path.resolve(root);
    const decoded = decodeURIComponent(String(reqPath || '/').split('?')[0]);
    const relative = decoded.replace(/^[/\\]+/, '');
    const full = path.resolve(rootResolved, relative);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
    return full;
  } catch (_) {
    return null;
  }
}

/* ========== Netlify server-side deploy ========== */
function crc32Buffer(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function makeStoredZip(filename, content) {
  const name = Buffer.from(filename, 'utf8');
  const data = Buffer.from(content, 'utf8');
  const crc = crc32Buffer(data);
  const local = Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
  const central = Buffer.concat([Buffer.from([0x50,0x4b,0x01,0x02]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
  const end = Buffer.concat([Buffer.from([0x50,0x4b,0x05,0x06]), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
  return Buffer.concat([local, central, end]);
}
async function netlifyDeploy(htmlContent, siteName) {
  const token = String(process.env.NETLIFY_DEPLOY_TOKEN || process.env.NETLIFY_TOKEN || '').trim();
  if (!token) throw new Error('NETLIFY_DEPLOY_TOKEN не задан');
  let html = String(htmlContent || '');
  if (!/<html[\s>]/i.test(html)) html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatClaud</title></head><body>' + html + '</body></html>';
  const cleanName = String(siteName || ('chatclaud-' + Date.now().toString(36))).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 45) || ('cc-' + Date.now().toString(36));
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  let site = null;
  const siteId = String(process.env.NETLIFY_SITE_ID || '').trim();
  if (siteId) {
    const r = await fetchWithTimeout('https://api.netlify.com/api/v1/sites/' + encodeURIComponent(siteId), { headers: { Authorization: 'Bearer ' + token } }, 30000);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || 'Netlify site недоступен');
    site = d;
  } else {
    let r = await fetchWithTimeout('https://api.netlify.com/api/v1/sites', { method: 'POST', headers, body: JSON.stringify({ name: cleanName, force_ssl: true }) }, 30000);
    let d = await r.json().catch(() => ({}));
    if (!r.ok) {
      r = await fetchWithTimeout('https://api.netlify.com/api/v1/sites', { method: 'POST', headers, body: JSON.stringify({ name: cleanName + '-' + Date.now().toString(36).slice(-5), force_ssl: true }) }, 30000);
      d = await r.json().catch(() => ({}));
    }
    if (!r.ok) throw new Error(d.message || d.error || ('Netlify HTTP ' + r.status));
    site = d;
  }
  const zip = makeStoredZip('index.html', html);
  const dep = await fetchWithTimeout('https://api.netlify.com/api/v1/sites/' + encodeURIComponent(site.id) + '/deploys', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/zip' },
    body: zip
  }, 90000);
  const d = await dep.json().catch(() => ({}));
  if (!dep.ok) throw new Error(d.message || d.error || ('Deploy HTTP ' + dep.status));
  return d.ssl_url || d.url || site.ssl_url || site.url || ('https://' + site.name + '.netlify.app');
}

const MIN_AI_RESPONSE_MS = 19000;
const MIN_AI_RESPONSE_SHORT_MS = 6000;
function waitAtLeast(startedAt, ms) { const left=Math.max(0, ms-(Date.now()-startedAt)); return left?new Promise(r=>setTimeout(r,left)):Promise.resolve(); }
function pickThinkMs(messages) {
  try {
    const last = (messages || []).slice().reverse().find(m => m && (m.role === 'user' || m.role === 'human'));
    const t = String((last && last.content) || '').trim();
    if (t.length > 0 && t.length <= 40 && !/https?:|найди|поищи|search|code|код|нарисуй|\/img|\/search|\/nova/i.test(t)) return MIN_AI_RESPONSE_SHORT_MS;
  } catch (e) {}
  return MIN_AI_RESPONSE_MS;
}

/* ========== SERVER ========== */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  /* --- /api/chat --- */
  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const isPlusUser = !!(body.plus || body.isPlus);
      const rate = checkRate(req, isPlusUser);
      if (!rate.ok) {
        return send(res, 429, {
          error: rate.plus
            ? ('Лимит Plus: ' + rate.hard + ' сообщений. Подожди ~' + rate.waitMin + ' мин (с момента лимита +3 часа).')
            : ('Лимит Free: ' + rate.hard + ' сообщений. Подожди ~' + rate.waitMin + ' мин (с момента лимита +3 часа).'),
          waitMin: rate.waitMin,
          rate: rate,
          code: 'RATE_LIMIT'
        });
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return send(res, 400, { error: 'messages required' });
      const trimmed = messages.slice(-30);
      let novaSourcesForClient = [];

      /* === URL enrichment через Nova === */
      try {
        let lastUser = '';
        let lastIdx = -1;
        for (let i = trimmed.length - 1; i >= 0; i--) {
          if (trimmed[i] && trimmed[i].role === 'user') {
            lastUser = String(trimmed[i].content || '');
            lastIdx = i;
            break;
          }
        }
        const urlMatch = lastUser.match(/https?:\/\/[^\s<>"']+/i);
        if (urlMatch && lastIdx >= 0) {
          /* 1) fetch-url */
          try {
            const page = await novaRequest('/api/fetch-url', { url: urlMatch[0] });
            if (page && page.ok) {
              let context = '';
              if (page.type === 'video') {
                context = '[Ссылка на видео]\nНазвание: ' + (page.title || '—')
                  + '\nКанал: ' + (page.channel || '—')
                  + '\nОписание: ' + (page.description || '—')
                  + '\nСубтитры: ' + (page.subtitles ? String(page.subtitles).slice(0, 3000) : '(нет)');
              } else {
                context = '[Ссылка на страницу]\nЗаголовок: ' + (page.title || '—')
                  + '\nТекст:\n' + String(page.text || '').slice(0, 5000);
              }
              trimmed[lastIdx] = { role: 'user', content: lastUser + '\n\n' + context };
            }
          } catch (e) {
            console.warn('nova fetch-url', e.message);
          }

          /* 2) social-deep для TikTok/Instagram */
          if (/tiktok\.com|instagram\.com/i.test(urlMatch[0])) {
            try {
              const social = await novaRequest('/api/social-deep', { url: urlMatch[0] });
              if (social && social.ok) {
                let sctx = '[Соцсеть: ' + (social.platform || '—') + ']\n';
                if (social.author) sctx += 'Автор: @' + social.author + '\n';
                if (social.authorNick) sctx += 'Имя: ' + social.authorNick + '\n';
                if (social.title) sctx += 'Описание: ' + social.title + '\n';
                if (social.music) sctx += 'Музыка: ' + social.music + '\n';
                if (social.duration) sctx += 'Длительность: ' + social.duration + '\n';
                sctx += 'Лайки: ' + Number(social.likes || 0).toLocaleString('ru-RU') + '\n';
                sctx += 'Комментарии: ' + Number(social.comments || 0).toLocaleString('ru-RU') + '\n';
                if (social.plays) sctx += 'Просмотры: ' + Number(social.plays).toLocaleString('ru-RU') + '\n';
                if (social.shares) sctx += 'Репосты: ' + Number(social.shares).toLocaleString('ru-RU') + '\n';
                if (social.saves) sctx += 'Сохранения: ' + Number(social.saves).toLocaleString('ru-RU') + '\n';

                const likesNum = Number(social.likes || 0);
                const commentsNum = Number(social.comments || 0);
                const playsNum = Number(social.plays || 0);
                let vibe = '';
                if (playsNum > 0) {
                  const eng = (likesNum + commentsNum) / playsNum;
                  if (eng > 0.15) vibe = 'очень высокая вовлечённость — людям реально нравится';
                  else if (eng > 0.08) vibe = 'хорошая вовлечённость';
                  else if (eng > 0.03) vibe = 'средняя вовлечённость';
                  else vibe = 'низкая вовлечённость';
                }
                if (likesNum > 100000) vibe += (vibe ? ', ' : '') + 'вирусное видео';
                else if (likesNum > 10000) vibe += (vibe ? ', ' : '') + 'популярное видео';
                if (vibe) sctx += '\nОценка реакции людей: ' + vibe + '\n';

                if (Array.isArray(social.topComments) && social.topComments.length) {
                  sctx += '\nТоп-комментарии:\n';
                  social.topComments.slice(0, 5).forEach((c, i) => {
                    c = c || {};
                    sctx += (i + 1) + '. "' + String(c.text || '') + '" — ' + Number(c.likes || 0) + ' лайков\n';
                  });
                }
                sctx += '\nОтвечай так, как будто ты сам посмотрел это видео и считываешь реакцию людей.';
                trimmed[lastIdx] = { role: 'user', content: lastUser + '\n\n' + sctx };
              }
            } catch (e) {
              console.warn('nova social-deep', e.message);
            }
          }
        }
      } catch (e) {
        console.warn('enrich error', e.message);
      }

      /* === Общий веб-поиск через Nova, если это не ссылка и не видео === */
      try {
        let lastUser3 = '';
        let lastIdx3 = -1;
        for (let i = trimmed.length - 1; i >= 0; i--) {
          if (trimmed[i] && trimmed[i].role === 'user') { lastUser3 = String(trimmed[i].content || ''); lastIdx3 = i; break; }
        }
        const hasUrlAlready = /https?:\/\/[^\s<>"']+/i.test(lastUser3);
        const greetingRe = /^(привет|здравствуй|хай|hello|hi|ку|йо|как дела|спасибо|пока|ок|окей|да|нет)\W*$/i;
        let q3 = lastUser3.trim();
        // Always search when user asks to find / look up (any message count)
        const intentSearch = /(?:^|\s)(\/search|\/find|\/seasch|\/nova|найди|поищи|загугли|погугли|search\b|find\b|look\s*up|google\b|новост)/i.test(q3)
          || /^(найди|поищи|загугли|погугли|search|find)\b/i.test(q3)
          || (/\b(tiktok|тикток|youtube|ютуб)\b/i.test(q3) && /(найди|поищи|видео|ролик)/i.test(q3));
        const forceSearch = intentSearch
          || /^\/search\b/i.test(q3)
          || /^\/find\b/i.test(q3)
          || /^\/seasch\b/i.test(q3)
          || /^\/nova\b/i.test(q3)
          || /^(найди|поищи|загугли|погугли)\b/i.test(q3)
          || /^(search|find|look\s*up|google)\b/i.test(q3)
          || /(поищи|найди).{0,12}(ещ[её]|again|once more)/i.test(q3)
          || /(search|find).{0,12}(again|more)/i.test(q3);
        if (/^\/(search|seasch|nova)\b/i.test(q3)) q3 = q3.replace(/^\/(search|seasch|nova)\s*/i, '').trim();
        const looksLikeQuery = false; // search ONLY when forceSearch
        // video queries still go through search (Nova can resolve TikTok etc.)
        if (forceSearch && lastIdx3 >= 0 && q3.length >= 2) {
          console.log('[nova-search] querying:', q3.slice(0, 100), 'force=', !!forceSearch);
          const sr = await webSearch(q3, forceSearch ? 'search' : 'search');
          const hasText = sr && sr.text && String(sr.text).trim().length > 20;
          const srcs = (sr && Array.isArray(sr.sources)) ? sr.sources : [];
          if (hasText || srcs.length) {
            console.log('[nova-search] ok text=', hasText, 'sources=', srcs.length);
            const block = hasText ? String(sr.text).slice(0, 12000) : srcs.map(s => (s.title||'') + ' ' + (s.url||'')).join('\n');
            trimmed[lastIdx3] = {
              role: 'user',
              content: lastUser3 + '\n\n[Свежие данные из веб-поиска Nova — используй для точного ответа, не выдумывай]\n' + block,
            };
            novaSourcesForClient = srcs;
          } else {
            console.log('[nova-search] empty result');
          }
        }
      } catch (e) {
        console.warn('[nova-search] error', e.message);
      }

      /* video shortcut */
      try {
        let lastUser2 = '';
        for (let i = trimmed.length - 1; i >= 0; i--) {
          if (trimmed[i] && trimmed[i].role === 'user') {
            lastUser2 = String(trimmed[i].content || '');
            break;
          }
        }
        const videoHit = await handleVideoSearch(lastUser2);
        if (videoHit && videoHit.text) {
          videoHit.left = rate.left;
          return send(res, 200, videoHit);
        }
      } catch (e) {}

      const aiStartedAt = Date.now();
      let result = null;
      let lastErr = null;
      const failures = [];
      const isReasoning = !!body.reason || /^(think|reason|reasoning)$/i.test(String(body.mode || ''));
      const providers = isReasoning
        ? [['groq', () => groqChat(trimmed, [CC_SYSTEM, body.system].filter(Boolean).join('\n\n'), true)], ['hf', () => hfChat(trimmed, [CC_SYSTEM, body.system].filter(Boolean).join('\n\n'))], ['mistral', () => mistralChat(trimmed, [CC_SYSTEM, body.system].filter(Boolean).join('\n\n'))]]
        : [['groq', () => groqChat(trimmed, [CC_SYSTEM, body.system].filter(Boolean).join('\n\n'), false)], ['mistral', () => mistralChat(trimmed, [CC_SYSTEM, body.system].filter(Boolean).join('\n\n'))], ['hf', () => hfChat(trimmed, [CC_SYSTEM, body.system].filter(Boolean).join('\n\n'))]];
      for (const [name, call] of providers) {
        try {
          result = await call();
          if (result && result.text) break;
        } catch (e) {
          lastErr = e.message || String(e);
          const safe = publicProviderError(e);
          failures.push(name + ': ' + safe);
          console.error('[ChatClaud provider failed]', name + ':', safe);
        }
      }
      if (!result || !result.text) {
        return send(res, 503, {
          error: 'Сервер не подключён к рабочему каналу ИИ.',
          code: 'NO_PROVIDER',
          details: failures.slice(0, 6),
        });
      }
      await waitAtLeast(aiStartedAt, pickThinkMs(trimmed));
      result.left = rate.left;
      result.rate = rate;
      result.provider = 'chatclaud';
      result.sources = novaSourcesForClient;
      return send(res, 200, result);
    } catch (e) {
      return send(res, 503, { error: e.message || 'ChatClaud сервер перегружен.' });
    }
  }

  /* --- /api/fetch-url --- */
  if (pathname === '/api/fetch-url' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const raw = String(body.url || '').trim();
      if (!isSafeUrl(raw)) return send(res, 400, { error: 'Недопустимый URL' });
      let result = null;
      try { result = await novaRequest('/api/fetch-url', { url: raw }); } catch (e) {}
      if (!result || !result.ok) result = await fetchUrlContent(raw, Math.min(18000, Number(body.maxLength) || 12000));
      return send(res, 200, result);
    } catch (e) { return send(res, e.statusCode || 503, { error: e.message || 'Не удалось открыть сайт' }); }
  }

  /* --- /api/transcribe --- */
  if (pathname === '/api/transcribe' && req.method === 'POST') {
    console.log('[transcribe] request received');
    try {
      const rate = checkRate(req);
      if (!rate.ok) return send(res, 429, { error: 'Лимит. Подожди ~' + rate.waitMin + ' мин.' });
      const body = await readBody(req);
      const dataUrl = String(body.audio || body.dataUrl || '');
      console.log('[transcribe] payload length:', dataUrl.length);
      const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
      if (!m) { console.log('[transcribe] FAILED: bad data URL format, prefix was:', dataUrl.slice(0, 40)); return send(res, 400, { error: 'audio required' }); }
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) { console.log('[transcribe] FAILED: empty buffer after decode'); return send(res, 400, { error: 'empty audio' }); }
      console.log('[transcribe] calling hfTranscribe, bytes:', buf.length, 'mime:', m[1], '| hfKeys count:', hfKeys().length);
      const result = await hfTranscribe(buf, m[1], body.language || '');
      console.log('[transcribe] SUCCESS:', JSON.stringify(result).slice(0, 150));
      return send(res, 200, result);
    } catch (e) {
      console.log('[transcribe] FAILED ->', e.message || e);
      return send(res, e.statusCode || 503, { error: e.message || 'transcription failed' });
    }
  }

  /* --- /api/deploy --- */
  if (pathname === '/api/deploy' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const html = String(body.html || '');
      if (html.length < 20) return send(res, 400, { error: 'html required' });
      if (html.length > 8 * 1024 * 1024) return send(res, 413, { error: 'project too large' });
      const slug = String(body.slug || body.name || 'site').slice(0, 80);
      const url = await netlifyDeploy(html, 'chatclaud-' + slug.replace(/[^a-zA-Z0-9-]/g, '-'));
      return send(res, 200, { ok: true, url });
    } catch (e) { return send(res, e.statusCode || 503, { error: e.message || 'deploy failed' }); }
  }

  /* --- /api/vision --- */
  if (pathname === '/api/vision' && req.method === 'POST') {
    console.log('[vision] request received');
    try {
      const rate = checkRate(req);
      if (!rate.ok) return send(res, 429, { error: 'Лимит. Подожди ~' + rate.waitMin + ' мин.' });
      const body = await readBody(req);
      const img = body.image || body.dataUrl || '';
      console.log('[vision] image payload length:', img.length, '| hfKeys count:', hfKeys().length);
      if (!img || img.length < 20) { console.log('[vision] FAILED: no image in body'); return send(res, 400, { error: 'image required' }); }
      let result = null;
      try {
        result = await hfVision(img, body.prompt);
        console.log('[vision] SUCCESS via', result.provider);
      } catch (e) {
        console.log('[vision] FAILED ->', e.message || e);
        return send(res, 503, { error: 'Vision недоступен: ' + String(e.message || e).slice(0, 180) });
      }
      return send(res, 200, result);
    } catch (e) {
      console.log('[vision] TOP-LEVEL FAILED ->', e.message || e);
      return send(res, 503, { error: e.message || 'vision fail' });
    }
  }

  /* --- /api/search --- */
  
  /* --- /api/imagine/image --- */
  if (pathname === '/api/imagine/image' && req.method === 'POST') {
    try {
      if (!runwayKey()) return send(res, 503, { error: 'Imagine not configured' });
      const body = await readBody(req);
      let prompt = String(body.prompt || body.text || '').trim().slice(0, 900);
      if (prompt.length < 2) return send(res, 400, { error: 'prompt required' });
      const isPlus = !!body.plus;
      const lim = checkImagineLimit(clientIp(req), 'image', isPlus);
      if (!lim.ok) return send(res, 429, { error: 'Daily image limit reached', left: 0, max: lim.max });
      const enhance = body.enhance !== false;
      if (enhance) {
        try { prompt = await hfEnhancePrompt(prompt, 'image'); } catch (e) {}
      }
      const ratio = String(body.ratio || 'portrait');
      const dims = ratio === 'landscape' ? { width: 1344, height: 768 }
        : ratio === 'square' ? { width: 1024, height: 1024 }
        : { width: 768, height: 1344 };
      // Prefer HuggingFace (free-ish) then Runway if configured
      try {
        const hf = await hfTextToImage(prompt, dims);
        bumpImagine(clientIp(req), 'image');
        const left = checkImagineLimit(clientIp(req), 'image', isPlus).left;
        return send(res, 200, { ok: true, url: hf.url, type: 'image', model: hf.model, prompt, left, provider: 'chatclaud-imagine' });
      } catch (hfErr) {
        console.warn('[imagine image hf]', hfErr.message);
      }
      if (!runwayKey()) return send(res, 503, { error: 'Image generator unavailable' });
      const model = String(body.model || process.env.RUNWAY_IMAGE_MODEL || 'gen4_image_turbo');
      const task = await runwayFetch('/v1/text_to_image', {
        model: model === 'gen4_image' ? 'gen4_image' : 'gen4_image_turbo',
        promptText: prompt,
        ratio: ratio === 'landscape' ? '1920:1080' : ratio === 'square' ? '1440:1440' : '1080:1920',
      });
      const id = task.id || task.task_id;
      if (!id) return send(res, 502, { error: 'No task id from Runway' });
      const done = await runwayWaitTask(id, 120000);
      const out = (done.output && done.output[0]) || done.output || (done.artifacts && done.artifacts[0] && done.artifacts[0].url);
      const url = typeof out === 'string' ? out : (out && (out.url || out.uri)) || '';
      if (!url) return send(res, 502, { error: 'No image output' });
      bumpImagine(clientIp(req), 'image');
      const left = checkImagineLimit(clientIp(req), 'image', isPlus).left;
      return send(res, 200, { ok: true, url, type: 'image', model, left, provider: 'chatclaud-imagine' });
    } catch (e) {
      return send(res, e.statusCode || 503, { error: e.message || 'Image generation failed' });
    }
  }

  /* --- /api/imagine/video --- */
  if (pathname === '/api/imagine/video' && req.method === 'POST') {
    try {
      if (!runwayKey()) return send(res, 503, { error: 'Imagine not configured' });
      const body = await readBody(req);
      let prompt = String(body.prompt || body.text || '').trim().slice(0, 900);
      if (prompt.length < 2) return send(res, 400, { error: 'prompt required' });
      const isPlus = !!body.plus;
      const lim = checkImagineLimit(clientIp(req), 'video', isPlus);
      if (!lim.ok) return send(res, 429, { error: 'Daily video limit reached', left: 0, max: lim.max });
      if (body.enhance !== false) {
        try { prompt = await hfEnhancePrompt(prompt, 'video'); } catch (e) {}
      }
      if (!runwayKey()) {
        return send(res, 503, { error: 'Video needs RUNWAYML_API_SECRET or use Photo mode (HF)', prompt });
      }
      const model = String(body.model || process.env.RUNWAY_VIDEO_MODEL || 'gen4.5');
      const ratio = String(body.ratio || '720:1280');
      const duration = Math.min(10, Math.max(2, Number(body.duration) || 5));
      const payload = {
        model: model,
        promptText: prompt,
        ratio: ratio,
        duration: duration,
      };
      if (body.imageUrl) payload.promptImage = body.imageUrl;
      const path = body.imageUrl ? '/v1/image_to_video' : '/v1/text_to_video';
      const task = await runwayFetch(path, payload);
      const id = task.id || task.task_id;
      if (!id) return send(res, 502, { error: 'No task id from Runway' });
      const done = await runwayWaitTask(id, 300000);
      const out = (done.output && done.output[0]) || done.output;
      const url = typeof out === 'string' ? out : (out && (out.url || out.uri)) || '';
      if (!url) return send(res, 502, { error: 'No video output' });
      bumpImagine(clientIp(req), 'video');
      const left = checkImagineLimit(clientIp(req), 'video', isPlus).left;
      return send(res, 200, { ok: true, url, type: 'video', model, left, provider: 'chatclaud-imagine' });
    } catch (e) {
      return send(res, e.statusCode || 503, { error: e.message || 'Video generation failed' });
    }
  }

  /* --- /api/imagine/limits --- */
  if (pathname === '/api/imagine/limits' && req.method === 'GET') {
    const isPlus = (req.url || '').includes('plus=1');
    const ip = clientIp(req);
    const img = checkImagineLimit(ip, 'image', isPlus);
    const vid = checkImagineLimit(ip, 'video', isPlus);
    return send(res, 200, {
      image: { used: img.used, left: img.left, max: img.max },
      video: { used: vid.used, left: vid.left, max: vid.max },
      hasRunway: !!runwayKey(),
    });
  }


  if (pathname === '/api/search' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await webSearch(body.q || body.query || '', body.type || body.searchType || 'search');
      return send(res, 200, result);
    } catch (e) {
      return send(res, 503, { error: e.message || 'search failed' });
    }
  }

  /* --- /api/admin/check --- */
  if (pathname === '/api/admin/check' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const secret = process.env.ADMIN_SECRET || '';
      const supplied = String(body.secret || '');
      if (!secret || supplied.length < 8 || supplied !== secret) {
        return send(res, 403, { ok: false, error: 'forbidden' });
      }
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { ok: false, error: 'bad request' });
    }
  }

  /* --- /api/plus/grant --- */
  if (pathname === '/api/plus/grant' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const secret = process.env.PLUS_BOT_SECRET || process.env.ADMIN_SECRET || '';
      if (!secret || body.secret !== secret) return send(res, 403, { error: 'forbidden' });
      const username = normalizeUsername(body.username);
      const months = Math.min(12, Math.max(1, parseInt(body.months, 10) || 1));
      if (!/^[a-z0-9_]{3,32}$/.test(username)) return send(res, 400, { error: 'bad username' });
      const store = readPlusStore();
      const now = Date.now();
      const cur = store[username] && store[username].plusUntil ? new Date(store[username].plusUntil).getTime() : 0;
      const base = Math.max(now, cur);
      const plusUntil = new Date(base + months * 30 * 24 * 3600 * 1000).toISOString();
      store[username] = {
        username, plus: true, plusUntil, months,
        telegramId: body.telegramId || null,
        updatedAt: new Date().toISOString(),
        email: body.email || (store[username] && store[username].email) || null,
      };
      writePlusStore(store);
      console.log('PLUS grant', username, plusUntil);
      return send(res, 200, { ok: true, username, plusUntil, months });
    } catch (e) {
      return send(res, 500, { error: e.message || 'grant fail' });
    }
  }

  /* --- /api/plus/check --- */
  if (pathname === '/api/plus/check' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      let username = '';
      if (req.method === 'GET') username = normalizeUsername(u.searchParams.get('username') || '');
      else {
        const body = await readBody(req);
        username = normalizeUsername(body.username || '');
      }
      if (!username) return send(res, 400, { error: 'username required' });
      const store = readPlusStore();
      const row = store[username];
      if (!row || !row.plusUntil) return send(res, 200, { ok: true, plus: false, username });
      const active = new Date(row.plusUntil).getTime() > Date.now();
      return send(res, 200, { ok: true, plus: active, username, plusUntil: row.plusUntil, email: row.email || null });
    } catch (e) {
      return send(res, 500, { error: e.message || 'check fail' });
    }
  }

  /* --- /api/health --- */
  
  if (pathname === '/api/keycheck' && req.method === 'GET') {
    return send(res, 200, {
      groqKeys: groqKeys().length,
      openAiKeys: 0,
      claudeKeys: 0,
      openRouterKeys: 0,
      note: 'Проверяется только наличие ключей. Секреты не возвращаются.'
    });
  }

  
  if (pathname === '/api/video-summary' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const url = String((body && (body.url || body.q)) || '').trim();
      if (!url) return send(res, 400, { error: 'url required' });
      let title = '', description = '', channel = '', outUrl = url;
      const ytId = youtubeVideoId(url);
      if (ytId) {
        const yt = await fetchYouTube(ytId);
        title = yt.title || '';
        description = yt.description || '';
        channel = yt.channel || '';
        outUrl = yt.url || url;
      } else {
        const oe = await fetchOembed(url);
        if (oe) {
          title = oe.title || '';
          channel = oe.author_name || oe.author || '';
          description = oe.description || '';
          outUrl = oe.url || url;
        }
      }
      if (!title && !description) {
        return send(res, 200, {
          text: 'Не удалось получить данные по видео. Ссылка: ' + url,
          sources: [{ title: 'Video', url: url }]
        });
      }
      const text = [
        title ? ('Видео: ' + title) : '',
        channel ? ('Канал: ' + channel) : '',
        description ? ('Описание: ' + String(description).slice(0, 900)) : '',
        'Ссылка: ' + outUrl
      ].filter(Boolean).join('\n');
      return send(res, 200, {
        text,
        sources: [{ title: title || 'Video', url: outUrl }],
        meta: { title, channel, description: String(description).slice(0, 500), url: outUrl }
      });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e).slice(0, 200) });
    }
  }

  if (pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      hasGroq: (typeof groqKeys === "function" ? groqKeys().length > 0 : !!(process.env.GROQ_KEY||process.env.GROQ_API_KEY)),
      hasMistral: (typeof mistralKeys === "function" ? mistralKeys().length > 0 : !!process.env.MISTRAL_API_KEY),
      mistralModel: process.env.MISTRAL_MODEL || 'mistral-medium-latest',
      groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      minAiResponseMs: MIN_AI_RESPONSE_MS,
      hasOpenAI: false,
      openAiKeys: 0,
      hasClaude: false,
      claudeKeys: 0,
      hasHf: hfKeys().length > 0, // HF_TOKEN/HF_KEY
      hasTavily: !!process.env.TAVILY_KEY,
      hasSerper: !!process.env.SERPER_KEY,
      hasNova: !!((process.env.NOVA_URL || 'https://nova-brawser.onrender.com') && (process.env.NOVA_API_TOKEN || process.env.NOVA_AIP_TOKEN || process.env.API_TOKEN)),
      hasFetchUrl: true,
      hasTranscribe: hfKeys().length > 0,
      hasNetlifyDeploy: !!(process.env.NETLIFY_DEPLOY_TOKEN || process.env.NETLIFY_TOKEN || process.env.NETLIFY_SITE_ID),
      maxBodyBytes: MAX_BODY_BYTES,
      hasSocialDeep: true,
       novaUrl: process.env.NOVA_URL || 'https://nova-brawser.onrender.com',
      hasPlusSecret: !!(process.env.PLUS_BOT_SECRET || process.env.ADMIN_SECRET),
      limitFree: RATE_FREE_HARD,
      limitPlus: RATE_PLUS_HARD,
      windowHours: 3,
      cooldownHours: 3,
    });
  }

  /* --- Static --- */
  let filePath = safeJoin(ROOT, pathname === '/' ? '/index.html' : pathname);
  if (!filePath) return send(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filePath) && pathname === '/') {
    const alt = path.join(ROOT, 'ChatClaud_NO_KEYS.html');
    if (fs.existsSync(alt)) filePath = alt;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      const index = path.join(ROOT, 'index.html');
      const alt = path.join(ROOT, 'ChatClaud_NO_KEYS.html');
      const fallback = fs.existsSync(index) ? index : alt;
      if (fallback && fs.existsSync(fallback)) {
        return fs.readFile(fallback, (e2, html) => {
          if (e2) return send(res, 404, { error: 'not found' });
          send(res, 200, html, 'text/html; charset=utf-8');
        });
      }
      return send(res, 404, { error: 'not found' });
    }
    send(res, 200, data, contentType(filePath));
  });
});

server.listen(PORT, HOST, () => {
  console.log('ChatClaud server on port', PORT);
});
server.on('error', (err) => console.error('ChatClaud server error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
