# -*- coding: utf-8 -*-
"""
刷新看板数据并生成当前仓库的 GitHub Pages 发布文件（不部署）。
由「工作台-上传云端」自动化每日调用。

流程：
1. 从本地源文件2.0 读取最新 产品表现.xlsx（云端为权威源，先由自动化取回）
2. 按 date|ASIN 把利润差异新字段（毛利/退款/流量/广告）刷新进 amz-data.json 的 perf.detail
   - 仅覆盖 xlsx 命中的记录，未命中（超出90天窗口）的原值保留，绝不整体清零
   - 其它分区（stock/ad/profit/searchTerms/promo/track 等）原样保留
3. 把 live-dashboard.html 生成到仓库根目录的 dashboard.html / index.html
4. 仅在源 Excel 存在并完成刷新时更新 cloud-status.json.uploadedAt
5. 更新 version.json 并打印 SUCCESS 摘要

用法：python3 src/refresh_dashboard.py
"""
import json, os, datetime

BASE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(BASE)
SRC_DIR = os.environ.get("AMZ_SOURCE_DIR", r"D:/00-运营/000-工作台自动化/源文件2.0")
SRC_XLSX = os.path.join(SRC_DIR, "产品表现.xlsx")
AMZ_JSON = os.path.join(REPO_ROOT, "amz-data.json")
CLOUD_JSON = os.path.join(REPO_ROOT, "cloud-status.json")
LIVE = os.path.join(BASE, "live-dashboard.html")
DIST_HTML = os.path.join(REPO_ROOT, "index.html")

# cloud-status.json 里展示的关键源文件清单（利润报表已按用户要求停用，不再导出）
SRC_FILES = ["002-价格与促销-2.0.xlsx", "产品表现.xlsx", "我的ASIN.xlsx", "补货建议.xlsx"]

NEW_FIELDS = ["gross", "refund", "impr", "clicks", "natClicks",
              "adSpend", "adSales", "adUnits", "adOrders", "cpc"]

# cols 精选白名单：只装看板「运营结论中心」实际消费的列（结论中心取数）。
# 仅在该 ASIN 最新一天记录携带（慢变指标无需逐日重复）；历史记录 cols 为空。
# 值做归一化：百分比字符串→数字（17.83%→17.83）、排名"类目：1234"→1234，
# 使 JSON 从 33MB → ~2MB，能存进浏览器 localStorage（配额 ~5-10MB）。
COLS_WHITELIST = [
    # 产品健康 / 结论中心消费
    "评分", "评论数", "Buybox赢得率", "大类排名", "小类排名",
    # 盈利
    "订单毛利率", "结算毛利率", "ROI", "退款率", "促销折扣",
    # 广告
    "ACOS", "ACoAS", "ROAS", "TACOS", "CPO", "SP广告费", "SB广告费", "SBV广告费", "SD广告费",
    "SP广告销售额", "SB广告销售额", "SBV广告销售额", "SD广告销售额",
    # 库存
    "FBA可售天数预估", "断货时间", "月库销比",
    # 销售
    "净销售额", "销量环比", "销售额环比", "订单量环比", "销售均价",
]

