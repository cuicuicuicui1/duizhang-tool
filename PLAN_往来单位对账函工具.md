# 往来单位对账函批量生成与回函核对工具 — 执行计划

> 本文档交给执行 AI 落地。所有设计决策已定稿，执行时照做即可；
> 遇到本文未覆盖的判断事项，在代码中以 `// MANUAL_REVIEW: ...` 标注，不得自行编造业务口径。

## 0. 给执行者的前言

- 这是一个**纯效率工具**：不碰账务、不记账、不生成凭证，只做「对账函生成 + 回函核对 + 归档」三件事。
- 会计是最终用户，运行在单个会计的 Windows 电脑上，单机单用户，无登录无权限。
- 验收方式：每个 Phase 末尾有明确验收标准，不达标不进入下一 Phase。
- 全程简体中文界面；金额格式 `1,234.56`，货币符号 ¥。

## 1. 技术选型（已定，不得更换）

| 项 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js 22 LTS | 本地常驻服务，`node server.js` 启动后浏览器访问 `http://localhost:3210` |
| 后端 | Express 4，无框架魔法 | 结构直白，方便测试脚本直接 require 模块 |
| 前端 | 原生 HTML + JS + CSS 单页多 Tab | 无构建步骤；可用 jsdom 做无头前端测试 |
| 存储 | JSON 文件（`data/` 目录） | 零依赖、可备份、可人工检查；写库前先备份 |
| Excel 读取 | `xlsx`（SheetJS 社区版） | **唯一能同时读 .xls / .xlsx / .csv 的包**；老财务软件导出土特产多为 .xls |
| Excel 生成 | `exceljs` | 样式、合并单元格、打印区域支持好（SheetJS 社区版无样式，只用于读） |
| CSV 编码 | `iconv-lite` + 自动探测 | 财务软件导出 CSV 常见 GBK/GB18030，Node 原生不支持 |
| PDF 生成 | `puppeteer-core` + 探测系统浏览器 | **禁止下载 Chromium**（国内网络必翻车）。按顺序探测 Edge / Chrome 安装路径；都找不到则降级为「打印优化 HTML」，提示用户浏览器打印另存 PDF |
| 打包下载 | `archiver` | 批量生成后 zip 一键下载 |
| 测试 | Node 内置 `node:test` + 自写断言脚本 | 不引入 jest，脚本统一放 `tools/rdtest/` |

**明确禁用**：数据库 / ORM、前端框架（Vue/React）、构建工具（Vite/Webpack）、SMTP 邮件、OCR。

## 2. 目录结构

```
duizhang/
  server.js               # 入口：Express 启动、静态托管、路由挂载
  src/
    money.js              # 金额工具（红线模块，见 §5.1）
    daxie.js              # 人民币大写转换（纯函数）
    store.js              # JSON 文件存储层（读写、备份、幂等写入）
    columns.js            # 智能列识别（表头别名字典 + 映射）
    importer.js           # 导入解析（xls/xlsx/csv → 标准结构）
    units.js              # 单位档案业务逻辑
    ledger.js             # 己方明细账/余额计算
    templates.js          # 对账函模板渲染（HTML）
    statement.js          # 批量生成（编号、版本、导出调度）
    exporter.js           # ExcelJS 导出 + puppeteer-core PDF 导出
    matcher.js            # 回函差异勾对算法（核心，见 §5.2）
    archive.js            # 归档与历史查询
    routes.js             # 全部 API 路由
  public/
    index.html            # 单页，Tab 切换
    app.js / tabs.js      # 前端逻辑
    style.css
  templates/
    receivable.html       # 应收对账函模板（占位符 {{...}}）
    payable.html          # 应付对账函模板
    detail_page.html      # 明细附页模板
  data/                   # 运行时生成，全部落这里（见 §4）
  tools/rdtest/           # 全部测试脚本
  samples/                # 测试用样本文件（构造的脏数据 Excel）
  package.json
  README.md               # 使用说明（给会计看，少术语）
```

## 3. 数据模型（`data/` 下的 JSON 结构）

