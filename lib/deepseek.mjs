import { solveChallenge } from './pow.mjs';
import { PARSER_SOURCE } from './stream.mjs';
import { getSite, resolveSite } from './sites.mjs';

const DEFAULT_API_BASE = 'https://chat.deepseek.com/api/v0';
const DEFAULT_ORIGIN = 'https://chat.deepseek.com';

// Values mirror what the web client sends. Per-site values (locale, timezone)
// are filled in by the constructor; these are the invariants.
const CLIENT_HEADERS = {
  'x-app-version': process.env.DS_APP_VERSION || '20241129.1',
  'x-client-platform': 'web',
  'x-client-version': process.env.DS_CLIENT_VERSION || '1.0.0-always',
};

/**
 * Headers are read from the page's own localStorage/cookie context, so a fresh
 * login in the browser is enough — nothing is copied into config files.
 */
function pageTokenExpr() {
  return `(() => {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return parsed && parsed.value ? String(parsed.value) : '';
    } catch (e) { return ''; }
  })()`;
}

/**
 * Waits until the page finishes navigating and its app context is usable.
 * A fixed sleep is unreliable: a logged-in reload can take several seconds,
 * and evaluating localStorage too early returns empty and looks like a logout.
 */
async function waitForPage(cdp, { tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 250));
    const state = await cdp.eval('document.readyState').catch(() => '');
    if (state === 'complete' || state === 'interactive') {
      const hasStore = await cdp.eval("typeof localStorage !== 'undefined'").catch(() => false);
      if (hasStore) {
        await new Promise(r => setTimeout(r, 400));
        return;
      }
    }
  }
  throw new Error('page did not become ready after navigation');
}

export class DeepSeekWeb {
  constructor(cdp, opts = {}) {
    this.cdp = cdp;
    this.thinking = opts.thinking ?? false;
    this.search = opts.search ?? false;
    this.timeoutMs = opts.timeoutMs ?? 180000;
    this.sessionId = null;
    this.parentMessageId = null;
    this.reqSeq = 0;

    // Site determines API host, locale header and the URL we keep the tab on.
    this.site = opts.site ? resolveSite(opts.site.id || opts.site, opts.siteOverrides) : getSite('cn');
    this.apiBase = this.site.apiBase || DEFAULT_API_BASE;
    this.origin = this.site.origin || DEFAULT_ORIGIN;

    // Set by the pool: builds a fresh tab when this one dies (user closed it,
    // browser restarted, or the target was discarded under memory pressure).
    this.revive = opts.revive || null;
  }

  /** API base for this worker's site. */
  get API_BASE() { return this.apiBase; }

  /** True when the underlying CDP session still exists. */
  async alive() {
    try {
      await this.cdp.eval('1');
      return true;
    } catch (err) {
      const m = String(err.message || '');
      return !/Session with given id not found|Target closed|No target with given id|not connected/i.test(m);
    }
  }

  /**
   * Rebuilds the page if the tab is gone. Returns true when recovery happened.
   * The chat session id is deliberately kept: it lives server-side at DeepSeek,
   * so only the local transport needs re-establishing.
   */
  async recover() {
    if (await this.alive()) return false;
    if (!this.revive) return false;
    this.cdp = await this.revive();
    this._pageReady = false;
    await this.ensurePage();
    return true;
  }

  async ensurePage() {
    if (this._pageReady) return this;

    // A tab handle (from CDP.newTab) is already pinned to one page. If it was
    // closed, Page.navigate would throw a stale-session error, so detect first.
    if (this.cdp.targetId) {
      if (!(await this.alive())) {
        if (this.revive) {
          this.cdp = await this.revive();
        } else {
          throw new Error('browser tab closed and no revive handler is set');
        }
      }
      const url = await this.cdp.eval('location.href').catch(() => '');
      if (!String(url).startsWith(this.origin)) {
        await this.cdp.send('Page.navigate', { url: this.origin + '/' });
        await waitForPage(this.cdp);
      }
    } else {
      await this.cdp.openPage(this.origin + '/');
      const url = await this.cdp.eval('location.href');
      if (!String(url).startsWith(this.origin)) {
        await this.cdp.send('Page.navigate', { url: this.origin + '/' });
        await waitForPage(this.cdp);
      }
    }
    this._pageReady = true;
    return this;
  }

