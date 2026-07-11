// Small zero-dependency helpers: terminal IO, HTTP(S), text utilities.
import readline from 'node:readline';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(color, s) {
  return useColor ? `${COLORS[color] || ''}${s}${COLORS.reset}` : s;
}

export const log = {
  info: (s) => console.log(s),
  ok: (s) => console.log(paint('green', s)),
  warn: (s) => console.log(paint('yellow', s)),
  err: (s) => console.error(paint('red', s)),
  dim: (s) => console.log(paint('dim', s)),
  step: (s) => console.log(paint('cyan', s)),
};
export const c = paint;

// Interactive prompt helper backed by a single readline interface.
export function createIO() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
  const askRequired = async (q) => {
    let v = '';
    while (!v) {
      v = await ask(q);
      if (!v) log.warn('  This value is required.');
    }
    return v;
  };
  const confirm = async (q, def = true) => {
    const hint = def ? '[Y/n]' : '[y/N]';
    const a = (await ask(`${q} ${hint} `)).toLowerCase();
    if (!a) return def;
    return a === 'y' || a === 'yes';
  };
  const close = () => rl.close();
  return { ask, askRequired, confirm, close };
}

// Minimal JSON HTTPS request. Returns parsed body { ok, data, status }.
export function httpsJson(urlStr, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        ...(payload != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    if (payload != null) req.write(payload);
    req.end();
  });
}

