import { describe, expect, it } from 'vitest';
import { collectPastedImages, namePastedFiles } from '../../src/editor/state/use-paste-images';

/** Minimal `DataTransfer` stand-in: only `files` / `items` are ever read. */
function clipboard(parts: {
  files?: File[];
  items?: Array<{ kind: string; type: string; file: File | null }>;
}): DataTransfer {
  return {
    files: parts.files ?? [],
    items: (parts.items ?? []).map((item) => ({ ...item, getAsFile: () => item.file })),
  } as unknown as DataTransfer;
}

function file(name: string, type: string, bytes = 8): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('collectPastedImages', () => {
  it('returns nothing for a missing clipboard or a text-only paste', () => {
    expect(collectPastedImages(null)).toEqual([]);
    expect(collectPastedImages(clipboard({}))).toEqual([]);
    expect(
      collectPastedImages(clipboard({ items: [{ kind: 'string', type: 'text/plain', file: null }] })),
    ).toEqual([]);
  });

  it('takes the screenshot from `files`', () => {
    const shot = file('', 'image/png');
    expect(collectPastedImages(clipboard({ files: [shot] }))).toEqual([shot]);
  });

  it('collects every image of a multi-item paste, in order', () => {
    const first = file('a.png', 'image/png');
    const second = file('b.png', 'image/png');
    expect(collectPastedImages(clipboard({ files: [first, second] }))).toEqual([first, second]);
  });

  it('falls back to `items` when `files` is empty', () => {
    const shot = file('', 'image/png');
    const items = [
      { kind: 'string', type: 'text/html', file: null },
      { kind: 'file', type: 'image/png', file: shot },
      { kind: 'file', type: 'application/pdf', file: file('doc.pdf', 'application/pdf') },
    ];
    expect(collectPastedImages(clipboard({ items }))).toEqual([shot]);
  });

  it('ignores a duplicate blob reported twice', () => {
    const shot = file('', 'image/png');
    expect(collectPastedImages(clipboard({ files: [shot, shot] }))).toEqual([shot]);
  });
});

describe('namePastedFiles', () => {
  it('leaves a named file alone', () => {
    const named = file('front.png', 'image/png');
    expect(namePastedFiles([named])[0]).toBe(named);
  });

  it('gives a nameless screenshot a readable label and extension', () => {
    const renamed = namePastedFiles([file('', 'image/png'), file('   ', 'image/jpeg')]);

    expect(renamed.map((entry) => entry.name)).toEqual(['本地图片-1.png', '本地图片-2.jpg']);
    // The bytes and the mime type must survive the re-wrap.
    expect(renamed[0]?.type).toBe('image/png');
    expect(renamed[0]?.size).toBe(8);
  });

  it('omits the extension when the mime type is unknown', () => {
    // A nameless paste with no declared type still gets a label; the sniffing
    // step downstream decides whether it is usable at all.
    expect(namePastedFiles([file('', '')])[0]?.name).toBe('本地图片-1');
    expect(namePastedFiles([file('', 'image/webp')])[0]?.name).toBe('本地图片-1.webp');
  });
});
