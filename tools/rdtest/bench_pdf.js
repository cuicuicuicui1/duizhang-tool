// 对比：命令行通道（每次重启浏览器） vs 复用同一个 puppeteer 浏览器实例
const path=require('path'),fs=require('fs');
process.env.DZ_DATA=path.join(__dirname,'.run','bp_'+Date.now());
const store=require('../../src/store');store.ensureDirs();
const exporter=require('../../src/exporter');
const N=12;
const html='<style>@page{size:A4;margin:25mm}</style>'+Array.from({length:40},(_,i)=>'<p style="font-family:SimSun">第 '+(i+1)+' 行中文测试 1,234.56 元</p>').join('');
(async()=>{
  const dir=path.join(store.DATA,'pdf');fs.mkdirSync(dir,{recursive:true});
  let t=Date.now();
  for(let i=0;i<N;i++) await exporter.htmlToPdfCli(html,path.join(dir,'cli'+i+'.pdf'),null,i%4);
  console.log('命令行通道 '+N+' 个（串行、4 个 profile 轮换）：'+((Date.now()-t)/1000).toFixed(1)+' 秒');

  const probe=exporter.probeBrowser();
  const puppeteer=require('puppeteer-core');
  t=Date.now();
  const browser=await puppeteer.launch({executablePath:probe.path,headless:true,timeout:30000,
    args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--font-render-hinting=none']});
  const launchMs=Date.now()-t;
  t=Date.now();
  for(let i=0;i<N;i++){
    const page=await browser.newPage();
    await page.setContent(html,{waitUntil:'load',timeout:30000});
    await page.emulateMediaType('print');
    await page.pdf({printBackground:true,preferCSSPageSize:true,displayHeaderFooter:false,path:path.join(dir,'pp'+i+'.pdf')});
    await page.close();
  }
  const renderMs=Date.now()-t;
  await browser.close();
  console.log('puppeteer 复用同一浏览器：启动 '+launchMs+'ms + '+N+' 个渲染 '+renderMs+'ms = '+((launchMs+renderMs)/1000).toFixed(1)+' 秒');
  console.log('  平均每份 '+((launchMs+renderMs)/N/1000).toFixed(2)+' 秒');
})();