```jsonc
// data/units.json — 往来单位档案
[{ "id": "u_xxxx", "name": "邯郸市某某贸易有限公司",   // 全称，对账函抬头用
   "type": "customer",            // customer=客户(应收) supplier=供应商(应付) both=兼有
   "contact": "", "phone": "", "address": "",         // 可选，模板上用
   "alias": ["某某贸易"],          // 简称/别名，导入匹配用
   "createdAt": "2026-09-12T09:00:00+08:00" }]

// data/ledgers.json — 己方明细账（导入后入库的标准结构）
[{ "id": "e_xxxx", "unitId": "u_xxxx",
   "account": "应收账款",          // 来源科目
   "date": "2026-08-15",          // 统一 ISO 日期
   "summary": "销售开票",
   "debitFen": 1500000,           // ★ 金额一律存「分」（整数），无贷方则为 0
   "creditFen": 0,
   "importBatch": "imp_xxxx",     // 追溯来源
   "sourceRow": 37 }]             // 原文件行号，方便对账时回查

// data/sessions.json — 对账批次
[{ "id": "s_xxxx", "period": "2026-08", "cutoffDate": "2026-08-31",
   "direction": "receivable",     // receivable | payable
   "unitIds": ["u_xxxx"], "createdAt": "..." }]

// data/statements.json — 已生成对账函（版本化，永不覆盖）
[{ "id": "st_xxxx", "sessionId": "s_xxxx", "unitId": "u_xxxx",
   "serialNo": "DZH-20260831-0001", "version": 2,   // 同单位同批次重复生成 version+1
   "ourBalanceFen": 1500000,      // 生成时点的己方账面余额快照
   "pdfPath": "...", "xlsxPath": "...", "createdAt": "..." }]

// data/replies.json — 回函记录
[{ "id": "r_xxxx", "statementId": "st_xxxx", "unitId": "u_xxxx",
   "theirBalanceFen": 1450000,    // 对方申报余额
   "theirEntries": [ /* 可选，对方明细，结构同 ledgers */ ],
   "channel": "manual",           // manual=手工录入 excel=导入
   "diffResult": { /* matcher 输出，见 §5.2 */ },
   "status": "confirmed",         // draft=已算差异待确认 confirmed=会计已确认
   "confirmedBy": "", "confirmedAt": "" }]
```

归档目录（只增不删）：
```
data/archive/{unitId}/{period}/v{version}/
  对账函.pdf  对账函.xlsx  回函原件.xlsx  差异报告.json  差异报告.html
data/imports/{importBatch}/原始文件名.xlsx   # 导入原件留档
```

## 4. 关键工程红线（违反即返工）

1. **金额全程用「分」（整数）**。解析入口字符串→分，展示出口分→`1,234.56`，中间禁止任何浮点运算。比对、求和、差异计算全部整数。
2. **字符串→分的解析必须处理**：千分位 `1,234.56`、括号负数 `(1,234.56)`、前导负号、全角数字/全角逗号、不可见字符（`\u00A0`、空格）、文本型数字、`--`/空单元格（视为 0）。
3. **写 JSON 库前先备份**：`BK=data/_backup_时间戳; cp -r data $BK`（mkdir 和 cp 用同一时间戳变量）。每次「导入确认」「批次生成」前自动备份。
4. **归档只增不删**：重复生成走 version+1；程序内不出现任何删除文件操作（本地安全钩子会拦截删除，且归档本就不该删）。
5. **PDF 一律走系统浏览器**（puppeteer-core 探测 Edge/Chrome），代码里不写死 Chromium 下载；探测失败自动降级打印 HTML，不报错崩死。
6. **所有判不准的业务判断标 `MANUAL_REVIEW`** 并在 UI 明示，工具只做建议和标记，最终确认按钮永远在会计手里。
7. 启动端口 3210；启动时 `SetConsoleOutputCP(65001)` 等价处理，日志用 ASCII 标记（`[OK]`/`[!!]`），不用 Unicode 符号。

## 5. 核心模块详设

### 5.1 money.js / daxie.js（纯函数，Phase 0 先行，先写单测）

- `parseToFen(str) -> {fen, ok, err}`：覆盖 §4.2 全部脏格式。
- `fenToStr(fen) -> "1,234.56"`。
- `toDaxie(fen) -> "壹万伍仟元整"`：人民币大写，处理 0、整数（加「整」）、角分、连续零、万/亿进位。**这是独立可测纯函数，单测用例不少于 30 条**（含 0.01、100、1001、10000、10010、100000000、负数提示非法）。

