/** Synthetic-only stress check. Run after npm run build. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
async function runner() {
  const assert=require('node:assert/strict'),c=require('./client.cjs');
  let last=Date.now(),gap=0,peak=0;
  const timer=setInterval(()=>{const n=Date.now();gap=Math.max(gap,n-last);last=n;peak=Math.max(peak,process.memoryUsage().rss);},10);
  try {
    const start=Date.now(),list=await c.parseSessionsAsync();
    assert.equal(list.length,1);assert.equal(list[0].messageCount,2);
    const detail=await c.parseSessionDetailAsync('stress',list[0]);
    assert(detail.messages.some(m=>m.content==='tail-needle'));assert.equal(detail.previewLimited,true);
    await c.indexSessionsAsync([{id:'stress',path:process.argv[2]}]);
    assert.deepEqual(await c.searchContentAsync('tail-needle'),['stress']);
    assert(process.memoryUsage().heapUsed<64*1024*1024);
    console.log(JSON.stringify({elapsedMs:Date.now()-start,maxMainHeartbeatGapMs:gap,peakRssMiB:Math.round(peak/1048576),mainHeapMiB:Math.round(process.memoryUsage().heapUsed/1048576),messages:detail.totalMessages,previewLimited:detail.previewLimited}));
  } finally {clearInterval(timer);c.disposeSessionWorker();}
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-worker-stress-'));
try {
  const project=path.join(root,'.claude','projects','synthetic');fs.mkdirSync(project,{recursive:true});
  const file=path.join(project,'stress.jsonl'),fd=fs.openSync(file,'w');
  const record=(role,content)=>JSON.stringify({cwd:root,timestamp:'2026-10-20T00:00:00.000Z',message:{role,content}})+'\n';
  fs.writeSync(fd,record('user','first prompt'));
  for(let i=0;i<40;i++)fs.writeSync(fd,record('assistant','x'.repeat(65536)));
  fs.writeSync(fd,'{"oversized":"');const padding=Buffer.alloc(1024*1024,120);
  const mib=Number(process.env.MANAGER_STRESS_MIB||128);assert(Number.isSafeInteger(mib)&&mib>=1&&mib<=512);
  for(let i=0;i<mib;i++)fs.writeSync(fd,padding);fs.writeSync(fd,'"}\n');
  fs.writeSync(fd,record('user','tail-needle'));fs.closeSync(fd);
  require('esbuild').buildSync({entryPoints:['src/features/sessions/sessionWorkerClient.ts'],bundle:true,platform:'node',target:'node20',format:'cjs',outfile:path.join(root,'client.cjs')});
  fs.copyFileSync('dist/session-worker.js',path.join(root,'session-worker.js'));
  fs.writeFileSync(path.join(root,'run.cjs'),'('+runner.toString()+')().catch(e=>{console.error(e.message);process.exitCode=1});');
  const child=spawnSync(process.execPath,[path.join(root,'run.cjs'),file],{env:{...process.env,USERPROFILE:root,HOME:root},encoding:'utf8',timeout:90000,windowsHide:true});
  process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');assert.equal(child.status,0);console.log(JSON.stringify({fixtureMiB:mib,syntheticHome:true}));
} finally {assert(path.dirname(root)===os.tmpdir()&&path.basename(root).startsWith('manager-worker-stress-'));fs.rmSync(root,{recursive:true,force:true});}