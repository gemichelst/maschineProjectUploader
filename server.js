/**
 * MASCHINE Project Uploader — server.js
 * Express backend with SSE streaming for rclone upload progress
 * ESM module, Phusion Passenger compatible
 */

import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3847;

// ── Config paths ──────────────────────────────────────────────────────────────
const CONFIG_DIR  = path.join(os.homedir(), '.maschine-uploader');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');

const DEFAULT_CONFIG = {
  sourceFolder:     '/Volumes/STUDIO/PROJECTS/MASCHINE',
  gdriveRemote:     'gdrive:',
  gdriveFolderId:   '1JK7DWRTYKutuAaNVn7GgwH-1PDryLqsj',
  gdriveFolderName: 'MASCHINE_BACKUP',
  defaultHours:     48,
  extensions:       'mxprj nki nksf nkm nkp wav aif aiff mp3 flac ogg m4a mid midi',
  excludePatterns:  '*.backup *.tmp *~',
  transfers:        2,
  bwLimit:          '',
  conflictMode:     'overwrite',
  appendDate:       true,
  autoOpenDrive:    false
};

const FILE_PRESETS = {
  all:        { label: 'All Files',           extensions: '' },
  maschine:   { label: 'MASCHINE Projects',   extensions: 'mxprj' },
  audio:      { label: 'Audio Only',          extensions: 'wav aif aiff mp3 flac ogg m4a' },
  masch_audio:{ label: 'MASCHINE + Audio',    extensions: 'mxprj nki nksf nkm nkp wav aif aiff mp3 flac ogg m4a' },
  ni_all:     { label: 'All NI Formats',      extensions: 'mxprj nki nksf nkm nkp nkc nkb nks' },
  midi:       { label: 'MIDI Only',           extensions: 'mid midi' },
  full:       { label: 'Full Session',        extensions: 'mxprj nki nksf nkm nkp wav aif aiff mp3 flac ogg m4a mid midi' }
};

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadHistory() {
  ensureConfigDir();
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
  } catch { return []; }
}

function saveHistory(history) {
  ensureConfigDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100), null, 2));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function buildFindArgs(sourceFolder, hours, extensions, excludePatterns) {
  const args = [sourceFolder, '-type', 'f'];
  if (hours && hours !== 'all') args.push('-mtime', `-${hours}h`);
  if (extensions && extensions.trim()) {
    const exts = extensions.trim().split(/\s+/);
    const nameArgs = [];
    exts.forEach((ext, i) => {
      if (i > 0) nameArgs.push('-o');
      nameArgs.push('-iname', `*.${ext}`);
    });
    args.push('(', ...nameArgs, ')');
  }
  if (excludePatterns && excludePatterns.trim()) {
    excludePatterns.trim().split(/\s+/).forEach(p => {
      args.push('!', '-name', p);
    });
  }
  return args;
}

// Active upload state for cancellation
let activeUpload = null;

// ── Routes ────────────────────────────────────────────────────────────────────

// Config
app.get('/api/config', (req, res) => res.json(loadConfig()));

app.post('/api/config', (req, res) => {
  const cfg = { ...loadConfig(), ...req.body };
  saveConfig(cfg);
  res.json({ ok: true, config: cfg });
});

app.get('/api/presets', (req, res) => res.json(FILE_PRESETS));

// Status — rclone installed, source accessible, remote configured
app.get('/api/status', async (req, res) => {
  const cfg = loadConfig();
  const status = { rclone: false, rcloneVersion: null, sourceFolder: false, gdriveRemote: false };

  try {
    const { stdout } = await execAsync('rclone version --json 2>/dev/null || rclone version');
    status.rclone = true;
    const m = stdout.match(/rclone\s+v([\d.]+)/i);
    status.rcloneVersion = m ? m[1] : 'installed';
  } catch { status.rclone = false; }

  try {
    status.sourceFolder = fs.existsSync(cfg.sourceFolder) &&
      fs.statSync(cfg.sourceFolder).isDirectory();
  } catch { status.sourceFolder = false; }

  try {
    if (status.rclone) {
      const { stdout } = await execAsync(`rclone listremotes 2>/dev/null`);
      const remote = cfg.gdriveRemote.replace(/:.*$/, ':');
      status.gdriveRemote = stdout.includes(remote);
    }
  } catch { status.gdriveRemote = false; }

  res.json(status);
});

