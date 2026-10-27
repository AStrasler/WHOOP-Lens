// Isolated process used only by the synthetic shared-SQLite concurrency test.
import {DatabaseSync} from 'node:sqlite';
import {d1Database} from '../d1-sqlite.mjs';
import {callWhoop} from '../../src/whoop-api.mjs';
let db,config,next=0;
const pending=new Map();
process.on('message',async message=>{
  if(message.kind==='response'){
    const resolve=pending.get(message.id);pending.delete(message.id);
    resolve(new Response(message.body,{status:message.status}));return;
  }
  if(message.kind==='init'){
    config=message;db=new DatabaseSync(config.path);db.exec('PRAGMA busy_timeout=2000');
    process.send({kind:'ready'});return;
  }
  if(message.kind==='run'){
    const fetcher=(url,options)=>new Promise(resolve=>{
      const id=++next;pending.set(id,resolve);
      process.send({kind:'fetch',id,url,body:options.body?String(options.body):null,headers:options.headers});
    });
    try{
      const results=await Promise.all(Array.from({length:message.count},()=>callWhoop(d1Database(db),config.member,'sleep',config.env,{}, {fetcher})));
      process.send({kind:'done',count:results.length});
    }catch{process.send({kind:'failed'});}
    finally{db.close();process.disconnect();}
  }
});