def norm_col_val(v):
    """把 xlsx 原始值归一化为紧凑存储：
    1) 百分比字符串 '17.83%' → 17.83（数字）
    2) 排名 'Health & Household：13977' → 13977（提取末段数字）
    3) 纯数字/空值原样（空值丢弃）
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    if s == "":
        return None
    if s.endswith("%"):
        try:
            return round(float(s[:-1].replace(",", "")), 4)
        except Exception:
            return s
    # 排名文本（如 'Health & Household：13977' / 'Disposable Spoons：23'）→ 提取末段数字。
    # 特征：含冒号（半角/全角）且末尾是数字。
    if (":" in s or "：" in s) and s[-1:].isdigit():
        import re
        nums = re.findall(r"\d+(?:\.\d+)?", s)
        if nums:
            return float(nums[-1])
    return s

def parse_date(v):
    if v is None:
        return ""
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, datetime.date):
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    # 尝试常见格式
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.datetime.strptime(s[:len(fmt) + 2], fmt).strftime("%Y-%m-%d")
        except Exception:
            pass
    # 形如 20260817 或 2026-08-17
    digits = "".join(ch for ch in s if ch.isdigit())
    if len(digits) >= 8:
        try:
            return datetime.datetime.strptime(digits[:8], "%Y%m%d").strftime("%Y-%m-%d")
        except Exception:
            pass
    return s

def to_num(v):
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").replace("¥", "").replace("%", "")
    if s in ("", "-", "—", "N/A", "nan"):
        return 0.0
    try:
        return float(s)
    except Exception:
        return 0.0

LOADER_REMOTE_DEFAULT = "https://raw.githubusercontent.com/KevinZuo-AMZ/kevinzuo-amz.github.io/main"

def build_loader(full_html, ver):
    """把完整看板 HTML 包成「自更新加载器」index.html（v2 秒开版）：
    - 先拉几十字节的 version.json（5 秒超时）：版本一致或拉不到 → 立即渲染内嵌完整看板（不下载 7MB）；
    - 版本有更新 → 下载 dashboard.html（30 秒超时）渲染最新版；失败 → 内嵌兜底；
    - 网络不通：4~5 秒内必定打开内嵌版；失败状态记入 localStorage，10 分钟内不再试远程（后续打开秒进）；
    - document.write 失败（极端环境）→ location 跳转同源 ./dashboard.html（随 dist 一起部署的完整版）。
    完整看板嵌在 <template> 内不会执行，序列化后 document.write 才会执行，安全。
    （已确认看板 HTML 内无 </template> 字样，嵌套安全。）
    """
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AMZ Manager-ZK</title>
<style>
html,body{margin:0;height:100%;background:#0b1220;color:#e8edf5;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
#ld{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
#ld .spin{width:42px;height:42px;border:3px solid rgba(255,255,255,.15);border-top-color:#4da3ff;border-radius:50%;animation:ldsp 1s linear infinite}
@keyframes ldsp{to{transform:rotate(360deg)}}
#ldt{font-size:14px;opacity:.85}
</style>
</head>
<body>
<div id="ld"><div class="spin"></div><div id="ldt">正在打开看板…</div></div>
<template id="dashfb">__FULL__</template>
<script>
(function(){
  var KEY='wb_amz_zk_dataBaseUrl';
  var FKEY='wb_amz_zk_ldrFailAt';
  var DEFAULT='__REMOTE__';
  var EMB_VER='__VER__';
  var ldt=document.getElementById('ldt');
  function stat(s){ try{ if(ldt) ldt.textContent=s; }catch(e){} }
  function render(html){
    try{ document.open(); document.write(html); document.close(); }
    catch(e){ try{ location.replace('./dashboard.html'); }catch(e2){} }
  }
  function embedded(){
    var t=document.getElementById('dashfb');
    render(t?t.innerHTML:'<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;color:#e8edf5;background:#0b1220">加载失败，请刷新重试');
  }
  function fetchT(url,ms){
    return new Promise(function(resolve,reject){
      var ctl=('AbortController' in window)?new AbortController():null;
      var to=setTimeout(function(){ if(ctl) ctl.abort(); reject(new Error('超时')); },ms);
      fetch(url, ctl?{signal:ctl.signal,cache:'no-store'}:{cache:'no-store'}).then(function(r){
        clearTimeout(to);
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.text();
      }).then(resolve).catch(reject);
    });
  }
  // localStorage 与看板 load()/save() 协议一致（JSON 编码），裸字符串也能读（兼容旧值）
  function lsGet(k){ try{ var v=localStorage.getItem(k); if(v==null) return null; try{ return JSON.parse(v); }catch(e){ return v; } }catch(e){ return null; } }
  function lsSet(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){ try{ localStorage.setItem(k,String(v)); }catch(e2){} } }
  var raw=null;
  try{ raw=lsGet(KEY); }catch(e){}
  var base=((raw==null?'':String(raw)).trim());
  // 不写 localStorage：看板 dataUrl() 会把「JSON 格式的默认地址」视为污染态删除，
  // 加载器写回会造成写/删震荡；且 base 有 DEFAULT 兜底，零配置不受影响。
  if(!base) base=DEFAULT;
  var root=base.replace(/\\/+$/,'');

  // 近 10 分钟内远程检测失败过 → 直接秒开内嵌版，不再干等
  var failAt=0;
  try{ failAt=parseInt(localStorage.getItem(FKEY)||'0',10)||0; }catch(e){}
  if(Date.now()-failAt<600000){ stat('正在打开看板…'); embedded(); return; }

  stat('正在检查更新…');
  fetchT(root+'/version.json?t='+Date.now(),5000).then(function(txt){
    var v='';
    try{ v=(JSON.parse(txt)||{}).v||''; }catch(e){}
    if(!v || v===EMB_VER){
      try{ localStorage.removeItem(FKEY); }catch(e){}
      stat('正在打开看板…'); embedded();
    }else{
      stat('发现新版本，正在下载（约7MB，请稍候）…');
      fetchT(root+'/dashboard.html?t='+Date.now(),30000).then(function(html){
        try{ localStorage.removeItem(FKEY); }catch(e){}
        if(html && html.length>500000 && html.indexOf('id="panel-sync"')>-1){ render(html); }
        else{ embedded(); }
      }).catch(function(){
        try{ localStorage.setItem(FKEY,String(Date.now())); }catch(e){}
        stat('网络较慢，正在用内置版本打开…'); setTimeout(embedded,300);
      });
    }
  }).catch(function(){
    try{ localStorage.setItem(FKEY,String(Date.now())); }catch(e){}
    stat('网络不通，正在用内置版本打开…'); setTimeout(embedded,300);
  });
})();
</script>
</body>
</html>
""".replace("__FULL__", full_html).replace("__REMOTE__", LOADER_REMOTE_DEFAULT).replace("__VER__", ver)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_release(source_refreshed=False, matched=0, total=0):
    """生成 GitHub Pages 发布文件；纯界面构建不改写源数据上传时间。"""
    if not os.path.exists(LIVE):
        print("FAIL: 找不到 %s" % LIVE)
        return 1
    if not os.path.exists(AMZ_JSON):
        print("FAIL: 找不到 %s" % AMZ_JSON)
        return 1

    built_at = utc_now()
    uploaded_at = ""
    if os.path.exists(CLOUD_JSON):
        try:
            with open(CLOUD_JSON, "r", encoding="utf-8") as f:
                cloud_status = json.load(f)
        except Exception:
            cloud_status = {}
    else:
        cloud_status = {}

    if source_refreshed:
        uploaded_at = built_at
        files_info = []
        for name in SRC_FILES:
            fp = os.path.join(SRC_DIR, name)
            if os.path.exists(fp):
                st = os.stat(fp)
                mtime = datetime.datetime.fromtimestamp(
                    st.st_mtime, tz=datetime.timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
                files_info.append({"name": name, "size": st.st_size, "mtime": mtime})
        cloud_status.update({
            "uploadedAt": uploaded_at,
            "refreshedAt": uploaded_at,
            "sourceDir": SRC_DIR,
            "count": len(files_info),
            "files": files_info,
        })
        with open(CLOUD_JSON, "w", encoding="utf-8") as f:
            json.dump(cloud_status, f, ensure_ascii=False, indent=2)
    else:
        uploaded_at = cloud_status.get("uploadedAt", "")

    with open(LIVE, "r", encoding="utf-8") as f:
        live_html = f.read()
    import hashlib
    ver = datetime.datetime.now().strftime("%Y%m%d.%H%M") + "-" + hashlib.md5(
        live_html.encode("utf-8")
    ).hexdigest()[:8]
    with open(os.path.join(REPO_ROOT, "dashboard.html"), "w", encoding="utf-8", newline="") as f:
        f.write(live_html)
    with open(DIST_HTML, "w", encoding="utf-8", newline="") as f:
        f.write(build_loader(live_html, ver))
    with open(os.path.join(REPO_ROOT, "version.json"), "w", encoding="utf-8", newline="") as f:
        json.dump({"v": ver, "t": built_at}, f, ensure_ascii=False)

    print("SUCCESS")
    print("source_data_refreshed:%s" % source_refreshed)
    if source_refreshed:
        print("matched_records:%d / total:%d" % (matched, total))
    print("uploadedAt:%s" % (uploaded_at or "preserved-empty"))
    print("release_root:%s" % REPO_ROOT)
    print("version:%s" % ver)
    return 0


def main():
    if not os.path.exists(SRC_XLSX):
        print("INFO: 找不到源文件 %s" % SRC_XLSX)
        print("INFO: 保留现有 amz-data.json 与 cloud-status.json，仅重新生成看板发布文件。")
        return build_release(source_refreshed=False)
    if not os.path.exists(AMZ_JSON):
        print("FAIL: 找不到 %s" % AMZ_JSON)
        return 1

    # 读 xlsx
    import openpyxl
    wb = openpyxl.load_workbook(SRC_XLSX, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = list(rows[0])
    idx = {str(h).strip(): i for i, h in enumerate(header) if h is not None}

    def col(*names):
        for n in names:
            if n in idx:
                return idx[n]
        return -1

    c_date = col("日期")
    c_pasin = col("父ASIN")
    c_asin = col("ASIN")
    c_name = col("品名")
    c_gross = col("订单毛利润", "毛利润")
    c_refund = col("退款金额")
    c_impr = col("展示", "曝光")
    c_clicks = col("点击")
    c_natc = col("自然点击量")
    c_adspend = col("广告花费")
    c_adsales = col("广告销售额")
    c_adunits = col("广告销量")
    c_adorders = col("广告订单量")
    c_cpc = col("CPC")
    c_sales = col("销售额")
    c_orders = col("订单量")
    c_units = col("销量")
    c_sess = col("Sessions-Total", "Sessions")
    c_natord = col("自然订单量")

    # 精选列：用原始表头（中文）做 key，只装白名单内的核心列。
    # 与顶层已有字段（date/asin/pasin/name/sales/orders/units/sessions/naturalOrders + NEW_FIELDS）重复的键跳过，
    # 避免 cols 里存两份相同数据，进一步控体积。
    # 体积策略：cols 只在该 ASIN 最新一天的记录上携带（评分/Buybox/排名等慢变指标无需逐日重复），
    # 历史记录 cols 为空对象——使 amz-data.json 从 33MB → ~2MB，能存进浏览器 localStorage（配额 ~5-10MB）。
    whitelist = set(COLS_WHITELIST)
    dup_keys = {"日期", "ASIN", "父ASIN", "品名", "销售额", "订单量", "销量", "Sessions-Total",
                "自然订单量", "订单毛利润", "退款金额", "展示", "点击", "自然点击量",
                "广告花费", "广告销售额", "广告销量", "广告订单量", "CPC"}
    # 先扫描：每个 ASIN 的最新日期（决定哪些记录携带 cols）
    last_date = {}
    for r in rows[1:]:
        asin = str(r[c_asin]).strip().upper() if c_asin >= 0 and r[c_asin] is not None else ""
        if not asin or asin == "-":
            continue
        d = parse_date(r[c_date])
        if d and (asin not in last_date or d > last_date[asin]):
            last_date[asin] = d
    xmap = {}
    for r in rows[1:]:
        asin = str(r[c_asin]).strip().upper() if c_asin >= 0 and r[c_asin] is not None else ""
        if not asin or asin == "-":
            continue  # 汇总/小计行跳过
        d = parse_date(r[c_date])
        key = d + "|" + asin
        if key not in xmap:
            cols = {}
            if last_date.get(asin) == d:
                for h, i in idx.items():
                    if h in whitelist and h not in dup_keys and i < len(r):
                        nv = norm_col_val(r[i]) if i < len(r) else None
                        if nv is not None and nv != "":
                            cols[h] = nv
            xmap[key] = {"pasin": str(r[c_pasin]).strip().upper() if c_pasin >= 0 and r[c_pasin] is not None else "",
                         "name": str(r[c_name]).strip() if c_name >= 0 and r[c_name] is not None else "",
                         "sales": 0.0, "orders": 0, "units": 0, "sessions": 0, "naturalOrders": 0,
                         "gross": 0.0, "refund": 0.0, "impr": 0.0, "clicks": 0.0,
                         "natClicks": 0.0, "adSpend": 0.0, "adSales": 0.0,
                         "adUnits": 0.0, "adOrders": 0.0, "cpc": 0.0,
                         "cols": cols}
        rec = xmap[key]
        rec["sales"] += to_num(r[c_sales])
        rec["orders"] += to_num(r[c_orders])
        rec["units"] += to_num(r[c_units])
        rec["sessions"] += to_num(r[c_sess])
        rec["naturalOrders"] += to_num(r[c_natord])
        rec["gross"] += to_num(r[c_gross])
        rec["refund"] += to_num(r[c_refund])
        rec["impr"] += to_num(r[c_impr])
        rec["clicks"] += to_num(r[c_clicks])
        rec["natClicks"] += to_num(r[c_natc])
        rec["adSpend"] += to_num(r[c_adspend])
        rec["adSales"] += to_num(r[c_adsales])
        rec["adUnits"] += to_num(r[c_adunits])
        rec["adOrders"] += to_num(r[c_adorders])
        rec["cpc"] += to_num(r[c_cpc])

    # 读 amz-data.json
    with open(AMZ_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)
    perf = data.setdefault("perf", {})
    # perf.detail 用 xlsx 全量重建（权威源）：保证最新日期（含 08-17/08-18）进看板，
    # 不再「只更新旧记录」，否则窗口滚动后最新数据会丢。
    new_detail = []
    for key in sorted(xmap.keys()):
        x = xmap[key]
        d, asin = key.split("|", 1)
        rec = {
            "date": d,
            "pasin": x.get("pasin", ""),
            "asin": asin,
            "name": x.get("name", ""),
            "sales": x.get("sales", 0.0),
            "orders": x.get("orders", 0),
            "units": x.get("units", 0),
            "sessions": x.get("sessions", 0),
            "naturalOrders": x.get("naturalOrders", 0),
            "gross": x.get("gross", 0.0),
            "refund": x.get("refund", 0.0),
            "impr": x.get("impr", 0.0),
            "clicks": x.get("clicks", 0.0),
            "natClicks": x.get("natClicks", 0.0),
            "adSpend": x.get("adSpend", 0.0),
            "adSales": x.get("adSales", 0.0),
            "adUnits": x.get("adUnits", 0.0),
            "adOrders": x.get("adOrders", 0.0),
            "cpc": x.get("cpc", 0.0),
            "cols": x.get("cols", {}),
        }
        new_detail.append(rec)
    # 保留 perf 元数据（target 等），替换 detail
    old_meta = {k: v for k, v in perf.items() if k != "detail"}
    perf.clear()
    perf.update(old_meta)
    perf["detail"] = new_detail
    matched = len(new_detail)

    with open(AMZ_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    return build_release(source_refreshed=True, matched=matched, total=len(new_detail))

if __name__ == "__main__":
    raise SystemExit(main())
