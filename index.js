'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const CONFIG = {
  version: '1.3.0',
  repository: 'lixyraa/ZyroOS',
  minNode: 20,
  fgTimeoutSec: 600,
  defaultLogLines: 20,
  maxLogLines: 2000,
  restartDelayMs: 2000,
  maxCrashes: 10,
  crashWindowMs: 60 * 1000,
  maxLogBytes: 5 * 1024 * 1024,
  keepLogBytes: 1024 * 1024,
  updateCacheHours: 6,
  updateTimeoutMs: 3500,
  bootDelayMs: 110,
  bootHoldMs: 900,
};

const DEFAULT_SETTINGS = {
  user: 'root',
  hostname: 'zyro',
  diskLimitMb: 2048,
  checkUpdates: true,
};

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, '.zyro');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'processes.json');
const UPDATE_FILE = path.join(DATA_DIR, 'update.json');
fs.mkdirSync(LOG_DIR, { recursive: true });

const NAME_RE = /^[\w.-]{1,32}$/;
const PROC_NAME_RE = /^[\w.-]+$/;

function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.user === 'string' && NAME_RE.test(raw.user)) s.user = raw.user;
    if (typeof raw.hostname === 'string' && NAME_RE.test(raw.hostname)) s.hostname = raw.hostname;
    if (Number.isFinite(raw.diskLimitMb) && raw.diskLimitMb >= 0) s.diskLimitMb = raw.diskLimitMb;
    if (typeof raw.checkUpdates === 'boolean') s.checkUpdates = raw.checkUpdates;
  }
  return s;
}

function loadConfig() {
  let state = 'created';
  let data = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      state = 'loaded';
    } catch {
      state = 'invalid';
      try {
        fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak');
      } catch {}
    }
  }
  let list = data && Array.isArray(data.processes) ? data.processes : null;
  if (list === null && state === 'created') {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
      if (Array.isArray(legacy)) list = legacy;
    } catch {}
  }
  const processes = (list || []).filter(
    (s) => s && typeof s.name === 'string' && PROC_NAME_RE.test(s.name) && typeof s.command === 'string' && s.command
  );
  return { settings: normalizeSettings(data && data.system), processes, state };
}

const loaded = loadConfig();
const settings = loaded.settings;

let cwd = ROOT;

const ESC = '\x1b[';
const RST = ESC + '0m';
const BOLD = ESC + '1m';
const CLEAR = ESC + '2J' + ESC + '3J' + ESC + 'H';
const ansi = (n) => `${ESC}38;5;${n}m`;
const PURPLE = ansi(141);
const VIOLET = ansi(135);
const RED = ansi(203);
const GREEN = ansi(114);
const YELLOW = ansi(221);
const CYAN = ansi(117);
const GRAY = ansi(245);
const WHITE = ansi(255);
const paint = (col, s) => `${col}${s}${RST}`;
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

let atLineStart = true;
function write(s) {
  s = String(s);
  if (!s.length) return;
  process.stdout.write(s);
  atLineStart = s.endsWith('\n');
}
const println = (s = '') => write(s + '\n');
const err = (m) => println(`${paint(RED, '✗')} ${m}`);
const ok = (m, sym = '✓', col = GREEN) => println(`${paint(col, sym)} ${m}`);
const info = (m) => println(paint(GRAY, m));

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtSize(b) {
  if (b == null) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function table(head, rows) {
  const w = head.map((h, i) => Math.max(strip(h).length, ...rows.map((r) => strip(r[i]).length)));
  const pad = (s, n) => s + ' '.repeat(n - strip(s).length);
  const hr = (l, m, r) => paint(GRAY, l + w.map((n) => '─'.repeat(n + 2)).join(m) + r);
  const bar = paint(GRAY, '│');
  const row = (cells) => bar + cells.map((c, i) => ' ' + pad(c, w[i]) + ' ').join(bar) + bar;
  println(
    [
      hr('╭', '┬', '╮'),
      row(head.map((h) => paint(BOLD + PURPLE, h))),
      hr('├', '┼', '┤'),
      ...rows.map(row),
      hr('╰', '┴', '╯'),
    ].join('\n')
  );
}

const expandHome = (p) => (p === '~' ? ROOT : p.startsWith('~/') ? path.join(ROOT, p.slice(2)) : p);
const resolvePath = (p) => path.resolve(cwd, expandHome(p));

function displayPath(p) {
  if (p === ROOT) return '~';
  if (p.startsWith(ROOT + path.sep)) return '~/' + path.relative(ROOT, p).split(path.sep).join('/');
  return p;
}

function isProtected(p) {
  const base = p.endsWith(path.sep) ? p : p + path.sep;
  return p === ROOT || (ROOT + path.sep).startsWith(base);
}

function friendly(e) {
  const map = {
    ENOENT: 'No such file or directory',
    EACCES: 'Permission denied',
    ENOTDIR: 'Not a directory',
    EISDIR: 'Is a directory',
    EEXIST: 'File exists',
    ENOTEMPTY: 'Directory not empty',
  };
  if (map[e.code]) return map[e.code] + (e.path ? `: ${displayPath(e.path)}` : '');
  return e.message;
}

function tokenize(str) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (const ch of str) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function splitAnd(str) {
  const parts = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '&' && str[i + 1] === '&') {
      parts.push(cur.trim());
      cur = '';
      i++;
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

const usage = (m) => {
  throw new Error('Usage: ' + m);
};

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return null;
  }
};

const SYM = {
  os: '◆',
  host: '●',
  kernel: '■',
  uptime: '◐',
  shell: '►',
  runtime: '▲',
  cpu: '★',
  mem: '≡',
  disk: '▣',
  net: '⇅',
  addr: '◎',
  proc: '↻',
  dir: '▸',
};