  async token() {
    const t = await this.cdp.eval(pageTokenExpr());
    if (!t) {
      throw new Error(`not logged in on ${this.site.label}: open the browser window or the console, sign in to ${this.origin} once, then retry`);
    }
    return t;
  }

  /**
   * Fetches the account summary DeepSeek's own web client uses for its user
   * menu. GET /users/current returns email / mobile_number / area_code; called
   * from inside the page so cookies and TLS fingerprint match a UI request.
   */
  async accountInfo() {
    await this.ensurePage();
    const token = await this.token();
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(this.apiBase + '/users/current')}, {
        method: 'GET',
        credentials: 'include',
        headers: ${JSON.stringify(this.headers(token))},
      });
      const t = await r.text();
      return JSON.stringify({ status: r.status, text: t });
    })()`;
    const raw = await this.cdp.eval(expr);
    const { status, text } = JSON.parse(raw);
    if (status !== 200) throw new Error(`users/current -> ${status}`);
    const json = JSON.parse(text);
    const info = json?.data?.biz_data;
    if (!info) return null;
    return {
      email: String(info.email || ''),
      phone: String(info.mobile_number || ''),
      name: '',
      areaCode: String(info.area_code || ''),
      id: String(info.id || ''),
    };
  }

  headers(token, extra = {}) {
    return {
      accept: '*/*',
      'accept-language': this.site.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: this.origin,
      referer: this.origin + '/',
      ...CLIENT_HEADERS,
      'x-client-locale': this.site.locale || 'zh_CN',
      'x-client-timezone-offset': String(this.site.timezoneOffset ?? '28800'),
      ...extra,
    };
  }

  /** POSTs JSON from inside the page so cookies, TLS fingerprint and CORS all match. */
  async postJSON(path, body, headers) {
    const expr = `(async () => {
      const r = await fetch(${JSON.stringify(this.apiBase + path)}, {
        method: 'POST',
        credentials: 'include',
        headers: ${JSON.stringify(headers)},
        body: ${JSON.stringify(JSON.stringify(body))}
      });
      const text = await r.text();
      return JSON.stringify({ status: r.status, text });
    })()`;
    const raw = await this.cdp.eval(expr);
    const { status, text } = JSON.parse(raw);
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (status !== 200) {
      const detail = json ? JSON.stringify(json).slice(0, 600) : String(text).slice(0, 600);
      const err = new Error(`deepseek ${path} -> ${status}: ${detail}`);
      err.status = status;
      throw err;
    }
    return json;
  }

  async createSession() {
    const token = await this.token();
    const json = await this.postJSON('/chat_session/create', { character_id: null }, this.headers(token));
    const id = json?.data?.biz_data?.id;
    if (!id) throw new Error('chat_session/create: unexpected payload ' + JSON.stringify(json).slice(0, 400));
    this.sessionId = id;
    this.parentMessageId = null;
    return id;
  }

  async powHeader(targetPath = '/api/v0/chat/completion') {
    const token = await this.token();
    const json = await this.postJSON('/chat/create_pow_challenge', { target_path: targetPath }, this.headers(token));
    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge) throw new Error('create_pow_challenge: no challenge in payload');
    return solveChallenge(challenge);
  }

  /**
   * Streams one completion. Calls onDelta({text, thinking}) as content arrives.
   * @returns {Promise<{text:string, thinking:string, finish:string}>}
   */
  async completion(prompt, { onDelta, thinking = this.thinking, search = this.search, newSession = false } = {}) {
    await this.ensurePage();
    if (newSession || !this.sessionId) await this.createSession();

    const token = await this.token();
    const pow = await this.powHeader();
    const reqId = `r${++this.reqSeq}`;

    const body = {
      chat_session_id: this.sessionId,
      parent_message_id: this.parentMessageId,
      prompt,
      ref_file_ids: [],
      thinking_enabled: !!thinking,
      search_enabled: !!search,
    };
    const headers = this.headers(token, { 'x-ds-pow-response': pow });

    // Kick off the stream inside the page and buffer it on window for polling.
    // The SSE parser is injected as source so page and Node share one implementation.
    const startExpr = `(() => {
      const P = ${PARSER_SOURCE};
      window.__ds = window.__ds || {};
      const store = { text: '', thinking: '', done: false, error: null, finish: '' };
      window.__ds[${JSON.stringify(reqId)}] = store;
      (async () => {
        const state = { text: '', thinking: '', finish: '', error: null, responseId: null };
        const r = await fetch(${JSON.stringify(this.apiBase + '/chat/completion')}, {
          method: 'POST',
          credentials: 'include',
          headers: ${JSON.stringify(headers)},
          body: ${JSON.stringify(JSON.stringify(body))}
        });
        if (!r.ok) {
          const t = await r.text();
          store.error = r.status + ': ' + t.slice(0, 600);
          return;
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let event = '';
        const flush = block => {
          const lines = block.split(/\\r?\\n/);
          let ev = '';
          const data = [];
          for (const line of lines) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) data.push(line.slice(5).trim());
          }
          if (!data.length) return;
          const raw = data.join('\\n');
          if (!raw || raw === '[DONE]') return;
          let payload;
          try { payload = JSON.parse(raw); } catch (e) { return; }
          if (ev === 'close') { if (!state.finish) state.finish = 'stop'; return; }
          if (ev === 'ready') { if (payload.response_message_id) state.responseId = payload.response_message_id; return; }
          if (ev === 'title' || ev === 'update_session') return;
          const d = P.applyFrame(state, payload);
          if (d.text) store.text += d.text;
          if (d.thinking) store.thinking += d.thinking;
          if (state.error) store.error = state.error;
          if (state.finish) store.finish = state.finish;
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\\n\\n')) >= 0) {
            flush(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
        }
        if (buf.trim()) flush(buf);
        if (!store.finish) store.finish = 'stop';
      })().catch(e => { store.error = String((e && e.message) || e); })
        .finally(() => { store.done = true; });
      return 'started';
    })()`;

    await this.cdp.eval(startExpr, { awaitPromise: false });

    const deadline = Date.now() + this.timeoutMs;
    let seenText = 0;
    let seenThinking = 0;
    let text = '';
    let think = '';
    let finish = '';

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 90));
      const snap = JSON.parse(await this.cdp.eval(
        `JSON.stringify(window.__ds && window.__ds[${JSON.stringify(reqId)}] || {missing:true})`
      ));
      if (snap.missing) throw new Error('page state lost (navigation or reload during stream)');
      if (snap.error) throw new Error('deepseek stream: ' + snap.error);

      if (snap.text.length > seenText) {
        const chunk = snap.text.slice(seenText);
        seenText = snap.text.length;
        text = snap.text;
        if (onDelta) onDelta({ text: chunk, thinking: '' });
      }
      if (snap.thinking.length > seenThinking) {
        const chunk = snap.thinking.slice(seenThinking);
        seenThinking = snap.thinking.length;
        think = snap.thinking;
        if (onDelta && thinking) onDelta({ text: '', thinking: chunk });
      }
      if (snap.finish) finish = snap.finish;
      if (snap.done) {
        finish = snap.finish || 'stop';
        break;
      }
    }

    // release page memory
    await this.cdp.eval(`(() => { if (window.__ds) delete window.__ds[${JSON.stringify(reqId)}]; return 1; })()`).catch(() => {});

    if (!finish) finish = 'stop';
    return { text, thinking: think, finish };
  }
}
