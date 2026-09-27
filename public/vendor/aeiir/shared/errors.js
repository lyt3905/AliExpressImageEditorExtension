/**
 * shared/errors.js
 * 阶段定义、错误码、中文错误文案与 StageError。
 *
 * 形态：经典脚本，挂载到 globalThis.AEIIR.errors。
 */
(function (root) {
  'use strict';

  var NS = (root.AEIIR = root.AEIIR || {});

  /** 完整业务流程的 12 个阶段（顺序即执行顺序） */
  var STAGES = [
    'VALIDATE_FILE',
    'FIND_TARGET_IMAGE',
    'FIND_DELETE_BUTTON',
    'DELETE_IMAGE',
    'WAIT_IMAGE_REMOVED',
    'FIND_MAIN_UPLOAD_BUTTON',
    'OPEN_UPLOAD_PANEL',
    'FIND_UPLOAD_FRAME',
    'FIND_FILE_INPUT',
    'INJECT_FILE',
    'WAIT_UPLOAD_RESULT',
    'CONFIRM_UPLOAD',
    'COMPLETE'
  ];

  var STAGE_LABELS = {
    PRE_FLIGHT: '前置检查：与页面建立通信',
    VALIDATE_FILE: '校验新图片文件',
    FIND_TARGET_IMAGE: '定位旧图片',
    FIND_DELETE_BUTTON: '定位删除按钮',
    DELETE_IMAGE: '点击删除',
    WAIT_IMAGE_REMOVED: '确认旧图片已移除',
    FIND_MAIN_UPLOAD_BUTTON: '定位主页面独立上传按钮',
    OPEN_UPLOAD_PANEL: '打开上传面板',
    FIND_UPLOAD_FRAME: '探测上传 iframe',
    FIND_FILE_INPUT: '定位文件输入框',
    INJECT_FILE: '注入图片文件',
    WAIT_UPLOAD_RESULT: '等待上传结果',
    CONFIRM_UPLOAD: '确认上传（点击面板底部「确认上传」）',
    COMPLETE: '完成'
  };

  /** 错误码 -> 中文可读错误 */
  var ERROR_MESSAGES = {
    CONFIRMATION_REQUIRED: '未勾选「我确认这是测试商品，允许删除并替换图片」，已拒绝执行删除',

    FILE_META_MISSING: '未提供待上传图片的元数据',
    FILE_NAME_MISSING: '待上传图片缺少文件名',
    INVALID_FILE_TYPE: '仅支持 PNG / JPEG 格式的图片',
    INVALID_FILE_SIZE: '文件大小无效（必须大于 0 字节）',
    FILE_TOO_LARGE: '文件超过 5 MB 上限',
    FILE_READ_FAILED: '图片文件读取失败，已中止流程（未执行删除）',
    DATA_URL_INVALID: '图片数据格式非法（必须是 data:image/png 或 data:image/jpeg 的 Base64 Data URL）',
    DATA_URL_DECODE_FAILED: '图片数据解码失败',
    IMAGE_MAGIC_MISMATCH: '图片内容与声明的格式不一致（文件头校验失败）',
    FILE_SIZE_MISMATCH: '图片数据大小与元数据不一致',

    TARGETING_MODE_INVALID: '定位方式无效（只支持 path = DOM 路径 与 url = URL 特征）',

    TARGET_IMAGE_PATH_MISSING: '未提供旧图片 DOM 路径',
    TARGET_IMAGE_PATH_INVALID: '旧图片 DOM 路径格式非法（必须以 / 开头，形如 /html/body/div[1]/div[2]）',
    TARGET_IMAGE_PATH_NOT_FOUND: '按 DOM 路径未找到对应元素（页面结构可能已变化，请用「只检测」重新取路径）',
    TARGET_IMAGE_PATH_AMBIGUOUS: '按 DOM 路径匹配到多个元素，无法确定唯一目标，已停止（不会猜测）',
    TARGET_IMAGE_PATH_NO_IMAGE: 'DOM 路径指向的元素内没有图片',
    TARGET_IMAGE_PATH_IMAGE_AMBIGUOUS: 'DOM 路径指向的元素内有多张图片，无法确定删除哪一张，已停止（不会猜测）',

    TARGET_IMAGE_NOT_FOUND: '未找到包含指定 URL 特征的目标旧图片',
    TARGET_IMAGE_NOT_UNIQUE: '匹配到多张目标旧图片，无法确定唯一目标，已停止（不会猜测）；如需指定请填写「旧图片匹配序号」',
    TARGET_IMAGE_NEEDLE_MISSING: '未提供旧图片 URL 特征',
    TARGET_IMAGE_INDEX_INVALID: '旧图片匹配序号无效（必须是不小于 0 的整数）',
    TARGET_IMAGE_INDEX_OUT_OF_RANGE: '旧图片匹配序号越界（序号从 0 开始，表示第 1 处匹配）',
    IMAGE_CARD_NOT_FOUND: '目标图片不在 div.image-card 结构内',

    DELETE_BUTTON_NOT_FOUND: '在目标图片附近未找到删除图标（path d 以 M601.344 73.984 开头，最多向上 6 层）',
    DELETE_BUTTON_AMBIGUOUS: '容器内存在多个删除图标且无法确定归属目标图片，已停止（不会猜测）',
    DELETE_CLICK_FAILED: '删除按钮点击失败',
    DELETE_CONFIRMATION_REQUIRED: '页面出现了额外的确认弹窗，已停止，请人工确认后再继续（DELETE_CONFIRMATION_REQUIRED）',
    DELETE_TIMEOUT: '等待旧图片从页面移除超时，删除未完成',

    UPLOAD_BUTTON_NOT_FOUND: '未找到可见的上传按钮（div.image-upload-btn）',
    UPLOAD_BUTTON_INDEX_INVALID: '上传按钮序号无效（必须是不小于 0 的整数）',
    UPLOAD_BUTTON_INDEX_OUT_OF_RANGE: '上传按钮序号越界',
    UPLOAD_BUTTON_CLICK_FAILED: '上传按钮点击失败',

    UPLOAD_FRAME_NOT_FOUND: '未找到包含上传区域的页面或 iframe',
    UPLOAD_FRAME_AMBIGUOUS: '多个 frame 同时匹配上传区域，存在歧义，已停止（不会猜测）',
    FRAME_MESSAGE_FAILED: '与页面 frame 通信失败',

    WRONG_TAB: '当前标签页不是 AliExpress 页面，请先切换到商品发布页',
    CONTENT_SCRIPT_NOT_READY: '页面内容脚本未就绪，自动注入后仍未响应（刷新页面后重试）',
    INJECT_UNAVAILABLE: '扩展缺少 scripting 权限，无法自动注入内容脚本',
    INJECT_FAILED: '内容脚本自动注入失败',

    FILE_INPUT_NOT_FOUND: '未找到文件选择输入框 input[type=file]',
    FILE_INPUT_AMBIGUOUS: '存在多个候选文件输入框，无法确定唯一目标，已停止',
    FILE_INJECTION_FAILED: '文件注入失败（已注入的文件与预期不一致）',

    UPLOAD_PANEL_NOT_FOUND: '未找到上传面板（既没有文件输入框，也没有拖拽上传区域）',
    DROP_ZONE_NOT_FOUND: '未找到上传拖拽区域（页面结构可能已变化）',
    DROP_ZONE_AMBIGUOUS: '页面上存在多个可见的上传拖拽区域，无法确定唯一目标，已停止（不会猜测）',
    DROP_INJECTION_FAILED: '向拖拽区投放文件失败（拖拽事件派发异常）',
    DRAG_EVENT_UNSUPPORTED: '当前页面无法构造拖拽事件（DragEvent / DataTransfer 不可用）',

    CONFIRM_UPLOAD_BUTTON_NOT_FOUND: '未在上传面板内找到「确认上传」按钮（可能该页面拖入即自动生效，无需点击）',
    CONFIRM_UPLOAD_BUTTON_DISABLED: '「确认上传」按钮当前不可点击（未选好图片或仍在上传中）',
    CONFIRM_UPLOAD_CLICK_FAILED: '「确认上传」按钮点击失败',
    CONFIRM_UPLOAD_SKIPPED: '已按设置跳过「确认上传」步骤',

    TAB_NOT_FOUND: '未找到当前标签页',
    TASK_NOT_FOUND: '未找到对应的任务数据（可能已过期或被清理）',
    UNKNOWN_MESSAGE: '收到未知类型的消息',
    INTERNAL_ERROR: '内部错误',

    UPLOAD_RESULT_UNCONFIRMED: '已确认文件注入成功，但未能确认服务端上传完成',
    DETECT_ONLY_OK: '只检测模式完成，未对页面做任何修改'
  };

  function messageOf(code) {
    return ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR;
  }

  function StageError(stage, code, detail, diagnostics) {
    var text = messageOf(code);
    if (detail) {
      text = text + '（' + detail + '）';
    }
    var err = new Error(text);
    err.name = 'StageError';
    err.stage = stage || 'INTERNAL_ERROR';
    err.stageLabel = STAGE_LABELS[err.stage] || err.stage;
    err.code = code || 'INTERNAL_ERROR';
    err.detail = detail || '';
    err.diagnostics = diagnostics || {};
    return err;
  }

  function fail(stage, code, detail, diagnostics) {
    throw StageError(stage, code, detail, diagnostics);
  }

  function isStageError(err) {
    return !!err && err.name === 'StageError';
  }

  /** 把任意异常统一序列化为可回传的结果对象 */
  function serializeError(err, fallbackStage) {
    if (isStageError(err)) {
      return {
        ok: false,
        stage: err.stage,
        stageLabel: err.stageLabel,
        code: err.code,
        message: err.message,
        diagnostics: err.diagnostics || {}
      };
    }
    var message = err && err.message ? err.message : String(err);
    return {
      ok: false,
      stage: fallbackStage || 'INTERNAL_ERROR',
      stageLabel: STAGE_LABELS[fallbackStage] || fallbackStage || '内部错误',
      code: 'INTERNAL_ERROR',
      message: '发生未预期的内部错误：' + message,
      diagnostics: {}
    };
  }

  NS.errors = {
    STAGES: STAGES,
    STAGE_LABELS: STAGE_LABELS,
    ERROR_MESSAGES: ERROR_MESSAGES,
    messageOf: messageOf,
    StageError: StageError,
    fail: fail,
    isStageError: isStageError,
    serializeError: serializeError
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
