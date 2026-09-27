import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared/errors';
import { createRequestId, errorResponse, okResponse, isExtensionMessage } from '../../src/shared/messages';
import { dispatchMessage, type MessageHandlers } from '../../src/background/message-router';

function makeHandlers(overrides: Partial<MessageHandlers> = {}): MessageHandlers {
  return {
    createEditorSession: async () => ({ sessionId: 'sess-1' }),
    downloadComposite: async (payload) => ({ downloadId: 42, filename: payload.filename }),
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
    expect(isExtensionMessage({ type: 'PING', requestId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'NOPE', requestId: 'r1' })).toBe(false);
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage({ type: 'PING' })).toBe(true);
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

  it('rejects SCAN_ACTIVE_TAB on the service worker channel', async () => {
    const response = await dispatchMessage({ type: 'SCAN_ACTIVE_TAB', requestId: 'r6' }, makeHandlers());
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe(ErrorCode.CONTENT_SCRIPT_UNAVAILABLE);
  });
});
