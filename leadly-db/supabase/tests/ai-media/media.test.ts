import { prepareImageHistory, openAiHistoryMessage, geminiHistoryMessage } from '../../functions/_shared/aiMedia.ts';
function assert(value: unknown) { if (!value) throw new Error('Assertion failed'); }
const message = {direction:'inbound',sender_type:'contact',content:'Una fuga',media_storage_path:'tenant/photo.jpg',media_mime_type:'image/jpeg'};
Deno.test('image bytes and caption reach both providers, text remains text', async () => {
 const [image] = await prepareImageHistory([message], 'tenant', async () => new Blob([new Uint8Array([1,2,3])],{type:'image/jpeg'}));
 assert(image.image?.data === 'AQID');
 const openai = openAiHistoryMessage(image);
 assert(Array.isArray(openai.content) && openai.content[1].image_url?.url === 'data:image/jpeg;base64,AQID');
 assert(geminiHistoryMessage(image).parts.length === 2);
 assert(openAiHistoryMessage({...message,image:undefined}).content === 'Una fuga');
 assert(message.content === 'Una fuga');
});
Deno.test('reject cross-tenant paths and handle missing files without invented vision', async () => {
 let calls=0;
 const history = await prepareImageHistory([{...message,media_storage_path:'other/file.jpg'},message], 'tenant', async () => { calls++; throw new Error('not found'); });
 assert(calls===1 && history.every(m=>!m.image && m.content.includes('No se pudo cargar')));
});
Deno.test('limits prioritize recent images and do not download outbound media', async () => {
 let calls=0;
 const history = await prepareImageHistory([...Array.from({length:6},()=>({...message})),{...message,direction:'outbound'}], 'tenant', async () => {calls++;return new Blob(['image']);});
 assert(calls===4 && !history[0].image && !!history[5].image && !history[6].image);
});
Deno.test('oversized files are omitted', async () => {
 const [result] = await prepareImageHistory([message], 'tenant', async () => new Blob([new Uint8Array(6*1024*1024)]));
 assert(!result.image && result.content.includes('No se pudo cargar'));
});