// Scan — find files matching current config/filters
app.post('/api/scan', async (req, res) => {
  const { hours, extensions, excludePatterns, sourceFolder } = req.body;
  const cfg = loadConfig();
  const src = sourceFolder || cfg.sourceFolder;

  if (!fs.existsSync(src)) {
    return res.status(400).json({ error: `Source folder not found: ${src}` });
  }

  try {
    const args = buildFindArgs(src, hours ?? cfg.defaultHours, extensions ?? cfg.extensions, excludePatterns ?? cfg.excludePatterns);

    const result = await new Promise((resolve, reject) => {
      // Use shell for find with parentheses support
      const findCmd = `find "${src}" -type f ${
        (hours && hours !== 'all') ? `-mtime -${hours}h ` : ''
      }${
        (extensions && extensions.trim()) ? `\\( ${extensions.trim().split(/\s+/).map((e,i) => `${i>0?'-o ':''}-iname "*.${e}"`).join(' ')} \\) ` : ''
      }${
        (excludePatterns && excludePatterns.trim()) ? excludePatterns.trim().split(/\s+/).map(p => `! -name "${p}"`).join(' ') : ''
      } -print0 2>/dev/null`;

      exec(findCmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err);

        const files = [];
        const byDir = {};
        const byExt = {};
        let totalSize = 0;

        const paths = stdout.split('\0').filter(Boolean);
        for (const fp of paths) {
          try {
            const stat = fs.statSync(fp);
            if (!stat.isFile()) continue;
            const ext = path.extname(fp).toLowerCase().replace('.', '') || 'unknown';
            const dir = path.dirname(fp).replace(src, '').replace(/^\//, '') || '.';
            const size = stat.size;
            totalSize += size;
            byDir[dir] = (byDir[dir] || 0) + 1;
            byExt[ext] = (byExt[ext] || 0) + 1;
            files.push({
              path: fp,
              name: path.basename(fp),
              ext,
              dir,
              size,
              sizeHuman: formatBytes(size),
              modified: stat.mtime.toISOString(),
              modifiedMs: stat.mtimeMs
            });
          } catch { /* skip unreadable */ }
        }

        // Sort by modified desc
        files.sort((a, b) => b.modifiedMs - a.modifiedMs);

        resolve({
          files,
          stats: {
            count: files.length,
            totalSize,
            totalSizeHuman: formatBytes(totalSize),
            byDir,
            byExt
          }
        });
      });
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload — SSE streaming
app.post('/api/upload', async (req, res) => {
  const { files, dryRun, bwLimit, transfers, gdriveRemote, gdriveFolderName, appendDate, conflictMode } = req.body;
  const cfg = loadConfig();

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.flush) res.flush();
  };

  const remote   = gdriveRemote || cfg.gdriveRemote;
  const bw       = bwLimit || cfg.bwLimit || '';
  const t        = transfers || cfg.transfers || 2;
  const confl    = conflictMode || cfg.conflictMode || 'overwrite';
  const useDate  = appendDate !== undefined ? appendDate : cfg.appendDate;

  const dateStr  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const folderName = (gdriveFolderName || cfg.gdriveFolderName || 'MASCHINE_BACKUP') +
    (useDate ? `___${dateStr}` : '');
  const destBase = `${remote}${folderName}`;

  const sessionLog = [];
  const sessionStart = Date.now();
  let uploaded = 0, failed = 0, skipped = 0;

  send('start', {
    total: files.length,
    dest: destBase,
    dryRun: !!dryRun,
    timestamp: new Date().toISOString()
  });

  if (dryRun) {
    send('log', { msg: '🔍 DRY RUN MODE — no files will be transferred', level: 'warn' });
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filePath = typeof file === 'string' ? file : file.path;
    const fileName = path.basename(filePath);

    send('file-start', { index: i, total: files.length, file: fileName, path: filePath });

    if (dryRun) {
      await new Promise(r => setTimeout(r, 80));
      send('file-done', { index: i, file: fileName, status: 'dry-run', duration: 80 });
      send('progress', { overall: Math.round(((i + 1) / files.length) * 100), current: 100 });
      sessionLog.push({ file: fileName, status: 'dry-run' });
      uploaded++;
      continue;
    }

    const fileStart = Date.now();

    const rcloneArgs = [
      'copy',
      filePath,
      destBase,
      '--progress',
      `--transfers=${t}`,
      '--drive-use-trash=false',
      '--stats=200ms',
      '--stats-one-line'
    ];

    if (bw) rcloneArgs.push(`--bwlimit=${bw}`);
    if (confl === 'skip') rcloneArgs.push('--ignore-existing');
    if (confl === 'checksum') rcloneArgs.push('--checksum');

    await new Promise((resolve) => {
      let progressPct = 0;
      const proc = spawn('rclone', rcloneArgs);

      if (activeUpload) { /* track current */ }
      activeUpload = proc;

      const parseProgress = (line) => {
        const m = line.match(/(\d+)%/);
        if (m) {
          progressPct = parseInt(m[1], 10);
          const overall = Math.round(((i + progressPct / 100) / files.length) * 100);
          send('progress', { overall, current: progressPct, file: fileName });
        }
        const speedM = line.match(/([\d.]+\s*[KMGTkmgt]?B\/s)/);
        if (speedM) send('speed', { speed: speedM[1] });
      };

      let stderr = '';
      proc.stdout.on('data', d => { d.toString().split('\n').forEach(parseProgress); });
      proc.stderr.on('data', d => {
        const chunk = d.toString();
        stderr += chunk;
        chunk.split('\n').forEach(line => {
          if (line.trim()) parseProgress(line);
        });
      });

      proc.on('close', (code) => {
        const duration = Date.now() - fileStart;
        activeUpload = null;
        if (code === 0) {
          send('file-done', { index: i, file: fileName, status: 'ok', duration });
          send('progress', { overall: Math.round(((i + 1) / files.length) * 100), current: 100 });
          sessionLog.push({ file: fileName, status: 'ok', duration });
          uploaded++;
        } else {
          const errMsg = stderr.trim().split('\n').pop() || 'Unknown error';
          send('file-done', { index: i, file: fileName, status: 'error', error: errMsg, duration });
          send('log', { msg: `✗ ${fileName}: ${errMsg}`, level: 'error' });
          sessionLog.push({ file: fileName, status: 'error', error: errMsg });
          failed++;
        }
        resolve();
      });

      proc.on('error', (err) => {
        send('file-done', { index: i, file: fileName, status: 'error', error: err.message });
        send('log', { msg: `✗ ${fileName}: ${err.message}`, level: 'error' });
        sessionLog.push({ file: fileName, status: 'error', error: err.message });
        failed++;
        activeUpload = null;
        resolve();
      });
    });
  }

  // Save history session
  const sessionData = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    dest: destBase,
    duration: Date.now() - sessionStart,
    total: files.length,
    uploaded,
    failed,
    skipped,
    dryRun: !!dryRun,
    files: sessionLog
  };
  const history = loadHistory();
  history.push(sessionData);
  saveHistory(history);

  send('complete', {
    total: files.length,
    uploaded,
    failed,
    skipped,
    duration: Date.now() - sessionStart,
    dest: destBase,
    gdriveFolderId: cfg.gdriveFolderId
  });

  res.end();
});

// Cancel active upload
app.post('/api/upload/cancel', (req, res) => {
  if (activeUpload) {
    activeUpload.kill('SIGTERM');
    activeUpload = null;
    res.json({ ok: true, msg: 'Upload cancelled' });
  } else {
    res.json({ ok: false, msg: 'No active upload' });
  }
});

// History
app.get('/api/history', (req, res) => {
  const history = loadHistory();
  res.json(history.reverse()); // newest first
});

app.delete('/api/history', (req, res) => {
  saveHistory([]);
  res.json({ ok: true });
});

// Directory browser
app.get('/api/browse', (req, res) => {
  const dir = req.query.path || os.homedir();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = dir !== '/' ? path.dirname(dir) : null;
    res.json({ current: dir, parent, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// rclone remotes list
app.get('/api/remotes', async (req, res) => {
  try {
    const { stdout } = await execAsync('rclone listremotes 2>/dev/null');
    const remotes = stdout.trim().split('\n').filter(Boolean);
    res.json({ remotes });
  } catch {
    res.json({ remotes: [] });
  }
});

// ── GDrive OAuth Setup ────────────────────────────────────────────────────────
let activeAuthProc = null;

// POST /api/gdrive/setup — SSE stream: spawns rclone authorize, emits url → done
app.post('/api/gdrive/setup', async (req, res) => {
  const { remoteName = 'gdrive', scope = 'drive' } = req.body || {};

  // Kill any stale auth session
  if (activeAuthProc) { try { activeAuthProc.kill('SIGTERM'); } catch {} }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); if (res.flush) res.flush(); }
    catch {}
  };

  send('status', { msg: 'Starting rclone authorization…', step: 1 });

  // rclone authorize streams the auth URL + token to stdout/stderr
  const proc = spawn('rclone', ['authorize', 'drive', `--drive-scope=${scope}`, '--auth-no-open-browser'], {
    env: { ...process.env }
  });
  activeAuthProc = proc;

  let tokenBuffer = '';
  let urlSent = false;
  let gotCode = false;

  const parseLine = (line) => {
    // URL extraction
    if (!urlSent) {
      const urlMatch = line.match(/https?:\/\/\S+/);
      if (urlMatch) {
        send('url', { url: urlMatch[0], msg: 'Authorization URL ready — opening your browser…' });
        urlSent = true;
        // Try to open browser automatically (macOS / Linux)
        const opener = process.platform === 'darwin' ? 'open' :
                        process.platform === 'win32'  ? 'start' : 'xdg-open';
        exec(`${opener} "${urlMatch[0]}"`, () => {});
      }
    }
    if (/waiting for code/i.test(line)) {
      send('status', { msg: 'Waiting for Google authorization…', step: 2 });
    }
    if (/got code/i.test(line)) {
      gotCode = true;
      send('status', { msg: 'Authorization code received — saving config…', step: 3 });
    }
  };

  proc.stderr.on('data', d => d.toString().split('\n').forEach(l => parseLine(l.trim())));
  proc.stdout.on('data', d => { tokenBuffer += d.toString(); });

  proc.on('close', async (code) => {
    activeAuthProc = null;

    if (code !== 0 && !gotCode) {
      send('error', { msg: `rclone authorize exited (code ${code}) — is rclone installed?` });
      res.end(); return;
    }

    // Extract JSON token from stdout (last JSON block)
    const jsonMatch = tokenBuffer.match(/(\{[\s\S]*"access_token"[\s\S]*\})/);
    if (!jsonMatch) {
      send('error', { msg: 'Could not capture OAuth token from rclone output.' });
      res.end(); return;
    }

    const tokenJson = jsonMatch[1].trim();

    try {
      // Check if remote already exists → update, else create
      const { stdout: existing } = await execAsync('rclone listremotes 2>/dev/null');
      const remoteTag = remoteName.replace(/:$/, '') + ':';
      const cmd = existing.includes(remoteTag)
        ? `rclone config update "${remoteName.replace(/:$/, '')}" token=${JSON.stringify(tokenJson)}`
        : `rclone config create "${remoteName.replace(/:$/, '')}" drive scope=${scope} token=${JSON.stringify(tokenJson)}`;

      await execAsync(cmd);

      // Save remote name to app config
      const cfg = loadConfig();
      cfg.gdriveRemote = remoteName.replace(/:$/, '') + ':';
      saveConfig(cfg);

      send('done', {
        remoteName: remoteName.replace(/:$/, '') + ':',
        msg: `Google Drive remote "${remoteName.replace(/:$/, '')}" configured successfully!`
      });
    } catch (err) {
      send('error', { msg: 'Config creation failed: ' + err.message });
    }

    res.end();
  });

  proc.on('error', (err) => {
    activeAuthProc = null;
    send('error', { msg: 'Failed to start rclone: ' + err.message + ' — make sure rclone is installed.' });
    res.end();
  });

  // Clean up if client disconnects
  req.on('close', () => {
    if (activeAuthProc) { try { activeAuthProc.kill('SIGTERM'); } catch {} activeAuthProc = null; }
  });
});

// Cancel active auth
app.post('/api/gdrive/cancel', (req, res) => {
  if (activeAuthProc) {
    try { activeAuthProc.kill('SIGTERM'); } catch {}
    activeAuthProc = null;
    res.json({ ok: true });
  } else {
    res.json({ ok: false });
  }
});

// Delete a remote from rclone config
app.delete('/api/gdrive/remote/:name', async (req, res) => {
  const name = req.params.name.replace(/:$/, '');
  try {
    await execAsync(`rclone config delete "${name}"`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
// Note: no host arg for Phusion Passenger compatibility
app.listen(PORT, () => {
  console.log(`\n  🎛  MASCHINE Project Uploader`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Config: ${CONFIG_FILE}\n`);
});
