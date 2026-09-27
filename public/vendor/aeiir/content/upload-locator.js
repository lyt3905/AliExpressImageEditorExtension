/**
 * content/upload-locator.js
 * 主页面独立上传按钮定位 + 单个 document 内的「上传区域」探测 + 文件输入框定位。
 *
 * 关键约束：
 * - 删除按钮与上传按钮不在同一位置，上传按钮是独立的 div.image-upload-btn。
 * - 通过弹窗中的序号选择，序号越界必须停止，不能自动改选其它按钮。
 * - 多 frame 同时匹配上传区域时由上层报歧义，本模块只负责单 document 判定。
 *
 * 形态：经典脚本，挂载到 globalThis.AEIIR.uploadLocator。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  var UPLOAD_BUTTON_SELECTOR = 'div.image-upload-btn';
  var UPLOAD_HINT_TEXT = '点击此处或者将文件拖至此处';
  var FILE_INPUT_SELECTOR = 'input[type="file"]';

  var UPLOAD_CONTAINER_SELECTORS = [
    '.ant-upload',
    '.ant-upload-drag',
    '[class*="upload-drag"]',
    '[class*="upload-area"]',
    '[class*="uploader"]',
    '[class*="drop-zone"]'
  ];

  /**
   * 拖拽上传区选择器（按「越具体越优先」排序）。
   * 真实页面（速卖通素材中心上传面板）用的是 div.material-center-upload-drag，
   * 文案为「点击此处或者将文件拖至此处」。
   */
  var DROP_ZONE_SELECTORS = [
    '.material-center-upload-drag',
    '[class*="material-center-upload-drag"]',
    '[class*="upload-drag"]',
    '.ant-upload-drag',
    '[class*="upload-area"]',
    '[class*="drop-zone"]',
    '[class*="uploader"]'
  ];

  /** 上传面板（弹层）容器候选：用于把搜索范围收敛到面板内部 */
  var PANEL_SELECTORS = [
    '.material-center-modal',
    '[class*="material-center-modal"]',
    '.ant-modal-content',
    '.ant-modal',
    '[role="dialog"]',
    '[class*="material-center-drawer"]',
    '.ant-drawer-content',
    '[class*="modal-content"]',
    '[class*="dialog"]'
  ];

  /** 「确认上传」按钮文案（精确匹配，不含「上传图片」这类卡片按钮） */
  var CONFIRM_BUTTON_TEXTS = ['确认上传', '确定上传', '确认添加', '确认插入'];

  /** 面板内可点击元素（按钮）候选选择器 */
  var BUTTON_SELECTORS = [
    'button',
    '[role="button"]',
    'a.ant-btn',
    '[class*="ant-btn"]',
    '[class*="btn"]',
    '[class*="-button"]'
  ];

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, '');
  }

  function domWait() {
    return root.AEIIR && root.AEIIR.domWait;
  }

  function elementDescription(node) {
    var messages = root.AEIIR && root.AEIIR.messages;
    return messages ? messages.describeElement(node) : String((node && node.tagName) || '');
  }

  /** 所有可见的 div.image-upload-btn */
  function findVisibleUploadButtons(doc, win) {
    var view = win || (doc && doc.defaultView) || root;
    var wait = domWait();
    var all = doc ? toArray(doc.querySelectorAll(UPLOAD_BUTTON_SELECTOR)) : [];
    var items = [];
    var visibleIndex = 0;
    for (var i = 0; i < all.length; i += 1) {
      var node = all[i];
      var visible = wait ? wait.isVisible(node, view) : true;
      var text = textOfUploadButton(node);
      var item = {
        element: node,
        domIndex: i,
        text: text,
        visible: visible
      };
      if (visible) {
        item.index = visibleIndex;
        visibleIndex += 1;
      }
      items.push(item);
    }
    var visibleItems = items.filter(function (item) {
      return item.visible;
    });
    return {
      selector: UPLOAD_BUTTON_SELECTOR,
      domCount: all.length,
      visibleCount: visibleItems.length,
      items: items,
      visibleItems: visibleItems
    };
  }

  function textOfUploadButton(node) {
    if (!node) {
      return '';
    }
    var span = node.querySelector ? node.querySelector('span') : null;
    if (span && span.textContent && span.textContent.trim()) {
      return span.textContent.trim();
    }
    var text = (node.textContent || '').trim();
    return text;
  }

  /**
   * 按序号选择上传按钮。
   * @returns 结构化报告；越界 / 无按钮均不猜测、不自动改选。
   */
  function selectUploadButton(survey, index) {
    var requested = index === undefined || index === null || index === '' ? 0 : Number(index);
    var diagnostics = {
      selector: UPLOAD_BUTTON_SELECTOR,
      visibleUploadButtonCount: survey ? survey.visibleCount : 0,
      domUploadButtonCount: survey ? survey.domCount : 0,
      requestedIndex: requested,
      buttonTexts: survey ? survey.visibleItems.map(function (item) {
        return item.text;
      }) : []
    };

    if (!isFinite(requested) || Math.floor(requested) !== requested || requested < 0) {
      return {
        ok: false,
        code: 'UPLOAD_BUTTON_INDEX_INVALID',
        detail: '序号=' + String(index),
        diagnostics: diagnostics
      };
    }
    if (!survey || survey.visibleCount === 0) {
      return {
        ok: false,
        code: 'UPLOAD_BUTTON_NOT_FOUND',
        detail: '页面上 div.image-upload-btn 共 ' + (survey ? survey.domCount : 0) + ' 个，可见 0 个',
        diagnostics: diagnostics
      };
    }
    if (requested >= survey.visibleCount) {
      return {
        ok: false,
        code: 'UPLOAD_BUTTON_INDEX_OUT_OF_RANGE',
        detail: '序号 ' + requested + ' 越界，可见上传按钮共 ' + survey.visibleCount + ' 个（有效序号 0 - ' + (survey.visibleCount - 1) + '）',
        diagnostics: diagnostics
      };
    }

    var item = survey.visibleItems[requested];
    return {
      ok: true,
      element: item.element,
      index: requested,
      text: item.text,
      diagnostics: diagnostics
    };
  }

  /** 在给定 element 子树里查找最小的、包含完整上传文案的元素 */
  function findUploadHintArea(scope, doc) {
    var container = scope || doc;
    if (!container || typeof container.textContent !== 'string') {
      return { found: false, element: null, text: '' };
    }
    var hint = normalizeText(UPLOAD_HINT_TEXT);
    if (normalizeText(container.textContent).indexOf(hint) === -1) {
      return { found: false, element: null, text: '' };
    }

    var view = doc && doc.defaultView ? doc.defaultView : root;
    var key = hint.slice(0, 6);
    var startNode = null;

    if (doc && typeof doc.createTreeWalker === 'function') {
      var SHOW_TEXT = (view && view.NodeFilter && view.NodeFilter.SHOW_TEXT) || 4;
      var walker = doc.createTreeWalker(container, SHOW_TEXT, null);
      var current = walker.nextNode();
      while (current) {
        if (normalizeText(current.nodeValue).indexOf(key) !== -1) {
          startNode = current;
          break;
        }
        current = walker.nextNode();
      }
    }

    function containsHint(node) {
      return !!node && typeof node.textContent === 'string' &&
        normalizeText(node.textContent).indexOf(hint) !== -1;
    }

    if (!startNode) {
      var candidates = container.querySelectorAll ? toArray(container.querySelectorAll('*')) : [];
      for (var i = 0; i < candidates.length; i += 1) {
        if (containsHint(candidates[i])) {
          startNode = candidates[i];
          break;
        }
      }
      if (!startNode) {
        return { found: true, element: container, text: UPLOAD_HINT_TEXT, refined: false };
      }
    }

    var node = startNode.nodeType === 3 ? startNode.parentElement : startNode;
    var guard = 0;
    // 先向上找到第一个「完整包含上传文案」的元素
    while (node && !containsHint(node) && node.parentElement && guard < 30) {
      node = node.parentElement;
      guard += 1;
    }
    // 再向下收缩到最深的、仍完整包含上传文案的子元素 —— 即范围最小的目标区域
    var depth = 0;
    while (node && node.children && node.children.length > 0 && depth < 30) {
      var deeper = null;
      for (var c = 0; c < node.children.length; c += 1) {
        if (containsHint(node.children[c])) {
          deeper = node.children[c];
          break;
        }
      }
      if (!deeper) {
        break;
      }
      node = deeper;
      depth += 1;
    }

    return {
      found: true,
      element: node,
      text: UPLOAD_HINT_TEXT,
      refined: true,
      description: elementDescription(node)
    };
  }

  function countUploadContainers(doc, scope) {
    var target = scope || doc;
    if (!target || !target.querySelectorAll) {
      return { total: 0, bySelector: [] };
    }
    var total = 0;
    var bySelector = [];
    var seen = [];
    for (var i = 0; i < UPLOAD_CONTAINER_SELECTORS.length; i += 1) {
      var selector = UPLOAD_CONTAINER_SELECTORS[i];
      var nodes = toArray(target.querySelectorAll(selector)).filter(function (node) {
        return seen.indexOf(node) === -1;
      });
      for (var j = 0; j < nodes.length; j += 1) {
        seen.push(nodes[j]);
      }
      bySelector.push({ selector: selector, count: nodes.length });
      total += nodes.length;
    }
    return { total: total, bySelector: bySelector, elements: seen };
  }

  function acceptsImage(input) {
    var accept = (input.getAttribute && input.getAttribute('accept')) || '';
    if (!accept) {
      return true;
    }
    return /image/i.test(accept) || /\.(png|jpe?g)/i.test(accept);
  }

  /**
   * 在单个 document（可能是主文档，也可能是某个 iframe 的文档）中探测上传区域。
   * 供 service worker 逐 frame 询问使用。
   */
  function probeDocument(doc, win) {
    var view = win || (doc && doc.defaultView) || root;
    if (!doc) {
      return {
        matched: false,
        score: 0,
        reason: '没有可探测的 document'
      };
    }
    var inputs = toArray(doc.querySelectorAll(FILE_INPUT_SELECTOR));
    var imageInputs = inputs.filter(acceptsImage);
    var hint = findUploadHintArea(doc.body || doc, doc);
    var containers = countUploadContainers(doc, doc.body || doc);

    var matchedBy = [];
    if (hint.found) {
      matchedBy.push('upload-hint-text');
    }
    if (imageInputs.length > 0) {
      matchedBy.push('image-file-input');
    } else if (inputs.length > 0) {
      matchedBy.push('file-input');
    }
    if (containers.total > 0) {
      matchedBy.push('upload-container');
    }

    var strongMatch = hint.found && (inputs.length > 0 || containers.total > 0);
    var weakMatch = imageInputs.length > 0 || inputs.length > 0;
    var matched = strongMatch || weakMatch;

    var score = 0;
    if (hint.found) {
      score += 3;
    }
    if (imageInputs.length > 0) {
      score += 2;
    }
    if (inputs.length > 0) {
      score += 1;
    }
    score += Math.min(containers.total, 2);

    return {
      matched: matched,
      strongMatch: strongMatch,
      weakMatch: weakMatch,
      score: score,
      matchedBy: matchedBy,
      hasUploadHint: hint.found,
      uploadHintText: hint.found ? UPLOAD_HINT_TEXT : null,
      uploadHintDescription: hint.description || null,
      fileInputCount: inputs.length,
      imageFileInputCount: imageInputs.length,
      uploadContainerCount: containers.total,
      uploadContainersBySelector: containers.bySelector,
      acceptValues: inputs.map(function (input) {
        return input.getAttribute('accept') || '';
      }),
      documentTitle: doc.title || ''
    };
  }

  /** 元素的 DOM 路径（用于诊断，方便直接复制） */
  function pathOf(node, doc) {
    var imagePath = root.AEIIR && root.AEIIR.imagePath;
    if (!imagePath || !node) {
      return null;
    }
    try {
      return imagePath.elementPath(node, doc);
    } catch (err) {
      return null;
    }
  }

  /**
   * 从某个元素向上找「最像拖拽区」的祖先：
   *   1. 类名形如 upload-drag / upload-area / drop-zone / uploader 的最近祖先（强判据）
   *   2. 否则取「最近的、内部含有 input[type=file] 的祖先」（弱判据）
   * 都找不到返回 null。
   * 注意 2 是必要的：上传文案节点本身（例如 <span>）不是可投放区域，
   * 需要校正到真正承载上传组件的那一层。
   */
  function closestDropZoneLike(node) {
    var current = node;
    var guard = 0;
    var withInput = null;
    while (current && guard < 8) {
      var cls = (current.getAttribute && current.getAttribute('class')) || '';
      if (/upload-drag|upload-area|drop-zone|uploader/i.test(cls)) {
        return current;
      }
      if (!withInput && current.querySelectorAll && current.querySelectorAll(FILE_INPUT_SELECTOR).length > 0) {
        withInput = current;
      }
      current = current.parentElement;
      guard += 1;
    }
    return withInput;
  }

  /**
   * 定位拖拽上传区（div.material-center-upload-drag 等）。
   * - 可见命中 1 个 -> 直接使用。
   * - 可见命中多个 -> DROP_ZONE_AMBIGUOUS（不猜）。
   * - 一个都没有 -> 退化为「按上传文案找最小区域」，仍找不到才 DROP_ZONE_NOT_FOUND。
   */
  function findDropZone(doc, win) {
    var view = win || (doc && doc.defaultView) || root;
    var wait = domWait();
    var diagnostics = {
      selectors: DROP_ZONE_SELECTORS,
      bySelector: [],
      totalCount: 0,
      visibleCount: 0,
      hintTextFallback: false,
      candidates: []
    };
    if (!doc) {
      return { ok: false, code: 'DROP_ZONE_NOT_FOUND', detail: '没有可搜索的 document', diagnostics: diagnostics };
    }

    // 按「越具体越优先」逐个选择器扫描，第一个有命中的选择器即采用；
    // 同时剔除「被其它命中项包含」的节点 —— 否则
    // [class*="material-center-upload-drag"] 会把内层的
    // p.material-center-upload-drag-text / -icon / -hint 一并算进来，造成假歧义。
    var collected = [];
    for (var i = 0; i < DROP_ZONE_SELECTORS.length; i += 1) {
      var selector = DROP_ZONE_SELECTORS[i];
      var raw = toArray(doc.querySelectorAll(selector));
      var nodes = raw.filter(function (node) {
        if (collected.indexOf(node) !== -1) {
          return false;
        }
        for (var c = 0; c < collected.length; c += 1) {
          if (collected[c].contains && collected[c].contains(node)) {
            return false;
          }
        }
        return true;
      });
      nodes = dedupeOutermost(nodes);
      bySelectorPush(diagnostics.bySelector, selector, nodes.length);
      if (nodes.length > 0 && collected.length === 0) {
        for (var k = 0; k < nodes.length; k += 1) {
          collected.push(nodes[k]);
        }
      }
    }
    diagnostics.totalCount = collected.length;

    var visible = collected.filter(function (node) {
      return wait ? wait.isVisible(node, view) : true;
    });
    diagnostics.visibleCount = visible.length;
    diagnostics.candidates = collected.map(function (node) {
      return {
        description: elementDescription(node),
        path: pathOf(node, doc),
        visible: wait ? wait.isVisible(node, view) : true
      };
    });

    if (visible.length === 1) {
      return {
        ok: true,
        element: visible[0],
        matchedBy: 'drop-zone-selector',
        description: elementDescription(visible[0]),
        diagnostics: diagnostics
      };
    }
    if (visible.length > 1) {
      return {
        ok: false,
        code: 'DROP_ZONE_AMBIGUOUS',
        detail: '可见拖拽上传区域 ' + visible.length + ' 个',
        candidates: visible,
        diagnostics: diagnostics
      };
    }

    var hint = findUploadHintArea(doc.body || doc, doc);
    if (hint.found && hint.element) {
      var anchored = closestDropZoneLike(hint.element) || hint.element;
      diagnostics.hintTextFallback = true;
      diagnostics.hintElement = elementDescription(anchored);
      diagnostics.hintPath = pathOf(anchored, doc);
      return {
        ok: true,
        element: anchored,
        matchedBy: 'upload-hint-text',
        description: elementDescription(anchored),
        diagnostics: diagnostics
      };
    }

    return {
      ok: false,
      code: 'DROP_ZONE_NOT_FOUND',
      detail: '未找到可见的拖拽上传区域（选择器命中 ' + collected.length + ' 个，均不可见）',
      diagnostics: diagnostics
    };
  }

  function bySelectorPush(list, selector, count) {
    list.push({ selector: selector, count: count });
  }

  /** 只保留最外层节点：被其它命中项包含的一律丢弃 */
  function dedupeOutermost(nodes) {
    return nodes.filter(function (node) {
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i] !== node && nodes[i].contains && nodes[i].contains(node)) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * 上传面板（弹层）作用域：从拖拽区向上找第一个「像面板」的祖先。
   * 找不到就退回「最近一层内部已经包含 input[type=file] 的祖先」——
   * 这一条不依赖类名，因此对改版更耐用。
   */
  function findUploadPanelScope(doc, dropZone, win) {
    var view = win || (doc && doc.defaultView) || root;
    var diagnostics = { anchor: dropZone ? elementDescription(dropZone) : null, strategy: null, levels: [] };
    if (!dropZone) {
      return { element: null, diagnostics: diagnostics };
    }

    var node = dropZone;
    var guard = 0;
    var chain = [];
    // 第一优先：从里向外，第一个「内部已经包含 input[type=file]」的祖先。
    // 这是最紧的作用域（通常就是上传组件自己的根节点），且不依赖类名。
    while (node && node !== doc.body && node !== doc.documentElement && guard < 20) {
      var cls = (node.getAttribute && node.getAttribute('class')) || '';
      var fileInputs = node.querySelectorAll ? node.querySelectorAll(FILE_INPUT_SELECTOR).length : 0;
      diagnostics.levels.push({
        level: guard,
        description: elementDescription(node),
        className: cls,
        fileInputs: fileInputs
      });
      if (fileInputs > 0) {
        diagnostics.strategy = 'nearest-ancestor-with-file-input';
        return { element: node, diagnostics: diagnostics, matchedBy: 'nearest-ancestor-with-file-input' };
      }
      chain.push(node);
      node = node.parentElement;
      guard += 1;
    }

    // 第二优先：类名像弹层/抽屉的祖先（适用于面板里没有 input 的情况）
    for (var i = 0; i < chain.length; i += 1) {
      if (matchesAnySelector(chain[i], PANEL_SELECTORS)) {
        diagnostics.strategy = 'panel-selector';
        return { element: chain[i], diagnostics: diagnostics, matchedBy: 'panel-selector' };
      }
    }

    // 最后退路：拖拽区往上 3 层（上传组件根节点通常就在附近）
    node = dropZone;
    for (var level = 0; level < 3 && node && node.parentElement && node.parentElement !== doc.body; level += 1) {
      node = node.parentElement;
    }
    diagnostics.strategy = node && node !== doc.body ? 'up-three-levels' : 'drop-zone-itself';
    return {
      element: node && node !== doc.body ? node : dropZone,
      diagnostics: diagnostics,
      matchedBy: diagnostics.strategy
    };
  }

  /**
   * 弹层（modal / drawer）作用域：用于找面板底部的「确认上传」等按钮。
   *
   * 与 findUploadPanelScope 的区别：后者取的是「包含 input 的最紧祖先」
   * （通常就是拖拽区本身），底部按钮并不在里面；这里要的是整个弹层。
   *
   * 做法：向上收集每一层「最具体的面板选择器命中」，然后优先取
   * 选择器优先级最高（越靠前越具体）的那一层 —— 这样
   * div.material-center-modal-body 不会抢先于 div.material-center-modal。
   */
  function findModalScope(doc, dropZone, win) {
    var diagnostics = { anchor: dropZone ? elementDescription(dropZone) : null, candidates: [] };
    if (!dropZone || !doc) {
      return { element: null, diagnostics: diagnostics };
    }
    var node = dropZone;
    var guard = 0;
    var best = null;
    while (node && node !== doc.body && node !== doc.documentElement && guard < 25) {
      var hit = firstMatchingSelector(node, PANEL_SELECTORS);
      if (hit >= 0) {
        diagnostics.candidates.push({
          level: guard,
          selector: PANEL_SELECTORS[hit],
          selectorRank: hit,
          description: elementDescription(node)
        });
        if (!best || hit < best.selectorRank) {
          best = { element: node, selectorRank: hit, selector: PANEL_SELECTORS[hit], level: guard };
        }
      }
      node = node.parentElement;
      guard += 1;
    }
    if (!best) {
      diagnostics.strategy = 'none';
      return { element: null, diagnostics: diagnostics };
    }
    diagnostics.strategy = 'panel-selector';
    diagnostics.selector = best.selector;
    diagnostics.level = best.level;
    return { element: best.element, diagnostics: diagnostics, matchedBy: 'panel-selector' };
  }

  /** 返回 selectors 中第一个命中的下标，未命中返回 -1 */
  function firstMatchingSelector(node, selectors) {
    if (!node || !node.matches) {
      return -1;
    }
    for (var i = 0; i < selectors.length; i += 1) {
      try {
        if (node.matches(selectors[i])) {
          return i;
        }
      } catch (err) {
        // 忽略无法解析的选择器
      }
    }
    return -1;
  }

  function matchesAnySelector(node, selectors) {
    if (!node || !node.matches) {
      return false;
    }
    for (var i = 0; i < selectors.length; i += 1) {
      try {
        if (node.matches(selectors[i])) {
          return true;
        }
      } catch (err) {
        // 忽略无法解析的选择器
      }
    }
    return false;
  }

  /**
   * 定位文件输入框。
   *
   * 关键：**必须把搜索范围收敛到上传面板内**。
   * 真实商品发布页上除了上传面板，别处（例如视频上传）也可能存在 input[type=file]；
   * 若在全文档范围内比较，会误选到别处的输入框，或者直接报 FILE_INPUT_AMBIGUOUS。
   *
   * 选择顺序：
   *   1. 显式 scope（调用方指定）
   *   2. 拖拽区所在面板（findUploadPanelScope）
   *   3. 与拖拽区 DOM 距离最近的那个（domDistance 最小）
   *   4. accept 含 image
   *   5. 可见
   * 仍未唯一 -> FILE_INPUT_AMBIGUOUS（不猜）。
   */
  function findFileInput(doc, win, scope) {
    var view = win || (doc && doc.defaultView) || root;
    var wait = domWait();
    var diagnostics = {
      selector: FILE_INPUT_SELECTOR,
      totalFileInputs: 0,
      scopeStrategy: scope ? 'explicit' : 'auto',
      scopeDescription: scope ? elementDescription(scope) : null,
      scopePath: scope ? pathOf(scope, doc) : null,
      panelDescription: null,
      panelStrategy: null,
      panelInputCount: 0,
      dropZone: null,
      inputs: [],
      usedBy: null
    };

    if (!doc) {
      return { ok: false, code: 'FILE_INPUT_NOT_FOUND', detail: '没有可搜索的 document', diagnostics: diagnostics };
    }

    var all = toArray(doc.querySelectorAll(FILE_INPUT_SELECTOR));
    diagnostics.totalFileInputs = all.length;
    if (all.length === 0) {
      return { ok: false, code: 'FILE_INPUT_NOT_FOUND', diagnostics: diagnostics };
    }

    // --- 收敛搜索范围 ---
    var searchRoot = scope || null;
    var dropZoneReport = null;
    if (!searchRoot) {
      dropZoneReport = findDropZone(doc, view);
      if (dropZoneReport.ok) {
        var panel = findUploadPanelScope(doc, dropZoneReport.element, view);
        if (panel.element) {
          searchRoot = panel.element;
          diagnostics.scopeStrategy = 'upload-panel';
          diagnostics.scopeDescription = elementDescription(panel.element);
          diagnostics.scopePath = pathOf(panel.element, doc);
          diagnostics.panelStrategy = panel.matchedBy;
        }
      }
      if (dropZoneReport.ok) {
        diagnostics.dropZone = {
          description: dropZoneReport.description,
          matchedBy: dropZoneReport.matchedBy,
          path: pathOf(dropZoneReport.element, doc)
        };
      }
    }

    var pool = all;
    var degraded = false;
    if (searchRoot) {
      var scoped = all.filter(function (input) {
        return searchRoot === input || (searchRoot.contains && searchRoot.contains(input));
      });
      diagnostics.scopeInputCount = scoped.length;
      if (scoped.length > 0) {
        pool = scoped;
      } else if (scope) {
        // 调用方明确指定了作用域（上传面板）：里面没有输入框就是「没有」，
        // 绝不放宽到全文档 —— 否则会误用页面别处的输入框（例如视频上传）。
        diagnostics.degraded = false;
        diagnostics.scopeDegraded = null;
        return {
          ok: false,
          code: 'FILE_INPUT_NOT_FOUND',
          detail: '上传面板内没有 input[type=file]（面板：' + elementDescription(scope) + '）',
          diagnostics: diagnostics
        };
      } else {
        degraded = true;
        diagnostics.scopeDegraded = '面板作用域内没有文件输入框，已退化为全文档搜索';
        searchRoot = null;
      }
    }
    diagnostics.usedScope = !!searchRoot;
    diagnostics.degraded = degraded;

    // --- 候选打分 ---
    var dropZone = dropZoneReport && dropZoneReport.ok ? dropZoneReport.element : null;
    var scored = pool.map(function (input, index) {
      var distance = dropZone ? wait.domDistance(input, dropZone) : null;
      return {
        input: input,
        indexInPool: index,
        distance: distance,
        accept: input.getAttribute('accept') || '',
        acceptsImage: acceptsImage(input),
        visible: wait ? wait.isVisible(input, view) : true,
        description: elementDescription(input),
        path: pathOf(input, doc)
      };
    });

    diagnostics.inputs = all.map(function (input, i) {
      var inScope = searchRoot ? (searchRoot === input || (searchRoot.contains && searchRoot.contains(input))) : false;
      return {
        index: i,
        accept: input.getAttribute('accept') || '',
        visible: wait ? wait.isVisible(input, view) : true,
        inScope: inScope,
        distanceToDropZone: dropZone ? wait.domDistance(input, dropZone) : null,
        description: elementDescription(input),
        path: pathOf(input, doc)
      };
    });
    diagnostics.poolSize = scored.length;
    diagnostics.panelInputCount = scored.length;

    if (scored.length === 1) {
      var only = scored[0];
      diagnostics.usedBy = only.acceptsImage
        ? 'image-file-input'
        : (searchRoot ? 'unique-in-panel' : 'unique-in-document');
      diagnostics.scopeResolved = searchRoot ? 'panel' : 'document';
      return { ok: true, element: only.input, diagnostics: diagnostics, matchedBy: diagnostics.usedBy };
    }

    // 与拖拽区最近者优先（DOM 距离最小；距离相同时不视为可区分）
    if (dropZone) {
      var finite = scored.filter(function (item) {
        return typeof item.distance === 'number' && isFinite(item.distance);
      });
      if (finite.length > 0) {
        finite.sort(function (a, b) {
          return a.distance - b.distance;
        });
        var best = finite[0];
        var tied = finite.filter(function (item) {
          return item.distance === best.distance;
        });
        if (tied.length === 1) {
          diagnostics.usedBy = 'nearest-to-drop-zone';
          diagnostics.chosenDistance = best.distance;
          diagnostics.runnerUpDistance = finite.length > 1 ? finite[1].distance : null;
          return { ok: true, element: best.input, diagnostics: diagnostics, matchedBy: diagnostics.usedBy };
        }
      }
    }

    var imagePool = pool.filter(acceptsImage);
    diagnostics.imagePoolSize = imagePool.length;
    if (imagePool.length === 1) {
      diagnostics.usedBy = 'image-file-input';
      return { ok: true, element: imagePool[0], diagnostics: diagnostics, matchedBy: 'image-file-input' };
    }

    var visible = pool.filter(function (input) {
      return wait ? wait.isVisible(input, view) : true;
    });
    diagnostics.visiblePoolSize = visible.length;
    if (visible.length === 1) {
      diagnostics.usedBy = 'only-visible-input';
      return { ok: true, element: visible[0], diagnostics: diagnostics, matchedBy: 'only-visible-input' };
    }

    return {
      ok: false,
      code: 'FILE_INPUT_AMBIGUOUS',
      detail: '候选文件输入框 ' + pool.length + ' 个（作用域：' + diagnostics.scopeStrategy +
        (dropZone ? '，均无法按与拖拽区的距离区分' : '') + '）',
      candidates: pool,
      diagnostics: diagnostics
    };
  }

  /** 面板内所有可点击按钮的文本与状态（诊断用，便于确认按钮文案是否变化） */
  function surveyPanelButtons(doc, win, scope) {
    var view = win || (doc && doc.defaultView) || root;
    var wait = domWait();
    var target = scope || doc;
    if (!target || !target.querySelectorAll) {
      return [];
    }
    var seen = [];
    for (var i = 0; i < BUTTON_SELECTORS.length; i += 1) {
      var nodes = toArray(target.querySelectorAll(BUTTON_SELECTORS[i]));
      for (var j = 0; j < nodes.length; j += 1) {
        if (seen.indexOf(nodes[j]) === -1) {
          seen.push(nodes[j]);
        }
      }
    }
    return seen.map(function (node) {
      var text = normalizeText(node.textContent || '');
      return {
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        className: (node.getAttribute && node.getAttribute('class')) || '',
        disabled: isDisabled(node),
        visible: wait ? wait.isVisible(node, view) : true
      };
    });
  }

  function isDisabled(node) {
    if (!node) {
      return true;
    }
    if (node.disabled === true) {
      return true;
    }
    if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') {
      return true;
    }
    var cls = (node.getAttribute && node.getAttribute('class')) || '';
    return /(^|[\s-])disabled([\s-]|$)/i.test(cls);
  }

  /**
   * 在上传面板内查找「确认上传」按钮（文本精确匹配，避免误点「上传图片」等卡片按钮）。
   */
  function findConfirmUploadButton(doc, win, scope) {
    var view = win || (doc && doc.defaultView) || root;
    var wait = domWait();
    var target = scope || doc;
    var diagnostics = {
      texts: CONFIRM_BUTTON_TEXTS,
      panelDescription: target ? elementDescription(target) : null,
      scanned: [],
      matchedBy: null
    };
    if (!target || !target.querySelectorAll) {
      return { ok: false, code: 'CONFIRM_UPLOAD_BUTTON_NOT_FOUND', diagnostics: diagnostics };
    }

    diagnostics.scanned = surveyPanelButtons(doc, view, target);

    var seen = [];
    var candidates = [];
    for (var i = 0; i < BUTTON_SELECTORS.length; i += 1) {
      var nodes = toArray(target.querySelectorAll(BUTTON_SELECTORS[i]));
      for (var j = 0; j < nodes.length; j += 1) {
        var node = nodes[j];
        if (seen.indexOf(node) !== -1) {
          continue;
        }
        seen.push(node);
        var text = normalizeText(node.textContent || '');
        if (CONFIRM_BUTTON_TEXTS.indexOf(text) === -1) {
          continue;
        }
        candidates.push({
          element: node,
          text: text,
          disabled: isDisabled(node),
          visible: wait ? wait.isVisible(node, view) : true,
          description: elementDescription(node)
        });
      }
    }

    var visibleCandidates = candidates.filter(function (item) {
      return item.visible;
    });
    var pool = visibleCandidates.length > 0 ? visibleCandidates : candidates;
    diagnostics.candidateCount = candidates.length;
    diagnostics.visibleCandidateCount = visibleCandidates.length;

    if (pool.length === 0) {
      return { ok: false, code: 'CONFIRM_UPLOAD_BUTTON_NOT_FOUND', diagnostics: diagnostics };
    }
    if (pool.length > 1) {
      // 多个同文案按钮：优先唯一的可点击者
      var enabled = pool.filter(function (item) {
        return !item.disabled;
      });
      if (enabled.length !== 1) {
        return {
          ok: false,
          code: 'CONFIRM_UPLOAD_BUTTON_NOT_FOUND',
          detail: '文案为「确认上传」的按钮有 ' + pool.length + ' 个，无法确定唯一目标',
          diagnostics: diagnostics
        };
      }
      pool = enabled;
    }

    var chosen = pool[0];
    if (chosen.disabled) {
      return {
        ok: false,
        code: 'CONFIRM_UPLOAD_BUTTON_DISABLED',
        element: chosen.element,
        text: chosen.text,
        diagnostics: diagnostics
      };
    }
    diagnostics.matchedBy = chosen.description;
    return {
      ok: true,
      element: chosen.element,
      text: chosen.text,
      description: chosen.description,
      diagnostics: diagnostics
    };
  }

  /** 一次性汇总上传面板结构（用于阶段日志，便于改版后快速定位问题） */
  function describeUploadPanel(doc, win) {
    var view = win || (doc && doc.defaultView) || root;
    var dropZone = findDropZone(doc, view);
    var panel = dropZone.ok ? findUploadPanelScope(doc, dropZone.element, view) : { element: null, diagnostics: {} };
    var modal = dropZone.ok ? findModalScope(doc, dropZone.element, view) : { element: null, diagnostics: {} };
    var inputs = toArray(doc ? doc.querySelectorAll(FILE_INPUT_SELECTOR) : []);
    var scope = panel.element || null;
    var buttonScope = modal.element || scope;
    return {
      dropZoneFound: dropZone.ok,
      dropZoneMatchedBy: dropZone.ok ? dropZone.matchedBy : null,
      dropZoneDescription: dropZone.ok ? dropZone.description : null,
      dropZonePath: dropZone.ok ? pathOf(dropZone.element, doc) : null,
      dropZoneError: dropZone.ok ? null : dropZone.code,
      panelFound: !!scope,
      panelStrategy: panel.matchedBy || null,
      panelDescription: scope ? elementDescription(scope) : null,
      panelPath: scope ? pathOf(scope, doc) : null,
      modalFound: !!modal.element,
      modalSelector: modal.diagnostics ? modal.diagnostics.selector || null : null,
      modalDescription: modal.element ? elementDescription(modal.element) : null,
      documentInputCount: inputs.length,
      panelInputCount: scope ? inputs.filter(function (input) {
        return scope === input || (scope.contains && scope.contains(input));
      }).length : 0,
      inputSummary: inputs.map(function (input) {
        var wait = domWait();
        return {
          accept: input.getAttribute('accept') || '',
          visible: wait ? wait.isVisible(input, view) : true,
          inPanel: scope ? (scope === input || (scope.contains && scope.contains(input))) : false,
          path: pathOf(input, doc)
        };
      }),
      // 底部按钮在弹层里，不在拖拽区那一层
      buttons: buttonScope ? surveyPanelButtons(doc, view, buttonScope) : []
    };
  }

  NS.uploadLocator = {
    UPLOAD_BUTTON_SELECTOR: UPLOAD_BUTTON_SELECTOR,
    UPLOAD_HINT_TEXT: UPLOAD_HINT_TEXT,
    FILE_INPUT_SELECTOR: FILE_INPUT_SELECTOR,
    UPLOAD_CONTAINER_SELECTORS: UPLOAD_CONTAINER_SELECTORS,
    DROP_ZONE_SELECTORS: DROP_ZONE_SELECTORS,
    PANEL_SELECTORS: PANEL_SELECTORS,
    CONFIRM_BUTTON_TEXTS: CONFIRM_BUTTON_TEXTS,
    BUTTON_SELECTORS: BUTTON_SELECTORS,
    normalizeText: normalizeText,
    textOfUploadButton: textOfUploadButton,
    findVisibleUploadButtons: findVisibleUploadButtons,
    selectUploadButton: selectUploadButton,
    findUploadHintArea: findUploadHintArea,
    countUploadContainers: countUploadContainers,
    acceptsImage: acceptsImage,
    probeDocument: probeDocument,
    pathOf: pathOf,
    closestDropZoneLike: closestDropZoneLike,
    dedupeOutermost: dedupeOutermost,
    findDropZone: findDropZone,
    findUploadPanelScope: findUploadPanelScope,
    findModalScope: findModalScope,
    findFileInput: findFileInput,
    surveyPanelButtons: surveyPanelButtons,
    isDisabled: isDisabled,
    findConfirmUploadButton: findConfirmUploadButton,
    describeUploadPanel: describeUploadPanel
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
