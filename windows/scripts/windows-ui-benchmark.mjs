// Uses the app's built-in 600-query benchmark in a real Windows WebView2.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import net from 'node:net';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const executable=path.resolve(process.argv[2]||path.join(root,'src-tauri/target/release/question-bank.exe'));
const source=path.resolve(process.argv[3]||path.join(root,'artifacts/windows-bench-100k.sqlite'));
const output=path.join(root,'artifacts',`windows-ui-benchmark-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const data=path.join(output,'data');
await fs.mkdir(data,{recursive:true});
await fs.copyFile(source,path.join(data,'question-bank.sqlite'));
const {chromium}=await import(process.env.QBANK_PLAYWRIGHT_MODULE?pathToFileURL(process.env.QBANK_PLAYWRIGHT_MODULE).href:'playwright');
const server=net.createServer();
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
await new Promise(resolve=>server.close(resolve));
const app=spawn(executable,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,
  QBANK_DATA_DIR:data,QBANK_BENCHMARK:'1',WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview-profile'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
}});
let browser;
let spawnError; app.on('error',error=>{spawnError=error;});
try{
  for(let i=0;i<120;i++){
    if(spawnError)throw spawnError;
    if(app.exitCode!==null)throw Error(`App exited ${app.exitCode}`);
    try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15000);
  await page.waitForFunction(()=>document.querySelector('.result'));
  await page.bringToFront();
  const info=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('app_info'));
  assert.equal(path.resolve(info.database),path.join(data,'question-bank.sqlite'));
  const summary={at:new Date().toISOString(),executable,source,info,results:[]};
  for(const [mode,label] of [['detail','详细模式'],['speed','极速模式']]){
    await page.getByRole('button',{name:label,exact:true}).click();
    await page.getByRole('button',{name:/^设置与维护/}).click();
    await page.getByRole('button',{name:'运行性能库界面验证',exact:true}).click();
    await page.getByText(/^界面验证完成：/).waitFor({timeout:180000});
    const result=JSON.parse(await fs.readFile(path.join(data,'ui-benchmark-report.json'),'utf8'));
    assert.equal(result.mode,mode);assert.equal(result.samples.length,600);
    await fs.writeFile(path.join(output,`${mode}.json`),JSON.stringify(result,null,2));
    await page.screenshot({path:path.join(output,`${mode}.png`)});
    summary.results.push({mode,questions:result.questions,ui_ms:result.ui_ms,core_ms:result.core_ms});
    console.log(JSON.stringify(summary.results.at(-1)));
    await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  }
}finally{
  await browser?.close().catch(()=>{});
  if(app.exitCode===null){const closed=new Promise(resolve=>app.once('exit',resolve));app.kill();await closed;}
  console.log(`Reports: ${output}`);
}