function memInfo() {
  const total = os.totalmem();
  let used = total - os.freemem();
  let limit = total;
  const lim = readText('/sys/fs/cgroup/memory.max') ?? readText('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const cur = readText('/sys/fs/cgroup/memory.current') ?? readText('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (lim && lim !== 'max' && Number(lim) > 0 && Number(lim) < total) limit = Number(lim);
  const envLimit = Number(process.env.SERVER_MEMORY) * 1048576;
  if (limit === total && envLimit > 0 && envLimit < total) limit = envLimit;
  if (cur && !isNaN(Number(cur))) used = Number(cur);
  return { used: Math.min(used, limit), limit };
}

function readCpuUsec() {
  const v2 = readText('/sys/fs/cgroup/cpu.stat');
  if (v2) {
    const m = v2.match(/usage_usec\s+(\d+)/);
    if (m) return Number(m[1]);
  }
  const v1 = readText('/sys/fs/cgroup/cpuacct/cpuacct.usage') ?? readText('/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage');
  if (v1 && !isNaN(Number(v1))) return Number(v1) / 1000;
  return null;
}

function cpuLimitCores() {
  const v2 = readText('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [q, p] = v2.split(' ');
    if (q !== 'max' && Number(q) > 0 && Number(p) > 0) return Number(q) / Number(p);
  }
  const q1 = readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const p1 = readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (q1 && p1 && Number(q1) > 0 && Number(p1) > 0) return Number(q1) / Number(p1);
  return null;
}

async function sampleCpu(ms) {
  const limit = cpuLimitCores() || os.cpus().length || 1;
  const a = readCpuUsec();
  const t0 = process.hrtime.bigint();
  await new Promise((r) => setTimeout(r, ms));
  const b = readCpuUsec();
  const elapsed = Number(process.hrtime.bigint() - t0) / 1000;
  let cores;
  if (a != null && b != null && elapsed > 0) cores = Math.max(0, (b - a) / elapsed);
  else cores = Math.min(os.loadavg()[0], limit);
  return { cores, limit };
}

function dirSize(dir) {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else total += fs.lstatSync(p).size;
      } catch {}
      if (++count > 500000) return total;
    }
  }
  return total;
}

function diskInfo() {
  const used = dirSize(ROOT);
  let limit = settings.diskLimitMb > 0 ? settings.diskLimitMb * 1048576 : 0;
  if (!limit) {
    try {
      const s = fs.statfsSync(ROOT);
      limit = s.bsize * s.blocks;
    } catch {
      limit = used || 1;
    }
  }
  return { used, limit };
}

function netTotals() {
  const t = readText('/proc/net/dev');
  if (!t) return null;
  let rx = 0;
  let tx = 0;
  for (const line of t.split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() === 'lo') continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    rx += f[0] || 0;
    tx += f[8] || 0;
  }
  return { rx, tx };
}

function groupRss(pgid) {
  try {
    let pages = 0;
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(rest[2]) !== pgid) continue;
        pages += Number(fs.readFileSync(`/proc/${d}/statm`, 'utf8').split(' ')[1]);
      } catch {}
    }
    return pages * 4096;
  } catch {
    return null;
  }
}

const RAMP = [57, 63, 99, 135, 141, 177, 183];

function buildLogo() {
  const W = 24;
  const H = 11;
  const BAND = 6;
  const lines = [];
  for (let r = 0; r < H; r++) {
    const row = new Array(W).fill(' ');
    if (r < 2 || r >= H - 2) {
      row.fill('█');
    } else {
      const s = Math.round((W - BAND) * (1 - (r - 2) / (H - 5)));
      for (let c = s; c < s + BAND && c < W; c++) row[c] = '█';
      row[s] = '▓';
      if (s + BAND < W) row[s + BAND] = '▒';
      if (s + BAND + 1 < W) row[s + BAND + 1] = '░';
    }
    let out = '';
    let cur = -1;
    for (let c = 0; c < W; c++) {
      if (row[c] === ' ') {
        if (cur !== -1) {
          out += RST;
          cur = -1;
        }
        out += ' ';
        continue;
      }
      const t = (c / (W - 1)) * 0.55 + (r / (H - 1)) * 0.45;
      const color = RAMP[Math.round(t * (RAMP.length - 1))];
      if (color !== cur) {
        out += ansi(color);
        cur = color;
      }
      out += row[c];
    }
    if (cur !== -1) out += RST;
    lines.push(out);
  }
  lines.push('');
  const tag = 'Z Y R O   O S';
  const left = Math.floor((W - tag.length) / 2);
  lines.push(' '.repeat(left) + BOLD + ansi(141) + tag + RST + ' '.repeat(W - tag.length - left));
  return { lines, width: W };
}

const levelColor = (frac) => (frac < 0.6 ? GREEN : frac < 0.85 ? YELLOW : RED);

function usageBar(frac, width = 10) {
  const f = Math.max(0, Math.min(width, Math.round(frac * width)));
  return paint(levelColor(frac), '▰'.repeat(f)) + paint(GRAY, '▱'.repeat(width - f));
}

function procCounts() {
  return {
    online: procs.filter((p) => p.status === 'online' || p.status === 'restarting').length,
    stopped: procs.filter((p) => p.status === 'stopped').length,
    errored: procs.filter((p) => p.status === 'errored').length,
  };
}

function neofetch() {
  const mem = memInfo();
  const cpus = os.cpus() || [];
  const cpuName = ((cpus[0] && cpus[0].model) || 'Unknown CPU').replace(/\s+/g, ' ').trim().slice(0, 26);
  const counts = procCounts();
  const mib = (b) => Math.round(b / 1048576);
  const frac = mem.used / mem.limit;
  const row = (sym, k, v) => `${paint(VIOLET, sym)} ${BOLD}${PURPLE}${k.padEnd(10)}${RST}${v}`;
  const header = `${BOLD}${PURPLE}${settings.user}${RST}${GRAY}@${RST}${BOLD}${PURPLE}${settings.hostname}${RST}`;
  const palette = [53, 54, 55, 56, 57, 93, 99, 135, 141, 177, 183, 189]
    .map((c) => `${ESC}48;5;${c}m  ${RST}`)
    .join('');

  const infoLines = [
    header,
    paint(GRAY, '─'.repeat(33)),
    row(SYM.os, 'OS', `Zyro OS ${CONFIG.version} ${os.arch()}`),
    row(SYM.host, 'Host', os.hostname()),
    row(SYM.kernel, 'Kernel', os.release()),
    row(SYM.uptime, 'Uptime', fmtDur(process.uptime() * 1000)),
    row(SYM.shell, 'Shell', 'zyrosh'),
    row(SYM.runtime, 'Runtime', `Node.js ${process.version}`),
    row(SYM.cpu, 'CPU', `${cpuName} (${cpus.length})`),
    row(SYM.mem, 'Memory', `${usageBar(frac)} ${mib(mem.used)} / ${mib(mem.limit)} MiB`),
    row(SYM.proc, 'Processes', `${counts.online} online · ${counts.stopped} stopped · ${counts.errored} errored`),
    row(SYM.dir, 'Directory', displayPath(cwd)),
    '',
    palette,
  ];

  const logo = buildLogo();
  const total = Math.max(infoLines.length, logo.lines.length);
  const out = [];
  for (let i = 0; i < total; i++) {
    const left = logo.lines[i] !== undefined ? logo.lines[i] : '';
    const padLen = logo.width - strip(left).length;
    out.push(`${left}${' '.repeat(Math.max(0, padLen))}    ${infoLines[i] || ''}`);
  }
  println('\n' + out.join('\n') + '\n');
}

