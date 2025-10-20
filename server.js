
import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import Groq from 'groq-sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const exec = promisify(execCb);
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const PORT = process.env.PORT || 8000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const CHAT_MODEL = process.env.MODEL || 'llama-3.3-70b-versatile';
const TTS_MODEL = process.env.TTS_MODEL || 'playai-tts';
const DEFAULT_VOICE = process.env.TTS_VOICE || 'Fritz-PlayAI';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '252912';
const ENABLE_SHELL = process.env.ENABLE_SHELL === '1';        // opt-in for /api/exec
const UNSAFE_EXEC = process.env.UNSAFE_EXEC === '1';          // bypass blocklist (not recommended)
const AUTO_RESTORE = process.env.AUTO_RESTORE === '1';        // restore code from backup on boot

const groq = new Groq({ apiKey: GROQ_API_KEY });

const HIDDEN_BACKUP = path.join(__dirname, '.autobak_secret_do_not_move');
const FILES_TO_PROTECT = ['server.js', 'index.html', 'package.json'];

// Create hidden backup once
if (!fs.existsSync(HIDDEN_BACKUP)) {
  fs.mkdirSync(HIDDEN_BACKUP);
  for (const f of FILES_TO_PROTECT) {
    const src = path.join(__dirname, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(HIDDEN_BACKUP, f));
    }
  }
  console.log('Created hidden backup.');
}

// Optional: auto-restore originals on boot
if (AUTO_RESTORE) {
  for (const f of FILES_TO_PROTECT) {
    const bak = path.join(HIDDEN_BACKUP, f);
    const dst = path.join(__dirname, f);
    if (fs.existsSync(bak)) fs.copyFileSync(bak, dst);
  }
  console.log('Auto-restored protected files from hidden backup.');
}

app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'groq-talk-mode-v3');
  next();
});

// Serve SPA
app.get('/', (req, res) => {
  const p = path.join(__dirname, 'index.html');
  if (fs.existsSync(p)) res.sendFile(p);
  else res.status(404).send('index.html not found');
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Chat
app.post('/api/chat', async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });
    const { messages, system, model } = req.body || {};
    const sys = system || [
      "You are a helpful assistant.",
      "You CAN browse via the tool: call POST /api/fetch with {url, summarize:true}.",
      "DO NOT claim you cannot browse. Always request approval before running commands or editing files.",
      "When asked to 'plan' or 'thinking', output a short public plan labeled: PLAN: ... (no chain-of-thought).",
      "When summarizing a web page, return a brief description, key bullets, and the main link. Do not dump raw HTML."
    ].join("\\n");

    const msgs = [{ role: 'system', content: sys }, ...(messages || [])];
    const completion = await groq.chat.completions.create({
      model: model || CHAT_MODEL,
      messages: msgs,
      temperature: 0.5,
      stream: false
    });
    const text = completion.choices?.[0]?.message?.content ?? '';
    res.json({ text, raw: completion });
  } catch (e) {
    const details = e.response?.data || String(e);
    console.error('chat_failed', details);
    res.status(500).json({ error: 'chat_failed', details });
  }
});

// STT via Groq Whisper
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });
    if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    const tr = await groq.audio.transcriptions.create({
      model: 'whisper-large-v3-turbo',
      file: blob,
      response_format: 'text'
    });
    const out = typeof tr === 'string' ? tr : (tr?.text ?? '');
    res.json({ text: out });
  } catch (e) {
    const details = e.response?.data || String(e);
    console.error('stt_failed', details);
    res.status(500).json({ error: 'stt_failed', details });
  }
});

// TTS via Groq SDK
app.post('/api/tts', async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });
    const { text, voice, format } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });
    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      input: text,
      voice: voice || DEFAULT_VOICE,
      response_format: (format || 'wav').toLowerCase()
    });
    const buf = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    res.send(buf);
  } catch (e) {
    const details = e.response?.data || String(e);
    console.error('tts_failed', details);
    res.status(500).json({ error: 'tts_failed', details });
  }
});

// Fetcher with optional summarize=true (returns about info, not raw HTML)
app.post('/api/fetch', async (req, res) => {
  try {
    const { url, userAgent, summarize } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid URL' });
    const resp = await axios.get(url, {
      headers: { 'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: s => s < 400 || s === 404
    });
    const html = String(resp.data || '');
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    // crude text extraction
    let text = $('main').text() || $('article').text() || $('body').text() || '';
    text = text.replace(/\s+/g,' ').trim().slice(0, 8000);

    let summary = null;
    if (summarize && GROQ_API_KEY) {
      const prompt = [
        `URL: ${url}`,
        `Title: ${title || '(none)'}`,
        `Description: ${desc || '(none)'}`,
        `Extracted text (may be partial): ${text.slice(0,3000)}`,
        ``,
        `Summarize in this format:`, 
        `ABOUT: <one-sentence>`, 
        `KEY POINTS: <3-6 bullets>`, 
        `PRIMARY LINK: ${url}`
      ].join('\n');

      const completion = await groq.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: 'You are an expert web summarizer. Be concise. No raw HTML.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        stream: false
      });
      summary = completion.choices?.[0]?.message?.content ?? null;
    }

    res.json({
      status: resp.status,
      headers: resp.headers,
      title, desc,
      about: summary,
      // keep a tiny preview for debugging; client won't show it
      preview: html.slice(0, 400)
    });
  } catch (e) {
    const details = e.response?.data || String(e);
    res.status(500).json({ error: 'fetch_failed', details });
  }
});

// Owner-only: run shell
const blocked = [/rm\\s+-rf/i, /\\bshutdown\\b/i, /\\breboot\\b/i, /\\bhalt\\b/i, /\\bmkfs\\b/i, /\\bdd\\s+/i, /\\bnetcat\\b|\\bnc\\b/i, /\\bwget\\b.*http/i, /\\bcurl\\b.*http/i];
app.post('/api/exec', async (req, res) => {
  try {
    const { password, command, cwd } = req.body || {};
    if (!ENABLE_SHELL) return res.status(403).json({ error: 'shell_disabled' });
    if (password !== OWNER_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
    if (!command || !command.trim()) return res.status(400).json({ error: 'no_command' });
    if (!UNSAFE_EXEC && blocked.some(rx => rx.test(command))) {
      return res.status(400).json({ error: 'blocked_command' });
    }
    const { stdout, stderr } = await exec(command, { timeout: 15000, cwd: cwd || process.cwd() });
    res.json({ ok: true, stdout, stderr });
  } catch (e) {
    res.status(500).json({ error: 'exec_failed', details: String(e) });
  }
});

// Owner-only: allow self-edit (with backup protection)
app.post('/api/self-edit', async (req, res) => {
  try {
    const { password, filename, content } = req.body || {};
    if (password !== OWNER_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
    if (!FILES_TO_PROTECT.includes(filename)) return res.status(400).json({ error: 'file_not_allowed' });
    const target = path.join(__dirname, filename);
    // write
    await fs.promises.writeFile(target, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'self_edit_failed', details: String(e) });
  }
});

// Owner-only: stop server (kills the node process)
app.post('/api/stop', async (req, res) => {
  const { password } = req.body || {};
  if (password !== OWNER_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, message: 'Stopping server' });
  setTimeout(()=> process.exit(0), 100);
});

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  if (!GROQ_API_KEY) console.log('NOTE: Set GROQ_API_KEY to use chat/STT/TTS.');
});
