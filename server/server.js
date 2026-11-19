const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DB_FILE = path.join(__dirname, 'db.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (_) {}
  return {};
}

function getGeminiKey() {
  return process.env.GEMINI_API_KEY || readConfig().geminiApiKey || '';
}

function readBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function requestModel(modelName, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (apiRes) => {
        let out = '';
        apiRes.on('data', (c) => (out += c));
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(out);
            if (apiRes.statusCode >= 400 || parsed.error) {
              return reject(new Error(parsed.error?.message || `HTTP ${apiRes.statusCode}`));
            }
            const rawText = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const cleaned = rawText.replace(/```json|```/gi, '').trim();
            let result = JSON.parse(cleaned);
            if (Array.isArray(result)) result = result[0] || {};
            resolve(result);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callGeminiVision(apiKey, imageDataUrl, docType) {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const mimeType = match[1];
  const base64Data = match[2];

  const prompt = `You are an expert HR document OCR extractor. Analyze this image of a ${docType || 'work / identity document'}.
Carefully find:
1. Full person's name (in Arabic or English, whichever is clearer).
2. Document/Identity/Passport/Residency number.
3. EXPIRY DATE: Look for words like "تاريخ الانتهاء", "ينتهي في", "Date of Expiry", "Expiry Date", "Valid Until", or date in passport MRZ zone.
4. Occupation / Job title if visible.

Return ONLY a single valid JSON object strictly matching this schema with NO commentary:
{
  "employeeName": "full name as string",
  "docNumber": "document number without spaces",
  "expiryDate": "YYYY-MM-DD",
  "jobTitle": "job title or empty"
}
If expiry date is in format DD/MM/YYYY, DD-MM-YYYY, or DD Month YYYY, you MUST convert it to YYYY-MM-DD.`;

  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });

  const candidateModels = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
  let lastErr = null;
  for (const m of candidateModels) {
    try {
      return await requestModel(m, apiKey, payload);
    } catch (err) {
      lastErr = err;
      console.warn(`Model ${m} failed:`, err.message);
    }
  }
  throw lastErr || new Error('All vision models failed');
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/state' && req.method === 'GET') {
    if (!fs.existsSync(DB_FILE)) {
      res.writeHead(404);
      return res.end();
    }
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(raw);
  }

  if (urlPath === '/api/state' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
      return sendJson(res, 200, { ok: true });
    } catch (_) {
      return sendJson(res, 400, { error: 'Invalid JSON' });
    }
  }

  if (urlPath === '/api/attendance/checkin' && req.method === 'POST') {
    try {
      const body = await readBody(req, 1024 * 1024);
      const { employeeId, date, checkIn } = JSON.parse(body);
      const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) : {};
      if (!Array.isArray(db.attendanceLogs)) db.attendanceLogs = [];

      // Check if already checked in without checkout
      const existing = db.attendanceLogs.find((l) => l.employeeId === employeeId && !l.checkOut);
      if (!existing) {
        db.attendanceLogs.push({
          id: 'att_' + Date.now(),
          employeeId,
          date,
          checkIn: checkIn || new Date().toISOString(),
          checkOut: null
        });
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
      }
      return sendJson(res, 200, { ok: true, attendanceLogs: db.attendanceLogs });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (urlPath === '/api/attendance/checkout' && req.method === 'POST') {
    try {
      const body = await readBody(req, 1024 * 1024);
      const { employeeId, checkOut } = JSON.parse(body);
      const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) : {};
      if (!Array.isArray(db.attendanceLogs)) db.attendanceLogs = [];

      const activeLog = db.attendanceLogs.find((l) => l.employeeId === employeeId && !l.checkOut);
      if (activeLog) {
        activeLog.checkOut = checkOut || new Date().toISOString();
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
      }
      return sendJson(res, 200, { ok: true, attendanceLogs: db.attendanceLogs });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (urlPath === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { hasGeminiKey: Boolean(getGeminiKey()) });
  }

  if (urlPath === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req, 1024 * 1024);
      const { geminiApiKey } = JSON.parse(body);
      const cfg = readConfig();
      cfg.geminiApiKey = (geminiApiKey || '').trim();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
      return sendJson(res, 200, { ok: true, hasGeminiKey: Boolean(cfg.geminiApiKey) });
    } catch (_) {
      return sendJson(res, 400, { error: 'Invalid config' });
    }
  }

  if (urlPath === '/api/ocr' && req.method === 'POST') {
    const apiKey = getGeminiKey();
    if (!apiKey) {
      return sendJson(res, 501, { error: 'GEMINI_API_KEY not configured' });
    }
    try {
      const body = await readBody(req);
      const { imageDataUrl, docType } = JSON.parse(body);
      const data = await callGeminiVision(apiKey, imageDataUrl, docType);
      return sendJson(res, 200, { ok: true, source: 'gemini', ...data });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Fotat HR Server running on http://localhost:${PORT}`);
});
