// ==UserScript==
// @name         学科网组卷/试卷下载打印 (精简优化版)
// @version      1.3.2
// @namespace    https://greasyfork.org/users/1566377-frank-678
// @description  【2026/2/17 修复】解决打印右侧被裁切（取消打印padding、强制换行、表格图片不溢出、轻微缩放）。
// @author       Frank-678
// @match        https://zujuan.xkw.com/zujuan
// @match        https://zujuan.xkw.com/*.html
// @icon         https://zujuan.xkw.com/favicon.ico
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/Frank-678/zxxk-zujuan-paper-downloader
// @supportURL   https://github.com/Frank-678/zxxk-zujuan-paper-downloader/issues
// @run-at       document-idle
// @downloadURL  https://update.greasyfork.org/scripts/564643/%E5%AD%A6%E7%A7%91%E7%BD%91%E7%BB%84%E5%8D%B7%E8%AF%95%E5%8D%B7%E4%B8%8B%E8%BD%BD%E6%89%93%E5%8D%B0%20%28%E7%B2%BE%E7%AE%80%E4%BC%98%E5%8C%96%E7%89%88%29.user.js
// @updateURL    https://update.greasyfork.org/scripts/564643/%E5%AD%A6%E7%A7%91%E7%BD%91%E7%BB%84%E5%8D%B7%E8%AF%95%E5%8D%B7%E4%B8%8B%E8%BD%BD%E6%89%93%E5%8D%B0%20%28%E7%B2%BE%E7%AE%80%E4%BC%98%E5%8C%96%E7%89%88%29.meta.js
// ==/UserScript==

(function () {
  "use strict";
  console.log("打印精简脚本 v1.3.2 已启动...");

  // --- 配置项 ---
  const CONFIG = {
    removeKnowledge: true, // 是否删除知识点 (true=删除, false=保留)
    removeSource: true,    // 是否删除题目来源/组卷次数 (true=删除)
    forceBlackText: true   // 是否强制打印为深黑色字体 (防止字迹太淡)
  };

  // --- 工具函数 ---
  function getSafeText(selector, defaultText = "") {
    try {
      var el = document.querySelector(selector);
      return el ? el.innerText.trim() : defaultText;
    } catch (e) {
      return defaultText;
    }
  }

  // --- 1. 创建按钮 ---
  var printButton = document.createElement("a");
  printButton.className = "link-item anchor-font3";
  printButton.style.cssText =
    "cursor:pointer;background-color:#409eff;color:#fff;border-radius:4px;padding:0 10px;margin-right:10px;";
  printButton.innerHTML =
    `<i class="icon icon-download1"></i><span style="font-weight:bold;">纯净打印</span>`;

  // --- 2. 核心逻辑 ---
  printButton.onclick = function () {
    if (
      !confirm(
        "即将生成【纯净版】打印页面。\n\n• 知识点：已隐藏\n• 干扰项：已清理\n• 页面状态：打印后自动恢复\n\n是否继续？"
      )
    )
      return;

    // 获取主体
    var examContent = document.querySelector(".exam-cnt");
    if (!examContent) {
      alert("找不到试卷内容");
      return;
    }

    // 获取标题
    var paperTitle = getSafeText(".exam-title .title-txt", "试卷");
    var subject = getSafeText(".subject-menu__title", "学科");
    document.title = subject + "_" + paperTitle;

    // 克隆节点
    var contentClone = examContent.cloneNode(true);

    // === 🧹 深度清理列表 ===
    var junkSelectors = [
      ".ctrl-box",          // 操作按钮
      ".add-sec-ques",      // 添加按钮
      "#paperAnalyze",      // 分析报告
      ".ques-additional",   // 题目顶部的题型说明/难度
      ".exam-item__custom", // "您最近一年使用..."
      ".video-help"         // 视频帮助
    ];

    // 根据配置删除来源信息
    if (CONFIG.removeSource) {
      junkSelectors.push(".exam-item__info"); // 底部来源、组卷次数
    }

    // 根据配置删除知识点（网站源码拼写 knowlegde）
    if (CONFIG.removeKnowledge) {
      junkSelectors.push(".item.knowlegde");  // 网站现有错误拼写
      junkSelectors.push(".item.knowledge");  // 预防未来修正
      junkSelectors.push(".knowledge-box");   // 知识点容器
    }

    // 执行删除
    junkSelectors.forEach((sel) => {
      contentClone.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // 强制显示答案
    contentClone.querySelectorAll("[hidden]").forEach((el) => el.removeAttribute("hidden"));
    contentClone.querySelectorAll(".exam-item__opt").forEach((el) => (el.style.display = "block"));

    // === 注入打印专用 CSS（重点修复：右侧裁切）===
    var style = document.createElement("style");
    style.innerHTML = `
      /* 全局：避免 padding/边框把宽度撑爆 */
      *, *::before, *::after { box-sizing: border-box !important; }

      @media print {
        /* 页边距给内容更大空间（原15mm会更容易挤） */
        @page { size: A4; margin: 12mm; }

        html, body {
          margin: 0 !important;
          padding: 0 !important;
          background: #fff !important;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
          overflow: visible !important;
        }

        /* 关键：打印时不要 wrapper 的 40px padding（这是裁切主因之一） */
        .print-preview-wrapper {
          width: auto !important;
          max-width: none !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        /* 关键：长字符串/英文/公式，强制可断行，防止一行撑出页面 */
        p, div, span, li, td, th {
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
        }

        /* 关键：表格/图片不溢出 */
        img { max-width: 100% !important; height: auto !important; page-break-inside: avoid; }
        table { width: 100% !important; max-width: 100% !important; }
        td, th { max-width: 100% !important; }

        /* 如果仍有极少数页面被裁，轻微缩放几乎无感但很稳 */
        body { transform: scale(0.98); transform-origin: top left; }

        /* 强制深色字体 */
        .exam-item__cnt, .exam-title, .sec-title, p, div, span {
          color: #000 !important;
          text-shadow: none !important;
        }

        /* 隐藏链接下划线 */
        a { text-decoration: none !important; color: #000 !important; }

        /* 题目之间留白 */
        .sec-list { margin-bottom: 20px; border-bottom: 1px dashed #eee; padding-bottom: 10px; }
      }

      /* 浏览预览：保留美观 padding（打印时会被上面覆盖为0） */
      .print-preview-wrapper {
        width: 100%;
        max-width: 900px;
        margin: 0 auto;
        padding: 40px;
      }
    `;

    // === 重构页面 ===
    document.body.innerHTML = "";
    document.body.style.background = "#fff";
    document.body.style.overflow = "auto";
    document.body.style.height = "auto";

    var printWrapper = document.createElement("div");
    printWrapper.className = "print-preview-wrapper";
    printWrapper.appendChild(style);
    printWrapper.appendChild(contentClone);
    document.body.appendChild(printWrapper);

    console.log("纯净版已生成，移除知识点：" + CONFIG.removeKnowledge);

    // 延迟调用打印
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    }, 800);
  };

  // --- 3. 注入位置 ---
  var targetFound = false;
  var selectors = [".tools .link-box", ".btn-box", ".exam-title"];
  for (let sel of selectors) {
    let el = document.querySelector(sel);
    if (el) {
      if (sel === ".exam-title") printButton.style.float = "right";
      el.insertBefore(printButton, el.firstChild);
      targetFound = true;
      break;
    }
  }
  if (!targetFound) {
    printButton.style.cssText += "position:fixed; top:100px; right:20px; z-index:9999;";
    document.body.appendChild(printButton);
  }
})();
