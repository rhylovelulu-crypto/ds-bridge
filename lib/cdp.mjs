import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Minimal Chrome DevTools Protocol client.
 * Uses the global WebSocket (Node 22+) so there is no npm dependency.
 */
export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.listeners = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return this;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('cdp: connect timeout')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('cdp: ' + (e.message || 'socket error'))); });
      ws.addEventListener('message', (ev) => this._onMessage(ev.data));
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('cdp: socket closed'));
        this.pending.clear();
        this.sessionId = null;
      });
    });
    return this;
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`cdp ${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.method;
      const set = this.listeners.get(key);
      if (set) for (const fn of set) fn(msg.params || {}, msg.sessionId);
    }
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => this.listeners.get(method).delete(fn);
  }

  send(method, params = {}, sessionId = this.sessionId) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('cdp: not connected');
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`cdp ${method}: timeout`));
        }
      }, 300000);
    });
  }

  /** Opens (or reuses) a page target and attaches a flat session to it. */
  async openPage(url, { reuse = true } = {}) {
    const { targetInfos } = await this.send('Target.getTargets', {}, null);
    const existing = reuse ? targetInfos.find(t => t.type === 'page' && t.url.startsWith(url)) : null;
    let targetId = existing?.targetId;

    if (!targetId) {
      const created = await this.send('Target.createTarget', { url }, null);
      targetId = created.targetId;
    }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, null);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable').catch(() => {});
    return { targetId, sessionId };
  }

  /**
   * Creates a separate tab and returns a lightweight handle that shares this
   * socket but pins its own flat session id. Keeps concurrent streams isolated.
   */
  async newTab(url = 'about:blank') {
    const created = await this.send('Target.createTarget', { url }, null);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, null);
    const parent = this;
    const handle = Object.create(CDP.prototype);
    handle.wsUrl = this.wsUrl;
    handle.ws = this.ws;
    handle.seq = this.seq;
    handle.pending = this.pending;
    handle.listeners = this.listeners;
    handle.sessionId = sessionId;
    handle.targetId = created.targetId;
    handle.connect = async () => handle;
    handle.send = (method, params = {}) => parent.send(method, params, sessionId);
    handle.eval = async (expression, opts = {}) => {
      const res = await handle.send('Runtime.evaluate', {
        expression,
        awaitPromise: opts.awaitPromise !== false,
        returnByValue: true,
        userGesture: true,
        timeout: opts.timeoutMs ?? 300000,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error('page eval: ' + (d.exception?.description || d.text || 'evaluate failed'));
      }
      return res.result?.value;
    };
    await handle.send('Runtime.enable');
    return handle;
  }

  async eval(expression, { awaitPromise = true, timeoutMs = 300000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
      timeout: timeoutMs,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text = d.exception?.description || d.text || 'evaluate failed';
      throw new Error('page eval: ' + text);
    }
    return res.result?.value;
  }
}

const DEFAULT_PORTS = [9222, 9223, 9224];

function findBrowserExe() {
  const candidates = [
    process.env.DS_BROWSER,
    // Linux / Termux paths first: the Android guide installs chromium here.
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/**
 * Asks the OS which process owns a listening port, then reads that process's
 * command line. On Windows this is the only way to tell two browsers apart when
 * both were launched by us: Chrome does not always persist DevToolsActivePort
 * (it tends to be missing once a profile has been reused), so the file alone
 * cannot be trusted to decide ownership.
 *
 * Returns { pid, userDataDir } or null when the lookup is not possible.
 */
function portOwner(port) {
  const isWindows = process.platform === 'win32';
  try {
    let out = '';
    if (isWindows) {
      const ps = [
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
        'if (-not $c) { exit 0 }',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue`,
        'if (-not $p) { exit 0 }',
        'Write-Output ("PID=" + $p.ProcessId)',
        'Write-Output ("CMD=" + $p.CommandLine)',
      ].join('; ');
      out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        timeout: 8000,
      });
    } else {
      // Linux / Termux: read the listening socket owner from /proc, then its
      // cmdline. No external tool needed (lsof may be missing on Termux).
      const hex = port.toString(16).toUpperCase().padStart(4, '0');
      let inode = '';
      for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
        try {
          for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
            const cols = line.trim().split(/\s+/);
            // local_address is col 1, inode col 9; listening state is 0A.
            if (cols[1] && cols[1].endsWith(':' + hex) && cols[3] === '0A') { inode = cols[9]; break; }
          }
        } catch { /* file may not exist */ }
        if (inode) break;
      }
      if (!inode) return null;
      for (const pid of fs.readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
        try {
          const links = fs.readdirSync(`/proc/${pid}/fd`);
          for (const fd of links) {
            const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
            if (target === `socket:[${inode}]`) {
              const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
              return { pid: Number(pid), userDataDir: (cmd.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/) || [])[1] || (cmd.match(/--user-data-dir=(\S+)/) || [])[1] || '' };
            }
          }
        } catch { /* permission or process gone */ }
      }
      return null;
    }
    const pid = Number((out.match(/PID=(\d+)/) || [])[1] || 0);
    const cmd = (out.match(/CMD=([\s\S]*)/) || [])[1] || '';
    const dir = (cmd.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/) || []);
    const userDataDir = dir[1] || dir[2] || '';
    if (!pid) return null;
    return { pid, userDataDir };
  } catch {
    return null;
  }
}

