/**
 * shared/validation.js
 * 文件元数据 / Data URL 校验（格式、大小、文件头魔数、字节一致）。
 * 必须在「删除旧图片」之前完成全部校验。
 *
 * 形态：经典脚本，挂载到 globalThis.AEIIR.validation。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  var ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg'];
  var ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
  var MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
  var DATA_URL_PATTERN = /^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?(;charset=[^;,]+)?(;base64)?,/i;

  function normalizeMime(type) {
    var t = String(type || '').trim().toLowerCase();
    if (t === 'image/jpg') {
      return 'image/jpeg';
    }
    return t;
  }

  function extensionOf(name) {
    var text = String(name || '');
    var dot = text.lastIndexOf('.');
    return dot === -1 ? '' : text.slice(dot).toLowerCase();
  }

  /** 校验文件元数据（name / type / size），不读取内容 */
  function validateFileMeta(meta) {
    if (!meta || typeof meta !== 'object') {
      return { ok: false, code: 'FILE_META_MISSING' };
    }
    var name = String(meta.name || '').trim();
    var type = normalizeMime(meta.type);
    var size = Number(meta.size);

    if (!name) {
      return { ok: false, code: 'FILE_NAME_MISSING' };
    }
    if (ALLOWED_MIME_TYPES.indexOf(type) === -1) {
      return { ok: false, code: 'INVALID_FILE_TYPE', detail: '当前类型：' + (meta.type || '未知') };
    }
    var ext = extensionOf(name);
    if (ext && ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
      return { ok: false, code: 'INVALID_FILE_TYPE', detail: '扩展名 ' + ext + ' 与 MIME 不匹配' };
    }
    if (!isFinite(size) || size <= 0) {
      return { ok: false, code: 'INVALID_FILE_SIZE', detail: 'size=' + String(meta.size) };
    }
    if (size > MAX_FILE_BYTES) {
      return {
        ok: false,
        code: 'FILE_TOO_LARGE',
        detail: size + ' 字节（' + (size / 1024 / 1024).toFixed(2) + ' MB），上限 5 MB'
      };
    }
    return { ok: true };
  }

  /** 浏览器 File 对象校验（popup 侧使用） */
  function validateFileObject(file) {
    if (!file) {
      return { ok: false, code: 'FILE_META_MISSING' };
    }
    return validateFileMeta({ name: file.name, type: file.type, size: file.size });
  }

  function base64ByteLength(base64) {
    var text = String(base64 || '');
    if (!text) {
      return 0;
    }
    var padding = 0;
    if (text.charAt(text.length - 1) === '=') {
      padding += 1;
    }
    if (text.charAt(text.length - 2) === '=') {
      padding += 1;
    }
    return Math.floor((text.length * 3) / 4) - padding;
  }

  function base64ToBytes(base64, win) {
    var text = String(base64 || '');
    var view = win || root;
    if (typeof view.atob === 'function') {
      var binary = view.atob(text);
      var out = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i) & 0xff;
      }
      return out;
    }
    if (typeof Buffer !== 'undefined') {
      var buf = Buffer.from(text, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    throw new Error('base64ToBytes: 当前环境不支持 Base64 解码');
  }

  /** 通过文件头魔数判断真实图片类型 */
  function sniffImageMime(bytes) {
    if (!bytes || bytes.length < 4) {
      return null;
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image/png';
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    return null;
  }

  function parseDataUrl(dataUrl, win) {
    var text = String(dataUrl || '');
    var match = DATA_URL_PATTERN.exec(text);
    if (!match) {
      return { ok: false, code: 'DATA_URL_INVALID' };
    }
    var mime = normalizeMime(match[1]);
    var isBase64 = /;base64$/i.test(match[3] || '') || /;base64,/i.test(text.slice(0, match[0].length));
    var commaIndex = match[0].length;
    var payload = text.slice(commaIndex);
    if (!isBase64) {
      return { ok: false, code: 'DATA_URL_INVALID', detail: '仅支持 Base64 编码的 Data URL' };
    }
    return {
      ok: true,
      mime: mime,
      base64: payload,
      size: base64ByteLength(payload)
    };
  }

  /** 校验 Data URL + 元数据，并返回可用的字节信息 */
  function validateDataUrl(dataUrl, win, expectedMeta) {
    var parsed = parseDataUrl(dataUrl, win);
    if (!parsed.ok) {
      return parsed;
    }
    if (ALLOWED_MIME_TYPES.indexOf(parsed.mime) === -1) {
      return { ok: false, code: 'INVALID_FILE_TYPE', detail: 'Data URL 类型：' + (parsed.mime || '未知') };
    }
    if (parsed.size <= 0) {
      return { ok: false, code: 'INVALID_FILE_SIZE', detail: '解码后 0 字节' };
    }
    if (parsed.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        code: 'FILE_TOO_LARGE',
        detail: parsed.size + ' 字节，上限 5 MB'
      };
    }
    var bytes;
    try {
      bytes = base64ToBytes(parsed.base64, win);
    } catch (err) {
      return { ok: false, code: 'DATA_URL_DECODE_FAILED', detail: err && err.message };
    }
    var sniffed = sniffImageMime(bytes);
    if (!sniffed) {
      return { ok: false, code: 'IMAGE_MAGIC_MISMATCH', detail: '文件头不是 PNG / JPEG' };
    }
    if (sniffed !== parsed.mime) {
      return {
        ok: false,
        code: 'IMAGE_MAGIC_MISMATCH',
        detail: '声明 ' + parsed.mime + '，实际文件头 ' + sniffed
      };
    }
    if (expectedMeta) {
      var metaCheck = validateFileMeta(expectedMeta);
      if (!metaCheck.ok) {
        return metaCheck;
      }
      if (normalizeMime(expectedMeta.type) !== sniffed) {
        return {
          ok: false,
          code: 'IMAGE_MAGIC_MISMATCH',
          detail: '元数据类型 ' + expectedMeta.type + ' 与实际 ' + sniffed + ' 不一致'
        };
      }
      if (Number(expectedMeta.size) !== parsed.size) {
        return {
          ok: false,
          code: 'FILE_SIZE_MISMATCH',
          detail: '元数据 ' + expectedMeta.size + ' 字节，实际 ' + parsed.size + ' 字节'
        };
      }
    }
    return {
      ok: true,
      mime: parsed.mime,
      size: parsed.size,
      bytes: bytes,
      base64: parsed.base64
    };
  }

  /** 读取 File 为 Data URL（失败时返回错误码，绝不抛到调用方之外的静默分支） */
  function readFileAsDataUrl(file, win, FileReaderCtor) {
    var view = win || root;
    var Reader = FileReaderCtor || view.FileReader;
    return new Promise(function (resolve) {
      if (!Reader) {
        resolve({ ok: false, code: 'FILE_READ_FAILED', detail: '当前环境缺少 FileReader' });
        return;
      }
      var preflight = validateFileObject(file);
      if (!preflight.ok) {
        resolve(preflight);
        return;
      }
      var reader = new Reader();
      reader.onerror = function () {
        resolve({ ok: false, code: 'FILE_READ_FAILED', detail: 'FileReader 报错' });
      };
      reader.onabort = function () {
        resolve({ ok: false, code: 'FILE_READ_FAILED', detail: '读取被中断' });
      };
      reader.onload = function () {
        var result = reader.result;
        var check = validateDataUrl(result, view, { name: file.name, type: file.type, size: file.size });
        if (!check.ok) {
          if (check.code === 'DATA_URL_DECODE_FAILED' || check.code === 'FILE_SIZE_MISMATCH') {
            resolve({ ok: false, code: 'FILE_READ_FAILED', detail: check.detail });
            return;
          }
          resolve(check);
          return;
        }
        resolve({
          ok: true,
          dataUrl: String(result),
          mime: check.mime,
          size: check.size,
          meta: { name: file.name, type: check.mime, size: check.size }
        });
      };
      try {
        reader.readAsDataURL(file);
      } catch (err) {
        resolve({ ok: false, code: 'FILE_READ_FAILED', detail: err && err.message });
      }
    });
  }

  function formatBytes(size) {
    var value = Number(size) || 0;
    if (value < 1024) {
      return value + ' B';
    }
    if (value < 1024 * 1024) {
      return (value / 1024).toFixed(1) + ' KB';
    }
    return (value / 1024 / 1024).toFixed(2) + ' MB';
  }

  NS.validation = {
    ALLOWED_MIME_TYPES: ALLOWED_MIME_TYPES,
    ALLOWED_EXTENSIONS: ALLOWED_EXTENSIONS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    normalizeMime: normalizeMime,
    validateFileMeta: validateFileMeta,
    validateFileObject: validateFileObject,
    validateDataUrl: validateDataUrl,
    parseDataUrl: parseDataUrl,
    base64ToBytes: base64ToBytes,
    base64ByteLength: base64ByteLength,
    sniffImageMime: sniffImageMime,
    readFileAsDataUrl: readFileAsDataUrl,
    formatBytes: formatBytes
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