async function statsCmd() {
  const cpu = await sampleCpu(1000);
  const mem = memInfo();
  const disk = diskInfo();
  const net = netTotals();
  const counts = procCounts();
  const key = (sym, k) => `${paint(VIOLET, sym)} ${BOLD}${PURPLE}${k.padEnd(10)}${RST}`;
  const meter = (frac, text) => {
    const f = Math.max(0, Math.min(1, frac));
    return `${usageBar(f, 20)} ${paint(levelColor(f), (Math.round(f * 100) + '%').padStart(4))}  ${text}`;
  };

  const lines = [
    '',
    `${paint(PURPLE, '◆')} ${BOLD}${WHITE}Server Statistics${RST} ${GRAY}·  ${settings.user}@${settings.hostname}${RST}`,
    paint(GRAY, '─'.repeat(60)),
    key(SYM.cpu, 'CPU') + meter(cpu.cores / cpu.limit, `${(cpu.cores * 100).toFixed(1)}% / ${Math.round(cpu.limit * 100)}%`),
    key(SYM.mem, 'Memory') + meter(mem.used / mem.limit, `${fmtSize(mem.used)} / ${fmtSize(mem.limit)}`),
    key(SYM.disk, 'Disk') + meter(disk.used / disk.limit, `${fmtSize(disk.used)} / ${fmtSize(disk.limit)}`),
    key(SYM.uptime, 'Uptime') + fmtDur(process.uptime() * 1000),
  ];
  if (net) lines.push(key(SYM.net, 'Network') + `↓ ${fmtSize(net.rx)}  ·  ↑ ${fmtSize(net.tx)}`);
  if (process.env.SERVER_IP && process.env.SERVER_PORT) {
    lines.push(key(SYM.addr, 'Address') + `${process.env.SERVER_IP}:${process.env.SERVER_PORT}`);
  }
  lines.push(key(SYM.proc, 'Processes') + `${counts.online} online · ${counts.stopped} stopped · ${counts.errored} errored`);
  lines.push('');
  println(lines.join('\n'));
}

function help() {
  const title = (t) => `${paint(PURPLE, '▸')} ${BOLD}${PURPLE}${t}${RST}`;
  const c = (cmd, desc) => `  ${paint(VIOLET, cmd.padEnd(34))}${desc}`;
  println(
    [
      '',
      `${paint(PURPLE, '◆')} ${BOLD}${WHITE}Zyro OS ${CONFIG.version}${RST}  ${GRAY}·  Command Reference${RST}`,
      paint(GRAY, '─'.repeat(64)),
      '',
      title('SYSTEM'),
      c('help', 'Show this reference'),
      c('neofetch', 'Display system information'),
      c('stats', 'Server statistics with usage bars'),
      c('version', 'Show version and check for updates'),
      c('clear', 'Clear the screen'),
      '',
      title('FILES & NAVIGATION'),
      c('pwd', 'Print the current directory'),
      c('cd <dir>', 'Change directory (cd, cd .., cd ~)'),
      c('ls [-la] [dir]', 'List directory contents'),
      c('tree [dir] [-L depth]', 'Show a directory tree'),
      c('cat <file>', 'Print a file'),
      c('tail [-n N] <file>', 'Print the last N lines of a file'),
      c('mkdir <dir>', 'Create a directory'),
      c('rm [-r] <path>', 'Remove files or directories'),
      c('mv <source> <target>', 'Move or rename'),
      c('cp [-r] <source> <target>', 'Copy'),
      '',
      title('RUNNING COMMANDS'),
      c('<any command>', 'Run it, e.g. npm install, git pull'),
      c('<command> &', 'Run in the background as a job'),
      c('cmd1 && cmd2', 'Run commands in sequence'),
      c('kill', 'Stop the command that is running'),
      c('jobs', 'List background jobs'),
      c('kill <job-n>', 'Stop a background job'),
      '',
      title('PROCESS MANAGER'),
      c('start <file.js> [--name name]', 'Start a script in the background'),
      c('start "<command>" --name name', 'Start any shell command'),
      c('autostart <file.js> [--name n]', 'Start now and on every server boot'),
      c('autostart on|off <name|id|all>', 'Toggle boot start for a process'),
      c('rename <name|id> <new-name>', 'Rename a process'),
      c('stop <name|id|all>', 'Stop processes'),
      c('restart <name|id|all>', 'Restart processes'),
      c('delete <name|id|all>', 'Stop and remove processes'),
      c('list', 'Show the status of all processes'),
      c('logs <name|id> [lines]', 'Show the last N log lines (default 20)'),
      '',
    ].join('\n')
  );
}

