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
const ENABLE_SHELL = process.env.ENABLE_SHELL === '1';
const UNSAFE_EXEC = process.env.UNSAFE_EXEC === '1';
const AUTO_RESTORE = process.env.AUTO_RESTORE === '1';

const groq = new Groq({ apiKey: GROQ_API_KEY });

// hidden backup for self-edit
const HIDDEN_BACKUP = path.join(__dirname, '.autobak_secret_do_not_move');
const FILES_TO_PROTECT = ['server.js', 'index.html', 'package.json'];

function makeBackupOnce(){
  try{
    if (!fs.existsSync(HIDDEN_BACKUP)) {
      fs.mkdirSync(HIDDEN_BACKUP);
      for (const f of FILES_TO_PROTECT) {
        const src = path.join(__dirname, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HIDDEN_BACKUP, f));
      }
      console.log('Created hidden backup.');
    }
  }catch(e){ console.warn('Backup failed:', e.message); }
}
makeBackupOnce();

if (AUTO_RESTORE){
  for (const f of FILES_TO_PROTECT){
    const bak = path.join(HIDDEN_BACKUP, f);
    const dst = path.join(__dirname, f);
    if (fs.existsSync(bak)) fs.copyFileSync(bak, dst);
  }
  console.log('Auto-restored protected files from hidden backup.');
}

app.use(express.json({ limit: '4mb' }));
app.use((req,res,next)=>{ res.setHeader('X-Powered-By','groq-talk-v4'); next(); });

// Serve SPA
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));
app.get('/health', (_req,res)=>res.json({ok:true}));

// --- Chat (non-stream) for fallback
app.post('/api/chat', async (req,res)=>{
  try{
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });
    const { messages, system, model } = req.body || {};
    const sys = system || [
      "You are a helpful assistant.",
      "You CAN browse via POST /api/fetch {url, summarize:true}.",
      "When you need to browse, say: PLAN: fetching <url> and then proceed.",
      "Do not paste raw HTML. Summarize key points and include the primary link."
    ].join("\n");
    const msgs = [{ role:'system', content: sys }, ...(messages||[])];
    const completion = await groq.chat.completions.create({
      model: model || CHAT_MODEL,
      messages: msgs,
      temperature: 0.5,
      stream: false
    });
    const text = completion.choices?.[0]?.message?.content ?? '';
    res.json({ text });
  }catch(e){
    const details = e.response?.data || String(e);
    console.error('chat_failed', details);
    res.status(500).json({ error: 'chat_failed', details });
  }
});

// --- Chat (streaming)
app.post('/api/chat-stream', async (req, res) => {
  try{
    if (!GROQ_API_KEY) { res.status(500).end('error: Missing GROQ_API_KEY'); return; }
    const { messages, system, model } = req.body || {};
    const sys = system || [
      "You are a helpful assistant.",
      "You CAN browse via POST /api/fetch {url, summarize:true}.",
      "When you need to browse, say: PLAN: fetching <url> and then proceed.",
      "Do not paste raw HTML. Summarize key points and include the primary link."
    ].join("\n");
    const msgs = [{ role:'system', content: sys }, ...(messages||[])];
    res.setHeader('Content-Type','text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding','chunked');
    const stream = await groq.chat.completions.create({
      model: model || CHAT_MODEL,
      messages: msgs,
      temperature: 0.5,
      stream: true
    });
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content ?? '';
      if (delta) res.write(delta);
    }
    res.end();
  }catch(e){
    console.error('chat_stream_failed', e.response?.data || e);
    try{ res.end('\n'); }catch{}
  }
});

// --- STT: Whisper v3 Turbo
app.post('/api/stt', upload.single('audio'), async (req,res)=>{
  try{
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
  }catch(e){
    const details = e.response?.data || String(e);
    console.error('stt_failed', details);
    res.status(500).json({ error: 'stt_failed', details });
  }
});

// --- TTS: playai-tts
app.post('/api/tts', async (req,res)=>{
  try{
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
    res.setHeader('Content-Type','audio/wav');
    res.send(buf);
  }catch(e){
    const details = e.response?.data || String(e);
    console.error('tts_failed', details);
    res.status(500).json({ error: 'tts_failed', details });
  }
});

// --- Fetch & summarize page
app.post('/api/fetch', async (req,res)=>{
  try{
    let { url, userAgent, summarize } = req.body || {};
    if (!url) return res.status(400).json({ error:'Invalid URL' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      timeout: 20000, maxRedirects: 5, validateStatus: s => s < 400 || s === 404
    });
    const html = String(resp.data || '');
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    let text = $('main').text() || $('article').text() || $('body').text() || '';
    text = text.replace(/\s+/g,' ').trim().slice(0, 8000);

    let about = null;
    if (summarize && GROQ_API_KEY){
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
      ].join('\\n');
      const completion = await groq.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: 'You are an expert web summarizer. Be concise. No raw HTML.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        stream: false
      });
      about = completion.choices?.[0]?.message?.content ?? null;
    }
    res.json({ status: resp.status, title, desc, about });
  }catch(e){
    const details = e.response?.data || String(e);
    res.status(500).json({ error: 'fetch_failed', details });
  }
});

// --- Owner: shell
const blocked = [/rm\\s+-rf/i, /\\bshutdown\\b/i, /\\breboot\\b/i, /\\bhalt\\b/i, /\\bmkfs\\b/i, /\\bdd\\s+/i, /\\bnetcat\\b|\\bnc\\b/i];
app.post('/api/exec', async (req,res)=>{
  try{
    const { password, command, cwd } = req.body || {};
    if (!ENABLE_SHELL) return res.status(403).json({ error:'shell_disabled' });
    if (password !== OWNER_PASSWORD) return res.status(401).json({ error:'unauthorized' });
    if (!command || !command.trim()) return res.status(400).json({ error:'no_command' });
    if (!UNSAFE_EXEC && blocked.some(rx => rx.test(command))) return res.status(400).json({ error:'blocked_command' });
    const { stdout, stderr } = await exec(command, { timeout: 15000, cwd: cwd || process.cwd() });
    res.json({ ok:true, stdout, stderr });
  }catch(e){ res.status(500).json({ error:'exec_failed', details:String(e) }); }
});

// --- Owner: self-edit
app.post('/api/self-edit', async (req,res)=>{
  try{
    const { password, filename, content } = req.body || {};
    if (password !== OWNER_PASSWORD) return res.status(401).json({ error:'unauthorized' });
    if (!['server.js','index.html','package.json'].includes(filename)) return res.status(400).json({ error:'file_not_allowed' });
    const target = path.join(__dirname, filename);
    await fs.promises.writeFile(target, content, 'utf8');
    // Restart the server after self-edit
    exec('pm2 restart server.js', (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({ error: 'Server restart failed', details: stderr });
      }
      res.json({ ok: true });
    });
  }catch(e){ res.status(500).json({ error:'self_edit_failed', details:String(e) }); }
});

// --- Owner: stop
app.post('/api/stop', (req,res)=>{
  const { password } = req.body || {};
  if (password !== OWNER_PASSWORD) return res.status(401).json({ error:'unauthorized' });
  res.json({ ok:true, message:'Stopping server' });
  setTimeout(()=>process.exit(0), 120);
});

// 404
app.use((req,res)=>res.status(404).json({ error:'not_found' }));

app.listen(PORT, ()=>{
  console.log(`Server listening on http://localhost:${PORT}`);
  if (!GROQ_API_KEY) console.log('NOTE: Set GROQ_API_KEY to use chat/STT/TTS.');
});