/** True when the browser holding `port` was launched with this profile. */
function portBelongsToProfile(port, profile) {
  const owner = portOwner(port);
  if (!owner) return false;
  if (!owner.userDataDir) return false;
  const norm = s => path.resolve(s).replace(/[\\/]+$/, '').toLowerCase();
  return norm(owner.userDataDir) === norm(profile);
}

/**
 * Attaches to an already-running debug browser, or launches a dedicated one.
 *
 * Each site (cn / intl) gets its own profile directory AND its own debug port.
 * That is not cosmetic: two DeepSeek accounts sharing one cookie jar means one
 * login silently overwrites the other. Anchoring to a fixed port also makes
 * "attach to the browser that is already running" unambiguous — probing a port
 * range would happily adopt the *other* site's browser.
 *
 * @param {object} opts
 * @param {number} [opts.port]        fixed debug port; 0 = auto-pick a free one
 * @param {string} [opts.userDataDir] profile dir; default derives from profileSlot
 * @param {string} [opts.profileSlot] 'cn' / 'intl' — isolates logins
 * @param {boolean} [opts.headless]
 */
export async function ensureBrowser({ port = 0, userDataDir = '', profileSlot = 'cn', headless = false } = {}) {
  const exe = findBrowserExe();
  if (!exe) throw new Error('no Edge/Chrome found; set DS_BROWSER to the browser exe path');

  const profile = userDataDir || path.join(os.homedir(), `.ds-bridge-profile-${profileSlot}`);

  // Headless servers have no display: the flag is read from DS_HEADLESS=1 so
  // the same checkout runs desktop (visible window, login button) and server
  // (headless, login state carried in the profile directory).
  const headlessMode = headless || process.env.DS_HEADLESS === '1';

  // 1) If a browser for this exact profile already owns the port, reuse it.
  //    Ownership is decided by the process command line, not by the mere fact
  //    that something is listening — otherwise a second site would hijack the
  //    first site's browser and its login.
  if (port) {
    const info = await probe(port);
    if (info?.webSocketDebuggerUrl) {
      if (portBelongsToProfile(port, profile)) {
        return { cdp: await new CDP(info.webSocketDebuggerUrl).connect(), port, launched: false, profile };
      }
      const owner = portOwner(port);
      throw new Error(
        `port ${port} is held by a different browser profile` +
        (owner?.userDataDir ? ` (${owner.userDataDir})` : '') +
        `; refusing to share it. Close that browser or change cdpPort for "${profileSlot}".`
      );
    }
  }

  // 2) Launch on the requested port, or the first free one.
  let usePort = port;
  if (!usePort) {
    for (let p = 9222; p < 9234; p++) {
      if (!(await probe(p))) { usePort = p; break; }
    }
    if (!usePort) throw new Error('no free debug port in 9222-9233');
  }

  const args = [
    `--remote-debugging-port=${usePort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ];
  if (headlessMode) {
    args.push('--headless=new');
  } else {
    // Background relaunches (auto-recovery after the window was closed) must
    // not steal focus. The window starts minimized; the "open login" button
    // restores it via Browser.setWindowBounds when the user asks for it.
    args.push('--start-minimized');
  }

  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const info = await probe(usePort);
    if (info?.webSocketDebuggerUrl) {
      const cdp = await new CDP(info.webSocketDebuggerUrl).connect();
      // Edge ignores --start-minimized when it restores the previous session:
      // the window pops to the front on every auto-relaunch. Session restore
      // wins over the flag, so force-minimize through CDP after attaching.
      await minimizeBrowserWindow(cdp).catch(() => {});
      return { cdp, port: usePort, launched: true, profile };
    }
  }
  throw new Error(`browser for profile "${profileSlot}" did not expose port ${usePort}`);
}

/** Force-minimizes the browser's main window over CDP (needs a page session). */
async function minimizeBrowserWindow(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets', {}, null);
  const page = targetInfos.find(t => t.type === 'page');
  if (!page) return;
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId }, null);
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }, null);
}
