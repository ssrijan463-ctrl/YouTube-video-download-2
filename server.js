const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DIR = path.join(os.tmpdir(), 'ytc-files');
fs.mkdirSync(DIR, { recursive: true });

const MAX_CONCURRENT = 2;
const FILE_TTL_MS = 15 * 60 * 1000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

// ---------- Cookies (never stored in the image / repo) ----------
// Option 1: COOKIES_B64 env var (base64 of cookies.txt)
// Option 2: secret file at COOKIES_PATH (default /etc/secrets/cookies.txt) or ./cookies.txt
let COOKIE_FILE = null;
(function loadCookies() {
  const dst = path.join(os.tmpdir(), 'yt-cookies.txt'); // writable copy
  try {
    if (process.env.COOKIES_B64) {
      fs.writeFileSync(dst, Buffer.from(process.env.COOKIES_B64, 'base64'), { mode: 0o600 });
      COOKIE_FILE = dst;
    } else {
      const candidates = [process.env.COOKIES_PATH, '/etc/secrets/cookies.txt', path.join(__dirname, 'cookies.txt')].filter(Boolean);
      const found = candidates.find((f) => fs.existsSync(f));
      if (found) { fs.copyFileSync(found, dst); fs.chmodSync(dst, 0o600); COOKIE_FILE = dst; }
    }
  } catch (e) { console.error('Cookie load failed:', e.message); }
  console.log(COOKIE_FILE ? 'Cookies loaded.' : 'No cookies found (running without login).');
})();

// ---------- Helpers ----------
function toSeconds(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) throw new Error('समय का फ़ॉर्मेट गलत है (उदा. 90 या 01:30)');
  return s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

const hits = new Map(); // simple per-IP rate limit
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 6;
}

const jobs = new Map();
let running = 0;

function findFile(id) {
  return fs.readdirSync(DIR).find((f) => f.startsWith(id + '.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
}

// ---------- API ----------
app.post('/api/process', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ success: false, error: 'बहुत ज़्यादा रिक्वेस्ट, एक मिनट रुको।' });
  if (running >= MAX_CONCURRENT) return res.status(503).json({ success: false, error: 'सर्वर व्यस्त है, थोड़ी देर बाद कोशिश करो।' });

  const { url, startTime, endTime } = req.body || {};
  let parsed;
  try { parsed = new URL(String(url || '').trim()); } catch { /* fallthrough */ }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ success: false, error: 'कृपया सही वीडियो लिंक (http/https) डालें।' });
  }

  let start, end;
  try { start = toSeconds(startTime); end = toSeconds(endTime); }
  catch (e) { return res.status(400).json({ success: false, error: e.message }); }
  if (start !== null && end !== null && start >= end) {
    return res.status(400).json({ success: false, error: 'Start Time, End Time से छोटा होना चाहिए।' });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const job = { status: 'running', progress: 0, error: null, createdAt: Date.now() };
  jobs.set(id, job);
  running++;

  const args = [
    '--no-playlist', '--no-warnings', '--newline', '--restrict-filenames',
    '--js-runtimes', 'node',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', path.join(DIR, `${id}.%(ext)s`),
  ];
  if (COOKIE_FILE) args.push('--cookies', COOKIE_FILE);
  if (start !== null || end !== null) {
    args.push('--download-sections', `*${start ?? 0}-${end ?? 'inf'}`, '--force-keyframes-at-cuts');
  }
  args.push('--', parsed.href);

  const p = spawn('yt-dlp', args);
  let err = '';
  const timer = setTimeout(() => p.kill('SIGKILL'), JOB_TIMEOUT_MS);

  p.stdout.on('data', (d) => {
    const m = d.toString().match(/(\d+(?:\.\d+)?)%/g);
    if (m) job.progress = parseFloat(m[m.length - 1]);
  });
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.on('error', (e) => { err += e.message; });
  p.on('close', (code) => {
    clearTimeout(timer); running--;
    const f = findFile(id);
    if (code === 0 && f) { job.status = 'done'; job.progress = 100; job.file = f; }
    else {
      console.error('yt-dlp failed:', err.slice(-800));
      job.status = 'error';
      job.error = /confirm you.re not a bot|Sign in/i.test(err)
        ? 'YouTube ने बॉट-चेक माँगा। कुकीज़ फाइल नई डालकर सर्वर रीस्टार्ट करो।'
        : 'प्रोसेसिंग विफल। लिंक या समय जाँचो।';
    }
  });

  res.json({ success: true, jobId: id });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: 'error', error: 'जॉब नहीं मिला' });
  res.json({ status: job.status, progress: job.progress, error: job.error, downloadUrl: job.status === 'done' ? `/api/file/${req.params.id}` : null });
});

app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.file) return res.status(404).send('फाइल नहीं मिली या एक्सपायर हो गई।');
  res.download(path.join(DIR, job.file), 'video.mp4');
});

// ---------- Cleanup ----------
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > FILE_TTL_MS && job.status !== 'running') {
      if (job.file) fs.rm(path.join(DIR, job.file), { force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 60 * 1000);

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
