import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared/errors';
import {
  PAGE_FILL_MESSAGE_TYPE,
  createRequestId,
  errorResponse,
  isExtensionMessage,
  isPageFillMessage,
  okResponse,
} from '../../src/shared/messages';
import { dispatchMessage, type MessageHandlers } from '../../src/background/message-router';
import type { PageFillInput, PageFillResult } from '../../src/shared/types';

function pageFillResult(message = '已回填'): PageFillResult {
  return {
    status: 'success',
    stage: 'COMPLETE',
    code: null,
    message,
    stages: [],
    warnings: [],
    elapsedMs: 12,
    frameId: 0,
    frameUrl: 'https://seller.aliexpress.com/x',
    strategy: 'input',
    confirmed: true,
  };
}

function makeHandlers(overrides: Partial<MessageHandlers> = {}): MessageHandlers {
  return {
    createEditorSession: async () => ({ sessionId: 'sess-1' }),
    downloadComposite: async (payload) => ({ downloadId: 42, filename: payload.filename }),
    replacePageImage: async () => pageFillResult(),
    closeEditorTab: async () => ({ closed: 1 }),
    getSettings: async () => ({ serverUrl: 'https://cutout.test', username: 'admin' }),
    saveSettings: async (payload) => ({ serverUrl: payload.serverUrl, username: payload.username }),
    getAuthState: async () => ({ loggedIn: true, user: { id: 1, username: 'admin' } }),
    login: async (payload) => ({ id: 1, username: payload.username }),
    logout: async () => ({ loggedIn: false }) as never,
    ...overrides,
  };
}

describe('message protocol helpers', () => {
  it('accepts known message types only', () => {
    expect(isExtensionMessage({ type: 'CREATE_EDITOR_SESSION', requestId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'REPLACE_PAGE_IMAGE', requestId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'CLOSE_EDITOR_TAB', requestId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'PING', requestId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'NOPE', requestId: 'r1' })).toBe(false);
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage({ type: 'PING' })).toBe(true);
  });

  it('keeps the page-fill bridge on its own channel', () => {
    // The bridge is injected per frame and addressed by frameId; letting it
    // validate as a normal extension message would let the two channels be
    // confused for one another.
    expect(PAGE_FILL_MESSAGE_TYPE).not.toBe('PING');
    expect(isPageFillMessage({ type: PAGE_FILL_MESSAGE_TYPE, requestId: 'r' })).toBe(true);
    expect(isPageFillMessage({ type: PAGE_FILL_MESSAGE_TYPE })).toBe(true);
    expect(isPageFillMessage({ type: 'REPLACE_PAGE_IMAGE', requestId: 'r' })).toBe(false);
    expect(isPageFillMessage(null)).toBe(false);
    expect(isExtensionMessage({ type: PAGE_FILL_MESSAGE_TYPE, requestId: 'r' })).toBe(false);
  });

  it('builds ok/error envelopes with the original requestId', () => {
    expect(okResponse('r1', { value: 1 })).toEqual({ requestId: 'r1', ok: true, data: { value: 1 } });
    expect(errorResponse('r2', 'E_X', 'boom')).toEqual({
      requestId: 'r2',
      ok: false,
      error: { code: 'E_X', message: 'boom' },
    });
  });

  it('generates unique request ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createRequestId('t')));
    expect(ids.size).toBe(50);
  });
});

