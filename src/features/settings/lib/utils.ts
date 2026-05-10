/** `executeAction` の戻りから IPC ペイロードを取り出す（ShogunAPI の二重ラップを吸収）。 */
export function unwrapExecutePayload(res: any) {
  if (!res || !res.data) return null;
  const d = res.data;
  if (d && d.data !== undefined && d.data !== null && typeof d.data === 'object') return d.data;
  return d;
}

/**
 * Read a value saved either as a dotted top-level key (`sections['chat.instructions']`)
 * or nested (`sections.chat.instructions`), with optional `{ value: string }` wrapper.
 */
export function readSectionValue(sections: any, dottedKey: string): string | undefined {
  if (!sections || typeof sections !== 'object') return undefined;
  const direct = sections[dottedKey];
  if (direct != null && typeof direct === 'object' && 'value' in direct) {
    return direct.value == null ? '' : String(direct.value);
  }
  if (typeof direct === 'string') return direct;
  const parts = String(dottedKey || '')
    .split('.')
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  let cur = sections;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[parts[i] as string];
  }
  if (cur != null && typeof cur === 'object' && 'value' in cur) {
    return cur.value == null ? '' : String(cur.value);
  }
  if (typeof cur === 'string') return cur;
  return undefined;
}

export function normalizeEmbedBackfillBatch(raw: any, OPTS: number[]) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 40;
  const r = Math.min(200, Math.max(20, Math.round(n)));
  return OPTS.includes(r) ? r : 40;
}

export function normalizeEmbedBackfillDelayMs(raw: any, OPTS: number[]) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return OPTS.includes(n) ? n : 0;
}

export function isProfilePhotoDataUrlSetting(s: any) {
  const t = s != null ? String(s).trim() : '';
  return t.length > 0 && /^data:image\//i.test(t);
}

export function downscaleDataUrlToMaxEdge(dataUrl: string, maxEdge: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) {
        resolve(dataUrl);
        return;
      }
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      try {
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(c.toDataURL('image/jpeg', 0.88));
      } catch (_e) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export async function imageFileToAvatarDataUrl(file: File, maxBytes: number): Promise<{ dataUrl?: string; error?: string }> {
  if (!file || !file.type.startsWith('image/')) return { error: 'Choose an image file.' };
  if (file.size > maxBytes) {
    return { error: 'Image must be 512 KB or smaller.' };
  }
  const raw = await new Promise<string | ArrayBuffer | null>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  let out = typeof raw === 'string' ? raw : '';
  if (out.length > 550000) {
    out = await downscaleDataUrlToMaxEdge(out, 256);
  }
  if (!isProfilePhotoDataUrlSetting(out) || out.length > 900000) {
    return { error: 'Could not store this image — try a smaller file.' };
  }
  return { dataUrl: out };
}

export function formatBytes(n: number) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
