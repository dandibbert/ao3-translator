// ==UserScript==
// @name         AO3 全文翻译+总结
// @namespace    https://ao3-translate.example
// @version      1.2.9
// @description  【翻译+总结双引擎】精确token计数；智能分块策略；流式渲染；章节总结功能；独立缓存系统；四视图切换（译文/原文/双语/总结）；长按悬浮菜单；移动端优化；OpenAI兼容API。
// @match        https://archiveofourown.org/works/*
// @match        https://archiveofourown.org/chapters/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  /* ================= Settings & Utils ================= */
  const NS = 'ao3_full_translate_v039';
  const settings = {
    defaults: {
      api: { baseUrl: '', path: 'v1/chat/completions', key: '' },
      model: { id: '', contextWindow: 16000 },
      gen: { maxTokens: 7000, temperature: 0.7, top_p: 1, omitMaxTokensInRequest: false },
      translate: {
        model: { id: '', contextWindow: 16000 },
        gen: { maxTokens: 7000, temperature: 0.7, top_p: 1 },
        reasoningEffort: -1  // -1不发送, 'none'/'low'/'medium'/'high'才发送
      },
      prompt: {
        system: '你是专业的文学翻译助手。请保持 AO3 文本结构、段落层次、行内格式（粗体、斜体、链接），人名不做翻译，术语翻译时意译，以保证不了解者也能看懂为准则，语气自然流畅。可以调整语序用词，但不要省略有实质性内容的语句。请保证译文地道，自然，有韵味，符合原文语气和上下文情境。',
        userTemplate: '你是一个专业的文学翻译助手，请将以下 AO3 正文完整翻译为中文，保证译文地道，自然，有韵味，符合原文语气和上下文情境。人名不做翻译，术语翻译时意译，以保证不了解者也能看懂为准则，保持 HTML 结构与行内标记，仅替换可见文本内容，不要漏翻除人名外的英文内容：\n{{content}}\n（请直接返回 HTML 片段，不要使用代码块或转义。）'
      },
      summary: {
        model: { id: '', contextWindow: 16000 },
        gen: { maxTokens: 7000, temperature: 0.7, top_p: 1 },
        reasoningEffort: -1,  // -1不发送, 'none'/'low'/'medium'/'high'才发送
        system: '你是专业的文学内容总结助手。请准确概括故事情节、人物关系和重要事件，保持客观中性的语调，不要做文本分析，仅输出总结内容。',
        userTemplate: '请对以下AO3章节内容进行剧情总结，重点包括：主要情节发展、角色互动、重要对话或事件。请用简洁明了的中文总结：\n{{content}}\n（请直接返回总结内容，不需要格式化，不需要做文本分析，人名保留原文不翻译。）',
        ratioTextToSummary: 0.3  // 总结通常比原文更简洁
      },
      stream: { enabled: true, minFrameMs: 30 },
      concurrency: 3,
      debug: false,
      disableSystemPrompt: false,  // 是否禁用发送 system prompt
      ui: { fontSize: 16 }, // 译文字体大小
      planner: {
        reserve: 384,
        trySingleShotOnce: true,
        singleShotSlackRatio: 0.15,
        packSlack: 0.95,          // 更激进一点
        ratioOutPerIn: 1        // ★ 英->中常见：输出token约为输入的70%
      },
      watchdog: { idleMs: -1, hardMs: -1, maxRetry: 1 },
      download: { workerUrl: '' },
      chunkIndicator: { showPreview: false },  // 分块指示器设置
      webdav: { url: '', username: '', password: '' }  // WebDAV 配置
    },
    get() {
      try {
        const saved = GM_Get(NS);
        return saved ? deepMerge(structuredClone(this.defaults), saved) : structuredClone(this.defaults);
      } catch { return structuredClone(this.defaults); }
    },
    set(p) { const merged = deepMerge(this.get(), p); GM_Set(NS, merged); return merged; }
  };
  function GM_Get(k) { try { return GM_getValue(k); } catch { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } } }
  function GM_Set(k, v) { try { GM_setValue(k, v); } catch { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } } }
  function GM_Del(k) { try { GM_deleteValue(k); } catch { try { localStorage.removeItem(k); } catch { } } }
  function GM_ListKeys() { try { return (typeof GM_listValues === 'function') ? GM_listValues() : Object.keys(localStorage); } catch { try { return Object.keys(localStorage); } catch { return []; } } }


  const d = (...args) => { if (settings.get().debug) console.log('[AO3X]', ...args); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const trimSlash = (s) => s.replace(/\/+$/, '');

  // GM_xmlhttpRequest 包装器，用于绕过 CORS 限制
  function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const requestConfig = {
        method: options.method || 'GET',
        url: url,
        headers: options.headers || {},
        timeout: options.timeout || 60000, // 默认60秒超时
        onload: (response) => {
          console.log(`[gmFetch] ${options.method || 'GET'} ${url} - Status: ${response.status}`);

          // 模拟 fetch API 的 Response 对象
          const mockResponse = {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            statusText: response.statusText,
            headers: response.responseHeaders,
            text: async () => response.responseText,
            json: async () => JSON.parse(response.responseText)
          };
          resolve(mockResponse);
        },
        onerror: (error) => {
          console.error('[gmFetch] Network error:', error);
          reject(new Error(`Network request failed: ${error.error || 'Unknown error'}`));
        },
        ontimeout: () => {
          console.error('[gmFetch] Request timeout');
          reject(new Error('Request timeout (60s)'));
        }
      };

      // 如果有 body/data，添加到请求中
      if (options.body) {
        requestConfig.data = options.body;
      }

      GM_xmlhttpRequest(requestConfig);
    });
  }

  // Safari 兼容的下载函数（异步版本）
  function downloadBlob(blob, filename) {
    return new Promise((resolve, reject) => {
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

      if (isSafari) {
        // Safari 特殊处理
        const reader = new FileReader();
        reader.onload = function () {
          const link = document.createElement('a');
          link.href = reader.result;
          link.download = filename;
          link.style.display = 'none';

          // Safari 需要将链接添加到 DOM 并模拟用户点击
          document.body.appendChild(link);

          // 使用 setTimeout 确保 DOM 更新
          setTimeout(() => {
            link.click();

            // 清理
            setTimeout(() => {
              document.body.removeChild(link);
              resolve();
            }, 100);
          }, 0);
        };
        reader.onerror = function (error) {
          reject(new Error('FileReader error: ' + error));
        };
        reader.readAsDataURL(blob);
      } else {
        // Chrome/Firefox 标准方法
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        // 清理
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          resolve();
        }, 100);
      }
    });
  }

  function deepMerge(a, b) { if (!b) return a; const o = Array.isArray(a) ? [...a] : { ...a }; for (const k in b) { o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k]; } return o; }
  function sanitizeHTML(html) {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    tmp.querySelectorAll('script, style, iframe, object, embed').forEach(n => n.remove());
    tmp.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase(), val = String(attr.value || '');
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(val)) el.removeAttribute(attr.name);
      });
    });
    return tmp.innerHTML;
  }
  function stripHtmlToText(html) { const div = document.createElement('div'); div.innerHTML = html; return (div.textContent || '').replace(/\s+/g, ' ').trim(); }
  function escapeHTML(s) { return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

  /* ================= Heuristic Token Estimator (local, no external deps) ================= */
  const TKT = {
    // Keep the same public interface but use a local heuristic only.
    model2enc() { return 'heuristic'; },
    async load() { /* no-op */ },
    async countTextTokens(text /*, modelId */) {
      return heuristicCount(text);
    },
    async countPromptTokens(messages /*, modelId */) {
      // Rough overhead for role/formatting. Keep small and stable.
      const structuralOverhead = 8;
      const joined = messages.map(m => m && typeof m.content === 'string' ? m.content : '').join('\n');
      return heuristicCount(joined) + structuralOverhead;
    }
  };
  function heuristicCount(text) {
    const s = (text || '');
    if (!s) return 0;
    // Heuristic: English-like ~1 token per 4 chars; Chinese-like ~1 per 1.7 chars.
    // Use the max of both to be conservative, and add 10% headroom.
    const chars = s.length;
    const estEN = Math.ceil(chars / 4);
    const estZH = Math.ceil(chars / 1.7);
    return Math.ceil(Math.max(estEN, estZH) * 1.1);
  }
  async function estimateTokensForText(text) { const s = settings.get(); return await TKT.countTextTokens(text, s.model.id); }
  async function estimatePromptTokensFromMessages(messages) { const s = settings.get(); return await TKT.countPromptTokens(messages, s.model.id); }

  /* ================= AO3 DOM Select ================= */
  function getHostElement() { return $('#chapters') || $('#workskin') || document.body; }
  function collectChapterUserstuffSmart() {
    const EXCLUDE_SEL = '.preface, .summary, .notes, .endnotes, .afterword, .work.meta, .series, .children';
    let nodes = [];
    const chapters = $('#chapters');
    if (chapters) nodes = $all('.chapter .userstuff', chapters).filter(n => !n.closest(EXCLUDE_SEL));
    if (!nodes.length) nodes = $all('.userstuff').filter(n => !n.closest(EXCLUDE_SEL));
    return nodes;
  }
  let SelectedNodes = [];
  function markSelectedNodes(nodes) { SelectedNodes.forEach(n => n.removeAttribute('data-ao3x-target')); SelectedNodes = nodes; nodes.forEach(n => n.setAttribute('data-ao3x-target', '1')); }

  /* ================= UI ================= */
  const UI = {
    init() {
      GM_AddCSS();
      const wrap = document.createElement('div');
      wrap.className = 'ao3x-fab-wrap';
      const btnTranslate = document.createElement('button'); btnTranslate.className = 'ao3x-btn'; btnTranslate.textContent = '🌐';
      UI._btnTranslate = btnTranslate;
      const btnMain = document.createElement('button'); btnMain.className = 'ao3x-btn'; btnMain.textContent = '⚙️';

      // 创建悬浮按钮组容器
      const floatingMenu = document.createElement('div');
      floatingMenu.className = 'ao3x-floating-menu';
      floatingMenu.style.display = 'none';

      // 创建下载按钮
      const btnDownload = document.createElement('button');
      btnDownload.className = 'ao3x-btn ao3x-floating-btn';
      btnDownload.textContent = '📥';
      btnDownload.title = '下载当前译文缓存';

      // 创建总结按钮
      const btnSummary = document.createElement('button');
      btnSummary.className = 'ao3x-btn ao3x-floating-btn';
      btnSummary.textContent = '📝';
      btnSummary.title = '生成章节总结';

      // 创建只计划按钮
      const btnPlanOnly = document.createElement('button');
      btnPlanOnly.className = 'ao3x-btn ao3x-floating-btn';
      btnPlanOnly.textContent = '📋';
      btnPlanOnly.title = '只计划不翻译（可手动选择翻译指定块）';

      // 创建批量下载按钮
      const btnBatchDownload = document.createElement('button');
      btnBatchDownload.className = 'ao3x-btn ao3x-floating-btn';
      btnBatchDownload.textContent = '📦';
      btnBatchDownload.title = '批量下载已翻译章节';
      btnBatchDownload.style.display = 'none'; // 默认隐藏
      UI._btnBatchDownload = btnBatchDownload; // 保存引用

      floatingMenu.appendChild(btnDownload);
      floatingMenu.appendChild(btnBatchDownload);
      floatingMenu.appendChild(btnPlanOnly);
      floatingMenu.appendChild(btnSummary);
      wrap.appendChild(floatingMenu);

      // 长按功能变量
      let longPressTimer = null;
      let longPressTriggered = false;
      let pointerHandledUntil = 0;
      let isMenuVisible = false;
      const TAP_SUPPRESS_MS = 350;
      const LONG_PRESS_SUPPRESS_MS = 1000;

      // 显示/隐藏悬浮菜单
      const showFloatingMenu = async () => {
        if (isMenuVisible) return;

        // 检查是否有多个已翻译章节
        const translatedChapters = await Controller.getTranslatedChapters();
        if (translatedChapters && translatedChapters.length > 1) {
          btnBatchDownload.style.display = '';
        } else {
          btnBatchDownload.style.display = 'none';
        }

        isMenuVisible = true;
        floatingMenu.style.display = 'flex';
        // 添加动画效果
        requestAnimationFrame(() => {
          floatingMenu.classList.add('visible');
        });
      };

      const hideFloatingMenu = () => {
        if (!isMenuVisible) return;
        isMenuVisible = false;
        floatingMenu.classList.remove('visible');
        // 延迟隐藏以等待动画完成
        setTimeout(() => {
          if (!isMenuVisible) {
            floatingMenu.style.display = 'none';
          }
        }, 200);
      };

      const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

      const markPointerHandled = (duration = 800) => {
        pointerHandledUntil = Math.max(pointerHandledUntil, now() + duration);
      };

      const pointerHandledActive = () => now() < pointerHandledUntil;

      const startLongPress = () => {
        longPressTriggered = false;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          longPressTriggered = true;
          showFloatingMenu();
        }, 800); // 0.8秒长按
      };

      const finishLongPress = () => {
        clearTimeout(longPressTimer);
        const wasLongPress = longPressTriggered;
        longPressTriggered = false;
        return wasLongPress;
      };

      const cancelLongPress = () => {
        finishLongPress();
      };

      // iOS Safari文本选择防护
      const preventSelection = (e) => {
        const target = e.target;
        if (!target) return;
        let btn = null;
        if (typeof target.closest === 'function') {
          btn = target.closest('.ao3x-btn');
        } else {
          let el = target;
          while (el && el !== document) {
            if (el.classList && el.classList.contains('ao3x-btn')) {
              btn = el;
              break;
            }
            el = el.parentNode;
          }
        }
        if (!btn) return;
        if (e.type === 'touchstart') return; // 允许触摸事件冒泡以保证点击触发
        e.preventDefault();
        e.stopPropagation();
        return false;
      };

      // 鼠标事件（桌面）
      btnTranslate.addEventListener('mousedown', (e) => {
        if (e.button && e.button !== 0) return;
        preventSelection(e);
        startLongPress();
      });
      btnTranslate.addEventListener('mouseup', (e) => {
        if (e.button && e.button !== 0) return;
        const wasLongPress = finishLongPress();
        markPointerHandled(wasLongPress ? 1200 : 800);
        if (wasLongPress) {
          if (e.cancelable) e.preventDefault();
        } else {
          if (e.cancelable) e.preventDefault();
          Controller.startTranslate();
        }
      });
      btnTranslate.addEventListener('mouseleave', () => {
        cancelLongPress();
        // 鼠标离开时也隐藏菜单
        setTimeout(() => {
          if (isMenuVisible && !floatingMenu.matches(':hover') && !btnTranslate.matches(':hover')) {
            hideFloatingMenu();
          }
        }, 100);
      });

      // 触摸事件（移动设备）
      btnTranslate.addEventListener('touchstart', (e) => {
        startLongPress();
      }, { passive: true });
      btnTranslate.addEventListener('touchend', (e) => {
        const wasLongPress = finishLongPress();
        markPointerHandled(wasLongPress ? 1400 : 800);
        if (e.cancelable) e.preventDefault();
        if (!wasLongPress) {
          Controller.startTranslate();
        }
      }, { passive: false });
      btnTranslate.addEventListener('touchcancel', () => {
        finishLongPress();
        markPointerHandled(800);
      });

      // 悬浮菜单事件
      floatingMenu.addEventListener('mouseleave', () => {
        // 鼠标离开悬浮菜单时延迟隐藏
        setTimeout(() => {
          if (isMenuVisible && !floatingMenu.matches(':hover') && !btnTranslate.matches(':hover')) {
            hideFloatingMenu();
          }
        }, 300);
      });

      // 点击外部区域隐藏菜单
      document.addEventListener('click', (e) => {
        if (isMenuVisible && !wrap.contains(e.target)) {
          hideFloatingMenu();
        }
      });

      // 添加全局文本选择防护
      document.addEventListener('selectstart', preventSelection);
      document.addEventListener('mousedown', preventSelection);
      document.addEventListener('touchstart', preventSelection);

      // 翻译按钮点击事件
      btnTranslate.addEventListener('click', (event) => {
        if (event && event.detail === 0) {
          pointerHandledUntil = 0;
        }
        if (pointerHandledActive()) return;
        Controller.startTranslate();
      });

      // 总结按钮事件
      btnSummary.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof SummaryController !== 'undefined' && SummaryController.startSummary) {
          SummaryController.startSummary();
        } else {
          UI.toast('总结功能尚未完全实现');
        }
        hideFloatingMenu();
      });

      // 下载按钮事件
      btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        Controller.downloadTranslation();
        hideFloatingMenu();
      });

      // 批量下载按钮事件
      btnBatchDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        Controller.batchDownloadChapters();
        hideFloatingMenu();
      });

      // 只计划按钮事件
      btnPlanOnly.addEventListener('click', (e) => {
        e.stopPropagation();
        Controller.planOnly();
        hideFloatingMenu();
      });


      btnMain.addEventListener('click', () => UI.openPanel());
      wrap.appendChild(btnTranslate); wrap.appendChild(btnMain); document.body.appendChild(wrap);
      UI.buildPanel(); UI.buildToolbar(); UI.ensureToast();
    },
    ensureToast() { if (!$('#ao3x-toast')) { const t = document.createElement('div'); t.id = 'ao3x-toast'; t.className = 'ao3x-toast'; document.body.appendChild(t); } },
    toast(msg) { const t = $('#ao3x-toast'); if (!t) return; const n = document.createElement('div'); n.className = 'item'; n.textContent = msg; t.appendChild(n); setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity .3s'; setTimeout(() => n.remove(), 300); }, 1400); },
    buildPanel() {
      const mask = document.createElement('div'); mask.className = 'ao3x-panel-mask'; mask.addEventListener('click', () => UI.closePanel());
      const panel = document.createElement('div'); panel.className = 'ao3x-panel';
      panel.innerHTML = `
        <div class="ao3x-panel-header">
          <h3>AO3 翻译设置</h3>
          <button class="ao3x-panel-close" id="ao3x-close-x">×</button>
        </div>
        <div class="ao3x-panel-body">
          <div class="ao3x-section">
            <h4 class="ao3x-section-title">API 配置</h4>
            <div class="ao3x-field">
              <label>Base URL</label>
              <input id="ao3x-base" type="text" placeholder="https://api.example.com"/>
            </div>
            <div class="ao3x-field">
              <label>API Path</label>
              <input id="ao3x-path" type="text" placeholder="v1/chat/completions"/>
              <span class="ao3x-hint">若 Base 已含 /v1/... 将忽略此项</span>
            </div>
            <div class="ao3x-field">
              <label>API Key</label>
              <input id="ao3x-key" type="password" placeholder="sk-..." autocomplete="off"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">翻译模型设置</h4>
            <div class="ao3x-field">
              <label>翻译模型名称</label>
              <div class="ao3x-input-group">
                <input id="ao3x-translate-model" type="text" placeholder="gpt-4o-mini"/>
                <button id="ao3x-fetch-models" class="ao3x-btn-secondary">获取列表</button>
              </div>
              <span class="ao3x-hint">翻译专用模型，可与总结模型不同</span>
            </div>
            <div id="ao3x-translate-model-browser" class="ao3x-model-browser" style="display:none">
              <div class="ao3x-field">
                <label>搜索模型</label>
                <input id="ao3x-translate-model-q" type="text" placeholder="输入关键词筛选模型..." class="ao3x-model-search"/>
              </div>
              <div class="ao3x-model-list" id="ao3x-translate-model-list"></div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>翻译上下文窗口</label>
                <input id="ao3x-translate-cw" type="number" min="2048" value="16000"/>
              </div>
              <div class="ao3x-field">
                <label>翻译Max Tokens</label>
                <input id="ao3x-translate-maxt" type="number" min="128" value="7000"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>翻译温度 <span class="ao3x-badge">0-2</span></label>
                <input id="ao3x-translate-temp" type="number" step="0.1" min="0" max="2" value="0.7"/>
              </div>
              <div class="ao3x-field">
                <label>翻译推理强度</label>
                <select id="ao3x-translate-reasoning">
                  <option value="-1">不发送</option>
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">总结模型设置</h4>
            <div class="ao3x-field">
              <label>总结模型名称</label>
              <div class="ao3x-input-group">
                <input id="ao3x-summary-model" type="text" placeholder="gpt-4o-mini"/>
                <button id="ao3x-fetch-summary-models" class="ao3x-btn-secondary">获取列表</button>
              </div>
              <span class="ao3x-hint">总结专用模型，可与翻译模型不同</span>
            </div>
            <div id="ao3x-summary-model-browser" class="ao3x-model-browser" style="display:none">
              <div class="ao3x-field">
                <label>搜索模型</label>
                <input id="ao3x-summary-model-q" type="text" placeholder="输入关键词筛选模型..." class="ao3x-model-search"/>
              </div>
              <div class="ao3x-model-list" id="ao3x-summary-model-list"></div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>总结上下文窗口</label>
                <input id="ao3x-summary-cw" type="number" min="2048" value="16000"/>
              </div>
              <div class="ao3x-field">
                <label>总结Max Tokens</label>
                <input id="ao3x-summary-maxt" type="number" min="128" value="7000"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>总结温度 <span class="ao3x-badge">0-2</span></label>
                <input id="ao3x-summary-temp" type="number" step="0.1" min="0" max="2" value="0.7"/>
              </div>
              <div class="ao3x-field">
                <label>总结推理强度</label>
                <select id="ao3x-summary-reasoning">
                  <option value="-1">不发送</option>
                  <option value="none">none</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </div>
            </div>
          </div>


          <div class="ao3x-section">
            <h4 class="ao3x-section-title">翻译提示词设置</h4>
            <div class="ao3x-field">
              <label>System Prompt</label>
              <textarea id="ao3x-sys" rows="3"></textarea>
            </div>
            <div class="ao3x-field">
              <label>User 模板 <span class="ao3x-hint">使用 {{content}} 作为占位符</span></label>
              <textarea id="ao3x-user" rows="3"></textarea>
            </div>
            <div class="ao3x-field">
              <label>译文/原文比 <span class="ao3x-hint">用于计算分块，通常译文比原文更长</span></label>
              <input id="ao3x-ratio" type="number" step="0.05" min="0.3" value="0.7"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">总结提示词设置</h4>
            <div class="ao3x-field">
              <label>System Prompt</label>
              <textarea id="ao3x-summary-sys" rows="3" placeholder="你是专业的文学内容总结助手..."></textarea>
            </div>
            <div class="ao3x-field">
              <label>User 模板 <span class="ao3x-hint">使用 {{content}} 作为占位符</span></label>
              <textarea id="ao3x-summary-user" rows="3" placeholder="请对以下AO3章节内容进行剧情总结...{{content}}"></textarea>
            </div>
            <div class="ao3x-field">
              <label>原文/总结比 <span class="ao3x-hint">用于计算分块，通常总结比原文更简洁</span></label>
              <input id="ao3x-summary-ratio" type="number" step="0.05" min="0.1" max="1" value="0.3"/>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">高级选项</h4>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>并发数</label>
                <input id="ao3x-conc" type="number" min="1" max="8" value="3"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>空闲超时 <span class="ao3x-hint">ms，-1禁用</span></label>
                <input id="ao3x-idle" type="number" placeholder="10000"/>
              </div>
              <div class="ao3x-field">
                <label>硬超时 <span class="ao3x-hint">ms，-1禁用</span></label>
                <input id="ao3x-hard" type="number" placeholder="90000"/>
              </div>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>最大重试</label>
                <input id="ao3x-retry" type="number" min="0" max="3" value="1"/>
              </div>
              <div class="ao3x-field">
                <label>刷新间隔 <span class="ao3x-hint">ms</span></label>
                <input id="ao3x-stream-minframe" type="number" min="0" placeholder="40"/>
              </div>
            </div>
            <div class="ao3x-field">
              <label>译文字体大小 <span class="ao3x-hint">px</span></label>
              <input id="ao3x-font-size" type="number" min="12" max="24" value="16"/>
            </div>
            <div class="ao3x-field">
              <label>下载服务URL</label>
              <input id="ao3x-download-worker" type="text" placeholder=""/>
            </div>
            <div class="ao3x-field">
              <label><input id="ao3x-omit-max-tokens" type="checkbox"/> 请求时不发送 Max Tokens</label>
              <span class="ao3x-hint">仅影响 API 请求，不影响分块、长度估算与重试扩容。</span>
            </div>
            <div class="ao3x-switches">
              <label class="ao3x-switch">
                <input id="ao3x-stream" type="checkbox" checked/>
                <span class="ao3x-switch-slider"></span>
                <span class="ao3x-switch-label">流式传输</span>
              </label>
              <label class="ao3x-switch">
                <input id="ao3x-debug" type="checkbox"/>
                <span class="ao3x-switch-slider"></span>
                <span class="ao3x-switch-label">调试模式</span>
              </label>
              <label class="ao3x-switch">
                <input id="ao3x-chunk-preview" type="checkbox"/>
                <span class="ao3x-switch-slider"></span>
                <span class="ao3x-switch-label">显示分块预览</span>
              </label>
              <label class="ao3x-switch">
                <input id="ao3x-disable-system-prompt" type="checkbox"/>
                <span class="ao3x-switch-slider"></span>
                <span class="ao3x-switch-label">禁用 System Prompt</span>
              </label>
            </div>
            <div class="ao3x-field">
              <label>存储管理</label>
              <div class="ao3x-input-group">
                <button id="ao3x-list-storage" class="ao3x-btn-secondary">查看翻译缓存键</button>
                <button id="ao3x-clear-all-cache" class="ao3x-btn-secondary">清理所有翻译缓存</button>
              </div>
              <span class="ao3x-hint">作用域：本脚本使用的翻译缓存（键前缀 ao3_translator_）。</span>
            </div>
            <div class="ao3x-field">
              <label>缓存备份与恢复</label>
              <div class="ao3x-input-group">
                <button id="ao3x-export-cache-zip" class="ao3x-btn-secondary">💾 导出所有缓存为 JSON</button>
                <button id="ao3x-import-cache-zip" class="ao3x-btn-secondary">📂 从 JSON 导入缓存</button>
              </div>
              <span class="ao3x-hint">导出/导入所有翻译缓存，便于备份和迁移</span>
            </div>
          </div>

          <div class="ao3x-section">
            <h4 class="ao3x-section-title">WebDAV 同步配置</h4>
            <div class="ao3x-field">
              <label>WebDAV 地址</label>
              <input id="ao3x-webdav-url" type="text" placeholder="https://dav.example.com/path"/>
              <span class="ao3x-hint">WebDAV 服务器地址，用于同步缓存</span>
            </div>
            <div class="ao3x-field-group">
              <div class="ao3x-field">
                <label>用户名</label>
                <input id="ao3x-webdav-username" type="text" placeholder="username"/>
              </div>
              <div class="ao3x-field">
                <label>密码</label>
                <input id="ao3x-webdav-password" type="password" placeholder="password" autocomplete="off"/>
              </div>
            </div>
            <div class="ao3x-field">
              <label>测试与操作</label>
              <div class="ao3x-input-group">
                <button id="ao3x-webdav-test" class="ao3x-btn-secondary">测试连接</button>
                <button id="ao3x-webdav-upload" class="ao3x-btn-secondary">上传当前缓存</button>
                <button id="ao3x-webdav-restore" class="ao3x-btn-secondary">从 WebDAV 恢复</button>
              </div>
              <span class="ao3x-hint">上传会自动保存当前页面的翻译缓存到 WebDAV</span>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(mask); document.body.appendChild(panel);
      panel.addEventListener('click', e => e.stopPropagation());
      const closeBtn = $('#ao3x-close-x', panel);
      if (closeBtn) {
        closeBtn.addEventListener('click', UI.closePanel);
      } else {
        d('ui:close-btn-missing');
      }

      const fetchBtn = $('#ao3x-fetch-models', panel);
      const fetchSummaryBtn = $('#ao3x-fetch-summary-models', panel);
      const translateBrowserBox = $('#ao3x-translate-model-browser', panel);
      const summaryBrowserBox = $('#ao3x-summary-model-browser', panel);

      if (fetchBtn && translateBrowserBox) {
        fetchBtn.addEventListener('click', async () => {
          translateBrowserBox.style.display = 'block';
          await ModelBrowser.fetchAndRender(panel, 'translate');
          UI.toast('翻译模型列表已更新');
        });
      }

      if (fetchSummaryBtn && summaryBrowserBox) {
        fetchSummaryBtn.addEventListener('click', async () => {
          summaryBrowserBox.style.display = 'block';
          await ModelBrowser.fetchAndRender(panel, 'summary');
          UI.toast('总结模型列表已更新');
        });
      }

      const translateModelSearch = $('#ao3x-translate-model-q', panel);
      if (translateModelSearch) {
        translateModelSearch.addEventListener('input', () => ModelBrowser.filter(panel, 'translate'));
      }
      const summaryModelSearch = $('#ao3x-summary-model-q', panel);
      if (summaryModelSearch) {
        summaryModelSearch.addEventListener('input', () => ModelBrowser.filter(panel, 'summary'));
      }

      const autosave = () => {
        // 检查翻译模型变更时的同步逻辑
        const translateModel = $('#ao3x-translate-model', panel).value.trim();
        const summaryModel = $('#ao3x-summary-model', panel).value.trim();

        // 如果总结模型为空且翻译模型有值，则同步
        if (!summaryModel && translateModel) {
          $('#ao3x-summary-model', panel).value = translateModel;
        }

        const newSettings = settings.set(collectPanelValues(panel));
        applyFontSize();

        // 同步到 ChunkIndicator
        if (typeof ChunkIndicator !== 'undefined' && ChunkIndicator.settings) {
          ChunkIndicator.settings.showPreview = !!(newSettings.chunkIndicator?.showPreview);
        }

        saveToast();
      };

      // 专门监听翻译模型输入框的变化
      const translateModelInput = $('#ao3x-translate-model', panel);
      if (translateModelInput) {
        translateModelInput.addEventListener('input', debounce(() => {
          const translateModel = $('#ao3x-translate-model', panel)?.value.trim() || '';
          const summaryModel = $('#ao3x-summary-model', panel)?.value.trim() || '';

          // 如果总结模型为空，则自动同步翻译模型的值
          if (!summaryModel && translateModel) {
            const summaryInput = $('#ao3x-summary-model', panel);
            if (summaryInput) summaryInput.value = translateModel;
          }
          autosave();
        }, 300));
      }

      panel.addEventListener('input', debounce(autosave, 300), true);
      panel.addEventListener('change', autosave, true);
      panel.addEventListener('blur', (e) => { if (panel.contains(e.target)) autosave(); }, true);

      // 存储管理：列出与清理（GM 与 localStorage 双覆盖）
      $('#ao3x-list-storage', panel)?.addEventListener('click', () => {
        try {
          const gmKeys = GM_ListKeys().filter(k => typeof k === 'string' && k.startsWith('ao3_translator_'));
          const lsKeys = (function () { try { return Object.keys(localStorage).filter(k => k.startsWith('ao3_translator_')); } catch { return []; } })();
          const allKeys = Array.from(new Set([...(gmKeys || []), ...(lsKeys || [])]));
          if (!allKeys.length) { UI.toast('未发现翻译缓存键'); return; }
          const lines = allKeys.slice(0, 50).join('\n') + (allKeys.length > 50 ? '\n…' : '');
          alert(`翻译缓存键（GM:${gmKeys.length} / LS:${lsKeys.length}）：\n${lines}`);
        } catch (e) { UI.toast('读取存储键失败'); console.warn(e); }
      });

      $('#ao3x-clear-all-cache', panel)?.addEventListener('click', () => {
        const gmKeys = GM_ListKeys().filter(k => typeof k === 'string' && k.startsWith('ao3_translator_'));
        const lsKeys = (function () { try { return Object.keys(localStorage).filter(k => k.startsWith('ao3_translator_')); } catch { return []; } })();
        const total = (gmKeys?.length || 0) + (lsKeys?.length || 0);
        if (!total) { UI.toast('没有可清理的翻译缓存'); return; }
        if (!confirm(`将清理 GM:${gmKeys.length} / LS:${lsKeys.length} 个翻译缓存，是否继续？`)) return;
        let removedGM = 0, removedLS = 0;
        for (const k of gmKeys) { try { GM_Del(k); removedGM++; } catch { } }
        for (const k of lsKeys) { try { localStorage.removeItem(k); removedLS++; } catch { } }
        UI.toast(`清理完成 GM:${removedGM} / LS:${removedLS}`);
      });

      // 导出所有缓存为 ZIP
      $('#ao3x-export-cache-zip', panel)?.addEventListener('click', async () => {
        await CacheManager.downloadCacheAsZip();
      });

      // 从 ZIP 导入缓存
      $('#ao3x-import-cache-zip', panel)?.addEventListener('click', () => {
        CacheManager.showImportDialog();
      });

      // WebDAV 按钮事件
      $('#ao3x-webdav-test', panel)?.addEventListener('click', async () => {
        const url = $('#ao3x-webdav-url', panel).value.trim();
        const username = $('#ao3x-webdav-username', panel).value.trim();
        const password = $('#ao3x-webdav-password', panel).value.trim();

        if (!url || !username || !password) {
          UI.toast('请填写完整的 WebDAV 配置');
          return;
        }

        try {
          UI.toast('正在测试连接...');
          const auth = btoa(`${username}:${password}`);
          const response = await gmFetch(url, {
            method: 'PROPFIND',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Depth': '0'
            }
          });

          if (response.ok || response.status === 207) {
            UI.toast('连接成功！');
          } else if (response.status === 401) {
            UI.toast('认证失败: 用户名或密码错误');
          } else {
            UI.toast(`连接失败: HTTP ${response.status}`);
          }
        } catch (e) {
          console.error('[WebDAV Test] Error:', e);
          UI.toast('连接失败: ' + e.message);
        }
      });

      $('#ao3x-webdav-upload', panel)?.addEventListener('click', async () => {
        await CacheManager.uploadToWebDAV();
      });

      $('#ao3x-webdav-restore', panel)?.addEventListener('click', async () => {
        await CacheManager.restoreFromWebDAV();
      });

      UI._panel = panel; UI._mask = mask; UI.syncPanel();
    },
    openPanel() { UI.syncPanel(); UI._mask.style.display = 'block'; UI._panel.style.display = 'block'; UI.hideFAB(); },
    closePanel() { UI._mask.style.display = 'none'; UI._panel.style.display = 'none'; UI.showFAB(); },
    hideFAB() { const fab = $('.ao3x-fab-wrap'); if (fab) fab.classList.add('hidden'); },
    showFAB() { const fab = $('.ao3x-fab-wrap'); if (fab) fab.classList.remove('hidden'); },
    syncPanel() {
      const s = settings.get();
      $('#ao3x-base').value = s.api.baseUrl; $('#ao3x-path').value = s.api.path; $('#ao3x-key').value = s.api.key;
      // 同步翻译和总结模型设置
      $('#ao3x-translate-model').value = s.translate?.model?.id || s.model?.id || '';
      $('#ao3x-translate-cw').value = s.translate?.model?.contextWindow || s.model?.contextWindow || 16000;
      $('#ao3x-translate-maxt').value = s.translate?.gen?.maxTokens || s.gen?.maxTokens || 7000;
      $('#ao3x-translate-temp').value = s.translate?.gen?.temperature || s.gen?.temperature || 0.7;
      $('#ao3x-translate-reasoning').value = String(s.translate?.reasoningEffort ?? -1);

      $('#ao3x-summary-model').value = s.summary?.model?.id || '';
      $('#ao3x-summary-cw').value = s.summary?.model?.contextWindow || s.model?.contextWindow || 16000;
      $('#ao3x-summary-maxt').value = s.summary?.gen?.maxTokens || s.gen?.maxTokens || 7000;
      $('#ao3x-summary-temp').value = s.summary?.gen?.temperature || s.gen?.temperature || 0.7;
      $('#ao3x-summary-reasoning').value = String(s.summary?.reasoningEffort ?? -1);
      $('#ao3x-omit-max-tokens').checked = !!s.gen?.omitMaxTokensInRequest;

      $('#ao3x-sys').value = s.prompt.system; $('#ao3x-user').value = s.prompt.userTemplate;
      $('#ao3x-stream').checked = !!s.stream.enabled; $('#ao3x-stream-minframe').value = String(s.stream.minFrameMs ?? 40);
      $('#ao3x-debug').checked = !!s.debug; $('#ao3x-conc').value = String(s.concurrency);
      $('#ao3x-disable-system-prompt').checked = !!s.disableSystemPrompt;
      $('#ao3x-idle').value = String(s.watchdog.idleMs); $('#ao3x-hard').value = String(s.watchdog.hardMs); $('#ao3x-retry').value = String(s.watchdog.maxRetry);
      $('#ao3x-ratio').value = String(s.planner?.ratioOutPerIn || 0.7);
      $('#ao3x-font-size').value = String(s.ui?.fontSize || 16);
      $('#ao3x-download-worker').value = s.download?.workerUrl || '';
      // 同步总结设置字段
      $('#ao3x-summary-sys').value = s.summary?.system || '';
      $('#ao3x-summary-user').value = s.summary?.userTemplate || '';
      $('#ao3x-summary-ratio').value = String(s.summary?.ratioTextToSummary ?? 0.3);
      // 同步分块指示器设置
      $('#ao3x-chunk-preview').checked = !!(s.chunkIndicator?.showPreview);
      // 同步 WebDAV 配置
      $('#ao3x-webdav-url').value = s.webdav?.url || '';
      $('#ao3x-webdav-username').value = s.webdav?.username || '';
      $('#ao3x-webdav-password').value = s.webdav?.password || '';
    },
    buildToolbar() {
      const bar = document.createElement('div');
      bar.className = 'ao3x-toolbar';
      bar.innerHTML = `<button data-mode="trans" class="active">仅译文</button><button data-mode="orig">仅原文</button><button data-mode="bi" disabled>双语对照</button><button id="ao3x-clear-cache" data-action="clear-cache">清除翻译缓存</button><button id="ao3x-retry-incomplete" data-action="retry" style="display: none;">重试未完成</button>`;
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'retry') { Controller.retryIncomplete(); return; }
        if (action === 'clear-cache') {
          if (confirm('确定要清除当前页面的翻译缓存吗？')) {
            TransStore.clearCache();
            View.setShowingCache(false);
            UI.updateToolbarState(); // 更新工具栏状态，重新显示双语对照按钮
            UI.toast('翻译缓存已清除');
            // 删除翻译容器
            const renderContainer = document.querySelector('#ao3x-render');
            if (renderContainer) {
              renderContainer.remove();
            }
            // 恢复原始章节内容的显示
            SelectedNodes.forEach(node => {
              node.style.display = '';
            });
            // 切换到原文模式
            View.setMode('orig');
            UI.hideToolbar();
          }
          return;
        }

        [...bar.querySelectorAll('button')].forEach(b => { if (!b.getAttribute('data-action')) b.classList.remove('active', 'highlight'); });
        if (!action && !btn.disabled) { btn.classList.add('active'); View.setMode(btn.getAttribute('data-mode')); }
      });

      document.body.appendChild(bar); UI._toolbar = bar;
    },
    showToolbar() { UI._toolbar.style.display = 'flex'; },
    hideToolbar() { UI._toolbar.style.display = 'none'; },
    updateToolbarState() {
      const retryBtn = $('#ao3x-retry-incomplete');
      const biBtn = $('[data-mode="bi"]', UI._toolbar);
      const clearCacheBtn = $('#ao3x-clear-cache');

      // 检查是否有需要重试的段落（只有真正失败的才显示重试按钮）
      const incompleteIndices = Controller.collectIncompleteIndices();
      let hasFailedBlocks = false;
      if (incompleteIndices.length > 0) {
        // 只有当存在真正失败的块（包含失败消息）时才显示重试按钮
        hasFailedBlocks = incompleteIndices.some(i => {
          const html = TransStore.get(String(i)) || '';
          return /\[该段失败：|\[请求失败：/.test(html);
        });
      }
      if (retryBtn) {
        retryBtn.style.display = hasFailedBlocks ? '' : 'none';
      }

      // 检查是否有缓存，控制清除缓存按钮的显示
      if (clearCacheBtn) {
        const hasCache = TransStore.hasCache();
        clearCacheBtn.style.display = hasCache ? '' : 'none';
      }

      // 检查翻译是否全部完成，高亮双语对照按钮
      if (biBtn) {
        const isAllComplete = TransStore.allDone(RenderState.total || 0) && (RenderState.total || 0) > 0;
        const isShowingCache = View.isShowingCache();

        // 如果正在显示缓存，隐藏双语对照按钮
        if (isShowingCache) {
          biBtn.style.display = 'none';
        } else {
          biBtn.style.display = '';
          // 启用双语对照按钮（除非正在显示缓存）
          biBtn.disabled = false;
          if (isAllComplete) {
            biBtn.classList.add('highlight');
          } else {
            biBtn.classList.remove('highlight');
          }
        }
      }
    },
    setTranslateBusy(isBusy) {
      const btn = UI._btnTranslate;
      if (!btn) return;
      if (isBusy) {
        btn.classList.add('ao3x-btn-busy');
        btn.setAttribute('aria-busy', 'true');
      } else {
        btn.classList.remove('ao3x-btn-busy');
        btn.removeAttribute('aria-busy');
      }
    }
  };
  const saveToast = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => UI.toast('已保存'), 120); }; })();

  // 应用字体大小设置
  function applyFontSize() {
    const s = settings.get();
    const fontSize = s.ui?.fontSize || 16;
    document.documentElement.style.setProperty('--translation-font-size', `${fontSize}px`);
  }

  function GM_AddCSS() {
    GM_addStyle(`
      :root{
        --c-bg:#fafafa; --c-fg:#0b0b0d; --c-card:#ffffff; --c-muted:#6b7280;
        --c-accent:#b30000; --c-accent-weak:#e74a4a;
        --c-border:#e5e5e5; --c-soft:#f7f7f8;
        --radius:12px; --radius-full:999px;
      }

      /* FAB按钮组 */
      .ao3x-fab-wrap{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:999999;display:flex;flex-direction:column;gap:8px;opacity:0.6;transition:opacity .3s;pointer-events:auto}
      .ao3x-fab-wrap:hover{opacity:1}
      .ao3x-fab-wrap.hidden{opacity:0;pointer-events:none}
      .ao3x-btn{background:rgba(255,255,255,.9);color:var(--c-accent);border:1px solid rgba(229,229,229,.8);border-radius:var(--radius-full);padding:10px 14px;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.08);cursor:pointer;transition:all .2s;backdrop-filter:blur(8px);user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation}
      .ao3x-btn:hover{background:rgba(255,255,255,.95);box-shadow:0 4px 12px rgba(179,0,0,.15);transform:translateY(-1px)}
      .ao3x-btn:active{transform:scale(.98)}
      .ao3x-btn-busy{opacity:.7;cursor:wait}

      /* 悬浮按钮组 - 环状布局 */
      .ao3x-floating-menu{
        position:absolute;right:100%;top:50%;
        transform:translate(-8px, -50%);
        pointer-events:none;opacity:0;
        transition:opacity .18s ease-out, transform .18s ease-out;
        display:flex;flex-direction:column;gap:8px;
        background:rgba(255,255,255,.98);
        border:1px solid var(--c-border);
        border-radius:12px;padding:8px;
        box-shadow:0 6px 18px rgba(0,0,0,.12);
        min-width:44px;
      }
      .ao3x-floating-menu.visible{
        opacity:1;pointer-events:all;transform:translate(-12px, -50%);
      }
      .ao3x-floating-btn{
        position:relative;
        /* 与主翻译按钮保持一致尺寸与风格 */
        padding:10px 14px;
        font-size:13px;
        background:white;
        border:1px solid rgba(229,229,229,.9);
        box-shadow:0 1px 3px rgba(0,0,0,.06);
        border-radius:var(--radius-full);
        min-width:auto;min-height:auto;
        display:flex;align-items:center;justify-content:center;
      }
      .ao3x-floating-btn:hover{
        background:#fff;
        box-shadow:0 3px 10px rgba(179,0,0,.16);
        transform:none;
      }
      @keyframes floatIn{
        from{
          opacity:0;
          transform:translateX(15px) scale(0.9);
        }
        to{
          opacity:1;
          transform:translateX(0) scale(1);
        }
      }

      /* 面板遮罩 */
      .ao3x-panel-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);backdrop-filter:blur(4px);z-index:99997;display:none}

      /* 设置面板 - 移动端优化 */
      .ao3x-panel{
        position:fixed;bottom:0;left:0;right:0;
        max-height:90vh;overflow:hidden;
        border-radius:var(--radius) var(--radius) 0 0;
        background:var(--c-card);color:var(--c-fg);z-index:99998;
        display:none;animation:slideUp .3s ease;
        box-shadow:0 -4px 20px rgba(0,0,0,.15);
      }
      @media (min-width:768px){
        .ao3x-panel{
          left:50%;bottom:auto;top:50%;
          transform:translate(-50%,-50%);
          width:min(90vw,720px);max-height:85vh;
          border-radius:var(--radius);
        }
      }
      @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}

      /* 面板头部 */
      .ao3x-panel-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:16px 20px;border-bottom:1px solid var(--c-border);
        position:sticky;top:0;background:var(--c-card);z-index:10;
      }
      .ao3x-panel-header h3{margin:0;font-size:16px;font-weight:600;color:var(--c-accent)}
      .ao3x-panel-close{
        width:28px;height:28px;border-radius:var(--radius-full);
        background:var(--c-soft);border:none;color:var(--c-muted);
        font-size:20px;line-height:1;cursor:pointer;transition:all .2s
      }
      .ao3x-panel-close:hover{background:var(--c-accent);color:white}

      /* 面板主体 */
      .ao3x-panel-body{
        padding:16px;overflow-y:auto;max-height:calc(90vh - 80px);
        -webkit-overflow-scrolling:touch;box-sizing:border-box;
      }
      @media (min-width:768px){
        .ao3x-panel-body{padding:20px;max-height:calc(85vh - 140px)}
      }

      /* 面板底部 - 移动端隐藏 */
      .ao3x-panel-footer{
        display:none;
      }
      @media (min-width:768px){
        .ao3x-panel-footer{
          display:flex;gap:12px;padding:16px 20px;
          border-top:1px solid var(--c-border);
          position:sticky;bottom:0;background:var(--c-card);
        }
      }

      /* 分组样式 */
      .ao3x-section{margin-bottom:24px}
      .ao3x-section:last-child{margin-bottom:0}
      .ao3x-section-title{
        font-size:13px;font-weight:600;color:var(--c-muted);
        text-transform:uppercase;letter-spacing:.5px;
        margin:0 0 12px;padding-bottom:8px;
        border-bottom:1px solid var(--c-border);
      }

      /* 表单字段 */
      .ao3x-field{margin-bottom:16px}
      .ao3x-field:last-child{margin-bottom:0}
      .ao3x-field label{
        display:block;font-size:13px;color:var(--c-fg);
        margin-bottom:6px;font-weight:500;
      }
      .ao3x-field input[type="text"],
      .ao3x-field input[type="number"],
      .ao3x-field input[type="password"],
      .ao3x-field select,
      .ao3x-field textarea{
        width:100%;padding:10px 12px;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-soft);color:var(--c-fg);
        font-size:14px;transition:all .2s;box-sizing:border-box;
      }
      .ao3x-field input:focus,
      .ao3x-field select:focus,
      .ao3x-field textarea:focus{
        outline:none;border-color:var(--c-accent);
        background:white;box-shadow:0 0 0 3px rgba(179,0,0,.1);
      }
      .ao3x-field textarea{min-height:80px;resize:vertical;font-family:inherit}

      /* 提示文字 */
      .ao3x-hint{
        font-size:11px;color:var(--c-muted);margin-top:4px;
        display:inline-block;
      }
      .ao3x-badge{
        display:inline-block;padding:2px 6px;
        background:var(--c-soft);border-radius:6px;
        font-size:10px;color:var(--c-muted);
      }

      /* 字段组 */
      .ao3x-field-group{
        display:grid;grid-template-columns:1fr 1fr;gap:12px;
        margin-bottom:16px;
      }
      @media (max-width:480px){
        .ao3x-field-group{grid-template-columns:1fr}
      }

      /* 输入组 */
      .ao3x-input-group{
        display:flex;gap:8px;align-items:stretch;
      }
      .ao3x-input-group input{flex:1}

      /* 按钮样式统一 */
      .ao3x-btn-primary,
      .ao3x-btn-ghost,
      .ao3x-btn-secondary{
        padding:10px 20px;border-radius:var(--radius-full);
        font-size:14px;font-weight:500;cursor:pointer;
        transition:all .2s;border:1px solid;
      }
      .ao3x-btn-primary{
        background:var(--c-accent);color:white;
        border-color:var(--c-accent);
      }
      .ao3x-btn-primary:hover{
        background:#9a0000;transform:translateY(-1px);
        box-shadow:0 4px 12px rgba(179,0,0,.25);
      }
      .ao3x-btn-ghost{
        background:transparent;color:var(--c-fg);
        border-color:var(--c-border);
      }
      .ao3x-btn-ghost:hover{
        background:var(--c-soft);
      }
      .ao3x-btn-secondary{
        background:var(--c-soft);color:var(--c-accent);
        border-color:var(--c-border);padding:8px 14px;
        font-size:13px;
      }
      .ao3x-btn-secondary:hover{
        background:var(--c-accent);color:white;
      }

      /* 开关组件 */
      .ao3x-switches{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
      .ao3x-switch{
        display:flex;align-items:center;cursor:pointer;
        position:relative;padding-left:48px;min-height:24px;
      }
      .ao3x-switch input{
        position:absolute;opacity:0;width:0;height:0;
      }
      .ao3x-switch-slider{
        position:absolute;left:0;top:0;
        width:40px;height:24px;border-radius:12px;
        background:var(--c-border);transition:all .3s;
      }
      .ao3x-switch-slider::after{
        content:'';position:absolute;left:2px;top:2px;
        width:20px;height:20px;border-radius:10px;
        background:white;transition:all .3s;
        box-shadow:0 2px 4px rgba(0,0,0,.2);
      }
      .ao3x-switch input:checked + .ao3x-switch-slider{
        background:var(--c-accent);
      }
      .ao3x-switch input:checked + .ao3x-switch-slider::after{
        transform:translateX(16px);
      }
      .ao3x-switch-label{
        font-size:14px;color:var(--c-fg);user-select:none;
      }

      /* 模型浏览器 */
      .ao3x-model-browser{
        margin-top:16px;margin-bottom:16px;padding:16px;border:1px solid var(--c-border);
        border-radius:var(--radius);background:var(--c-soft);
        box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      .ao3x-model-search{
        width:100%;padding:10px 12px;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-card);color:var(--c-fg);
        font-size:14px;transition:all .2s;box-sizing:border-box;
      }
      .ao3x-model-search:focus{
        outline:none;border-color:var(--c-accent);
        background:white;box-shadow:0 0 0 3px rgba(179,0,0,.1);
      }
      .ao3x-model-list{
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:var(--c-card);max-height:240px;overflow-y:auto;
        margin-top:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      .ao3x-model-list:empty{
        display:flex;align-items:center;justify-content:center;
        min-height:60px;color:var(--c-muted);font-size:13px;
      }
      .ao3x-model-list:empty::after{
        content:'暂无可用模型，请点击"获取列表"按钮';
      }
      .ao3x-model-item{
        display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;font-size:14px;cursor:pointer;
        border-bottom:1px solid var(--c-border);transition:all .2s;
        color:var(--c-fg);
      }
      .ao3x-model-item:last-child{border-bottom:none}
      .ao3x-model-item:hover{
        background:var(--c-soft);color:var(--c-accent);
        transform:translateX(2px);
      }
      .ao3x-model-item:active{
        transform:translateX(1px);background:var(--c-accent);
        color:white;
      }
      .ao3x-model-item .model-name{
        font-weight:500;flex:1;
      }
      .ao3x-model-item .model-info{
        font-size:12px;color:var(--c-muted);
        margin-left:8px;
      }
      @media (max-width:480px){
        .ao3x-model-browser{margin-top:12px;padding:12px}
        .ao3x-model-list{max-height:200px}
        .ao3x-model-item{padding:10px 12px;font-size:13px}
        .ao3x-model-item .model-info{display:none}
      }

      /* 工具栏 */
      .ao3x-toolbar{
        position:fixed;left:50%;top:12px;transform:translateX(-50%);
        z-index:99996;background:white;border-radius:var(--radius-full);
        padding:4px;display:none;gap:4px;
        border:1px solid var(--c-border);
        box-shadow:0 2px 12px rgba(0,0,0,.1);
      }
      .ao3x-toolbar button{
        background:transparent;color:var(--c-fg);border:none;
        padding:8px 14px;border-radius:var(--radius-full);
        font-size:13px;font-weight:500;cursor:pointer;
        transition:all .2s;
      }
      .ao3x-toolbar button:hover{background:var(--c-soft)}
      .ao3x-toolbar button.active{
        background:var(--c-accent);color:white;
      }
      .ao3x-toolbar button.highlight{
        animation:highlight-pulse 2s infinite;
        box-shadow:0 0 0 2px var(--c-accent);
      }
      .ao3x-toolbar button:disabled{
        opacity:0.5;
        cursor:not-allowed;
        color:var(--c-fg-weak);
      }
      .ao3x-toolbar button:disabled:hover{
        background:transparent;
      }
      @keyframes highlight-pulse{
        0%,100%{box-shadow:0 0 0 2px var(--c-accent)}
        50%{box-shadow:0 0 0 4px var(--c-accent-weak)}
      }

      /* Toast提示 */
      .ao3x-toast{
        position:fixed;right:12px;top:12px;
        display:flex;flex-direction:column;gap:8px;z-index:99999;
      }
      .ao3x-toast .item{
        background:var(--c-accent);color:white;
        padding:10px 16px;border-radius:var(--radius);
        font-size:13px;font-weight:500;
        box-shadow:0 4px 12px rgba(179,0,0,.25);
        animation:slideInRight .3s ease;
      }
      @keyframes slideInRight{from{transform:translateX(100%);opacity:0}}

      /* 内容区域 */
      .ao3x-render{margin:0 auto;max-width:900px;padding:0 16px}
      .ao3x-translation{
        line-height:1.7;min-height:1em;
        font-size:var(--translation-font-size,16px);
        min-height:60px;
        /* 渲染优化 */
        contain:layout style;
        content-visibility:auto;
        will-change:contents;
      }
      .ao3x-block{
        margin-bottom:1em;
        font-size:var(--translation-font-size,16px);
        line-height:1.7;
        /* 防止闪烁的关键设置 */
        contain:layout;
        transform:translateZ(0);
        backface-visibility:hidden;
      }
      .ao3x-muted{opacity:.5;font-style:italic}
      .ao3x-small{font-size:12px;color:var(--c-muted)}

      /* 引用样式 */
      .ao3x-translation blockquote{
        margin:1em 0;
        padding-left:1em;
        border-left:4px solid var(--c-border);
        font-style:italic;
        color:var(--c-fg);
        background:var(--c-soft);
        border-radius:0 var(--radius) var(--radius) 0;
      }

      /* 图片和媒体优化 - 防止加载时布局抖动 */
      .ao3x-translation img,
      .ao3x-translation video,
      .ao3x-translation iframe{
        max-width:100%;
        height:auto;
        display:block;
        /* 为图片预留空间，防止加载时抖动 */
        min-height:100px;
        background:var(--c-soft);
        /* GPU加速，减少闪烁 */
        transform:translateZ(0);
        backface-visibility:hidden;
      }
      .ao3x-translation img[src]{
        /* 图片加载后移除最小高度限制 */
        min-height:0;
      }

      /* 双语对照 */
      .ao3x-pair{
        padding:12px 16px;margin:12px 0;
        border:1px solid var(--c-border);border-radius:var(--radius);
        background:white;box-shadow:0 1px 3px rgba(0,0,0,.05);
        min-height:80px;transition:all 0.2s ease;
      }
      .ao3x-pair .orig{color:#374151;line-height:1.6}
      .ao3x-pair .orig blockquote{
        margin:0.5em 0;
        padding-left:0.8em;
        border-left:3px solid var(--c-border);
        font-style:italic;
        background:var(--c-soft);
        border-radius:0 var(--radius) var(--radius) 0;
      }
      .ao3x-pair .trans{
        color:#111;line-height:1.7;margin-top:12px;padding-top:12px;
        border-top:1px dashed var(--c-border);
        font-size:var(--translation-font-size,16px);
      }
      .ao3x-pair .trans blockquote{
        margin:0.5em 0;
        padding-left:0.8em;
        border-left:3px solid var(--c-accent);
        font-style:italic;
        background:rgba(179,0,0,0.05);
        border-radius:0 var(--radius) var(--radius) 0;
      }

      /* 计划面板 */
      .ao3x-plan{
        border:1px solid var(--c-border);background:white;
        border-radius:var(--radius);margin:16px 0;
        overflow:hidden;
      }
      .ao3x-plan-header{
        display:flex;align-items:center;justify-content:space-between;
        padding:12px 16px;background:var(--c-soft);
        border-bottom:1px solid var(--c-border);
        position:sticky;top:0;z-index:10;
      }
      .ao3x-plan h4{
        margin:0;font-size:14px;font-weight:600;
        color:var(--c-accent);flex:1;
      }
      .ao3x-plan-toggle{
        background:none;border:none;color:var(--c-accent);
        cursor:pointer;font-size:16px;padding:4px;margin-left:8px;
        width:24px;height:24px;display:flex;align-items:center;
        justify-content:center;border-radius:4px;
        transition:all .2s;font-weight:bold;
        line-height:1;user-select:none;
      }
      .ao3x-plan-toggle:hover{
        background:rgba(179,0,0,0.1);
      }
      .ao3x-plan-toggle:active{
        transform:scale(0.95);
      }
      .ao3x-plan-body{
        max-height:400px;overflow-y:auto;
        transition:max-height .3s ease;
      }
      .ao3x-plan-body.collapsed{
        max-height:0;overflow:hidden;
      }
      .ao3x-plan-controls{
        padding:12px 16px;background:white;
        border-bottom:1px solid var(--c-border);
        position:sticky;top:0;z-index:9;
      }
      .ao3x-plan-rows{
        padding:0 16px 12px;
      }
      .ao3x-plan .row{
        font-size:12px;color:#4b5563;padding:8px 0;
        border-top:1px solid var(--c-border);
        display:flex;align-items:center;gap:8px;
      }
      .ao3x-plan .row:first-of-type{border-top:none}

      /* KV显示 */
      .ao3x-kv{
        display:flex;gap:8px;flex-wrap:wrap;
        font-size:11px;margin-top:12px;
        overflow:hidden;
        word-wrap:break-word;
      }
      .ao3x-kv span{
        background:var(--c-soft);padding:4px 8px;
        border-radius:6px;color:var(--c-muted);
        word-break:break-word;
        max-width:100%;
      }

      /* 块选择控制 */
      .ao3x-block-controls{
        display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;
      }
      .ao3x-btn-mini{
        background:var(--c-soft);color:var(--c-fg);border:1px solid var(--c-border);
        border-radius:6px;padding:4px 8px;font-size:11px;font-weight:500;
        cursor:pointer;transition:all .2s;
      }
      .ao3x-btn-mini:hover{
        background:var(--c-accent);color:white;transform:translateY(-1px);
      }
      .ao3x-btn-primary-mini{
        background:var(--c-accent);color:white;border-color:var(--c-accent);
      }
      .ao3x-btn-primary-mini:hover{
        background:#9a0000;
      }
      /* 翻译块按钮 */
      .ao3x-translate-block-btn{
        margin-left:auto;background:var(--c-accent);color:white;
        border-color:var(--c-accent);
      }
      .ao3x-translate-block-btn:hover{
        background:#9a0000;
      }
      .ao3x-translate-block-btn.ao3x-btn-done{
        background:var(--c-soft);color:var(--c-muted);
        border-color:var(--c-border);cursor:default;
      }
      .ao3x-translate-block-btn.ao3x-btn-done:hover{
        background:var(--c-soft);color:var(--c-muted);
        transform:none;
      }

      /* 块复选框 */
      .ao3x-block-checkbox{
        display:inline-flex;align-items:center;cursor:pointer;
        margin-right:8px;position:relative;
      }
      .ao3x-block-checkbox input{
        position:absolute;opacity:0;cursor:pointer;height:0;width:0;
      }
      .ao3x-block-checkbox .checkmark{
        width:16px;height:16px;background:var(--c-soft);
        border:1px solid var(--c-border);border-radius:4px;
        position:relative;transition:all .2s;
      }
      .ao3x-block-checkbox:hover input:not(:checked) ~ .checkmark{
        border-color:var(--c-accent);
      }
      .ao3x-block-checkbox input:checked ~ .checkmark{
        background:var(--c-accent);border-color:var(--c-accent);
      }
      .ao3x-block-checkbox .checkmark::after{
        content:'';position:absolute;display:none;
        left:5px;top:2px;width:3px;height:6px;
        border:solid white;border-width:0 2px 2px 0;
        transform:rotate(45deg);
      }
      .ao3x-block-checkbox input:checked ~ .checkmark::after{
        display:block;
      }

      /* 总结视图样式 */
      .ao3x-summary-container{
        margin:20px 0;padding:0;
        border-top:2px solid var(--c-accent);
        border-bottom:2px solid var(--c-accent);
        background:rgba(179,0,0,0.02);
        border-radius:var(--radius);
      }
      .ao3x-summary-block{
        margin-bottom:20px;border:1px solid var(--c-border);
        border-radius:var(--radius);background:white;
        box-shadow:0 1px 3px rgba(0,0,0,.05);
      }
      /* 当内容直接放在总结块中（未使用 .ao3x-summary-pair 包裹）时，提供基础内边距 */
      .ao3x-summary-block > .ao3x-summary-content{
        padding:16px;
      }
      .ao3x-summary-pair{
        padding:16px;
      }
      .ao3x-summary-header{
        font-weight:600;font-size:14px;color:var(--c-accent);
        margin-bottom:8px;padding-bottom:6px;
        border-bottom:1px solid var(--c-border);
      }
      .ao3x-summary-preview{
        font-size:12px;color:var(--c-muted);line-height:1.4;
        margin-bottom:12px;padding:8px;background:var(--c-soft);
        border-radius:6px;border-left:3px solid var(--c-border);
      }
      .ao3x-summary-content{
        color:var(--c-fg);line-height:1.6;font-size:15px;
        min-height:40px;transition:min-height 0.2s ease;
      }
      .ao3x-summary-content blockquote{
        margin:0.8em 0;padding-left:1em;
        border-left:3px solid var(--c-accent);
        font-style:italic;background:rgba(179,0,0,0.05);
        border-radius:0 var(--radius) var(--radius) 0;
      }

      .ao3x-plan .row b{
        flex-shrink:0;
      }
      .ao3x-plan .row .ao3x-jump-btn{
        flex-shrink:0;
      }
      .ao3x-plan .row .ao3x-small{
        color:var(--c-muted);
      }

      .ao3x-block-highlight{
        animation:ao3x-block-pulse 1.2s ease;
        box-shadow:0 0 0 3px rgba(179,0,0,0.25);
      }
      @keyframes ao3x-block-pulse{
        0%{box-shadow:0 0 0 3px rgba(179,0,0,0.45);}
        100%{box-shadow:0 0 0 0 rgba(179,0,0,0);}
      }

      /* 分块指示弹窗 */
      .ao3x-chunk-popup{
        position:fixed;
        top:50%;
        left:50%;
        transform:translate(-50%, -50%);
        z-index:999999;
        background:rgba(239, 68, 68, 0.9);
        border-radius:16px;
        padding:24px 32px;
        box-shadow:0 8px 32px rgba(0, 0, 0, 0.3);
        animation:popupFadeIn 0.2s ease-out;
        user-select:none;
        -webkit-user-select:none;
        max-width:80vw;
        pointer-events:none;
      }
      .ao3x-chunk-popup-number{
        color:white;
        font-size:48px;
        font-weight:700;
        line-height:1;
        text-align:center;
        margin:0;
        font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .ao3x-chunk-popup-preview{
        color:rgba(255, 255, 255, 0.9);
        font-size:13px;
        line-height:1.5;
        text-align:left;
        margin:12px 0 0 0;
      }
      .ao3x-chunk-popup-preview div{
        margin:4px 0;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      @keyframes popupFadeIn{
        from{
          opacity:0;
          transform:translate(-50%, -50%) scale(0.9);
        }
        to{
          opacity:1;
          transform:translate(-50%, -50%) scale(1);
        }
      }
      .ao3x-chunk-popup.hiding{
        animation:popupFadeOut 0.2s ease-out forwards;
      }
      @keyframes popupFadeOut{
        from{
          opacity:1;
          transform:translate(-50%, -50%) scale(1);
        }
        to{
          opacity:0;
          transform:translate(-50%, -50%) scale(0.9);
        }
      }
      @media (max-width:768px){
        .ao3x-chunk-popup{
          padding:20px 24px;
          max-width:90vw;
        }
        .ao3x-chunk-popup-number{
          font-size:36px;
        }
        .ao3x-chunk-popup-preview{
          font-size:12px;
        }
      }

      /* 章节选择对话框 */
      .ao3x-chapter-dialog{
        position:fixed;
        inset:0;
        background:rgba(0,0,0,.4);
        backdrop-filter:blur(4px);
        z-index:99999;
        display:flex;
        align-items:center;
        justify-content:center;
        animation:fadeIn .3s ease;
      }
      .ao3x-chapter-dialog-content{
        background:var(--c-card);
        border-radius:var(--radius);
        width:min(90vw, 500px);
        max-height:80vh;
        display:flex;
        flex-direction:column;
        box-shadow:0 8px 32px rgba(0,0,0,.2);
      }
      .ao3x-chapter-dialog-header{
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:16px 20px;
        border-bottom:1px solid var(--c-border);
      }
      .ao3x-chapter-dialog-header h3{
        margin:0;
        font-size:16px;
        font-weight:600;
        color:var(--c-accent);
      }
      .ao3x-chapter-dialog-close{
        width:28px;
        height:28px;
        border-radius:var(--radius-full);
        background:var(--c-soft);
        border:none;
        color:var(--c-muted);
        font-size:20px;
        line-height:1;
        cursor:pointer;
        transition:all .2s;
      }
      .ao3x-chapter-dialog-close:hover{
        background:var(--c-accent);
        color:white;
      }
      .ao3x-chapter-dialog-body{
        padding:16px 20px;
        overflow-y:auto;
        flex:1;
      }
      .ao3x-chapter-controls{
        display:flex;
        gap:8px;
        margin-bottom:12px;
      }
      .ao3x-chapter-list{
        display:flex;
        flex-direction:column;
        gap:8px;
      }
      .ao3x-chapter-item{
        display:flex;
        align-items:center;
        padding:10px 12px;
        background:var(--c-soft);
        border-radius:var(--radius);
        cursor:pointer;
        transition:all .2s;
      }
      .ao3x-chapter-item:hover{
        background:rgba(179,0,0,0.05);
      }
      .ao3x-chapter-item input[type="checkbox"]{
        margin-right:10px;
        cursor:pointer;
      }
      .ao3x-chapter-dialog-footer{
        display:flex;
        gap:12px;
        padding:16px 20px;
        border-top:1px solid var(--c-border);
        justify-content:flex-end;
      }
      @keyframes fadeIn{
        from{
          opacity:0;
        }
        to{
          opacity:1;
        }
      }

    `);
  }
  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
  function normalizeReasoningEffortValue(val) {
    if (val == null) return null;
    if (typeof val === 'number') {
      return val === -1 ? null : val;
    }
    const str = String(val).trim();
    if (!str || str === '-1') return null;
    return str;
  }
  function applyReasoningEffort(payload, effortValue) {
    if (!payload || typeof payload !== 'object') return payload;
    const effort = normalizeReasoningEffortValue(effortValue);
    if (effort == null) return payload;
    payload.reasoning_effort = effort;
    if (effort === 'none') {
      payload.reasoning = { effort, enabled: false };
      payload.thinking = { type: 'disabled' };
      payload.chat_template_kwargs = { thinking: false };
      return payload;
    }
    payload.reasoning = { effort };
    return payload;
  }
  function applyMaxTokens(payload, maxTokens, omitMaxTokensInRequest) {
    if (!payload || typeof payload !== 'object') return payload;
    if (omitMaxTokensInRequest) return payload;
    const parsedMaxTokens = Number(maxTokens);
    if (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens <= 0 || !Number.isInteger(parsedMaxTokens)) return payload;
    payload.max_tokens = parsedMaxTokens;
    return payload;
  }

  // 构建 messages 数组，根据设置决定是否包含 system prompt
  function buildMessages(systemPrompt, userContent, disableSystemPrompt) {
    const messages = [];
    if (!disableSystemPrompt && systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  function collectPanelValues(panel) {
    const cur = settings.get();

    // 收集翻译模型配置
    const translateModel = $('#ao3x-translate-model', panel).value.trim();
    const summaryModel = $('#ao3x-summary-model', panel).value.trim();
    const readReasoningSelect = (id) => {
      const el = $(id, panel);
      if (!el) return -1;
      const raw = `${el.value ?? ''}`.trim();
      if (!raw || raw === '-1') return -1;
      return raw;
    };
    const translateReasoning = readReasoningSelect('#ao3x-translate-reasoning');
    const summaryReasoning = readReasoningSelect('#ao3x-summary-reasoning');

    return {
      api: { baseUrl: $('#ao3x-base', panel).value.trim(), path: $('#ao3x-path', panel).value.trim(), key: $('#ao3x-key', panel).value.trim() },
      // 保持向后兼容的model字段
      model: {
        id: translateModel || cur.model?.id || '',
        contextWindow: parseInt($('#ao3x-translate-cw', panel).value, 10) || cur.model?.contextWindow || 16000
      },
      gen: {
        maxTokens: parseInt($('#ao3x-translate-maxt', panel).value, 10) || cur.gen?.maxTokens || 7000,
        temperature: parseFloat($('#ao3x-translate-temp', panel).value) || cur.gen?.temperature || 0.7,
        omitMaxTokensInRequest: $('#ao3x-omit-max-tokens', panel).checked
      },
      translate: {
        model: {
          id: translateModel,
          contextWindow: parseInt($('#ao3x-translate-cw', panel).value, 10) || cur.model?.contextWindow || 16000
        },
        gen: {
          maxTokens: parseInt($('#ao3x-translate-maxt', panel).value, 10) || cur.gen?.maxTokens || 7000,
          temperature: parseFloat($('#ao3x-translate-temp', panel).value) || cur.gen?.temperature || 0.7
        },
        reasoningEffort: translateReasoning
      },
      summary: {
        model: {
          id: summaryModel,
          contextWindow: parseInt($('#ao3x-summary-cw', panel).value, 10) || cur.model?.contextWindow || 16000
        },
        gen: {
          maxTokens: parseInt($('#ao3x-summary-maxt', panel).value, 10) || cur.gen?.maxTokens || 7000,
          temperature: parseFloat($('#ao3x-summary-temp', panel).value) || cur.gen?.temperature || 0.7
        },
        reasoningEffort: summaryReasoning,
        system: $('#ao3x-summary-sys', panel).value,
        userTemplate: $('#ao3x-summary-user', panel).value,
        ratioTextToSummary: Math.max(0.1, Math.min(1, parseFloat($('#ao3x-summary-ratio', panel).value) || cur.summary?.ratioTextToSummary || 0.3))
      },
      prompt: { system: $('#ao3x-sys', panel).value, userTemplate: $('#ao3x-user', panel).value },
      stream: { enabled: $('#ao3x-stream', panel).checked, minFrameMs: Math.max(0, parseInt($('#ao3x-stream-minframe', panel).value || String(cur.stream.minFrameMs || 40), 10)) },
      concurrency: Math.max(1, Math.min(8, parseInt($('#ao3x-conc', panel).value, 10) || cur.concurrency)),
      debug: $('#ao3x-debug', panel).checked,
      disableSystemPrompt: $('#ao3x-disable-system-prompt', panel).checked,
      planner: {
        ...cur.planner,
        ratioOutPerIn: Math.max(0.3, parseFloat($('#ao3x-ratio', panel).value || cur.planner?.ratioOutPerIn || 0.7))
      },
      watchdog: {
        idleMs: (function () { const v = parseInt($('#ao3x-idle', panel).value || cur.watchdog.idleMs, 10); return v === -1 ? -1 : Math.max(5000, v); })(),
        hardMs: (function () { const v = parseInt($('#ao3x-hard', panel).value || cur.watchdog.hardMs, 10); return v === -1 ? -1 : Math.max(10000, v); })(),
        maxRetry: Math.max(0, Math.min(3, parseInt($('#ao3x-retry', panel).value || cur.watchdog.maxRetry, 10)))
      },
      ui: {
        fontSize: Math.max(12, Math.min(24, parseInt($('#ao3x-font-size', panel).value || cur.ui?.fontSize || 16, 10)))
      },
      download: {
        workerUrl: ($('#ao3x-download-worker', panel).value || cur.download?.workerUrl || '').trim()
      },
      chunkIndicator: {
        showPreview: $('#ao3x-chunk-preview', panel).checked
      },
      webdav: {
        url: ($('#ao3x-webdav-url', panel).value || cur.webdav?.url || '').trim(),
        username: ($('#ao3x-webdav-username', panel).value || cur.webdav?.username || '').trim(),
        password: ($('#ao3x-webdav-password', panel).value || cur.webdav?.password || '').trim()
      }
    };
  }

  /* ================= Render Container & Plan ================= */
  let renderContainer = null;
  function ensureRenderContainer() {
    if (renderContainer) return renderContainer;
    const c = document.createElement('div'); c.id = 'ao3x-render'; c.className = 'ao3x-render';
    const first = SelectedNodes && SelectedNodes[0];
    if (first && first.parentNode) first.parentNode.insertBefore(c, first);
    else (getHostElement() || document.body).appendChild(c);
    renderContainer = c; return c;
  }
  function renderPlanSummary(plan) {
    const c = ensureRenderContainer();
    let box = $('#ao3x-plan', c);
    if (!box) { box = document.createElement('div'); box.id = 'ao3x-plan'; box.className = 'ao3x-plan'; c.appendChild(box); }
    const rows = plan.map((p, i) => {
      const estIn = p.inTok != null ? p.inTok : 0;
      return `<div class="row"><label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${i}"><span class="checkmark"></span></label><button class="ao3x-btn-mini ao3x-jump-btn" data-block-index="${i}" title="跳转到块 #${i}">📍</button><b>块 #${i}</b><span class="ao3x-small">~${estIn} tokens</span></div>`;
    }).join('');
    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-retry-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">重试选中</button>
      </div>
    `;

    // 保存当前折叠状态
    const oldBody = box.querySelector('.ao3x-plan-body');
    const wasCollapsed = oldBody && oldBody.classList.contains('collapsed');

    box.innerHTML = `
      <div class="ao3x-plan-header">
        <h4>翻译计划：共 ${plan.length} 块</h4>
        <button class="ao3x-plan-toggle" type="button" title="折叠/展开">${wasCollapsed ? '▸' : '▾'}</button>
      </div>
      <div class="ao3x-plan-body${wasCollapsed ? ' collapsed' : ''}">
        <div class="ao3x-plan-controls">${controls}</div>
        <div class="ao3x-plan-rows">${rows}</div>
        <div class="ao3x-kv" id="ao3x-kv" style="padding:0 16px 12px;"></div>
      </div>
    `;

    // 使用事件委托绑定折叠按钮事件，避免重复绑定
    box.removeEventListener('click', togglePlanHandler);
    box.addEventListener('click', togglePlanHandler);

    // 绑定控制按钮事件
    bindBlockControlEvents(box);
  }

  // 折叠按钮处理函数（使用事件委托）
  function togglePlanHandler(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('.ao3x-plan-toggle');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const box = e.currentTarget;
    const body = box.querySelector('.ao3x-plan-body');

    if (body && btn) {
      const isCollapsed = body.classList.toggle('collapsed');
      // 用 replaceChildren 避免残留文本节点跑到别处（出现“↓”的根源之一）
      btn.replaceChildren(document.createTextNode(isCollapsed ? '▸' : '▾'));
      console.log('[togglePlanHandler] 折叠状态:', isCollapsed, '按钮文本:', btn.textContent);
    }

    // 兜底清理：移除 KV 后面偶发出现的“↓/▾/▸”文本节点（不应出现在统计文本下方）
    cleanupPlanStrayGlyphText(box);
  }
  const _ao3xStrayGlyphRe = /^[▾▸↓]+$/;
  function cleanupPlanStrayGlyphText(box) {
    if (!box || !(box instanceof Element)) return;
    const kvs = box.querySelectorAll('.ao3x-kv');
    kvs.forEach(kv => {
      let n = kv.nextSibling;
      while (n && n.nodeType === Node.TEXT_NODE) {
        const trimmed = (n.textContent || '').trim();
        const next = n.nextSibling;
        if (trimmed && _ao3xStrayGlyphRe.test(trimmed)) n.remove();
        n = next;
      }
    });
  }
  function updateKV(kv, kvId = 'ao3x-kv') {
    // 直接使用 document.querySelector，确保可靠性
    const elem = document.querySelector(`#${kvId}`);
    if (!elem) {
      console.error(`[updateKV] 找不到容器 #${kvId}`, 'kv数据:', kv);
      // 尝试查找是否有重复的元素
      const allElems = document.querySelectorAll(`#${kvId}`);
      if (allElems.length > 1) {
        console.error(`[updateKV] 发现${allElems.length}个重复的 #${kvId} 元素！`);
      }
      return;
    }

    // 清理 KV 后面偶发出现的“↓/▾/▸”文本节点（通常来自某些浏览器/脚本的怪异DOM插入）
    cleanupPlanStrayGlyphText(elem.parentElement);

    // 修复变量名冲突，使用更清晰的命名
    const html = Object.entries(kv).map(([key, val]) =>
      `<span>${escapeHTML(key)}: ${escapeHTML(String(val))}</span>`
    ).join('');

    // 清空后再设置，确保没有残留内容
    elem.innerHTML = '';
    elem.innerHTML = html;

    // 再次兜底清理
    cleanupPlanStrayGlyphText(elem.parentElement);

    console.log(`[updateKV] 更新成功 #${kvId}:`, kv);
  }

  function scrollToChunkStart(chunkIndex) {
    const idx = Number(chunkIndex);
    if (!Number.isFinite(idx)) return;

    // 使用与 ChunkIndicator 相同的查找方式：直接在整个文档中查找块元素
    // 这样即使容器结构变化也能正常工作
    const allBlocks = document.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)');
    let block = null;

    // 遍历所有块，找到匹配的 data-index
    for (const b of allBlocks) {
      if (b.getAttribute('data-index') === String(idx)) {
        block = b;
        break;
      }
    }

    if (!block) {
      const indices = Array.from(allBlocks).map(b => b.getAttribute('data-index')).filter(Boolean);
      d('scrollToChunkStart:block-not-found', {
        targetIdx: idx,
        availableIndices: indices,
        totalBlocks: allBlocks.length
      });
      UI.toast(`未找到块 #${idx}（共 ${allBlocks.length} 个块）`);
      return;
    }

    const anchor = block.querySelector('.ao3x-anchor') || block;
    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    block.classList.add('ao3x-block-highlight');
    setTimeout(() => block.classList.remove('ao3x-block-highlight'), 1200);
  }

  /* ================= Token-aware Packing (precise) ================= */
  async function packIntoChunks(htmlList, budgetTokens) {
    const s = settings.get();
    const plan = []; let cur = []; let curTok = 0;

    async function tokOf(html) {
      const t = stripHtmlToText(html);
      return await TKT.countTextTokens(t, s.model.id);
    }
    async function flush() {
      if (cur.length) {
        const html = cur.join('\n');
        const text = stripHtmlToText(html);
        const inTok = await TKT.countTextTokens(text, s.model.id);
        plan.push({ html, text, inTok });
        cur = []; curTok = 0;
      }
    }

    for (const h of htmlList) {
      const tTok = await tokOf(h);
      if (tTok > budgetTokens) {
        const parts = segmentSentencesFromHTML(h);
        for (const p of parts) {
          const pTok = await tokOf(p);
          if (pTok > budgetTokens) {
            const txt = stripHtmlToText(p);
            const byPunc = txt.split(/([。！？!?…]+["”』）】]*\s*)/);
            let accum = ''; let accumTok = 0;
            for (let i = 0; i < byPunc.length; i += 2) {
              const chunk = (byPunc[i] || '') + (byPunc[i + 1] || ''); if (!chunk) continue;
              const test = accum + chunk;
              const testTok = await TKT.countTextTokens(test, s.model.id);
              if (curTok + testTok > budgetTokens) {
                if (accum) {
                  const aTok = await TKT.countTextTokens(accum, s.model.id);
                  if (curTok + aTok > budgetTokens) await flush();
                  cur.push(accum); curTok += aTok;
                }
                accum = chunk; accumTok = await TKT.countTextTokens(accum, s.model.id);
              } else {
                accum = test; accumTok = testTok;
              }
            }
            if (accum) {
              if (curTok + accumTok > budgetTokens) await flush();
              cur.push(accum); curTok += accumTok;
            }
          } else {
            if (curTok + pTok > budgetTokens) await flush();
            cur.push(p); curTok += pTok;
          }
        }
      } else {
        if (curTok + tTok > budgetTokens) await flush();
        cur.push(h); curTok += tTok;
      }
    }
    await flush();
    return plan.map((p, i) => ({ index: i, html: p.html, text: p.text, inTok: p.inTok }));
  }
  function segmentSentencesFromHTML(html) {
    const tmp = document.createElement('div'); tmp.innerHTML = html; const parts = [];
    // 处理块级元素，包括blockquote在内的所有块级元素
    const blocks = $all('p, div, li, pre, blockquote', tmp);

    if (!blocks.length) {
      parts.push(html);
      return parts;
    }

    // 处理所有块级元素，包括blockquote
    for (const b of blocks) {
      // 检查是否在其他块级元素内部，避免重复处理
      if (b.closest('p, div, li, pre, blockquote') && !b.parentElement?.isEqualNode(tmp)) continue;
      parts.push(b.outerHTML);
    }

    return parts;
  }

  /* ================= Finish Reason Handler ================= */
  function handleFinishReason(finishReason, label) {
    if (!finishReason) return; // null 或 undefined，不处理

    const reasonMap = {
      'stop': '正常完成',
      'length': '长度限制（将自动重试）',
      'content_filter': '内容被过滤',
      'tool_calls': '工具调用完成',
      'function_call': '函数调用完成',
      'recitation': '引用检测触发',
      'safety': '安全检查触发',
      'other': '其他原因完成'
    };

    // 只对非正常完成的情况显示提示
    if (finishReason !== 'stop' && finishReason !== 'length') {
      const reason = reasonMap[finishReason] || `未知原因: ${finishReason}`;
      UI.toast(`${label} 非正常完成: ${reason}`);
      d('finish_reason:abnormal', { label, finishReason, reason });
    }
  }

  class RequestError extends Error {
    constructor(message, options = {}) {
      super(message || '请求失败');
      this.name = 'RequestError';
      if (options.cause) this.cause = options.cause;
      if (typeof options.status === 'number') this.status = options.status;
      if (typeof options.retryAfterMs === 'number') this.retryAfterMs = options.retryAfterMs;
      if (options.isNetworkError) this.isNetworkError = true;
      if (options.isTimeout) this.isTimeout = true;
      if (typeof options.code === 'string') this.code = options.code;
      if (typeof options.shouldRetry === 'boolean') this.shouldRetry = options.shouldRetry;
    }
  }

  function parseRetryAfter(headerValue) {
    if (!headerValue) return null;
    const seconds = Number(headerValue);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(headerValue);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  const RETRIABLE_STATUS = new Set([403, 408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

  function shouldRetryError(err) {
    if (!err) return false;
    if (typeof err.shouldRetry === 'boolean') return err.shouldRetry;
    if (err.noRetry) return false;
    if (typeof err.status === 'number' && RETRIABLE_STATUS.has(err.status)) return true;
    if (err.isTimeout) return true;
    if (err.isNetworkError) return true;
    const msg = (err.message || '').toLowerCase();
    if (!msg) return false;
    return msg.includes('timeout') || msg.includes('network') || msg.includes('fetch failed') || msg.includes('connection');
  }

  function computeRetryDelay(err, attempt) {
    if (err && typeof err.retryAfterMs === 'number' && err.retryAfterMs >= 0) {
      return Math.min(10000, Math.max(0, err.retryAfterMs));
    }
    if (err && err.isTimeout) {
      return Math.min(2000, 300 + (attempt - 1) * 200);
    }
    return Math.min(5000, 500 + (attempt - 1) * 400 + Math.random() * 600);
  }

  /* ================= OpenAI-compatible + SSE ================= */
  function resolveEndpoint(baseUrl, apiPath) { if (!baseUrl) throw new Error('请在设置中填写 Base URL'); const hasV1 = /\/v1\//.test(baseUrl); return hasV1 ? baseUrl : `${trimSlash(baseUrl)}/${trimSlash(apiPath || 'v1/chat/completions')}`; }
  function resolveModelsEndpoint(baseUrl) { if (!baseUrl) throw new Error('请填写 Base URL'); const m = baseUrl.match(/^(.*?)(\/v1\/.*)$/); return m ? `${m[1]}/v1/models` : `${trimSlash(baseUrl)}/v1/models`; }
  async function fetchJSON(url, key, body) {
    try {
      const res = await gmFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'authorization': `Bearer ${key}` } : {})
        },
        body: JSON.stringify(body)
      }).catch(err => {
        throw new RequestError(err?.message || '网络请求失败', { cause: err, isNetworkError: true });
      });
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (!res.ok) {
        const t = await res.text();
        throw new RequestError(`HTTP ${res.status}: ${t.slice(0, 500)}`, {
          status: res.status,
          retryAfterMs
        });
      }
      return await res.json();
    } catch (err) {
      if (err instanceof RequestError) throw err;
      throw new RequestError(err?.message || '请求失败', { cause: err, isNetworkError: true });
    }
  }
  function supportsStreamingFetch() { return true; }

  async function postChatWithRetry({ endpoint, key, payload, stream, onDelta, onDone, onError, onFinishReason, label, onAttempt }) {
    const cfg = settings.get().watchdog || {};
    const maxRetry = Math.max(0, cfg.maxRetry || 0);
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        if (typeof onAttempt === 'function') {
          try { onAttempt(attempt); } catch (hookErr) { d('chat:onAttempt-error', { label, attempt, error: hookErr?.message }); }
        }
        d('chat:start', { label, attempt, stream });
        await postChatOnce({ endpoint, key, payload, stream, onDelta, onDone, onFinishReason, label, idleMs: cfg.idleMs, hardMs: cfg.hardMs });
        d('chat:done', { label, attempt });
        return;
      } catch (e) {
        d('chat:error', { label, attempt, error: e.message, status: e.status });
        const msg = e?.message || '';
        if (msg && (msg.includes('idle-timeout') || msg.includes('hard-timeout'))) {
          UI.toast(`块 ${label} 因超时失败`);
        }
        const canRetry = attempt <= maxRetry && shouldRetryError(e);
        if (!canRetry) { if (onError) onError(e); return; }
        const delay = computeRetryDelay(e, attempt + 1);
        d('chat:retrying', { label, attemptNext: attempt + 1, delay });
        await sleep(delay);
      }
    }
  }
  async function postChatOnce({ endpoint, key, payload, stream, onDelta, onDone, onFinishReason, label, idleMs, hardMs }) {
    if (stream && supportsStreamingFetch()) {
      await fetchSSEWithAbort(endpoint, key, payload, onDelta, onFinishReason, { label, idleMs, hardMs });
      onDone && onDone();
    } else {
      const full = await fetchJSON(endpoint, key, payload);
      let content = full?.choices?.[0]?.message?.content || '';
      const fr = full?.choices?.[0]?.finish_reason || null;
      // 过滤思考内容，只保留非思考内容作为译文
      if (content) {
        content = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')  // 标准XML标签格式
          .replace(/<think>[\s\S]*?<\/think>/g, '')  // 简化XML标签格式
          .replace(/^Thought:\s*[^\n]*\n\n/gm, '')  // 行首的Thought前缀格式（必须有双换行）
          .replace(/^Thinking Process:\s*[^\n]*\n\n/gm, '')  // 行首的思考过程前缀（必须有双换行）
          .replace(/^Internal Monologue:\s*[^\n]*\n\n/gm, '')  // 行首的内心独白前缀（必须有双换行）
          .replace(/\[思考\][\s\S]*?\[\/思考\]/g, '');  // 中文标签格式
      }
      onDelta && onDelta(content); onFinishReason && onFinishReason(fr); onDone && onDone();
    }
  }
  function fetchSSEWithAbort(url, key, body, onDelta, onFinishReason, { label = 'chunk', idleMs = 10000, hardMs = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      let lastTxtLen = 0;
      let buf = '';
      let eventBuf = [];
      let sawDone = false;
      let finishReason = null;
      let req = null;

      const cleanReq = () => { if (req) { try { req.abort(); } catch { } req = null; } };

      let lastTick = performance.now();

      const checkIdle = () => {
        const now = performance.now();
        if (now - lastTick > idleMs) {
          cleanup();
          cleanReq();
          reject(new RequestError('idle-timeout', { isTimeout: true }));
        }
      };

      const idleTimer = (idleMs > 0) ? setInterval(checkIdle, 2000) : null;

      const hardTimer = (hardMs > 0) ? setTimeout(() => {
        cleanup();
        cleanReq();
        reject(new RequestError('hard-timeout', { isTimeout: true }));
      }, hardMs) : null;

      const cleanup = () => {
        if (idleTimer) clearInterval(idleTimer);
        if (hardTimer) clearTimeout(hardTimer);
      };

      const processChunk = (text) => {
        if (!text) return;
        buf += text;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              flushEvent();
              sawDone = true;
              return;
            }
            if (data) eventBuf.push(data);
          } else if (!line.trim()) {
            flushEvent();
          }
        }
      };

      const flushEvent = () => {
        if (!eventBuf.length) return;
        const joined = eventBuf.join('\n');
        eventBuf = [];
        try {
          const j = JSON.parse(joined);
          const choice = j?.choices?.[0];
          let delta = choice?.delta?.content ?? choice?.text ?? '';
          if (delta) {
            delta = delta.replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .replace(/^Thought:\s*[^\n]*\n\n/gm, '')
              .replace(/^Thinking Process:\s*[^\n]*\n\n/gm, '')
              .replace(/^Internal Monologue:\s*[^\n]*\n\n/gm, '')
              .replace(/\[思考\][\s\S]*?\[\/思考\]/g, '');
          }
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
          if (delta) {
            onDelta(delta);
            lastTick = performance.now();
          }
        } catch (e) { d('sse:parse-error', { label, payload: joined }); }
      };

      req = GM_xmlhttpRequest({
        method: 'POST',
        url: url,
        headers: {
          'content-type': 'application/json',
          ...(key ? { 'authorization': `Bearer ${key}` } : {})
        },
        data: JSON.stringify(body),
        onprogress: (r) => {
          if (sawDone) return;
          const newSnippet = r.responseText.slice(lastTxtLen);
          lastTxtLen = r.responseText.length;
          if (newSnippet) {
            lastTick = performance.now();
            processChunk(newSnippet);
          }
        },
        onload: (r) => {
          cleanup();
          if (r.status >= 200 && r.status < 300) {
            if (buf.trim()) processChunk(''); // Try to flush remainder
            if (typeof onFinishReason === 'function') onFinishReason(finishReason);
            d('sse:complete', { label, finishReason });
            resolve();
          } else {
            reject(new RequestError(`HTTP ${r.status}: ${r.responseText.slice(0, 500)}`, { status: r.status }));
          }
        },
        onerror: (e) => {
          cleanup();
          reject(new RequestError('Network error', { isNetworkError: true }));
        },
        ontimeout: () => {
          cleanup();
          reject(new RequestError('Request timeout', { isTimeout: true }));
        }
      });
    });
  }

  async function getModels() {
    const s = settings.get(); const url = resolveModelsEndpoint(s.api.baseUrl);
    const res = await gmFetch(url, { headers: { ...(s.api.key ? { 'authorization': `Bearer ${s.api.key}` } : {}) } });
    if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
    const j = await res.json(); const list = j?.data || j?.models || [];
    return list.map(m => typeof m === 'string' ? { id: m } : m);
  }
  const ModelBrowser = {
    all: [],
    currentType: 'translate', // 记录当前操作的模型类型
    async fetchAndRender(panel, type = 'translate') {
      this.currentType = type;
      try {
        const list = await getModels();
        this.all = list;
        this.render(panel, list, type);
      } catch (e) {
        UI.toast('获取模型失败：' + e.message);
      }
    },
    render(panel, list, type = 'translate') {
      const boxId = type === 'translate' ? '#ao3x-translate-model-list' : '#ao3x-summary-model-list';
      const box = $(boxId, panel);
      box.innerHTML = '';
      list.forEach(m => {
        const div = document.createElement('div');
        div.className = 'ao3x-model-item';
        div.textContent = m.id || m.name || JSON.stringify(m);
        div.addEventListener('click', () => {
          this.selectModel(panel, m.id || m.name, type);
        });
        box.appendChild(div);
      });
    },
    selectModel(panel, modelId, type) {
      if (type === 'translate') {
        // 设置翻译模型
        $('#ao3x-translate-model', panel).value = modelId;

        // 如果总结模型为空，则同步设置总结模型
        const summaryModelInput = $('#ao3x-summary-model', panel);
        if (!summaryModelInput.value.trim()) {
          summaryModelInput.value = modelId;
          UI.toast(`已设置翻译模型为 ${modelId}，并同步到总结模型`);
        } else {
          UI.toast(`已设置翻译模型为 ${modelId}`);
        }
      } else if (type === 'summary') {
        // 设置总结模型
        $('#ao3x-summary-model', panel).value = modelId;
        UI.toast(`已设置总结模型为 ${modelId}`);
      }

      // 保存设置
      settings.set(collectPanelValues(panel));
      saveToast();
    },
    filter(panel, type = null) {
      const actualType = type || this.currentType;
      const queryId = actualType === 'translate' ? '#ao3x-translate-model-q' : '#ao3x-summary-model-q';
      const q = ($(queryId, panel).value || '').toLowerCase();
      const list = !q ? this.all : this.all.filter(m => (m.id || '').toLowerCase().includes(q));
      this.render(panel, list, actualType);
    }
  };

  /* ================= View / Render State (ordered) ================= */
  const TransStore = {
    _map: Object.create(null), _done: Object.create(null),
    _cacheKey: null,

    // 初始化缓存键（基于当前URL）
    initCache() {
      this._cacheKey = `ao3_translator_${window.location.pathname}`;
      this.loadFromCache();
    },

    // 从存储加载缓存（优先 GM 存储，回落 localStorage 由 GM_Get 封装处理）
    loadFromCache() {
      if (!this._cacheKey) return;
      try {
        const data = GM_Get(this._cacheKey);
        if (data && typeof data === 'object') {
          this._map = data._map || Object.create(null);
          this._done = data._done || Object.create(null);
          return;
        }
        // GM 无数据时，尝试从 localStorage 读取并迁移
        try {
          const cached = localStorage.getItem(this._cacheKey);
          if (cached) {
            const dataLS = JSON.parse(cached);
            this._map = dataLS._map || Object.create(null);
            this._done = dataLS._done || Object.create(null);
            // 迁移到 GM，并清理 LS
            try { GM_Set(this._cacheKey, { _map: this._map, _done: this._done, timestamp: Date.now() }); } catch { }
            try { localStorage.removeItem(this._cacheKey); } catch { }
          }
        } catch { }
      } catch (e) {
        console.warn('Failed to load translation cache:', e);
      }
    },

    // 保存到存储（优先 GM 存储，回落 localStorage 由 GM_Set 封装处理）
    saveToCache() {
      if (!this._cacheKey) return;
      try {
        const data = {
          _map: this._map,
          _done: this._done,
          timestamp: Date.now()
        };
        GM_Set(this._cacheKey, data);
      } catch (e) {
        console.warn('Failed to save translation cache:', e);
      }
    },

    // 清除缓存
    clearCache() {
      if (this._cacheKey) {
        GM_Del(this._cacheKey);
      }
      this.clear();
    },

    // 检查是否有缓存
    hasCache() {
      if (!this._cacheKey) return false;
      try {
        const data = GM_Get(this._cacheKey);
        if (data) {
          const map = data._map || {};
          return Object.keys(map).length > 0;
        }
        // GM 无数据时，尝试读取 LS 并顺便迁移
        try {
          const cached = localStorage.getItem(this._cacheKey);
          if (!cached) return false;
          const dataLS = JSON.parse(cached);
          const map = dataLS._map || {};
          if (Object.keys(map).length > 0) {
            try { GM_Set(this._cacheKey, { _map: map, _done: dataLS._done || {}, timestamp: Date.now() }); } catch { }
            try { localStorage.removeItem(this._cacheKey); } catch { }
            return true;
          }
          return false;
        } catch {
          return false;
        }
      } catch (e) {
        return false;
      }
    },

    // 获取缓存信息
    getCacheInfo() {
      if (!this._cacheKey) return { hasCache: false, total: 0, completed: 0 };
      try {
        const data = GM_Get(this._cacheKey);
        if (data) {
          const map = data._map || {};
          const done = data._done || {};
          return {
            hasCache: Object.keys(map).length > 0,
            total: Object.keys(map).length,
            completed: Object.keys(done).length
          };
        }
        // GM 无数据时，尝试读取 LS 并迁移
        try {
          const cached = localStorage.getItem(this._cacheKey);
          if (!cached) return { hasCache: false, total: 0, completed: 0 };
          const dataLS = JSON.parse(cached);
          const map = dataLS._map || {};
          const done = dataLS._done || {};
          // 迁移
          try { GM_Set(this._cacheKey, { _map: map, _done: done, timestamp: Date.now() }); } catch { }
          try { localStorage.removeItem(this._cacheKey); } catch { }
          return {
            hasCache: Object.keys(map).length > 0,
            total: Object.keys(map).length,
            completed: Object.keys(done).length
          };
        } catch {
          return { hasCache: false, total: 0, completed: 0 };
        }
      } catch (e) {
        return { hasCache: false, total: 0, completed: 0 };
      }
    },

    set(i, html) {
      this._map[i] = html;
      this.saveToCache(); // 自动保存
    },

    get(i) { return this._map[i] || ''; },

    markDone(i) {
      this._done[i] = true;
      this.saveToCache(); // 自动保存
    },

    allDone(total) {
      for (let k = 0; k < total; k++) { if (!this._done[k]) return false; }
      return true;
    },

    clear() {
      this._map = Object.create(null);
      this._done = Object.create(null);
    }
  };

  const PlanStore = {
    _html: Object.create(null),
    set(i, html) {
      if (Number.isInteger(i) && html) {
        this._html[i] = html;
      }
    },
    get(i) {
      if (Number.isInteger(i)) {
        return this._html[i] || '';
      }
      return '';
    },
    clear() {
      this._html = Object.create(null);
    }
  };

  const RenderState = {
    nextToRender: 0, total: 0, lastApplied: Object.create(null),
    _pendingUpdates: new Map(), // 批处理待更新的内容
    _updateScheduled: false,
    setTotal(n) { this.total = n; this.nextToRender = 0; this.lastApplied = Object.create(null); },
    canRender(i) { return i === this.nextToRender; },
    applyIncremental(i, cleanHtml) {
      const c = ensureRenderContainer();
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`); if (!anchor) return;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if (!transDiv) {
        transDiv = document.createElement('div');
        transDiv.className = 'ao3x-translation';
        // 设置最小高度防止容器跳动
        transDiv.style.minHeight = '60px';
        anchor.insertAdjacentElement('afterend', transDiv);
      }
      const prev = this.lastApplied[i] || '';
      const hasPlaceholder = /\(待译\)/.test(transDiv.textContent || '');

      // 首次渲染或有占位符时，直接替换全部内容
      if (!prev || hasPlaceholder) {
        // 使用批处理避免频繁的DOM更新
        this._pendingUpdates.set(i, { transDiv, cleanHtml, mode: 'replace' });
        this._scheduleUpdate();
        this.lastApplied[i] = cleanHtml;
        return;
      }

      // 检查新内容是否与上次完全相同，避免无意义的更新
      if (cleanHtml === prev) {
        return;
      }

      // 增量更新：仅追加新增部分
      if (cleanHtml.startsWith(prev)) {
        const tail = cleanHtml.slice(prev.length);
        if (tail) {
          // 批处理追加更新
          this._pendingUpdates.set(i, { transDiv, tail, mode: 'append' });
          this._scheduleUpdate();
          this.lastApplied[i] = cleanHtml;
        }
      } else {
        // 内容不连续，全量替换
        this._pendingUpdates.set(i, { transDiv, cleanHtml, mode: 'replace' });
        this._scheduleUpdate();
        this.lastApplied[i] = cleanHtml;
      }
    },
    _scheduleUpdate() {
      if (this._updateScheduled) return;
      this._updateScheduled = true;
      requestAnimationFrame(() => {
        this._flushUpdates();
        this._updateScheduled = false;
      });
    },
    _flushUpdates() {
      // 批量处理所有待更新的DOM操作，减少reflow
      for (const [i, update] of this._pendingUpdates.entries()) {
        const { transDiv, cleanHtml, tail, mode } = update;
        if (mode === 'replace') {
          transDiv.innerHTML = cleanHtml || '<span class="ao3x-muted">（待译）</span>';
        } else if (mode === 'append' && tail) {
          // 使用insertAdjacentHTML而不是innerHTML，性能更好
          transDiv.insertAdjacentHTML('beforeend', tail);
        }
      }
      this._pendingUpdates.clear();
    },
    // 直接渲染到指定块，绕过顺序检查（用于「只计划」模式的单块翻译）
    applyDirect(i, cleanHtml) {
      const c = ensureRenderContainer();
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`); if (!anchor) return;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if (!transDiv) {
        transDiv = document.createElement('div');
        transDiv.className = 'ao3x-translation';
        transDiv.style.minHeight = '60px';
        anchor.insertAdjacentElement('afterend', transDiv);
      }
      const prev = this.lastApplied[i] || '';
      const hasPlaceholder = /[（(]待译/.test(transDiv.textContent || '');

      if (!prev || hasPlaceholder) {
        this._pendingUpdates.set(i, { transDiv, cleanHtml, mode: 'replace' });
        this._scheduleUpdate();
        this.lastApplied[i] = cleanHtml;
        return;
      }

      if (cleanHtml === prev) return;

      if (cleanHtml.startsWith(prev)) {
        const tail = cleanHtml.slice(prev.length);
        if (tail) {
          this._pendingUpdates.set(i, { transDiv, tail, mode: 'append' });
          this._scheduleUpdate();
          this.lastApplied[i] = cleanHtml;
        }
      } else {
        this._pendingUpdates.set(i, { transDiv, cleanHtml, mode: 'replace' });
        this._scheduleUpdate();
        this.lastApplied[i] = cleanHtml;
      }
    },
    finalizeCurrent() {
      // Advance rendering pointer and drain any already-finished chunks in order.
      while (this.nextToRender < this.total) {
        const i = this.nextToRender;
        const live = (typeof Streamer !== 'undefined' && Streamer.getCleanNow)
          ? Streamer.getCleanNow(i) : '';
        const cached = TransStore.get(String(i)) || '';
        const best = live || cached;
        if (best) this.applyIncremental(i, best);
        // If this chunk is fully done, move to the next and continue draining.
        const isDone = !!(TransStore && TransStore._done && TransStore._done[i]);
        if (isDone) {
          this.nextToRender++;
          continue;
        }
        // Current chunk not finished; stop here and wait for more delta/done.
        break;
      }
    }
  };

  const View = {
    mode: 'trans',
    _isShowingCache: false,
    ensure() { return ensureRenderContainer(); },
    info(msg) { let n = $('#ao3x-info'); if (!n) { n = document.createElement('div'); n.id = 'ao3x-info'; n.className = 'ao3x-small'; this.ensure().prepend(n); } n.textContent = msg; },
    clearInfo() { const n = $('#ao3x-info'); if (n) n.remove(); },

    // 检查是否正在显示缓存
    isShowingCache() {
      return this._isShowingCache;
    },

    // 设置是否正在显示缓存
    setShowingCache(showing) {
      this._isShowingCache = showing;
    },
    setMode(m) {
      // 只在显示缓存时禁用双语对照模式
      if (m === 'bi' && this.isShowingCache()) {
        m = 'trans'; // 强制切换到译文模式
        UI.toast('显示缓存时双语对照功能已禁用');
      }
      this.mode = m; this.applyHostVisibility(); this.refresh(true);
    },
    applyHostVisibility() {
      const container = this.ensure();
      if (this.mode === 'trans' || this.mode === 'bi') {
        SelectedNodes.forEach(n => n.style.display = 'none');
        container.style.display = '';
      } else if (this.mode === 'orig') {
        // 原文模式：隐藏原始节点，但保持容器可见（用于双击检测）
        SelectedNodes.forEach(n => n.style.display = 'none');
        container.style.display = '';
      } else {
        SelectedNodes.forEach(n => n.style.display = '');
        container.style.display = 'none';
      }
    },
    refresh(initial = false) {
      if (this.mode === 'bi' && Bilingual.canRender()) { this.renderBilingual(); return; }
      if (this.mode === 'summary') { this.renderSummary(); return; }
      const c = this.ensure();
      if (initial) {
        const next = RenderState.nextToRender || 0;
        c.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)').forEach(block => {
          const idxStr = block.getAttribute('data-index');
          const i = Number(idxStr);
          const orig = block.getAttribute('data-original-html') || '';
          if (this.mode === 'trans') {
            let contentHTML = '';
            if (i < next) {
              // Already rendered; keep lastApplied or cached
              contentHTML = (RenderState.lastApplied[i]) || TransStore.get(idxStr) || '';
            } else if (i === next) {
              // Current chunk: show live snapshot if any, else cached, else placeholder
              const live = (typeof Streamer !== 'undefined' && Streamer.getCleanNow) ? Streamer.getCleanNow(i) : '';
              contentHTML = live || TransStore.get(idxStr) || '';
            } else {
              // 对于缓存加载，显示所有已缓存的翻译
              contentHTML = TransStore.get(idxStr) || '';
            }
            const transHTML = contentHTML || '<span class="ao3x-muted">（待译）</span>';
            block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idxStr}"></span><div class="ao3x-translation">${transHTML}</div>`;
            // Only sync lastApplied for already-rendered/current chunk
            if (typeof RenderState !== 'undefined' && RenderState.lastApplied) {
              if (i <= next) RenderState.lastApplied[i] = contentHTML || '';
            }
          } else if (this.mode === 'orig') {
            block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idxStr}"></span>${orig}`;
          }
          // 确保 data-index 和 data-original-html 属性被保留
          if (idxStr !== null && idxStr !== undefined) block.setAttribute('data-index', idxStr);
          block.setAttribute('data-original-html', orig);
        });
      }
    },
    renderSummary() {
      const c = this.ensure();
      // 查找总结专用的块容器
      const summaryBlocks = Array.from(c.querySelectorAll('.ao3x-summary-block'));

      if (summaryBlocks.length === 0) {
        // 如果没有总结块，显示提示信息
        c.innerHTML = '<div class="ao3x-info">没有找到总结内容。请先生成章节总结。</div>';
        return;
      }

      // 渲染每个总结块
      summaryBlocks.forEach(block => {
        const idx = block.getAttribute('data-summary-index');
        const orig = block.getAttribute('data-original-html') || '';
        const summary = SummaryStore.get(idx) || '';

        // 创建总结视图HTML结构
        const summaryHTML = summary || '<span class="ao3x-muted">（待总结）</span>';
        const origPreview = this.getTextPreview(stripHtmlToText(orig), 100); // 显示原文预览

        const html = `
          <div class="ao3x-summary-pair">
            <div class="ao3x-summary-header">段落 #${idx}</div>
            <div class="ao3x-summary-preview">原文预览：${escapeHTML(origPreview)}</div>
            <div class="ao3x-summary-content">${summaryHTML}</div>
          </div>
        `;

        // 直接更新 innerHTML，移除 requestAnimationFrame 以避免异步问题
        block.innerHTML = `<span class="ao3x-anchor" data-summary-chunk-id="${idx}"></span>${html}`;
      });
    },
    renderBilingual() {
      const c = this.ensure(); const blocks = Array.from(c.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)'));
      blocks.forEach(block => {
        const idx = block.getAttribute('data-index');
        const orig = block.getAttribute('data-original-html') || '';
        const trans = TransStore.get(idx);
        const pairs = Bilingual.pairByParagraph(orig, trans);
        const html = pairs.map(p => `<div class="ao3x-pair"><div class="orig">${p.orig}</div><div class="trans">${p.trans || '<span class="ao3x-muted">（无对应段落）</span>'}</div></div>`).join('');

        // 直接更新 innerHTML，移除 requestAnimationFrame 以避免异步问题
        block.innerHTML = `<span class="ao3x-anchor" data-chunk-id="${idx}"></span>${html}`;
        // 确保 data-index 和 data-original-html 属性被保留
        if (idx !== null && idx !== undefined) block.setAttribute('data-index', idx);
        if (orig) block.setAttribute('data-original-html', orig);
      });
    },
    setBlockTranslation(idx, html) {
      TransStore.set(String(idx), html);
      if (RenderState.canRender(Number(idx))) {
        RenderState.applyIncremental(Number(idx), html);
      }
      // 只在显示缓存时禁用双语对照功能
      if (this.mode === 'bi' && Bilingual.canRender() && this.isShowingCache()) {
        this.mode = 'trans';
        UI.toast('显示缓存时双语对照功能已禁用');
        this.refresh(true);
      }
    },
    // 获取文本预览，用于总结视图
    getTextPreview(text, maxLength = 100) {
      if (!text || typeof text !== 'string') return '';
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean.length <= maxLength) return clean;
      return clean.slice(0, maxLength) + '...';
    },
  };
  const Bilingual = {
    canRender() { return this._total != null && TransStore.allDone(this._total); },
    setTotal(n) { this._total = n; }, _total: null,
    splitParagraphs(html) {
      const div = document.createElement('div'); div.innerHTML = html; const out = [];
      // 处理所有块级元素，包括blockquote
      div.querySelectorAll('p, div, li, pre, blockquote').forEach(el => {
        const text = (el.textContent || '').trim();
        if (!text) return;
        // 检查是否在其他块级元素内部，避免重复处理
        if (el.closest('p, div, li, pre, blockquote') && !el.parentElement?.isEqualNode(div)) return;
        out.push(el.outerHTML);
      });

      if (!out.length) {
        const raw = (div.innerHTML || '').split(/<br\s*\/?>/i).map(x => x.trim()).filter(Boolean);
        return raw.map(x => `<p>${x}</p>`);
      }
      return out;
    },
    pairByParagraph(origHTML, transHTML) { const o = this.splitParagraphs(origHTML); const t = this.splitParagraphs(transHTML); const m = Math.max(o.length, t.length); const pairs = new Array(m); for (let i = 0; i < m; i++) { pairs[i] = { orig: o[i] || '', trans: t[i] || '' }; } return pairs; }
  };

  /* ================= Chunk Indicator ================= */
  const ChunkIndicator = {
    _popup: null,
    _hideTimer: null,
    _container: null,
    _boundHandler: null,
    _hasListener: false,  // 标记是否已添加监听器
    _retryCount: 0,       // 重试计数器
    _maxRetries: 5,       // 最大重试次数
    settings: {
      showPreview: false,  // 默认不显示预览文本
      duration: 1000       // 显示时长 1 秒
    },

    _resolveContainer(hint) {
      const tryResolveFromNode = (node) => {
        if (!node) return null;
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node.closest('#ao3x-render');
        }
        if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
          return node.parentElement.closest('#ao3x-render');
        }
        return null;
      };

      const resolveFromHint = (maybeHint) => {
        if (!maybeHint) return null;
        if (maybeHint instanceof Event) {
          const path = typeof maybeHint.composedPath === 'function'
            ? maybeHint.composedPath()
            : [];
          for (const node of path) {
            const found = tryResolveFromNode(node);
            if (found) return found;
          }
          return tryResolveFromNode(maybeHint.target);
        }
        if (Array.isArray(maybeHint)) {
          for (const node of maybeHint) {
            const found = tryResolveFromNode(node);
            if (found) return found;
          }
          return null;
        }
        return tryResolveFromNode(maybeHint);
      };

      const hinted = resolveFromHint(hint);
      if (hinted) {
        if (this._container !== hinted) {
          this._container = hinted;
          d('ChunkIndicator: rebound to container via hint', hinted);
        }
        return hinted;
      }

      if (this._container && this._container.isConnected) {
        return this._container;
      }

      const containers = document.querySelectorAll('#ao3x-render');
      const container = containers.length ? containers[containers.length - 1] : null;
      if (container && this._container !== container) {
        this._container = container;
        d('ChunkIndicator: rebound to container', container);
      }
      return container;
    },

    init() {
      const container = this._resolveContainer();
      if (!container) {
        // 限制重试次数，避免无限重试
        if (this._retryCount < this._maxRetries) {
          this._retryCount++;
          d('ChunkIndicator: container not found, retrying... (' + this._retryCount + '/' + this._maxRetries + ')');
          setTimeout(() => this.init(), 500);
        } else {
          d('ChunkIndicator: container not found after ' + this._maxRetries + ' retries, giving up');
        }
        return;
      }

      // 重置重试计数器
      this._retryCount = 0;
      const previousContainer = this._container;
      this._container = container;

      if (!this._boundHandler) {
        this._boundHandler = this.handleDoubleClick.bind(this);
      }

      // 总是在 document 上监听，避免容器被替换后丢失事件
      if (!this._hasListener) {
        document.addEventListener('dblclick', this._boundHandler);
        this._hasListener = true;
        d('ChunkIndicator: initialized and listening on', container);
      } else {
        if (previousContainer !== container) {
          d('ChunkIndicator: switched to new container', container);
        } else {
          d('ChunkIndicator: listener already active on current container');
        }
      }
    },

    handleDoubleClick(e) {
      let container = this._resolveContainer(e);
      if (!container || !container.isConnected) {
        d('ChunkIndicator: container missing when handling double click');
        return;
      }

      const block = this._locateBlockFromEvent(e, container);
      if (block && container && !container.contains(block)) {
        const owningContainer = this._resolveContainer(block);
        if (owningContainer && owningContainer.contains(block)) {
          container = owningContainer;
          d('ChunkIndicator: switched to block container', container);
        }
      }
      if (!block || !container.contains(block)) {
        const inside = this._isEventInsideContainer(e, container);
        if (inside) {
          d('ChunkIndicator: click inside render container but no block found', e.target);
        } else {
          d('ChunkIndicator: double click outside render container');
        }
        return; // 仅处理渲染容器内的双击
      }

      d('ChunkIndicator: double click detected', e.target);

      // 阻止默认的文本选择行为
      e.preventDefault();
      d('ChunkIndicator: found block', block);

      // 读取分块编号
      const chunkIndex = block.getAttribute('data-index');
      d('ChunkIndicator: chunk index', chunkIndex);

      if (chunkIndex === null) {
        d('ChunkIndicator: no chunk index');
        return;
      }

      // 仅在设置开启时获取预览文本
      const previewText = this.settings.showPreview
        ? this.getPreviewText(parseInt(chunkIndex, 10))
        : null;

      // 显示弹窗
      d('ChunkIndicator: showing popup for chunk', chunkIndex);
      this.showPopup(chunkIndex, previewText);
    },

    _locateBlockFromEvent(e, container) {
      if (!e) return null;
      const tryTarget = (node) => this._getBlockFromTarget(node);
      let block = tryTarget(e.target);
      if (block) return block;

      if (typeof e.composedPath === 'function') {
        block = this._getBlockFromPath(e.composedPath());
        if (block) return block;
      }

      block = this._getBlockFromPoint(e);
      if (block && (!container || container.contains(block))) {
        return block;
      }

      if (container) {
        block = this._getBlockFromBounds(container, e);
      }

      return block || null;
    },

    _getBlockFromTarget(target) {
      let node = target;
      while (node && node !== document) {
        if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('ao3x-block') && !node.classList.contains('ao3x-summary-block')) {
          return node;
        }
        node = node.parentNode || node.host || null;
      }
      return null;
    },

    _getBlockFromPath(path = []) {
      for (const node of path) {
        const block = this._getBlockFromTarget(node);
        if (block) return block;
      }
      return null;
    },

    _getBlockFromPoint(e) {
      if (!e) return null;
      const { clientX, clientY } = e;
      if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;

      if (typeof document.elementsFromPoint === 'function') {
        const hits = document.elementsFromPoint(clientX, clientY) || [];
        for (const node of hits) {
          const block = this._getBlockFromTarget(node);
          if (block) return block;
        }
      }

      if (typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(clientX, clientY);
        return this._getBlockFromTarget(hit);
      }
      return null;
    },

    _getBlockFromBounds(container, e) {
      if (!container || !e) return null;
      const { clientX, clientY } = e;
      if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
      const blocks = container.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)');
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          return block;
        }
      }
      return null;
    },

    _isEventInsideContainer(e, container) {
      if (!e || !container) return false;
      if (container.contains(e.target)) return true;
      if (typeof container.getBoundingClientRect !== 'function') return false;
      const rect = container.getBoundingClientRect();
      const { clientX, clientY } = e;
      if (typeof clientX !== 'number' || typeof clientY !== 'number') return false;
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    },

    showPopup(chunkIndex, previewText) {
      // 清除之前的定时器
      if (this._hideTimer) {
        clearTimeout(this._hideTimer);
      }

      // 创建弹窗（如果不存在）
      if (!this._popup) {
        this._popup = document.createElement('div');
        this._popup.className = 'ao3x-chunk-popup';
        document.body.appendChild(this._popup);
      }

      // 构建弹窗内容
      let content = `<div class="ao3x-chunk-popup-number">#${chunkIndex}</div>`;

      // 仅在开启预览时显示
      if (previewText && this.settings.showPreview) {
        content += `
          <div class="ao3x-chunk-popup-preview">
            <div>开头：${escapeHTML(previewText.startText)}...</div>
            <div>结尾：...${escapeHTML(previewText.endText)}</div>
          </div>
        `;
      }

      // 更新内容
      this._popup.innerHTML = content;
      this._popup.classList.remove('hiding');

      // 1 秒后自动隐藏
      this._hideTimer = setTimeout(() => this.hidePopup(), this.settings.duration);
    },

    hidePopup() {
      if (!this._popup) return;

      // 添加淡出动画类
      this._popup.classList.add('hiding');

      // 等待动画完成后移除
      setTimeout(() => {
        if (this._popup && this._popup.parentNode) {
          this._popup.remove();
          this._popup = null;
        }
      }, 200);
    },

    getPreviewText(chunkIndex) {
      // 从 PlanStore 获取分块的原始 HTML
      const html = (typeof PlanStore !== 'undefined' && PlanStore.get)
        ? PlanStore.get(chunkIndex)
        : '';

      if (!html) return null;

      // 转换为纯文本
      const text = stripHtmlToText(html);
      const cleanText = text.replace(/\s+/g, ' ').trim();

      // 提取开头和结尾
      const startText = cleanText.slice(0, 50);
      const endText = cleanText.slice(-50);

      return { startText, endText };
    }
  };

  function renderPlanAnchors(plan) {
    const c = ensureRenderContainer(); c.innerHTML = '';
    const box = document.createElement('div'); box.id = 'ao3x-plan'; box.className = 'ao3x-plan'; c.appendChild(box);
    const rows = plan.map((p, i) => {
      const estIn = p.inTok != null ? p.inTok : 0;
      return `<div class="row"><label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${i}"><span class="checkmark"></span></label><button class="ao3x-btn-mini ao3x-jump-btn" data-block-index="${i}" title="跳转到块 #${i}">📍</button><b>块 #${i}</b><span class="ao3x-small">~${estIn} tokens</span></div>`;
    }).join('');
    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-retry-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">重试选中</button>
      </div>
    `;
    box.innerHTML = `
      <div class="ao3x-plan-header">
        <h4>翻译计划：共 ${plan.length} 块</h4>
        <button class="ao3x-plan-toggle" type="button" title="折叠/展开">▾</button>
      </div>
      <div class="ao3x-plan-body">
        <div class="ao3x-plan-controls">${controls}</div>
        <div class="ao3x-plan-rows">${rows}</div>
        <div class="ao3x-kv" id="ao3x-kv" style="padding:0 16px 12px;"></div>
      </div>
    `;

    // 使用事件委托绑定折叠按钮事件
    box.removeEventListener('click', togglePlanHandler);
    box.addEventListener('click', togglePlanHandler);

    // 绑定控制按钮事件
    bindBlockControlEvents(box);

    // 立即初始化统计显示（同步），避免 setTimeout 覆盖“单块翻译中”的统计
    updateKV({ 进行中: 0, 完成: 0, 失败: 0 });

    PlanStore.clear();
    plan.forEach((p, i) => {
      const wrapper = document.createElement('div'); wrapper.className = 'ao3x-block'; wrapper.setAttribute('data-index', String(i)); wrapper.setAttribute('data-original-html', p.html);
      PlanStore.set(i, p.html);
      const anchor = document.createElement('span'); anchor.className = 'ao3x-anchor'; anchor.setAttribute('data-chunk-id', String(i)); wrapper.appendChild(anchor);
      const div = document.createElement('div'); div.className = 'ao3x-translation'; div.innerHTML = '<span class="ao3x-muted">（待译）</span>';
      wrapper.appendChild(div);
      c.appendChild(wrapper);
    });

    if (typeof ChunkIndicator !== 'undefined' && ChunkIndicator.init) {
      ChunkIndicator.init();
    }
  }
  function appendPlanAnchorsFrom(plan, startIndex) {
    const c = ensureRenderContainer();
    let box = c.querySelector('#ao3x-plan');
    if (!box) { box = document.createElement('div'); box.id = 'ao3x-plan'; box.className = 'ao3x-plan'; c.prepend(box); }

    // 保存当前折叠状态
    const oldBody = box.querySelector('.ao3x-plan-body');
    const wasCollapsed = oldBody && oldBody.classList.contains('collapsed');

    // Update plan header count
    const rows = plan.slice(startIndex).map((p, i) => {
      const idx = startIndex + i;
      const estIn = p.inTok != null ? p.inTok : 0;
      return `<div class="row"><label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${idx}"><span class="checkmark"></span></label><button class="ao3x-btn-mini ao3x-jump-btn" data-block-index="${idx}" title="跳转到块 #${idx}">📍</button><b>块 #${idx}</b><span class="ao3x-small">~${estIn} tokens</span></div>`;
    }).join('');

    const headHtml = `<h4>翻译计划：共 ${plan.length} 块</h4><button class="ao3x-plan-toggle" type="button" title="折叠/展开">${wasCollapsed ? '▸' : '▾'}</button>`;
    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-retry-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">重试选中</button>
      </div>
    `;
    const fixed = Array.from(box.querySelectorAll('.row')).slice(0, startIndex).map(n => n.outerHTML).join('');

    // 不要在这里创建 KV 容器字符串，直接在 innerHTML 中嵌入
    box.innerHTML = `<div class="ao3x-plan-header">${headHtml}</div><div class="ao3x-plan-body${wasCollapsed ? ' collapsed' : ''}"><div class="ao3x-plan-controls">${controls}</div><div class="ao3x-plan-rows">${fixed}${rows}</div><div class="ao3x-kv" id="ao3x-kv" style="padding:0 16px 12px;"></div></div>`;

    // 使用事件委托重新绑定折叠按钮事件
    box.removeEventListener('click', togglePlanHandler);
    box.addEventListener('click', togglePlanHandler);

    // 重新绑定控制按钮事件
    bindBlockControlEvents(box);

    for (let i = startIndex; i < plan.length; i++) {
      if (c.querySelector(`[data-chunk-id="${i}"]`)) continue; // already exists
      const p = plan[i];
      const wrapper = document.createElement('div'); wrapper.className = 'ao3x-block'; wrapper.setAttribute('data-index', String(i)); wrapper.setAttribute('data-original-html', p.html);
      PlanStore.set(i, p.html);
      const anchor = document.createElement('span'); anchor.className = 'ao3x-anchor'; anchor.setAttribute('data-chunk-id', String(i)); wrapper.appendChild(anchor);
      const div = document.createElement('div'); div.className = 'ao3x-translation'; div.innerHTML = '<span class="ao3x-muted">（待译）</span>';
      wrapper.appendChild(div);
      c.appendChild(wrapper);
    }

    if (typeof ChunkIndicator !== 'undefined' && ChunkIndicator.init) {
      ChunkIndicator.init();
    }
  }

  /* ================= Planner helpers (dynamic coalesce) ================= */
  async function coalescePlanForRemaining(plan, startIndex, budgetTokens) {
    // 把“未开始”的块尽量合并，减少请求次数
    const remain = plan.slice(startIndex).map(x => x.html);
    if (!remain.length) return plan;
    const packed = await packIntoChunks(remain, budgetTokens);
    // 重新编号并拼回
    const head = plan.slice(0, startIndex);
    const reindexed = packed.map((p, idx) => ({ ...p, index: head.length + idx }));
    return head.concat(reindexed);
  }

  /* ================= 块选择控制事件绑定 ================= */
  function bindBlockControlEvents(container) {
    const selectAllBtn = container.querySelector('#ao3x-select-all');
    const selectNoneBtn = container.querySelector('#ao3x-select-none');
    const selectInvertBtn = container.querySelector('#ao3x-select-invert');
    const retrySelectedBtn = container.querySelector('#ao3x-retry-selected');

    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = true);
        UI.toast(`已选择 ${checkboxes.length} 个块`);
      });
    }

    if (selectNoneBtn) {
      selectNoneBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);
        UI.toast('已取消全部选择');
      });
    }

    if (selectInvertBtn) {
      selectInvertBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        let selectedCount = 0;
        checkboxes.forEach(cb => {
          cb.checked = !cb.checked;
          if (cb.checked) selectedCount++;
        });
        UI.toast(`已反选，当前选中 ${selectedCount} 个块`);
      });
    }

    if (retrySelectedBtn) {
      retrySelectedBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]:checked');
        const selectedIndices = Array.from(checkboxes).map(cb => {
          const index = cb.getAttribute('data-block-index');
          return parseInt(index, 10);
        }).filter(i => !isNaN(i));

        if (selectedIndices.length === 0) {
          UI.toast('请先选择要重试的块');
          return;
        }

        Controller.retrySelectedBlocks(selectedIndices);
      });
    }

    // 修复：使用事件委托，无论 innerHTML 如何变化都能正常工作
    // 移除旧的事件监听器（如果存在）
    if (container._jumpClickHandler) {
      container.removeEventListener('click', container._jumpClickHandler);
    }

    // 创建新的事件处理器并保存引用
    container._jumpClickHandler = (event) => {
      const jumpBtn = event.target.closest('.ao3x-jump-btn');
      if (!jumpBtn || !container.contains(jumpBtn)) return;
      event.preventDefault();
      const index = Number(jumpBtn.getAttribute('data-block-index'));
      d('jumpBtn:clicked', { index, hasFiniteIndex: Number.isFinite(index) });
      if (!Number.isFinite(index)) return;
      scrollToChunkStart(index);
    };

    container.addEventListener('click', container._jumpClickHandler);
    d('bindBlockControlEvents:bound', { containerId: container.id });
  }

  /* ================= Cache Import/Export Module ================= */
  const CacheManager = {
    // 获取所有翻译缓存
    getAllCaches() {
      const gmKeys = GM_ListKeys().filter(k => typeof k === 'string' && k.startsWith('ao3_translator_'));
      const caches = [];

      for (const key of gmKeys) {
        try {
          const cacheData = GM_Get(key);
          if (cacheData && cacheData._map && Object.keys(cacheData._map).length > 0) {
            caches.push({ key, cache: cacheData });
          }
        } catch (e) {
          console.warn(`[CacheManager] Failed to read cache: ${key}`, e);
        }
      }

      return caches;
    },

    // 导出所有缓存为JSON对象数组
    async exportAllCaches() {
      try {
        const caches = this.getAllCaches();

        if (caches.length === 0) {
          throw new Error('没有可导出的缓存数据');
        }

        const exportData = {
          version: '1.0',
          exportTime: new Date().toISOString(),
          totalCaches: caches.length,
          caches: caches.map(item => ({
            key: item.key,
            url: item.key.replace('ao3_translator_', ''),
            cache: item.cache
          }))
        };

        return exportData;
      } catch (e) {
        console.error('[CacheManager] Export failed:', e);
        throw e;
      }
    },

    // 打包所有缓存为 JSON 并下载
    async downloadCacheAsZip() {
      try {
        UI.toast('正在收集所有缓存...');

        const exportData = await this.exportAllCaches();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `ao3-caches-${timestamp}.json`;

        // 不使用格式化以减小文件大小和加快处理速度
        const jsonStr = JSON.stringify(exportData);
        const fileSizeMB = (jsonStr.length / 1024 / 1024).toFixed(2);

        UI.toast(`正在下载 ${exportData.totalCaches} 个缓存 (${fileSizeMB} MB)...`);

        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });

        // 等待下载完成
        await downloadBlob(blob, filename);

        UI.toast(`成功导出 ${exportData.totalCaches} 个缓存`);
      } catch (e) {
        console.error('[CacheManager] Download failed:', e);
        UI.toast('导出失败：' + e.message);
      }
    },

    // 从 JSON 文件导入所有缓存
    async importCacheFromZip(file) {
      try {
        UI.toast('正在读取文件...');

        const jsonStr = await file.text();
        const importData = JSON.parse(jsonStr);

        // 验证数据格式
        if (!importData.version || !importData.caches) {
          throw new Error('数据格式不正确');
        }

        UI.toast(`找到 ${importData.totalCaches} 个缓存，正在导入...`);

        let imported = 0;
        let failed = 0;

        for (const item of importData.caches) {
          try {
            if (!item.key || !item.cache) {
              failed++;
              continue;
            }

            GM_Set(item.key, item.cache);
            imported++;
          } catch (e) {
            console.error(`[CacheManager] Failed to import cache:`, e);
            failed++;
          }
        }

        if (imported > 0) {
          UI.toast(`导入成功: ${imported} 个缓存${failed > 0 ? `, 失败: ${failed} 个` : ''}`);

          // 如果当前页面的缓存被更新，刷新页面
          const currentKey = `ao3_translator_${window.location.pathname}`;
          if (importData.caches.some(item => item.key === currentKey)) {
            setTimeout(() => {
              location.reload();
            }, 1000);
          }
        } else {
          throw new Error('没有成功导入任何缓存');
        }

      } catch (e) {
        console.error('[CacheManager] Import failed:', e);
        UI.toast('导入失败：' + e.message);
      }
    },

    // WebDAV 上传
    async uploadToWebDAV() {
      try {
        const s = settings.get();
        const webdavConfig = s.webdav;

        if (!webdavConfig || !webdavConfig.url || !webdavConfig.username || !webdavConfig.password) {
          UI.toast('请先配置 WebDAV 设置');
          return;
        }

        UI.toast('正在准备上传...');

        const exportData = await this.exportAllCaches();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `ao3-caches-${timestamp}.json`;

        // 不使用格式化以减小文件大小和加快处理速度
        const jsonStr = JSON.stringify(exportData);
        const fileSizeMB = (jsonStr.length / 1024 / 1024).toFixed(2);

        console.log(`[WebDAV Upload] File size: ${fileSizeMB} MB, ${exportData.totalCaches} caches`);

        const url = `${trimSlash(webdavConfig.url)}/${filename}`;
        const auth = btoa(`${webdavConfig.username}:${webdavConfig.password}`);

        UI.toast(`正在上传 ${exportData.totalCaches} 个缓存 (${fileSizeMB} MB)...`);

        const response = await gmFetch(url, {
          method: 'PUT',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json; charset=utf-8'
          },
          body: jsonStr,
          timeout: 180000 // 3分钟超时，适应大文件
        });

        console.log(`[WebDAV Upload] Response status: ${response.status}`);

        if (!response.ok && response.status !== 201 && response.status !== 204) {
          const errorText = await response.text().catch(() => response.statusText);
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        UI.toast(`已上传 ${exportData.totalCaches} 个缓存到 WebDAV (${filename})`);

      } catch (e) {
        console.error('[CacheManager] WebDAV upload failed:', e);
        UI.toast('上传失败：' + e.message);
      }
    },

    // WebDAV 恢复
    async restoreFromWebDAV() {
      try {
        const s = settings.get();
        const webdavConfig = s.webdav;

        if (!webdavConfig || !webdavConfig.url || !webdavConfig.username || !webdavConfig.password) {
          UI.toast('请先配置 WebDAV 设置');
          return;
        }

        // 显示文件列表对话框
        UI.toast('正在获取 WebDAV 文件列表...');

        const files = await this.listWebDAVFiles(webdavConfig);

        if (files.length === 0) {
          UI.toast('WebDAV 目录为空');
          return;
        }

        // 显示文件选择对话框
        this.showWebDAVFileDialog(files, webdavConfig);

      } catch (e) {
        console.error('[CacheManager] WebDAV restore failed:', e);
        UI.toast('获取文件列表失败：' + e.message);
      }
    },

    // 列出 WebDAV 文件
    async listWebDAVFiles(config) {
      try {
        const url = trimSlash(config.url);
        const auth = btoa(`${config.username}:${config.password}`);

        const response = await gmFetch(url, {
          method: 'PROPFIND',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Depth': '1'
          }
        });

        if (!response.ok && response.status !== 207) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const xml = await response.text();
        console.log('[CacheManager] WebDAV PROPFIND response:', xml);
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'text/xml');

        const files = [];
        // 使用 getElementsByTagNameNS 处理命名空间，兼容不同 WebDAV 服务器
        const responses = doc.getElementsByTagNameNS('DAV:', 'response');
        console.log('[CacheManager] Found responses:', responses.length);

        for (const resp of responses) {
          const hrefElement = resp.getElementsByTagNameNS('DAV:', 'href')[0];
          const href = hrefElement?.textContent || hrefElement?.text;
          console.log('[CacheManager] Processing href:', href);
          // 只支持 .json 文件
          if (href && href.endsWith('.json')) {
            const filename = decodeURIComponent(href.split('/').pop());
            console.log('[CacheManager] Found JSON file:', filename);
            files.push({ filename, href });
          }
        }

        console.log('[CacheManager] Total JSON files found:', files.length);

        // 按时间排序（最新的在前）
        files.sort((a, b) => b.filename.localeCompare(a.filename));

        return files;
      } catch (e) {
        console.error('[CacheManager] List WebDAV files failed:', e);
        throw e;
      }
    },

    // 显示 WebDAV 文件选择对话框
    showWebDAVFileDialog(files, config) {
      const dialog = document.createElement('div');
      dialog.className = 'ao3x-chapter-dialog';

      const fileItems = files.map(file => `
        <label class="ao3x-chapter-item" style="cursor:pointer" data-filename="${escapeHTML(file.filename)}">
          <span>${escapeHTML(file.filename)}</span>
        </label>
      `).join('');

      dialog.innerHTML = `
        <div class="ao3x-chapter-dialog-content">
          <div class="ao3x-chapter-dialog-header">
            <h3>选择要恢复的缓存文件</h3>
            <button class="ao3x-chapter-dialog-close">×</button>
          </div>
          <div class="ao3x-chapter-dialog-body">
            <div class="ao3x-chapter-list" id="ao3x-webdav-file-list">
              ${fileItems}
            </div>
          </div>
          <div class="ao3x-chapter-dialog-footer">
            <button class="ao3x-btn-ghost" id="ao3x-webdav-cancel">取消</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      // 绑定事件
      dialog.querySelector('.ao3x-chapter-dialog-close').addEventListener('click', () => {
        dialog.remove();
      });

      dialog.querySelector('#ao3x-webdav-cancel').addEventListener('click', () => {
        dialog.remove();
      });

      // 文件项点击事件
      dialog.querySelectorAll('.ao3x-chapter-item').forEach(item => {
        item.addEventListener('click', async () => {
          const filename = item.getAttribute('data-filename');
          dialog.remove();
          await this.downloadFromWebDAV(filename, config);
        });
      });
    },

    // 从 WebDAV 下载文件并恢复所有缓存
    async downloadFromWebDAV(filename, config) {
      try {
        UI.toast('正在下载缓存...');

        const url = `${trimSlash(config.url)}/${filename}`;
        const auth = btoa(`${config.username}:${config.password}`);

        const response = await gmFetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${auth}`
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const jsonStr = await response.text();
        const importData = JSON.parse(jsonStr);

        // 验证数据格式
        if (!importData.version || !importData.caches) {
          throw new Error('数据格式不正确');
        }

        UI.toast(`找到 ${importData.totalCaches} 个缓存，正在导入...`);

        let imported = 0;
        let failed = 0;

        for (const item of importData.caches) {
          try {
            if (!item.key || !item.cache) {
              failed++;
              continue;
            }

            GM_Set(item.key, item.cache);
            imported++;
          } catch (e) {
            console.error(`[CacheManager] Failed to import cache:`, e);
            failed++;
          }
        }

        if (imported > 0) {
          UI.toast(`导入成功: ${imported} 个缓存${failed > 0 ? `, 失败: ${failed} 个` : ''}`);

          // 如果当前页面的缓存被更新，刷新页面
          const currentKey = `ao3_translator_${window.location.pathname}`;
          if (importData.caches.some(item => item.key === currentKey)) {
            setTimeout(() => {
              location.reload();
            }, 1000);
          }
        } else {
          throw new Error('没有成功导入任何缓存');
        }

      } catch (e) {
        console.error('[CacheManager] Download from WebDAV failed:', e);
        UI.toast('下载失败：' + e.message);
      }
    },

    // 显示文件选择对话框
    showImportDialog() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importCacheFromZip(file);
        }
      });
      input.click();
    }
  };

  /* ================= Controller ================= */
  const Controller = {
    _isTranslating: false,

    hasTranslationBlocks() {
      const container = document.querySelector('#ao3x-render');
      if (!container) return false;
      return !!container.querySelector('.ao3x-block:not(.ao3x-summary-block)');
    },

    // 获取作品名和章节名
    getWorkInfo() {
      const titleElement = document.querySelector('h2.title.heading');
      const workTitle = titleElement ? titleElement.textContent.trim() : '未知作品';

      // 尝试多种章节名选择器
      const chapterElement = document.querySelector('.chapter.preface.group h3.title a') ||
        document.querySelector('.chapter h3.title a') ||
        document.querySelector('h3.title a');
      const chapterTitle = chapterElement ? chapterElement.textContent.trim() : '未知章节';

      return {
        workTitle: workTitle,
        chapterTitle: chapterTitle
      };
    },

    // 获取当前work的所有已翻译章节
    async getTranslatedChapters() {
      try {
        // 从URL中提取work ID
        const match = window.location.pathname.match(/\/works\/(\d+)/);
        if (!match) return [];

        const workId = match[1];
        const cacheKeyPrefix = `ao3_translator_/works/${workId}/chapters/`;

        // 获取所有缓存键
        const allKeys = GM_ListKeys();
        const chapterKeys = allKeys.filter(key => key.startsWith(cacheKeyPrefix));

        // 提取章节信息
        const chapters = [];
        for (const key of chapterKeys) {
          const chapterId = key.replace(cacheKeyPrefix, '');
          const cacheData = GM_Get(key);

          if (cacheData && cacheData._map && Object.keys(cacheData._map).length > 0) {
            chapters.push({
              id: chapterId,
              url: `/works/${workId}/chapters/${chapterId}`,
              cacheKey: key,
              cacheData: cacheData
            });
          }
        }

        // 按章节ID数字顺序排序
        chapters.sort((a, b) => {
          const numA = parseInt(a.id, 10);
          const numB = parseInt(b.id, 10);
          return numA - numB;
        });

        return chapters;
      } catch (e) {
        console.error('[AO3X] Failed to get translated chapters:', e);
        return [];
      }
    },

    // 批量下载已翻译章节
    async batchDownloadChapters() {
      try {
        UI.toast('正在获取已翻译章节列表...');

        const chapters = await this.getTranslatedChapters();
        if (!chapters || chapters.length === 0) {
          UI.toast('没有找到已翻译的章节');
          return;
        }

        if (chapters.length === 1) {
          UI.toast('只有一个已翻译章节，使用普通下载即可');
          return;
        }

        // 显示章节选择对话框
        this.showChapterSelectionDialog(chapters);

      } catch (e) {
        console.error('[AO3X] Batch download failed:', e);
        UI.toast('批量下载失败：' + e.message);
      }
    },

    // 显示章节选择对话框
    showChapterSelectionDialog(chapters) {
      // 创建对话框
      const dialog = document.createElement('div');
      dialog.className = 'ao3x-chapter-dialog';
      dialog.innerHTML = `
        <div class="ao3x-chapter-dialog-content">
          <div class="ao3x-chapter-dialog-header">
            <h3>选择要下载的章节</h3>
            <button class="ao3x-chapter-dialog-close">×</button>
          </div>
          <div class="ao3x-chapter-dialog-body">
            <div class="ao3x-chapter-controls">
              <button class="ao3x-btn-mini" id="ao3x-chapter-select-all">全选</button>
              <button class="ao3x-btn-mini" id="ao3x-chapter-select-none">取消全选</button>
            </div>
            <div class="ao3x-chapter-list" id="ao3x-chapter-list"></div>
          </div>
          <div class="ao3x-chapter-dialog-footer">
            <button class="ao3x-btn-ghost" id="ao3x-chapter-cancel">取消</button>
            <button class="ao3x-btn-primary" id="ao3x-chapter-download">下载选中章节</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      // 填充章节列表
      const listContainer = dialog.querySelector('#ao3x-chapter-list');
      chapters.forEach((chapter, index) => {
        const item = document.createElement('label');
        item.className = 'ao3x-chapter-item';
        item.innerHTML = `
          <input type="checkbox" value="${chapter.id}" checked>
          <span>Chapter ${chapter.id}</span>
        `;
        listContainer.appendChild(item);
      });

      // 绑定事件
      dialog.querySelector('.ao3x-chapter-dialog-close').addEventListener('click', () => {
        dialog.remove();
      });

      dialog.querySelector('#ao3x-chapter-cancel').addEventListener('click', () => {
        dialog.remove();
      });

      dialog.querySelector('#ao3x-chapter-select-all').addEventListener('click', () => {
        dialog.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
      });

      dialog.querySelector('#ao3x-chapter-select-none').addEventListener('click', () => {
        dialog.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
      });

      dialog.querySelector('#ao3x-chapter-download').addEventListener('click', async () => {
        const selectedIds = Array.from(dialog.querySelectorAll('input[type="checkbox"]:checked'))
          .map(cb => cb.value);

        if (selectedIds.length === 0) {
          UI.toast('请至少选择一个章节');
          return;
        }

        dialog.remove();
        await this.downloadSelectedChapters(chapters.filter(c => selectedIds.includes(c.id)));
      });
    },

    // 下载选中的章节
    async downloadSelectedChapters(selectedChapters) {
      try {
        UI.toast(`正在下载 ${selectedChapters.length} 个章节...`);

        const info = this.getWorkInfo();
        const workTitle = info.workTitle || '作品';

        let fullText = '';

        for (const chapter of selectedChapters) {
          fullText += `\n\n========== Chapter ${chapter.id} ==========\n\n`;

          const cacheData = chapter.cacheData;
          const total = Object.keys(cacheData._map || {}).length;

          for (let i = 0; i < total; i++) {
            const translation = cacheData._map[String(i)];
            if (!translation) continue;

            let plain = '';
            try {
              if (this.extractTextWithStructure) {
                plain = this.extractTextWithStructure(translation) || '';
              } else {
                const div = document.createElement('div');
                div.innerHTML = translation;
                plain = (div.textContent || '').replace(/\r?\n/g, '\n').trim();
              }
            } catch (_) { }

            if (plain) fullText += plain + '\n\n';
          }
        }

        fullText = fullText.trim();
        if (!fullText) {
          UI.toast('翻译内容为空');
          return;
        }

        const fileName = `${workTitle}-批量下载-${selectedChapters.length}章.txt`;

        // 使用与单章下载相同的逻辑
        const s = settings.get();
        const WORKER_ORIGIN = s.download?.workerUrl || '';
        const ua = navigator.userAgent || '';
        const hasEvansToken = /\bEvansBrowser\/\d+(?:\.\d+)*\b/i.test(ua);
        const shouldUseCloud = hasEvansToken;

        if (shouldUseCloud) {
          UI.toast('1/2 上传到云端…');
          const body = new URLSearchParams();
          body.set('text', fullText);
          body.set('filename', fileName);

          const res = await fetch(`${WORKER_ORIGIN}/api/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
          });

          if (!res.ok) {
            const err = await res.text().catch(() => res.statusText);
            UI.toast('上传失败：' + err);
            return;
          }

          const data = await res.json().catch(() => null);
          if (!data || !data.url) {
            UI.toast('上传返回无下载链接');
            return;
          }

          UI.toast('2/2 跳转下载…');
          location.href = data.url;
        } else {
          const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
          downloadBlob(blob, fileName);
          UI.toast(`已下载 ${fileName}`);
        }

      } catch (e) {
        console.error('[AO3X] Download selected chapters failed:', e);
        UI.toast('下载失败：' + e.message);
      }
    },

    // 下载翻译为TXT文件（完整替换此函数）
    downloadTranslation() {
      // 1) 基本检查
      const cacheInfo = TransStore.getCacheInfo && TransStore.getCacheInfo();
      if (!cacheInfo || !cacheInfo.hasCache || !cacheInfo.completed) {
        UI.toast('没有可下载的翻译内容');
        return;
      }

      // 2) 生成文件名
      const info = this.getWorkInfo ? this.getWorkInfo() : {};
      const workTitle = (info && info.workTitle) || '作品';
      const chapterTitle = (info && info.chapterTitle) || '章节';
      const fileName = `${workTitle}-${chapterTitle}.txt`;

      // 3) 汇总正文
      let fullText = '';
      const total = cacheInfo.total || 0;
      for (let i = 0; i < total; i++) {
        const translation = TransStore.get && TransStore.get(String(i));
        if (!translation) continue;

        let plain = '';
        try {
          if (this.extractTextWithStructure) {
            plain = this.extractTextWithStructure(translation) || '';
          } else {
            const div = document.createElement('div');
            div.innerHTML = translation;
            plain = (div.textContent || '').replace(/\r?\n/g, '\n').trim();
          }
        } catch (_) { }
        if (plain) fullText += plain + '\n\n';
      }
      fullText = fullText.trim();
      if (!fullText) {
        UI.toast('翻译内容为空');
        return;
      }

      // 4) EvansBrowser / iOS Safari 家族 → 走云端“两步法”（POST→GET）；其他浏览器保留 Blob
      const s = settings.get();
      const WORKER_ORIGIN = s.download?.workerUrl || '';

      // —— 只针对 EvansBrowser，其他一律走 Blob ——
      // 你给的精确 UA（可留作备用精确等号匹配）
      const EVANS_FULL =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 ' +
        'Mobile/15E148 Safari/604.1 EvansBrowser/1.0';

      const ua = navigator.userAgent || '';

      // 条件1：包含 EvansBrowser/<版本号>（推荐）
      const hasEvansToken = /\bEvansBrowser\/\d+(?:\.\d+)*\b/i.test(ua);

      // 条件2：精确等号匹配整串（可选补充，避免极端裁剪导致 token 丢失时你仍能识别）
      const isExactEvansUA = ua.trim() === EVANS_FULL;

      // 最终：只有 Evans 才用云端两步法
      const shouldUseCloud = hasEvansToken || isExactEvansUA;

      if (shouldUseCloud) {
        // —— 两步法：1) POST 文本到 /api/upload → 2) 跳转到返回的 GET 下载链接 ——
        (async () => {
          try {
            UI.toast('1/2 上传到云端…');
            const body = new URLSearchParams();
            body.set('text', fullText);
            body.set('filename', fileName);

            const res = await fetch(`${WORKER_ORIGIN}/api/upload`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body
            });

            if (!res.ok) {
              const err = await res.text().catch(() => res.statusText);
              UI.toast('上传失败：' + err);
              return;
            }

            const data = await res.json().catch(() => null);
            if (!data || !data.url) {
              UI.toast('上传返回无下载链接');
              return;
            }

            UI.toast('2/2 跳转下载…');
            location.href = data.url; // 导航到 GET 链接触发下载
          } catch (e) {
            UI.toast('异常：' + (e && e.message ? e.message : String(e)));
          }
        })();
        return; // 重要：不要再继续走到 Blob 分支
      }

      // 5) 其他浏览器：使用 Safari 兼容的下载
      try {
        const blob = new Blob([fullText], { type: 'text/plain;charset=utf-8' });
        downloadBlob(blob, fileName);
        UI.toast(`已下载 ${fileName}`);
      } catch (e) {
        UI.toast('本地下载失败：' + (e && e.message ? e.message : String(e)));
      }
    },

    // 智能提取文本，保留段落结构
    extractTextWithStructure(html) {
      // 创建临时DOM元素来解析HTML
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;

      // 递归提取文本，保留段落结构
      const extractText = (element) => {
        let text = '';

        // 处理文本节点
        for (let node of element.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const content = node.textContent.trim();
            if (content) {
              text += content + ' ';
            }
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();

            // 块级元素处理：添加换行
            if (['p', 'div', 'br', 'blockquote', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
              const blockText = extractText(node).trim();
              if (blockText) {
                text += blockText + '\n';
              }
            }
            // 行内元素处理：直接添加文本
            else if (['span', 'strong', 'em', 'i', 'b', 'a', 'code', 'small', 'sub', 'sup'].includes(tagName)) {
              text += extractText(node);
            }
            // 其他元素：递归处理
            else {
              text += extractText(node);
            }
          }
        }

        return text;
      };

      // 提取并清理文本
      let extractedText = extractText(tempDiv);

      // 替换HTML实体字符
      extractedText = extractedText
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      // 清理多余的空格和换行
      extractedText = extractedText
        .replace(/[ \t]+/g, ' ')  // 多个空格/制表符合并为一个空格
        .replace(/\n\s*\n\s*\n/g, '\n\n')  // 多个空行合并为两个换行
        .replace(/\n +\n/g, '\n\n')  // 移除空行中的空格
        .replace(/\s+$/g, '')  // 移除末尾空格
        .replace(/^\s+/g, '');  // 移除开头空格

      return extractedText.trim();
    },

    // 直接应用到已有 DOM（不受顺序指针限制），用于重试/修复历史块
    applyDirect(i, html) {
      const c = document.querySelector('#ao3x-render'); if (!c) return;
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`); if (!anchor) return;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if (!transDiv) { transDiv = document.createElement('div'); transDiv.className = 'ao3x-translation'; anchor.insertAdjacentElement('afterend', transDiv); }
      transDiv.innerHTML = html || '<span class="ao3x-muted">（待译）</span>';
      if (RenderState && RenderState.lastApplied) RenderState.lastApplied[i] = html || '';
    },

    // 收集“未完成/失败”的索引
    collectIncompleteIndices() {
      const total = RenderState.total || 0; const out = [];
      for (let i = 0; i < total; i++) {
        const done = !!(TransStore._done && TransStore._done[i]);
        const html = TransStore.get(String(i)) || '';
        const failed = /\[该段失败：|\[请求失败：/.test(html);
        if (!done || failed || !html) out.push(i);
      }
      return out;
    },

    // 重试选中的块（手动选择）
    async retrySelectedBlocks(selectedIndices) {
      const normalized = Array.from(new Set((selectedIndices || []).map(i => Number(i)).filter(i => Number.isInteger(i) && i >= 0))).sort((a, b) => a - b);
      if (!normalized.length) {
        UI.toast('未选择要重试的块');
        return;
      }

      const s = settings.get();
      const totalSelected = normalized.length;
      UI.toast(`开始重试 ${totalSelected} 个选中块…`);

      const c = document.querySelector('#ao3x-render');
      if (!c) {
        UI.toast('未找到渲染容器');
        return;
      }

      // 彻底清理选中块的所有缓存和状态
      const minIndex = normalized[0];
      normalized.forEach(i => {
        // 清除TransStore中的旧翻译和完成状态
        TransStore.set(String(i), '');
        if (TransStore._done) delete TransStore._done[i];

        // 清理Streamer中的缓冲区
        if (typeof Streamer !== 'undefined' && typeof Streamer.reset === 'function') {
          Streamer.reset(i);
        } else if (typeof Streamer !== 'undefined') {
          Streamer._buf[i] = '';
          Streamer._dirty[i] = false;
        }

        // 重置DOM显示为待译状态
        Controller.applyDirect(i, '<span class="ao3x-muted">（重新翻译中…）</span>');
        const anchorEl = c.querySelector(`[data-chunk-id="${i}"]`);
        if (anchorEl) {
          const transDiv = anchorEl.parentElement.querySelector('.ao3x-translation');
          if (transDiv) transDiv.style.minHeight = '60px';
        }
        if (RenderState && RenderState.lastApplied) {
          RenderState.lastApplied[i] = '';
        }
      });

      if (TransStore && typeof TransStore.saveToCache === 'function') {
        TransStore.saveToCache();
      }

      if (RenderState) {
        if (typeof RenderState.nextToRender === 'number') {
          RenderState.nextToRender = Math.min(RenderState.nextToRender, minIndex);
        } else {
          RenderState.nextToRender = minIndex;
        }
      }

      // 构造子计划（复用 data-original-html）
      const subPlan = normalized.map(i => {
        const block = c.querySelector(`.ao3x-block[data-index="${i}"]`);
        const html = block ? (block.getAttribute('data-original-html') || '') : '';
        const fallback = html || PlanStore.get(i);
        return { index: i, html: fallback };
      });

      const queue = normalized.slice();
      // 状态计数
      let inFlight = 0, completed = 0, failed = 0;
      updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

      const postOne = (idx) => {
        const planItem = subPlan.find(p => p.index === idx);
        if (!planItem || !planItem.html) {
          failed++;
          updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });
          if (queue.length) setTimeout(launchNext, 0);
          return;
        }

        const label = `retry-selected#${idx}`;
        inFlight++;
        updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

        const payload = {
          model: s.model.id,
          messages: buildMessages(
            s.prompt.system,
            s.prompt.userTemplate.replace('{{content}}', planItem.html),
            s.disableSystemPrompt
          ),
          temperature: s.gen.temperature,
          stream: !!s.stream.enabled
        };
        applyMaxTokens(payload, s.gen.maxTokens, s.gen?.omitMaxTokensInRequest);
        applyReasoningEffort(payload, s.translate?.reasoningEffort);

        postChatWithRetry({
          endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
          key: s.api.key,
          payload,
          stream: s.stream.enabled,
          label,
          onAttempt: (attempt) => {
            if (attempt === 1) return;
            if (Streamer && typeof Streamer.reset === 'function') Streamer.reset(idx);
            TransStore.set(String(idx), '');
            if (TransStore._done) delete TransStore._done[idx];
            if (TransStore && typeof TransStore.saveToCache === 'function') {
              TransStore.saveToCache();
            }
            if (RenderState && RenderState.lastApplied) RenderState.lastApplied[idx] = '';
            Controller.applyDirect(idx, '<span class="ao3x-muted">（重试中…）</span>');
          },
          onDelta: (delta) => {
            Streamer.push(idx, delta, (k, clean) => {
              TransStore.set(String(k), clean);
              // 只有当前顺序渲染的块才能实时显示，其他块仅缓存
              if (RenderState.canRender(k)) {
                RenderState.applyIncremental(k, clean);
              }
            });
          },
          onFinishReason: (fr) => {
            d('retry-selected:finish_reason', { idx, fr });
            handleFinishReason(fr, `retry-selected#${idx}`);
          },
          onDone: () => {
            TransStore.markDone(idx);
            inFlight--; completed++;
            Streamer.done(idx, (k, clean) => {
              TransStore.set(String(k), clean);
              // 只有当前顺序渲染的块才能实时显示，其他块仅缓存
              if (RenderState.canRender(k)) {
                RenderState.applyIncremental(k, clean);
              }
            });

            // 若正好轮到该块，也推进一次顺序渲染
            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

            // 检查是否所有选中的块都完成了
            if (completed + failed >= totalSelected) {
              // 清理状态显示，恢复正常显示
              setTimeout(() => {
                const kvElement = document.querySelector('#ao3x-kv');
                if (kvElement) {
                  // 显示总体统计而不是重试统计
                  const totalCompleted = Object.keys(TransStore._done || {}).length;
                  const total = RenderState.total || 0;
                  updateKV({ 已完成: totalCompleted, 总计: total });
                }
                UI.updateToolbarState();
              }, 1000);
            }

            setTimeout(launchNext, 0);
          },
          onError: (e) => {
            inFlight--; failed++;
            const msg = `<p class="ao3x-muted">[重试失败：${e.message}]</p>`;
            TransStore.set(String(idx), msg);
            TransStore.markDone(idx);
            // 只有当前顺序渲染的块才能实时显示，其他块仅缓存
            if (RenderState.canRender(idx)) {
              RenderState.applyIncremental(idx, msg);
            }

            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 重试进行中: inFlight, 重试完成: completed, 重试失败: failed });

            // 检查是否所有选中的块都完成了
            if (completed + failed >= totalSelected) {
              // 清理状态显示，恢复正常显示
              setTimeout(() => {
                const kvElement = document.querySelector('#ao3x-kv');
                if (kvElement) {
                  // 显示总体统计而不是重试统计
                  const totalCompleted = Object.keys(TransStore._done || {}).length;
                  const total = RenderState.total || 0;
                  updateKV({ 已完成: totalCompleted, 总计: total });
                }
                UI.updateToolbarState();
              }, 1000);
            }

            setTimeout(launchNext, 0);
          }
        });
      };

      // 按设置并发数重试选中的块
      const conc = Math.max(1, Math.min(4, s.concurrency || 2));

      const launchNext = () => {
        while (inFlight < conc && queue.length) {
          const nextIdx = queue.shift();
          postOne(nextIdx);
        }
      };

      // 开始处理
      launchNext();

      // 监控完成状态
      const checkCompletion = () => {
        if (completed + failed >= totalSelected) {
          UI.toast(`选中块重试完成：成功 ${completed}，失败 ${failed}`);

          // 最后兜底刷新
          finalFlushAll(RenderState.total || 0);

          // 如果是双语模式且可以渲染，更新双语视图
          try {
            if (View && View.mode === 'bi' && Bilingual.canRender()) {
              View.renderBilingual();
            }
          } catch { }

          return;
        }

        // 如果未完成，继续监控
        setTimeout(checkCompletion, 500);
      };

      // 开始监控完成状态
      setTimeout(checkCompletion, 500);
    },

    // 仅重试未完成/失败的块（断点续传）
    async retryIncomplete() {
      const s = settings.get();
      const indices = this.collectIncompleteIndices();
      if (!indices.length) { UI.toast('没有需要重试的段落'); return; }
      UI.toast(`重试 ${indices.length} 段…`);

      const c = document.querySelector('#ao3x-render'); if (!c) { UI.toast('未找到渲染容器'); return; }

      // 构造子计划（复用 data-original-html）
      const subPlan = indices.map(i => {
        const block = c.querySelector(`.ao3x-block[data-index="${i}"]`);
        const html = block ? (block.getAttribute('data-original-html') || '') : '';
        const fallback = html || PlanStore.get(i);
        return { index: i, html: fallback };
      });

      // 状态计数
      let inFlight = 0, completed = 0, failed = 0;
      updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });

      const postOne = (idx) => {
        // 清理旧状态（允许再次写入）
        TransStore.set(String(idx), '');
        if (TransStore._done) delete TransStore._done[idx];

        const label = `retry#${idx}`;
        inFlight++; updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
        const s = settings.get();
        const payload = {
          model: s.model.id,
          messages: buildMessages(
            s.prompt.system,
            s.prompt.userTemplate.replace('{{content}}', subPlan.find(p => p.index === idx).html),
            s.disableSystemPrompt
          ),
          temperature: s.gen.temperature,
          stream: !!s.stream.enabled
        };
        applyMaxTokens(payload, s.gen.maxTokens, s.gen?.omitMaxTokensInRequest);
        applyReasoningEffort(payload, s.translate?.reasoningEffort);

        postChatWithRetry({
          endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
          key: s.api.key,
          payload,
          stream: s.stream.enabled,
          label,
          onAttempt: (attempt) => {
            if (attempt === 1) return;
            if (Streamer && typeof Streamer.reset === 'function') Streamer.reset(idx);
            TransStore.set(String(idx), '');
            if (TransStore._done) delete TransStore._done[idx];
            if (RenderState && RenderState.lastApplied) RenderState.lastApplied[idx] = '';
            Controller.applyDirect(idx, '<span class="ao3x-muted">（重试中…）</span>');
          },
          onDelta: (delta) => { Streamer.push(idx, delta, (k, clean) => { TransStore.set(String(k), clean); Controller.applyDirect(k, clean); }); },
          onFinishReason: (fr) => {
            d('retry:finish_reason', { idx, fr });
            handleFinishReason(fr, `retry#${idx}`);
          },
          onDone: () => {
            TransStore.markDone(idx);
            inFlight--; completed++;
            Streamer.done(idx, (k, clean) => { TransStore.set(String(k), clean); Controller.applyDirect(k, clean); });
            // 若正好轮到该块，也推进一次顺序渲染
            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
          },
          onError: (e) => {
            inFlight--; failed++;
            const msg = (TransStore.get(String(idx)) || '') + `<p class="ao3x-muted">[该段失败：${e.message}]</p>`;
            TransStore.set(String(idx), msg);
            TransStore.markDone(idx);
            Controller.applyDirect(idx, msg);
            if (RenderState.canRender(idx)) RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
          }
        });
      };

      // 顺序/小并发重试（按设置并发）
      const conc = Math.max(1, Math.min(4, s.concurrency || 2));
      let ptr = 0; let running = 0;
      await new Promise(resolve => {
        const kick = () => {
          while (running < conc && ptr < indices.length) {
            const i = indices[ptr++]; running++;
            postOne(i);
            // 监听完成：通过轮询观察已完成数量
          }
          if (completed + failed >= indices.length) resolve(); else setTimeout(kick, 120);
        };
        kick();
      });

      // 最后兜底刷新与双语视图
      finalFlushAll(RenderState.total || 0);
      try { if (View && View.mode === 'bi' && Bilingual.canRender()) View.renderBilingual(); } catch { }
      UI.toast('重试完成');
      UI.updateToolbarState(); // 更新工具栏状态
    },
    async startTranslate() {
      if (this._isTranslating) {
        UI.toast('翻译任务正在进行中，请勿重复触发');
        return;
      }

      const nodes = collectChapterUserstuffSmart(); if (!nodes.length) { UI.toast('未找到章节正文'); return; }

      const existingContainer = document.querySelector('#ao3x-render');
      if (existingContainer) {
        const existingBlocks = existingContainer.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)');
        if (existingBlocks.length) {
          const hasRenderedTranslation = Array.from(existingBlocks).some(block => {
            const trans = block.querySelector('.ao3x-translation');
            if (!trans) return false;
            const html = (trans.innerHTML || '').trim();
            if (!html) return false;
            const text = (trans.textContent || '').trim();
            return text && !/[（(]待译[)）]/.test(text);
          });
          if (hasRenderedTranslation) {
            UI.toast('当前页面已存在译文，如需重新翻译请先清除缓存或使用重试功能。');
          } else {
            UI.toast('翻译任务已在进行中，请稍候完成后再试。');
          }
          return;
        }
      }
      markSelectedNodes(nodes); renderContainer = null; UI.showToolbar(); View.info('准备中…');

      if (this.hasTranslationBlocks()) {
        UI.toast('已存在译文，如需重新翻译请先清除缓存或重试失败的段落');
        return;
      }

      this._isTranslating = true;
      UI.setTranslateBusy(true);
      try {
        const nodes = collectChapterUserstuffSmart();
        if (!nodes.length) { UI.toast('未找到章节正文'); return; }

        markSelectedNodes(nodes); renderContainer = null; UI.showToolbar(); View.info('准备中…');

        // 重置缓存显示状态，因为现在要开始新的翻译
        View.setShowingCache(false);
        UI.updateToolbarState(); // 更新工具栏状态，重新显示双语对照按钮

        const s = settings.get();
        const allHtml = nodes.map(n => n.innerHTML);
        const fullHtml = allHtml.join('\n');
        const ratio = Math.max(0.3, s.planner?.ratioOutPerIn ?? 0.7);
        const reserve = s.planner?.reserve ?? 384;
        const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

        // 固定prompt token（不含正文）
        const promptTokens = await estimatePromptTokensFromMessages(
          buildMessages(
            s.prompt.system || '',
            (s.prompt.userTemplate || '').replace('{{content}}', ''),
            s.disableSystemPrompt
          )
        );

        const allText = stripHtmlToText(fullHtml);
        const allEstIn = await estimateTokensForText(allText);

        const cw = s.model.contextWindow || 8192;
        const maxT = s.gen.maxTokens || 1024;
        // ★ 核心预算：k<1 时更“能塞”
        // 约束1：out = k * in ≤ max_tokens  → in ≤ max_tokens / k
        // 约束2：prompt + in + out + reserve ≤ cw → in(1+k) ≤ (cw - prompt - reserve)
        const cap1 = maxT / ratio;
        const cap2 = (cw - promptTokens - reserve) / (1 + ratio);
        const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
        const maxInputBudget = Math.floor(maxInputBudgetRaw * packSlack);

        const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
        const canSingle = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

        d('budget', { contextWindow: cw, promptTokens, reserve, userMaxTokens: maxT, ratio, packSlack, maxInputBudget, allEstIn, canSingle });

        // 规划
        let plan = [];
        if (canSingle) {
          const inTok = await estimateTokensForText(allText);
          plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
        } else {
          plan = await packIntoChunks(allHtml, maxInputBudget);
        }
        d('plan', { chunks: plan.length, totalIn: allEstIn, inputBudget: maxInputBudget });

        renderPlanAnchors(plan);
        View.setMode('trans');
        RenderState.setTotal(plan.length);
        Bilingual.setTotal(plan.length);
        updateKV({ 进行中: 0, 完成: 0, 失败: 0 });

        // 运行
        try {
          if (plan.length === 1 && canSingle && (s.planner?.trySingleShotOnce !== false)) {
            View.info('单次请求翻译中…');
            await this.translateSingle({
              endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
              key: s.api.key,
              stream: s.stream.enabled,
              modelCw: s.model.contextWindow,
              ratio,
              promptTokens,
              reserve,
              contentHtml: plan[0].html,
              inTok: plan[0].inTok,
              userMaxTokens: s.gen.maxTokens
            });
            View.clearInfo();
            finalFlushAll(1);
            return;
          }
          View.info('文本较长：已启用智能分段 + 并发流水线…');
          await this.translateConcurrent({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            plan,
            concurrency: s.concurrency,
            stream: s.stream.enabled,
            modelCw: s.model.contextWindow,
            ratio,
            promptTokens,
            reserve,
            userMaxTokens: s.gen.maxTokens
          });
          View.clearInfo();
        } catch (e) {
          d('fatal', e);
          UI.toast('翻译失败：' + e.message);
        }
      } finally {
        this._isTranslating = false;
        UI.setTranslateBusy(false);
      }
    },

    // 单次请求：max_tokens 基于真实 inTok 与 ratio
    async translateSingle({ endpoint, key, stream, modelCw, ratio, promptTokens, reserve, contentHtml, inTok, userMaxTokens }) {
      const predictedOut = Math.ceil(inTok * ratio);
      const outCapByCw = Math.max(256, modelCw - promptTokens - inTok - reserve);
      const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));
      d('single:tokens', { inTok, predictedOut, outCapByCw, userMaxTokens, maxTokensLocal });
      if (maxTokensLocal < 256) throw new Error('上下文空间不足');

      const s = settings.get();
      const i = 0;

      // 更新统计：开始翻译（与并发模式一致）
      let inFlight = 1, completed = 0, failed = 0;
      updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: '0/1', 状态: '翻译中' });

      const payload = {
        model: s.model.id,
        messages: buildMessages(
          s.prompt.system,
          s.prompt.userTemplate.replace('{{content}}', contentHtml),
          s.disableSystemPrompt
        ),
        temperature: s.gen.temperature,
        stream: !!s.stream.enabled
      };
      applyMaxTokens(payload, maxTokensLocal, s.gen?.omitMaxTokensInRequest);
      applyReasoningEffort(payload, s.translate?.reasoningEffort);
      await postChatWithRetry({
        endpoint, key, stream,
        payload,
        label: `single#${i}`,
        onAttempt: (attempt) => {
          if (attempt === 1) return;
          updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/1`, 状态: '重试中', 尝试: `第${attempt}次` });
          if (Streamer && typeof Streamer.reset === 'function') Streamer.reset(i);
          TransStore.set(String(i), '');
          if (TransStore._done) delete TransStore._done[i];
          if (RenderState && RenderState.lastApplied) RenderState.lastApplied[i] = '';
          Controller.applyDirect(i, '<span class="ao3x-muted">（重试中…）</span>');
        },
        onDelta: (delta) => { Streamer.push(i, delta, (k, clean) => { View.setBlockTranslation(k, clean); }); },
        onFinishReason: (fr) => {
          d('finish_reason', { i, fr });
          handleFinishReason(fr, `single#${i}`);
        },
        onDone: async () => {
          // 更新统计：完成
          inFlight = 0; completed = 1;
          updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: '1/1', 状态: '已完成' });

          // 同步获取完整内容，避免异步调度导致的内容丢失
          const finalRaw = Streamer._buf[i] || '';
          const finalHtml = /[<][a-zA-Z]/.test(finalRaw) ? finalRaw : finalRaw.replace(/\n/g, '<br/>');
          const finalClean = sanitizeHTML(finalHtml);

          // 立即保存和渲染完整内容
          TransStore.set(String(i), finalClean);
          TransStore.markDone(i);
          View.setBlockTranslation(i, finalClean);

          RenderState.finalizeCurrent();
          finalFlushAll(1);
          UI.updateToolbarState(); // 更新工具栏状态
          if (View && View.mode === 'bi' && Bilingual && Bilingual.canRender && Bilingual.canRender()) {
            try { View.renderBilingual(); } catch { }
          }
        },
        onError: (e) => {
          inFlight = 0; failed = 1;
          updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/1`, 状态: '失败' });
          // Mark as done with failure note so render can advance and UI不会卡住
          const msg = `<p class="ao3x-muted">[请求失败：${e.message}]</p>`;
          const prev = TransStore.get(String(i)) || '';
          TransStore.set(String(i), prev + msg);
          TransStore.markDone(i);
          View.setBlockTranslation(i, prev + msg);
          RenderState.finalizeCurrent();
          throw e;
        }
      });
    },

    // 分块并发：含动态校准 ratio（首块实测 out/in），对"未启动的块"合包重排，减少请求次数
    async translateConcurrent({ endpoint, key, plan, concurrency, stream, modelCw, ratio, promptTokens, reserve, userMaxTokens }) {
      const N = plan.length;
      RenderState.setTotal(N);
      Bilingual.setTotal(N);

      let inFlight = 0, nextToStart = 0, completed = 0, failed = 0;

      let calibrated = false;
      let liveRatio = ratio; // 运行期实时 ratio
      let currentBudget = Math.floor(Math.max(0, Math.min(userMaxTokens / liveRatio, (modelCw - promptTokens - reserve) / (1 + liveRatio))) * (settings.get().planner.packSlack || 0.95));

      const started = new Set(); // 已经发出的 index

      const startNext = () => { while (inFlight < concurrency && nextToStart < plan.length) { startChunk(nextToStart++); } };

      const startChunk = (i) => {
        started.add(i);
        const inputTok = plan[i].inTok != null ? plan[i].inTok : 0;
        const predictedOut = Math.ceil(inputTok * liveRatio);
        const outCapByCw = Math.max(256, modelCw - promptTokens - inputTok - reserve);
        let maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));
        const label = `chunk#${i}`;
        inFlight++; updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
        const begin = performance.now();
        d('chunk:start', { i, inFlight, nextToStart, nextToRender: RenderState.nextToRender, inputTok, predictedOut, outCapByCw, maxTokensLocal, liveRatio });

        const snapshot = settings.get();
        const payload = {
          model: snapshot.model.id,
          messages: buildMessages(
            snapshot.prompt.system,
            snapshot.prompt.userTemplate.replace('{{content}}', plan[i].html),
            snapshot.disableSystemPrompt
          ),
          temperature: snapshot.gen.temperature,
          stream: !!snapshot.stream.enabled
        };
        applyMaxTokens(payload, maxTokensLocal, snapshot.gen?.omitMaxTokensInRequest);
        applyReasoningEffort(payload, snapshot.translate?.reasoningEffort);

        postChatWithRetry({
          endpoint, key, payload, stream, label,
          onAttempt: (attempt) => {
            if (attempt === 1) return;
            if (Streamer && typeof Streamer.reset === 'function') Streamer.reset(i);
            TransStore.set(String(i), '');
            if (TransStore._done) delete TransStore._done[i];
            if (RenderState && RenderState.lastApplied) RenderState.lastApplied[i] = '';
            Controller.applyDirect(i, '<span class="ao3x-muted">（重试中…）</span>');
          },
          onDelta: (delta) => { Streamer.push(i, delta, (k, clean) => { View.setBlockTranslation(k, clean); }); },
          onFinishReason: async (fr) => {
            d('finish_reason', { i, fr });
            handleFinishReason(fr, `chunk#${i}`);
            if (fr === 'length') {
              // 优先：适度扩大 out，再次尝试一次
              const extra = Math.floor(maxTokensLocal * 0.5);
              const newOutCapByCw = Math.max(256, modelCw - promptTokens - inputTok - reserve);
              const maybe = Math.min(userMaxTokens, newOutCapByCw);
              if (maxTokensLocal + extra <= maybe && extra >= 128) {
                const newMax = maxTokensLocal + extra;
                d('length:increase-max_tokens', { i, from: maxTokensLocal, to: newMax });
                TransStore.set(String(i), ''); // 清空已输出以免重复
                const retrySnapshot = settings.get();
                const retryPayload = {
                  model: retrySnapshot.model.id,
                  messages: buildMessages(
                    retrySnapshot.prompt.system,
                    retrySnapshot.prompt.userTemplate.replace('{{content}}', plan[i].html),
                    retrySnapshot.disableSystemPrompt
                  ),
                  temperature: retrySnapshot.gen.temperature,
                  stream: !!retrySnapshot.stream.enabled
                };
                applyMaxTokens(retryPayload, newMax, retrySnapshot.gen?.omitMaxTokensInRequest);
                applyReasoningEffort(retryPayload, retrySnapshot.translate?.reasoningEffort);
                await postChatWithRetry({
                  endpoint, key, stream, label: `chunk#${i}-retry-max`,
                  payload: retryPayload,
                  onAttempt: (attempt2) => {
                    if (attempt2 === 1) return;
                    if (Streamer && typeof Streamer.reset === 'function') Streamer.reset(i);
                    TransStore.set(String(i), '');
                    if (TransStore._done) delete TransStore._done[i];
                    if (RenderState && RenderState.lastApplied) RenderState.lastApplied[i] = '';
                    Controller.applyDirect(i, '<span class="ao3x-muted">（重试中…）</span>');
                  },
                  onDelta: (delta) => { Streamer.push(i, delta, (k, clean) => { View.setBlockTranslation(k, clean); }); },
                  onFinishReason: (fr2) => {
                    d('finish_reason(second)', { i, fr2 });
                    handleFinishReason(fr2, `chunk#${i}-retry-max`);
                  },
                  onDone: () => { },
                  onError: (e) => { d('length:retry-max error', e); }
                });
              } else {
                // 次选：对该块更细切（一般不会走到这里，因为我们有真实计数）
                d('length:rechunk', { i });
              }
            }
          },
          onDone: async () => {
            inFlight--; completed++;
            d('chunk:done', { i, ms: Math.round(performance.now() - begin) });

            // 同步获取完整内容，避免异步调度导致的内容丢失
            const finalRaw = Streamer._buf[i] || '';
            const finalHtml = /[<][a-zA-Z]/.test(finalRaw) ? finalRaw : finalRaw.replace(/\n/g, '<br/>');
            const finalClean = sanitizeHTML(finalHtml);

            // 立即保存和渲染完整内容
            TransStore.set(String(i), finalClean);
            TransStore.markDone(i);
            View.setBlockTranslation(i, finalClean);

            // 确保最终内容被应用
            if (RenderState.canRender(i)) {
              RenderState.applyIncremental(i, finalClean);
            }

            // ★ 动态校准：首个完成的块，实测 out/in（真实 token）
            if (!calibrated) {
              calibrated = true;
              const outTok = await estimateTokensForText(stripHtmlToText(finalClean));
              const inTok = plan[i].inTok || 1;
              let observedK = outTok / inTok;
              // 限制范围，避免异常
              observedK = Math.min(1.2, Math.max(0.4, observedK));
              if (Math.abs(observedK - liveRatio) > 0.08) {
                liveRatio = (liveRatio * 0.3 + observedK * 0.7); // 比重偏向实测
                currentBudget = Math.floor(Math.max(0, Math.min(userMaxTokens / liveRatio, (modelCw - promptTokens - reserve) / (1 + liveRatio))) * (settings.get().planner.packSlack || 0.95));
                d('calibrate', { observedK, liveRatio, currentBudget });

                // 对“未启动”的部分合包重排，减少请求次数
                const notStartedFrom = nextToStart;
                if (notStartedFrom < plan.length) {
                  const before = plan.slice(0, notStartedFrom);
                  const coalesced = await packIntoChunks(plan.slice(notStartedFrom).map(p => p.html), currentBudget);
                  plan = before.concat(coalesced.map((p, idx) => ({ ...p, index: before.length + idx })));
                  // 仅为未启动部分追加锚点，不重置已有 DOM 和状态
                  appendPlanAnchorsFrom(plan, notStartedFrom);
                  // 仅更新总数，不重置 next 指针
                  if (typeof RenderState !== 'undefined') RenderState.total = plan.length;
                  Bilingual.setTotal(plan.length);
                }
              }
            }

            if (RenderState.canRender(i)) RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
            UI.updateToolbarState(); // 更新工具栏状态
            startNext();
          },
          onError: (e) => {
            inFlight--; failed++;
            d('chunk:error', { i, err: e.message });
            const clean = (TransStore.get(String(i)) || '') + `<p class="ao3x-muted">[该段失败：${e.message}]</p>`;
            TransStore.set(String(i), clean);
            TransStore.markDone(i);
            View.setBlockTranslation(i, clean);
            RenderState.finalizeCurrent();
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed });
            startNext();
          }
        });
      };

      // 启动并发
      startNext();
      // 顺序推进直至全部完成
      while (RenderState.nextToRender < plan.length) { await sleep(80); }
      // 兜底一次：确保没有残留“待译”
      finalFlushAll(plan.length);
      UI.updateToolbarState(); // 更新工具栏状态
      // If in bilingual mode, render paired view now that all are done
      try { if (View && View.mode === 'bi') View.renderBilingual(); } catch { }
    },

    // 只计划不翻译：生成分块计划，但不自动开始翻译
    _planOnlyPlan: null,  // 保存计划供后续翻译使用

    async planOnly() {
      if (this._isTranslating) {
        UI.toast('翻译任务正在进行中，请勿重复触发');
        return;
      }

      const nodes = collectChapterUserstuffSmart();
      if (!nodes.length) {
        UI.toast('未找到章节正文');
        return;
      }

      // 检查是否已存在翻译
      const existingContainer = document.querySelector('#ao3x-render');
      if (existingContainer) {
        const existingBlocks = existingContainer.querySelectorAll('.ao3x-block:not(.ao3x-summary-block)');
        if (existingBlocks.length) {
          const hasRenderedTranslation = Array.from(existingBlocks).some(block => {
            const trans = block.querySelector('.ao3x-translation');
            if (!trans) return false;
            const html = (trans.innerHTML || '').trim();
            if (!html) return false;
            const text = (trans.textContent || '').trim();
            return text && !/[（(]待译[)）]/.test(text);
          });
          if (hasRenderedTranslation) {
            UI.toast('当前页面已存在译文，如需重新计划请先清除缓存');
            return;
          }
        }
      }

      markSelectedNodes(nodes);
      renderContainer = null;
      UI.showToolbar();
      View.info('正在生成分块计划…');

      try {
        const s = settings.get();
        const allHtml = nodes.map(n => n.innerHTML);
        const fullHtml = allHtml.join('\n');
        const ratio = Math.max(0.3, s.planner?.ratioOutPerIn ?? 0.7);
        const reserve = s.planner?.reserve ?? 384;
        const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

        // 固定prompt token（不含正文）
        const promptTokens = await estimatePromptTokensFromMessages(
          buildMessages(
            s.prompt.system || '',
            (s.prompt.userTemplate || '').replace('{{content}}', ''),
            s.disableSystemPrompt
          )
        );

        const allText = stripHtmlToText(fullHtml);
        const allEstIn = await estimateTokensForText(allText);

        const cw = s.model.contextWindow || 8192;
        const maxT = s.gen.maxTokens || 1024;
        const cap1 = maxT / ratio;
        const cap2 = (cw - promptTokens - reserve) / (1 + ratio);
        const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
        const maxInputBudget = Math.floor(maxInputBudgetRaw * packSlack);

        const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
        const canSingle = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

        d('planOnly:budget', { contextWindow: cw, promptTokens, reserve, userMaxTokens: maxT, ratio, packSlack, maxInputBudget, allEstIn, canSingle });

        // 规划
        let plan = [];
        if (canSingle) {
          const inTok = await estimateTokensForText(allText);
          plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
        } else {
          plan = await packIntoChunks(allHtml, maxInputBudget);
        }

        d('planOnly:plan', { chunks: plan.length, totalIn: allEstIn, inputBudget: maxInputBudget });

        // 保存计划供后续翻译使用
        this._planOnlyPlan = plan;

        // 渲染计划面板（带翻译按钮）
        renderPlanAnchorsWithTranslateButtons(plan);
        View.setMode('trans');
        RenderState.setTotal(plan.length);
        Bilingual.setTotal(plan.length);

        // 更新统计显示
        updateKV({ 总块数: plan.length, 状态: '计划完成，可选择翻译' });

        View.clearInfo();
        UI.toast(`分块计划完成：共 ${plan.length} 块，可点击"翻译"按钮翻译指定块`);

      } catch (e) {
        d('planOnly:error', e);
        UI.toast('生成计划失败：' + e.message);
      }
    },

    // 翻译指定的块（用于"只计划"模式下的手动翻译）
    async translateBlocks(blockIndices) {
      if (!blockIndices || !blockIndices.length) {
        UI.toast('请选择要翻译的块');
        return;
      }

      if (this._isTranslating) {
        UI.toast('翻译任务正在进行中，请稍候');
        return;
      }

      const plan = this._planOnlyPlan;
      if (!plan || !plan.length) {
        UI.toast('未找到分块计划，请先执行"只计划"');
        return;
      }

      // 过滤出有效的块索引
      const validIndices = blockIndices.filter(i => i >= 0 && i < plan.length);
      if (!validIndices.length) {
        UI.toast('选择的块索引无效');
        return;
      }

      this._isTranslating = true;
      UI.setTranslateBusy(true);

      try {
        const s = settings.get();
        const totalToTranslate = validIndices.length;

        UI.toast(`开始翻译 ${totalToTranslate} 个块…`);

        // 状态计数
        let inFlight = 0, completed = 0, failed = 0;
        updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 总计: totalToTranslate });

        const c = document.querySelector('#ao3x-render');
        if (!c) {
          UI.toast('未找到渲染容器');
          return;
        }

        // 准备翻译的块
        const queue = [...validIndices];

        const translateOne = (idx) => {
          const planItem = plan[idx];
          if (!planItem || !planItem.html) {
            failed++;
            updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 总计: totalToTranslate });
            launchNext();
            return;
          }

          // 更新UI显示为翻译中
          Controller.applyDirect(idx, '<span class="ao3x-muted">（翻译中…）</span>');

          const label = `block#${idx}`;
          inFlight++;
          updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 总计: totalToTranslate });

          const inputTok = planItem.inTok || 0;
          const ratio = Math.max(0.3, s.planner?.ratioOutPerIn ?? 0.7);
          const reserve = s.planner?.reserve ?? 384;
          const modelCw = s.model.contextWindow || 8192;
          const userMaxTokens = s.gen.maxTokens || 1024;

          // 计算prompt tokens
          const promptTokensEst = 200; // 估算值
          const predictedOut = Math.ceil(inputTok * ratio);
          const outCapByCw = Math.max(256, modelCw - promptTokensEst - inputTok - reserve);
          const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));

          const payload = {
            model: s.model.id,
            messages: buildMessages(
              s.prompt.system,
              s.prompt.userTemplate.replace('{{content}}', planItem.html),
              s.disableSystemPrompt
            ),
            temperature: s.gen.temperature,
            stream: !!s.stream.enabled
          };
          applyMaxTokens(payload, maxTokensLocal, s.gen?.omitMaxTokensInRequest);
          applyReasoningEffort(payload, s.translate?.reasoningEffort);

          postChatWithRetry({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            payload,
            stream: s.stream.enabled,
            label,
            onAttempt: (attempt) => {
              if (attempt === 1) return;
              if (Streamer && typeof Streamer.reset === 'function') Streamer.reset(idx);
              TransStore.set(String(idx), '');
              if (TransStore._done) delete TransStore._done[idx];
              if (RenderState && RenderState.lastApplied) RenderState.lastApplied[idx] = '';
              Controller.applyDirect(idx, '<span class="ao3x-muted">（重试中…）</span>');
            },
            onDelta: (delta) => {
              Streamer.push(idx, delta, (k, clean) => {
                TransStore.set(String(k), clean);
                // 「只计划」模式：直接渲染到对应块，绕过顺序检查
                RenderState.applyDirect(k, clean);
              });
            },
            onFinishReason: (fr) => {
              d('translateBlocks:finish_reason', { idx, fr });
              handleFinishReason(fr, `block#${idx}`);
            },
            onDone: () => {
              inFlight--;
              completed++;

              // 同步获取完整内容
              const finalRaw = Streamer._buf[idx] || '';
              const finalHtml = /[<][a-zA-Z]/.test(finalRaw) ? finalRaw : finalRaw.replace(/\n/g, '<br/>');
              const finalClean = sanitizeHTML(finalHtml);

              // 保存和渲染
              TransStore.set(String(idx), finalClean);
              TransStore.markDone(idx);
              View.setBlockTranslation(idx, finalClean);

              updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 总计: totalToTranslate });
              UI.updateToolbarState();

              // 更新块的翻译按钮状态
              updateBlockTranslateButton(idx, true);

              launchNext();
            },
            onError: (e) => {
              inFlight--;
              failed++;
              d('translateBlocks:error', { idx, err: e.message });

              const clean = `<p class="ao3x-muted">[翻译失败：${e.message}]</p>`;
              TransStore.set(String(idx), clean);
              TransStore.markDone(idx);
              View.setBlockTranslation(idx, clean);

              updateKV({ 进行中: inFlight, 完成: completed, 失败: failed, 总计: totalToTranslate });

              launchNext();
            }
          });
        };

        const conc = Math.max(1, Math.min(4, s.concurrency || 2));

        const launchNext = () => {
          while (inFlight < conc && queue.length) {
            const nextIdx = queue.shift();
            translateOne(nextIdx);
          }

          // 检查是否全部完成
          if (completed + failed >= totalToTranslate && inFlight === 0) {
            UI.toast(`翻译完成：成功 ${completed}，失败 ${failed}`);
            finalFlushAll(plan.length);
            try {
              if (View && View.mode === 'bi' && Bilingual.canRender()) {
                View.renderBilingual();
              }
            } catch { }
          }
        };

        // 开始翻译
        launchNext();

      } finally {
        this._isTranslating = false;
        UI.setTranslateBusy(false);
      }
    }
  };

  // 渲染带翻译按钮的计划面板
  function renderPlanAnchorsWithTranslateButtons(plan) {
    const c = ensureRenderContainer();
    c.innerHTML = '';
    const box = document.createElement('div');
    box.id = 'ao3x-plan';
    box.className = 'ao3x-plan';
    c.appendChild(box);

    const rows = plan.map((p, i) => {
      const estIn = p.inTok != null ? p.inTok : 0;
      return `<div class="row">
        <label class="ao3x-block-checkbox"><input type="checkbox" data-block-index="${i}"><span class="checkmark"></span></label>
        <button class="ao3x-btn-mini ao3x-jump-btn" data-block-index="${i}" title="跳转到块 #${i}">📍</button>
        <b>块 #${i}</b>
        <span class="ao3x-small">~${estIn} tokens</span>
        <button class="ao3x-btn-mini ao3x-translate-block-btn" data-block-index="${i}" title="翻译此块">🌐 翻译</button>
      </div>`;
    }).join('');

    const controls = `
      <div class="ao3x-block-controls">
        <button id="ao3x-select-all" class="ao3x-btn-mini">全选</button>
        <button id="ao3x-select-none" class="ao3x-btn-mini">取消全选</button>
        <button id="ao3x-select-invert" class="ao3x-btn-mini">反选</button>
        <button id="ao3x-translate-selected" class="ao3x-btn-mini ao3x-btn-primary-mini">翻译选中</button>
        <button id="ao3x-translate-all" class="ao3x-btn-mini ao3x-btn-primary-mini">翻译全部</button>
      </div>
    `;

    box.innerHTML = `
      <div class="ao3x-plan-header">
        <h4>翻译计划：共 ${plan.length} 块（只计划模式）</h4>
        <button class="ao3x-plan-toggle" type="button" title="折叠/展开">▾</button>
      </div>
      <div class="ao3x-plan-body">
        <div class="ao3x-plan-controls">${controls}</div>
        <div class="ao3x-plan-rows">${rows}</div>
        <div class="ao3x-kv" id="ao3x-kv" style="padding:0 16px 12px;"></div>
      </div>
    `;

    // 使用事件委托绑定折叠按钮事件
    box.removeEventListener('click', togglePlanHandler);
    box.addEventListener('click', togglePlanHandler);

    // 绑定控制按钮事件
    bindPlanOnlyControlEvents(box);

    // 初始化统计显示
    updateKV({ 总块数: plan.length, 状态: '计划完成' });

    PlanStore.clear();
    plan.forEach((p, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'ao3x-block';
      wrapper.setAttribute('data-index', String(i));
      wrapper.setAttribute('data-original-html', p.html);
      PlanStore.set(i, p.html);

      const anchor = document.createElement('span');
      anchor.className = 'ao3x-anchor';
      anchor.setAttribute('data-chunk-id', String(i));
      wrapper.appendChild(anchor);

      const div = document.createElement('div');
      div.className = 'ao3x-translation';
      div.innerHTML = '<span class="ao3x-muted">（待译 - 点击上方"翻译"按钮开始）</span>';
      wrapper.appendChild(div);

      c.appendChild(wrapper);
    });

    if (typeof ChunkIndicator !== 'undefined' && ChunkIndicator.init) {
      ChunkIndicator.init();
    }
  }

  // 绑定"只计划"模式的控制按钮事件
  function bindPlanOnlyControlEvents(container) {
    const selectAllBtn = container.querySelector('#ao3x-select-all');
    const selectNoneBtn = container.querySelector('#ao3x-select-none');
    const selectInvertBtn = container.querySelector('#ao3x-select-invert');
    const translateSelectedBtn = container.querySelector('#ao3x-translate-selected');
    const translateAllBtn = container.querySelector('#ao3x-translate-all');

    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = true);
        UI.toast(`已选择 ${checkboxes.length} 个块`);
      });
    }

    if (selectNoneBtn) {
      selectNoneBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        checkboxes.forEach(cb => cb.checked = false);
        UI.toast('已取消全部选择');
      });
    }

    if (selectInvertBtn) {
      selectInvertBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]');
        let selectedCount = 0;
        checkboxes.forEach(cb => {
          cb.checked = !cb.checked;
          if (cb.checked) selectedCount++;
        });
        UI.toast(`已反选，当前选中 ${selectedCount} 个块`);
      });
    }

    if (translateSelectedBtn) {
      translateSelectedBtn.addEventListener('click', () => {
        const checkboxes = container.querySelectorAll('.ao3x-block-checkbox input[type="checkbox"]:checked');
        const selectedIndices = Array.from(checkboxes).map(cb => {
          const index = cb.getAttribute('data-block-index');
          return parseInt(index, 10);
        }).filter(i => !isNaN(i));

        if (selectedIndices.length === 0) {
          UI.toast('请先选择要翻译的块');
          return;
        }

        Controller.translateBlocks(selectedIndices);
      });
    }

    if (translateAllBtn) {
      translateAllBtn.addEventListener('click', () => {
        const plan = Controller._planOnlyPlan;
        if (!plan || !plan.length) {
          UI.toast('未找到分块计划');
          return;
        }

        const allIndices = plan.map((_, i) => i);
        Controller.translateBlocks(allIndices);
      });
    }

    // 绑定单个块的翻译按钮事件（使用事件委托）
    if (container._translateBlockHandler) {
      container.removeEventListener('click', container._translateBlockHandler);
    }

    container._translateBlockHandler = (event) => {
      const translateBtn = event.target.closest('.ao3x-translate-block-btn');
      if (!translateBtn || !container.contains(translateBtn)) return;

      event.preventDefault();
      const index = Number(translateBtn.getAttribute('data-block-index'));
      if (!Number.isFinite(index)) return;

      // 检查是否已翻译
      const isDone = TransStore._done && TransStore._done[index];
      if (isDone) {
        UI.toast(`块 #${index} 已翻译完成`);
        return;
      }

      Controller.translateBlocks([index]);
    };

    container.addEventListener('click', container._translateBlockHandler);

    // 绑定跳转按钮事件
    if (container._jumpClickHandler) {
      container.removeEventListener('click', container._jumpClickHandler);
    }

    container._jumpClickHandler = (event) => {
      const jumpBtn = event.target.closest('.ao3x-jump-btn');
      if (!jumpBtn || !container.contains(jumpBtn)) return;
      event.preventDefault();
      const index = Number(jumpBtn.getAttribute('data-block-index'));
      if (!Number.isFinite(index)) return;
      scrollToChunkStart(index);
    };

    container.addEventListener('click', container._jumpClickHandler);
  }

  // 更新块的翻译按钮状态
  function updateBlockTranslateButton(index, isDone) {
    const btn = document.querySelector(`.ao3x-translate-block-btn[data-block-index="${index}"]`);
    if (btn) {
      if (isDone) {
        btn.textContent = '✓ 已译';
        btn.disabled = true;
        btn.classList.add('ao3x-btn-done');
      } else {
        btn.textContent = '🌐 翻译';
        btn.disabled = false;
        btn.classList.remove('ao3x-btn-done');
      }
    }
  }

  /* ================= Summary Storage ================= */
  const SummaryStore = {
    _map: Object.create(null), _done: Object.create(null),
    // 总结为一次性展示：完全取消本地持久化

    initCache() { /* no-op: 不做持久化初始化 */ },
    loadFromCache() { /* no-op */ },
    saveToCache() { /* no-op */ },
    clearCache() { this.clear(); },
    hasCache() { return false; },
    getCacheInfo() { return { hasCache: false, total: 0, completed: 0 }; },

    set(i, content) { this._map[i] = content; },
    get(i) { return this._map[i] || ''; },
    markDone(i) { this._done[i] = true; },
    allDone(total) { for (let k = 0; k < total; k++) { if (!this._done[k]) return false; } return true; },
    clear() { this._map = Object.create(null); this._done = Object.create(null); }
  };

  /* ================= SummaryController ================= */
  const SummaryController = {
    _isActive: false,
    _currentPlan: null,
    _renderState: { nextToRender: 0, total: 0, lastApplied: Object.create(null) },

    // 检查是否可以启动总结
    canStartSummary() {
      const nodes = collectChapterUserstuffSmart();
      return nodes.length > 0;
    },

    // 获取总结配置
    getSummaryConfig() {
      const s = settings.get();
      return {
        system: s.summary?.system || '你是专业的文学内容总结助手。请准确概括故事情节、人物关系和重要事件，保持客观中性的语调。',
        userTemplate: s.summary?.userTemplate || '请对以下AO3章节内容进行剧情总结，重点包括：主要情节发展、角色互动、重要对话或事件。请用简洁明了的中文总结：\n{{content}}\n（请直接返回总结内容，不需要格式化。）',
        ratioTextToSummary: s.summary?.ratioTextToSummary || 0.3
      };
    },

    // 启动总结功能
    async startSummary() {
      // 防抖：短时间重复点击不重复发送
      const now = Date.now();
      this._lastStartAt = this._lastStartAt || 0;
      if (now - this._lastStartAt < 1200) {
        UI.toast('总结已在处理中…');
        return;
      }
      this._lastStartAt = now;
      if (this._isActive) {
        UI.toast('总结功能正在运行中');
        return;
      }

      const nodes = collectChapterUserstuffSmart();
      if (!nodes.length) {
        UI.toast('未找到章节正文');
        return;
      }

      this._isActive = true;
      markSelectedNodes(nodes);
      // 不重置 renderContainer，复用当前容器，且清理旧的总结 UI，避免叠加
      const c = ensureRenderContainer();
      c.querySelectorAll('#ao3x-summary-plan, .ao3x-summary-block').forEach(n => n.remove());
      // 不触发顶栏工具栏，保持与翻译工具栏独立
      View.info('准备总结中…');

      try {
        const s = settings.get();
        const config = this.getSummaryConfig();
        const allHtml = nodes.map(n => n.innerHTML);
        const fullHtml = allHtml.join('\n');

        // 使用总结专用的比例计算分块
        const ratio = config.ratioTextToSummary;
        const reserve = s.planner?.reserve ?? 384;
        const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

        // 计算总结的prompt tokens
        const promptTokens = await estimatePromptTokensFromMessages(
          buildMessages(
            config.system,
            config.userTemplate.replace('{{content}}', ''),
            s.disableSystemPrompt
          )
        );

        const allText = stripHtmlToText(fullHtml);
        const allEstIn = await estimateTokensForText(allText);

        const summaryModelCw = s.summary?.model?.contextWindow || s.model.contextWindow || 8192;
        const summaryMaxTokens = s.summary?.gen?.maxTokens || s.gen.maxTokens || 1024;

        // 总结通常比翻译需要更少的输出token
        const cap1 = summaryMaxTokens / ratio;
        const cap2 = (summaryModelCw - promptTokens - reserve) / (1 + ratio);
        const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
        const maxInputBudget = Math.floor(maxInputBudgetRaw * packSlack);

        const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
        const canSingle = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

        d('summary:budget', { contextWindow: summaryModelCw, promptTokens, reserve, userMaxTokens: summaryMaxTokens, ratio, packSlack, maxInputBudget, allEstIn, canSingle });

        // 创建总结计划
        let plan = [];
        if (canSingle) {
          const inTok = await estimateTokensForText(allText);
          plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
        } else {
          plan = await packIntoChunks(allHtml, maxInputBudget);
        }

        this._currentPlan = plan;
        d('summary:plan', { chunks: plan.length, totalIn: allEstIn, inputBudget: maxInputBudget });

        // 渲染总结计划界面
        this.renderSummaryPlan(plan);
        this.initRenderState(plan.length);

        // 开始总结处理
        if (plan.length === 1 && canSingle) {
          View.info('单次总结中…');
          await this.summarizeSingle({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            stream: s.stream.enabled,
            modelCw: summaryModelCw,
            ratio,
            promptTokens,
            reserve,
            contentHtml: plan[0].html,
            inTok: plan[0].inTok,
            userMaxTokens: summaryMaxTokens,
            config
          });
        } else {
          View.info('文本较长：正在分段总结…');
          await this.summarizeConcurrent({
            endpoint: resolveEndpoint(s.api.baseUrl, s.api.path),
            key: s.api.key,
            plan,
            concurrency: s.concurrency,
            stream: s.stream.enabled,
            modelCw: summaryModelCw,
            ratio,
            promptTokens,
            reserve,
            userMaxTokens: summaryMaxTokens,
            config
          });
        }

        View.clearInfo();
        UI.toast('总结完成');

      } catch (e) {
        d('summary:fatal', e);
        UI.toast('总结失败：' + e.message);
        View.clearInfo();
      } finally {
        this._isActive = false;
      }
    },

    // 渲染总结计划界面
    renderSummaryPlan(plan) {
      const c = ensureRenderContainer();

      // 1. 创建总结计划容器，放在最前面（翻译计划之前）
      let summaryPlanBox = $('#ao3x-summary-plan', c);
      if (!summaryPlanBox) {
        summaryPlanBox = document.createElement('div');
        summaryPlanBox.id = 'ao3x-summary-plan';
        summaryPlanBox.className = 'ao3x-plan';
        // 插入到容器最前面，翻译计划之前
        const existingPlan = $('#ao3x-plan', c);
        if (existingPlan) {
          c.insertBefore(summaryPlanBox, existingPlan);
        } else {
          c.insertBefore(summaryPlanBox, c.firstChild);
        }
      }

      // 保存当前折叠状态
      const oldBody = summaryPlanBox.querySelector('.ao3x-plan-body');
      const wasCollapsed = oldBody && oldBody.classList.contains('collapsed');

      const rows = plan.map((p, i) => {
        const estIn = p.inTok != null ? p.inTok : 0;
        return `<div class="row"><b>段落 #${i}</b><span class="ao3x-small">~${estIn} tokens</span></div>`;
      }).join('');

      summaryPlanBox.innerHTML = `
        <div class="ao3x-plan-header">
          <h4>总结计划：共 ${plan.length} 段</h4>
          <button class="ao3x-plan-toggle" type="button" title="折叠/展开">${wasCollapsed ? '▸' : '▾'}</button>
        </div>
        <div class="ao3x-plan-body${wasCollapsed ? ' collapsed' : ''}">
          <div class="ao3x-plan-rows">${rows}</div>
          <div class="ao3x-kv" id="ao3x-summary-kv" style="padding:0 16px 12px;"></div>
        </div>
      `;

      // 使用事件委托绑定折叠按钮事件
      summaryPlanBox.removeEventListener('click', toggleSummaryPlanHandler);
      summaryPlanBox.addEventListener('click', toggleSummaryPlanHandler);

      // 2. 创建总结内容容器，放在总结计划之后，翻译计划之前
      let summaryContentContainer = $('#ao3x-summary-content-container', c);
      if (!summaryContentContainer) {
        summaryContentContainer = document.createElement('div');
        summaryContentContainer.id = 'ao3x-summary-content-container';
        summaryContentContainer.className = 'ao3x-summary-container';
        // 插入到总结计划之后
        summaryPlanBox.insertAdjacentElement('afterend', summaryContentContainer);
      }

      // 清空总结内容容器（避免重复添加）
      summaryContentContainer.innerHTML = '';

      // 3. 在总结内容容器中创建每个总结块
      plan.forEach((p, i) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'ao3x-block ao3x-summary-block';
        wrapper.setAttribute('data-summary-index', String(i));
        wrapper.setAttribute('data-original-html', p.html);

        const anchor = document.createElement('span');
        anchor.className = 'ao3x-anchor';
        anchor.setAttribute('data-summary-chunk-id', String(i));
        wrapper.appendChild(anchor);

        const div = document.createElement('div');
        div.className = 'ao3x-summary-content';
        div.innerHTML = '<span class="ao3x-muted">（待总结）</span>';
        wrapper.appendChild(div);

        // 将总结块添加到总结内容容器中
        summaryContentContainer.appendChild(wrapper);
      });
    },

    // 初始化总结渲染状态
    initRenderState(total) {
      this._renderState = {
        nextToRender: 0,
        total: total,
        lastApplied: Object.create(null)
      };
    },

    // 检查是否可以渲染指定段落
    canRender(i) {
      return i === this._renderState.nextToRender;
    },

    // 增量应用总结内容到DOM
    applyIncremental(i, cleanContent) {
      const c = ensureRenderContainer();
      const anchor = c.querySelector(`[data-summary-chunk-id="${i}"]`);
      if (!anchor) return;

      let contentDiv = anchor.parentElement.querySelector('.ao3x-summary-content');
      if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.className = 'ao3x-summary-content';
        contentDiv.style.minHeight = '40px'; // 防止跳动
        anchor.insertAdjacentElement('afterend', contentDiv);
      }

      const prev = this._renderState.lastApplied[i] || '';
      const hasPlaceholder = /\(待总结\)/.test(contentDiv.textContent || '');

      // 首次渲染或有占位符时，直接替换全部内容
      if (!prev || hasPlaceholder) {
        contentDiv.innerHTML = cleanContent || '<span class="ao3x-muted">（待总结）</span>';
        this._renderState.lastApplied[i] = cleanContent;
        return;
      }

      // 检查新内容是否与上次完全相同，避免无意义的更新
      if (cleanContent === prev) {
        return;
      }

      // 始终使用全量替换而非增量追加，确保显示完整内容
      // 这避免了增量更新时可能丢失的token片段
      contentDiv.innerHTML = cleanContent;
      this._renderState.lastApplied[i] = cleanContent;
    },

    // 完成当前段落并推进渲染指针
    finalizeCurrent() {
      while (this._renderState.nextToRender < this._renderState.total) {
        const i = this._renderState.nextToRender;

        // 获取当前段落的内容
        const cached = SummaryStore.get(String(i)) || '';
        if (cached) this.applyIncremental(i, cached);

        // 检查是否已完成
        const isDone = !!(SummaryStore._done && SummaryStore._done[i]);
        if (isDone) {
          this._renderState.nextToRender++;
          continue;
        }

        // 当前段落未完成，停止推进
        break;
      }
    },

    // 更新总结状态显示
    updateSummaryKV(kv) {
      const kvElement = document.querySelector('#ao3x-summary-kv');
      if (!kvElement) return;
      kvElement.innerHTML = Object.entries(kv).map(([k, v]) =>
        `<span>${k}: ${escapeHTML(String(v))}</span>`
      ).join('');
    },

    // 单次总结处理
    async summarizeSingle({ endpoint, key, stream, modelCw, ratio, promptTokens, reserve, contentHtml, inTok, userMaxTokens, config }) {
      const predictedOut = Math.ceil(inTok * ratio);
      const outCapByCw = Math.max(256, modelCw - promptTokens - inTok - reserve);
      const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));

      d('summary:single:tokens', { inTok, predictedOut, outCapByCw, userMaxTokens, maxTokensLocal });
      if (maxTokensLocal < 256) throw new Error('上下文空间不足，无法进行总结');

      const s = settings.get();
      const i = 0;
      this.updateSummaryKV({ 状态: '正在总结', 进度: '1/1' });

      const payload = {
        model: s.summary?.model?.id || s.model.id,
        messages: buildMessages(
          config.system,
          config.userTemplate.replace('{{content}}', contentHtml),
          s.disableSystemPrompt
        ),
        temperature: s.summary?.gen?.temperature || s.gen.temperature,
        stream: !!s.stream.enabled
      };
      applyMaxTokens(payload, maxTokensLocal, s.gen?.omitMaxTokensInRequest);
      applyReasoningEffort(payload, s.summary?.reasoningEffort);

      await postChatWithRetry({
        endpoint,
        key,
        stream,
        payload,
        label: `summary-single#${i}`,
        onAttempt: (attempt) => {
          if (attempt === 1) return;
          if (SummaryStreamer && typeof SummaryStreamer.reset === 'function') SummaryStreamer.reset(i);
          SummaryStore.set(String(i), '');
          if (SummaryStore._done) delete SummaryStore._done[i];
          this.applyIncremental(i, '<span class="ao3x-muted">（重试中…）</span>');
        },
        onDelta: (delta) => {
          // 使用专用的 SummaryStreamer，与翻译分离缓冲区
          SummaryStreamer.push(i, delta, (k, clean) => {
            SummaryStore.set(String(k), clean);
            if (this.canRender(k)) {
              this.applyIncremental(k, clean);
            }
          });
        },
        onFinishReason: (fr) => {
          d('summary:single:finish_reason', { i, fr });
          handleFinishReason(fr, `summary-single#${i}`);
        },
        onDone: () => {
          // 同步获取完整内容，避免异步调度导致的内容丢失
          const finalRaw = SummaryStreamer._buf[i] || '';
          const finalHtml = /[<][a-zA-Z]/.test(finalRaw) ? finalRaw : finalRaw.replace(/\n/g, '<br/>');
          const finalClean = sanitizeHTML(finalHtml);

          // 立即保存和渲染完整内容
          SummaryStore.set(String(i), finalClean);
          SummaryStore.markDone(i);

          if (this.canRender(i)) {
            this.applyIncremental(i, finalClean);
          }

          this.finalizeCurrent();
          this.updateSummaryKV({ 状态: '已完成', 进度: '1/1' });
          d('summary:single:completed', { tokens: { in: inTok, maxOut: maxTokensLocal }, finalLength: finalRaw.length });
        },
        onError: (e) => {
          const msg = `<p class="ao3x-muted">[总结失败：${e.message}]</p>`;
          SummaryStore.set(String(i), msg);
          SummaryStore.markDone(i);

          if (this.canRender(i)) {
            this.applyIncremental(i, msg);
          }

          this.finalizeCurrent();
          this.updateSummaryKV({ 状态: '失败', 错误: e.message });

          throw e;
        }
      });
    },

    // 并发分段总结处理
    async summarizeConcurrent({ endpoint, key, plan, concurrency, stream, modelCw, ratio, promptTokens, reserve, userMaxTokens, config }) {
      const N = plan.length;
      this.initRenderState(N);

      let inFlight = 0, nextToStart = 0, completed = 0, failed = 0;
      const startNext = () => {
        while (inFlight < concurrency && nextToStart < plan.length) {
          startChunk(nextToStart++);
        }
      };

      const startChunk = (i) => {
        const inputTok = plan[i].inTok != null ? plan[i].inTok : 0;
        const predictedOut = Math.ceil(inputTok * ratio);
        const outCapByCw = Math.max(256, modelCw - promptTokens - inputTok - reserve);
        const maxTokensLocal = Math.max(256, Math.min(userMaxTokens, outCapByCw, predictedOut));
        const label = `summary-chunk#${i}`;

        inFlight++;
        this.updateSummaryKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/${N}` });

        d('summary:chunk:start', { i, inFlight, nextToStart, inputTok, predictedOut, outCapByCw, maxTokensLocal });

        const snapshot = settings.get();
        const payload = {
          model: snapshot.summary?.model?.id || snapshot.model.id,
          messages: buildMessages(
            config.system,
            config.userTemplate.replace('{{content}}', plan[i].html),
            snapshot.disableSystemPrompt
          ),
          temperature: snapshot.summary?.gen?.temperature || snapshot.gen.temperature,
          stream: !!snapshot.stream.enabled
        };
        applyMaxTokens(payload, maxTokensLocal, snapshot.gen?.omitMaxTokensInRequest);
        applyReasoningEffort(payload, snapshot.summary?.reasoningEffort);

        postChatWithRetry({
          endpoint,
          key,
          payload,
          stream,
          label,
          onAttempt: (attempt) => {
            if (attempt === 1) return;
            if (SummaryStreamer && typeof SummaryStreamer.reset === 'function') SummaryStreamer.reset(i);
            SummaryStore.set(String(i), '');
            if (SummaryStore._done) delete SummaryStore._done[i];
            this.applyIncremental(i, '<span class="ao3x-muted">（重试中…）</span>');
          },
          onDelta: (delta) => {
            // 使用专用的 SummaryStreamer，与翻译分离缓冲区
            SummaryStreamer.push(i, delta, (k, clean) => {
              SummaryStore.set(String(k), clean);
              if (this.canRender(k)) {
                this.applyIncremental(k, clean);
              }
            });
          },
          onFinishReason: (fr) => {
            d('summary:chunk:finish_reason', { i, fr });
            handleFinishReason(fr, `summary-chunk#${i}`);
          },
          onDone: () => {
            inFlight--;
            completed++;

            d('summary:chunk:done', { i });

            // 同步获取完整内容，避免异步调度导致的内容丢失
            const finalRaw = SummaryStreamer._buf[i] || '';
            const finalHtml = /[<][a-zA-Z]/.test(finalRaw) ? finalRaw : finalRaw.replace(/\n/g, '<br/>');
            const finalClean = sanitizeHTML(finalHtml);

            // 立即保存和渲染完整内容
            SummaryStore.set(String(i), finalClean);
            SummaryStore.markDone(i);

            if (this.canRender(i)) {
              this.applyIncremental(i, finalClean);
            }

            this.finalizeCurrent();
            this.updateSummaryKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/${N}` });
            startNext();
          },
          onError: (e) => {
            inFlight--;
            failed++;

            d('summary:chunk:error', { i, err: e.message });

            const msg = `<p class="ao3x-muted">[总结失败：${e.message}]</p>`;
            SummaryStore.set(String(i), msg);
            SummaryStore.markDone(i);

            if (this.canRender(i)) {
              this.applyIncremental(i, msg);
            }

            this.finalizeCurrent();
            this.updateSummaryKV({ 进行中: inFlight, 完成: completed, 失败: failed, 进度: `${completed}/${N}` });
            startNext();
          }
        });
      };

      // 启动并发处理
      startNext();

      // 等待所有分段完成
      while (this._renderState.nextToRender < plan.length) {
        await sleep(80);
      }

      d('summary:concurrent:completed', { total: N, completed, failed });
    }
  };

  // 总结计划折叠按钮处理函数
  function toggleSummaryPlanHandler(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('.ao3x-plan-toggle');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const box = e.currentTarget;
    const body = box.querySelector('.ao3x-plan-body');

    if (body && btn) {
      const isCollapsed = body.classList.toggle('collapsed');
      btn.replaceChildren(document.createTextNode(isCollapsed ? '▸' : '▾'));
      console.log('[toggleSummaryPlanHandler] 折叠状态:', isCollapsed, '按钮文本:', btn.textContent);
    }

    cleanupPlanStrayGlyphText(box);
  }

  /* ================= Streamer（增量 + 有序；含实时快照） ================= */
  const createStreamer = () => ({
    _buf: Object.create(null),
    _dirty: Object.create(null),
    _raf: null,
    _last: 0,
    _accumulated: Object.create(null), // 记录已累积的完整内容，用于去重
    _batchUpdates: new Map(), // 批处理更新
    push(i, delta, apply) {
      // 确保delta不为空
      if (!delta) return;

      // 累积新增内容到缓冲区
      const prevLen = (this._buf[i] || '').length;
      this._buf[i] = (this._buf[i] || '') + delta;

      // 记录已累积的内容，用于后续去重检查
      this._accumulated[i] = this._buf[i];

      this._dirty[i] = true;
      // 收集更新而不是立即触发
      this._batchUpdates.set(i, { k: i, clean: null, apply });
      this.schedule();
    },
    done(i, apply) {
      // 标记为脏，触发最终渲染
      this._dirty[i] = true;
      this._batchUpdates.set(i, { k: i, clean: null, apply });
      this.schedule(true);
    },
    getCleanNow(i) {
      const raw = (this._buf && this._buf[i]) || '';
      if (!raw) return '';
      const html = /[<][a-zA-Z]/.test(raw) ? raw : raw.replace(/\n/g, '<br/>');
      return sanitizeHTML(html);
    },
    reset(i) {
      if (typeof i === 'number') {
        this._buf[i] = '';
        this._dirty[i] = false;
        this._accumulated[i] = '';
        this._batchUpdates.delete(i);
      } else {
        this._buf = Object.create(null);
        this._dirty = Object.create(null);
        this._accumulated = Object.create(null);
        this._batchUpdates.clear();
      }
    },
    schedule(force = false) {
      const { minFrameMs } = (typeof settings !== 'undefined' ? settings.get().stream : { minFrameMs: 40 });
      if (this._raf) return;
      const tick = () => {
        this._raf = null;
        const now = performance.now();
        if (!force && now - this._last < (minFrameMs ?? 40)) {
          this._raf = requestAnimationFrame(tick);
          return;
        }
        this._last = now;

        // 批量处理所有更新
        const updates = Array.from(this._batchUpdates.values());
        this._batchUpdates.clear();

        // 在同一帧内处理所有DOM更新
        for (const { k, apply } of updates) {
          if (!this._dirty[k]) continue;
          const raw = this._buf[k] || '';
          const html = /[<][a-zA-Z]/.test(raw) ? raw : raw.replace(/\n/g, '<br/>');
          const clean = sanitizeHTML(html);
          this._dirty[k] = false;
          apply(Number(k), clean);
        }

        // 如果还有待处理的更新，继续调度
        if (Object.values(this._dirty).some(Boolean) || this._batchUpdates.size > 0) {
          this._raf = requestAnimationFrame(tick);
        }
      };
      this._raf = requestAnimationFrame(tick);
    }
  });

  // Create separate instances for translation and summary
  const Streamer = createStreamer();
  const SummaryStreamer = createStreamer();

  /* ================= 兜底：终局强制刷新 ================= */
  function finalFlushAll(total) {
    const c = document.querySelector('#ao3x-render');
    if (!c) return;
    for (let i = 0; i < total; i++) {
      const html = TransStore.get(String(i)) || '';
      const anchor = c.querySelector(`[data-chunk-id="${i}"]`);
      if (!anchor) continue;
      let transDiv = anchor.parentElement.querySelector('.ao3x-translation');
      if (!transDiv) {
        transDiv = document.createElement('div');
        transDiv.className = 'ao3x-translation';
        anchor.insertAdjacentElement('afterend', transDiv);
      }
      transDiv.innerHTML = html || '<span class="ao3x-muted">（待译）</span>';
      if (RenderState && RenderState.lastApplied) {
        RenderState.lastApplied[i] = html;
      }
    }
    if (settings.get().debug) console.log('[AO3X] drain: flushed all blocks into DOM');

    // 在所有块都刷新到 DOM 后，初始化分块指示器
    if (typeof ChunkIndicator !== 'undefined' && ChunkIndicator.init) {
      ChunkIndicator.init();
    }
  }

  /* ================= 自动加载缓存 ================= */
  async function autoLoadFromCache(nodes, cacheInfo) {
    try {
      // 标记当前正在显示缓存
      View.setShowingCache(true);

      // 收集章节内容并创建翻译计划
      markSelectedNodes(nodes);

      const allHtml = nodes.map(n => n.innerHTML);
      const fullHtml = allHtml.join('\n');

      // 估算token并创建计划
      const s = settings.get();
      const allText = stripHtmlToText(fullHtml);
      const allEstIn = await estimateTokensForText(allText);

      const cw = s.model.contextWindow || 8192;
      const maxT = s.gen.maxTokens || 1024;
      const ratio = Math.max(0.3, s.planner?.ratioOutPerIn ?? 0.7);
      const reserve = s.planner?.reserve ?? 384;
      const packSlack = Math.max(0.5, Math.min(1, s.planner?.packSlack ?? 0.95));

      // 固定prompt token（不含正文）
      const promptTokens = await estimatePromptTokensFromMessages(
        buildMessages(
          s.prompt.system || '',
          (s.prompt.userTemplate || '').replace('{{content}}', ''),
          s.disableSystemPrompt
        )
      );

      const cap1 = maxT / ratio;
      const cap2 = (cw - promptTokens - reserve) / (1 + ratio);
      const maxInputBudgetRaw = Math.max(0, Math.min(cap1, cap2));
      const maxInputBudget = Math.floor(maxInputBudgetRaw * packSlack);

      const slackSingle = s.planner?.singleShotSlackRatio ?? 0.15;
      const canSingle = allEstIn <= maxInputBudget * (1 + Math.max(0, slackSingle));

      // 创建计划（与缓存大小匹配）
      let plan = [];
      if (canSingle) {
        const inTok = await estimateTokensForText(allText);
        plan = [{ index: 0, html: fullHtml, text: allText, inTok }];
      } else {
        plan = await packIntoChunks(allHtml, maxInputBudget);
      }

      // 确保计划长度与缓存匹配
      if (plan.length !== cacheInfo.total) {
        // 如果不匹配，调整计划长度以匹配缓存
        if (plan.length < cacheInfo.total) {
          // 需要分更多块
          const remaining = cacheInfo.total - plan.length;
          for (let i = 0; i < remaining; i++) {
            plan.push({
              index: plan.length + i,
              html: '',
              text: '',
              inTok: 0
            });
          }
        } else {
          // 需要合并块
          plan = plan.slice(0, cacheInfo.total);
        }
      }

      // 渲染计划锚点
      renderPlanAnchors(plan);
      View.setMode('trans');
      RenderState.setTotal(plan.length);
      Bilingual.setTotal(plan.length);

      // 显示工具栏
      UI.showToolbar();

      // 刷新显示以加载缓存内容
      View.refresh(true);

      // 初始化分块指示器（缓存加载完成后）
      if (typeof ChunkIndicator !== 'undefined' && ChunkIndicator.init) {
        ChunkIndicator.init();
      }

      // 更新工具栏状态
      UI.updateToolbarState();

      // 显示提示信息
      UI.toast(`已自动加载 ${cacheInfo.completed}/${cacheInfo.total} 段缓存翻译`);

      if (settings.get().debug) {
        console.log('[AO3X] Auto-loaded cache:', cacheInfo);
      }

    } catch (e) {
      console.error('[AO3X] Failed to auto-load cache:', e);
      UI.toast('自动加载缓存失败');
    }
  }

  /* ================= Boot ================= */
  function init() {
    UI.init();
    applyFontSize(); // 应用初始字体大小设置

    // 不在页面加载时初始化分块指示器，只在翻译完成后初始化
    // ChunkIndicator.init() 会在 drain() 和 autoLoadFromCache() 中调用

    // 初始化翻译缓存
    TransStore.initCache();

    const nodes = collectChapterUserstuffSmart();
    if (!nodes.length) UI.toast('未找到章节正文（请确认页面是否是章节页）');

    // 检查是否有缓存，如果有则自动加载
    const cacheInfo = TransStore.getCacheInfo();
    if (cacheInfo.hasCache) {
      // 延迟一下确保UI已经初始化完成
      setTimeout(() => {
        autoLoadFromCache(nodes, cacheInfo);
      }, 100);
    }

    const mo = new MutationObserver(() => { /* no-op，保留接口 */ });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

})();