describe('dispatchMessage', () => {
  it('routes CREATE_EDITOR_SESSION to the handler', async () => {
    const response = await dispatchMessage(
      {
        type: 'CREATE_EDITOR_SESSION',
        requestId: 'r1',
        payload: { sourceTabId: 1, sourceUrl: 'https://x', images: [] },
      },
      makeHandlers(),
    );
    expect(response).toEqual({ requestId: 'r1', ok: true, data: { sessionId: 'sess-1' } });
  });

  it('routes DOWNLOAD_COMPOSITE and returns the download id', async () => {
    const response = await dispatchMessage(
      { type: 'DOWNLOAD_COMPOSITE', requestId: 'r2', payload: { dataUrl: 'data:image/png;base64,AA', filename: 'a.png' } },
      makeHandlers(),
    );
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ downloadId: 42, filename: 'a.png' });
  });

  it('routes auth messages', async () => {
    const login = await dispatchMessage(
      { type: 'LOGIN', requestId: 'r3', payload: { serverUrl: 'https://x', username: 'admin', password: 'p' } },
      makeHandlers(),
    );
    expect(login.data).toEqual({ id: 1, username: 'admin' });

    const state = await dispatchMessage({ type: 'GET_AUTH_STATE', requestId: 'r4' }, makeHandlers());
    expect(state.data).toEqual({ loggedIn: true, user: { id: 1, username: 'admin' } });
  });

  it('converts thrown errors into an error envelope without leaking a stack', async () => {
    const response = await dispatchMessage(
      { type: 'GET_SETTINGS', requestId: 'r5' },
      makeHandlers({
        getSettings: async () => {
          throw new Error('storage exploded');
        },
      }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe('storage exploded');
    expect(response.error?.code).toBe(ErrorCode.UNKNOWN);
  });

  it('routes REPLACE_PAGE_IMAGE to the page-fill handler', async () => {
    const response = await dispatchMessage(
      {
        type: 'REPLACE_PAGE_IMAGE',
        requestId: 'r7',
        payload: { sessionId: 'sess-1', dataUrl: 'data:image/png;base64,AA', filename: 'a.png' },
      },
      makeHandlers({ replacePageImage: async (payload) => pageFillResult(`session=${payload.sessionId}`) }),
    );
    expect(response.ok).toBe(true);
    expect(response.data).toEqual(pageFillResult('session=sess-1'));
  });

  it('passes the delete-first flag through to the handler untouched', async () => {
    // The router is a dumb pipe, and that is exactly what can go wrong here: a
    // whitelist-style rewrite would silently drop `removeFirstImage` and the
    // editor's checkbox would look like it does nothing.
    const seen: PageFillInput[] = [];
    const response = await dispatchMessage(
      {
        type: 'REPLACE_PAGE_IMAGE',
        requestId: 'r9',
        payload: { sessionId: 'sess-1', dataUrl: 'data:image/png;base64,AA', filename: 'a.png', removeFirstImage: true },
      },
      makeHandlers({ replacePageImage: async (payload) => { seen.push(payload); return pageFillResult('ok'); } }),
    );

    expect(response.ok).toBe(true);
    expect(seen[0]?.removeFirstImage).toBe(true);
  });

  it('surfaces a page-fill failure as an error envelope', async () => {
    const response = await dispatchMessage(
      {
        type: 'REPLACE_PAGE_IMAGE',
        requestId: 'r8',
        payload: { sessionId: 'sess-1', dataUrl: 'data:image/png;base64,AA', filename: 'a.png' },
      },
      makeHandlers({
        replacePageImage: async () => {
          throw Object.assign(new Error('打开上传面板失败：没有可见的上传按钮'), {
            code: ErrorCode.PAGE_FILL_FAILED,
          });
        },
      }),
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCode.PAGE_FILL_FAILED);
    expect(response.error?.message).toContain('打开上传面板失败');
  });

  it('routes CLOSE_EDITOR_TAB and passes the session id through', async () => {
    // The session id is the ONLY thing the background gets, and it is what the
    // tab is matched on. A handler that silently received an undefined session
    // would close nothing, and the auto-close would just look broken.
    const seen: string[] = [];
    const response = await dispatchMessage(
      { type: 'CLOSE_EDITOR_TAB', requestId: 'r12', payload: { sessionId: 'sess-9' } },
      makeHandlers({
        closeEditorTab: async (payload) => {
          seen.push(payload.sessionId);
          return { closed: 2 };
        },
      }),
    );
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ closed: 2 });
    expect(seen).toEqual(['sess-9']);
  });

  it('rejects SCAN_ACTIVE_TAB on the service worker channel', async () => {
    const response = await dispatchMessage({ type: 'SCAN_ACTIVE_TAB', requestId: 'r6' }, makeHandlers());
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCode.CONTENT_SCRIPT_UNAVAILABLE);
  });

  it('names the running build when a message type is unknown', async () => {
    // A missing route means the worker answering is older than its caller, and
    // that reads like a code bug — it sends you through the whole message
    // plumbing looking for a typo. The error must therefore carry the running
    // version and the fix, and must survive an environment with no chrome API
    // (this test runs in node).
    const response = await dispatchMessage(
      { type: 'REPLACE_PAGE_IMAGE_V2', requestId: 'r10' } as unknown as Parameters<typeof dispatchMessage>[0],
      makeHandlers(),
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCode.UNKNOWN);
    expect(response.error?.message).toContain('未知消息类型：REPLACE_PAGE_IMAGE_V2');
    expect(response.error?.message).toContain('扩展版本');
    expect(response.error?.message).toContain('chrome://extensions');
  });

  it('reads that version from the manifest rather than hard-coding it', async () => {
    // Pins the mechanism, not the wording: if this stops reading
    // chrome.runtime.getManifest(), the message would still look right while
    // telling the user nothing useful.
    const globals = globalThis as unknown as { chrome?: unknown };
    const saved = globals.chrome;
    globals.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) } };
    try {
      const response = await dispatchMessage(
        { type: 'NOPE', requestId: 'r11' } as unknown as Parameters<typeof dispatchMessage>[0],
        makeHandlers(),
      );
      expect(response.error?.message).toContain('扩展版本 9.9.9');
    } finally {
      if (saved === undefined) delete globals.chrome;
      else globals.chrome = saved;
    }
  });
});
