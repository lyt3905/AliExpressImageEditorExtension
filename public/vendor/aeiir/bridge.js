/**
 * vendor/aeiir/bridge.js
 * 页面回填桥。
 *
 * 由 service worker 用 chrome.scripting.executeScript 注入到「持有商品图片控件
 * （或上传面板）的那个 frame」，注入顺序固定在它前面的是姊妹项目的 6 个库文件
 * （shared/messages|errors|validation、content/dom-wait|upload-locator|file-injector）。
 * 之所以原样复用那套库而不是移植：它们已经用真实卖家后台跑通并覆盖了图标/拖拽区/
 * 文件输入框/确认按钮的定位与「注入后自证」，重写一遍只会引入新的偏差。
 *
 * 与姊妹项目的差别有三点，都是本项目特有的：
 *   1. **默认追加**：新图必须落在「尚未占用的槽位」上，因此上传按钮的挑选优先空槽位
 *      （见 chooseUploadButton）。
 *   2. **可选删图**：payload.removeFirstImage 为真时，先把第 1 张旧图删掉腾出空位
 *      （见 removeFirstImage）。删图是破坏性操作，所以默认由调用方显式开启，且**只有
 *      第一次尝试才带这个标志** —— 跨 frame 重试再删一次就会误删第 2 张。
 *   3. **跨 frame 重试**：面板可能不在本 frame 出现。此时回报
 *      UPLOAD_PANEL_NOT_FOUND，由 service worker 换 frame 再执行一次
 *      （openPanel=false，避免重复点击上传按钮）。
 *
 * 红线：只点上传面板内部的「确认上传」，绝不点商品级「保存 / 发布 / 提交」。
 * 除此之外唯一会改动商品页数据的动作是用户显式要求的「删除第 1 张图」，
 * 它只点那一个删除图标，失败就停（见 removeFirstImage）。
 *
 * 形态：经典脚本（classic script），挂载到 globalThis.AEIIR。ESM 在
 * executeScript 的 files 注入路径下不可用。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  /**
   * service worker -> 本桥。
   * 刻意不复用姊妹项目的 MESSAGE_TYPES：那是它自己的信封，而本桥是从外部注入的
   * 独立脚本，不该混进 content-script.ts 的类型白名单。
   */
  var MESSAGE_TYPE = 'AIEE_PAGE_FILL_EXECUTE';

  /** 点击上传按钮后，等待上传面板出现的上限。 */
  var DEFAULT_PANEL_TIMEOUT = 8000;
  /** 等待「确认上传」按钮可点击、以及点击后等待面板关闭的上限。 */
  var DEFAULT_CONFIRM_TIMEOUT = 8000;
  /** 等待上传完成（服务端信号）的上限。 */
  var DEFAULT_UPLOAD_TIMEOUT = 25000;
  /** 点击旧图的删除图标后，等待它从图片区消失的上限。 */
  var DEFAULT_DELETE_TIMEOUT = 8000;

  var STAGE_LABELS = {
    FIND_DELETE_BUTTON: '定位删除按钮',
    DELETE_IMAGE: '点击删除',
    WAIT_IMAGE_REMOVED: '确认旧图已移除',
    OPEN_PANEL: '打开上传面板',
    FIND_DROP_ZONE: '定位上传面板',
    FIND_FILE_INPUT: '定位文件输入框',
    INJECT_FILE: '注入图片文件',
    WAIT_UPLOAD: '等待上传结果',
    CONFIRM_UPLOAD: '确认上传'
  };

  var SLOT_SELECTOR = '.sell-o-image-item';
  var IMAGE_CARD_SELECTOR = 'div.image-card';
  /** 商品图片控件的外层容器，用来把槽位统计收敛到图片区（排除页面别处的同名节点）。 */
  var SLOT_ROOT_SELECTOR = '.imageUploadWrap';
  /** 已占用槽位上的「删除」小图标。 */
  var REMOVE_ICON_SELECTOR = '.image-upload-remove';
  /**
   * 删除图标的 SVG path 特征（真机为 `M601.344 73.984 ...`）。
   * 类名被改版改掉时靠它兜底；因为只在「第一个已占用槽位」内部找，
   * 不会误点到别的图片的删除图标。
   */
  var REMOVE_ICON_PATH_PREFIX = 'M601.344 73.984';

  // 幂等守卫：跨 frame 重试会重复注入同一组脚本，不守卫就会重复注册 onMessage。
  if (NS.__pageFillBridgeInstalled === true) {
    return;
  }

  var messagesModule = NS.messages;
  var domWait = NS.domWait;
  var uploadLocator = NS.uploadLocator;
  var fileInjector = NS.fileInjector;

  if (!messagesModule || !domWait || !uploadLocator || !fileInjector) {
    // 库文件缺失说明注入顺序被打乱，这种状态绝不能装作可用。
    NS.__pageFillBridgeError = 'AEIIR 库未加载完整，无法回填';
    return;
  }

  // ---------------------------------------------------------------- 基础动作

  /**
   * 构造事件要用的 window，取不到就返回 null（那就不带 view）。
   *
   * 优先取「节点自己的 ownerDocument.defaultView」而不是调用方传进来的 win：
   * 事件本来就该由节点所在的 realm 构造，而 win 只是个来路不明的全局对象。
   */
  function eventViewFor(target, win) {
    var fromNode = target && target.ownerDocument ? target.ownerDocument.defaultView : null;
    if (fromNode && typeof fromNode.MouseEvent === 'function') {
      return fromNode;
    }
    if (win && win.document && typeof win.MouseEvent === 'function') {
      return win;
    }
    if (root && root.document && typeof root.MouseEvent === 'function') {
      return root;
    }
    return null;
  }

  /**
   * 点击元素：优先原生 click()，SVG 等无 click() 时派发完整指针序列。
   *
   * SVGElement 没有 click()（click() 只定义在 HTMLElement 上），所以「类名改版后按
   * path 兜底找到的删除图标」会落到派发分支 —— 这条路必须走得通。
   */
  function clickElement(target, win) {
    var used = [];
    if (typeof target.click === 'function') {
      target.click();
      used.push('element.click()');
      return used;
    }

    var view = eventViewFor(target, win);
    var MouseEventCtor = (view && view.MouseEvent) || (root && root.MouseEvent);
    if (typeof MouseEventCtor !== 'function') {
      throw new Error('无法为 <' + ((target && target.tagName) || '?') + '> 构造事件：这个环境里没有 MouseEvent');
    }

    // MouseEventInit.view 的类型是 Window?，传进去的对象只要不是真正的 window
    // 就会抛 `member view is not of type Window`（jsdom 尤其严格：只认 window 的
    // global proxy）。view 只是事件上的一个便利字段，没有它浏览器照样派发、页面照样
    // 响应 —— 所以这里先探一次，不行就整体退到不带 view 的形态，
    // 绝不让一次点击因为少个字段而整个失败。
    var useView = !!view;
    if (useView) {
      try {
        new MouseEventCtor('click', { bubbles: true, cancelable: true, composed: true, view: view, detail: 1 });
      } catch (err) {
        useView = false;
      }
    }

    var sequence = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < sequence.length; i += 1) {
      var name = sequence[i];
      var init = { bubbles: true, cancelable: true, composed: true, detail: 1 };
      if (useView) {
        init.view = view;
      }
      target.dispatchEvent(new MouseEventCtor(name, init));
      used.push(useView ? name : name + '(no-view)');
    }
    return used;
  }

  /**
   * 上传按钮所属的「槽位」。
   * 卖家后台用 .sell-o-image-item；老版式只有 div.image-card，退化为它的父结点
   * （按钮通常和卡片同级挂在同一个容器里）。
   */
  function slotOf(button) {
    if (!button || typeof button.closest !== 'function') {
      return null;
    }
    var slot = button.closest(SLOT_SELECTOR);
    if (slot) {
      return slot;
    }
    var card = button.closest(IMAGE_CARD_SELECTOR);
    return card ? card.parentElement || card : null;
  }

  /**
   * 槽位是否已被占用。
   * 判据与 content/image-scanner.ts 的 isFilledSlot 保持一致（has-url 类，或槽内
   * 确实有一张带 URL 的 <img>），这样「扫描到的图」和「判定为空槽」不会互相矛盾。
   */
  function isFilledSlot(slot) {
    if (!slot) {
      return false;
    }
    try {
      if (slot.classList && slot.classList.contains('has-url')) {
        return true;
      }
    } catch (err) {
      /* ignore */
    }
    var images = slot.querySelectorAll ? slot.querySelectorAll('img') : [];
    for (var i = 0; i < images.length; i += 1) {
      var src = '';
      try {
        src = images[i].currentSrc || images[i].src || images[i].getAttribute('src') || '';
      } catch (err2) {
        /* ignore */
      }
      if (src) {
        return true;
      }
    }
    return false;
  }

  /**
   * 挑选要点击的上传按钮。
   *
   * 追加语义：速卖通删掉第 1 张图后，后面的图会自动前移，所以「新建一张」必须落在
   * 空槽位上。优先可见按钮中第一个挂在空槽位上的；一个空槽位都没有时退化为第 0 个，
   * 并把 degraded 标出来 —— 那种情况下很可能覆盖已有图片，必须让用户看见。
   */
  function chooseUploadButton(survey) {
    var visible = (survey && survey.visibleItems) || [];
    var empty = [];
    var filled = [];
    for (var i = 0; i < visible.length; i += 1) {
      var item = visible[i];
      if (isFilledSlot(slotOf(item.element))) {
        filled.push(item);
      } else {
        empty.push(item);
      }
    }
    var pool = empty.length ? empty : filled;
    if (!pool.length) {
      return null;
    }
    return {
      item: pool[0],
      degraded: empty.length === 0,
      emptyCount: empty.length,
      filledCount: filled.length,
      buttonTexts: visible.map(function (entry) {
        return entry.text;
      })
    };
  }

  /**
   * 图片区的槽位占用情况。
   *
   * 真实页面**只在空槽位上**渲染 div.image-upload-btn（已占用槽位只有
   * image-upload-edit / image-upload-remove 两个 SVG 图标）。所以「一个可见按钮都没有」
   * 有两种完全不同的原因，必须分开说：
   *   - 槽位全满 -> 用户要先去删一张（不是「去打开上传面板」）
   *   - 页面改版 / 面板没渲染 -> 才让人手动打开面板
   * 给错指引会让用户去找一个根本不存在的东西。
   *
   * 统计范围收敛到 .imageUploadWrap：页面别处（例如 SKU 模块）也有
   * .sell-o-image-item，不收敛就会把无关槽位算进来，导致「已满」永远判不出来。
   */
  function surveySlots(doc) {
    var slots = slotsOf(doc);
    var filled = 0;
    for (var i = 0; i < slots.length; i += 1) {
      if (isFilledSlot(slots[i])) {
        filled += 1;
      }
    }
    return { total: slots.length, filled: filled };
  }

  // ---------------------------------------------------------------- 删掉第 1 张旧图

  /** 商品图片区的根节点。删图路径要求严格，找不到就返回 null（不回退到整个文档）。 */
  function imageAreaOf(doc) {
    if (!doc || !doc.querySelector) {
      return null;
    }
    try {
      return doc.querySelector(SLOT_ROOT_SELECTOR) || null;
    } catch (err) {
      return null;
    }
  }

  function slotsWithin(root) {
    if (!root || !root.querySelectorAll) {
      return [];
    }
    return Array.prototype.slice.call(root.querySelectorAll(SLOT_SELECTOR));
  }

  /** 图片区内的全部槽位（按 DOM 顺序）。 */
  function slotsOf(doc) {
    return slotsWithin(imageAreaOf(doc) || doc);
  }

  /** 槽位里第一张有 URL 的图片地址；没有则空串。 */
  function imageUrlOf(slot) {
    var images = slot && slot.querySelectorAll ? slot.querySelectorAll('img') : [];
    for (var i = 0; i < images.length; i += 1) {
      var src = '';
      try {
        src = images[i].currentSrc || images[i].src || images[i].getAttribute('src') || '';
      } catch (err) {
        src = '';
      }
      if (src) {
        return src;
      }
    }
    return '';
  }

  /** 槽位的可读名称（「商品正面图」这类），只用于回报。 */
  function slotLabelOf(slot) {
    var header = slot && slot.querySelector ? slot.querySelector('.header-text') : null;
    var text = header && header.textContent ? header.textContent.trim() : '';
    return text || '(未命名)';
  }

  var HOVER_EVENTS = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'];

  /**
   * 把指针「移」到槽位上。
   *
   * 已占用槽位上的编辑 / 删除图标很可能是 hover 才渲染的（真机上是 .image-tools）。
   * 程序化 click 本身不受 CSS 隐藏影响，但**节点得先在 DOM 里**，所以先把 hover 事件派出去。
   */
  function hoverSlot(slot, win) {
    var view = win || (slot && slot.ownerDocument && slot.ownerDocument.defaultView) || root;
    var used = [];
    for (var i = 0; i < HOVER_EVENTS.length; i += 1) {
      var name = HOVER_EVENTS[i];
      var event = null;
      try {
        var Ctor = name.indexOf('pointer') === 0 && view.PointerEvent ? view.PointerEvent : view.MouseEvent;
        event = Ctor
          ? new Ctor(name, { bubbles: true, cancelable: true, composed: true, view: view, detail: 1 })
          : new view.Event(name, { bubbles: true, cancelable: true, composed: true });
      } catch (err) {
        event = null;
      }
      if (!event) {
        continue;
      }
      slot.dispatchEvent(event);
      used.push(name);
    }
    return used;
  }

  /**
   * 槽位里的删除图标。先按类名找，再按 SVG path 特征兜底（改版把类名换掉的情况）。
   * 搜索范围永远是「某一个槽位内部」，所以不会误点到别的图片的删除图标。
   */
  function findRemoveIcon(slot) {
    if (!slot || !slot.querySelector) {
      return null;
    }
    var byClass = null;
    try {
      byClass = slot.querySelector(REMOVE_ICON_SELECTOR);
    } catch (err) {
      byClass = null;
    }
    if (byClass) {
      return byClass;
    }
    var paths = slot.querySelectorAll ? slot.querySelectorAll('svg path') : [];
    for (var i = 0; i < paths.length; i += 1) {
      var d = '';
      try {
        d = paths[i].getAttribute('d') || '';
      } catch (err2) {
        d = '';
      }
      if (d.indexOf(REMOVE_ICON_PATH_PREFIX) === 0) {
        // 点 svg>path 不稳定，往上找它所在的可点击图标元素。
        var node = paths[i];
        for (var up = 0; up < 4 && node; up += 1) {
          var tag = node.tagName ? String(node.tagName).toLowerCase() : '';
          if (tag === 'svg' || (node.classList && node.classList.contains('anticon'))) {
            return node;
          }
          node = node.parentElement;
        }
        return paths[i];
      }
    }
    return null;
  }

  /**
   * 删掉图片区里的第 1 张图，给新图腾出空位。
   *
   * 这是本项目唯一会删除商品数据的地方，所以刻意做得「宁可停下也不猜」：
   *   - 只取图片区内的**第一个已占用槽位**（真机上删除后后面的图会前移，
   *     所以不能指望删完第 0 槽就空着）；
   *   - 删除图标找不到就失败停止，绝不退化成点别的按钮；
   *   - 点完必须确认占用数真的少了，否则报超时 —— 真机删除可能弹二次确认框，
   *     盲目去点「确定」是另一类风险，交给人工。
   */
  async function removeFirstImage(doc, win, options) {
    var opts = options || {};
    var recorder = opts.recorder;
    var timeout = opts.timeout > 0 ? opts.timeout : DEFAULT_DELETE_TIMEOUT;
    var area = imageAreaOf(doc);
    if (!area) {
      recorder.fail('FIND_DELETE_BUTTON', 'IMAGE_AREA_NOT_FOUND',
        '页面上没有找到商品图片区（' + SLOT_ROOT_SELECTOR + '），无法确定要删哪一张，已停止',
        { rootSelector: SLOT_ROOT_SELECTOR });
      return { ok: false, failure: recorder.failure() };
    }

    var before = surveySlots(doc);
    var slots = slotsWithin(area);
    var target = null;
    var targetIndex = -1;
    for (var i = 0; i < slots.length; i += 1) {
      if (isFilledSlot(slots[i])) {
        target = slots[i];
        targetIndex = i;
        break;
      }
    }
    if (!target) {
      recorder.ok('FIND_DELETE_BUTTON', '图片区没有已占用的槽位，无需删除', {
        slotCount: before.total,
        filledSlotCount: before.filled
      });
      return { ok: true, removed: null, skipped: true };
    }

    var label = slotLabelOf(target);
    var url = imageUrlOf(target);
    var hovered = hoverSlot(target, win);

    // 图标可能 hover 后才渲染，所以派完事件还要等它一下（真机上通常在几十毫秒内出现）。
    var found = await domWait.waitFor({
      doc: doc,
      win: win,
      stage: 'FIND_DELETE_BUTTON',
      description: '等待第 1 张图的删除图标出现',
      timeout: timeout,
      pollInterval: 120,
      observeTarget: target,
      check: function () {
        var node = findRemoveIcon(target);
        var snapshot = {
          slotIndex: targetIndex,
          slotLabel: label,
          imageUrl: url,
          hoverEvents: hovered,
          iconSelector: REMOVE_ICON_SELECTOR,
          pathPrefix: REMOVE_ICON_PATH_PREFIX,
          editIconFound: !!(target.querySelector && target.querySelector('.image-upload-edit'))
        };
        return node ? { done: true, value: node, snapshot: snapshot } : { snapshot: snapshot };
      }
    });
    if (!found.ok) {
      recorder.fail('FIND_DELETE_BUTTON', 'DELETE_BUTTON_NOT_FOUND',
        '在第 1 张图（' + label + '）里没有找到删除图标，已停止（不会去点别的按钮）。请手动删掉这一张，或反馈页面结构已变化',
        found.snapshot);
      return { ok: false, failure: recorder.failure() };
    }

    var clickMethods;
    try {
      clickMethods = clickElement(found.value, win);
    } catch (err) {
      recorder.fail('DELETE_IMAGE', 'DELETE_CLICK_FAILED',
        '点击第 1 张图的删除图标失败：' + (err && err.message ? err.message : String(err)),
        { slotIndex: targetIndex, slotLabel: label });
      return { ok: false, failure: recorder.failure() };
    }
    recorder.ok('DELETE_IMAGE', '已点击第 1 张图（' + label + '）的删除图标，等待它从图片区消失', {
      clickMethods: clickMethods,
      slotIndex: targetIndex,
      slotLabel: label,
      imageUrl: url
    });

    var latest = { before: before, after: before };
    var gone = await domWait.waitFor({
      doc: doc,
      win: win,
      stage: 'WAIT_IMAGE_REMOVED',
      description: '等待第 1 张图从图片区消失',
      timeout: timeout,
      pollInterval: 120,
      observeTarget: doc,
      check: function () {
        var now = surveySlots(doc);
        latest = { before: before, after: now };
        // 占用数少了才算删掉：真机上后面的图会前移，按「第 0 槽变空」判会永远不成立。
        return now.filled < before.filled ? { done: true, value: latest, snapshot: latest } : { snapshot: latest };
      }
    });
    if (!gone.ok) {
      recorder.fail('WAIT_IMAGE_REMOVED', 'DELETE_TIMEOUT',
        '点了删除图标，但第 1 张图没有从图片区消失（已占用 ' + before.filled + ' → ' + latest.after.filled +
          '）。页面上可能弹了二次确认框，本流程不会自己去点确认，已停止；请手动确认后再回填',
        latest);
      return { ok: false, failure: recorder.failure() };
    }

    recorder.ok('WAIT_IMAGE_REMOVED', '第 1 张图（' + label + '）已从图片区移除（已占用 ' +
      before.filled + ' → ' + latest.after.filled + '）', {
      slotIndex: targetIndex,
      slotLabel: label,
      imageUrl: url,
      before: before,
      after: latest.after
    });
    return { ok: true, removed: { slotIndex: targetIndex, label: label, url: url, before: before, after: latest.after } };
  }

  // ---------------------------------------------------------------- 阶段记录

  function createRecorder() {
    var stages = [];
    var failure = null;

    function push(stage, status, message, diagnostics) {
      stages.push({
        stage: stage,
        stageLabel: STAGE_LABELS[stage] || stage,
        status: status,
        message: message || '',
        diagnostics: messagesModule.sanitizeForLog(diagnostics || {})
      });
    }

    return {
      stages: stages,
      ok: function (stage, message, diagnostics) {
        push(stage, 'ok', message, diagnostics);
      },
      notice: function (stage, message, diagnostics) {
        push(stage, 'notice', message, diagnostics);
      },
      fail: function (stage, code, message, diagnostics) {
        failure = { stage: stage, stageLabel: STAGE_LABELS[stage] || stage, code: code, message: message };
        push(stage, 'failed', message, diagnostics);
      },
      failure: function () {
        return failure;
      }
    };
  }

  function buildResult(extra) {
    var base = {
      ok: false,
      status: 'failed',
      stage: null,
      code: null,
      message: '',
      stages: [],
      upload: null,
      confirmUpload: null,
      elapsedMs: 0,
      frameUrl: root.location ? root.location.href : ''
    };
    var keys = Object.keys(extra || {});
    for (var i = 0; i < keys.length; i += 1) {
      base[keys[i]] = extra[keys[i]];
    }
    return base;
  }

  // ---------------------------------------------------------------- 定位上传面板

  /**
   * 定位上传面板的拖拽区。
   * waitMs <= 0 表示「面板此刻应当已经开着」（跨 frame 重试路径），只探一次。
   */
  function locateDropZone(doc, win, waitMs) {
    if (!(waitMs > 0)) {
      var once = uploadLocator.findDropZone(doc, win);
      return Promise.resolve({
        zone: once.ok ? once : null,
        waited: null,
        lastCode: once.code || null,
        lastVisibleCount: once.diagnostics ? once.diagnostics.visibleCount : null
      });
    }

    var hit = null;
    return domWait
      .waitFor({
        doc: doc,
        win: win,
        stage: 'FIND_DROP_ZONE',
        description: '等待上传面板出现',
        timeout: waitMs,
        pollInterval: 200,
        observeTarget: doc,
        check: function () {
          var zone = uploadLocator.findDropZone(doc, win);
          if (zone.ok) {
            hit = zone;
            return { done: true, value: { matchedBy: zone.matchedBy }, snapshot: { found: true } };
          }
          return {
            done: false,
            snapshot: {
              code: zone.code,
              visibleCount: zone.diagnostics ? zone.diagnostics.visibleCount : null
            }
          };
        }
      })
      .then(function (waited) {
        return {
          zone: hit,
          waited: waited,
          lastCode: waited.snapshot ? waited.snapshot.code : null,
          lastVisibleCount: waited.snapshot ? waited.snapshot.visibleCount : null
        };
      });
  }

  // ---------------------------------------------------------------- 确认上传

  /**
   * 「上传面板是否还开着」的判定。
   *
   * 锚定在**已经解析出的那个拖拽区元素**上，而不是每次重新跑一遍 findDropZone：
   * 面板一旦关闭，findDropZone 会继续往下试 `[class*="uploader"]` 这个兜底选择器，
   * 而它正好命中商品表单自己的 `.image-uploader` 包裹层 —— 于是结果是「可见拖拽区
   * 有 5 个」（DROP_ZONE_AMBIGUOUS）而不是「没有拖拽区」（DROP_ZONE_NOT_FOUND），
   * 关闭判定永远不成立：每次回填都要白等满 8 秒并报一条假警告。
   */
  function makePanelProbe(dropZoneElement, doc, win) {
    // 锚点必须是一个「具体元素」：document.body / documentElement 永远 isConnected，
    // 拿它们当锚点会把「没有面板」谎报成「面板开着」，进而白等满 8 秒。
    // findDropZone 失败时返回的报告本来就不带 element，调用方一旦用 body 兜底就会踩到。
    var body = doc && doc.body;
    var docRoot = doc && doc.documentElement;
    var anchored = dropZoneElement && dropZoneElement !== body && dropZoneElement !== docRoot ? dropZoneElement : null;

    return function () {
      if (anchored && anchored.isConnected) {
        return true;
      }
      var zone = uploadLocator.findDropZone(doc, win);
      return !!zone.ok;
    };
  }

  /**
   * 点击面板底部的「确认上传」。
   *
   * 与姊妹项目同一条判定链：
   * - confirmUploadClick === false -> 只报告，不点击
   * - 按钮可点击 -> 点击，并观察面板是否关闭（关闭是「已应用到商品」的有力旁证）
   * - 等待期间面板已消失 -> 视为「拖入即生效」，不算失败
   * - 始终找不到 -> notice，不阻断整条流程
   */
  function confirmUploadIfNeeded(options) {
    var doc = options.doc;
    var win = options.win;
    var recorder = options.recorder;
    var isPanelOpen = options.isPanelOpen;
    var scope = options.buttonScope || (doc && doc.body) || doc;
    var waitLimit = options.timeout > 0 ? options.timeout : DEFAULT_CONFIRM_TIMEOUT;

    if (options.click === false) {
      recorder.notice('CONFIRM_UPLOAD', '已按设置跳过「确认上传」', { skipped: true });
      return Promise.resolve({ skipped: true, clicked: false, found: false, panelClosed: false, text: null });
    }

    var found = null;
    var lastProbe = null;
    var scopeUsed = 'panel';

    return domWait
      .waitFor({
        doc: doc,
        win: win,
        stage: 'CONFIRM_UPLOAD',
        description: '等待「确认上传」按钮可点击',
        timeout: waitLimit,
        pollInterval: 150,
        observeTarget: scope,
        check: function () {
          var probe = uploadLocator.findConfirmUploadButton(doc, win, scope);
          lastProbe = probe;
          if (probe.ok) {
            found = probe;
            return { done: true, value: { text: probe.text }, snapshot: { ready: true, text: probe.text } };
          }
          if (!isPanelOpen()) {
            return { done: true, value: { reason: 'panel-gone' }, snapshot: { ready: false, reason: 'panel-gone' } };
          }
          return { done: false, snapshot: { ready: false, lastCode: probe.code } };
        }
      })
      .then(function (waited) {
        var panelGone = !!(waited.value && waited.value.reason === 'panel-gone');

        // 弹层作用域内没找到时，做一次整页扫描（只做一次，不参与轮询）：
        // 有些实现的底部按钮挂在弹层之外的容器里。
        if (!found && !panelGone) {
          var fallback = uploadLocator.findConfirmUploadButton(doc, win, (doc && doc.body) || doc);
          if (fallback.ok) {
            found = fallback;
            scopeUsed = 'document';
          }
        }

        if (!found) {
          var reason = panelGone
            ? '上传面板已经消失，判断为「投进去即生效」，无需点击「确认上传」'
            : (waited.snapshot && waited.snapshot.lastCode === 'CONFIRM_UPLOAD_BUTTON_DISABLED'
                ? '上传面板内的「确认上传」按钮一直不可点击'
                : '上传面板内未找到「确认上传」按钮');
          var scanned = (lastProbe && lastProbe.diagnostics && lastProbe.diagnostics.scanned) || [];
          recorder.notice('CONFIRM_UPLOAD', reason, {
            waitedMs: waited.elapsed,
            buttonScope: messagesModule.describeElement(scope),
            lastSnapshot: waited.snapshot,
            panelButtons: scanned
          });
          return { skipped: false, clicked: false, found: false, panelGone: panelGone, text: null, scanned: scanned };
        }

        var clickMethods = [];
        try {
          clickMethods = clickElement(found.element, win);
        } catch (err) {
          recorder.notice('CONFIRM_UPLOAD', '「确认上传」按钮点击失败：' + (err && err.message ? err.message : String(err)), {
            buttonText: found.text
          });
          return { skipped: false, clicked: false, found: true, text: found.text, panelClosed: false };
        }

        return domWait
          .waitFor({
            doc: doc,
            win: win,
            stage: 'CONFIRM_UPLOAD',
            description: '等待上传面板关闭',
            timeout: DEFAULT_CONFIRM_TIMEOUT,
            pollInterval: 150,
            observeTarget: doc,
            check: function () {
              if (!isPanelOpen()) {
                return { done: true, value: { reason: 'panel-gone' }, snapshot: { panelOpen: false } };
              }
              return { done: false, snapshot: { panelOpen: true } };
            }
          })
          .then(function (closed) {
            var diagnostics = {
              buttonText: found.text,
              buttonDescription: found.description,
              buttonScopeUsed: scopeUsed,
              clickMethods: clickMethods,
              waitedMs: waited.elapsed,
              panelClosed: !!closed.ok,
              panelCloseWaitedMs: closed.elapsed
            };
            if (closed.ok) {
              recorder.ok('CONFIRM_UPLOAD', '已点击「' + found.text + '」，上传面板已关闭', diagnostics);
            } else {
              recorder.notice(
                'CONFIRM_UPLOAD',
                '已点击「' + found.text + '」，但上传面板仍未关闭，请回页面人工确认图片是否已应用',
                diagnostics
              );
            }
            return {
              skipped: false,
              clicked: true,
              found: true,
              text: found.text,
              panelClosed: !!closed.ok,
              clickMethods: clickMethods
            };
          });
      });
  }

  // ---------------------------------------------------------------- 主流程

  /**
   * @param payload {dataUrl, fileMeta, openPanel, confirmUploadClick,
   *                 panelTimeout, uploadTimeout, confirmTimeout}
   */
  async function runFill(payload) {
    var doc = root.document;
    var win = root;
    var recorder = createRecorder();
    var startedAt = Date.now();
    var openPanel = payload.openPanel !== false;
    var removedImage = null;

    function finish(extra) {
      return buildResult(
        Object.assign(
          {
            stages: recorder.stages,
            elapsedMs: Date.now() - startedAt
          },
          extra || {}
        )
      );
    }

    try {
      // ---------- 0. 可选：先删掉第 1 张旧图，腾出空位 ----------
      // 放在开面板之前：删除图标在商品页上（不需要面板），而删除会让图片区重排，
      // 空槽位的上传按钮也会跟着换位置 —— 先删再选槽位才选得准。
      if (payload.removeFirstImage === true) {
        var removal = await removeFirstImage(doc, win, {
          recorder: recorder,
          timeout: payload.deleteTimeout
        });
        if (!removal.ok) {
          var removeFailure = removal.failure;
          return finish({ stage: removeFailure.stage, code: removeFailure.code, message: removeFailure.message });
        }
        removedImage = removal.removed;
      }

      // ---------- 1. 打开上传面板 ----------
      if (openPanel) {
        var survey = uploadLocator.findVisibleUploadButtons(doc, win);
        var choice = chooseUploadButton(survey);
        // 面板可能已经开着 —— 用户按上一次的提示手动打开了，或上一次尝试留下的。
        // 这种情况页面同样可能一个可见按钮都没有，但流程完全可以继续：第 2 步要的
        // 正是这个拖拽区。不认这种情况，我们给的「请手动打开面板」就是死循环指引：
        // 用户照做、再点一次回填，仍然会因为「没有按钮」而报同一个错。
        var reuseOpenPanel = !choice && uploadLocator.findDropZone(doc, win).ok;

        if (!choice && !reuseOpenPanel) {
          var slots = surveySlots(doc);
          // 页面只在空槽位渲染上传按钮，所以「没有可见按钮」最可能的原因是图片位满了。
          // 这两件事的处理方式完全不同，绝不能都报成「请先打开上传面板」。
          var allFull = slots.total > 0 && slots.filled === slots.total;
          var noButton = allFull
            ? '商品页的图片位已经全部占用（' + slots.total + ' 个槽位都有图），页面上已经没有「上传图片」按钮，' +
              '请先在商品页删掉一张、腾出空位再回填'
            : '页面上 div.image-upload-btn 共 ' + survey.domCount + ' 个，可见 0 个，' +
              '请先在商品页把图片上传面板打开，打开后再点一次回填即可继续';
          recorder.fail('OPEN_PANEL', 'UPLOAD_BUTTON_NOT_FOUND', noButton, {
            domUploadButtonCount: survey.domCount,
            visibleUploadButtonCount: survey.visibleCount,
            slotCount: slots.total,
            filledSlotCount: slots.filled,
            allSlotsFull: allFull
          });
          var noButtonFailure = recorder.failure();
          return finish({ stage: noButtonFailure.stage, code: noButtonFailure.code, message: noButton });
        }

        if (reuseOpenPanel) {
          // 用 ok 而不是 notice：notice 会被提到用户眼前的「需确认」警告里，
          // 而这条纯属审计信息，对用户没有可执行的含义。
          recorder.ok('OPEN_PANEL', '本 frame 的上传面板已经打开，直接复用，跳过点击上传按钮', {
            reusedOpenPanel: true,
            domUploadButtonCount: survey.domCount
          });
        } else {
          if (choice.degraded) {
            recorder.notice(
              'OPEN_PANEL',
              '没有找到空槽位（可见上传按钮 ' + choice.filledCount + ' 个都挂在已占用的槽位上），已改用第 0 个按钮，' +
                '可能会覆盖已有图片，请回商品页核对',
              { filledSlotCount: choice.filledCount, buttonTexts: choice.buttonTexts }
            );
          }

          var clickMethods;
          try {
            clickMethods = clickElement(choice.item.element, win);
          } catch (err) {
            recorder.fail('OPEN_PANEL', 'UPLOAD_BUTTON_CLICK_FAILED', err && err.message ? err.message : String(err), {
              buttonText: choice.item.text
            });
            var clickFailure = recorder.failure();
            return finish({ stage: clickFailure.stage, code: clickFailure.code, message: clickFailure.message });
          }

          recorder.ok('OPEN_PANEL', '已点击上传按钮「' + (choice.item.text || '(无文本)') + '」，等待上传面板出现', {
            clickMethods: clickMethods,
            usedButtonIndex: choice.item.index,
            buttonTexts: choice.buttonTexts,
            emptySlotCount: choice.emptyCount,
            filledSlotCount: choice.filledCount
          });
        }
      }

      // ---------- 2. 定位上传面板 ----------
      var located = await locateDropZone(doc, win, openPanel ? payload.panelTimeout : 0);
      if (!located.zone) {
        var why = located.lastCode || 'DROP_ZONE_NOT_FOUND';
        recorder.fail('FIND_DROP_ZONE', 'UPLOAD_PANEL_NOT_FOUND', '本 frame 内没有出现上传面板（' + why + '）', {
          dropZoneCode: why,
          visibleDropZoneCount: located.lastVisibleCount,
          dropZoneSelectors: uploadLocator.DROP_ZONE_SELECTORS
        });
        var zoneFailure = recorder.failure();
        // 这个失败码是「换 frame 重试」的信号，由 service worker 解读。
        return finish({ stage: zoneFailure.stage, code: zoneFailure.code, message: zoneFailure.message });
      }

      var dropZone = located.zone;
      var panelScope = uploadLocator.findUploadPanelScope(doc, dropZone.element, win).element;
      // 「确认上传」按钮在弹层底部，不在拖拽区那一层，需要单独取弹层作用域。
      var modalScope = uploadLocator.findModalScope(doc, dropZone.element, win).element;
      recorder.ok('FIND_DROP_ZONE', '已定位上传面板（判定依据：' + dropZone.matchedBy + '）', {
        matchedBy: dropZone.matchedBy,
        description: dropZone.description,
        panelDescription: panelScope ? messagesModule.describeElement(panelScope) : null,
        modalDescription: modalScope ? messagesModule.describeElement(modalScope) : null
      });

      // ---------- 3. 定位文件输入框 ----------
      // 关键：把搜索范围限制在上传面板内。整页搜索会误选到页面别处的
      // input[type=file]（例如视频上传），或直接报 FILE_INPUT_AMBIGUOUS。
      var inputReport = uploadLocator.findFileInput(doc, win, panelScope || undefined);
      var strategy = 'input';

      if (inputReport.ok) {
        recorder.ok(
          'FIND_FILE_INPUT',
          '已定位唯一文件输入框（判定依据：' + inputReport.matchedBy + '；搜索范围：' +
            (inputReport.diagnostics.usedScope ? '上传面板内' : '全文档') + '）',
          inputReport.diagnostics
        );
      } else {
        strategy = 'drop-zone';
        recorder.ok('FIND_FILE_INPUT', '未采用文件输入框（' + inputReport.code + '），改用拖拽投放', {
          dropZoneMatchedBy: dropZone.matchedBy,
          inputFailure: inputReport.code
        });
      }

      // ---------- 4. 注入文件 ----------
      // 预览基线必须在注入之前取：部分页面在 change / drop 里同步渲染缩略图，
      // 晚取会把新增的那张算进基线，导致漏判。
      var previewBaseline = fileInjector.countPreviews(doc);
      var injected =
        strategy === 'drop-zone'
          ? fileInjector.injectViaDropZone(dropZone.element, payload.dataUrl, payload.fileMeta, { win: win })
          : fileInjector.injectFile(inputReport.element, payload.dataUrl, payload.fileMeta, { win: win });

      if (!injected.ok) {
        recorder.fail(
          'INJECT_FILE',
          injected.code || 'FILE_INJECTION_FAILED',
          injected.detail || '文件注入失败',
          injected.diagnostics
        );
        var injectFailure = recorder.failure();
        return finish({ stage: injectFailure.stage, code: injectFailure.code, message: injectFailure.message });
      }
      recorder.ok(
        'INJECT_FILE',
        strategy === 'drop-zone'
          ? '已按 dragenter → dragover → drop 顺序把文件投放到拖拽区'
          : '已注入文件并触发 input / change 事件',
        injected.diagnostics
      );

      // ---------- 5. 等待上传结果 ----------
      var upload = await fileInjector.waitForUploadResult({
        doc: doc,
        win: win,
        baseline: previewBaseline,
        timeout: payload.uploadTimeout > 0 ? payload.uploadTimeout : DEFAULT_UPLOAD_TIMEOUT
      });
      if (upload.confirmed) {
        recorder.ok('WAIT_UPLOAD', '已观察到上传完成信号（判据：' + (upload.diagnostics.criteria || '-') + '）', upload.diagnostics);
      } else if (strategy === 'drop-zone') {
        recorder.notice(
          'WAIT_UPLOAD',
          '文件已投放，但未观察到上传完成信号；拖拽投放只能确认事件已派发，页面是否真的收到文件需要人工核对',
          upload.diagnostics
        );
      } else {
        recorder.notice('WAIT_UPLOAD', '文件已注入并触发事件，但未观察到上传完成信号', upload.diagnostics);
      }

      // ---------- 6. 确认上传 ----------
      var confirm = await confirmUploadIfNeeded({
        doc: doc,
        win: win,
        recorder: recorder,
        buttonScope: modalScope || panelScope,
        isPanelOpen: makePanelProbe(dropZone.element, doc, win),
        click: payload.confirmUploadClick,
        timeout: payload.confirmTimeout
      });

      var confirmed = !!upload.confirmed && (confirm.clicked || confirm.panelGone || confirm.skipped);
      return finish({
        ok: true,
        status: confirmed ? 'success' : 'unconfirmed',
        stage: 'COMPLETE',
        code: confirmed ? null : 'UPLOAD_RESULT_UNCONFIRMED',
        message: confirmed
          ? '已把新图上传到商品页图片区' +
            (confirm.skipped ? '（未点击「确认上传」）' : '并点击了「确认上传」') +
            (removedImage ? '；回填前已删除原来的第 1 张图（' + removedImage.label + '）' : '')
          : // 删了图却没确认上传成功，用户是「净损失一张图」，必须写在提示里。
            '文件已投放到上传面板，但未能确认上传完成，请回商品页人工核对' +
            (removedImage
              ? '；注意：本次已先删除了原来的第 1 张图（' + removedImage.label + '），若新图没上传成功需要你手动补回'
              : ''),
        upload: {
          status: upload.status,
          confirmed: !!upload.confirmed,
          strategy: strategy,
          criteria: upload.diagnostics ? upload.diagnostics.criteria : null
        },
        confirmUpload: {
          skipped: !!confirm.skipped,
          clicked: !!confirm.clicked,
          found: !!confirm.found,
          panelGone: !!confirm.panelGone,
          panelClosed: !!confirm.panelClosed,
          buttonText: confirm.text || null
        }
      });
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      var serialized = NS.errors && NS.errors.serializeError ? NS.errors.serializeError(err, 'WAIT_UPLOAD') : null;
      var code = serialized ? serialized.code : 'INTERNAL_ERROR';
      var stage = serialized ? serialized.stage : 'WAIT_UPLOAD';
      recorder.fail(stage, code, message, serialized ? serialized.diagnostics : {});
      return finish({ stage: stage, code: code, message: message });
    }
  }

  // ---------------------------------------------------------------- 消息入口

  function registerMessageListener() {
    var api = root.chrome;
    if (!api || !api.runtime || !api.runtime.onMessage) {
      return false;
    }
    api.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== MESSAGE_TYPE) {
        return false;
      }
      runFill(message.payload || {}).then(sendResponse, function (err) {
        sendResponse(
          buildResult({
            status: 'failed',
            code: 'INTERNAL_ERROR',
            message: '回填流程异常终止：' + (err && err.message ? err.message : String(err))
          })
        );
      });
      return true; // 异步响应，保持通道打开
    });
    return true;
  }

  /**
   * 本地探测：只读页面状态，绝不点击。
   * service worker 用它在注入库之前先挑出「哪个 frame 是商品图片控件所在」。
   */
  function probe() {
    var doc = root.document;
    return {
      frameUrl: root.location ? root.location.href : '',
      isTopFrame: (function () {
        try {
          return root.top === root;
        } catch (err) {
          return false;
        }
      })(),
      probe: uploadLocator.probeDocument(doc, root)
    };
  }

  NS.pageFillBridge = {
    MESSAGE_TYPE: MESSAGE_TYPE,
    chooseUploadButton: chooseUploadButton,
    surveySlots: surveySlots,
    removeFirstImage: removeFirstImage,
    findRemoveIcon: findRemoveIcon,
    slotsOf: slotsOf,
    isFilledSlot: isFilledSlot,
    slotOf: slotOf,
    clickElement: clickElement,
    makePanelProbe: makePanelProbe,
    runFill: runFill,
    probe: probe,
    registerMessageListener: registerMessageListener
  };

  var registered = registerMessageListener();
  NS.pageFillBridge.listenerRegistered = registered;
  // 只有真正注册成功才标记，避免「注册失败但后续注入被守卫拦住」。
  NS.__pageFillBridgeInstalled = registered === true;
})(typeof globalThis !== 'undefined' ? globalThis : self);
