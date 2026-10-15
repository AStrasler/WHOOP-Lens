// Enforce a byte limit while streaming, including chunked uploads.
export async function readBounded(request,limit){
  const declared=request.headers.get('content-length');
  if(declared!=null&&(!/^\d+$/.test(declared)||Number(declared)>limit)) return {error:'too_large'};
  if(!request.body) return {error:'invalid'};
  const reader=request.body.getReader();
  const chunks=[];
  let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();return {error:'too_large'};}
      chunks.push(value);
    }
  }catch{return {error:'invalid'};}
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};}
  catch{return {error:'invalid'};}
}
