/** Private CRM attachments are loaded once per turn and reused across tool rounds. */
export interface HistoryMessage {
  direction: string;
  sender_type: string;
  content: string;
  media_storage_path?: string | null;
  media_mime_type?: string | null;
  image?: { mimeType: string; data: string };
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const UNAVAILABLE = '\n[No se pudo cargar esta imagen. Pide al usuario que la reenvíe o describa; no inventes su contenido.]';

export async function prepareImageHistory(
  history: HistoryMessage[],
  tenantId: string,
  download: (path: string) => Promise<Blob>,
): Promise<HistoryMessage[]> {
  const result = history.map((message) => ({ ...message }));
  let count = 0;
  let bytes = 0;
  // Prioritize the latest attachments without changing conversation order.
  for (let index = result.length - 1; index >= 0; index--) {
    const message = result[index];
    if (message.direction !== 'inbound') continue;
    const mime = message.media_mime_type?.toLowerCase();
    if (!mime?.startsWith('image/') && !message.media_storage_path && message.content !== '[Imagen adjunta]') continue;
    if (mime && !mime.startsWith('image/')) continue;
    const path = message.media_storage_path;
    if (!path || !path.startsWith(`${tenantId}/`) || path.split('/').includes('..') || !mime || !SUPPORTED.has(mime)) {
      message.content += UNAVAILABLE;
      continue;
    }
    if (count >= MAX_IMAGES) {
      message.content += '\n[Imagen anterior omitida por límite de contexto visual. No asumas su contenido.]';
      continue;
    }
    count++;
    try {
      const blob = await download(path);
      if (!blob.size || blob.size > MAX_IMAGE_BYTES || bytes + blob.size > MAX_TOTAL_BYTES) throw new Error('image_size_limit');
      const data = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < data.length; offset += 8192) binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
      message.image = { mimeType: mime, data: btoa(binary) };
      bytes += blob.size;
    } catch {
      // Never log the image, path or private contents.
      console.warn('AI attachment unavailable');
      message.content += UNAVAILABLE;
    }
  }
  return result;
}

export function openAiHistoryMessage(message: HistoryMessage) {
  const role = message.direction === 'inbound' ? 'user' : 'assistant';
  return {
    role,
    content: message.image && role === 'user'
      ? [{ type: 'text', text: message.content }, { type: 'image_url', image_url: { url: `data:${message.image.mimeType};base64,${message.image.data}`, detail: 'auto' } }]
      : message.content,
  };
}

export function geminiHistoryMessage(message: HistoryMessage) {
  const role = message.direction === 'inbound' ? 'user' : 'model';
  return { role, parts: [
    { text: message.content },
    ...(message.image && role === 'user' ? [{ inlineData: { mimeType: message.image.mimeType, data: message.image.data } }] : []),
  ] };
}
