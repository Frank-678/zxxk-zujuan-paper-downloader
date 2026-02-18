// ==UserScript==
// @name         组卷网 - 个人题库 离线导出 + 答案合集（图片嵌入 & ZIP）
// @namespace    https://greasyfork.org/users/1566377-frank-678
// @version      2.0
// @description  将个人题库题目与答案导出为离线HTML/ZIP，支持把题目内所有图片/公式和答案图片嵌入为 Data-URI，智能命名，去重，并发/延迟/封禁保护（兼容组卷网个人题库 DOM）
// @author       Frank-678
// @match        https://zujuan.xkw.com/*
// @match        https://www.zxxk.com/zujuan/*
// @grant        GM_registerMenuCommand
// @grant        GM_notification
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
  function downloadBlob(blob, filename){ const a=document.createElement('a'); const url=URL.createObjectURL(blob); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },1000); }

  function loadScriptOnce(src){
    if (document.querySelector('script[data-src="'+src+'"]')) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true; s.setAttribute('data-src', src);
      s.onload = ()=>res(); s.onerror = (e)=>rej(e); document.head.appendChild(s);
    });
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

  async function fetchBlobWithRetry(url, prefs){
    const maxRetries = (prefs && prefs.FETCH_RETRY!=null) ? prefs.FETCH_RETRY : 2;
    const baseDelay = (prefs && prefs.INTER_REQUEST_DELAY_MS!=null) ? prefs.INTER_REQUEST_DELAY_MS : 120;
    let attempt = 0;
    if (window.__pz_block_until && Date.now() < window.__pz_block_until) {
      throw new Error('Global block in effect until ' + new Date(window.__pz_block_until).toLocaleTimeString());
    }
    while(attempt<=maxRetries){
      try {
        // try fetch
        const resp = await fetch(url, {method:'GET', mode:'cors', cache:'force-cache'});
        if (!resp.ok) {
          if (resp.status === 429 || resp.status === 403) {
            const blockMs = (prefs && prefs.BLOCK_DURATION_MS) || 10*60*1000;
            window.__pz_block_until = Date.now() + blockMs;
            throw new Error('Server returned ' + resp.status + '. Blocked for ' + (blockMs/60000) + ' minutes.');
          }
          throw new Error('HTTP ' + resp.status);
        }
        const blob = await resp.blob();
        const size = blob.size || 0;
        return { blob, size, url, status: resp.status };
      } catch(err){
        attempt++;
        if(attempt>maxRetries) throw err;
        const back = baseDelay * Math.pow(2,attempt) + Math.round(Math.random()*200);
        await sleep(back);
      }
    }
    throw new Error('Failed to fetch: ' + url);
  }

  function blobToDataURL(blob){ return new Promise((res, rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=(e)=>rej(e); fr.readAsDataURL(blob); }); }

  /* ----------------------------
     Embed resources inside a node (images + bg)
     Returns { html, bytes, fetchedCount, failedUrls }
     ---------------------------- */
  async function embedResourcesForNode(node, prefs, onProgress){
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
    let totalBytes = 0, fetchedCount = 0;
    const failed = [];
    const CONCURRENCY = Math.max(1, (prefs && prefs.CONCURRENCY) || 3);
    let idx = 0, inflight = 0;
    async function worker(){
      while(idx < entries.length){
        if(inflight >= CONCURRENCY){ await sleep(40); continue; }
        const [url, elList] = entries[idx++];
        inflight++;
        (async ()=>{
          try {
            await sleep((prefs && prefs.INTER_REQUEST_DELAY_MS) || 120);
            const info = await fetchBlobWithRetry(url, prefs);
            const datauri = await blobToDataURL(info.blob);
            // replace occurrences
            elList.forEach(item=>{
              try{
                if(item.type === 'img'){
                  // simply set src to datauri, remove srcset etc
                  item.el.setAttribute('src', datauri);
                  item.el.removeAttribute('data-src'); item.el.removeAttribute('data-original'); item.el.removeAttribute('srcset');
                } else if (item.type === 'bgInline'){
                  const old = item.el.getAttribute('style') || '';
                  const newStyle = old.replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g'), datauri);
                  item.el.setAttribute('style', newStyle);
                } else { // bgComputed
                  item.el.style.backgroundImage = `url('${datauri}')`;
                }
              }catch(e){}
            });
            totalBytes += info.size || (datauri.length * 0.75);
            fetchedCount++;
            if(typeof onProgress === 'function') onProgress({done: fetchedCount, total: entries.length});
          } catch(e){
            console.warn('resource fetch failed', url, e);
            failed.push(url);
            // no replacement -> will remain external
          } finally { inflight--; }
        })();
      }
      while(inflight>0) await sleep(40);
    }
    await worker();
    return { html: clone.innerHTML, bytes: totalBytes, fetchedCount, failedUrls: failed };
  }

  /* ----------------------------
     Answer-specific helpers
     ---------------------------- */

  // Try to toggle "显示全部答案和解析"
  async function showAllAnswersAndWait(timeoutMs = 6000){
    try {
      const chk = document.getElementById('isshowAnswer');
      if (chk && !chk.checked) {
        // click label: there is label with for="isshowAnswer"
        const lab = document.querySelector('label[for="isshowAnswer"]') || document.querySelector('.show-answer');
        if (lab) lab.click();
        else chk.click();
      }
      // wait for answers nodes to appear/populate
      const start = Date.now();
      while(Date.now() - start < timeoutMs){
        const answers = document.querySelectorAll('.item.answer');
        if (answers && answers.length>0) {
          // ensure at least some answers have non-empty content
          let any = false;
          answers.forEach(a=>{
            if (a && (a.innerText.trim() || a.querySelector('img'))) any = true;
          });
          if (any) return true;
        }
        await sleep(200);
      }
      return false;
    } catch(e){ console.warn('showAllAnswersAndWait error', e); return false; }
  }

  // Collect answer-image URLs for all questions (after answers shown)
  function collectAnswerImageUrls(dedupeByQID = true){
    const items = [];
    const nodes = document.querySelectorAll('.tk-quest-item');
    const seenQ = new Set();
    nodes.forEach((n, idx) => {
      try {
        const qid = n.getAttribute('questionid') || (n.querySelector('.wrapper.quesdiv') ? n.querySelector('.wrapper.quesdiv').id.replace('quesdiv','') : `noqid_${idx+1}`);
        if (dedupeByQID && seenQ.has(qid)) return; // skip duplicate
        seenQ.add(qid);
        // find answer block
        let answerBlock = n.querySelector('.item.answer') || n.querySelector('.exam-item__opt .item.answer');
        let images = [];
        if (answerBlock) {
          // simple image tags
          answerBlock.querySelectorAll('img').forEach(img=>{
            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');
            if (src) images.push(normalizeUrl(src));
          });
          // maybe answer contains direct link to imzujuan image text (raw)
          answerBlock.querySelectorAll('a').forEach(a=>{
            const href = a.getAttribute('href');
            if (href && href.match(/getAnswerAndParse|imzujuan/)) images.push(normalizeUrl(href));
          });
          // sometimes answer may show as <div><img> or <span style="background-image:url(...)">
          answerBlock.querySelectorAll('*').forEach(el=>{
            const st = el.getAttribute && el.getAttribute('style');
            if (st && /url\(/i.test(st)) {
              const m = st.match(/url\(['"]?([^'")]+)['"]?\)/);
              if (m && m[1]) images.push(normalizeUrl(m[1]));
            }
          });
        }
        // fallback: some answers are available via imzujuan/getAnswerAndParse endpoint (pattern). We'll attempt to build that URL if no images found.
        items.push({ qid, node: n, images: images.filter(Boolean) });
      } catch(e){ console.warn('collectAnswerImageUrls error', e); }
    });
    return items;
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
        <strong>离线导出 & 答案合集</strong>
        <button id="pz_close_btn" style="border:none;background:#f2f2f2;padding:4px 6px;border-radius:4px;cursor:pointer">×</button>
      </div>
      <div style="margin-bottom:8px">
        <label>并发: <input id="pz_concurrency" type="number" min="1" value="3" style="width:60px"></label>
        <label style="margin-left:12px">延迟(ms): <input id="pz_delay_ms" type="number" min="0" value="120" style="width:80px"></label>
      </div>
      <div style="margin-bottom:8px">
        <label>重试: <input id="pz_fetch_retry" type="number" min="0" value="2" style="width:50px"></label>
        <label style="margin-left:12px">封禁 ms: <input id="pz_block_ms" type="number" min="1000" value="600000" style="width:110px"></label>
      </div>
      <div style="margin-bottom:8px">
        <label>最大嵌入总 MB: <input id="pz_max_mb" type="number" min="1" value="8" style="width:80px"></label>
        <label style="float:right"><input id="pz_dedupe" type="checkbox" checked> 去重(QID)</label>
      </div>
      <div style="margin-bottom:8px">
        <button id="pz_build_html_btn" style="padding:6px 8px;margin-right:6px">生成题目离线 HTML</button>
        <button id="pz_build_zip_btn" style="padding:6px 8px">生成题目 ZIP</button>
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
          <button id="pz_ans_html_btn" style="padding:6px 8px;margin-right:6px">导出答案合集 HTML</button>
          <button id="pz_ans_zip_btn" style="padding:6px 8px">导出答案 ZIP（图片/HTML）</button>
        </div>
      </div>
      <div style="margin-top:8px">
        <div id="pz_log" style="height:140px;overflow:auto;border:1px solid #eee;padding:6px;background:#fdfdfd;font-size:12px"></div>
        <div style="height:8px"></div>
        <div style="background:#eee;height:12px;border-radius:8px;overflow:hidden">
          <div id="pz_progress" style="width:0%;height:100%;background:#4caf50"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('pz_close_btn').onclick = () => panel.remove();

    document.getElementById('pz_build_html_btn').addEventListener('click', async ()=>{
      const prefs = readPrefsFromUI();
      log('收集题目...');
      const rows = collectQuestionRows();
      if (!rows.length){ log('未找到题目节点。'); return; }
      const rowsToProcess = applyDedup(rows, prefs.dedupe);
      await buildAndDownloadSingleHTML(rowsToProcess, prefs);
    });

    document.getElementById('pz_build_zip_btn').addEventListener('click', async ()=>{
      const prefs = readPrefsFromUI();
      log('收集题目...');
      const rows = collectQuestionRows();
      if (!rows.length){ log('未找到题目节点。'); return; }
      const rowsToProcess = applyDedup(rows, prefs.dedupe);
      await buildAndDownloadZip(rowsToProcess, prefs);
    });

    document.getElementById('pz_ans_html_btn').addEventListener('click', async ()=>{
      const prefs = readPrefsFromUI();
      prefs.ANS_EMBED = !!document.getElementById('pz_ans_embed').checked;
      prefs.ANS_DEDUPE = !!document.getElementById('pz_ans_dedupe').checked;
      log('尝试显示全部答案（如果页面上有该控件）...');
      await showAllAnswersAndWait(6000);
      log('收集答案图片列表...');
      const items = collectAnswerImageUrls(prefs.ANS_DEDUPE);
      if (!items.length){ log('没有找到答案节点或答案图片。'); alert('未发现答案图片。请先点击页面上“显示全部答案和解析”或检查页面。'); return; }
      await exportAnswersAsHTML(items, prefs);
    });

    document.getElementById('pz_ans_zip_btn').addEventListener('click', async ()=>{
      const prefs = readPrefsFromUI();
      prefs.ANS_EMBED = !!document.getElementById('pz_ans_embed').checked;
      prefs.ANS_DEDUPE = !!document.getElementById('pz_ans_dedupe').checked;
      log('尝试显示全部答案（如果页面上有该控件）...');
      await showAllAnswersAndWait(6000);
      log('收集答案图片列表...');
      const items = collectAnswerImageUrls(prefs.ANS_DEDUPE);
      if (!items.length){ log('没有找到答案节点或答案图片。'); alert('未发现答案图片。请先点击页面上“显示全部答案和解析”或检查页面。'); return; }
      await exportAnswersAsZip(items, prefs);
    });
  }

  // helper: collect question rows (same as earlier)
  function collectQuestionRows(){
    const items=[];
    const nodes=document.querySelectorAll('.tk-quest-item');
    let idx=1;
    nodes.forEach(n=>{
      try{
        const qid = n.getAttribute('questionid') || (n.querySelector('.wrapper.quesdiv') ? n.querySelector('.wrapper.quesdiv').id.replace('quesdiv','') : null);
        let qnode = n.querySelector('.wrapper.quesdiv');
        if(!qnode) qnode = n;
        const cnt = qnode.querySelector('.exam-item__cnt') || qnode;
        let qtext = cnt ? (cnt.innerText || cnt.textContent || '') : '';
        qtext = qtext.replace(/\s+/g,' ').trim();
        let ansText = '';
        const ansNode = n.querySelector('.item.answer') || n.querySelector('.exam-item__opt .item.answer');
        if(ansNode) ansText = (ansNode.innerText || ansNode.textContent || '').trim();
        items.push({ idx: idx++, qid: qid || ('noqid_' + idx), node: qnode, qtext, ansText });
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

  function readPrefsFromUI(){
    const concurrency = parseInt(document.getElementById('pz_concurrency').value||'3',10);
    const INTER_REQUEST_DELAY_MS = parseInt(document.getElementById('pz_delay_ms').value||'120',10);
    const FETCH_RETRY = parseInt(document.getElementById('pz_fetch_retry').value||'2',10);
    const BLOCK_DURATION_MS = parseInt(document.getElementById('pz_block_ms').value||'600000',10);
    const MAX_EMBED_TOTAL_MB = parseInt(document.getElementById('pz_max_mb') ? document.getElementById('pz_max_mb').value : '8', 10) || 8;
    const dedupe = !!(document.getElementById('pz_dedupe') && document.getElementById('pz_dedupe').checked);
    return { CONCURRENCY: concurrency, INTER_REQUEST_DELAY_MS, FETCH_RETRY, BLOCK_DURATION_MS, MAX_EMBED_TOTAL_MB, dedupe };
  }

  function log(msg){
    const Ln=document.getElementById('pz_log');
    const t=new Date().toLocaleTimeString();
    if(Ln) Ln.innerHTML = `<div>[${t}] ${escapeHtml(''+msg)}</div>` + Ln.innerHTML;
    else console.log(msg);
  }
  function setProgress(pct){ const el=document.getElementById('pz_progress'); if(el) el.style.width = Math.round(pct) + '%'; }

  /* ----------------------------
     Export answers -> HTML
     ---------------------------- */
  async function exportAnswersAsHTML(items, prefs){
    // items: [{qid,node,images: [url,...]}]
    log(`准备导出 ${items.length} 个题目的答案（嵌入:${prefs.ANS_EMBED}）。`);
    let processed = 0;
    const parts = [];
    for(const it of items){
      processed++;
      log(`处理答案 ${processed}/${items.length} QID:${it.qid}`);
      const qnode = it.node.querySelector ? (it.node.querySelector('.exam-item__cnt') || it.node) : it.node;
      // get answer block text/html
      const answerBlock = it.node.querySelector('.item.answer') || it.node.querySelector('.exam-item__opt .item.answer');
      let answerHtml = answerBlock ? answerBlock.innerHTML : '<em>未找到答案内容</em>';
      // if images to embed
      if(prefs.ANS_EMBED && it.images && it.images.length>0){
        // fetch & embed each image
        const CONCURRENCY = Math.max(1, prefs.CONCURRENCY || 3);
        // simple sequential for stability
        const embeddedImgs = [];
        for(let i=0;i<it.images.length;i++){
          const url = it.images[i];
          try{
            const info = await fetchBlobWithRetry(url, prefs);
            const data = await blobToDataURL(info.blob);
            // replace occurrences in answerHtml
            answerHtml = answerHtml.split(url).join(data);
            embeddedImgs.push({url, data});
          }catch(e){
            log(`  嵌入图片失败: ${url} (${e && e.message ? e.message : e})`);
            // keep external url
          }
          setProgress((processed-1 + (i+1)/Math.max(1,it.images.length))/items.length*100);
        }
      }
      // prepare a card with question + answer
      const qcnt = qnode ? qnode.innerHTML : '';
      parts.push(`<div class="card"><div style="font-weight:700">QID:${escapeHtml(it.qid)}</div><div class="q">${qcnt}</div><hr><div class="ans">${answerHtml}</div></div>`);
      setProgress(processed/items.length*100);
    }

    const finalHTML = `<!doctype html><html><head><meta charset="utf-8"><title>答案合集</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:Arial,'Microsoft Yahei',sans-serif;margin:12px;color:#111;background:#f6f6f6} .container{max-width:960px;margin:0 auto} .card{background:#fff;border:1px solid #e6e6e6;padding:12px;border-radius:6px;margin-bottom:12px;page-break-inside:avoid} img{max-width:100%;height:auto}</style>
      </head><body><div class="container">${parts.join('\n')}</div></body></html>`;
    const blob = new Blob([finalHTML], {type:'text/html;charset=utf-8'});
    const fn = `answers_collection_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.html`;
    downloadBlob(blob, fn);
    log('答案合集导出完成：' + fn);
    setProgress(100);
  }

  /* ----------------------------
     Export answers -> ZIP (images & per-question HTML)
     ---------------------------- */
  async function exportAnswersAsZip(items, prefs){
    log('加载 JSZip...');
    try { await loadScriptOnce('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); } catch(e){ alert('加载 JSZip 失败，无法生成 ZIP'); return; }
    if(!window.JSZip){ alert('JSZip 未加载'); return; }
    const zip = new JSZip();
    const imgFolder = zip.folder('answers_images');
    const htmlFolder = zip.folder('answers_html');
    let processed = 0;
    for(const it of items){
      processed++;
      log(`处理答案 ${processed}/${items.length} QID:${it.qid}`);
      const answerBlock = it.node.querySelector('.item.answer') || it.node.querySelector('.exam-item__opt .item.answer');
      // collect images from answerBlock
      const imgs = [];
      if(answerBlock){
        answerBlock.querySelectorAll('img').forEach(img=>{ const s = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'); if(s) imgs.push(normalizeUrl(s)); });
        // inline styles
        answerBlock.querySelectorAll('*').forEach(el=>{
          const st = el.getAttribute && el.getAttribute('style');
          if(st && /url\(/i.test(st)){
            const m = st.match(/url\(['"]?([^'")]+)['"]?\)/);
            if(m && m[1]) imgs.push(normalizeUrl(m[1]));
          }
        });
      }
      const safeBase = `QID_${it.qid}`;
      let htmlSnippet = `<div style="font-weight:700">QID:${escapeHtml(it.qid)}</div>`;
      // include question content
      const qnode = it.node.querySelector ? (it.node.querySelector('.exam-item__cnt') || it.node) : it.node;
      htmlSnippet += `<div class="q">${qnode ? qnode.innerHTML : ''}</div><hr>`;
      // answer text
      const ansHtml = answerBlock ? answerBlock.innerHTML : '<em>未找到答案</em>';
      htmlSnippet += `<div class="ans">${ansHtml}</div>`;
      // create per-question html (will be updated if images are embedded)
      let perQuestionHTML = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(safeBase)}</title><style>img{max-width:100%}</style></head><body>${htmlSnippet}</body></html>`;

      // fetch images: if embed requested, embed into HTML; also add each image file to ZIP (named by qid)
      for(let i=0;i<imgs.length;i++){
        const url = imgs[i];
        const ext = (url.split('.').pop().split(/\W/)[0] || 'png').toLowerCase();
        const imgName = `${safeBase}_ans${i+1}.${ext}`;
        try{
          const info = await fetchBlobWithRetry(url, prefs);
          if(prefs.ANS_EMBED){
            const data = await blobToDataURL(info.blob);
            perQuestionHTML = perQuestionHTML.split(url).join(data);
            // also add to ZIP as binary
            const arrayBuffer = await info.blob.arrayBuffer();
            imgFolder.file(imgName, arrayBuffer);
          } else {
            // not embed: add raw file
            const arrayBuffer = await info.blob.arrayBuffer();
            imgFolder.file(imgName, arrayBuffer);
            // replace occurrences with local filename
            perQuestionHTML = perQuestionHTML.split(url).join(`answers_images/${imgName}`);
          }
        }catch(e){
          log(`  下载答案图片失败：${url} (${e && e.message})`);
          // keep external url
        }
        setProgress((processed-1 + (i+1)/Math.max(1,imgs.length))/items.length*100);
      }

      // add per-question HTML
      htmlFolder.file(`${safeBase}.html`, perQuestionHTML);
      setProgress(processed/items.length*100);
    }

    log('生成 ZIP...');
    const content = await zip.generateAsync({type:'blob'}, meta => {
      if(meta && meta.percent) setProgress(meta.percent);
    });
    const fn = `answers_export_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.zip`;
    downloadBlob(content, fn);
    log('ZIP 下载完成：' + fn);
    setProgress(100);
  }

  /* ----------------------------
     Remaining: reuse embedResources/buildAndDownload functions for questions
     (for brevity, use simplified versions from earlier script)
     ---------------------------- */

  async function embedResourcesForNode_simple(node, prefs, onProgress) {
    // reuse embedResourcesForNode above (same)
    return embedResourcesForNode(node, prefs, onProgress);
  }

  // buildAndDownloadSingleHTML & buildAndDownloadZip (same as earlier but use simple embed func)
  async function buildAndDownloadSingleHTML(rows, prefs){
    const total=rows.length; let processed=0; let accumulatedBytes=0; const parts=[];
    for(const r of rows){
      processed++;
      log(`处理题 ${processed}/${total} QID:${r.qid}`);
      const cntNode = r.node.querySelector ? (r.node.querySelector('.exam-item__cnt') || r.node) : r.node;
      try{
        const res = await embedResourcesForNode_simple(cntNode, prefs, ({done, total: t})=>{
          setProgress(((processed-1) + done/Math.max(1,t))/total*100);
        });
        accumulatedBytes += res.bytes || 0;
        const bytesLimit = (prefs.MAX_EMBED_TOTAL_MB || 8)*1024*1024;
        if(accumulatedBytes > bytesLimit){
          log(`已超出嵌入阈值 ${prefs.MAX_EMBED_TOTAL_MB} MB，停止导出。`);
          alert('嵌入图片总大小超出设置阈值，请增大阈值或减少题目数量后重试。');
          return;
        }
        const meta = `<div style="font-weight:700;margin-bottom:6px">【${r.idx}】 QID:${escapeHtml(r.qid)} ${r.ansText ? '/ 答:' + escapeHtml(r.ansText) : ''}</div>`;
        parts.push(`<div class="card">${meta}${res.html}</div>`);
      }catch(e){
        log(`题 ${r.qid} 处理失败: ${e && e.message}`);
        const raw = cntNode.innerHTML;
        parts.push(`<div class="card"><div style="font-weight:700">【${r.idx}】 QID:${escapeHtml(r.qid)}（嵌入失败）</div>${raw}</div>`);
      }
      setProgress(processed/total*100);
    }
    const finalHTML = `<!doctype html><html><head><meta charset="utf-8"><title>个人题库 - 离线打印</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,'Microsoft Yahei',sans-serif;margin:12px;color:#111;background:#f6f6f6}.container{max-width:960px;margin:0 auto}.card{background:#fff;border:1px solid #e6e6e6;padding:12px;border-radius:6px;margin-bottom:12px;page-break-inside:avoid}.card img{max-width:100%;height:auto}</style></head><body><div class="container">${parts.join('\n')}</div></body></html>`;
    const blob = new Blob([finalHTML], {type:'text/html;charset=utf-8'});
    const filename = `personal_tk_offline_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.html`;
    downloadBlob(blob, filename);
    log('导出完成：' + filename);
    setProgress(100);
  }

  async function buildAndDownloadZip(rows, prefs){
    log('加载 JSZip...');
    try{ await loadScriptOnce('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); }catch(e){ alert('加载 JSZip 失败'); return; }
    if(!window.JSZip){ alert('JSZip 未加载'); return; }
    const zip = new JSZip(); const folder = zip.folder('personal_questions');
    const total=rows.length; let processed=0; let accumulatedBytes=0;
    for(const r of rows){
      processed++;
      log(`处理题 ${processed}/${total} QID:${r.qid}`);
      const cntNode = r.node.querySelector ? (r.node.querySelector('.exam-item__cnt') || r.node) : r.node;
      try{
        const res = await embedResourcesForNode_simple(cntNode, prefs, ({done, total:t})=>{
          setProgress(((processed-1) + done/Math.max(1,t))/total*100);
        });
        accumulatedBytes += res.bytes || 0;
        const bytesLimit = (prefs.MAX_EMBED_TOTAL_MB || 8)*1024*1024;
        if(accumulatedBytes > bytesLimit){
          log('已超出嵌入阈值，中止。');
          alert('嵌入图片总大小超出设置阈值，请调整后重试。');
          return;
        }
        const safeTitle = `QID_${r.qid}_idx${r.idx}`;
        folder.file(`${safeTitle}.html`, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(safeTitle)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>img{max-width:100%}</style></head><body>${res.html}</body></html>`);
      }catch(e){
        log(`题 ${r.qid} 处理异常: ${e && e.message}`);
        const raw = cntNode.innerHTML;
        folder.file(`QID_${r.qid}_idx${r.idx}_fallback.html`, `<!doctype html><html><head><meta charset="utf-8"></head><body>${raw}</body></html>`);
      }
      setProgress(processed/total*100);
    }

    log('生成 ZIP...');
    const content = await zip.generateAsync({type:'blob'}, meta=>{
      if(meta && meta.percent) setProgress(meta.percent);
    });
    const fn = `personal_questions_${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'_')}.zip`;
    downloadBlob(content, fn);
    log('ZIP 下载完成：' + fn);
    setProgress(100);
  }

  /* ----------------------------
     Init
     ---------------------------- */
  setTimeout(()=>{
    buildPanel();
    log('离线导出 & 答案合集面板已准备好（调整并发/延迟/阈值后使用）。');
  }, 1200);

})();
