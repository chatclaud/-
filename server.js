/**
 * ChatClaud — сервер для Render
 * Env: GROQ_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, TAVILY_KEY, SERPER_KEY,
 *      NOVA_URL, NOVA_API_TOKEN, PLUS_BOT_SECRET, PORT
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
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

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
  else res.end(JSON.stringify(body));
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
  const configuredBase = (process.env.NOVA_URL || '').replace(/\/$/, '');
  const base = configuredBase;
  const token = process.env.NOVA_AIP_TOKEN || process.env.NOVA_API_TOKEN || process.env.API_TOKEN || '';
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const RATE_LIMIT = 50000;
const RATE_WINDOW_MS = 3 * 60 * 60 * 1000;
const rateMap = new Map();
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}
function checkRate(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let e = rateMap.get(ip);
  if (!e || now - e.start >= RATE_WINDOW_MS) {
    e = { start: now, count: 0 };
    rateMap.set(ip, e);
  }
  e.count += 1;
  if (e.count > RATE_LIMIT) {
    const waitMin = Math.max(1, Math.ceil((e.start + RATE_WINDOW_MS - now) / 60000));
    return { ok: false, left: 0, waitMin };
  }
  return { ok: true, left: Math.max(0, RATE_LIMIT - e.count), waitMin: 0 };
}

function hfKeys() {
  const out = [];
  const seen = new Set();
  const push = (v) => { v = String(v || '').trim(); if (v && !seen.has(v)) { seen.add(v); out.push(v); } };
  ['HF_KEY','HF_KEY_1','HF_KEY_2','HF_KEY_3','HUGGINGFACE_KEY','HUGGINGFACE_KEY_2','HUGGINGFACE_TOKEN'].forEach(k => push(process.env[k]));
  Object.keys(process.env).forEach(k => { if (/^HF_/i.test(k) || /HUGGINGFACE/i.test(k)) push(process.env[k]); });
  return out;
}
async function hfVision(imageDataUrl, prompt) {
  const keys = hfKeys();
  if (!keys.length) throw new Error('no hf vision');
  const models = [
    'Qwen/Qwen2.5-VL-72B-Instruct',
    'Qwen/Qwen2.5-VL-32B-Instruct',
    'meta-llama/Llama-3.2-11B-Vision-Instruct',
    'Qwen/Qwen2-VL-7B-Instruct',
  ];
  const visionPrompt = prompt || 'Опиши изображение по-русски.';
  let lastErr = 'empty';
  for (const key of keys) {
    for (const model of models) {
      try {
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
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


function openaiKeys() {
  const out = [];
  const seen = new Set();
  const names = ['OPENAI_API_KEY','OPENAI_KEY','OPENAI_KEY_1','OPENAI_KEY_2','OPENAI_API_KEY_1','OPENAI_API_KEY_2'];
  for (const k of names) {
    const v = String(process.env[k] || '').trim();
    if (v && !seen.has(v) && /^sk-[A-Za-z0-9_-]+$/.test(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function anthropicKeys() {
  const out = [];
  const seen = new Set();
  const names = ['ANTHROPIC_API_KEY','ANTHROPIC_KEY','ANTHROPIC_KEY_1','ANTHROPIC_KEY_2','CLAUDE_API_KEY','CLAUDE_KEY','CLAUDE_KEY_1'];
  for (const k of names) {
    const v = String(process.env[k] || '').trim();
    if (v && !seen.has(v) && /^(sk-ant-|sk-ant-api)/.test(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function normalizeChatMessages(messages, system) {
  const sys = system || 'Ты ChatClaud. Отвечай на языке пользователя. Не упоминай внутренние API, ключи и служебные детали.';
  return [{ role: 'system', content: String(sys).slice(0, 8000) }].concat(
    (messages || []).slice(-20).map((m) => ({
      role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 8000),
    }))
  );
}

async function openaiChat(messages, system, reasoning = false) {
  const keys = openaiKeys();
  if (!keys.length) throw new Error('OpenAI key не задан');
  const configured = String(process.env.OPENAI_MODEL || '').trim();
  const models = configured ? [configured] : (reasoning
    ? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
    : ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  const input = normalizeChatMessages(messages, system);
  let lastErr = 'OpenAI: empty';
  for (const key of keys) {
    for (const model of models) {
      try {
        const body = {
          model,
          input,
          max_output_tokens: reasoning ? 2200 : 1500,
        };
        if (reasoning) body.reasoning = { effort: 'medium' };
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = (data.error && (data.error.message || data.error.code)) || ('OpenAI ' + res.status);
          continue;
        }
        let text = typeof data.output_text === 'string' ? data.output_text : '';
        if (!text && Array.isArray(data.output)) {
          const parts = [];
          for (const item of data.output) {
            if (!Array.isArray(item.content)) continue;
            for (const c of item.content) if (typeof c.text === 'string') parts.push(c.text);
          }
          text = parts.join('\n');
        }
        if (text && text.trim()) return { text: text.trim(), provider: 'openai:' + model };
        lastErr = 'OpenAI empty response';
      } catch (e) { lastErr = e.message || String(e); }
    }
  }
  throw new Error(String(lastErr).slice(0, 280));
}

async function anthropicChat(messages, system, reasoning = false) {
  const keys = anthropicKeys();
  if (!keys.length) throw new Error('Claude key не задан');
  const configured = String(process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || '').trim();
  const models = configured ? [configured] : (reasoning
    ? ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']
    : ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5']);
  const all = normalizeChatMessages(messages, system);
  const sys = all[0].content;
  const msgs = all.slice(1);
  let lastErr = 'Claude: empty';
  for (const key of keys) {
    for (const model of models) {
      try {
        const body = {
          model,
          max_tokens: reasoning ? 2200 : 1500,
          system: sys,
          messages: msgs,
        };
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = (data.error && (data.error.message || data.error.type)) || ('Claude ' + res.status);
          continue;
        }
        const text = Array.isArray(data.content)
          ? data.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n')
          : '';
        if (text && text.trim()) return { text: text.trim(), provider: 'claude:' + model };
        lastErr = 'Claude empty response';
      } catch (e) { lastErr = e.message || String(e); }
    }
  }
  throw new Error(String(lastErr).slice(0, 280));
}


async function openaiVision(imageDataUrl, prompt) {
  const keys = openaiKeys();
  if (!keys.length) throw new Error('OpenAI key не задан');
  const models = [String(process.env.OPENAI_VISION_MODEL || '').trim(), 'gpt-5.6-luna', 'gpt-5.6-terra'].filter(Boolean);
  const textPrompt = prompt || 'Опиши изображение по-русски подробно.';
  let lastErr = 'OpenAI vision empty';
  for (const key of keys) for (const model of models) {
    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          input: [{ role: 'user', content: [
            { type: 'input_text', text: textPrompt },
            { type: 'input_image', image_url: imageDataUrl },
          ]}],
          max_output_tokens: 1000,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { lastErr = (data.error && data.error.message) || ('OpenAI vision ' + res.status); continue; }
      let text = typeof data.output_text === 'string' ? data.output_text : '';
      if (!text && Array.isArray(data.output)) for (const item of data.output) for (const c of (item.content || [])) if (typeof c.text === 'string') text += c.text;
      if (text.trim()) return { text: text.trim(), provider: 'openai-vision:' + model };
    } catch (e) { lastErr = e.message || String(e); }
  }
  throw new Error(String(lastErr).slice(0, 250));
}

function groqKeys() {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    v = String(v || '').trim();
    if (!v || !/^gsk_[A-Za-z0-9_-]+$/.test(v) || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  [
    'GROQ_KEY', 'GROQ_KEY_1', 'GROQ_KEY_2', 'GROQ_KEY_3',
    'GROQ_API_KEY', 'GROQ_API_KEY_1'
  ].forEach((k) => push(process.env[k]));
  return out;
}

async function groqChat(messages, system) {
  const keys = groqKeys();
  if (!keys.length) throw new Error('no groq');
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it', 'mixtral-8x7b-32768', 'llama3-70b-8192'];
  const sys = system || 'Ты ChatClaud. 13 сентября 2026. Отвечай на языке пользователя. Не называй чужие бренды.';
  const msgs = [{ role: 'system', content: sys }].concat(
    (messages || []).slice(-16).map((m) => ({
      role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000),
    }))
  );
  let lastErr = 'empty';
  for (const key of keys) {
    for (const model of models) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify({ model, messages: msgs, max_tokens: 1500, temperature: 0.6 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          lastErr = (data.error && data.error.message) || ('groq ' + res.status);
          continue;
        }
        const t = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (t && String(t).trim()) return { text: String(t).trim(), provider: 'groq:' + model };
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
  }
  throw new Error(String(lastErr).slice(0, 200));
}

function mistralKeys() {
  const out = [];
  const seen = new Set();
  const names = [
    'MISTRAL_API_KEY', 'MISTRAL_KEY', 'MISTRAL_KEY_1', 'MISTRAL_KEY_2',
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
  const model = String(process.env.MISTRAL_MODEL || 'mistral-medium-latest').trim();
  const sys = system || 'Ты ChatClaud. Отвечай на языке пользователя. Помни контекст диалога.';
  const msgs = [{ role: 'system', content: sys }].concat(
    (messages || []).slice(-20).map((m) => ({
      role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 5000),
    }))
  );
  let lastErr = 'empty';
  for (const key of keys) {
    try {
      const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages: msgs, max_tokens: 1600, temperature: 0.5 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = (data.error && (data.error.message || data.error)) || ('mistral ' + res.status);
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
    process.env.HF_KEY || process.env.HF_KEY_1 || '',
    process.env.HF_KEY_2 || '',
  ].filter(Boolean);
  if (!keys.length) throw new Error('no hf');

  // только chat-compatible на router.huggingface.co
  const models = [
    'Qwen/Qwen2.5-72B-Instruct',
    'meta-llama/Llama-3.3-70B-Instruct',
    'Qwen/Qwen2.5-32B-Instruct',
    'mistralai/Mistral-Nemo-Instruct-2407',
  ];

  const sys = system || 'Ты ChatClaud. Сентябрь 2026. Помни диалог. Отвечай на языке пользователя.';
  const msgs = [{ role: 'system', content: sys }];
  (messages || []).slice(-20).forEach(function(m) {
    msgs.push({
      role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000),
    });
  });

  let lastErr = 'empty';
  for (let ki = 0; ki < keys.length; ki++) {
    for (let mi = 0; mi < models.length; mi++) {
      try {
        const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
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

async function webSearch(q, type) {
  const query = String(q || '').trim().slice(0, 300);
  if (query.length < 2) return { text: '', sources: [], type: type || 'search' };

  const searchType = ['videos', 'images', 'news', 'search'].includes(type) ? type : 'search';
  const parts = [];
  const sources = [];
  const novaUrl = process.env.NOVA_URL || 'https://nova-brawser.onrender.com';

  // Nova is the primary web-search provider. Serper/Tavily are fallbacks.
  try {
    const data = await novaRequest('/api/search', { q: query, type: searchType });
    const items = (data && (data.organic || data.results || data.videos || data.images || data.news)) || [];
    if (data && data.answer) parts.push({ title: 'Кратко', text: data.answer, url: '', src: 'nova' });
    (Array.isArray(items) ? items : []).slice(0, 8).forEach((r) => {
      parts.push({
        title: r.title || r.name || '',
        text: r.snippet || r.description || r.content || r.text || r.date || '',
        url: r.link || r.url || '',
        src: 'nova',
        imageUrl: r.imageUrl || r.thumbnailUrl || r.image || '',
      });
    });
  } catch (e) {
    console.warn('nova search', e.message);
  }

  const serper = process.env.SERPER_KEY || '';
  if (serper) {
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
        body: JSON.stringify({ q: query, num: 5, gl: 'ru', hl: 'ru' }),
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
            src: searchType,
            imageUrl: r.imageUrl || r.thumbnailUrl || '',
          });
        });
      }
    } catch (e) {}
  }

  const tavily = process.env.TAVILY_KEY || '';
  if (tavily && searchType === 'search' && parts.length < 2) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavily, query, search_depth: 'basic', include_answer: true, max_results: 5 }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.answer) parts.push({ title: 'Кратко', text: data.answer, url: '', src: 'web' });
        (data.results || []).forEach((r) => {
          parts.push({ title: r.title || '', text: r.content || r.snippet || '', url: r.url || '', src: 'web' });
        });
      }
    } catch (e) {}
  }

  parts.forEach((p) => {
    if (p.url && sources.length < 8) sources.push({ title: p.title || p.url, url: p.url });
  });

  let text = parts.map((p, i) => {
    let line = i + 1 + '. ' + (p.title || '');
    if (p.url) line += '\n' + p.url;
    if (p.text) line += '\n' + String(p.text).slice(0, 180);
    return line;
  }).join('\n\n').slice(0, 4000);

  if (!text) text = 'Ничего не найдено по запросу.';
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

/* ========== SERVER ========== */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  /* --- /api/chat --- */
  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const rate = checkRate(req);
      if (!rate.ok) {
        return send(res, 429, {
          error: 'Лимит ' + RATE_LIMIT + ' сообщений / 3 часа. Подожди ~' + rate.waitMin + ' мин.',
          waitMin: rate.waitMin,
        });
      }
      const body = await readBody(req);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) return send(res, 400, { error: 'messages required' });
      const trimmed = messages.slice(-30);

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

      let result = null;
      let lastErr = null;
      const preferGroq = /^(1|true|yes)$/i.test(String(process.env.PREFER_GROQ || ''));
      const isReasoning = !!body.reason || /^(think|reason|reasoning)$/i.test(String(body.mode || ''));
      const providers = isReasoning
        ? [
            ['openai', () => openaiChat(trimmed, body.system, true)],
            ['claude', () => anthropicChat(trimmed, body.system, true)],
            ['mistral', () => mistralChat(trimmed, body.system)],
          ]
        : preferGroq
        ? [
            ['mistral', () => mistralChat(trimmed, body.system)],
            ['groq', () => groqChat(trimmed, body.system)],
            ['openai', () => openaiChat(trimmed, body.system, false)],
            ['claude', () => anthropicChat(trimmed, body.system, false)],
          ]
        : [
            ['mistral', () => mistralChat(trimmed, body.system)],
            ['groq', () => groqChat(trimmed, body.system)],
            ['openai', () => openaiChat(trimmed, body.system, false)],
            ['claude', () => anthropicChat(trimmed, body.system, false)],
            ['hf', () => hfChat(trimmed, body.system)],
          ];
      for (const [, call] of providers) {
        try {
          result = await call();
          if (result && result.text) break;
        } catch (e) {
          lastErr = e.message || String(e);
        }
      }
      if (!result || !result.text) {
        return send(res, 503, { error: String(lastErr || 'Все каналы недоступны').slice(0, 300) });
      }
      result.left = rate.left;
      return send(res, 200, result);
    } catch (e) {
      return send(res, 503, { error: e.message || 'ChatClaud сервер перегружен.' });
    }
  }

  /* --- /api/vision --- */
  if (pathname === '/api/vision' && req.method === 'POST') {
    try {
      const rate = checkRate(req);
      if (!rate.ok) return send(res, 429, { error: 'Лимит. Подожди ~' + rate.waitMin + ' мин.' });
      const body = await readBody(req);
      const img = body.image || body.dataUrl || '';
      if (!img || img.length < 20) return send(res, 400, { error: 'image required' });
      let result = null;
      let lastErr = null;
      try { result = await hfVision(img, body.prompt); } catch (e) { lastErr = e.message; }
      if (!result || !result.text) {
        try { result = await openaiVision(img, body.prompt); } catch (e2) { lastErr = e2.message || lastErr; }
      }
      if (!result || !result.text) return send(res, 503, { error: 'Не удалось разобрать фото.' });
      return send(res, 200, result);
    } catch (e) {
      return send(res, 503, { error: e.message || 'vision fail' });
    }
  }

  /* --- /api/search --- */
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
      openAiKeys: openaiKeys().length,
      claudeKeys: anthropicKeys().length,
      openRouterKeys: 0,
      note: 'Проверяется только наличие ключей. Секреты не возвращаются.'
    });
  }

  if (pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      hasGroq: (typeof groqKeys === "function" ? groqKeys().length > 0 : !!(process.env.GROQ_KEY||process.env.GROQ_API_KEY)),
      hasMistral: (typeof mistralKeys === "function" ? mistralKeys().length > 0 : !!process.env.MISTRAL_API_KEY),
      mistralModel: process.env.MISTRAL_MODEL || 'mistral-medium-latest',
      hasOpenAI: openaiKeys().length > 0,
      openAiKeys: openaiKeys().length,
      hasClaude: anthropicKeys().length > 0,
      claudeKeys: anthropicKeys().length,
      hasHf: !!(process.env.HF_KEY || process.env.HF_KEY_1 || process.env.HUGGINGFACE_KEY),
      hasTavily: !!process.env.TAVILY_KEY,
      hasSerper: !!process.env.SERPER_KEY,
      hasNova: !!((process.env.NOVA_URL || 'https://nova-brawser.onrender.com') && (process.env.NOVA_API_TOKEN || process.env.NOVA_AIP_TOKEN || process.env.API_TOKEN)),
      hasFetchUrl: true,
      hasSocialDeep: true,
      novaUrl: process.env.NOVA_URL || 'https://nova-brawser.onrender.com',
      hasPlusSecret: !!(process.env.PLUS_BOT_SECRET || process.env.ADMIN_SECRET),
      limit: RATE_LIMIT,
      windowHours: 3,
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

server.listen(PORT, () => {
  console.log('ChatClaud server on port', PORT);
});