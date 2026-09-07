# 领星 OpenAPI 看板数据接口

## 目标

用领星官方 OpenAPI 直接生成看板需要的本地数据，逐步替代 Playwright 登录后下载 Excel 的流程。同步只写当前仓库，不上传远端；是否执行 GitHub 推送仍由 `src/push_data.py` 单独控制。

数据链路：

```text
看板“领星 API 接入”模块
  -> src/lingxing_bridge.py（仅监听本机回环地址）
  -> src/sync_lingxing_api.py（字段映射、校验、原子写入）
  -> src/lingxing_api.py（鉴权、签名、重试、分页）
  -> 领星官方 OpenAPI
  -> amz-data.json + cloud-status.json
  -> 看板读取本机数据；明确发布后再同步到 GitHub Pages
```

## 官方前置条件

1. 使用领星 ERP 超级管理员账号，在“设置 -> 业务配置 -> 全局 -> 开放接口”取得 AppID 和 AppSecret。
2. 把执行同步脚本的设备公网 IP 加入领星开放接口白名单。领星要求填写实际公网 IP，不是域名。
3. 业务接口域名固定为 `https://openapi.lingxing.com`。

官方说明：[领星 API 接入指南](https://apidoc.lingxing.com/#/docs/Guidance/newInstructions)、[获取 access-token](https://apidoc.lingxing.com/#/docs/Authorization/GetToken)。

## 本机配置

建议创建项目内虚拟环境：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-lingxing.txt
```

Windows 使用：

```powershell
py -m venv .venv
.venv\Scripts\pip.exe install -r requirements-lingxing.txt
```

在仓库根目录创建本机 `.env`，字段参考 `.env.example`：

```dotenv
LINGXING_APP_ID=
LINGXING_APP_SECRET=
LINGXING_SIDS=
LINGXING_LOOKBACK_DAYS=90
LINGXING_CURRENCY_CODE=USD
```

`.env` 已被 Git 忽略。不要把 AppSecret、access_token 或 refresh_token 写入源码、普通 Markdown、任务记录或 Git 配置。

## 执行

先进行只读验证，不改看板文件：

```bash
.venv/bin/python src/sync_lingxing_api.py --dry-run
```

确认结果后刷新本地看板数据与发布文件：

```bash
.venv/bin/python src/sync_lingxing_api.py
```

常用参数：

```text
--days 30                  回看 30 天，最大 92 天
--start-date 2026-08-01    指定开始日期
--end-date 2026-08-21      指定结束日期
--sids 101,102             限定店铺
--datasets performance     只刷新产品表现、广告和利润
--datasets stock           只刷新库存与补货
--include-today            纳入当天尚未完整的数据
--no-build                 不重新生成发布 HTML
```

默认同步到昨天，避免当天数据尚未结算就进入经营判断。同步成功后，`cloud-status.json.uploadedAt` 会更新为本次 API 同步时间，看板顶部“云端数据同步”模块据此展示更新时间。

## 看板内接入

GitHub Pages 是公开静态页面，不能安全保存 AppID 或 AppSecret。因此看板只连接当前设备上的回环连接器，真实凭证始终由本机 Python 进程从 `.env` 读取，不会返回给浏览器。

先在项目根目录启动连接器：

```bash
.venv/bin/python src/lingxing_bridge.py
```

连接器启动后会显示本机地址和一次性的配对码。在看板“数据同步”页面中：

1. 保持默认连接器地址 `http://127.0.0.1:8765`，填入本次启动显示的配对码。
2. 点击“测试连接”，确认凭证、IP 白名单和本地依赖均可用。
3. 选择日期范围、产品表现或库存数据集，再点击“同步领星数据”。
4. “同步后载入看板”默认开启；“同步后发布到 GitHub”默认关闭，开启后每次仍需再次确认。

连接器接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/status` | 检查连接器、凭证配置和同步状态 |
| `POST /api/test` | 只读验证鉴权并读取授权店铺，不改写看板数据 |
| `POST /api/sync` | 按白名单参数同步数据，可显式选择是否发布 |
| `GET /api/data` | 读取当前设备上的 `amz-data.json` 和同步时间 |

公开 HTTPS 页面访问本机 HTTP 回环地址会受浏览器本地网络安全策略控制。连接器已处理 CORS、Private Network Access 预检和来源白名单；Chrome/Edge 可能要求本地网络访问授权。Safari 可能把 HTTPS 到 HTTP 回环请求视为混合内容并拒绝，当前建议使用 Chrome 或 Edge。参考：[Chrome Private Network Access](https://developer.chrome.com/blog/private-network-access-update)、[MDN Local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)。

## 数据覆盖

| 看板分区 | 官方接口 | 当前处理 |
| --- | --- | --- |
| `perf.detail` | `POST /bd/productPerformance/openApi/asinList` | 按天拉取并全量重建所选日期范围 |
| `ad.detail` | 同上 | 从产品表现的广告聚合字段派生 |
| `profit.detail` | 同上 | 从销售额、销量、订单毛利润派生 |
| `stock` | 补货列表 + FBA 库存 v2 | 合并补货、日均销量、在途、调仓和库龄 |
| ASIN 名称、父体、SKU | `POST /erp/sc/data/mws/listing` | 作为字段映射索引 |
| 店铺 sid | `GET /erp/sc/data/seller/lists` | 默认选择所有状态正常店铺 |
| `promo` | 客户端已封装商品折扣接口 | 暂不自动覆盖，保留历史价格基线和人工排期 |
| `mine`、`tasks`、`track` | 本地运营数据 | 始终保留，不由 API 覆盖 |

产品表现接口返回的是请求日期范围汇总值，所以同步脚本按天请求，才能保持看板现有的 `date + ASIN` 明细契约。官方接口未提供独立“广告销量”字段，当前 `adUnits` 暂以广告订单量代替；广告订单、花费、销售额、曝光和点击均使用官方原字段。

## 安全与失败策略

- AppID/AppSecret 只从环境变量或本机 `.env` 读取。
- access_token 只保存在当前 Python 进程内，不落盘。
- 公开看板不提供凭证输入框，也不会取得或保存 AppID、AppSecret、access_token。
- 配对码只保存在当前标签页的 `sessionStorage`，关闭标签页后失效，不写入 `localStorage`、项目文件或 Git。
- 连接器只监听回环地址，并校验 Host、Origin、配对码、请求体大小、参数范围和并发同步状态。
- 同步与发布使用固定参数列表调用项目脚本，不拼接 shell 命令。
- 签名按官方规则生成：参数 ASCII 排序、MD5 大写、AES/ECB/PKCS5Padding、Base64，并由 URL 编码器处理。
- 遇到 token 过期、签名过期、限流、HTTP 429 或 5xx 时有限次数重试。
- 核心数据为空时默认拒绝覆盖；确有意图时才使用 `--allow-empty`。
- JSON 先写同目录临时文件、完成校验后原子替换，降低中途失败损坏数据的风险。
- API 同步本身不执行 `git push`；发布仍需显式运行 `src/push_data.py`。

## 后续发布流程

API 验证通过后，原流程可简化为：

```text
1. 运行 src/sync_lingxing_api.py
2. 检查看板与 cloud-status.json
3. 运行 src/push_data.py
4. 刷新 https://kevinzuo-amz.github.io/
```

在获得真实接口响应并完成一次人工对账前，保留 `src/lingxing_auto.js` 和 Excel 刷新流程作为回退路径。
