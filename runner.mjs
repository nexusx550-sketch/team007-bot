// Node 22+. Secrets come from the process environment, never source or command arguments.
import fs from 'node:fs/promises';
import path from 'node:path';
const {TEAMBOARD_URL,TEAMBOARD_BRIDGE_KEY}=process.env;
const TELEGRAM_BOT_TOKEN=process.env.TELEGRAM_BOT_TOKEN||process.env.BOT_TOKEN||process.env.API_TOKEN;
if(!TELEGRAM_BOT_TOKEN||!TEAMBOARD_URL||!TEAMBOARD_BRIDGE_KEY)throw new Error('Set TELEGRAM_BOT_TOKEN, TEAMBOARD_URL, TEAMBOARD_BRIDGE_KEY in the service environment.');
const site=new URL(TEAMBOARD_URL);if(site.protocol!=='https:'||site.username||site.password)throw new Error('TEAMBOARD_URL must be an HTTPS Site origin.');
const statePath=path.resolve(process.env.BOT_STATE_FILE||path.join(process.env.DATA_DIR||'/app/data','state.json'));
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
async function deliverOutbox(){const {messages}=await board({action:'outbox'});for(const message of messages){try{await telegram('sendMessage',{chat_id:message.chatId,text:message.text});}catch(e){if(e.retryAfter){await pause(Math.min(e.retryAfter,60)*1000);throw e;}if(e.status>=400&&e.status<500){await board({action:'ack',id:message.id,state:'failed',error:'Telegram отклонил сообщение. Проверьте доступ бота к чату.'});continue;}throw e;}await board({action:'ack',id:message.id,state:'sent'});await pause(60);}}
try{
 let connected=false,me;
 while(!stopping&&!connected){try{
 me=await telegram('getMe');const webhook=await telegram('getWebhookInfo');
 if(webhook.url)throw new Error('Active webhook: stop the webhook integration before using polling.');
 await board({action:'heartbeat',username:me.username});connected=true;console.log('Teamboard bot connected.');
 }catch(e){if(e.message.startsWith('Active webhook:'))throw e;console.error('Startup connection failed; retrying.',e.status?`HTTP ${e.status}`:'Connection error');await pause(5000);}}

 let lastHeartbeat=0;
 while(!stopping){try{
 if(Date.now()-lastHeartbeat>30000){await board({action:'heartbeat',username:me.username});lastHeartbeat=Date.now();}
 await deliverOutbox();
 const updates=await telegram('getUpdates',{offset:state.offset,timeout:15,limit:20,allowed_updates:['message','callback_query']});
 for(const update of updates){if(stopping)break;
 if(state.updateId!==update.update_id){state.updateId=update.update_id;state.nextCall=0;await save();}
 // Strip unrelated attachments and metadata before forwarding a Telegram event.
 const clean={update_id:update.update_id};if(update.message)clean.message={text:update.message.text,chat:{id:update.message.chat.id,type:update.message.chat.type},from:update.message.from?{id:update.message.from.id,username:update.message.from.username}:undefined};if(update.callback_query){const q=update.callback_query;clean.callback_query={id:q.id,data:q.data,from:{id:q.from.id,username:q.from.username},message:q.message?{chat:{id:q.message.chat.id,type:q.message.chat.type}}:undefined};}
 const result=await board({action:'update',update:clean});const calls=result.calls||[];
 for(let i=state.nextCall;i<calls.length;i++){const call=calls[i];if(!['sendMessage','answerCallbackQuery'].includes(call.method))throw new Error('Unsupported bot operation');try{await telegram(call.method,call.body);}catch(e){if(e.retryAfter)await pause(Math.min(e.retryAfter,60)*1000);if(call.method!=='answerCallbackQuery'||e.status!==400)throw e;}state.nextCall=i+1;await save();}
 state={offset:update.update_id+1,updateId:null,nextCall:0};await save();
 }
 }catch(e){console.error('Bot operation failed; retrying.',e.status?`HTTP ${e.status}`:'Connection error');await pause(5000);}}
}finally{await fs.unlink(lock).catch(()=>{});}