### 5.2 matcher.js — 回函差异勾对算法（本工具技术含量最高的模块）

输入：己方明细 `ourEntries[]`、对方回函（余额 `theirBalanceFen` + 可选明细 `theirEntries[]`）。

执行顺序：

1. **余额快比**：`ourClosingFen`（己方期初+借-贷）vs `theirBalanceFen`。差=0 → 结论「一致」，直接出报告，不进入勾对。
2. **逐笔勾对**（仅当对方提供了明细）：
   - L1 精确匹配：金额（分）相等一对一贪心配对；同金额多笔时取日期最近者。
   - L2 时间性匹配：剩余项按金额相等 + 日期差 ≤ 15 天（窗口可配）配对 → 标 `时间性差异/在途`。
   - L3 组合匹配：己方未匹配项 ≤ 20 笔时，对每个对方未匹配金额跑子集和（己方多笔合并 = 对方一笔，典型场景：汇总付款、合并开票）；对称地反向跑一遍。> 20 笔跳过并在报告标 `MANUAL_REVIEW: 未匹配笔数过多，请人工勾对`。
   - L4 剩余分类：`己方有对方无` / `对方有己方无` / `方向相反疑似`（金额相同但借贷方向对调）/ `疑似重复`（己方同金额同摘要出现 ≥2 次）。
3. **只有余额没有明细的回函**：输出差异金额 = 己方余额 − 对方余额，提示「请向对方索取明细或人工逐笔核对」，标 `MANUAL_REVIEW`。
4. 输出 `diffResult`：`{ status, balanceDiffFen, matched[], timeDiffs[], combos[], ourOnly[], theirOnly[], suspects[], summary }`。
5. **勾对结果一律 draft**，差异报告页由会计逐项确认/驳回后状态才转 `confirmed` 并归档。

### 5.3 智能列识别 columns.js + importer.js

**表头行探测**：扫描前 10 行，找到包含 ≥ 2 个别名字典命中列的首行作为表头（真实导出文件前 1-3 行常是公司名/报表标题/导出日期）。

**别名字典**（执行时实现为可扩充的 JSON）：

| 标准列 | 常见别名 |
|---|---|
| 单位名称 | 往来单位 / 客户 / 供应商 / 对方单位 / 单位 / 客商 / 辅助核算 |
| 日期 | 业务日期 / 凭证日期 / 记账日期 / 单据日期 |
| 摘要 | 摘要说明 / 备注 / 内容 / 用途 |
| 借方金额 | 借方 / 借方发生额 / 应收金额 / 收入 / 增加 |
| 贷方金额 | 贷方 / 贷方发生额 / 应付金额 / 回款 / 减少 |
| 金额+方向 | 金额 / 发生额（配方向列：借/贷） |
| 余额 | 期末余额 / 结余 / 当前余额（配方向列） |
| 科目 | 会计科目 / 科目名称 |
| 凭证号 | 凭证编号 / 单号 / 凭证字 |

**映射确认 UI**：自动识别结果以表格预览（前 20 行），每列顶部下拉框可手动改映射；确认后把「原表头→标准列」映射按文件签名（表头行 join）记忆，下次同格式文件免映射。

**必须吞下的脏数据清单**（每条都要造样本进 `samples/` 并进测试）：

1. 表头上方 1-3 行标题/公司名/导出日期；合并单元格标题
2. .xls 老格式（2003 格式）；.csv GBK/GB18030 编码；带 BOM / 不带 BOM
3. 千分位金额、括号负数、红字负数（颜色读不到就依赖括号/负号，报告里注明）
4. 借贷双列、金额+方向单列、正负混合单列，三种结构都要能解
5. 日期全格式：Excel 序列数、`2026/8/31`、`2026-08-31`、`2026年8月31日`、`20260831`
6. 末尾「合计/总计」行、中间按月「小计」行 → 识别剔除（首列文本匹配）
7. 全空行、尾部空行、某列整体为空
8. 单位名称含首尾空格、全角括号/半角括号差异 → trim + 全角转半角后匹配档案；匹配不到 → 导入向导里提供「新建档案 / 绑定已有单位」
9. 一个文件多 sheet（按科目分 sheet / 按月分 sheet）→ sheet 选择器，支持多选合并导入
10. 科目余额表（每单位一行余额）与明细账（逐笔）两种都要支持：余额表只够生成对账函，明细账才能做回函勾对，导入时明示该单位「仅有余额，无法逐笔核对」
11. 同一单位多科目（应收账款 + 预收账款）→ 默认按单位合并对账，UI 提供按科目拆分的开关
12. 单元格内不可见字符 `\u00A0`、换行符

