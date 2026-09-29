/**
 * content/file-injector.js
 * Data URL -> Blob -> File -> DataTransfer -> input.files，并判定上传结果。
 *
 * 关键约束：
 * - 绝不打开或操作 Windows 文件选择窗口。
 * - 注入前完成格式 / 大小 / 读取校验，校验不过则不进入注入阶段。
 * - 注入后必须核对 input.files.length / 文件名 / MIME / 大小，不一致即 FILE_INJECTION_FAILED。
 * - 注入成功 ≠ 上传成功：只能确认注入时状态为 FILE_INJECTED_UPLOAD_UNCONFIRMED。
 *
 * 形态：经典脚本，挂载到 globalThis.AEIIR.fileInjector。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  var DEFAULT_UPLOAD_TIMEOUT = 30000;

  var PREVIEW_SELECTORS = [
    '.ant-upload-list-item',
    '.ant-upload-list-item-container',
    '[class*="upload-list-item"]',
    // 真实页面（速卖通素材中心上传面板）用的是 material-center-upload-list
    '[class*="upload-list"] img',
    '[class*="material-center-upload"] img',
    '.ant-upload-list img',
    '[class*="upload-area"] img',
    '[class*="upload-drag"] img',
    '[class*="uploader"] img',
    '[class*="preview"] img'
  ];

  var PROGRESS_SELECTORS = [
    '.ant-progress',
    '[class*="progress"]',
    '[class*="uploading"]',
    '[class*="loading"]'
  ];

  var SUCCESS_SELECTORS = [
    '.ant-upload-list-item-done',
    '[class*="upload-list-item-done"]',
    '[class*="upload-success"]',
    '[class*="upload-done"]'
  ];

  function toArray(list) {
    return Array.prototype.slice.call(list || []);
  }

  function validation() {
    return root.AEIIR && root.AEIIR.validation;
  }

  function domWait() {
    return root.AEIIR && root.AEIIR.domWait;
  }

  function errors() {
    return root.AEIIR && root.AEIIR.errors;
  }

  function makeStageError(stage, code, detail, diagnostics) {
    var mod = errors();
    if (mod) {
      return mod.StageError(stage, code, detail, diagnostics);
    }
    var err = new Error(code + (detail ? ': ' + detail : ''));
    err.name = 'StageError';
    err.stage = stage;
    err.code = code;
    err.diagnostics = diagnostics || {};
    return err;
  }

  /** 兼容无 DataTransfer 的实现（例如 jsdom）的最小替身 */
  function createFileListLike(files) {
    var list = { length: files.length, item: function (i) { return files[i] || null; } };
    for (var i = 0; i < files.length; i += 1) {
      list[i] = files[i];
    }
    if (typeof Symbol !== 'undefined' && Symbol.iterator) {
      list[Symbol.iterator] = function () {
        var index = 0;
        return {
          next: function () {
            var done = index >= files.length;
            var value = done ? undefined : files[index];
            index += 1;
            return { value: value, done: done };
          }
        };
      };
    }
    return list;
  }

  function createDataTransferShim() {
    var files = [];
    var shim = {
      __isDataTransferShim: true,
      items: {
        add: function (file) {
          files.push(file);
          return file;
        },
        remove: function (index) {
          files.splice(index, 1);
        },
        clear: function () {
          files.length = 0;
        }
      },
      types: ['Files'],
      clearData: function () {
        files.length = 0;
      }
    };
    Object.defineProperty(shim.items, 'length', {
      get: function () {
        return files.length;
      }
    });
    Object.defineProperty(shim, 'files', {
      get: function () {
        return createFileListLike(files);
      }
    });
    return shim;
  }

  function createDataTransfer(win) {
    var view = win || root;
    var Ctor = view && view.DataTransfer;
    if (typeof Ctor === 'function') {
      try {
        var native = new Ctor();
        if (native && native.items && typeof native.items.add === 'function') {
          return { dataTransfer: native, kind: 'native' };
        }
      } catch (err) {
        // 落到 shim
      }
    }
    return { dataTransfer: createDataTransferShim(), kind: 'shim' };
  }

  function dataUrlToBlob(dataUrl, win) {
    var check = validation().validateDataUrl(dataUrl, win);
    if (!check.ok) {
      throw makeStageError('INJECT_FILE', check.code, check.detail, { validation: check });
    }
    var view = win || root;
    var bytes = check.bytes || validation().base64ToBytes(check.base64, view);
    var BlobCtor = (view && view.Blob) || root.Blob;
    if (typeof BlobCtor !== 'function') {
      throw makeStageError('INJECT_FILE', 'FILE_INJECTION_FAILED', '当前环境缺少 Blob 构造器');
    }
    return { blob: new BlobCtor([bytes], { type: check.mime }), mime: check.mime, size: check.size };
  }

  /** new File([blob], originalFileName, { type: originalMimeType, lastModified: Date.now() }) */
  function buildFile(dataUrl, meta, win) {
    var view = win || root;
    var decoded = dataUrlToBlob(dataUrl, win);
    var FileCtor = (view && view.File) || root.File;
    if (typeof FileCtor !== 'function') {
      throw makeStageError('INJECT_FILE', 'FILE_INJECTION_FAILED', '当前环境缺少 File 构造器');
    }
    var file = new FileCtor([decoded.blob], meta.name, {
      type: meta.type || decoded.mime,
      lastModified: Date.now()
    });
    return { file: file, blob: decoded.blob, mime: decoded.mime };
  }

  function assignFiles(input, dataTransfer) {
    var outcome = { ok: false, method: null, error: null };
    try {
      input.files = dataTransfer.files;
      if (input.files && input.files.length > 0) {
        outcome.ok = true;
        outcome.method = 'input.files = dataTransfer.files';
        return outcome;
      }
    } catch (err) {
      outcome.error = err && err.message ? err.message : String(err);
    }
    // 兜底：某些实现把 files 定义为只读访问器（测试环境常见），用属性定义方式写入
    try {
      Object.defineProperty(input, 'files', {
        value: dataTransfer.files,
        configurable: true,
        enumerable: true,
        writable: true
      });
      outcome.method = 'Object.defineProperty(input, "files")';
      outcome.ok = !!(input.files && input.files.length > 0);
    } catch (err2) {
      outcome.error = (outcome.error ? outcome.error + ' / ' : '') + (err2 && err2.message ? err2.message : String(err2));
    }
    return outcome;
  }

  function dispatchInputEvents(input, win) {
    var view = win || (input.ownerDocument && input.ownerDocument.defaultView) || root;
    var EventCtor = view && view.Event;
    var dispatched = [];
    var names = ['input', 'change'];
    for (var i = 0; i < names.length; i += 1) {
      var name = names[i];
      var event = EventCtor
        ? new EventCtor(name, { bubbles: true, cancelable: true, composed: true })
        : { type: name };
      if (typeof input.dispatchEvent === 'function') {
        input.dispatchEvent(event);
      }
      dispatched.push({ type: name, bubbles: true, composed: true });
    }
    return dispatched;
  }

  /**
   * 构造带 dataTransfer 的拖拽事件。
   * 优先 DragEvent（Chrome 支持 dataTransfer 初始化项）；缺失时退化为
   * Event + defineProperty('dataTransfer')，保证 React 的合成事件仍能读到文件。
   */
  function createDragEvent(win, type, dataTransfer) {
    var view = win || root;
    var DragEventCtor = view && view.DragEvent;
    if (typeof DragEventCtor === 'function') {
      try {
        return {
          event: new DragEventCtor(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer: dataTransfer
          }),
          kind: 'DragEvent'
        };
      } catch (err) {
        // 落到 Event + defineProperty
      }
    }
    var EventCtor = view && view.Event;
    if (typeof EventCtor !== 'function') {
      return { event: null, kind: null, error: '当前环境缺少 Event 构造器' };
    }
    var event = new EventCtor(type, { bubbles: true, cancelable: true, composed: true });
    try {
      Object.defineProperty(event, 'dataTransfer', {
        value: dataTransfer,
        configurable: true,
        enumerable: true
      });
      return { event: event, kind: 'Event+dataTransfer' };
    } catch (err2) {
      return {
        event: null,
        kind: null,
        error: '无法为事件附加 dataTransfer：' + (err2 && err2.message ? err2.message : String(err2))
      };
    }
  }

  /**
   * 向拖拽区依次派发 dragenter -> dragover -> drop。
   * dragenter / dragover 上主动 preventDefault（真实拖拽里这是「这里是合法投放目标」的信号）。
   */
  function dispatchDragSequence(dropZone, dataTransfer, win) {
    var view = win || (dropZone && dropZone.ownerDocument && dropZone.ownerDocument.defaultView) || root;
    var order = ['dragenter', 'dragover', 'drop'];
    var records = [];
    for (var i = 0; i < order.length; i += 1) {
      var type = order[i];
      var built = createDragEvent(view, type, dataTransfer);
      if (!built.event) {
        return {
          ok: false,
          code: 'DRAG_EVENT_UNSUPPORTED',
          detail: built.error || ('无法构造 ' + type + ' 事件'),
          events: records
        };
      }
      var notCancelled = true;
      try {
        notCancelled = dropZone.dispatchEvent(built.event);
      } catch (err) {
        return {
          ok: false,
          code: 'DROP_INJECTION_FAILED',
          detail: '派发 ' + type + ' 事件抛错：' + (err && err.message ? err.message : String(err)),
          events: records
        };
      }
      records.push({
        type: type,
        eventKind: built.kind,
        bubbles: !!built.event.bubbles,
        composed: !!built.event.composed,
        defaultPreventedByPage: !!(built.event.defaultPrevented || notCancelled === false),
        dispatchReturnedTrue: notCancelled === true
      });
    }
    return { ok: true, events: records };
  }

  /**
   * 兜底注入：面板里没有 input[type=file] 时，直接把文件「拖」进拖拽区。
   *
   * 注意：拖拽投放无法像 input.files 那样事前/事后核对文件对象，
   * 因此这里只能确认「事件已按顺序派发」，最终是否被页面接受由
   * waitForUploadResult 的预览/MutationObserver 判据决定。
   */
  function injectViaDropZone(dropZone, dataUrl, meta, options) {
    var opts = options || {};
    if (!dropZone) {
      return { ok: false, code: 'DROP_ZONE_NOT_FOUND', detail: '没有可投放的拖拽区域' };
    }
    var doc = dropZone.ownerDocument;
    var win = opts.win || (doc && doc.defaultView) || root;

    var precheck = validation().validateDataUrl(dataUrl, win, meta);
    if (!precheck.ok) {
      return { ok: false, code: precheck.code, detail: precheck.detail, diagnostics: { stage: 'VALIDATE_FILE' } };
    }

    var built;
    try {
      built = buildFile(dataUrl, meta, win);
    } catch (err) {
      var serialized = errors().serializeError(err, 'INJECT_FILE');
      return { ok: false, code: serialized.code, detail: serialized.message, diagnostics: serialized.diagnostics };
    }

    var dt = createDataTransfer(win);
    if (!dt.dataTransfer || !dt.dataTransfer.items || typeof dt.dataTransfer.items.add !== 'function') {
      return {
        ok: false,
        code: 'DRAG_EVENT_UNSUPPORTED',
        detail: '无法构造 DataTransfer，拖拽投放不可用',
        diagnostics: { dataTransferKind: dt.kind }
      };
    }
    dt.dataTransfer.items.add(built.file);

    var dispatched = dispatchDragSequence(dropZone, dt.dataTransfer, win);
    var diagnostics = {
      strategy: 'drop-zone',
      dataTransferKind: dt.kind,
      dropZone: {
        description: (root.AEIIR && root.AEIIR.messages)
          ? root.AEIIR.messages.describeElement(dropZone)
          : String(dropZone.tagName || '')
      },
      file: {
        name: meta.name,
        type: meta.type,
        size: meta.size
      },
      events: dispatched.events || [],
      eventOrder: ['dragenter', 'dragover', 'drop'],
      assurance: 'events-dispatched',
      note: '拖拽投放无法像 input.files 那样核对文件对象，只能确认事件已派发'
    };

    if (!dispatched.ok) {
      return {
        ok: false,
        code: dispatched.code,
        detail: dispatched.detail,
        diagnostics: diagnostics
      };
    }

    return {
      ok: true,
      file: built.file,
      strategy: 'drop-zone',
      diagnostics: diagnostics
    };
  }

  function verifyInjectedFiles(input, meta) {
    var files = input.files;
    var report = {
      length: files ? files.length : 0,
      fileName: null,
      fileType: null,
      fileSize: null,
      expectedName: meta.name,
      expectedType: meta.type,
      expectedSize: meta.size,
      nameMatches: false,
      typeMatches: false,
      sizeMatches: false
    };
    if (!files || files.length === 0) {
      return { ok: false, reason: 'input.files 为空', report: report };
    }
    var file = files[0];
    report.fileName = file.name;
    report.fileType = file.type;
    report.fileSize = file.size;
    report.nameMatches = String(file.name) === String(meta.name);
    report.typeMatches = String(file.type) === String(meta.type);
    report.sizeMatches = Number(file.size) === Number(meta.size);
    if (files.length !== 1) {
      return { ok: false, reason: 'input.files.length=' + files.length + '，期望 1', report: report };
    }
    if (!report.nameMatches) {
      return { ok: false, reason: '文件名不一致', report: report };
    }
    if (!report.typeMatches) {
      return { ok: false, reason: 'MIME 不一致', report: report };
    }
    if (!report.sizeMatches) {
      return { ok: false, reason: '文件大小不一致', report: report };
    }
    return { ok: true, report: report };
  }

  /**
   * 注入文件并触发 input / change。
   * @returns {ok, code?, detail?, diagnostics?}
   */
  function injectFile(input, dataUrl, meta, options) {
    var opts = options || {};
    if (!input) {
      return { ok: false, code: 'FILE_INPUT_NOT_FOUND', detail: '没有可注入的文件输入框' };
    }
    var doc = input.ownerDocument;
    var win = opts.win || (doc && doc.defaultView) || root;

    var precheck = validation().validateDataUrl(dataUrl, win, meta);
    if (!precheck.ok) {
      return { ok: false, code: precheck.code, detail: precheck.detail, diagnostics: { stage: 'VALIDATE_FILE' } };
    }

    var built;
    try {
      built = buildFile(dataUrl, meta, win);
    } catch (err) {
      var serialized = errors().serializeError(err, 'INJECT_FILE');
      return { ok: false, code: serialized.code, detail: serialized.message, diagnostics: serialized.diagnostics };
    }

    var dt = createDataTransfer(win);
    dt.dataTransfer.items.add(built.file);

    var assign = assignFiles(input, dt.dataTransfer);
    var verification = verifyInjectedFiles(input, meta);
    var diagnostics = {
      dataTransferKind: dt.kind,
      assignMethod: assign.method,
      assignError: assign.error,
      beforeDispatch: verification.report,
      fileConstruction: 'new File([blob], ' + meta.name + ', {type: ' + meta.type + ', lastModified: Date.now()})'
    };

    if (!verification.ok) {
      return {
        ok: false,
        code: 'FILE_INJECTION_FAILED',
        detail: verification.reason,
        diagnostics: diagnostics
      };
    }

    var events = dispatchInputEvents(input, win);
    var afterDispatch = verifyInjectedFiles(input, meta);
    diagnostics.dispatchedEvents = events;
    diagnostics.afterDispatch = afterDispatch.report;
    diagnostics.verifiedBeforeUpload = true;

    if (!afterDispatch.ok) {
      return {
        ok: false,
        code: 'FILE_INJECTION_FAILED',
        detail: '事件派发后校验失败：' + afterDispatch.reason,
        diagnostics: diagnostics
      };
    }

    return {
      ok: true,
      file: built.file,
      diagnostics: diagnostics
    };
  }

  function countBySelectors(doc, selectors) {
    if (!doc || !doc.querySelectorAll) {
      return { count: 0, bySelector: [] };
    }
    var seen = [];
    var bySelector = [];
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = toArray(doc.querySelectorAll(selectors[i])).filter(function (node) {
        return seen.indexOf(node) === -1;
      });
      for (var j = 0; j < nodes.length; j += 1) {
        seen.push(nodes[j]);
      }
      bySelector.push({ selector: selectors[i], count: nodes.length });
      if (nodes.length > 0) {
        // 命中即累计，后续选择器只做补充统计
      }
    }
    return { count: seen.length, bySelector: bySelector, elements: seen };
  }

  function countPreviews(doc) {
    var result = countBySelectors(doc, PREVIEW_SELECTORS);
    return { count: result.count, bySelector: result.bySelector };
  }

  function countProgressElements(doc) {
    var result = countBySelectors(doc, PROGRESS_SELECTORS);
    return { count: result.count, bySelector: result.bySelector };
  }

  function hasSuccessMarker(doc) {
    var result = countBySelectors(doc, SUCCESS_SELECTORS);
    return { found: result.count > 0, bySelector: result.bySelector };
  }

  /**
   * 等待上传结果，区分「已注入 / 已开始上传 / 已确认成功」。
   * 默认等待 30 秒；只能确认注入时返回 FILE_INJECTED_UPLOAD_UNCONFIRMED（不是失败）。
   */
  function waitForUploadResult(options) {
    var opts = options || {};
    var doc = opts.doc;
    var win = opts.win || (doc && doc.defaultView) || root;
    var wait = domWait();
    // 基线必须由调用方在「注入之前」取好再传进来：有些页面在 input/change 事件里
    // 就同步把缩略图渲染出来了，等到这里再取基线会把新增的那张算进基线，导致漏判。
    var before = opts.baseline && typeof opts.baseline.count === 'number'
      ? opts.baseline
      : countPreviews(doc);
    var baselineSource = opts.baseline && typeof opts.baseline.count === 'number'
      ? 'pre-injection'
      : 'at-wait-start';
    var sawProgress = false;
    var progressEverSeen = 0;

    return wait.waitFor({
      doc: doc,
      win: win,
      stage: 'WAIT_UPLOAD_RESULT',
      description: '等待上传结果',
      timeout: typeof opts.timeout === 'number' ? opts.timeout : DEFAULT_UPLOAD_TIMEOUT,
      pollInterval: opts.pollInterval || 300,
      // 默认 0（不节流）保持原行为；调用方可显式开启来压住 MutationObserver 风暴。
      throttleMs: typeof opts.throttleMs === 'number' ? opts.throttleMs : 0,
      observeTarget: doc,
      check: function () {
        var success = hasSuccessMarker(doc);
        var previews = countPreviews(doc);
        var progress = countProgressElements(doc);
        if (progress.count > 0) {
          sawProgress = true;
          progressEverSeen += 1;
        }
        var snapshot = {
          previewsBefore: before.count,
          previewsAfter: previews.count,
          progressElements: progress.count,
          sawProgress: sawProgress
        };
        if (success.found) {
          return {
            done: true,
            snapshot: snapshot,
            value: { criteria: 'success-marker', previewsAfter: previews.count }
          };
        }
        if (previews.count > before.count) {
          return {
            done: true,
            snapshot: snapshot,
            value: { criteria: 'preview-count-increased', previewsBefore: before.count, previewsAfter: previews.count }
          };
        }
        if (sawProgress && progress.count === 0) {
          return {
            done: true,
            snapshot: snapshot,
            value: { criteria: 'progress-disappeared', previewsAfter: previews.count }
          };
        }
        return { done: false, snapshot: snapshot };
      }
    }).then(function (result) {
      var previewsAfter = countPreviews(doc);
      if (result.ok) {
        return {
          ok: true,
          confirmed: true,
          status: 'UPLOAD_CONFIRMED',
          code: null,
          diagnostics: {
            criteria: result.value ? result.value.criteria : null,
            baselineSource: baselineSource,
            previewsBefore: before.count,
            previewsAfter: previewsAfter.count,
            previewsDelta: previewsAfter.count - before.count,
            sawProgress: sawProgress,
            progressPolls: progressEverSeen,
            elapsedMs: result.elapsed,
            polls: result.polls,
            previewsBySelectorBefore: before.bySelector
          }
        };
      }
      return {
        ok: true,
        confirmed: false,
        status: 'FILE_INJECTED_UPLOAD_UNCONFIRMED',
        code: 'UPLOAD_RESULT_UNCONFIRMED',
        diagnostics: {
          timedOut: !!result.timedOut,
          timeoutMs: opts.timeout || DEFAULT_UPLOAD_TIMEOUT,
          previewsBefore: before.count,
          previewsAfter: previewsAfter.count,
          previewsDelta: previewsAfter.count - before.count,
          sawProgress: sawProgress,
          progressPolls: progressEverSeen,
          elapsedMs: result.elapsed,
          polls: result.polls,
          previewsBySelectorBefore: before.bySelector,
          note: '文件已注入页面并触发 input/change，但未观察到服务端上传完成信号'
        }
      };
    });
  }

  NS.fileInjector = {
    DEFAULT_UPLOAD_TIMEOUT: DEFAULT_UPLOAD_TIMEOUT,
    PREVIEW_SELECTORS: PREVIEW_SELECTORS,
    PROGRESS_SELECTORS: PROGRESS_SELECTORS,
    SUCCESS_SELECTORS: SUCCESS_SELECTORS,
    createFileListLike: createFileListLike,
    createDataTransferShim: createDataTransferShim,
    createDataTransfer: createDataTransfer,
    dataUrlToBlob: dataUrlToBlob,
    buildFile: buildFile,
    assignFiles: assignFiles,
    dispatchInputEvents: dispatchInputEvents,
    createDragEvent: createDragEvent,
    dispatchDragSequence: dispatchDragSequence,
    injectViaDropZone: injectViaDropZone,
    verifyInjectedFiles: verifyInjectedFiles,
    injectFile: injectFile,
    countPreviews: countPreviews,
    countProgressElements: countProgressElements,
    hasSuccessMarker: hasSuccessMarker,
    waitForUploadResult: waitForUploadResult
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