function parseVersion(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function releaseState(latest, url) {
  const link = url || `https://github.com/${CONFIG.repository}/releases/latest`;
  return isNewer(latest, CONFIG.version) ? { state: 'available', latest, url: link } : { state: 'latest', latest, url: link };
}

async function checkUpdate(force) {
  if (!settings.checkUpdates) return { state: 'disabled' };
  const cached = readJson(UPDATE_FILE);
  const fresh = cached && Date.now() - cached.checkedAt < CONFIG.updateCacheHours * 3600000;
  if (!force && fresh && cached.latest) return releaseState(cached.latest, cached.url);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.updateTimeoutMs);
    const res = await fetch(`https://api.github.com/repos/${CONFIG.repository}/releases/latest`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `ZyroOS/${CONFIG.version}`, Accept: 'application/vnd.github+json' },
    });
    clearTimeout(timer);
    if (res.status === 404) return { state: 'none' };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    if (!parseVersion(latest)) throw new Error('Invalid release tag');
    try {
      fs.writeFileSync(UPDATE_FILE, JSON.stringify({ checkedAt: Date.now(), latest, url: data.html_url || null }));
    } catch {}
    return releaseState(latest, data.html_url);
  } catch {
    if (cached && cached.latest) return releaseState(cached.latest, cached.url);
    return { state: 'unavailable' };
  }
}

function updateMessage(u) {
  switch (u.state) {
    case 'latest':
      return { level: 'ok', msg: `Zyro OS is up to date ${paint(GRAY, `(v${CONFIG.version})`)}` };
    case 'available':
      return { level: 'warn', msg: `Update available: v${CONFIG.version} → ${paint(BOLD + GREEN, 'v' + u.latest)}` };
    case 'none':
      return { level: 'info', msg: 'No published releases found yet' };
    case 'disabled':
      return { level: 'info', msg: 'Update check is disabled in configuration' };
    default:
      return { level: 'info', msg: 'Update check unavailable (offline or rate limited)' };
  }
}

let updateInfo = { state: 'unavailable' };

function updateNotice() {
  if (updateInfo.state !== 'available') return;
  println(
    `${paint(YELLOW, '↑')} Update available: v${CONFIG.version} → ${paint(BOLD + GREEN, 'v' + updateInfo.latest)}  ${paint(GRAY, updateInfo.url)}`
  );
}

async function versionCmd() {
  println(`${paint(PURPLE, '◆')} ${BOLD}Zyro OS${RST} v${CONFIG.version}  ${paint(GRAY, `· Node.js ${process.version} · github.com/${CONFIG.repository}`)}`);
  updateInfo = await checkUpdate(true);
  const m = updateMessage(updateInfo);
  const sym = { ok: ['✓', GREEN], warn: ['↑', YELLOW], info: ['·', GRAY] }[m.level];
  println(`${paint(sym[1], sym[0])} ${m.msg}`);
  if (updateInfo.state === 'available') info(updateInfo.url);
}

function killTree(child, sig = 'SIGTERM') {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {}
  }
}

function terminate(child) {
  if (!child) return;
  killTree(child, 'SIGTERM');
  const t = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
  t.unref();
  child.once('close', () => clearTimeout(t));
}

const logFile = (name) => path.join(LOG_DIR, name + '.log');
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function rotateLog(f) {
  try {
    const st = fs.statSync(f);
    if (st.size <= CONFIG.maxLogBytes) return;
    const keep = CONFIG.keepLogBytes;
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, st.size - keep);
    fs.closeSync(fd);
    fs.writeFileSync(f, buf);
  } catch {}
}

function tailLines(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = 64 * 1024;
    let pos = size;
    let buf = Buffer.alloc(0);
    let count = 0;
    while (pos > 0 && count <= n) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      for (const byte of b) if (byte === 10) count++;
      buf = Buffer.concat([b, buf]);
    }
    const lines = buf.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

let fgProc = null;

function runForeground(cmd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, { shell: true, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (e) {
      err(e.message);
      return resolve(false);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, CONFIG.fgTimeoutSec * 1000);

    fgProc = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.stdin.on('error', () => {});
    child.on('error', (e) => err(e.message));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fgProc = null;
      if (timedOut) err(`Command timed out after ${CONFIG.fgTimeoutSec}s and was terminated`);
      else if (signal) info(`Terminated (${signal})`);
      resolve(code === 0 && !timedOut);
    });
  });
}

const jobs = [];
let nextJob = 1;

