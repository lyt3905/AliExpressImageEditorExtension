/**
 * shared/messages.js
 * 消息类型常量与消息工具（popup / service worker / content script 共用）。
 *
 * 形态：经典脚本（classic script），挂载到 globalThis.AEIIR.messages。
 * 之所以不使用 ES Module：content script 不支持 ESM 声明式加载，
 * popup 与 service worker 需要复用同一份代码。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  /** popup -> service worker */
  var MESSAGE_TYPES = {
    START_TASK: 'AEIIR_START_TASK',
    DETECT_ONLY: 'AEIIR_DETECT_ONLY',
    GET_TASK_STATE: 'AEIIR_GET_TASK_STATE',

    /** service worker -> content script（顶层 frame） */
    RUN_FLOW: 'AEIIR_RUN_FLOW',
    RUN_DETECT: 'AEIIR_RUN_DETECT',

    /** content script -> service worker */
    STAGE_LOG: 'AEIIR_STAGE_LOG',
    TASK_RESULT: 'AEIIR_TASK_RESULT',
    DISCOVER_UPLOAD_FRAME: 'AEIIR_DISCOVER_UPLOAD_FRAME',
    REQUEST_INJECT: 'AEIIR_REQUEST_INJECT',

    /** service worker -> content script（任意 frame） */
    PING: 'AEIIR_PING',
    PROBE_UPLOAD: 'AEIIR_PROBE_UPLOAD',
    INJECT_FILE: 'AEIIR_INJECT_FILE',

    /** service worker -> popup（广播） */
    TASK_UPDATE: 'AEIIR_TASK_UPDATE'
  };

  var STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    SUCCESS: 'success',
    UNCONFIRMED: 'unconfirmed',
    FAILED: 'failed',
    ABORTED: 'aborted'
  };

  var STATUS_LABELS = {
    idle: '空闲',
    running: '处理中',
    success: '成功',
    unconfirmed: '部分完成',
    failed: '失败',
    aborted: '已终止'
  };

  /** 帧探测模式 */
  var FRAME_DISCOVERY_MODE = {
    LIST: 'list',
    PROBE: 'probe'
  };

  function makeMessage(type, payload) {
    if (!type) {
      throw new Error('makeMessage: 消息类型不能为空');
    }
    var message = { type: type, sentAt: Date.now() };
    if (payload && typeof payload === 'object') {
      var keys = Object.keys(payload);
      for (var i = 0; i < keys.length; i += 1) {
        message[keys[i]] = payload[keys[i]];
      }
    }
    return message;
  }

  function isType(message, type) {
    return !!message && typeof message === 'object' && message.type === type;
  }

  /** 日志中禁止出现完整 Base64 / Data URL */
  var REDACTED_KEYS = ['dataurl', 'data', 'base64', 'bytes', 'buffer'];
  var MAX_STRING_IN_LOG = 160;
  /**
   * DOM 绝对路径要单独放宽上限。
   * 真实商品发布页的路径有 40 段以上（约 300 字符），如果按普通字符串截断到 160 字符，
   * 「只检测」日志里列出的路径就变成半截、复制回去必然解析失败 ——
   * 而这个功能正是要求用户从日志里复制路径，所以必须完整保留。
   */
  var MAX_PATH_IN_LOG = 800;
  var DOM_PATH_LIKE = /^\/?(html|body)(\[\d+\])?\//i;

  function maxLengthFor(text) {
    return DOM_PATH_LIKE.test(text) ? MAX_PATH_IN_LOG : MAX_STRING_IN_LOG;
  }

  function sanitizeForLog(value, depth) {
    var level = typeof depth === 'number' ? depth : 0;
    if (level > 4) {
      return '[深度截断]';
    }
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value === 'string') {
      var text = value;
      if (/^data:/i.test(text)) {
        return '[已省略 Data URL，长度 ' + text.length + ']';
      }
      var limit = maxLengthFor(text);
      if (text.length > limit) {
        return text.slice(0, limit) + '…[截断，共 ' + text.length + ' 字符]';
      }
      return text;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'function') {
      return '[函数]';
    }
    if (Array.isArray(value)) {
      if (value.length > 20) {
        var head = value.slice(0, 20).map(function (item) {
          return sanitizeForLog(item, level + 1);
        });
        head.push('…[共 ' + value.length + ' 项]');
        return head;
      }
      return value.map(function (item) {
        return sanitizeForLog(item, level + 1);
      });
    }
    if (typeof value === 'object') {
      if (value.nodeType === 1) {
        return '[元素 ' + describeElement(value) + ']';
      }
      var out = {};
      var names = Object.keys(value);
      for (var i = 0; i < names.length; i += 1) {
        var name = names[i];
        if (REDACTED_KEYS.indexOf(String(name).toLowerCase()) !== -1) {
          out[name] = '[已省略]';
        } else {
          out[name] = sanitizeForLog(value[name], level + 1);
        }
      }
      return out;
    }
    return String(value);
  }

  function describeElement(el) {
    if (!el || !el.tagName) {
      return '未知元素';
    }
    var tag = String(el.tagName).toLowerCase();
    var id = el.getAttribute && el.getAttribute('id');
    var cls = el.getAttribute && el.getAttribute('class');
    var parts = [tag];
    if (id) {
      parts.push('#' + id);
    }
    if (cls) {
      parts.push('.' + String(cls).trim().split(/\s+/).slice(0, 3).join('.'));
    }
    return parts.join('');
  }

  /** 只记录文件名 / 类型 / 大小，绝不记录内容 */
  function describeFileMeta(meta) {
    if (!meta) {
      return '文件：未提供';
    }
    return '文件：' + String(meta.name || '(无名)') +
      '，类型：' + String(meta.type || '(未知)') +
      '，大小：' + String(meta.size || 0) + ' 字节';
  }

  NS.messages = {
    MESSAGE_TYPES: MESSAGE_TYPES,
    STATUS: STATUS,
    STATUS_LABELS: STATUS_LABELS,
    FRAME_DISCOVERY_MODE: FRAME_DISCOVERY_MODE,
    makeMessage: makeMessage,
    isType: isType,
    sanitizeForLog: sanitizeForLog,
    describeElement: describeElement,
    describeFileMeta: describeFileMeta
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