**导入流程**（三步向导）：选文件 → 列映射+前 20 行预览+剔除行标注 → 确认入库（自动备份 → 解析 → 写 ledgers.json → 原件留档 `data/imports/`）。

### 5.4 对账函模板（templates/）

预置两套模板，HTML + `{{placeholder}}`，样式按 A4 打印设计（`@page` 规则、页边距 2.5cm）。

**应收对账函字段**：编号、我方公司名/地址/电话、致对方公司抬头、对账截止日期、「截至 YYYY 年 MM 月 DD 日，贵公司欠我方款项余额为 ¥X（大写：X）」、本期借/贷发生额合计、明细附页（逐笔：日期/摘要/借方/贷方/余额）、回函联（「信息证明无误 □ / 信息不符及说明 □：____」、对方签章处、骑缝章提示）、我方公章处、经办人、日期。
**应付对账函**：措辞改为「我方欠贵公司款项余额」。

**模板配置页可改**：公司名/地址/电话/落款、logo 上传（存 `data/assets/`，HTML 以 file:// 引用）、对账口径（余额对账 / 余额+明细附页）、编号规则（默认 `DZH-{yyyymmdd}-{4位序号}`）。

**既是客户又是供应商的单位**：应收应付余额**分别列示**于同一张函（合规上不得擅自抵销），并在函尾标 `MANUAL_REVIEW: 该单位同时存在应收/应付余额，是否净额结算请人工确认`。

### 5.5 批量生成与导出 statement.js / exporter.js

- 选截止日 → 列出该时点有余额的单位（区分有明细/仅余额）→ 勾选 → 一键生成。
- 每单位：算余额快照 → 渲染 HTML → 同时产出 Excel（ExcelJS，含打印区域设置）和 PDF（puppeteer-core 打印 HTML）→ 写入 statements.json（version+1）→ 落归档目录。
- 批量结果页：逐单位状态（成功/失败原因），全部完成后 zip 打包下载。
- 50 家单位、每家 200 行明细的规模下，全程 < 60 秒为达标。

### 5.6 归档与历史 archive.js

- 按「单位 → 期间 → 版本」树形查询；详情页展示：对账函 PDF/Excel 下载、回函记录、差异报告、确认人/时间。
- 归档数据只增不删；提供「数据备份」按钮（整包 zip data/）和「从备份恢复」（恢复前再备份当前）。

## 6. API 设计（routes.js，全部返回 `{ok, data, err}`）

```
GET  /api/health
CRUD /api/units
POST /api/import/preview      # 上传文件 → 表头探测 + 列映射建议 + 前20行
POST /api/import/commit       # 确认映射 → 解析入库（自动备份）
GET/PUT /api/company          # 我方公司信息/模板配置
POST /api/templates/preview   # 模板 + 样例数据 → HTML 预览
GET  /api/ledger/balance?unitId=&cutoff=
POST /api/statements/generate # {sessionId 或临时参数: cutoff, direction, unitIds[]}
GET  /api/statements/:id/file?fmt=pdf|xlsx
GET  /api/statements/batchZip?sessionId=
POST /api/replies             # 回函录入（手工余额 or 文件导入）
POST /api/diff/run            # {replyId} → diffResult（draft）
POST /api/diff/confirm        # 会计确认 → confirmed + 归档
GET  /api/archive/tree        # 单位→期间→版本
GET  /api/archive/:stmtId/detail
POST /api/backup  POST /api/restore
```

## 7. 前端页面（单页 Tab）

