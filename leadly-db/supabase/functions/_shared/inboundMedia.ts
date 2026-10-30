export interface InboundMessage {
  from?: string;
  from_user_id?: string;
  user_id?: string;
  id: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  image?: { id: string; mime_type?: string; caption?: string };
  sticker?: { id: string; mime_type?: string; animated?: boolean };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  video?: { id: string; mime_type?: string; caption?: string };
}

export function extractMessageText(message: InboundMessage): string {
  if (message.type === 'text' && message.text?.body) return message.text.body;
  if (message.type === 'button' && message.button?.text) return message.button.text;
  if (message.type === 'interactive' && message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.type === 'interactive' && message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message.type === 'image') return message.image?.caption?.trim() || '[Imagen adjunta]';
  if (message.type === 'sticker') return '[Sticker adjunto]';
  if (message.type === 'audio') return '[Audio no soportado]';
  if (message.type === 'video') return message.video?.caption?.trim() || '[Video adjunto]';
  return `[mensaje no soportado: ${message.type}]`;
}

export function inboundMedia(message: InboundMessage) {
  if (message.type === 'image') return message.image;
  if (message.type === 'sticker') return message.sticker;
  // Videos are blocked before persistence; never download their media.
  if (message.type === 'video') return undefined;
  if (message.type === 'audio') return undefined;
}

export function mediaExtension(type: string, mime: string, size: number): string {
  const extensions: Record<string, Record<string, string>> = {
    image: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
    sticker: { 'image/webp': 'webp' },

  };
  const extension = extensions[type]?.[mime.split(';')[0].trim().toLowerCase()];
  if (!extension || size <= 0 || size > (type === 'video' || type === 'audio' ? 16 : 8) * 1024 * 1024) throw new Error('Unsupported attachment type or size');
  return extension;
}

export function acceptsInboundMessage(message: InboundMessage): boolean {
  return message.type !== 'video' && message.type !== 'audio';
}

export const AUDIO_NOT_SUPPORTED_REPLY = 'Este canal no admite audios ni notas de voz. Por favor, escríbenos tu mensaje por texto.';
