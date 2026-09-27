/**
 * content/dom-wait.js
 * DOM 等待 / 可见性判断 / 时序工具。
 * 关键约束：等待结果必须由「条件满足」决定，绝不使用固定 sleep 作为成功标准。
 *
 * 形态：经典脚本，挂载到 globalThis.AEIIR.domWait。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  var layoutSupport = typeof WeakMap === 'function' ? new WeakMap() : null;

  function sleep(ms, win) {
    var view = win || root;
    var Timer = view.setTimeout || setTimeout;
    var wait = typeof ms === 'number' && ms >= 0 ? ms : 0;
    return new Promise(function (resolve) {
      Timer(resolve, wait);
    });
  }

  function nextTick(win) {
    var view = win || root;
    if (typeof view.requestAnimationFrame === 'function') {
      return new Promise(function (resolve) {
        view.requestAnimationFrame(function () {
          resolve();
        });
      });
    }
    return sleep(0, view);
  }

  /** 当前文档是否具备真实布局信息（jsdom 等无渲染环境下返回 false） */
  function hasLayoutInfo(doc) {
    if (!doc) {
      return false;
    }
    // 只缓存「有布局」的结论：首次调用可能发生在布局完成之前，
    // 缓存 false 会让后续所有可见性判断永久失效。
    if (layoutSupport && layoutSupport.get(doc) === true) {
      return true;
    }
    var result = false;
    try {
      var body = doc.body;
      if (body && typeof body.getBoundingClientRect === 'function') {
        var rect = body.getBoundingClientRect();
        result = !!rect && (rect.width > 0 || rect.height > 0);
      }
    } catch (err) {
      result = false;
    }
    if (result && layoutSupport) {
      layoutSupport.set(doc, true);
    }
    return result;
  }

  /**
   * 可见性判断。
   * 只依据 CSS：display:none / visibility:hidden / hidden 属性 视为不可见。
   * opacity:0 一律视为「存在但可能需要悬停」，不算不可见（需求六）。
   * 尺寸判断仅在文档具备真实布局信息时启用。
   */
  function isVisible(el, win) {
    if (!el || !el.ownerDocument) {
      return false;
    }
    var doc = el.ownerDocument;
    var view = win || doc.defaultView || root;
    if (el.hasAttribute && el.hasAttribute('hidden')) {
      return false;
    }
    var style = null;
    if (view && typeof view.getComputedStyle === 'function') {
      style = view.getComputedStyle(el);
    } else if (el.style) {
      style = el.style;
    }
    if (style) {
      if (style.display === 'none') {
        return false;
      }
      if (style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false;
      }
    }
    if (hasLayoutInfo(doc) && typeof el.getBoundingClientRect === 'function') {
      var rect = el.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return false;
      }
    }
    return true;
  }

  /** opacity 是否为 0（需要 hover 才能显现的场景），用于诊断而非阻断 */
  function hasZeroOpacity(el, win) {
    if (!el || !el.ownerDocument) {
      return false;
    }
    var view = win || el.ownerDocument.defaultView || root;
    if (!view || typeof view.getComputedStyle !== 'function') {
      return false;
    }
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var style = view.getComputedStyle(node);
      if (style && style.opacity === '0') {
        return true;
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      return null;
    }
    var rect = el.getBoundingClientRect();
    if (!rect) {
      return null;
    }
    return rect;
  }

  function isDegenerateRect(rect) {
    return !rect || (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0);
  }

  function centerOf(el) {
    var rect = rectOf(el);
    if (isDegenerateRect(rect)) {
      return null;
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** 元素中心点距离；布局不可用时返回 null */
  function centerDistance(a, b) {
    var ca = centerOf(a);
    var cb = centerOf(b);
    if (!ca || !cb) {
      return null;
    }
    return Math.sqrt(Math.pow(ca.x - cb.x, 2) + Math.pow(ca.y - cb.y, 2));
  }

  /** DOM 树距离（LCA 路径长度），布局不可用时的兜底判据 */
  function ancestorsOf(node) {
    var chain = [];
    var current = node;
    while (current) {
      chain.push(current);
      current = current.parentNode;
    }
    return chain;
  }

  function domDistance(a, b) {
    if (!a || !b) {
      return Number.POSITIVE_INFINITY;
    }
    if (a === b) {
      return 0;
    }
    var chainA = ancestorsOf(a);
    var chainB = ancestorsOf(b);
    for (var i = 0; i < chainA.length; i += 1) {
      var indexB = chainB.indexOf(chainA[i]);
      if (indexB !== -1) {
        return i + indexB;
      }
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * 条件等待：MutationObserver + 定时轮询双保险。
   * options:
   *   doc, win, stage, description
   *   timeout（默认 8000ms）, pollInterval（默认 120ms）
   *   check(): { done?: boolean, value?: any, abort?: boolean, status?: string, snapshot?: any }
   * 返回（resolve，不 reject）:
   *   { ok, timedOut, aborted, status, value, snapshot, elapsed, polls, description, stage }
   */
  function waitFor(options) {
    var opts = options || {};
    var doc = opts.doc || root.document;
    var win = opts.win || (doc && doc.defaultView) || root;
    var timeout = typeof opts.timeout === 'number' ? opts.timeout : 8000;
    var pollInterval = typeof opts.pollInterval === 'number' ? opts.pollInterval : 120;
    var check = opts.check;
    var description = opts.description || '等待条件满足';
    var stage = opts.stage || 'WAIT_IMAGE_REMOVED';
    var observeTarget = opts.observeTarget || doc;
    var startedAt = Date.now();

    if (typeof check !== 'function') {
      return Promise.resolve({
        ok: false,
        timedOut: false,
        aborted: true,
        status: 'INTERNAL_ERROR',
        description: description,
        stage: stage,
        elapsed: 0,
        polls: 0,
        snapshot: { reason: 'waitFor 缺少 check 回调' }
      });
    }

    return new Promise(function (resolve) {
      var finished = false;
      var polls = 0;
      var lastSnapshot = null;
      var timer = null;
      var interval = null;
      var observer = null;

      function cleanup() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        if (observer && typeof observer.disconnect === 'function') {
          observer.disconnect();
          observer = null;
        }
      }

      function finish(result) {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        resolve(Object.assign({
          description: description,
          stage: stage,
          elapsed: Date.now() - startedAt,
          polls: polls,
          snapshot: lastSnapshot
        }, result));
      }

      function evaluate() {
        if (finished) {
          return;
        }
        polls += 1;
        var outcome = null;
        try {
          outcome = check();
        } catch (err) {
          finish({
            ok: false,
            timedOut: false,
            aborted: true,
            status: 'INTERNAL_ERROR',
            error: err && err.message ? err.message : String(err)
          });
          return;
        }
        if (!outcome || typeof outcome !== 'object') {
          return;
        }
        if (outcome.snapshot !== undefined) {
          lastSnapshot = outcome.snapshot;
        }
        if (outcome.abort) {
          finish({
            ok: false,
            timedOut: false,
            aborted: true,
            status: outcome.status || 'ABORTED',
            value: outcome.value,
            message: outcome.message,
            diagnostics: outcome.diagnostics
          });
          return;
        }
        if (outcome.done) {
          finish({
            ok: true,
            timedOut: false,
            aborted: false,
            value: outcome.value,
            diagnostics: outcome.diagnostics
          });
        }
      }

      var Observer = win && win.MutationObserver;
      if (!Observer && typeof MutationObserver !== 'undefined') {
        Observer = MutationObserver;
      }
      if (Observer && observeTarget && typeof Observer === 'function') {
        observer = new Observer(function () {
          evaluate();
        });
        observer.observe(observeTarget, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });
      }

      interval = setInterval(evaluate, pollInterval);
      timer = setTimeout(function () {
        finish({ ok: false, timedOut: true, aborted: false, status: 'WAIT_TIMEOUT' });
      }, timeout);

      evaluate();
    });
  }

  NS.domWait = {
    sleep: sleep,
    nextTick: nextTick,
    isVisible: isVisible,
    hasZeroOpacity: hasZeroOpacity,
    hasLayoutInfo: hasLayoutInfo,
    rectOf: rectOf,
    centerOf: centerOf,
    centerDistance: centerDistance,
    isDegenerateRect: isDegenerateRect,
    domDistance: domDistance,
    waitFor: waitFor
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
