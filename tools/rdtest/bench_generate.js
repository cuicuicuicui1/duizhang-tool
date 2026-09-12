// 定位批量生成的耗时构成：并发是否真的生效
const path=require('path'),fs=require('fs'),XLSX=require('xlsx');
const RUNID='benchgen_'+Date.now();
process.env.DZ_DATA=path.join(__dirname,'rdtest','.run',RUNID);
process.env.DZ_BACKUP=path.join(__dirname,'rdtest','.run',RUNID+'_bk');
const store=require('../src/store');store.ensureDirs();
const importer=require('../src/importer'),unitsMod=require('../src/units'),ledger=require('../src/ledger');
const statementMod=require('../src/statement'),configMod=require('../src/config'),exporter=require('../src/exporter');
const cfg=configMod.getConfig();
const N=Number(process.argv[2]||12), CONC=Number(process.argv[3]||10);
const ids=[];
for(let i=1;i<=N;i++){
  const u=unitsMod.create({name:'压测'+i+'号有限公司',type:'customer'});ids.push(u.id);
  const rows=[['日期','摘要','借方金额','贷方金额']];
  for(let r=0;r<200;r++){const d=String((r%28)+1).padStart(2,'0');rows.push(['2026-08-'+d,'业务'+r,r%3===0?1000+r:'',r%3===0?'':500+r]);}
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'S');
  const p=path.join(__dirname,'rdtest','.run','bg'+i+'.xlsx');XLSX.writeFile(wb,p);
  const buf=fs.readFileSync(p);const a=importer.analyze({buffer:buf,filename:'bg.xlsx',config:cfg});
  importer.commit({buffer:buf,filename:'bg.xlsx',config:cfg,units:unitsMod.all(),plans:[{sheetName:'S',include:true,headerRow:a.sheets[0].headerRowNo,mapping:a.sheets[0].mapping,unitId:u.id,account:'应收账款'}]});
}
// 单独量一次 xlsx 与 pdf
(async()=>{
  const u=unitsMod.get(ids[0]);
  const bal=ledger.computeUnitBalance(ids[0],{cutoff:'2026-08-31',direction:'receivable',from:'2026-08-01',config:cfg});
  let t=Date.now();
  await exporter.toXlsx({unit:u,balance:bal,session:{period:'2026-08',cutoffDate:'2026-08-31',direction:'receivable'},config:cfg,statement:{serialNo:'X',version:1}},path.join(store.DATA,'x.xlsx'));
  const xlsxMs=Date.now()-t;
  const tpl=require('../src/templates');
  const html=tpl.renderStatement({unit:u,balance:bal,session:{period:'2026-08',cutoffDate:'2026-08-31',direction:'receivable'},config:cfg,statement:{serialNo:'X',version:1}});
  t=Date.now();
  await exporter.htmlToPdf(html,path.join(store.DATA,'x.pdf'),{slot:0});
  const pdfMs=Date.now()-t;
  console.log('单份：xlsx '+xlsxMs+'ms，pdf '+pdfMs+'ms，合计 '+(xlsxMs+pdfMs)+'ms');

  for(const conc of [1,2,3,6]){
    const t0=Date.now();
    const r=await statementMod.generate({unitIds:ids,cutoffDate:'2026-08-31',direction:'receivable',period:'2026-08',config:cfg,concurrency:conc});
    console.log('并发 '+conc+'：'+N+' 家耗时 '+((Date.now()-t0)/1000).toFixed(1)+' 秒，ok='+r.okCount+'/'+N);
  }
})();
