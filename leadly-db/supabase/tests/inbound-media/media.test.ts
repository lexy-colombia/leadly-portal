import { extractMessageText, inboundMedia, mediaExtension } from '../../functions/_shared/inboundMedia.ts';
function assert(value: unknown) { if (!value) throw new Error('Assertion failed'); }
Deno.test('stickers and videos preserve media ids and captions', () => {
 const sticker={id:'s',type:'sticker',sticker:{id:'media-s',animated:true}};
 const video={id:'v',type:'video',video:{id:'media-v',caption:' Una fuga '}};
 assert(extractMessageText(sticker)==='[Sticker adjunto]' && inboundMedia(sticker)?.id==='media-s');
 assert(extractMessageText(video)==='Una fuga' && inboundMedia(video)?.id==='media-v');
 assert(extractMessageText({...video,video:{id:'media-v'}})==='[Video adjunto]');
});
Deno.test('existing text, buttons and images remain supported', () => {
 assert(extractMessageText({id:'1',type:'text',text:{body:'Hola'}})==='Hola');
 assert(extractMessageText({id:'1',type:'image',image:{id:'i'}})==='[Imagen adjunta]');
 assert(extractMessageText({id:'1',type:'interactive',interactive:{button_reply:{title:'Sí'}}})==='Sí');
});
Deno.test('mime types and size bounds are checked before storage', () => {
 assert(mediaExtension('sticker','image/webp',500)==='webp');
 assert(mediaExtension('video','video/mp4',16*1024*1024)==='mp4');
 assert(mediaExtension('video','video/3gpp',500)==='3gp');
 for(const [type,mime,size] of [['video','text/html',500],['sticker','video/mp4',500],['video','video/mp4',16*1024*1024+1]] as const){
  let rejected=false;try{mediaExtension(type,mime,size)}catch{rejected=true}assert(rejected);
 }
});
