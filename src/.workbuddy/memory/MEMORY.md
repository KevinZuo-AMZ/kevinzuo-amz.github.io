# 项目长期记忆（data_host_repo / 看板同步）

## 看板同步运行约定（每日 15:00 automation-1787903498999）

### refresh_dashboard.py 必须用 AMZ_SOURCE_DIR
- 脚本默认从 `源文件2.0\产品表现.xlsx` 取数。文件实际在 `源文件2.0\每日更新\`。
- 不设 `AMZ_SOURCE_DIR` 时脚本**静默回退、不刷新**（打印 source_data_refreshed:False，保留旧 amz-data.json）。
- 正确调用：`AMZ_SOURCE_DIR="D:/00-运营/000-工作台自动化/源文件2.0/每日更新" python refresh_dashboard.py`
- 成功标志：source_data_refreshed:True，matched_records 应为 8010/total 8010（随产品数变化）。

### 领星下载脚本运行环境
- `lingxing_auto.js` 需 **Node ≥ 20**（Playwright 要求）。本机用 Node 22.22.2。
- 本机 `NODE_OPTIONS=--use-system-ca` 会让 Node 18 启动失败；运行前须 `NODE_OPTIONS=` 清空。
- GUI 模式（不加 --headless），自动跳过登录页（持久化 Edge profile `.lingxing_auto_edge_profile`）。
- 结尾 `✓ PASS / ✗ FAIL` + 文件 mtime 为成功判定依据。

### 推送
- `push_data.py` 读同目录 `push_config.json`（token 勿外泄/勿提交）。
- 公开仓 kevinzuo-amz.github.io / 私有仓 amz-private-data，GitHub Pages 自动重建。
