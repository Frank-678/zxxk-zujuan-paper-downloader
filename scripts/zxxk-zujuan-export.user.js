// ==UserScript==
// @name         组卷网 - 个人题库 离线导出 + 答案合集 v3.1（图片嵌入 & ZIP）
// @namespace    https://greasyfork.org/users/1566377-frank-678
// @version      3.1.0
// @description  基于 v2.2 主线：保留离线 HTML/ZIP 与图片跨域回退；新增逐题点击答案预加载、取消、超时和最小诊断，解决懒加载答案导出为空
// @author       Frank-678
// @match        https://zujuan.xkw.com/*
// @match        https://www.zxxk.com/zujuan/*
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      imzujuan.xkw.com
// @connect      *.xkw.com
// @connect      xkw.com
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/Frank-678/zxxk-zujuan-paper-downloader
// @supportURL   https://github.com/Frank-678/zxxk-zujuan-paper-downloader/issues
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  /* ----------------------------
     Utilities
     ---------------------------- */
  function $(sel, root = document) { return root.querySelector(sel); }
  function $all(sel, root = document) { return Array.from((root||document).querySelectorAll(sel)); }
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function escapeHtml(s){ if(!s) return ''; return (''+s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function safeFilePart(s, fallback='item'){
    const out = (''+(s || fallback)).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, '_').slice(0, 120);
    return out || fallback;
  }
  function safeDiagnosticUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin + parsed.pathname;
    } catch (e) {
      return String(url || '').split(/[?#]/, 1)[0];
    }
  }

  const APP_VERSION = '3.1.0';
  const QUESTION_SELECTOR = '.tk-quest-item';
  const ANSWER_SELECTOR = '.exam-item__opt .item.answer, .item.answer';
  let activeTask = null;
  let lastDiagnostics = null;

  class TaskCancelledError extends Error {
    constructor(reason='用户取消') {
      super(reason);
      this.name = 'TaskCancelledError';
    }
  }

  class ExportTask {
    constructor(kind, prefs) {
      this.kind = kind;
      this.prefs = prefs;
      this.cancelled = false;
      this.completed = false;
      this.aborters = new Set();
      this.resourceCache = new Map();
      this.progress = 0;
      this.stage = '准备中';
      this.startedAt = new Date().toISOString();
      this.diagnostics = {
        version: APP_VERSION,
        kind,
        startedAt: this.startedAt,
        page: { host: location.host, path: location.pathname },
        selectorDoctor: null,
        preload: [],
        resourceFailures: []
      };
    }

    throwIfCancelled() {
      if (this.cancelled) throw new TaskCancelledError();
    }

    registerAbort(aborter) {
      if (typeof aborter !== 'function') return () => {};
      if (this.cancelled) {
        try { aborter(); } catch (e) {}
        return () => {};
      }
      this.aborters.add(aborter);
      return () => this.aborters.delete(aborter);
    }

    cancel() {
      if (this.cancelled || this.completed) return;
      this.cancelled = true;
      this.stage = '正在取消…';
      for (const aborter of this.aborters) {
        try { aborter(); } catch (e) {}
      }
      this.aborters.clear();
      updateTaskUI();
      log('已请求取消；当前请求结束后将停止。');
    }

    setStage(stage) {
      this.stage = stage;
      updateTaskUI();
    }

    setProgress(percent) {
      this.progress = Math.max(0, Math.min(100, Number(percent) || 0));
      setProgress(this.progress);
      updateTaskUI();
    }

    recordResourceFailure(url, error) {
      this.diagnostics.resourceFailures.push({
        url: safeDiagnosticUrl(url),
        error: String(error && error.message ? error.message : error || 'unknown')
      });
    }

    finish(status, error) {
      this.completed = true;
      this.diagnostics.finishedAt = new Date().toISOString();
      this.diagnostics.status = status;
      if (error) this.diagnostics.error = String(error && error.message ? error.message : error);
      lastDiagnostics = this.diagnostics;
    }
  }

  function isCancellation(error, task) {
    return !!(task && task.cancelled) || error instanceof TaskCancelledError || (error && error.name === 'AbortError');
  }

  async function sleepWithTask(ms, task) {
    if (task) task.throwIfCancelled();
    await sleep(Math.max(0, Number(ms) || 0));
    if (task) task.throwIfCancelled();
  }

  function setTaskProgress(task, start, end, percent) {
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    if (task) task.setProgress(start + (end - start) * clamped / 100);
    else setProgress(start + (end - start) * clamped / 100);
  }
  function addManualDownloadLink(url, filename){
    const Ln = document.getElementById('pz_log');
    if(!Ln) return;
    const wrap = document.createElement('div');
    const t = new Date().toLocaleTimeString();
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.textContent = `若未自动下载，点击这里手动保存：${filename}`;
    a.style.cssText = 'color:#1565c0;text-decoration:underline;word-break:break-all';
    wrap.appendChild(document.createTextNode(`[${t}] `));
    wrap.appendChild(a);
    wrap.appendChild(document.createTextNode('（10分钟内有效）'));
    Ln.prepend(wrap);
  }
  function triggerAnchorDownload(url, filename){
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>a.remove(), 30000);
  }
  function downloadBlob(blob, filename){
    const url = URL.createObjectURL(blob);
    addManualDownloadLink(url, filename);
    const cleanup = () => URL.revokeObjectURL(url);
    setTimeout(cleanup, 10 * 60 * 1000);
    if (typeof GM_download === 'function') {
      try {
        GM_download({
          url,
          name: filename,
          saveAs: false,
          onerror: () => triggerAnchorDownload(url, filename)
        });
        return;
      } catch(e) {
        console.warn('GM_download failed, falling back to anchor download', e);
      }
    }
    triggerAnchorDownload(url, filename);
  }

  /* ----------------------------
     Built-in ZIP writer (STORE/no compression)
     ---------------------------- */
  function _u16(n){ return new Uint8Array([n & 255, (n>>>8) & 255]); }
  function _u32(n){ return new Uint8Array([n & 255, (n>>>8) & 255, (n>>>16) & 255, (n>>>24) & 255]); }
  function _concatU8(chunks){
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks){ out.set(c, off); off += c.length; }
    return out;
  }
  function _encodeUtf8(s){ return new TextEncoder().encode(s); }
  const _crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i=0;i<256;i++){
      let c = i;
      for (let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
      t[i] = c>>>0;
    }
    return t;
  })();
  function crc32(u8){
    let c = 0xFFFFFFFF;
    for (let i=0;i<u8.length;i++) c = _crcTable[(c ^ u8[i]) & 255] ^ (c>>>8);
    return (c ^ 0xFFFFFFFF)>>>0;
  }
  function _dosDateTime(d=new Date()){
    const year = Math.max(1980, d.getFullYear());
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
    if(zip.files.length > 65535) throw new Error('ZIP 文件数量超过 65535，当前简易 ZIP 格式不支持。');
    const parts = [];
    const central = [];
    let offset = 0;
    const now = _dosDateTime(new Date());
    const utf8Flag = 0x0800;
    for (const f of zip.files){
      if(f.size > 0xFFFFFFFF) throw new Error('单个文件超过 4GB，当前简易 ZIP 格式不支持。');
      const nameU8 = _encodeUtf8(f.path);
      f.offset = offset;
      f.dosTime = now.dosTime;
      f.dosDate = now.dosDate;
      const local = _concatU8([
        _u32(0x04034b50), _u16(20), _u16(utf8Flag), _u16(0),
        _u16(f.dosTime), _u16(f.dosDate), _u32(f.crc), _u32(f.size), _u32(f.size),
        _u16(nameU8.length), _u16(0), nameU8, f.dataU8
      ]);
      parts.push(local);
      offset += local.length;
      if(offset > 0xFFFFFFFF) throw new Error('ZIP 总大小超过 4GB，当前简易 ZIP 格式不支持。');
      const cdir = _concatU8([
        _u32(0x02014b50), _u16(0x0314), _u16(20), _u16(utf8Flag), _u16(0),
        _u16(f.dosTime), _u16(f.dosDate), _u32(f.crc), _u32(f.size), _u32(f.size),
        _u16(nameU8.length), _u16(0), _u16(0), _u16(0), _u16(0), _u32(0), _u32(f.offset), nameU8
      ]);
      central.push(cdir);
    }
    const centralStart = offset;
    const centralU8 = _concatU8(central);
    offset += centralU8.length;
    if(offset > 0xFFFFFFFF) throw new Error('ZIP 总大小超过 4GB，当前简易 ZIP 格式不支持。');
    const eocd = _concatU8([
      _u32(0x06054b50), _u16(0), _u16(0), _u16(zip.files.length), _u16(zip.files.length),
      _u32(centralU8.length), _u32(centralStart), _u16(0)
    ]);
    const finalU8 = _concatU8([...parts, centralU8, eocd]);
    return new Blob([finalU8], { type: 'application/zip' });
  }

  /* ----------------------------
     Fetch + embed helpers (robust)
     ---------------------------- */

  function normalizeUrl(u){
    if(!u) return u;
    u = u.trim();
    if(u.startsWith('//')) return location.protocol + u;
    if(u.startsWith('/')) return location.origin + u;
    return u;
  }

  function isAnswerImageUrl(url){
    try {
      const u = new URL(normalizeUrl(url), location.href);
      return /(^|\.)imzujuan\.xkw\.com$/i.test(u.hostname) && /\/getAnswerAndParse\//i.test(u.pathname);
    } catch(e){ return false; }
  }

  function guessMimeFromUrl(url){
    let clean = '';
    try { clean = new URL(normalizeUrl(url), location.href).pathname.toLowerCase(); }
    catch(e){ clean = (url || '').split('?')[0].toLowerCase(); }
    if(/\.jpe?g$/.test(clean)) return 'image/jpeg';
    if(/\.png$/.test(clean)) return 'image/png';
    if(/\.gif$/.test(clean)) return 'image/gif';
    if(/\.webp$/.test(clean)) return 'image/webp';
    if(/\.svg$/.test(clean)) return 'image/svg+xml';
    return 'image/png';
  }

  function getImageExt(url, blob){
    const type = (blob && blob.type || '').toLowerCase().split(';')[0].trim();
    const byMime = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp',
      'image/avif': 'avif'
    };
    if(byMime[type]) return byMime[type];
    try {
      const path = new URL(normalizeUrl(url), location.href).pathname.toLowerCase();
      const m = path.match(/\.([a-z0-9]{1,5})$/);
      if(m && ['jpg','jpeg','png','gif','webp','svg','bmp','avif'].includes(m[1])) return m[1] === 'jpeg' ? 'jpg' : m[1];
    } catch(e) {}
    return guessMimeFromUrl(url).split('/').pop().replace('jpeg','jpg').replace('svg+xml','svg') || 'png';
  }

  function gmFetchBlob(url, prefs, task){
    if (typeof GM_xmlhttpRequest !== 'function') return Promise.reject(new Error('GM_xmlhttpRequest unavailable'));
    if (task) task.throwIfCancelled();
    return new Promise((resolve, reject) => {
      let settled = false;
      let requestHandle = null;
      let unregisterAbort = () => {};
      const done = (fn, v) => {
        if(!settled){
          settled = true;
          unregisterAbort();
          fn(v);
        }
      };
      try {
        requestHandle = GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          anonymous: false,
          headers: {
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          },
          timeout: (prefs && prefs.FETCH_TIMEOUT_MS) || 25000,
          onload: (resp) => {
            const status = resp.status || 0;
            if(status >= 200 && status < 300 && resp.response){
              let blob = resp.response;
              if(!(blob instanceof Blob)) blob = new Blob([blob], { type: resp.responseHeaders && /content-type:\s*([^\r\n]+)/i.test(resp.responseHeaders) ? RegExp.$1.trim() : guessMimeFromUrl(url) });
              if(!blob.type) blob = blob.slice(0, blob.size, guessMimeFromUrl(url));
              done(resolve, { blob, size: blob.size || 0, url, status, via: 'GM_xmlhttpRequest' });
              return;
            }
            done(reject, new Error('GM HTTP ' + status));
          },
          onerror: () => done(reject, new Error('GM request error')),
          ontimeout: () => done(reject, new Error('GM request timeout')),
          onabort: () => done(reject, new Error('GM request aborted'))
        });
        if (task) {
          unregisterAbort = task.registerAbort(() => {
            try { if (requestHandle && typeof requestHandle.abort === 'function') requestHandle.abort(); } catch (e) {}
          });
          // A cached failure may settle before its abort callback is registered.
          if (settled) unregisterAbort();
          if (task.cancelled && requestHandle && typeof requestHandle.abort === 'function') requestHandle.abort();
        }
      } catch(e){ done(reject, e); }
    });
  }

  async function browserFetchBlob(url, prefs, task){
    if (task) task.throwIfCancelled();
    const controller = new AbortController();
    const unregisterAbort = task ? task.registerAbort(() => controller.abort()) : () => {};
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, (prefs && prefs.FETCH_TIMEOUT_MS) || 25000);
    try {
      const resp = await fetch(url, {
        method:'GET', mode:'cors', credentials:'include', cache:'force-cache', referrer: location.href, signal: controller.signal
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const blob = await resp.blob();
      if (task) task.throwIfCancelled();
      return { blob, size: blob.size || 0, url, status: resp.status, via: 'fetch' };
    } catch (error) {
      if (timedOut && !(task && task.cancelled)) throw new Error('fetch request timeout');
      throw error;
    } finally {
      clearTimeout(timeout);
      unregisterAbort();
    }
  }

  async function fetchBlobWithRetry(url, prefs, task){
    url = normalizeUrl(url);
    if (task) task.throwIfCancelled();
    const maxRetries = (prefs && prefs.FETCH_RETRY!=null) ? prefs.FETCH_RETRY : 2;
    const baseDelay = (prefs && prefs.INTER_REQUEST_DELAY_MS!=null) ? prefs.INTER_REQUEST_DELAY_MS : 120;
    let attempt = 0;
    const preferGM = isAnswerImageUrl(url);
    let lastErr = null;
    if (window.__pz_block_until && Date.now() < window.__pz_block_until) {
      throw new Error('Global block in effect until ' + new Date(window.__pz_block_until).toLocaleTimeString());
    }
    while(attempt<=maxRetries){
      if (task) task.throwIfCancelled();
      try {
        const info = preferGM ? await gmFetchBlob(url, prefs, task) : await browserFetchBlob(url, prefs, task);
        if(info && (info.status === 429 || info.status === 403)) throw new Error('HTTP ' + info.status);
        return info;
      } catch(err){
        lastErr = err;
        if (isCancellation(err, task)) throw err;
        if(!preferGM && isAnswerImageUrl(url)){
          try { return await gmFetchBlob(url, prefs, task); } catch(gmErr){
            lastErr = gmErr;
            if (isCancellation(gmErr, task)) throw gmErr;
          }
        }
        const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
        if(/\b(403|429)\b/.test(msg)){
          const blockMs = (prefs && prefs.BLOCK_DURATION_MS) || 10*60*1000;
          window.__pz_block_until = Date.now() + blockMs;
          throw new Error('Server returned ' + msg + '. Blocked for ' + (blockMs/60000) + ' minutes.');
        }
        attempt++;
        if(attempt>maxRetries) throw lastErr;
        const back = baseDelay * Math.pow(2,attempt) + Math.round(Math.random()*200);
        await sleepWithTask(back, task);
      }
    }
    throw lastErr || new Error('Failed to fetch: ' + url);
  }

  function blobToDataURL(blob){ return new Promise((res, rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=(e)=>rej(e); fr.readAsDataURL(blob); }); }

  /* ----------------------------
     Embed resources inside a node (images + bg)
     Returns { html, bytes, fetchedCount, failedUrls }
     ---------------------------- */
  async function fetchBlobForTask(url, prefs, task) {
    const normalized = normalizeUrl(url);
    if (!task) return fetchBlobWithRetry(normalized, prefs);
    task.throwIfCancelled();
    if (task.resourceCache.has(normalized)) return task.resourceCache.get(normalized);
    const pending = fetchBlobWithRetry(normalized, prefs, task).catch(error => {
      task.resourceCache.delete(normalized);
      throw error;
    });
    task.resourceCache.set(normalized, pending);
    return pending;
  }

  async function embedResourcesForNode(node, prefs, onProgress, task){
    if (task) task.throwIfCancelled();
    const clone = node.cloneNode(true);
    // collect candidate URLs mapped to elements (dedupe by url)
    const map = new Map(); // url -> { elements: [{el,type,attr}], seen }
    function add(url, el, type, attr){
      if(!url) return;
      const n = normalizeUrl(url);
      if(!n) return;
      const arr = map.get(n) || [];
      arr.push({el, type, attr});
      map.set(n, arr);
    }

    // images
    clone.querySelectorAll('img').forEach(img=>{
      const attrs = ['src','data-src','data-original'];
      let found = false;
      for(const a of attrs){
        const v = img.getAttribute(a);
        if(v && !v.startsWith('data:')) { add(v, img, 'img', a); found = true; break; }
      }
      const ss = img.getAttribute('srcset');
      if(!found && ss){
        const first = ss.split(',')[0].trim().split(' ')[0];
        if(first && !first.startsWith('data:')) add(first, img, 'img', 'srcset');
      }
    });
    // inline styles with url()
    clone.querySelectorAll('*').forEach(el=>{
      const st = el.getAttribute('style');
      if(st && /url\(/i.test(st)){
        const re = /url\(['"]?([^'")]+)['"]?\)/ig; let m;
        while((m=re.exec(st))){ if(m[1] && !m[1].startsWith('data:')) add(m[1], el, 'bgInline', 'style'); }
      }
      // computed style
      try {
        const cs = window.getComputedStyle(el);
        if (cs && cs.backgroundImage && cs.backgroundImage !== 'none') {
          const m = cs.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
          if (m && m[1] && !m[1].startsWith('data:')) add(m[1], el, 'bgComputed', 'computed');
        }
      } catch(e){}
    });

    // fetch each unique url with concurrency
    const entries = Array.from(map.entries());
    let totalBytes = 0, fetchedCount = 0, completedCount = 0;
    const failed = [];
    const CONCURRENCY = Math.max(1, (prefs && prefs.CONCURRENCY) || 3);
    let idx = 0;
    async function worker(){
      while(true){
        if (task) task.throwIfCancelled();
        const current = idx++;
        if (current >= entries.length) return;
        const [url, elList] = entries[current];
        try {
          await sleepWithTask((prefs && prefs.INTER_REQUEST_DELAY_MS) || 120, task);
          const info = await fetchBlobForTask(url, prefs, task);
          const datauri = await blobToDataURL(info.blob);
          if (task) task.throwIfCancelled();
          elList.forEach(item=>{
            try{
              if(item.type === 'img'){
                item.el.setAttribute('src', datauri);
                item.el.removeAttribute('data-src'); item.el.removeAttribute('data-original'); item.el.removeAttribute('srcset');
              } else if (item.type === 'bgInline'){
                const old = item.el.getAttribute('style') || '';
                const newStyle = old.replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g'), datauri);
                item.el.setAttribute('style', newStyle);
              } else {
                item.el.style.backgroundImage = `url('${datauri}')`;
              }
            }catch(e){}
          });
          totalBytes += info.size || (datauri.length * 0.75);
          fetchedCount++;
        } catch(e){
          if (isCancellation(e, task)) throw e;
          console.warn('resource fetch failed', url, e);
          failed.push(url);
          if (task) task.recordResourceFailure(url, e);
        } finally {
          completedCount++;
          if(typeof onProgress === 'function') onProgress({done: completedCount, total: entries.length});
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()));
    return { html: clone.innerHTML, bytes: totalBytes, fetchedCount, failedUrls: failed };
  }

  /* ----------------------------
     Answer-specific helpers
     ---------------------------- */

  function getQuestionId(node, index) {
    const wrapper = node.querySelector('.wrapper.quesdiv');
    return node.getAttribute('questionid') || (wrapper && wrapper.id ? wrapper.id.replace('quesdiv', '') : '') || `noqid_${index + 1}`;
  }

  function getAnswerBlock(node) {
    return node ? node.querySelector(ANSWER_SELECTOR) : null;
  }

  function isPlaceholderImageSource(src) {
    const value = (src || '').trim().toLowerCase();
    return !value || value === 'about:blank' ||
      /^data:image\/gif;base64,r0lgodlhaqaba/i.test(value) ||
      /(?:^|[\/_-])(placeholder|loading|lazy)(?:[\/_?.-]|$)/i.test(value);
  }

  function isUsableAnswerImage(img) {
    return !!img && !isPlaceholderImageSource(img.getAttribute('src'));
  }

  function answerBlockState(answerBlock) {
    if (!answerBlock) return { ready: false, reason: 'answer-node-missing' };
    const rawText = (answerBlock.innerText || answerBlock.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const labelOnly = /^(?:答案|解析|参考答案|答案解析|详解|解答)\s*[：:]?\s*$/;
    const knownFailure = /^(?:未抓到答案内容|未找到答案(?:内容)?|暂无答案|加载中(?:\.\.\.)?)$/;
    const hasText = !!rawText && !labelOnly.test(rawText) && !knownFailure.test(rawText);
    const hasImage = Array.from(answerBlock.querySelectorAll('img')).some(isUsableAnswerImage);
    const hasStructuredContent = !!answerBlock.querySelector('math, svg, canvas, object, embed');
    if (hasText || hasImage || hasStructuredContent) {
      return { ready: true, reason: hasText ? 'text' : (hasImage ? 'image' : 'structured'), text: rawText };
    }
    return { ready: false, reason: rawText ? 'placeholder-or-label' : 'answer-empty', text: rawText };
  }

  function answerState(node) {
    return answerBlockState(getAnswerBlock(node));
  }

  function hydrateLazyImages(root) {
    if (!root) return 0;
    let hydrated = 0;
    root.querySelectorAll('img').forEach(img => {
      const current = img.getAttribute('src');
      if (!isPlaceholderImageSource(current)) return;
      const replacement = ['data-src', 'data-original', 'data-lazy-src']
        .map(attr => img.getAttribute(attr))
        .find(value => value && !isPlaceholderImageSource(value));
      if (replacement) {
        img.setAttribute('src', replacement);
        hydrated++;
      }
    });
    return hydrated;
  }

  function collectAnswerImageUrlsFromBlock(answerBlock) {
    if (!answerBlock) return [];
    const urls = new Set();
    const add = value => {
      const normalized = normalizeUrl(value || '');
      if (normalized && !/^data:/i.test(normalized)) urls.add(normalized);
    };
    answerBlock.querySelectorAll('img').forEach(img => {
      add(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'));
    });
    answerBlock.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href');
      if (href && /getAnswerAndParse|imzujuan/i.test(href)) add(href);
    });
    answerBlock.querySelectorAll('*').forEach(element => {
      const style = element.getAttribute && element.getAttribute('style');
      if (!style || !/url\(/i.test(style)) return;
      const pattern = /url\(['"]?([^'")]+)['"]?\)/ig;
      let match;
      while ((match = pattern.exec(style))) add(match[1]);
    });
    return Array.from(urls);
  }

  // Serialize a detached copy after answer resources have been resolved. This also
  // rewrites relative `src` / `data-src` values that would not match an absolute URL.
  function renderAnswerBlock(answerBlock, replacements = new Map()) {
    if (!answerBlock) return '<em>未找到答案内容</em>';
    const clone = answerBlock.cloneNode(true);
    hydrateLazyImages(clone);
    clone.querySelectorAll('img').forEach(img => {
      for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
        const raw = img.getAttribute(attr);
        const replacement = replacements.get(normalizeUrl(raw || '')) || replacements.get(raw || '');
        if (!replacement) continue;
        img.setAttribute('src', replacement);
        img.removeAttribute('data-src');
        img.removeAttribute('data-original');
        img.removeAttribute('data-lazy-src');
        break;
      }
    });
    clone.querySelectorAll('*').forEach(element => {
      const style = element.getAttribute && element.getAttribute('style');
      if (!style || !/url\(/i.test(style)) return;
      const rewritten = style.replace(/url\((['"]?)([^'")]+)\1\)/ig, (all, quote, raw) => {
        const replacement = replacements.get(normalizeUrl(raw || '')) || replacements.get(raw || '');
        return replacement ? `url("${replacement}")` : all;
      });
      element.setAttribute('style', rewritten);
    });
    return clone.innerHTML;
  }

  function waitForAnswerReady(questionNode, timeoutMs, task) {
    const initial = answerState(questionNode);
    if (initial.ready) return Promise.resolve({ ...initial, elapsedMs: 0, timedOut: false });
    return new Promise(resolve => {
      const started = Date.now();
      let observer = null;
      let interval = null;
      let timer = null;
      let unregisterAbort = () => {};
      let finished = false;
      const finish = (state, timedOut) => {
        if (finished) return;
        finished = true;
        if (observer) observer.disconnect();
        if (interval) clearInterval(interval);
        if (timer) clearTimeout(timer);
        unregisterAbort();
        resolve({ ...state, elapsedMs: Date.now() - started, timedOut: !!timedOut });
      };
      const inspect = () => {
        if (task && task.cancelled) return finish({ ready: false, reason: 'cancelled' }, false);
        hydrateLazyImages(getAnswerBlock(questionNode));
        const state = answerState(questionNode);
        if (state.ready) finish(state, false);
      };
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(inspect);
        observer.observe(questionNode, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['src', 'data-src', 'data-original', 'style']
        });
      }
      interval = setInterval(inspect, 120);
      timer = setTimeout(() => finish(answerState(questionNode), true), Math.max(0, Number(timeoutMs) || 0));
      if (task) unregisterAbort = task.registerAbort(() => finish({ ready: false, reason: 'cancelled' }, false));
      inspect();
    });
  }

  // The global switch exists on only some page types; avoid an unnecessary long wait when it is absent.
  async function showAllAnswersAndWait(timeoutMs = 6000, task){
    try {
      if (task) task.throwIfCancelled();
      const checkbox = document.getElementById('isshowAnswer');
      const trigger = document.querySelector('label[for="isshowAnswer"], .show-answer');
      if (!checkbox && !trigger) return false;
      if (checkbox && !checkbox.checked) (trigger || checkbox).click();
      else if (!checkbox && trigger) trigger.click();

      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (task) task.throwIfCancelled();
        if (Array.from(document.querySelectorAll(ANSWER_SELECTOR)).some(block => answerBlockState(block).ready)) return true;
        await sleepWithTask(120, task);
      }
      return false;
    } catch(e){
      if (isCancellation(e, task)) throw e;
      console.warn('showAllAnswersAndWait error', e);
      return false;
    }
  }

  function getAnswerClickTarget(questionNode) {
    return questionNode.querySelector('.exam-item__cnt') || questionNode.querySelector('.wrapper.quesdiv') || questionNode;
  }

  function describeClickTarget(target) {
    if (!target) return 'none';
    if (target.matches && target.matches('.exam-item__cnt')) return '.exam-item__cnt';
    if (target.matches && target.matches('.wrapper.quesdiv')) return '.wrapper.quesdiv';
    return '.tk-quest-item';
  }

  async function preloadAllAnswers(prefs, task, nodes = Array.from(document.querySelectorAll(QUESTION_SELECTOR))) {
    const report = { total: nodes.length, existing: 0, clicked: 0, failed: 0, globalReveal: false, items: [] };
    if (!nodes.length) return report;

    task.setStage(`答案预加载：检查全局开关（${nodes.length} 题）…`);
    report.globalReveal = await showAllAnswersAndWait(prefs.ANSWER_GLOBAL_WAIT_MS, task);

    for (let index = 0; index < nodes.length; index++) {
      task.throwIfCancelled();
      const questionNode = nodes[index];
      const qid = getQuestionId(questionNode, index);
      const record = { qid, index: index + 1, status: '', attempts: 0, clickTarget: '', elapsedMs: 0 };
      task.setStage(`答案预加载：${index + 1}/${nodes.length}（${qid}）`);

      let state = answerState(questionNode);
      if (state.ready) {
        hydrateLazyImages(getAnswerBlock(questionNode));
        report.existing++;
        record.status = 'already-ready';
        record.reason = state.reason;
      } else {
        try { questionNode.scrollIntoView({ block: 'center', behavior: 'instant' }); }
        catch (e) { try { questionNode.scrollIntoView(); } catch (ignored) {} }
        await sleepWithTask(Math.min(300, prefs.ANSWER_PRELOAD_DELAY_MS), task);
        state = answerState(questionNode);

        if (state.ready) {
          hydrateLazyImages(getAnswerBlock(questionNode));
          report.existing++;
          record.status = 'scroll-ready';
          record.reason = state.reason;
        } else {
          const target = getAnswerClickTarget(questionNode);
          record.clickTarget = describeClickTarget(target);
          const attempts = Math.max(1, prefs.ANSWER_CLICK_ATTEMPTS);
          for (let attempt = 0; attempt < attempts && !state.ready; attempt++) {
            task.throwIfCancelled();
            record.attempts++;
            try { target.click(); } catch (error) { record.clickError = String(error && error.message ? error.message : error); }
            const waited = await waitForAnswerReady(questionNode, prefs.ANSWER_PRELOAD_TIMEOUT_MS, task);
            record.elapsedMs += waited.elapsedMs || 0;
            if (task.cancelled) task.throwIfCancelled();
            hydrateLazyImages(getAnswerBlock(questionNode));
            state = answerState(questionNode);
            if (!state.ready && attempt + 1 < attempts) await sleepWithTask(prefs.ANSWER_PRELOAD_DELAY_MS, task);
          }
          if (state.ready) {
            report.clicked++;
            record.status = 'clicked-ready';
            record.reason = state.reason;
          } else {
            report.failed++;
            record.status = 'not-loaded';
            record.reason = state.reason;
          }
        }
      }
      report.items.push(record);
      task.diagnostics.preload.push(record);
      setTaskProgress(task, 0, 30, ((index + 1) / nodes.length) * 100);
      await sleepWithTask(prefs.ANSWER_PRELOAD_DELAY_MS, task);
    }
    task.diagnostics.preloadSummary = { ...report, items: undefined };
    return report;
  }

  // Collect answer-image URLs after preloading; keep unanswered questions in the output instead of silently dropping them.
  function collectAnswerImageUrls(dedupeByQID = true){
    const items = [];
    const seenQ = new Set();
    Array.from(document.querySelectorAll(QUESTION_SELECTOR)).forEach((node, index) => {
      try {
        const qid = getQuestionId(node, index);
        if (dedupeByQID && seenQ.has(qid)) return;
        seenQ.add(qid);
        const answerBlock = getAnswerBlock(node);
        hydrateLazyImages(answerBlock);
        items.push({ qid, node, images: collectAnswerImageUrlsFromBlock(answerBlock), state: answerBlockState(answerBlock) });
      } catch(e){ console.warn('collectAnswerImageUrls error', e); }
    });
    return items;
  }

  function runSelectorDoctor() {
    const questions = Array.from(document.querySelectorAll(QUESTION_SELECTOR));
    const report = {
      generatedAt: new Date().toISOString(),
      page: { host: location.host, path: location.pathname },
      questionCount: questions.length,
      answerBlockCount: document.querySelectorAll(ANSWER_SELECTOR).length,
      readyAnswerCount: questions.filter(node => answerState(node).ready).length,
      globalAnswerToggle: !!document.querySelector('#isshowAnswer, label[for="isshowAnswer"], .show-answer')
    };
    if (activeTask) activeTask.diagnostics.selectorDoctor = report;
    else if (lastDiagnostics) lastDiagnostics.selectorDoctor = report;
    return report;
  }

  /* ----------------------------
     Build Panel UI (extends previous with answer options)
     ---------------------------- */
  function buildPanel() {
    if (document.getElementById('pz_offline_export_panel')) return;
    const panel = document.createElement('div');
    panel.id = 'pz_offline_export_panel';
    panel.style.cssText = 'position:fixed;right:12px;top:80px;width:360px;z-index:999999;background:#fff;border:1px solid #ddd;box-shadow:0 6px 18px rgba(0,0,0,0.12);border-radius:8px;padding:10px;font-family:Arial,Microsoft Yahei,sans-serif;font-size:13px;';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <strong>离线导出 & 答案合集 <span style="color:#777;font-weight:400">v${APP_VERSION}</span></strong>
        <button id="pz_close_btn" style="border:none;background:#f2f2f2;padding:4px 6px;border-radius:4px;cursor:pointer" aria-label="关闭">×</button>
      </div>
      <div style="margin-bottom:8px">
        <label>并发: <input id="pz_concurrency" type="number" min="1" value="3" style="width:60px"></label>
        <label style="margin-left:12px">延迟(ms): <input id="pz_delay_ms" type="number" min="0" value="120" style="width:80px"></label>
      </div>
      <div style="margin-bottom:8px">
        <label>重试: <input id="pz_fetch_retry" type="number" min="0" value="2" style="width:50px"></label>
        <label style="margin-left:12px">超时(ms): <input id="pz_fetch_timeout" type="number" min="3000" value="25000" style="width:78px"></label>
      </div>
      <div style="margin-bottom:8px">
        <label>封禁 ms: <input id="pz_block_ms" type="number" min="1000" value="600000" style="width:110px"></label>
      </div>
      <div style="margin-bottom:8px">
        <label>最大嵌入总 MB: <input id="pz_max_mb" type="number" min="1" value="8" style="width:80px"></label>
        <label style="float:right"><input id="pz_dedupe" type="checkbox" checked> 去重(QID)</label>
      </div>
      <div style="margin-bottom:8px">
        <button data-pz-export id="pz_build_html_btn" style="padding:6px 8px;margin-right:6px">生成题目离线 HTML</button>
        <button data-pz-export id="pz_build_zip_btn" style="padding:6px 8px">生成题目 ZIP</button>
      </div>
      <hr>
      <div style="margin-bottom:8px">
        <strong>答案导出</strong>
        <div style="margin-top:6px">
          <label><input id="pz_ans_embed" type="checkbox" checked> 嵌入答案图片为 Data-URI</label>
        </div>
        <div style="margin-top:6px">
          <label><input id="pz_ans_dedupe" type="checkbox" checked> 导出时按 QID 去重</label>
        </div>
        <div style="margin-top:6px">
          <label>单题等待(ms): <input id="pz_ans_timeout" type="number" min="500" max="15000" value="2500" style="width:70px"></label>
          <label style="margin-left:8px">点击次数: <input id="pz_ans_attempts" type="number" min="1" max="3" value="1" style="width:42px"></label>
        </div>
        <div style="margin-top:6px">
          <button data-pz-export id="pz_ans_html_btn" style="padding:6px 8px;margin-right:6px">导出答案合集 HTML</button>
          <button data-pz-export id="pz_ans_zip_btn" style="padding:6px 8px">导出答案 ZIP（图片/HTML）</button>
        </div>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button id="pz_cancel_btn" style="display:none;padding:4px 7px">取消当前导出</button>
        <button id="pz_doctor_btn" style="padding:4px 7px">检查页面兼容性</button>
        <button id="pz_diag_btn" style="padding:4px 7px" disabled>下载本次诊断 JSON</button>
        <span id="pz_task_status" style="color:#666;font-size:12px">空闲</span>
      </div>
      <div style="margin-top:8px">
        <div id="pz_log" style="height:140px;overflow:auto;border:1px solid #eee;padding:6px;background:#fdfdfd;font-size:12px"></div>
        <div style="height:8px"></div>
        <div style="background:#eee;height:12px;border-radius:8px;overflow:hidden">
          <div id="pz_progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" style="width:0%;height:100%;background:#4caf50"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('pz_close_btn').onclick = () => {
      if (activeTask && !activeTask.completed) activeTask.cancel();
      panel.remove();
    };
    document.getElementById('pz_cancel_btn').onclick = () => activeTask && activeTask.cancel();
    document.getElementById('pz_doctor_btn').onclick = () => {
      const report = runSelectorDoctor();
      log(`兼容性检查：题目 ${report.questionCount}，答案节点 ${report.answerBlockCount}，已就绪 ${report.readyAnswerCount}，全局开关 ${report.globalAnswerToggle ? '有' : '无'}。`);
    };
    document.getElementById('pz_diag_btn').onclick = downloadLastDiagnostics;

    document.getElementById('pz_build_html_btn').addEventListener('click', () => startQuestionExport('html'));
    document.getElementById('pz_build_zip_btn').addEventListener('click', () => startQuestionExport('zip'));
    document.getElementById('pz_ans_html_btn').addEventListener('click', () => startAnswerExport('html'));
    document.getElementById('pz_ans_zip_btn').addEventListener('click', () => startAnswerExport('zip'));
    updateTaskUI();
  }

  // Collect question rows for the v2.2-compatible question exporters.
  function collectQuestionRows(){
    const items=[];
    const nodes=document.querySelectorAll('.tk-quest-item');
    let idx=1;
    nodes.forEach(n=>{
      try{
        const itemIndex = idx++;
        const qid = n.getAttribute('questionid') || (n.querySelector('.wrapper.quesdiv') ? n.querySelector('.wrapper.quesdiv').id.replace('quesdiv','') : null);
        let qnode = n.querySelector('.wrapper.quesdiv');
        if(!qnode) qnode = n;
        const cnt = qnode.querySelector('.exam-item__cnt') || qnode;
        let qtext = cnt ? (cnt.innerText || cnt.textContent || '') : '';
        qtext = qtext.replace(/\s+/g,' ').trim();
        let ansText = '';
        const ansNode = n.querySelector('.item.answer') || n.querySelector('.exam-item__opt .item.answer');
        if(ansNode) ansText = (ansNode.innerText || ansNode.textContent || '').trim();
        items.push({ idx: itemIndex, qid: qid || ('noqid_' + itemIndex), node: qnode, qtext, ansText });
      }catch(e){}
    });
    return items;
  }

  function applyDedup(rows, dedupe){
    if(!dedupe) return rows.slice();
    const seen=new Set(); const out=[];
    rows.forEach(r=>{
      const k=r.qid || r.idx;
      if(!seen.has(k)){ seen.add(k); out.push(r); }
    });
    return out;
  }

  function readIntInput(id, fallback, min, max) {
    const element = document.getElementById(id);
    const value = Number.parseInt(element && element.value, 10);
    const normalized = Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, normalized));
  }

  function readPrefsFromUI(){
    return {
      CONCURRENCY: readIntInput('pz_concurrency', 3, 1, 8),
      INTER_REQUEST_DELAY_MS: readIntInput('pz_delay_ms', 120, 0, 5000),
      FETCH_RETRY: readIntInput('pz_fetch_retry', 2, 0, 5),
      FETCH_TIMEOUT_MS: readIntInput('pz_fetch_timeout', 25000, 3000, 120000),
      BLOCK_DURATION_MS: readIntInput('pz_block_ms', 600000, 1000, 3600000),
      MAX_EMBED_TOTAL_MB: readIntInput('pz_max_mb', 8, 1, 512),
      ANSWER_PRELOAD_TIMEOUT_MS: readIntInput('pz_ans_timeout', 2500, 500, 15000),
      ANSWER_CLICK_ATTEMPTS: readIntInput('pz_ans_attempts', 1, 1, 3),
      ANSWER_PRELOAD_DELAY_MS: readIntInput('pz_delay_ms', 120, 50, 5000),
      ANSWER_GLOBAL_WAIT_MS: 6000,
      ANS_EMBED: !!(document.getElementById('pz_ans_embed') && document.getElementById('pz_ans_embed').checked),
      ANS_DEDUPE: !!(document.getElementById('pz_ans_dedupe') && document.getElementById('pz_ans_dedupe').checked),
      dedupe: !!(document.getElementById('pz_dedupe') && document.getElementById('pz_dedupe').checked)
    };
  }

  function updateTaskUI(){
    const running = !!(activeTask && !activeTask.completed);
    document.querySelectorAll('[data-pz-export]').forEach(button => { button.disabled = running; });
    const cancelButton = document.getElementById('pz_cancel_btn');
    if (cancelButton) cancelButton.style.display = running ? '' : 'none';
    const status = document.getElementById('pz_task_status');
    if (status) {
      if (running) status.textContent = `${activeTask.stage} ${Math.round(activeTask.progress)}%`;
      else if (lastDiagnostics) status.textContent = `上次任务：${lastDiagnostics.status || '完成'}`;
      else status.textContent = '空闲';
    }
    const diagnosticsButton = document.getElementById('pz_diag_btn');
    if (diagnosticsButton) diagnosticsButton.disabled = !lastDiagnostics;
  }

  function log(msg){
    const logNode = document.getElementById('pz_log');
    const time = new Date().toLocaleTimeString();
    if(logNode) {
      const entry = document.createElement('div');
      entry.textContent = `[${time}] ${String(msg)}`;
      logNode.prepend(entry);
    } else console.log(msg);
  }

  function setProgress(pct){
    const el = document.getElementById('pz_progress');
    const value = Math.round(Math.max(0, Math.min(100, Number(pct) || 0)));
    if(el) {
      el.style.width = value + '%';
      el.setAttribute('aria-valuenow', String(value));
    }
  }

  async function runExportTask(kind, prefs, work) {
    if (activeTask && !activeTask.completed) {
      alert('已有导出任务正在执行，请先完成或取消。');
      return;
    }
    const task = new ExportTask(kind, prefs);
    activeTask = task;
    task.setProgress(0);
    task.setStage('初始化…');
    try {
      await work(task);
      task.throwIfCancelled();
      task.setProgress(100);
      task.finish('completed');
      log('导出任务完成。');
    } catch(error) {
      if (isCancellation(error, task)) {
        task.finish('cancelled');
        log('导出已取消。');
      } else {
        task.finish('failed', error);
        console.error('export task failed', error);
        log('导出失败：' + (error && error.message ? error.message : error));
        alert('导出失败：' + (error && error.message ? error.message : error));
      }
    } finally {
      activeTask = null;
      updateTaskUI();
    }
  }

  function startQuestionExport(mode) {
    const prefs = readPrefsFromUI();
    const rows = applyDedup(collectQuestionRows(), prefs.dedupe);
    if (!rows.length) { log('未找到题目节点。'); return; }
    runExportTask(`questions-${mode}`, prefs, async task => {
      task.setStage('收集题目并导出…');
      if (mode === 'html') await buildAndDownloadSingleHTML(rows, prefs, task);
      else await buildAndDownloadZip(rows, prefs, task);
    });
  }

  function startAnswerExport(mode) {
    const prefs = readPrefsFromUI();
    runExportTask(`answers-${mode}`, prefs, async task => {
      const compatibility = runSelectorDoctor();
      log(`兼容性检查：题目 ${compatibility.questionCount}，答案节点 ${compatibility.answerBlockCount}，已就绪 ${compatibility.readyAnswerCount}，全局开关 ${compatibility.globalAnswerToggle ? '有' : '无'}。`);
      const preload = await preloadAllAnswers(prefs, task);
      log(`答案预加载完成：已有 ${preload.existing}，点击加载 ${preload.clicked}，未加载 ${preload.failed}。`);
      task.setStage('收集答案并导出…');
      const items = collectAnswerImageUrls(prefs.ANS_DEDUPE);
      if (!items.length) throw new Error('未找到题目节点或答案节点。');
      if (mode === 'html') await exportAnswersAsHTML(items, prefs, task);
      else await exportAnswersAsZip(items, prefs, task);
    });
  }

  function downloadLastDiagnostics() {
    if (!lastDiagnostics) return;
    const payload = JSON.stringify(lastDiagnostics, null, 2);
    const filename = `zxxk_export_diagnostics_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'_')}.json`;
    downloadBlob(new Blob([payload], { type: 'application/json;charset=utf-8' }), filename);
    log('诊断 JSON 已生成：' + filename);
  }

  /* ----------------------------
     Export answers -> HTML
     ---------------------------- */
  async function exportAnswersAsHTML(items, prefs, task){
    // items: [{qid,node,images: [url,...]}]
    task.setStage('生成答案合集 HTML…');
    log(`准备导出 ${items.length} 个题目的答案（嵌入:${prefs.ANS_EMBED}）。`);
    let processed = 0;
    const parts = [];
    for(const it of items){
      task.throwIfCancelled();
      processed++;
      log(`处理答案 ${processed}/${items.length} QID:${it.qid}`);
      const qnode = it.node.querySelector ? (it.node.querySelector('.exam-item__cnt') || it.node) : it.node;
      // get answer block text/html
      const answerBlock = getAnswerBlock(it.node);
      const replacements = new Map();
      // if images to embed
      if(prefs.ANS_EMBED && it.images && it.images.length>0){
        for(let i=0;i<it.images.length;i++){
          task.throwIfCancelled();
          const url = it.images[i];
          try{
            const info = await fetchBlobForTask(url, prefs, task);
            const data = await blobToDataURL(info.blob);
            replacements.set(url, data);
          }catch(e){
            if (isCancellation(e, task)) throw e;
            log(`  嵌入图片失败: ${url} (${e && e.message ? e.message : e})`);
          }
          setTaskProgress(task, 30, 100, (processed-1 + (i+1)/Math.max(1,it.images.length))/items.length*100);
        }
      }
      const answerHtml = renderAnswerBlock(answerBlock, replacements);
      // prepare a card with question + answer
      const qcnt = qnode ? qnode.innerHTML : '';
      parts.push(`<div class="card"><div style="font-weight:700">QID:${escapeHtml(it.qid)}</div><div class="q">${qcnt}</div><hr><div class="ans">${answerHtml}</div></div>`);
      setTaskProgress(task, 30, 100, processed/items.length*100);
    }

    const finalHTML = `<!doctype html><html><head><meta charset="utf-8"><title>答案合集</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:Arial,'Microsoft Yahei',sans-serif;margin:12px;color:#111;background:#f6f6f6} .container{max-width:960px;margin:0 auto} .card{background:#fff;border:1px solid #e6e6e6;padding:12px;border-radius:6px;margin-bottom:12px;page-break-inside:avoid} img{max-width:100%;height:auto}</style>
      </head><body><div class="container">${parts.join('\n')}</div></body></html>`;
    const blob = new Blob([finalHTML], {type:'text/html;charset=utf-8'});
    const fn = `answers_collection_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.html`;
    downloadBlob(blob, fn);
    log('答案合集导出完成：' + fn);
    setTaskProgress(task, 30, 100, 100);
  }

  /* ----------------------------
     Export answers -> ZIP (images & per-question HTML)
     ---------------------------- */
  async function exportAnswersAsZip(items, prefs, task){
    task.setStage('生成答案 ZIP…');
    log('使用内置 ZIP 生成器（无需 JSZip/CDN）...');
    const zip = zipCreate();
    let processed = 0;
    for(const it of items){
      task.throwIfCancelled();
      processed++;
      log(`处理答案 ${processed}/${items.length} QID:${it.qid}`);
      const answerBlock = getAnswerBlock(it.node);
      const imgs = [];
      const seenImgs = new Set();
      const addImg = (rawUrl) => {
        const raw = rawUrl && rawUrl.trim();
        const url = normalizeUrl(raw);
        if(url && !/^data:/i.test(url) && !seenImgs.has(url)) { seenImgs.add(url); imgs.push({ raw, url }); }
      };
      if(answerBlock){
        answerBlock.querySelectorAll('img').forEach(img=>{
          addImg(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'));
        });
        answerBlock.querySelectorAll('*').forEach(el=>{
          const st = el.getAttribute && el.getAttribute('style');
          if(st && /url\(/i.test(st)){
            const re = /url\(['"]?([^'")]+)['"]?\)/ig; let m;
            while((m = re.exec(st))) addImg(m[1]);
          }
        });
      }
        const safeBase = safeFilePart(`QID_${it.qid}`, `QID_${processed}`);
        let htmlSnippet = `<div style="font-weight:700">QID:${escapeHtml(it.qid)}</div>`;
        const qnode = it.node.querySelector ? (it.node.querySelector('.exam-item__cnt') || it.node) : it.node;
        htmlSnippet += `<div class="q">${qnode ? qnode.innerHTML : ''}</div><hr>`;
        const ansHtml = answerBlock ? answerBlock.innerHTML : '<em>未找到答案</em>';
        htmlSnippet += `<div class="ans">${ansHtml}</div>`;
        let perQuestionHTML = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(safeBase)}</title><style>body{font-family:Arial,'Microsoft Yahei',sans-serif;margin:12px}img{max-width:100%;height:auto}</style></head><body>${htmlSnippet}</body></html>`;

      for(let i=0;i<imgs.length;i++){
        task.throwIfCancelled();
        const { raw, url } = imgs[i];
        try{
          const info = await fetchBlobForTask(url, prefs, task);
          const ext = getImageExt(url, info.blob);
          const imgName = `${safeBase}_ans${i+1}.${ext}`;
          await zipAddBlob(zip, `answers_images/${imgName}`, info.blob);
          if(prefs.ANS_EMBED){
            const data = await blobToDataURL(info.blob);
            perQuestionHTML = perQuestionHTML.split(raw).join(data).split(url).join(data);
          } else {
            const localPath = `../answers_images/${imgName}`;
            perQuestionHTML = perQuestionHTML.split(raw).join(localPath).split(url).join(localPath);
          }
        }catch(e){
          if (isCancellation(e, task)) throw e;
          log(`  下载答案图片失败：${url} (${e && e.message ? e.message : e})`);
        }
        setTaskProgress(task, 30, 100, (processed-1 + (i+1)/Math.max(1,imgs.length))/items.length*100);
      }

      await zipAddText(zip, `answers_html/${safeBase}.html`, perQuestionHTML);
      setTaskProgress(task, 30, 100, processed/items.length*100);
    }

    task.throwIfCancelled();
    log('生成 ZIP...');
    setTaskProgress(task, 30, 100, 98);
    const content = zipFinalize(zip);
    const fn = `answers_export_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.zip`;
    downloadBlob(content, fn);
    log('ZIP 下载已触发：' + fn);
    setTaskProgress(task, 30, 100, 100);
  }

  /* ----------------------------
     Question export adapters: share the same resilient resource pipeline
     ---------------------------- */

  async function embedResourcesForNode_simple(node, prefs, onProgress, task) {
    // reuse embedResourcesForNode above (same)
    return embedResourcesForNode(node, prefs, onProgress, task);
  }

  async function buildAndDownloadSingleHTML(rows, prefs, task){
    task.setStage('生成题目离线 HTML…');
    const total=rows.length; let processed=0; let accumulatedBytes=0; const parts=[];
    for(const r of rows){
      task.throwIfCancelled();
      processed++;
      log(`处理题 ${processed}/${total} QID:${r.qid}`);
      const cntNode = r.node.querySelector ? (r.node.querySelector('.exam-item__cnt') || r.node) : r.node;
      try{
        const res = await embedResourcesForNode_simple(cntNode, prefs, ({done, total: t})=>{
          setTaskProgress(task, 0, 100, ((processed-1) + done/Math.max(1,t))/total*100);
        }, task);
        accumulatedBytes += res.bytes || 0;
        const bytesLimit = (prefs.MAX_EMBED_TOTAL_MB || 8)*1024*1024;
        if(accumulatedBytes > bytesLimit){
          throw new Error(`嵌入图片总大小超出设置阈值（${prefs.MAX_EMBED_TOTAL_MB} MB）。`);
        }
        const meta = `<div style="font-weight:700;margin-bottom:6px">【${r.idx}】 QID:${escapeHtml(r.qid)} ${r.ansText ? '/ 答:' + escapeHtml(r.ansText) : ''}</div>`;
        parts.push(`<div class="card">${meta}${res.html}</div>`);
      }catch(e){
        if (isCancellation(e, task)) throw e;
        log(`题 ${r.qid} 处理失败: ${e && e.message}`);
        const raw = cntNode.innerHTML;
        parts.push(`<div class="card"><div style="font-weight:700">【${r.idx}】 QID:${escapeHtml(r.qid)}（嵌入失败）</div>${raw}</div>`);
      }
      setTaskProgress(task, 0, 100, processed/total*100);
    }
    task.throwIfCancelled();
    const finalHTML = `<!doctype html><html><head><meta charset="utf-8"><title>个人题库 - 离线打印</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,'Microsoft Yahei',sans-serif;margin:12px;color:#111;background:#f6f6f6}.container{max-width:960px;margin:0 auto}.card{background:#fff;border:1px solid #e6e6e6;padding:12px;border-radius:6px;margin-bottom:12px;page-break-inside:avoid}.card img{max-width:100%;height:auto}</style></head><body><div class="container">${parts.join('\n')}</div></body></html>`;
    const blob = new Blob([finalHTML], {type:'text/html;charset=utf-8'});
    const filename = `personal_tk_offline_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.html`;
    downloadBlob(blob, filename);
    log('导出完成：' + filename);
    setTaskProgress(task, 0, 100, 100);
  }

  async function buildAndDownloadZip(rows, prefs, task){
    task.setStage('生成题目 ZIP…');
    log('使用内置 ZIP 生成器（无需 JSZip/CDN）...');
    const zip = zipCreate();
    const total=rows.length; let processed=0; let accumulatedBytes=0;
    for(const r of rows){
      task.throwIfCancelled();
      processed++;
      log(`处理题 ${processed}/${total} QID:${r.qid}`);
      const cntNode = r.node.querySelector ? (r.node.querySelector('.exam-item__cnt') || r.node) : r.node;
      try{
        const res = await embedResourcesForNode_simple(cntNode, prefs, ({done, total:t})=>{
          setTaskProgress(task, 0, 100, ((processed-1) + done/Math.max(1,t))/total*100);
        }, task);
        accumulatedBytes += res.bytes || 0;
        const bytesLimit = (prefs.MAX_EMBED_TOTAL_MB || 8)*1024*1024;
        if(accumulatedBytes > bytesLimit){
          throw new Error(`嵌入图片总大小超出设置阈值（${prefs.MAX_EMBED_TOTAL_MB} MB）。`);
        }
        const safeTitle = safeFilePart(`QID_${r.qid}_idx${r.idx}`, `question_${processed}`);
        await zipAddText(zip, `personal_questions/${safeTitle}.html`, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(safeTitle)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,'Microsoft Yahei',sans-serif;margin:12px}img{max-width:100%;height:auto}</style></head><body>${res.html}</body></html>`);
      }catch(e){
        if (isCancellation(e, task)) throw e;
        log(`题 ${r.qid} 处理异常: ${e && e.message ? e.message : e}`);
        const raw = cntNode.innerHTML;
        const safeTitle = safeFilePart(`QID_${r.qid}_idx${r.idx}_fallback`, `question_${processed}_fallback`);
        await zipAddText(zip, `personal_questions/${safeTitle}.html`, `<!doctype html><html><head><meta charset="utf-8"></head><body>${raw}</body></html>`);
      }
      setTaskProgress(task, 0, 100, processed/total*100);
    }

    task.throwIfCancelled();
    log('生成 ZIP...');
    setTaskProgress(task, 0, 100, 98);
    const content = zipFinalize(zip);
    const fn = `personal_questions_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.zip`;
    downloadBlob(content, fn);
    log('ZIP 下载已触发：' + fn);
    setTaskProgress(task, 0, 100, 100);
  }

  /* ----------------------------
     Init
     ---------------------------- */
  setTimeout(()=>{
    buildPanel();
    log('离线导出 & 答案合集面板已准备好（调整并发/延迟/阈值后使用）。');
  }, 1200);

})();
