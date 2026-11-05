// Node 22+. Secrets come from the process environment, never source or command arguments.
import fs from 'node:fs/promises';
import path from 'node:path';
const {TELEGRAM_BOT_TOKEN,TEAMBOARD_URL,TEAMBOARD_BRIDGE_KEY,SITES_SERVICE_TOKEN}=process.env;
if(!TELEGRAM_BOT_TOKEN||!TEAMBOARD_URL||!TEAMBOARD_BRIDGE_KEY)throw new Error('Set TELEGRAM_BOT_TOKEN, TEAMBOARD_URL, TEAMBOARD_BRIDGE_KEY in the service environment.');
const site=new URL(TEAMBOARD_URL);if(site.protocol!=='https:'||site.username||site.password)throw new Error('TEAMBOARD_URL must be an HTTPS Site origin.');
const statePath=path.resolve(process.env.BOT_STATE_FILE||'/var/lib/teamboard-bot/state.json');
await fs.mkdir(path.dirname(statePath),{recursive:true,mode:0o700});
const lock=statePath+'.lock';
async function processStart(pid){try{const stat=await fs.readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}catch{return null;}}
const record={pid:process.pid,start:await processStart(process.pid)};
async function acquire(){const handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify(record));await handle.close();}
try{await acquire();}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=JSON.parse(await fs.readFile(lock,'utf8'))}catch{old=null;}if(old?.start&&await processStart(old.pid)===old.start)throw new Error('A bot process already uses this state file.');await fs.unlink(lock);await acquire();}
let state={offset:0,updateId:null,nextCall:0};try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
async function save(){await fs.writeFile(statePath+'.tmp',JSON.stringify(state),{mode:0o600});await fs.rename(statePath+'.tmp',statePath);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let stopping=false;process.on('SIGTERM',()=>stopping=true);process.on('SIGINT',()=>stopping=true);
async function telegram(method,body={}){const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(35000)});const d=await r.json();if(!d.ok){const error=new Error('Telegram request failed');error.status=d.error_code||r.status;error.retryAfter=d.parameters?.retry_after;throw error;}return d.result;}
async function board(body){const r=await fetch(site.origin+'/api/telegram',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TEAMBOARD_BRIDGE_KEY},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok){const error=new Error('Board request failed');error.status=r.status;throw error;}return r.json();}
// Voice transfer is bounded and never sends the Telegram token to Team007 or Mac.
async function transferVoice(body){
 const jobId=body.jobId,fileId=body.fileId;
 if(typeof jobId!=='string'||!/^[a-f0-9-]{36}$/.test(jobId)||typeof fileId!=='string'||fileId.length>512)throw new Error('Invalid voice request');
 const upload=async (audio,error=false)=>{
  const r=await fetch(site.origin+'/api/telegram/voice',{method:'POST',headers:{'Content-Type':'audio/ogg',Authorization:'Bearer '+TEAMBOARD_BRIDGE_KEY,'X-Job-Id':jobId,...(error?{'X-Audio-Error':'1'}:{})},body:audio,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok&&r.status!==409){const e=new Error('Audio upload failed');e.status=r.status;throw e;}
 };
 let audio;
 try{
  const f=await telegram('getFile',{file_id:fileId});
  if(typeof f.file_path!=='string'||!/^voice\/[A-Za-z0-9_./-]+$/.test(f.file_path)||f.file_path.split('/').includes('..')||f.file_size>524288)throw new Error('Unsupported voice file');
  const r=await fetch('https://api.telegram.org/file/bot'+TELEGRAM_BOT_TOKEN+'/'+f.file_path,{redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!r.ok||Number(r.headers.get('content-length')||0)>524288)throw new Error('Voice unavailable');
  const chunks=[];let length=0;for await(const chunk of r.body){length+=chunk.length;if(length>524288)throw new Error('Voice too large');chunks.push(chunk);}
  audio=Buffer.concat(chunks);if(audio.length<4||audio.subarray(0,4).toString()!=='OggS')throw new Error('Invalid OGG');
 }catch{await upload(new Uint8Array(),true);return;}
 await upload(audio);
}
// End voice transfer.
async function deliverOutbox(){const {messages}=await board({action:'outbox'});for(const message of messages){try{await telegram('sendMessage',{chat_id:message.chatId,text:message.text});}catch(e){if(e.retryAfter){await pause(Math.min(e.retryAfter,60)*1000);throw e;}if(e.status>=400&&e.status<500){await board({action:'ack',id:message.id,state:'failed',error:'Telegram отклонил сообщение. Проверьте доступ бота к чату.'});continue;}throw e;}await board({action:'ack',id:message.id,state:'sent'});await pause(60);}}
try{
 const me=await telegram('getMe'),webhook=await telegram('getWebhookInfo');if(webhook.url)throw new Error('This bot already uses a webhook. Use a dedicated bot or remove that webhook deliberately before starting.');
 await board({action:'heartbeat',username:me.username,voiceBridge:true});console.log('Teamboard bot connected.');
 let lastHeartbeat=0;
 while(!stopping){try{
 if(Date.now()-lastHeartbeat>30000){await board({action:'heartbeat',username:me.username,voiceBridge:true});lastHeartbeat=Date.now();}
 await deliverOutbox();
 const updates=await telegram('getUpdates',{offset:state.offset,timeout:15,limit:20,allowed_updates:['message','callback_query']});
 for(const update of updates){if(stopping)break;
 if(state.updateId!==update.update_id){state.updateId=update.update_id;state.nextCall=0;await save();}
 // Strip unrelated attachments and metadata before forwarding a Telegram event.
 const clean={update_id:update.update_id};if(update.message)clean.message={text:update.message.text,chat:{id:update.message.chat.id,type:update.message.chat.type},from:update.message.from?{id:update.message.from.id,username:update.message.from.username}:undefined};if(update.message?.voice){const v=update.message.voice;clean.message.voice={file_id:v.file_id,duration:v.duration,file_size:v.file_size};};if(update.callback_query){const q=update.callback_query;clean.callback_query={id:q.id,data:q.data,from:{id:q.from.id,username:q.from.username},message:q.message?{chat:{id:q.message.chat.id,type:q.message.chat.type}}:undefined};}
 const result=await board({action:'update',update:clean});const calls=result.calls||[];
 for(let i=state.nextCall;i<calls.length;i++){const call=calls[i];if(call.method==='downloadVoice'){await transferVoice(call.body);state.nextCall=i+1;await save();continue;}if(!['sendMessage','answerCallbackQuery'].includes(call.method))throw new Error('Unsupported bot operation');try{await telegram(call.method,call.body);}catch(e){if(e.retryAfter)await pause(Math.min(e.retryAfter,60)*1000);if(call.method!=='answerCallbackQuery'||e.status!==400)throw e;}state.nextCall=i+1;await save();}
 state={offset:update.update_id+1,updateId:null,nextCall:0};await save();
 }
 }catch(e){console.error('Bot operation failed; retrying.',e.status?`HTTP ${e.status}`:'Connection error');await pause(5000);}}
}finally{await fs.unlink(lock).catch(()=>{});}