// Download a URL into memory, refusing anything over maxBytes. Chat-platform
// downloads are small by construction (Telegram caps bot downloads at 20 MB),
// so buffering keeps both the size guard and the multipart re-upload trivial.
export function httpsGetBuffer(urlStr, { timeoutMs = 120000, maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, (res) => {
      if (res.statusCode !== 200) {
        res.resume(); // drain, else the socket is held open
        return reject(new Error(`Download failed (HTTP ${res.statusCode})`));
      }
      const chunks = [];
      let received = 0;
      res.on('data', (d) => {
        received += d.length;
        if (maxBytes && received > maxBytes) {
          req.destroy();
          return reject(new Error(`File is larger than ${formatBytes(maxBytes)}`));
        }
        chunks.push(d);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Download timed out after ${timeoutMs}ms`)));
  });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// multipart/form-data POST with no dependencies. Used for both Telegram's
// sendPhoto and the speech-to-text upload. Returns { ok, status, data } like
// httpsJson. Field values and filenames land inside MIME headers, so both are
// sanitized: a filename with a CRLF in it would otherwise forge headers.
//
// http:// is honoured so a self-hosted whisper on localhost needs no TLS, but
// only for loopback: everything else would put an Authorization header and the
// user's audio on the wire in the clear.
export function multipartPost(urlStr, { fields = {}, files = [], headers = {}, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const plaintext = u.protocol === 'http:';
    if (plaintext && !LOOPBACK.has(u.hostname)) {
      return reject(new Error(`refusing to POST credentials over plain http to ${u.hostname} — use https, or a loopback address`));
    }
    const transport = plaintext ? http : https;
    const boundary = `----asideremote${randomBytes(12).toString('hex')}`;
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      if (value == null) continue;
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
    }
    for (const f of files) {
      const type = String(f.contentType || 'application/octet-stream').replace(/[^\w.+/-]/g, '');
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${sanitizeFilename(f.filename)}"\r\n` +
        `Content-Type: ${type || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
      parts.push(f.buffer);
      parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);

    const req = transport.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (plaintext ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        ...headers,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    req.write(body);
    req.end();
  });
}

// Reduce an untrusted name (chat clients let you send "../../.ssh/authorized_keys")
// to a single safe path segment.
export function sanitizeFilename(name, fallback = 'file') {
  const base = path.basename(String(name ?? ''))
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 80);
  return base || fallback;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return 'unknown size';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Split a long string into <=size pieces, trying not to cut mid-line.
export function chunkText(text, size = 3800) {
  if (text.length <= size) return [text];
  const out = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > size) {
      if (buf) out.push(buf);
      if (line.length > size) {
        for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
        buf = '';
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// Best-effort: find local image file paths referenced in agent output.
const IMG_RE = /(?:^|\s|["'(])((?:\/|\.\/|~\/)[^\s"')]+\.(?:png|jpe?g|webp|gif))/gi;
export function findImagePaths(text) {
  const found = new Set();
  let m;
  while ((m = IMG_RE.exec(text)) !== null) found.add(m[1]);
  return [...found];
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Reduce a raw agent transcript to just the answer the user should see. Works
// best on the raw pseudo-TTY output (with ANSI colours): Aside wraps its
// "Thinking" notes and tool OUTPUT in dim (\x1b[2m…\x1b[0m) and tool-call names
// in green, while the final answer is default-coloured. Stripping the dim spans
// is what reliably removes arbitrary tool output/dumps (file contents, command
// output, search results) that no line pattern could catch. After that a line
// filter drops any leftover tool-call lines and aria snapshot nodes. Returns ''
// if filtering removes everything (a transcript with no user-facing answer).
// Also accepts already-cleaned text (no colours) and line-filters best-effort.
const CLOSES_CALL = /\)\s*(\[[^\]]*\])?\s*$/;       // `…)` or `…) [toolu_id]`
const TOOL_CALL = /^[\w.]+\s*\(/;                    // bash(, read_file(, repl(, gmail.search(
// The CLI prints its own update banner on stdout, un-dimmed, so it survives the
// colour filter and lands in the chat above the answer.
const CLI_NOTICE = /^Aside CLI\b.*\bis available\b|^Run: aside --update\b/i;
const ARIA_NODE = /^-\s+(title|heading|text|paragraph|link|button|generic|image|img|list|listitem|combobox|textbox|checkbox|radio|tab|tabpanel|menu|menuitem|menubar|dialog|alertdialog|banner|navigation|main|region|article|form|table|row|cell|columnheader|rowheader|separator|status|note|alert|figure|code|blockquote|group|toolbar|tooltip|switch|slider|progressbar|searchbox|option|complementary|contentinfo|caption|document)\b/i;
export function extractAnswer(rawOrText) {
  if (!rawOrText) return '';
  let s = String(rawOrText);
  // Colour signal (pty output): dim spans = Thinking + tool output/dumps.
  s = s.replace(/\x1b\[2m[\s\S]*?\x1b\[0m/g, '');
  s = cleanTerminalOutput(s); // strip remaining ANSI + resolve tty artifacts
  const kept = [];
  let inCall = false;
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (inCall) { if (CLOSES_CALL.test(t)) inCall = false; continue; }
    if (!t) { kept.push(''); continue; }
    if (CLI_NOTICE.test(t)) continue;
    if (/^Thinking:/i.test(t)) continue;
    if (TOOL_CALL.test(t)) { if (!CLOSES_CALL.test(t)) inCall = true; continue; }
    if (/^>/.test(t)) continue;                              // tool output marker
    if (/\[ref=e?\d+\]|\[url=|\[level=\d/.test(t)) continue; // snapshot refs
    if (ARIA_NODE.test(t)) continue;                         // aria snapshot node
    kept.push(line);
  }
  // Empty means the transcript had no user-facing answer (only Thinking + tool
  // calls, or a task suspended on an approval). Return '' — NOT the raw
  // transcript — so callers show a clean placeholder instead of leaking it.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Convert a useful subset of Markdown to Telegram-flavoured HTML
// (parse_mode=HTML supports b,i,u,s,a,code,pre,blockquote). Everything else is
// HTML-escaped. Pair with a plain-text fallback if Telegram rejects the markup.
const htmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function mdToTelegramHtml(text) {
  if (!text) return '';
  const blocks = [];
  // [[CB:n]] placeholder: plain ASCII, survives htmlEsc and the link/bold/italic
  // passes, and is astronomically unlikely to occur in real agent output.
  const stash = (html) => '[[CB:' + (blocks.push(html) - 1) + ']]';
  let s = String(text);
  // Pull fenced + inline code out first so we never format inside them.
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => stash('<pre>' + htmlEsc(code.replace(/\n$/, '')) + '</pre>'));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => stash('<code>' + htmlEsc(code) + '</code>'));
  s = htmlEsc(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => '<a href="' + url + '">' + label + '</a>');
  s = s.replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>').replace(/__([^\n_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^\n~]+)~~/g, '<s>$1</s>');
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  return s.replace(/\[\[CB:(\d+)\]\]/g, (_, i) => blocks[Number(i)]);
}

// Strip ANSI/terminal control codes and resolve carriage-return overwrites,
// so output captured from a pseudo-TTY reads like the final rendered text.
export function cleanTerminalOutput(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');   // OSC
  s = s.replace(/\x1b[P_X^][^\x1b]*\x1b\\/g, '');               // DCS/PM/APC/SOS
  s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');             // CSI
  s = s.replace(/\x1b[()][0-9A-Za-z]/g, '');                    // charset
  s = s.replace(/\x1b./g, '');                                  // any leftover ESC x
  // Normalize CRLF line endings first: a pty terminates every line with \r\n,
  // so without this the trailing \r below would wipe the line's content.
  s = s.replace(/\r\n/g, '\n');
  // Collapse bare carriage-return overwrites (spinners/progress) to the last
  // non-empty segment of each line.
  s = s.split('\n').map((line) => {
    const parts = line.split('\r').filter((p) => p !== '');
    return parts.length ? parts[parts.length - 1] : '';
  }).join('\n');
  // Apply backspaces (each \b erases the preceding char) before stripping
  // control chars, so pty echo like "^D\b\b" cancels itself out instead of
  // leaving a stray "^D" behind.
  let prev;
  do { prev = s; s = s.replace(/[^\n\x08]\x08/g, ''); } while (s !== prev);
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');      // stray control chars
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
