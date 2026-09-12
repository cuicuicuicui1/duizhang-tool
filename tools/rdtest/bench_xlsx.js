// 拆解 toXlsx 的耗时：建表 vs 写盘（zip）
const path=require('path'),fs=require('fs'),XLSX=require('xlsx');
process.env.DZ_DATA=path.join(__dirname,'.run','bx_'+Date.now());
const store=require('../../src/store');store.ensureDirs();
const importer=require('../../src/importer'),unitsMod=require('../../src/units'),ledger=require('../../src/ledger');
const configMod=require('../../src/config'),exporter=require('../../src/exporter');
const cfg=configMod.getConfig();
const u=unitsMod.create({name:'压测单位有限公司',type:'customer'});
const rows=[['日期','摘要','借方金额','贷方金额']];
for(let r=0;r<200;r++){const d=String((r%28)+1).padStart(2,'0');rows.push(['2026-08-'+d,'业务'+r,r%3===0?1000+r:'',r%3===0?'':500+r]);}
const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'S');
XLSX.writeFile(wb,path.join(__dirname,'.run','bx.xlsx'));
const buf=fs.readFileSync(path.join(__dirname,'.run','bx.xlsx'));
const a=importer.analyze({buffer:buf,filename:'bx.xlsx',config:cfg});
importer.commit({buffer:buf,filename:'bx.xlsx',config:cfg,units:unitsMod.all(),plans:[{sheetName:'S',include:true,headerRow:a.sheets[0].headerRowNo,mapping:a.sheets[0].mapping,unitId:u.id,account:'应收账款'}]});
(async()=>{
  const bal=ledger.computeUnitBalance(u.id,{cutoff:'2026-08-31',direction:'receivable',from:'2026-08-01',config:cfg});
  const args={unit:u,balance:bal,session:{period:'2026-08',cutoffDate:'2026-08-31',direction:'receivable'},config:cfg,statement:{serialNo:'X',version:1}};
  for(let i=0;i<3;i++){
    const t=Date.now();
    await exporter.toXlsx(args,path.join(store.DATA,'t'+i+'.xlsx'));
    console.log('第'+(i+1)+'次 toXlsx '+(Date.now()-t)+'ms，文件 '+(fs.statSync(path.join(store.DATA,'t'+i+'.xlsx')).size/1024).toFixed(0)+'KB');
  }
  // 只写一个空工作簿对比
  const ExcelJS=require('exceljs');const wb2=new ExcelJS.Workbook();wb2.addWorksheet('x');
  let t=Date.now();await wb2.xlsx.writeFile(path.join(store.DATA,'empty.xlsx'));console.log('空工作簿 writeFile '+(Date.now()-t)+'ms');
})();
