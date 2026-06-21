// ==UserScript==
// @name         组卷网 - 离线导出飞跃版 v3（答案预加载/稳定ZIP Debug包/黑金UI）
// @namespace    https://greasyfork.org/users/1566377-frank-678
// @version      3.0.0-alpha.4
// @description  修复：答案懒加载导致大量“未抓到答案”。导出答案前强制滚动预加载全部题的答案DOM；Debug包必出ZIP(无依赖)；黑金UI；标题对齐下拉框
// @author       Frank-678
// @match        https://zujuan.xkw.com/*
// @match        https://www.zxxk.com/zujuan/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @license      AGPL-3.0-or-later
// ==/UserScript==

(function () {
  'use strict';

  /******************************************************************
   * 0) App
   ******************************************************************/
  const APP = {
    name: 'PZ Exporter v3',
    version: '3.0.0-alpha.4',
    ids: {
      btn: 'pz_v3_btn',
      panel: 'pz_v3_panel',
      log: 'pz_v3_log',
      prog: 'pz_v3_progress',
      tasks: 'pz_v3_tasks',
    },
  };

  function hasQuestionDOM() {
    return !!document.querySelector('.tk-quest-item, .exam-cnt, .exam-list');
  }

  function waitForQuestionDOM(timeoutMs = 12000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (hasQuestionDOM()) { clearInterval(timer); resolve(true); return; }
        if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(false); }
      }, 200);
    });
  }

  /******************************************************************
   * 1) Utils
   ******************************************************************/
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => ('' + (s ?? '')).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const nowStamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  };
  function normalizeUrl(u) {
    if (!u) return u;
    u = ('' + u).trim();
    if (u.startsWith('data:')) return u;
    if (u.startsWith('//')) return location.protocol + u;
    if (u.startsWith('/')) return location.origin + u;
    return u;
  }
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1200);
  }
  function toast(text) {
    try { GM_notification({ title: APP.name, text, timeout: 1600 }); }
    catch(e) { console.log('[toast]', text); }
  }
  function openPrintWindow(html, title='print') {
    const w = window.open('', '_blank');
    if (!w) { alert('浏览器拦截新窗口，请允许弹窗后重试'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    try { w.document.title = title; } catch(e) {}
    setTimeout(() => { w.focus(); w.print(); }, 500);
  }
  function clampInt(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  /******************************************************************
   * 2) Logger / Debug state
   ******************************************************************/
  const Debug = {
    state: {
      app: { name: APP.name, version: APP.version },
      page: { url: location.href, origin: location.origin, ua: navigator.userAgent, time: new Date().toISOString() },
      prefs: null,
      selectorDoctor: [],
      network: [],
      resourceProbes: [],
      errors: [],
      tasks: [],
      loginProbe: [],
      preloadProbe: [], // 新增：答案预加载记录
    },
    recordError(where, err, extra={}) {
      this.state.errors.push({
        where,
        message: String(err?.message || err),
        stack: String(err?.stack || ''),
        time: new Date().toISOString(),
        extra,
      });
    },
    netPush(evt) {
      this.state.network.push(Object.assign({ time: new Date().toISOString() }, evt));
      if (this.state.network.length > 4000) this.state.network.splice(0, this.state.network.length - 4000);
    },
    probePush(p) {
      this.state.resourceProbes.push(Object.assign({ time: new Date().toISOString() }, p));
      if (this.state.resourceProbes.length > 8000) this.state.resourceProbes.splice(0, this.state.resourceProbes.length - 8000);
    },
    loginPush(p) {
      this.state.loginProbe.push(Object.assign({ time: new Date().toISOString() }, p));
      if (this.state.loginProbe.length > 400) this.state.loginProbe.splice(0, this.state.loginProbe.length - 400);
    },
    preloadPush(p) {
      this.state.preloadProbe.push(Object.assign({ time: new Date().toISOString() }, p));
      if (this.state.preloadProbe.length > 2000) this.state.preloadProbe.splice(0, this.state.preloadProbe.length - 2000);
    }
  };

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    const el = $('#' + APP.ids.log);
    if (el) el.innerHTML = `<div>${esc(line)}</div>` + el.innerHTML;
    console.log(line);
  }

  function setProgress(pct) {
    const el = $('#' + APP.ids.prog);
    if (!el) return;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    el.style.width = `${p}%`;
  }

  /******************************************************************
   * 3) Network observer (observe only)
   ******************************************************************/
  function installNetworkObserver() {
    if (window.__pz_v3_net_observed) return;
    window.__pz_v3_net_observed = true;

    const _fetch = window.fetch;
    window.fetch = async function (...args) {
      const t0 = performance.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || 'GET';
      try {
        const resp = await _fetch.apply(this, args);
        Debug.netPush({ type: 'fetch', url: String(url), method, status: resp.status, ok: resp.ok, ms: Math.round(performance.now() - t0) });
        return resp;
      } catch (e) {
        Debug.netPush({ type: 'fetch', url: String(url), method, status: 0, ok: false, ms: Math.round(performance.now() - t0), note: String(e?.message || e) });
        throw e;
      }
    };

    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__pz_meta = { method, url, t0: 0 };
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const meta = this.__pz_meta || { method: 'GET', url: '', t0: 0 };
      meta.t0 = performance.now();
      const onLoadend = () => {
        Debug.netPush({
          type: 'xhr',
          url: String(meta.url),
          method: String(meta.method),
          status: Number(this.status || 0),
          ok: this.status >= 200 && this.status < 300,
          ms: Math.round(performance.now() - meta.t0),
        });
        this.removeEventListener('loadend', onLoadend);
      };
      this.addEventListener('loadend', onLoadend);
      return _send.apply(this, arguments);
    };
  }

  /******************************************************************
   * 4) Adaptive Rate limiter
   ******************************************************************/
  const Rate = {
    dyn: { conc: 3, delayMs: 120, cooldownUntil: 0, badCount: 0, goodStreak: 0 },
    configureFromPrefs(prefs) {
      this.dyn.conc = clampInt(prefs.concurrency, 1, 12, 3);
      this.dyn.delayMs = clampInt(prefs.delayMs, 0, 5000, 120);
      this.dyn.cooldownUntil = 0;
      this.dyn.badCount = 0;
      this.dyn.goodStreak = 0;
    },
    onBad(status, prefs) {
      if (status !== 429 && status !== 403) return;
      this.dyn.badCount++;
      this.dyn.goodStreak = 0;
      this.dyn.conc = Math.max(1, Math.floor(this.dyn.conc * 0.6));
      this.dyn.delayMs = Math.min(3000, Math.round(this.dyn.delayMs * 1.7 + 80));
      const coolMs = clampInt(prefs.blockMs, 10_000, 60*60*1000, 10*60*1000);
      this.dyn.cooldownUntil = Date.now() + coolMs;
      log(`触发限速保护：status=${status} → 并发=${this.dyn.conc}, 延迟=${this.dyn.delayMs}ms, 冷却=${Math.round(coolMs/1000)}s`);
    },
    onGood() {
      this.dyn.goodStreak++;
      if (this.dyn.goodStreak >= 18) {
        this.dyn.goodStreak = 0;
        this.dyn.conc = Math.min(this.dyn.conc + 1, 8);
        this.dyn.delayMs = Math.max(0, Math.round(this.dyn.delayMs * 0.9));
      }
    },
    async waitCooldownIfNeeded() {
      if (Date.now() < this.dyn.cooldownUntil) {
        const left = this.dyn.cooldownUntil - Date.now();
        log(`冷却中：等待 ${Math.round(left/1000)}s...`);
        await sleep(Math.min(left, 5000));
      }
    }
  };

  /******************************************************************
   * 5) Promise Pool with cancel token
   ******************************************************************/
  class CancelToken {
    constructor() { this.cancelled = false; this.reason = ''; }
    cancel(reason='cancelled') { this.cancelled = true; this.reason = reason; }
    throwIfCancelled() { if (this.cancelled) throw new Error('Cancelled: ' + this.reason); }
  }

  async function promisePool(items, workerFn, opts) {
    const { concurrency = 3, onProgress = null, cancelToken = null } = opts || {};
    const total = items.length;
    let idx = 0;
    let done = 0;
    const results = new Array(total);

    async function workerLoop(workerId) {
      while (true) {
        if (cancelToken) cancelToken.throwIfCancelled();
        const cur = idx++;
        if (cur >= total) return;
        try {
          const r = await workerFn(items[cur], cur, workerId);
          results[cur] = { ok: true, value: r };
        } catch (e) {
          results[cur] = { ok: false, error: e };
        } finally {
          done++;
          if (typeof onProgress === 'function') onProgress(done, total);
        }
      }
    }

    const workers = [];
    for (let i=0;i<Math.max(1, concurrency);i++) workers.push(workerLoop(i+1));
    await Promise.all(workers);
    return results;
  }

  /******************************************************************
   * 6) Fetch helpers (fetch -> GM_xhr fallback)
   ******************************************************************/
  function gmXhr(url, responseType='blob', timeoutMs=25000) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType,
          timeout: timeoutMs,
          onload: (resp) => resolve(resp),
          onerror: () => reject(new Error('GM_xhr onerror')),
          ontimeout: () => reject(new Error('GM_xhr timeout')),
        });
      } catch (e) { reject(e); }
    });
  }

  async function fetchBlobSmart(url, prefs, cancelToken) {
    const u = normalizeUrl(url);
    const timeoutMs = clampInt(prefs.timeoutMs, 3000, 120000, 25000);
    const retry = clampInt(prefs.retry, 0, 8, 2);

    for (let attempt=0; attempt<=retry; attempt++) {
      if (cancelToken) cancelToken.throwIfCancelled();

      while (Date.now() < Rate.dyn.cooldownUntil) {
        await Rate.waitCooldownIfNeeded();
        if (cancelToken) cancelToken.throwIfCancelled();
      }
      if (Rate.dyn.delayMs > 0) await sleep(Rate.dyn.delayMs);

      // 1) fetch
      const t0 = performance.now();
      try {
        const resp = await fetch(u, { method: 'GET', credentials: 'include', cache: 'force-cache' });
        if (!resp.ok) throw Object.assign(new Error('fetch HTTP ' + resp.status), { status: resp.status });
        const blob = await resp.blob();
        Debug.probePush({ url: u, ok: true, via: 'fetch', status: resp.status, ms: Math.round(performance.now()-t0), size: blob.size || 0 });
        Rate.onGood();
        return { blob, via: 'fetch', status: resp.status };
      } catch (e) {
        const st = Number(e?.status || 0);
        Debug.probePush({ url: u, ok: false, via: 'fetch', status: st, ms: Math.round(performance.now()-t0), error: String(e?.message || e) });
        if (st === 429 || st === 403) Rate.onBad(st, prefs);
      }

      // 2) GM_xhr
      const t1 = performance.now();
      try {
        const resp = await gmXhr(u, 'blob', timeoutMs);
        const ok = resp.status >= 200 && resp.status < 300;
        if (!ok) throw Object.assign(new Error('GM_xhr HTTP ' + resp.status), { status: resp.status });
        const blob = resp.response;
        Debug.probePush({ url: u, ok: true, via: 'GM_xhr', status: resp.status, ms: Math.round(performance.now()-t1), size: blob?.size || 0 });
        Rate.onGood();
        return { blob, via: 'GM_xhr', status: resp.status };
      } catch (e2) {
        const st2 = Number(e2?.status || 0);
        Debug.probePush({ url: u, ok: false, via: 'GM_xhr', status: st2, ms: Math.round(performance.now()-t1), error: String(e2?.message || e2) });
        if (st2 === 429 || st2 === 403) Rate.onBad(st2, prefs);
      }

      if (attempt < retry) {
        const back = Math.min(2500, 200 * Math.pow(2, attempt) + Math.round(Math.random()*120));
        await sleep(back);
      }
    }

    throw new Error('fetchBlobSmart failed: ' + u);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  /******************************************************************
   * 7) Minimal ZIP writer (STORE, no compression) — Debug包必出ZIP
   ******************************************************************/
  function _u16(n){ return new Uint8Array([n & 255, (n>>>8) & 255]); }
  function _u32(n){ return new Uint8Array([n & 255, (n>>>8) & 255, (n>>>16) & 255, (n>>>24) & 255]); }
  function _concatU8(chunks){
    let len = 0; for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks){ out.set(c, off); off += c.length; }
    return out;
  }
  function _encodeUtf8(s){ return new TextEncoder().encode(s); }

  const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i=0;i<256;i++){
      let c=i;
      for (let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
      t[i]=c>>>0;
    }
    return t;
  })();
  function crc32(u8){
    let c = 0xFFFFFFFF;
    for (let i=0;i<u8.length;i++){
      c = _crcTable[(c ^ u8[i]) & 255] ^ (c>>>8);
    }
    return (c ^ 0xFFFFFFFF)>>>0;
  }
  function _dosDateTime(d=new Date()){
    const year = d.getFullYear();
    const month = d.getMonth()+1;
    const day = d.getDate();
    const hours = d.getHours();
    const mins = d.getMinutes();
    const secs = Math.floor(d.getSeconds()/2);
    const dosTime = ((hours & 31) << 11) | ((mins & 63) << 5) | (secs & 31);
    const dosDate = (((year-1980) & 127) << 9) | ((month & 15) << 5) | (day & 31);
    return { dosTime, dosDate };
  }
  function zipCreate(){ return { files: [] }; }
  async function zipAddText(zip, path, text){
    const u8 = _encodeUtf8(text);
    zip.files.push({ path, dataU8: u8, crc: crc32(u8), size: u8.length });
  }
  async function zipAddBlob(zip, path, blob){
    const ab = await blob.arrayBuffer();
    const u8 = new Uint8Array(ab);
    zip.files.push({ path, dataU8: u8, crc: crc32(u8), size: u8.length });
  }
  function zipFinalize(zip){
    const parts = [];
    const central = [];
    let offset = 0;
    const now = _dosDateTime(new Date());

    for (const f of zip.files){
      const nameU8 = _encodeUtf8(f.path);
      f.offset = offset;
      f.dosTime = now.dosTime;
      f.dosDate = now.dosDate;

      const local = _concatU8([
        _u32(0x04034b50),
        _u16(20),
        _u16(0),
        _u16(0),
        _u16(f.dosTime),
        _u16(f.dosDate),
        _u32(f.crc),
        _u32(f.size),
        _u32(f.size),
        _u16(nameU8.length),
        _u16(0),
        nameU8,
        f.dataU8
      ]);
      parts.push(local);
      offset += local.length;

      const cdir = _concatU8([
        _u32(0x02014b50),
        _u16(0x0314),
        _u16(20),
        _u16(0),
        _u16(0),
        _u16(f.dosTime),
        _u16(f.dosDate),
        _u32(f.crc),
        _u32(f.size),
        _u32(f.size),
        _u16(nameU8.length),
        _u16(0),
        _u16(0),
        _u16(0),
        _u16(0),
        _u32(0),
        _u32(f.offset),
        nameU8
      ]);
      central.push(cdir);
    }

    const centralStart = offset;
    const centralU8 = _concatU8(central);
    offset += centralU8.length;

    const eocd = _concatU8([
      _u32(0x06054b50),
      _u16(0), _u16(0),
      _u16(zip.files.length),
      _u16(zip.files.length),
      _u32(centralU8.length),
      _u32(centralStart),
      _u16(0)
    ]);

    const finalU8 = _concatU8([...parts, centralU8, eocd]);
    return new Blob([finalU8], { type: 'application/zip' });
  }

  /******************************************************************
   * 8) Resource embedder (Data-URI)
   ******************************************************************/
  function collectResourceUrlsFromFragment(rootEl) {
    const urlMap = new Map();
    const add = (url, node, kind) => {
      const u = normalizeUrl(url);
      if (!u || u.startsWith('data:')) return;
      const arr = urlMap.get(u) || [];
      arr.push({ node, kind });
      urlMap.set(u, arr);
    };

    $$('img', rootEl).forEach(img => {
      // 关键：懒加载情况下，src可能为空，但 data-src / data-original 有值
      const src = img.getAttribute('src');
      const ds = img.getAttribute('data-src') || img.getAttribute('data-original');
      if (!src && ds) img.setAttribute('src', ds);
      const finalSrc = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
      if (finalSrc) add(finalSrc, img, 'img');

      const ss = img.getAttribute('srcset');
      if (ss && !finalSrc) {
        const first = ss.split(',')[0]?.trim()?.split(' ')[0];
        if (first) add(first, img, 'img');
      }
    });

    $$('*', rootEl).forEach(el => {
      const st = el.getAttribute('style');
      if (st && /url\(/i.test(st)) {
        const re = /url\(['"]?([^'")]+)['"]?\)/ig;
        let m;
        while ((m = re.exec(st))) add(m[1], el, 'style-url');
      }
    });

    return urlMap;
  }

  async function embedResourcesInHTML(html, prefs, ctx) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html || '';

    const urlMap = collectResourceUrlsFromFragment(wrap);
    const urls = Array.from(urlMap.keys());
    const cache = (ctx && ctx.task && ctx.task.resourceCache) ? ctx.task.resourceCache : new Map();

    const maxMB = clampInt(prefs.maxEmbedMB, 1, 200, 12);
    const maxBytes = maxMB * 1024 * 1024;
    let totalBytes = ctx.task ? (ctx.task.embedBytes || 0) : 0;

    const toFetch = urls.filter(u => !cache.has(u));
    const cancelToken = ctx.task.cancelToken;

    const results = await promisePool(
      toFetch,
      async (u) => {
        if (cancelToken) cancelToken.throwIfCancelled();
        while (Date.now() < Rate.dyn.cooldownUntil) {
          await Rate.waitCooldownIfNeeded();
          if (cancelToken) cancelToken.throwIfCancelled();
        }

        const r = await fetchBlobSmart(u, prefs, cancelToken);
        const blob = r.blob;
        const size = blob.size || 0;

        if (totalBytes + size > maxBytes) {
          cache.set(u, { ok: false, dataUrl: null, skipped: true, reason: `embed cap ${maxMB}MB exceeded` });
          return { u, ok: false, skipped: true };
        }

        const dataUrl = await blobToDataURL(blob);
        totalBytes += size;
        cache.set(u, { ok: true, dataUrl, size, via: r.via, status: r.status });
        return { u, ok: true };
      },
      {
        concurrency: Math.max(1, Rate.dyn.conc),
        cancelToken,
        onProgress: (done, total) => {
          if (ctx && typeof ctx.onSubProgress === 'function') ctx.onSubProgress(done, total);
        }
      }
    );

    for (const [u, nodes] of urlMap.entries()) {
      const info = cache.get(u);
      if (!info || !info.ok || !info.dataUrl) continue;
      for (const { node, kind } of nodes) {
        try {
          if (kind === 'img') {
            node.setAttribute('src', info.dataUrl);
            node.removeAttribute('data-src');
            node.removeAttribute('data-original');
            node.removeAttribute('srcset');
          } else if (kind === 'style-url') {
            const st = node.getAttribute('style') || '';
            node.setAttribute('style', st.split(u).join(info.dataUrl));
          }
        } catch (e) {}
      }
    }

    if (ctx.task) {
      ctx.task.resourceCache = cache;
      ctx.task.embedBytes = totalBytes;
      ctx.task.failedResources = ctx.task.failedResources || [];
      for (const r of results) if (r && r.ok === false) ctx.task.failedResources.push(r);
    }

    return wrap.innerHTML;
  }

  /******************************************************************
   * 9) Login check before exporting answers
   ******************************************************************/
  function isLoggedInHeuristic() {
    const bodyText = document.body?.innerText || '';
    const hasLogoutOrUser =
      !!document.querySelector('a[href*="logout"], a[href*="Logout"], .user, .userinfo, .avatar, .head-user, .user-name') ||
      bodyText.includes('退出');
    if (hasLogoutOrUser) return true;

    const hasLoginLink =
      !!document.querySelector('a[href*="login"], a[href*="Login"], a[href*="passport"], .login, .head-login') ||
      (bodyText.includes('登录') && !bodyText.includes('退出'));
    if (hasLoginLink) return false;

    return true;
  }

  async function checkLoginBeforeAnswers() {
    const heur = isLoggedInHeuristic();
    Debug.loginPush({ kind: 'heuristic', result: heur });
    if (heur === false) return false;

    try {
      const resp = await gmXhr(location.origin, 'text', 12000);
      const t = (resp.responseText || resp.response || '').slice(0, 80000);
      const looksLogin = /登录|注册|passport|signin|sign in/i.test(t) && !/退出|logout/i.test(t);
      Debug.loginPush({ kind: 'origin_probe', status: resp.status, looksLogin });
      if (looksLogin) return false;
    } catch (e) {
      Debug.loginPush({ kind: 'origin_probe', error: String(e?.message || e) });
    }
    return true;
  }

  /******************************************************************
   * 10) Collect questions & show answers
   ******************************************************************/
  function collectQuestions(dedupeByQid=true) {
    const nodes = $$('.tk-quest-item');
    const seen = new Set();
    const out = [];
    let order = 1;

    for (const n of nodes) {
      const qid =
        n.getAttribute('questionid') ||
        (n.querySelector('.wrapper.quesdiv')?.id?.replace('quesdiv', '') ?? '');
      const id = qid || `noqid_${order}`;
      if (dedupeByQid && seen.has(id)) continue;
      seen.add(id);

      const qCnt = n.querySelector('.exam-item__cnt') || n.querySelector('.wrapper.quesdiv') || n;
      const ansBlock = n.querySelector('.exam-item__opt .item.answer') || n.querySelector('.item.answer');
      const typeText = n.querySelector('.ques-additional .left-msg')?.innerText || '';

      out.push({
        order: order++,
        qid: id,
        typeText,
        qHtml: qCnt ? qCnt.innerHTML : '',
        aHtml: ansBlock ? ansBlock.innerHTML : '',
        node: n,
      });
    }
    return out;
  }

  async function showAllAnswersAndWait(timeoutMs = 9000) {
    try {
      const chk = document.getElementById('isshowAnswer');
      if (chk && !chk.checked) {
        const lab = document.querySelector('label[for="isshowAnswer"]') || document.querySelector('.show-answer');
        (lab || chk).click();
      }
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const blocks = document.querySelectorAll('.exam-item__opt .item.answer, .item.answer');
        if (blocks.length) {
          let any = false;
          blocks.forEach(b => {
            if ((b.innerText || '').trim() || b.querySelector('img')) any = true;
          });
          if (any) return true;
        }
        await sleep(200);
      }
      return false;
    } catch (e) {
      Debug.recordError('showAllAnswersAndWait', e);
      return false;
    }
  }

  // ✅ 关键新增：导出答案前，强制触发懒加载，把所有题的答案img填充出来
  async function preloadAllAnswers(task, prefs) {
    const items = $$('.tk-quest-item');
    if (!items.length) return;

    task.setStage(`答案预加载：滚动触发懒加载（${items.length}题）...`);
    Debug.preloadPush({ kind: 'start', count: items.length });

    // 确保“显示答案”开关开启
    await showAllAnswersAndWait(4000);

    // 逐题滚动到中间，等待答案块出现/填充
    for (let i = 0; i < items.length; i++) {
      task.cancelToken.throwIfCancelled();

      const el = items[i];
      const qid = el.getAttribute('questionid') || `idx_${i+1}`;
      task.setStage(`答案预加载：${i+1}/${items.length} QID:${qid}`);
      task.setProgress((i / items.length) * 20); // 预加载占前20%

      // 触发 IntersectionObserver / lazy loader
      try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(e) { el.scrollIntoView(); }
      await sleep(Math.max(80, clampInt(prefs.delayMs, 0, 5000, 120)));

      // 尝试把 data-src 填到 src
      const ans = el.querySelector('.exam-item__opt .item.answer, .item.answer');
      if (ans) {
        const imgs = ans.querySelectorAll('img');
        imgs.forEach(img => {
          const src = img.getAttribute('src');
          const ds = img.getAttribute('data-src') || img.getAttribute('data-original');
          if ((!src || src.trim()==='') && ds) img.setAttribute('src', ds);
        });
      }

      // 等待答案内容出现：img 有 src 或 answer 有文字
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 2500) {
        const a = el.querySelector('.exam-item__opt .item.answer, .item.answer');
        if (a) {
          const hasText = (a.innerText || '').trim().length > 0;
          const hasImg = !!a.querySelector('img[src], img[data-src], img[data-original]');
          if (hasText || hasImg) { ok = true; break; }
        }
        await sleep(120);
      }
      Debug.preloadPush({ kind: 'qid', qid, ok });

      // 少量让步，别把站点节流炸掉
      await sleep(80);
    }

    task.setProgress(20);
    Debug.preloadPush({ kind: 'done' });
  }

  /******************************************************************
   * 11) Export builders (paper/answers) + title align dropdown
   ******************************************************************/
  function buildPrintCSS(prefs) {
    const pageBreak = prefs.eachQuestionNewPage ? 'page-break-after: always;' : '';
    const margin = clampInt(prefs.pageMarginMm, 5, 30, 12);
    return `<style>
@page { size: A4; margin: ${margin}mm; }
html, body { margin:0; padding:0; background:#fff !important; }
* { box-sizing:border-box; }
body { font-family: Arial, "Microsoft Yahei", sans-serif; color:#000; }
img { max-width:100% !important; height:auto !important; }
table { width:100% !important; max-width:100% !important; border-collapse: collapse; }
td, th { word-break: break-word; overflow-wrap:anywhere; }
.pz-paper { max-width: 190mm; margin: 0 auto; padding: 0; }
.pz-title { font-size: 18px; font-weight: 700; margin: 6mm 0 3mm; }
.pz-meta { font-size: 12px; margin: 0 0 4mm; }
.pz-q { padding: 3mm 0; ${pageBreak} }
.pz-qhead { font-weight:700; margin-bottom: 2mm; }
.pz-answer { margin-top: 2mm; }
.pz-answer-label { font-weight:700; margin-right: 6px; }
.pz-lines { margin-top: 3mm; }
.pz-line { height: 6mm; border-bottom: 1px solid #000; margin: 0 0 3mm; }
</style>`;
  }

  function makeLinesHTML(n) {
    const count = Math.max(0, Math.min(40, Number(n || 0)));
    if (!count) return '';
    return `<div class="pz-lines">${Array.from({length:count},()=>`<div class="pz-line"></div>`).join('')}</div>`;
  }

  function guessSolveSet(questions, prefs) {
    const solveSet = new Set();
    for (const q of questions) {
      const t = q.typeText || '';
      if (/解答题|计算题|证明题|应用题|作图题|问答题/.test(t)) solveSet.add(q.qid);
    }
    const parseList = (s) => (s||'').split(/[\s,，;；]+/g).map(x=>x.trim()).filter(Boolean);
    for (const id of parseList(prefs.manualSolveQids)) solveSet.add(id);
    for (const id of parseList(prefs.manualNotSolveQids)) solveSet.delete(id);
    return solveSet;
  }

  function titleHTML(title, align) {
    if (!align || align === 'none') return '';
    const a = align === 'center' ? 'center' : (align === 'right' ? 'right' : 'left');
    return `<div class="pz-title" style="text-align:${a}">${esc(title)}</div>`;
  }

  async function buildPaperHTML(questions, prefs, task) {
    const title = (document.querySelector('.exam-title .title-txt')?.innerText || '试卷').trim();
    const solveSet = guessSolveSet(questions, prefs);

    const metaLines = [];
    if (prefs.showExportTime) metaLines.push(`导出时间：${new Date().toLocaleString()}`);
    if (prefs.showQuestionCount) metaLines.push(`题数：${questions.length}`);
    const metaHtml = metaLines.length ? `<div class="pz-meta">${metaLines.map(esc).join('　　')}</div>` : '';

    const items = [];
    for (let i=0;i<questions.length;i++) {
      task.cancelToken.throwIfCancelled();
      const q = questions[i];
      task.setStage(`试卷：处理题目 ${i+1}/${questions.length} QID:${q.qid}`);

      let qHtml = q.qHtml || '';
      if (prefs.embedImages) {
        qHtml = await embedResourcesInHTML(qHtml, prefs, {
          task,
          label: `paper-q-${q.qid}`,
          onSubProgress: (d,t) => task.setProgress(20 + (i + d/Math.max(1,t))/questions.length * 80),
        });
      }

      const headBits = [];
      if (prefs.showOrder) headBits.push(`${q.order}.`);
      if (prefs.showQid) headBits.push(`QID:${q.qid}`);
      if (prefs.showScore) headBits.push(`(${Number(prefs.defaultScore||0)}分)`);

      const isSolve = solveSet.has(q.qid);
      const lines = prefs.addBlankLines ? (isSolve ? makeLinesHTML(prefs.solveLines) : makeLinesHTML(prefs.nonSolveLines)) : '';

      items.push(`
<section class="pz-q" data-qid="${esc(q.qid)}">
  ${headBits.length ? `<div class="pz-qhead">${esc(headBits.join(' '))}</div>` : ''}
  <div class="pz-qbody">${qHtml}</div>
  ${lines}
</section>`.trim());

      task.setProgress(20 + (i+1)/questions.length * 80);
    }

    const html = `<!doctype html><html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)}</title>
${buildPrintCSS(prefs)}
</head><body>
<div class="pz-paper">
  ${titleHTML(title, prefs.paperTitleAlign)}
  ${metaHtml}
  ${items.join('\n')}
</div>
</body></html>`;

    return { html, title };
  }

  async function buildAnswersHTML(questions, prefs, task) {
    const title = (document.querySelector('.exam-title .title-txt')?.innerText || '答案').trim();

    const includeStem = !!prefs.ansIncludeStem;
    const showOrder = includeStem ? false : !!prefs.ansShowOrder;
    const showQid = !!prefs.ansShowQid;

    const metaLines = [];
    if (prefs.showExportTime) metaLines.push(`导出时间：${new Date().toLocaleString()}`);
    if (prefs.showQuestionCount) metaLines.push(`题数：${questions.length}`);
    const metaHtml = metaLines.length ? `<div class="pz-meta">${metaLines.map(esc).join('　　')}</div>` : '';

    const cards = [];
    for (let i=0;i<questions.length;i++) {
      task.cancelToken.throwIfCancelled();
      const q = questions[i];
      task.setStage(`答案：处理 ${i+1}/${questions.length} QID:${q.qid}`);

      // 注意：懒加载可能导致这里仍为空，因此我们在 runTask 里已做 preloadAllAnswers
      let ansHtml = (q.aHtml && q.aHtml.trim()) ? q.aHtml : '<em>（未抓到答案内容）</em>';
      let stemHtml = q.qHtml || '';

      if (prefs.ansEmbedImages) {
        ansHtml = await embedResourcesInHTML(ansHtml, prefs, {
          task,
          label: `ans-a-${q.qid}`,
          onSubProgress: (d,t) => task.setProgress(20 + (i + d/Math.max(1,t))/questions.length * 80),
        });
      }
      if (includeStem && prefs.ansEmbedImages) {
        stemHtml = await embedResourcesInHTML(stemHtml, prefs, {
          task,
          label: `ans-q-${q.qid}`,
          onSubProgress: (d,t) => task.setProgress(20 + (i + d/Math.max(1,t))/questions.length * 80),
        });
      }

      const headParts = [];
      if (showOrder) headParts.push(`【${q.order}】`);
      if (showQid) headParts.push(`QID:${q.qid}`);

      cards.push(`
<section class="pz-q" data-qid="${esc(q.qid)}">
  ${headParts.length ? `<div class="pz-qhead">${esc(headParts.join(' '))}</div>` : ''}
  ${includeStem ? `<div class="pz-qbody">${stemHtml}</div><hr/>` : ''}
  <div class="pz-answer"><span class="pz-answer-label">答案：</span></div>
  <div class="pz-qbody">${ansHtml}</div>
</section>`.trim());

      task.setProgress(20 + (i+1)/questions.length * 80);
    }

    const html = `<!doctype html><html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(title)}</title>
${buildPrintCSS({ ...prefs, eachQuestionNewPage: prefs.ansEachNewPage })}
</head><body>
<div class="pz-paper">
  ${titleHTML(title, prefs.ansTitleAlign)}
  ${metaHtml}
  ${cards.join('\n')}
</div>
</body></html>`;

    return { html, title };
  }

  /******************************************************************
   * 12) Selector Doctor
   ******************************************************************/
  function runSelectorDoctor() {
    const checks = [
      { name: '题目列表', sel: '.tk-quest-item' },
      { name: '题干容器', sel: '.tk-quest-item .exam-item__cnt, .tk-quest-item .wrapper.quesdiv' },
      { name: '答案块', sel: '.tk-quest-item .item.answer, .tk-quest-item .exam-item__opt .item.answer' },
      { name: '显示答案开关', sel: '#isshowAnswer, label[for="isshowAnswer"], .show-answer' },
      { name: '试卷标题', sel: '.exam-title .title-txt' },
    ];
    const report = checks.map(c => {
      const nodes = $$(c.sel);
      const sample = nodes[0] ? (nodes[0].outerHTML || '').slice(0, 280) : '';
      return { name: c.name, sel: c.sel, count: nodes.length, sample };
    });
    Debug.state.selectorDoctor = report;
    log('Selector Doctor 已生成报告（可在 Debug Pack 中导出）');
    return report;
  }

  /******************************************************************
   * 13) Debug Pack — ALWAYS ZIP (no JSZip)
   ******************************************************************/
  async function exportDebugPackZip() {
    try {
      try { runSelectorDoctor(); } catch(e) {}

      const snapshot = JSON.parse(JSON.stringify(Debug.state || {}));

      const extra = {
        time: new Date().toISOString(),
        href: location.href,
        title: document.title,
        origin: location.origin,
        readyState: document.readyState,
        cookieEnabled: navigator.cookieEnabled,
        language: navigator.language,
        platform: navigator.platform,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        questionCount: document.querySelectorAll('.tk-quest-item').length,
        hasAnswerToggle: !!document.querySelector('#isshowAnswer, label[for="isshowAnswer"], .show-answer'),
      };

      const examTitleHtml = (document.querySelector('.exam-title')?.outerHTML || '');
      const firstQHtml = (document.querySelector('.tk-quest-item')?.outerHTML || '');
      const bodyTopHtml = (document.body?.innerHTML || '').slice(0, 160000);

      const failedUrls = (snapshot.resourceProbes || [])
        .filter(x => x && x.ok === false)
        .map(x => `${x.via || ''}\t${x.status || ''}\t${x.error || ''}\t${x.url || ''}`)
        .join('\n') || '(none)';

      const reportHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Debug</title>
<style>
body{font-family:Arial,"Microsoft Yahei",sans-serif;padding:12px}
pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:10px;border-radius:10px}
.small{color:#666;font-size:12px}
</style></head><body>
<h2>${esc(APP.name)} Debug Pack</h2>
<div class="small">Generated: ${esc(new Date().toLocaleString())}</div>
<h3>Extra</h3><pre>${esc(JSON.stringify(extra, null, 2))}</pre>
<h3>Errors</h3><pre>${esc(JSON.stringify(snapshot.errors || [], null, 2))}</pre>
<h3>Selector Doctor</h3><pre>${esc(JSON.stringify(snapshot.selectorDoctor || [], null, 2))}</pre>
<h3>Login Probe</h3><pre>${esc(JSON.stringify(snapshot.loginProbe || [], null, 2))}</pre>
<h3>Preload Probe (tail 80)</h3><pre>${esc(JSON.stringify((snapshot.preloadProbe||[]).slice(-80), null, 2))}</pre>
</body></html>`;

      const zip = zipCreate();
      await zipAddText(zip, 'debug/meta.json', JSON.stringify({ app: snapshot.app, page: snapshot.page }, null, 2));
      await zipAddText(zip, 'debug/prefs.json', JSON.stringify(snapshot.prefs || null, null, 2));
      await zipAddText(zip, 'debug/login_probe.json', JSON.stringify(snapshot.loginProbe || [], null, 2));
      await zipAddText(zip, 'debug/preload_probe.json', JSON.stringify(snapshot.preloadProbe || [], null, 2));
      await zipAddText(zip, 'debug/selector_doctor.json', JSON.stringify(snapshot.selectorDoctor || [], null, 2));
      await zipAddText(zip, 'debug/errors.json', JSON.stringify(snapshot.errors || [], null, 2));
      await zipAddText(zip, 'debug/network_full.json', JSON.stringify(snapshot.network || [], null, 2));
      await zipAddText(zip, 'debug/resource_probes_full.json', JSON.stringify(snapshot.resourceProbes || [], null, 2));
      await zipAddText(zip, 'debug/failed_urls.txt', failedUrls);
      await zipAddText(zip, 'debug/extra.json', JSON.stringify(extra, null, 2));
      await zipAddText(zip, 'debug/report.html', reportHtml);
      await zipAddText(zip, 'debug/dom/exam_title.html', examTitleHtml.slice(0, 120000));
      await zipAddText(zip, 'debug/dom/first_question.html', firstQHtml.slice(0, 160000));
      await zipAddText(zip, 'debug/dom/body_top.html', bodyTopHtml);
      const bodyText = (document.body?.innerText || '').slice(0, 240000);
      await zipAddText(zip, 'debug/dom/body_text_sample.txt', bodyText);

      // tasks summary
      try {
        const tasks = (TaskCenter?.list || []).slice(0, 30).map(t => ({
          id: t.id, type: t.type, status: t.status, stage: t.stage, progress: t.progress,
          createdAt: t.createdAt, embedBytes: t.embedBytes,
          failedResourcesCount: (t.failedResources||[]).length,
        }));
        await zipAddText(zip, 'debug/tasks_summary.json', JSON.stringify(tasks, null, 2));
      } catch(e) {}

      const blob = zipFinalize(zip);
      downloadBlob(blob, `debug_pack_${nowStamp()}.zip`);
      toast('Debug ZIP 已导出（稳定版）');
    } catch (e) {
      Debug.recordError('exportDebugPackZip', e);
      alert('导出 Debug ZIP 失败：' + (e?.message || e));
    }
  }

  /******************************************************************
   * 14) Task center
   ******************************************************************/
  class Task {
    constructor(type, prefs) {
      this.id = `${type}_${nowStamp()}_${Math.random().toString(16).slice(2,8)}`;
      this.type = type; // 'paper' | 'answers'
      this.prefs = prefs;
      this.cancelToken = new CancelToken();
      this.status = 'queued';
      this.stage = '';
      this.progress = 0;
      this.createdAt = new Date().toISOString();
      this.resourceCache = new Map();
      this.embedBytes = 0;
      this.failedResources = [];
      this.output = null;
      this.error = null;
    }
    setStage(s) { this.stage = s; renderTasks(); }
    setProgress(p) { this.progress = Math.max(0, Math.min(100, p||0)); setProgress(this.progress); renderTasks(); }
    cancel() {
      if (this.status === 'running' || this.status === 'queued') {
        this.cancelToken.cancel('user');
        this.status = 'cancelled';
        this.stage = '已取消';
        renderTasks();
      }
    }
  }

  const TaskCenter = {
    list: [],
    running: false,
    add(task) {
      this.list.unshift(task);
      Debug.state.tasks = this.list.map(t => ({ id: t.id, type: t.type, status: t.status, stage: t.stage, progress: t.progress, createdAt: t.createdAt }));
      renderTasks();
      this.kick();
    },
    async kick() {
      if (this.running) return;
      this.running = true;
      try {
        while (true) {
          const next = this.list.find(t => t.status === 'queued');
          if (!next) break;
          await this.runTask(next);
        }
      } finally {
        this.running = false;
      }
    },
    async runTask(task) {
      task.status = 'running';
      task.setStage('初始化...');
      task.setProgress(0);

      try {
        Rate.configureFromPrefs(task.prefs);
        Debug.state.prefs = task.prefs;

        if (task.type === 'answers') {
          task.setStage('检查登录状态...');
          const okLogin = await checkLoginBeforeAnswers();
          if (!okLogin) throw new Error('检测为未登录：请先登录账号后再导出答案');

          // ✅ 关键：导出答案前预加载全部答案
          await preloadAllAnswers(task, task.prefs);
        }

        task.setStage('收集题目...');
        const qs = collectQuestions(task.prefs.dedupeByQid);
        if (!qs.length) throw new Error('未找到题目节点（.tk-quest-item）');

        let built;
        if (task.type === 'paper') built = await buildPaperHTML(qs, task.prefs, task);
        else built = await buildAnswersHTML(qs, task.prefs, task);

        const filenameBase = `${task.type}_${nowStamp()}`;
        task.output = { html: built.html, title: built.title, filenameBase };

        task.setStage('输出...');
        await outputByMode(task.output.html, filenameBase, task.prefs, task);

        task.status = 'done';
        task.setStage('完成');
        task.setProgress(100);
        toast(`${task.type === 'paper' ? '试卷' : '答案'}导出完成`);
      } catch (e) {
        if (task.cancelToken.cancelled) {
          task.status = 'cancelled';
          task.setStage('已取消');
          return;
        }
        task.status = 'failed';
        task.error = String(e?.message || e);
        Debug.recordError('runTask', e, { taskId: task.id, type: task.type });
        task.setStage('失败：' + task.error);
        toast('导出失败（可导出Debug包排查）');
      } finally {
        Debug.state.tasks = this.list.map(t => ({ id: t.id, type: t.type, status: t.status, stage: t.stage, progress: t.progress, createdAt: t.createdAt }));
        renderTasks();
      }
    }
  };

  async function outputByMode(html, filenameBase, prefs, task) {
    const mode = prefs.mode;
    if (mode === 'download') {
      downloadBlob(new Blob([html], { type:'text/html;charset=utf-8' }), `${filenameBase}.html`);
      return;
    }
    if (mode === 'print') {
      openPrintWindow(html, filenameBase);
      return;
    }
    if (mode === 'zip') {
      const zip = zipCreate();
      await zipAddText(zip, `${filenameBase}.html`, html);
      await zipAddText(zip, `debug_snapshot.json`, JSON.stringify({
        app: Debug.state.app,
        page: Debug.state.page,
        prefs,
        selectorDoctor: Debug.state.selectorDoctor,
        loginProbe: Debug.state.loginProbe,
        preloadProbe: Debug.state.preloadProbe,
        task: { id: task.id, type: task.type, status: task.status, stage: task.stage, embedBytes: task.embedBytes },
      }, null, 2));
      const blob = zipFinalize(zip);
      downloadBlob(blob, `${filenameBase}.zip`);
      return;
    }
    throw new Error('Unknown output mode: ' + mode);
  }

  /******************************************************************
   * 15) UI (Black-Gold)
   ******************************************************************/
  const UI = {
    gold: '#c8a24b',
    black: '#111',
    panelBg: '#fff',
    border: '#e6e6e6',
  };

  function injectButton() {
    if (document.getElementById(APP.ids.btn)) return;
    const btn = document.createElement('button');
    btn.id = APP.ids.btn;
    btn.textContent = `离线导出 v3`;
    btn.style.cssText = `
position:fixed; right:18px; top:120px; z-index:2147483647;
background: linear-gradient(135deg, ${UI.black} 0%, #000 60%, ${UI.black} 100%);
color:${UI.gold};
border:1px solid rgba(200,162,75,0.55);
padding:8px 12px; border-radius:12px;
box-shadow:0 8px 20px rgba(0,0,0,0.22);
cursor:pointer; font-weight:900; font-size:13px;`;
    btn.onclick = () => togglePanel();
    document.body.appendChild(btn);
  }

  function togglePanel() {
    const exist = document.getElementById(APP.ids.panel);
    if (exist) { exist.remove(); return; }
    buildPanel();
  }

  function smallGoldBtn(text, id) {
    return `<button id="${id}" style="
border:1px solid rgba(200,162,75,0.6);
background:#0b0b0b;
color:${UI.gold};
border-radius:12px;padding:6px 10px;cursor:pointer;font-weight:900">${esc(text)}</button>`;
  }
  function goldMainBtn(text, id) {
    return `<button id="${id}" style="
padding:8px 10px;border-radius:12px;border:1px solid rgba(200,162,75,0.65);
background: linear-gradient(135deg, ${UI.black}, #000);
color:${UI.gold};cursor:pointer;font-weight:900">${esc(text)}</button>`;
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = APP.ids.panel;
    panel.style.cssText = `
position:fixed; right:18px; top:160px; width:700px; max-height:calc(100vh - 190px); overflow:auto;
z-index:2147483647; background:${UI.panelBg}; border:1px solid ${UI.border};
box-shadow:0 10px 28px rgba(0,0,0,0.18); border-radius:14px; padding:12px;
font-family:Arial,"Microsoft Yahei",sans-serif; font-size:13px; color:#111;`;

    const titleAlignSelect = (id, def='center') => `
<select id="${id}" style="border:1px solid #ddd;border-radius:10px;padding:6px 8px;background:#fff">
  <option value="none"${def==='none'?' selected':''}>无</option>
  <option value="left"${def==='left'?' selected':''}>左</option>
  <option value="center"${def==='center'?' selected':''}>中</option>
  <option value="right"${def==='right'?' selected':''}>右</option>
</select>`;

    panel.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
  <div style="font-weight:900;font-size:14px">${esc(APP.name)} <span style="color:#666;font-weight:600">${esc(APP.version)}</span></div>
  <div style="display:flex;gap:8px;align-items:center">
    ${smallGoldBtn('Selector Doctor', 'pz_v3_doctor')}
    ${smallGoldBtn('导出Debug包ZIP', 'pz_v3_dbg')}
    <button id="pz_v3_close" style="border:0;background:#f2f2f2;border-radius:12px;padding:6px 10px;cursor:pointer;font-weight:900">×</button>
  </div>
</div>

<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
  <div style="flex:1;min-width:330px;border:1px solid #eee;border-radius:12px;padding:10px;background:#fff">
    <div style="font-weight:900;margin-bottom:6px">抓取与限速</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label>并发 <input id="pz_v3_conc" type="number" min="1" value="3" style="width:60px"></label>
      <label>延迟(ms) <input id="pz_v3_delay" type="number" min="0" value="120" style="width:80px"></label>
      <label>超时(ms) <input id="pz_v3_timeout" type="number" min="3000" value="25000" style="width:90px"></label>
      <label>重试 <input id="pz_v3_retry" type="number" min="0" value="2" style="width:60px"></label>
      <label>冷却(ms) <input id="pz_v3_block" type="number" min="10000" value="600000" style="width:110px"></label>
    </div>
    <div style="height:8px"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label><input id="pz_v3_dedupe" type="checkbox" checked> 去重(QID)</label>
      <label><input id="pz_v3_embed" type="checkbox" checked> 内嵌图片/公式</label>
      <label>最大嵌入(MB) <input id="pz_v3_maxmb" type="number" min="1" value="12" style="width:70px"></label>
    </div>
    <div style="margin-top:8px;color:#666;font-size:12px">
      v3.0-alpha.4：导出答案前会自动滚动预加载全部答案，解决“后面题答案为空”。
    </div>
  </div>

  <div style="flex:1;min-width:330px;border:1px solid #eee;border-radius:12px;padding:10px;background:#fff">
    <div style="font-weight:900;margin-bottom:6px">输出</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label>方式
        <select id="pz_v3_mode" style="border:1px solid #ddd;border-radius:10px;padding:6px 8px;background:#fff">
          <option value="download">下载HTML</option>
          <option value="print">新窗口打印</option>
          <option value="zip">ZIP(HTML+快照)</option>
        </select>
      </label>
      <label><input id="pz_v3_break" type="checkbox"> 每题分页</label>
      <label>页边距(mm) <input id="pz_v3_margin" type="number" min="5" value="12" style="width:60px"></label>
      <label><input id="pz_v3_showtime" type="checkbox" checked> 导出时间</label>
      <label><input id="pz_v3_showcount" type="checkbox" checked> 题数</label>
    </div>
  </div>
</div>

<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
  <div style="flex:1;min-width:330px;border:1px solid #eee;border-radius:12px;padding:10px;background:#fff">
    <div style="font-weight:900;margin-bottom:6px">试卷设置</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label>标题 ${titleAlignSelect('pz_v3_p_title_align', 'center')}</label>
      <label><input id="pz_v3_p_order" type="checkbox" checked> 显示题号(1.)</label>
      <label><input id="pz_v3_p_qid" type="checkbox"> 显示QID</label>
      <label><input id="pz_v3_p_score" type="checkbox"> 分值</label>
      <label>默认分 <input id="pz_v3_p_scorev" type="number" min="0" value="3" style="width:60px"></label>
    </div>
    <div style="height:8px"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label><input id="pz_v3_lines" type="checkbox"> 留作答空行</label>
      <label>解答行 <input id="pz_v3_solve" type="number" min="0" value="10" style="width:70px"></label>
      <label>非解答行 <input id="pz_v3_nonsolve" type="number" min="0" value="2" style="width:70px"></label>
    </div>
    <div style="height:8px"></div>
    <div style="font-size:12px;color:#666">解答题覆写（QID，空格/逗号分隔）</div>
    <div style="display:flex;gap:10px;margin-top:6px">
      <textarea id="pz_v3_manual_solve" placeholder="强制为解答题的QID" style="flex:1;height:54px;resize:vertical"></textarea>
      <textarea id="pz_v3_manual_notsolve" placeholder="强制为非解答题的QID" style="flex:1;height:54px;resize:vertical"></textarea>
    </div>
  </div>

  <div style="flex:1;min-width:330px;border:1px solid #eee;border-radius:12px;padding:10px;background:#fff">
    <div style="font-weight:900;margin-bottom:6px">答案设置</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label>标题 ${titleAlignSelect('pz_v3_a_title_align', 'center')}</label>
      <label><input id="pz_v3_a_break" type="checkbox"> 每题分页</label>
    </div>
    <div style="height:8px"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <label><input id="pz_v3_a_stem" type="checkbox" checked> 带题干</label>
      <label><input id="pz_v3_a_order" type="checkbox"> 显示【order】</label>
      <label><input id="pz_v3_a_qid" type="checkbox"> 显示QID</label>
      <label><input id="pz_v3_a_embed" type="checkbox" checked> 嵌入答案图片</label>
    </div>
    <div style="margin-top:6px;color:#666;font-size:12px">规则：带题干时自动禁用【order】（避免重复信息）。</div>

    <div style="height:10px"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      ${goldMainBtn('加入任务：导出试卷', 'pz_v3_btn_paper')}
      ${goldMainBtn('加入任务：导出答案', 'pz_v3_btn_ans')}
    </div>
  </div>
</div>

<div style="border:1px solid #eee;border-radius:12px;padding:10px;margin-bottom:10px;background:#fff">
  <div style="font-weight:900;margin-bottom:6px">任务中心</div>
  <div id="${APP.ids.tasks}" style="display:flex;flex-direction:column;gap:8px"></div>
</div>

<div style="border:1px solid #eee;border-radius:12px;padding:10px;background:#fff">
  <div style="font-weight:900;margin-bottom:6px">日志</div>
  <div id="${APP.ids.log}" style="height:150px;overflow:auto;border:1px solid #eee;border-radius:12px;padding:8px;background:#fcfcfc;font-size:12px"></div>
  <div style="height:8px"></div>
  <div style="background:#eee;height:12px;border-radius:999px;overflow:hidden">
    <div id="${APP.ids.prog}" style="width:0%;height:100%;background:${UI.gold}"></div>
  </div>
</div>
`;

    document.body.appendChild(panel);

    $('#pz_v3_close').onclick = () => panel.remove();
    $('#pz_v3_dbg').onclick = () => exportDebugPackZip();
    $('#pz_v3_doctor').onclick = () => {
      const rep = runSelectorDoctor();
      alert('Selector Doctor 完成：\n' + rep.map(x => `${x.name}: ${x.count}`).join('\n'));
    };

    $('#pz_v3_a_stem').addEventListener('change', refreshDisabledStates);
    $('#pz_v3_p_score').addEventListener('change', refreshDisabledStates);
    $('#pz_v3_lines').addEventListener('change', refreshDisabledStates);

    $('#pz_v3_btn_paper').onclick = () => {
      const prefs = readPrefsFromUI();
      Debug.state.prefs = prefs;
      const t = new Task('paper', prefs);
      TaskCenter.add(t);
      log('已加入任务：导出试卷');
    };

    $('#pz_v3_btn_ans').onclick = async () => {
      const prefs = readPrefsFromUI();
      Debug.state.prefs = prefs;

      log('导出答案：预检查登录状态...');
      const okLogin = await checkLoginBeforeAnswers();
      if (!okLogin) {
        alert('检测为未登录：请先登录账号后再导出答案。\n（如你确认已登录但仍误判，请导出Debug包给我看 loginProbe。）');
        return;
      }

      const t = new Task('answers', prefs);
      TaskCenter.add(t);
      log('已加入任务：导出答案');
    };

    refreshDisabledStates();
    renderTasks();
  }

  function refreshDisabledStates() {
    const scoreOn = $('#pz_v3_p_score')?.checked;
    if ($('#pz_v3_p_scorev')) $('#pz_v3_p_scorev').disabled = !scoreOn;

    const linesOn = $('#pz_v3_lines')?.checked;
    if ($('#pz_v3_solve')) $('#pz_v3_solve').disabled = !linesOn;
    if ($('#pz_v3_nonsolve')) $('#pz_v3_nonsolve').disabled = !linesOn;

    const includeStem = $('#pz_v3_a_stem')?.checked;
    if ($('#pz_v3_a_order')) {
      $('#pz_v3_a_order').disabled = !!includeStem;
      if (includeStem) $('#pz_v3_a_order').checked = false;
    }
  }

  function readPrefsFromUI() {
    return {
      concurrency: Number($('#pz_v3_conc')?.value || 3),
      delayMs: Number($('#pz_v3_delay')?.value || 120),
      timeoutMs: Number($('#pz_v3_timeout')?.value || 25000),
      retry: Number($('#pz_v3_retry')?.value || 2),
      blockMs: Number($('#pz_v3_block')?.value || 600000),

      dedupeByQid: !!$('#pz_v3_dedupe')?.checked,
      embedImages: !!$('#pz_v3_embed')?.checked,
      maxEmbedMB: Number($('#pz_v3_maxmb')?.value || 12),

      mode: $('#pz_v3_mode')?.value || 'download',
      eachQuestionNewPage: !!$('#pz_v3_break')?.checked,
      pageMarginMm: Number($('#pz_v3_margin')?.value || 12),
      showExportTime: !!$('#pz_v3_showtime')?.checked,
      showQuestionCount: !!$('#pz_v3_showcount')?.checked,

      paperTitleAlign: $('#pz_v3_p_title_align')?.value || 'center',
      showOrder: !!$('#pz_v3_p_order')?.checked,
      showQid: !!$('#pz_v3_p_qid')?.checked,
      showScore: !!$('#pz_v3_p_score')?.checked,
      defaultScore: Number($('#pz_v3_p_scorev')?.value || 0),
      addBlankLines: !!$('#pz_v3_lines')?.checked,
      solveLines: Number($('#pz_v3_solve')?.value || 10),
      nonSolveLines: Number($('#pz_v3_nonsolve')?.value || 2),
      manualSolveQids: $('#pz_v3_manual_solve')?.value || '',
      manualNotSolveQids: $('#pz_v3_manual_notsolve')?.value || '',

      ansTitleAlign: $('#pz_v3_a_title_align')?.value || 'center',
      ansEachNewPage: !!$('#pz_v3_a_break')?.checked,
      ansIncludeStem: !!$('#pz_v3_a_stem')?.checked,
      ansShowOrder: !!$('#pz_v3_a_order')?.checked,
      ansShowQid: !!$('#pz_v3_a_qid')?.checked,
      ansEmbedImages: !!$('#pz_v3_a_embed')?.checked,
    };
  }

  function renderTasks() {
    const root = $('#' + APP.ids.tasks);
    if (!root) return;

    const list = TaskCenter.list.slice(0, 10);
    root.innerHTML = list.map(t => `
<div style="border:1px solid #eee;border-radius:12px;padding:8px;display:flex;gap:10px;align-items:flex-start;justify-content:space-between;background:#fff">
  <div style="flex:1;min-width:0">
    <div style="font-weight:900">
      ${t.type === 'paper' ? '试卷' : '答案'} <span style="color:#666;font-weight:600">${esc(t.status)}</span>
    </div>
    <div style="color:#333;font-size:12px;margin-top:4px;word-break:break-word">${esc(t.stage || '')}</div>
    <div style="color:#666;font-size:12px;margin-top:4px">progress: ${esc(String(Math.round(t.progress||0)))}% · embedBytes: ${esc(String(t.embedBytes||0))}</div>
    ${t.error ? `<div style="color:#b00020;font-size:12px;margin-top:4px">error: ${esc(t.error)}</div>` : ''}
  </div>
  <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
    ${(t.status === 'running' || t.status === 'queued') ? `
      <button data-act="cancel" data-id="${esc(t.id)}" style="
        padding:6px 10px;border-radius:12px;border:1px solid rgba(200,162,75,0.65);
        background:#0b0b0b;color:#c8a24b;cursor:pointer;font-weight:900">取消</button>` : ''}
  </div>
</div>`).join('');

    $$('button[data-act="cancel"]', root).forEach(btn => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-id');
        const t = TaskCenter.list.find(x => x.id === id);
        if (t) t.cancel();
      };
    });
  }

  /******************************************************************
   * 16) Menu commands
   ******************************************************************/
  function installMenu() {
    try {
      GM_registerMenuCommand('PZ v3: 导出 Debug ZIP（稳定）', exportDebugPackZip);
      GM_registerMenuCommand('PZ v3: Selector Doctor', () => {
        const rep = runSelectorDoctor();
        alert('Selector Doctor:\n' + rep.map(x => `${x.name}: ${x.count}`).join('\n'));
      });
      GM_registerMenuCommand('PZ v3: 显示面板', () => {
        if (!document.getElementById(APP.ids.panel)) buildPanel();
      });
    } catch (e) {}
  }

  /******************************************************************
   * 17) Boot
   ******************************************************************/
  (async function boot() {
    const ok = await waitForQuestionDOM(12000);
    if (!ok) return;

    installNetworkObserver();
    installMenu();
    injectButton();
    log('v3 面板按钮已就绪。');
  })();

})();