function startJob(cmd) {
  if (!cmd) return;
  const job = { id: nextJob++, command: cmd, status: 'running', child: null, startedAt: Date.now() };
  job.name = `job-${job.id}`;
  try {
    fs.writeFileSync(logFile(job.name), '');
  } catch {}
  const out = fs.createWriteStream(logFile(job.name), { flags: 'a' });
  let child;
  try {
    child = spawn(cmd, { shell: true, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  } catch (e) {
    out.end();
    return err(e.message);
  }
  job.child = child;
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  child.on('error', (e) => out.write(`[zyro] spawn error: ${e.message}\n`));
  child.on('close', (code, signal) => {
    out.end();
    job.child = null;
    job.status = signal ? 'killed' : code === 0 ? 'done' : 'failed';
    const detail = signal ? signal : `exit ${code}`;
    println(paint(job.status === 'done' ? GREEN : YELLOW, `◆ [${job.name}] ${job.status} (${detail})`));
  });
  jobs.push(job);
  while (jobs.length > 20) {
    const i = jobs.findIndex((j) => j.status !== 'running');
    if (i < 0) break;
    jobs.splice(i, 1);
  }
  println(
    paint(PURPLE, `◆ [${job.name}] started in background (pid ${child.pid})`) +
      paint(GRAY, `  ·  view output: logs ${job.name}`)
  );
}

function jobsCmd() {
  if (!jobs.length) return info('No background jobs.');
  const label = {
    running: () => paint(GREEN, '● running'),
    done: () => paint(GRAY, '○ done'),
    failed: () => paint(RED, '✗ failed'),
    killed: () => paint(YELLOW, '◐ killed'),
  };
  table(
    ['Job', 'Command', 'Status', 'PID', 'Uptime'],
    jobs.map((j) => [
      j.name,
      j.command.length > 28 ? j.command.slice(0, 27) + '…' : j.command,
      label[j.status](),
      j.child ? String(j.child.pid) : '-',
      j.status === 'running' ? fmtDur(Date.now() - j.startedAt) : '-',
    ])
  );
}

function killCmd(args) {
  if (!args[0]) {
    if (fgProc) {
      terminate(fgProc);
      return;
    }
    throw new Error('No command is currently running. Usage: kill <job-n>');
  }
  const t = args[0];
  const job = jobs.find((j) => j.name === t || String(j.id) === t);
  if (!job) throw new Error(`Job "${t}" not found (see: jobs)`);
  if (job.status !== 'running') throw new Error(`${job.name} has already finished`);
  terminate(job.child);
}

const procs = [];
let nextId = 0;
let shuttingDown = false;

function makeProc(name, command, pcwd, auto) {
  return {
    id: nextId++,
    name,
    command,
    cwd: pcwd,
    auto: !!auto,
    status: 'stopped',
    child: null,
    pid: null,
    startedAt: 0,
    restarts: 0,
    crashes: [],
    timer: null,
    manualStop: false,
    out: null,
  };
}

function evt(p, msg) {
  try {
    if (p.out && !p.out.destroyed && !p.out.writableEnded) p.out.write(`[zyro] ${stamp()} ${msg}\n`);
  } catch {}
}

function saveConfig() {
  try {
    const data = {
      system: settings,
      processes: procs.filter((p) => p.auto).map((p) => ({ name: p.name, command: p.command, cwd: p.cwd })),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function spawnManaged(p) {
  clearTimeout(p.timer);
  p.manualStop = false;
  const lf = logFile(p.name);
  rotateLog(lf);
  if (!p.out || p.out.destroyed || p.out.writableEnded) {
    try {
      p.out = fs.createWriteStream(lf, { fd: fs.openSync(lf, 'a') });
    } catch {
      p.out = fs.createWriteStream(lf, { flags: 'a' });
    }
  }

  if (!fs.existsSync(p.cwd)) {
    p.status = 'errored';
    evt(p, `errored: working directory not found (${p.cwd})`);
    return;
  }
  evt(p, `start: ${p.command}`);

  let child;
  try {
    child = spawn(p.command, { shell: true, cwd: p.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  } catch (e) {
    p.status = 'errored';
    evt(p, `spawn error: ${e.message}`);
    return;
  }
  p.child = child;
  p.pid = child.pid;
  p.status = 'online';
  p.startedAt = Date.now();
  child.stdout.pipe(p.out, { end: false });
  child.stderr.pipe(p.out, { end: false });

  child.on('error', (e) => {
    evt(p, `spawn error: ${e.message}`);
    if (!child.pid) {
      p.status = 'errored';
      p.child = null;
      p.pid = null;
    }
  });

  child.on('close', (code, signal) => {
    p.child = null;
    p.pid = null;
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    if (p.manualStop || shuttingDown) {
      p.status = 'stopped';
      evt(p, `stopped (${why})`);
      return;
    }
    p.restarts++;
    const now = Date.now();
    p.crashes = p.crashes.filter((t) => now - t < CONFIG.crashWindowMs);
    p.crashes.push(now);
    if (p.crashes.length > CONFIG.maxCrashes) {
      p.status = 'errored';
      evt(p, `errored: ${why}; too many crashes, automatic restart disabled`);
      return;
    }
    p.status = 'restarting';
    evt(p, `${why}; restarting (#${p.restarts}) in ${CONFIG.restartDelayMs / 1000}s`);
    p.timer = setTimeout(() => spawnManaged(p), CONFIG.restartDelayMs);
  });
}

function stopProc(p) {
  return new Promise((resolve) => {
    clearTimeout(p.timer);
    const child = p.child;
    if (!child) {
      p.status = 'stopped';
      return resolve();
    }
    p.manualStop = true;
    child.once('close', () => resolve());
    terminate(child);
  });
}

function targets(arg) {
  if (!arg) throw new Error('Specify a process name, id or "all"');
  if (arg === 'all') {
    if (!procs.length) throw new Error('No processes');
    return [...procs];
  }
  const p = procs.find((x) => x.name === arg || String(x.id) === arg);
  if (!p) throw new Error(`Process "${arg}" not found (see: list)`);
  return [p];
}

function checkName(name) {
  if (!PROC_NAME_RE.test(name)) throw new Error('Names may only contain letters, numbers, dots, dashes and underscores');
  if (/^job-\d+$/.test(name)) throw new Error('The name "job-n" is reserved for background jobs');
}

const GENERIC_NAMES = new Set([
  'index', 'main', 'app', 'server', 'start', 'bot', 'run',
  'npm', 'node', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'sh', 'bash',
]);

function defaultName(first, isNode) {
  let base = path.basename(first, path.extname(first)) || 'app';
  if (GENERIC_NAMES.has(base.toLowerCase())) {
    const dir = isNode ? path.dirname(resolvePath(first)) : cwd;
    if (dir !== ROOT) base = path.basename(dir);
  }
  return base.replace(/[^\w.-]/g, '_') || 'app';
}

function createProc(raw, verb, auto) {
  let rest = raw.trim().replace(new RegExp('^' + verb + '\\s*'), '');
  let name = null;
  rest = rest
    .replace(/(?:^|\s)(?:--name|-n)\s+(\S+)/, (_, n) => {
      name = n;
      return '';
    })
    .trim();
  const quoted = rest.match(/^(["'])(.*)\1$/);
  if (quoted) rest = quoted[2].trim();
  if (!rest) usage(`${verb} <file.js | "command"> [--name name]`);

  const first = tokenize(rest)[0];
  const isNode = /\.(c|m)?js$/i.test(first);
  if (isNode && !fs.existsSync(resolvePath(first))) throw new Error(`File not found: ${first}`);
  const command = isNode ? `node ${rest}` : rest;

  const taken = (n) => procs.some((p) => p.name === n);
  if (name) {
    checkName(name);
    if (taken(name)) throw new Error(`The name "${name}" is already in use. Use: restart ${name}`);
  } else {
    const base = defaultName(first, isNode);
    name = base;
    let i = 2;
    while (taken(name)) name = `${base}-${i++}`;
  }

  const p = makeProc(name, command, cwd, auto);
  procs.push(p);
  saveConfig();
  spawnManaged(p);
  const note = auto ? '  ·  autostart on' : '';
  ok(`${paint(BOLD, name)} started ${paint(GRAY, `(id ${p.id}, pid ${p.pid || '-'})${note}`)}`, '►');
}

function startCmd(_args, raw) {
  createProc(raw, 'start', false);
}

function autostartCmd(args, raw) {
  const sub = args[0];
  if (sub === 'on' || sub === 'off') {
    for (const p of targets(args[1])) {
      p.auto = sub === 'on';
      ok(`${paint(BOLD, p.name)} autostart ${sub}`, sub === 'on' ? '↻' : '○', sub === 'on' ? PURPLE : GRAY);
    }
    saveConfig();
    return;
  }
  createProc(raw, 'autostart', true);
}

function renameCmd(args) {
  if (args.length !== 2 || args[0] === 'all') usage('rename <name|id> <new-name>');
  const [p] = targets(args[0]);
  const next = args[1];
  checkName(next);
  if (procs.some((x) => x !== p && x.name === next)) throw new Error(`The name "${next}" is already in use`);
  const prev = p.name;
  try {
    fs.renameSync(logFile(prev), logFile(next));
  } catch {}
  p.name = next;
  saveConfig();
  ok(`${paint(BOLD, prev)} → ${paint(BOLD, next)}`, '↻', CYAN);
}

async function stopCmd(args) {
  for (const p of targets(args[0])) {
    await stopProc(p);
    ok(`${paint(BOLD, p.name)} stopped`, '■', YELLOW);
  }
}

async function restartCmd(args) {
  for (const p of targets(args[0])) {
    await stopProc(p);
    p.restarts++;
    p.crashes = [];
    spawnManaged(p);
    ok(`${paint(BOLD, p.name)} restarted ${paint(GRAY, `(pid ${p.pid || '-'})`)}`, '↻', CYAN);
  }
}

async function deleteCmd(args) {
  for (const p of targets(args[0])) {
    await stopProc(p);
    if (p.out) p.out.end();
    procs.splice(procs.indexOf(p), 1);
    try {
      fs.unlinkSync(logFile(p.name));
    } catch {}
    saveConfig();
    ok(`${paint(BOLD, p.name)} deleted`, '✕', GRAY);
  }
}

const STATUS_LABEL = {
  online: () => paint(GREEN, '● online'),
  stopped: () => paint(GRAY, '○ stopped'),
  restarting: () => paint(YELLOW, '◐ restarting'),
  errored: () => paint(RED, '✗ errored'),
};

function listCmd() {
  if (!procs.length) return info('No processes yet. Start one with: start <file.js> --name <name>');
  table(
    ['ID', 'Name', 'Status', 'Uptime', 'Restarts', 'PID', 'Memory', 'Auto'],
    procs.map((p) => [
      String(p.id),
      p.name,
      (STATUS_LABEL[p.status] || (() => p.status))(),
      p.status === 'online' ? fmtDur(Date.now() - p.startedAt) : '-',
      String(p.restarts),
      p.pid ? String(p.pid) : '-',
      p.pid ? fmtSize(groupRss(p.pid)) : '-',
      p.auto ? paint(PURPLE, '✓') : '-',
    ])
  );
  info(`${procs.length} total · ${procs.filter((p) => p.status === 'online').length} online`);
}

function logsCmd(args) {
  if (!args[0]) usage('logs <name|id|job-n> [lines]');
  const target = args[0];
  let n = CONFIG.defaultLogLines;
  for (const a of args.slice(1)) {
    if (/^\d+$/.test(a)) {
      n = parseInt(a, 10);
      break;
    }
  }
  if (!Number.isInteger(n) || n < 1) throw new Error('Line count must be a positive number');
  n = Math.min(n, CONFIG.maxLogLines);

  const p = procs.find((x) => x.name === target || String(x.id) === target);
  const name = p ? p.name : target;
  if (!PROC_NAME_RE.test(name) || !fs.existsSync(logFile(name))) throw new Error(`Log "${target}" not found`);

  const lines = tailLines(logFile(name), n);
  println(`${paint(PURPLE, '≡')} ${paint(BOLD + PURPLE, `Logs · ${name} · last ${lines.length} line${lines.length === 1 ? '' : 's'}`)}`);
  println(paint(GRAY, '─'.repeat(48)));
  if (!lines.length) return info('(log is empty)');
  println(lines.map((l) => (l.startsWith('[zyro]') ? paint(GRAY, l) : l)).join('\n'));
}

function resurrect(saved) {
  let started = 0;
  for (const s of saved) {
    if (procs.some((p) => p.name === s.name)) continue;
    const p = makeProc(s.name, s.command, s.cwd && fs.existsSync(s.cwd) ? s.cwd : ROOT, true);
    procs.push(p);
    spawnManaged(p);
    started++;
  }
  return started;
}

const FILE_SYMBOLS = [
  [['.js', '.mjs', '.cjs', '.ts'], '◆', PURPLE],
  [['.json'], '◇', YELLOW],
  [['.md', '.txt'], '□', GRAY],
  [['.log'], '≡', GRAY],
  [['.zip', '.tar', '.gz', '.rar', '.7z'], '▣', RED],
  [['.png', '.jpg', '.jpeg', '.gif', '.webp'], '●', GREEN],
  [['.sh', '.bat'], '►', GREEN],
];

function entrySymbol(name, isDir) {
  if (isDir) return paint(CYAN, '▸');
  const ext = path.extname(name).toLowerCase();
  for (const [exts, sym, col] of FILE_SYMBOLS) if (exts.includes(ext)) return paint(col, sym);
  return paint(GRAY, '·');
}

function entryLabel(name, isDir) {
  return `${entrySymbol(name, isDir)} ` + (isDir ? paint(BOLD + CYAN, name + '/') : name);
}

function visibleEntries(dir, showHiddenFiles) {
  let entries = fs.readdirSync(dir, { withFileTypes: true });
  entries = entries.filter((d) => !(d.isDirectory() && d.name.startsWith('.')));
  if (dir === ROOT) entries = entries.filter((d) => d.isDirectory());
  else if (!showHiddenFiles) entries = entries.filter((d) => !d.name.startsWith('.'));
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return entries;
}

function cdCmd(args) {
  const target = args.length ? args.join(' ') : '~';
  const dir = resolvePath(target);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    throw new Error(`cd: ${target}: no such directory`);
  }
  if (!st.isDirectory()) throw new Error(`cd: ${target}: not a directory`);
  cwd = dir;
}

function lsCmd(args) {
  const flags = args.filter((a) => a.startsWith('-')).join('');
  const targetsArg = args.filter((a) => !a.startsWith('-'));
  const dir = resolvePath(targetsArg[0] || '.');
  const st = fs.statSync(dir);
  if (!st.isDirectory()) return println(entryLabel(path.basename(dir), false));

  const entries = visibleEntries(dir, flags.includes('a'));
  if (!entries.length) return info('(empty)');

  const label = (d) => entryLabel(d.name, d.isDirectory());

  if (flags.includes('l')) {
    const rows = entries.map((d) => {
      let size = '-';
      let mtime = '';
      try {
        const s = fs.lstatSync(path.join(dir, d.name));
        size = d.isDirectory() ? '-' : fmtSize(s.size);
        mtime = s.mtime.toISOString().replace('T', ' ').slice(0, 16);
      } catch {}
      return `${size.padStart(9)}  ${paint(GRAY, mtime)}  ${label(d)}`;
    });
    return println(paint(GRAY, `${'Size'.padStart(9)}  ${'Modified'.padEnd(16)}  Name`) + '\n' + rows.join('\n'));
  }

  const items = entries.map(label);
  const lines = [];
  let line = '';
  for (const it of items) {
    if (strip(line).length + strip(it).length + 2 > 56 && line) {
      lines.push(line);
      line = '';
    }
    line += (line ? '  ' : '') + it;
  }
  if (line) lines.push(line);
  println(lines.join('\n'));
}

function treeCmd(args) {
  let depth = 3;
  let target = '.';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-L') depth = parseInt(args[++i], 10) || 3;
    else target = args[i];
  }
  const root = resolvePath(target);
  if (!fs.statSync(root).isDirectory()) throw new Error('Not a directory');
  println(`${paint(CYAN, '▸')} ${paint(BOLD + CYAN, displayPath(root))}`);

  const LIMIT = 400;
  let lines = 0;
  let dirs = 0;
  let files = 0;
  let cut = false;

  const walk = (dir, prefix, level) => {
    let entries;
    try {
      entries = visibleEntries(dir, false);
    } catch {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      if (lines >= LIMIT) {
        cut = true;
        return;
      }
      const e = entries[i];
      const last = i === entries.length - 1;
      const skip = e.isDirectory() && e.name === 'node_modules';
      println(paint(GRAY, prefix + (last ? '└── ' : '├── ')) + entryLabel(e.name, e.isDirectory()) + (skip ? paint(GRAY, ' …') : ''));
      lines++;
      if (e.isDirectory()) {
        dirs++;
        if (!skip && level < depth) walk(path.join(dir, e.name), prefix + (last ? '    ' : '│   '), level + 1);
      } else files++;
    }
  };
  walk(root, '', 1);
  if (cut) info(`… output truncated at ${LIMIT} lines`);
  info(`${dirs} director${dirs === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}`);
}

function catCmd(args) {
  if (!args.length) usage('cat <file>');
  for (const a of args) {
    const f = resolvePath(a);
    const st = fs.statSync(f);
    if (st.isDirectory()) throw new Error(`${a}: is a directory`);
    if (st.size > 1048576) throw new Error(`${a}: file too large (>1 MiB), use: tail -n 50 ${a}`);
    write(fs.readFileSync(f, 'utf8'));
  }
}

function tailCmd(args) {
  let n = 10;
  let file = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n') n = parseInt(args[++i], 10);
    else if (/^-\d+$/.test(a)) n = -parseInt(a, 10);
    else file = a;
  }
  if (!file) usage('tail [-n N] <file>');
  if (!Number.isInteger(n) || n < 1) throw new Error('Line count must be a positive number');
  const f = resolvePath(file);
  if (fs.statSync(f).isDirectory()) throw new Error(`${file}: is a directory`);
  const lines = tailLines(f, Math.min(n, CONFIG.maxLogLines));
  if (lines.length) println(lines.join('\n'));
}

function mkdirCmd(args) {
  const dirs = args.filter((a) => !a.startsWith('-'));
  if (!dirs.length) usage('mkdir <dir>');
  for (const d of dirs) fs.mkdirSync(resolvePath(d), { recursive: true });
}

function rmCmd(args) {
  const flags = args.filter((a) => a.startsWith('-')).join('');
  const list = args.filter((a) => !a.startsWith('-'));
  if (!list.length) usage('rm [-r] [-f] <path>');
  const recursive = /[rR]/.test(flags);
  const force = flags.includes('f');
  let allOk = true;
  for (const t of list) {
    const p = resolvePath(t);
    if (isProtected(p)) {
      err(`Refusing to remove ${t}: protected path`);
      allOk = false;
      continue;
    }
    if (!fs.existsSync(p)) {
      if (!force) {
        err(`${t}: no such file or directory`);
        allOk = false;
      }
      continue;
    }
    if (fs.lstatSync(p).isDirectory() && !recursive) {
      err(`${t} is a directory (use rm -r)`);
      allOk = false;
      continue;
    }
    fs.rmSync(p, { recursive: true, force: true });
  }
  return allOk;
}

function mvCmd(args) {
  const list = args.filter((a) => !a.startsWith('-'));
  if (list.length !== 2) usage('mv <source> <target>');
  const s = resolvePath(list[0]);
  let d = resolvePath(list[1]);
  if (isProtected(s)) throw new Error(`Refusing to move ${list[0]}: protected path`);
  if (!fs.existsSync(s)) throw new Error(`${list[0]}: no such file or directory`);
  if (fs.existsSync(d) && fs.statSync(d).isDirectory()) d = path.join(d, path.basename(s));
  try {
    fs.renameSync(s, d);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(s, d, { recursive: true });
    fs.rmSync(s, { recursive: true, force: true });
  }
}

function cpCmd(args) {
  const flags = args.filter((a) => a.startsWith('-')).join('');
  const list = args.filter((a) => !a.startsWith('-'));
  if (list.length !== 2) usage('cp [-r] <source> <target>');
  const s = resolvePath(list[0]);
  let d = resolvePath(list[1]);
  if (!fs.existsSync(s)) throw new Error(`${list[0]}: no such file or directory`);
  const isDir = fs.statSync(s).isDirectory();
  if (isDir && !/[rR]/.test(flags)) throw new Error(`${list[0]} is a directory (use cp -r)`);
  if (fs.existsSync(d) && fs.statSync(d).isDirectory()) d = path.join(d, path.basename(s));
  fs.cpSync(s, d, { recursive: true });
}

const BUILTINS = {
  help: { fn: () => help() },
  neofetch: { fn: () => neofetch() },
  stats: { fn: statsCmd },
  version: { fn: versionCmd },
  clear: { fn: () => write(CLEAR) },
  pwd: { fn: () => println(displayPath(cwd)) },
  cd: { fn: cdCmd },
  tree: { fn: treeCmd },
  ls: { fn: lsCmd, fs: true },
  cat: { fn: catCmd, fs: true },
  tail: { fn: tailCmd, fs: true },
  mkdir: { fn: mkdirCmd, fs: true },
  rm: { fn: rmCmd, fs: true },
  mv: { fn: mvCmd, fs: true },
  cp: { fn: cpCmd, fs: true },
  jobs: { fn: jobsCmd },
  kill: { fn: killCmd },
  start: { fn: startCmd },
  autostart: { fn: autostartCmd },
  rename: { fn: renameCmd },
  stop: { fn: stopCmd },
  restart: { fn: restartCmd },
  delete: { fn: deleteCmd },
  list: { fn: listCmd },
  logs: { fn: logsCmd },
};

const META = /[|;<>*?`]|\$\(/;

async function runSegment(seg) {
  if (!seg) return true;
  const args = tokenize(seg);
  const b = Object.prototype.hasOwnProperty.call(BUILTINS, args[0]) ? BUILTINS[args[0]] : null;
  if (b) {
    if (b.fs && META.test(seg)) return runForeground(seg);
    try {
      const r = await b.fn(args.slice(1), seg);
      return r !== false;
    } catch (e) {
      err(friendly(e));
      return false;
    }
  }
  return runForeground(seg);
}

async function runLine(line) {
  if (/(^|[^&])&\s*$/.test(line)) return startJob(line.replace(/&\s*$/, '').trim());
  for (const seg of splitAnd(line)) {
    if (!(await runSegment(seg))) break;
  }
}

function promptStr() {
  return (
    BOLD + PURPLE + settings.user + '@' + settings.hostname + RST +
    GRAY + ':' + RST +
    CYAN + displayPath(cwd) + RST +
    GRAY + (settings.user === 'root' ? '#' : '$') + RST
  );
}

function showPrompt() {
  if (!atLineStart) println();
  println();
  println(promptStr());
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  saveConfig();
  const children = [...procs.map((p) => p.child), ...jobs.map((j) => j.child), fgProc].filter(Boolean);
  println(paint(PURPLE, `\nZyro OS is shutting down... stopping ${children.length} process${children.length === 1 ? '' : 'es'}.`));
  const done = () => process.exit(0);
  if (!children.length) return done();
  let left = children.length;
  for (const c of children) {
    c.once('close', () => {
      if (--left === 0) done();
    });
    terminate(c);
  }
  setTimeout(done, 6500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bootLine = (tag, col, msg) => println(`${GRAY}[${RST}${col}${tag}${RST}${GRAY}]${RST} ${msg}`);
const bootOk = (m) => bootLine('  OK  ', GREEN, m);
const bootInfo = (m) => bootLine(' INFO ', CYAN, m);
const bootWarn = (m) => bootLine(' WARN ', YELLOW, m);
const bootFail = (m) => bootLine(' FAIL ', RED, m);

async function boot() {
  const pause = () => sleep(CONFIG.bootDelayMs);
  println(`\n${BOLD}${PURPLE}Zyro OS ${CONFIG.version}${RST} ${GRAY}(zyrosh) is starting...${RST}`);
  await pause();

  const major = Number(process.versions.node.split('.')[0]);
  if (major < CONFIG.minNode) {
    bootFail(`Node.js ${process.version} is not supported, Zyro OS requires Node.js ${CONFIG.minNode} or newer`);
    process.exit(1);
  }
  bootOk(`Runtime check passed ${paint(GRAY, `(Node.js ${process.version})`)}`);
  await pause();

  if (loaded.state === 'invalid') bootWarn('Configuration is invalid, defaults loaded (backup: .zyro/config.json.bak)');
  else if (loaded.state === 'created') bootOk(`Created default configuration ${paint(GRAY, '(.zyro/config.json)')}`);
  else bootOk(`Loaded configuration ${paint(GRAY, '(.zyro/config.json)')}`);
  await pause();

  bootOk(`Mounted workspace ${paint(GRAY, ROOT)}`);
  await pause();

  bootOk('Started process manager');
  await pause();

  const resumed = resurrect(loaded.processes);
  if (resumed) bootOk(`Restored ${resumed} autostart process${resumed === 1 ? '' : 'es'}`);
  else bootInfo('No autostart processes configured');
  await pause();

  updateInfo = await checkUpdate(false);
  const m = updateMessage(updateInfo);
  ({ ok: bootOk, warn: bootWarn, info: bootInfo })[m.level](m.msg);

  saveConfig();
  await sleep(CONFIG.bootHoldMs);

  write(CLEAR);
  neofetch();
  updateNotice();
  info("Type 'help' to list available commands.");
  showPrompt();
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let chain = boot().catch((e) => err('Boot error: ' + e.message));

rl.on('line', (raw) => {
  const line = raw.replace(/\r$/, '');
  if (fgProc) {
    if (line.trim() === 'kill') {
      info('Terminating command...');
      terminate(fgProc);
    } else {
      try {
        fgProc.stdin.write(line + '\n');
      } catch {}
    }
    return;
  }
  chain = chain.then(async () => {
    const input = line.trim();
    if (input) {
      try {
        await runLine(input);
      } catch (e) {
        err(friendly(e));
      }
    }
    showPrompt();
  });
});

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((s) => process.on(s, shutdown));
process.on('uncaughtException', (e) => err('Internal error: ' + e.message));
process.on('unhandledRejection', (e) => err('Internal error: ' + (e && e.message ? e.message : e)));

setInterval(() => procs.forEach((p) => rotateLog(logFile(p.name))), 5 * 60 * 1000).unref();
