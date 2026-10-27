(function(){
const uid='u1'; const db={tasks:[],penalty_entries:[],catalogue_items:[
 {id:'c1',item:'Late for an appointment',points:5,sort:1},{id:'c2',item:'Skipped a planned workout',points:10,sort:2},{id:'c3',item:'Missed a deadline',points:15,sort:3}],
 thresholds:[{id:'t1',points:20,punishment:'No dessert for 3 days',sort:1},{id:'t2',points:50,punishment:'No online shopping for 1 week',sort:2},{id:'t3',points:100,punishment:'Donate $50 to charity',sort:3}],
 user_settings:[{user_id:uid,layout:["today","due","calendar","total","chart"]}],task_series:[],push_subscriptions:[]};
let n=0; const id=()=> 'id'+(++n);
function q(table){ let rows=null, op='select', payload=null, filters=[], single=false, ret=false;
 const api={select(){ret=true;return api}, insert(p){op='insert';payload=p;return api}, update(p){op='update';payload=p;return api}, delete(){op='delete';return api}, upsert(p){op='upsert';payload=p;return api},
  eq(k,v){filters.push(r=>r[k]===v);return api}, gte(k,v){filters.push(r=>r[k]>=v);return api}, lte(k,v){filters.push(r=>r[k]<=v);return api}, in(k,v){filters.push(r=>v.includes(r[k]));return api},
  order(){return api}, single(){single=true;return api}, maybeSingle(){single=true;return api},
  then(res,rej){ let out; const t=db[table];
   if(op==='select') out=t.filter(r=>filters.every(f=>f(r)));
   else if(op==='insert'){ const arr=(Array.isArray(payload)?payload:[payload]).map(p=>({id:id(),user_id:uid,created_at:new Date().toISOString(),completed:false,penalized:false,cleared:false,active:true,...p})); t.push(...arr); out=arr;}
   else if(op==='update'){ out=t.filter(r=>filters.every(f=>f(r))); out.forEach(r=>Object.assign(r,payload)); }
   else if(op==='delete'){ out=[]; for(let i=t.length-1;i>=0;i--) if(filters.every(f=>f(t[i]))) out.push(...t.splice(i,1)); }
   else if(op==='upsert'){ out=[payload]; }
   const data= single? (out[0]||null) : out; res({data:JSON.parse(JSON.stringify(data)),error:null}); } };
 return api; }
window.supabase={createClient(){ return {
 auth:{ getSession:async()=>({data:{session:{user:{id:uid,email:'qa@test'}}}}), onAuthStateChange(){}, signOut:async()=>{} },
 from:q, rpc:async()=>({data:0}), functions:{invoke:async()=>({data:{ok:true}})} }; }};
window.__db=db;
})();