1. **首页**：对账批次列表 + 「新建对账」入口 + 最近动态
2. **单位档案**：增删改查、别名、往来类型、历史对账次数
3. **数据导入**：三步向导（选文件 → 映射预览 → 入库结果）
4. **模板设置**：公司信息、logo、应收/应付模板实时预览
5. **批量生成**：选截止日 → 单位勾选（显示各家余额）→ 生成 → 状态列表 → zip 下载
6. **回函核对**：选对账函 → 录回函（手工金额 / 导入明细）→ 差异报告（分类着色：时间性差异黄色、己方有对方无红色、组合匹配蓝色）→ 逐项确认 → 归档
7. **历史归档**：树形浏览 + 详情 + 下载
8. **设置**：编号规则、匹配日期窗口、备份/恢复

前端约束：`fetch` 统一走 `api()` 辅助函数（**body 必须 `JSON.stringify`**）；Tab 用 `showTab('xxx')` 切换；所有金额展示走 `fenToStr`；弹窗确认用原生 confirm。

## 8. 分期实施与验收

| Phase | 内容 | 验收标准 |
|---|---|---|
| P0 | 脚手架、money.js、daxie.js、store.js | 30+ 条纯函数单测全过；金额脏格式解析用例全过 |
| P1 | 单位档案 + 智能列识别 + 导入三步向导 | `samples/` 下 12 类脏数据样本全部正确解析入库；表头识别准确率 100%（对样本集） |
| P2 | 模板配置 + 批量生成 + Excel/PDF 导出 | 10 家虚拟单位一键生成；PDF 中文无乱码、大写金额正确；zip 下载完整；重复生成版本递增不覆盖 |
| P3 | 回函录入 + matcher 勾对 + 差异报告 | 算法测试集（一致/未达账项/汇总付款/方向记反/疑似重复/仅余额）全过；draft→confirmed 流程闭环 |
| P4 | 历史归档 + 备份恢复 | 归档树正确；备份→改数据→恢复后数据一致 |
| P5 | 全量测试 + README | §9 六层测试全绿；README 给会计看得懂 |

## 9. 测试方案（六层，脚本放 `tools/rdtest/`，统一 PASS/FAIL+预期/实际对照输出，末尾汇总）

1. **主场景端到端**：清空 data → 建 3 家虚拟单位（甲：完全一致；乙：有 2 笔未达账项；丙：5 笔己方明细对应 1 笔汇总回款）→ 导入 → 生成对账函 → 录回函 → 勾对 → 核对预期差异表 → 确认归档
2. **规则内核单测**：直接 require money/daxie/matcher/columns，构造独立数据集，不碰存储层
3. **边界/脏数据**：负数、0、null、非法日期、不存在 unitId、5 万行明细、NaN 字符串、空文件、非 Excel 文件改后缀
4. **导入/导出**：12 类样本全过一遍；所有导出接口 GET 一遍验证非空非错
5. **运维操作**：备份/恢复、重复导入幂等（同文件导两次不重复入库，按 unitId+date+金额+摘要 去重）、版本递增
6. **前端渲染（jsdom）**：`new JSDOM(html,{url:服务根,runScripts:'dangerously'})`，注入 fetch/confirm/alert 兜底，逐 Tab 切换，捕获 jsdomError/window.error，检查页面文本无 `undefined`/`NaN`/`null`

## 10. 风险与应对

| 风险 | 应对 |
|---|---|
| 系统无 Edge/Chrome 导致 PDF 失败 | 降级打印 HTML，UI 明示「浏览器打开后 Ctrl+P 另存 PDF」 |
| SheetJS 读某些加密/损坏 xls 报错 | 导入预览层 try/catch，明确报错文案，不崩服务 |
| 明细量大致组合匹配慢 | L3 子集和限 20 笔上限，超出转 MANUAL_REVIEW |
| 会计误操作重复生成 | 版本化只增不删，旧版本永远可查 |
| 红字负数（仅颜色标记）解析成正数 | 报告注明该限制；向导预览页高亮提示人工核对 |

## 11. 明确不做（Out of Scope，执行者不要扩展）

- 邮件/SMTP 群发、电子签章、银行流水核对、与财务软件 API 直连
- 多公司/多账套、多用户/权限
- 任何记账、调账、凭证生成功能
- OCR 识别对方扫描回函（二期再议）
