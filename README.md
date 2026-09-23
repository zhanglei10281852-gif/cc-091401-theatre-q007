# 剧院无障碍服务

为观众安排无障碍席位、陪同票、手语翻译与现场辅助设备，覆盖申请受理、按场次锁资源、
现场履约闭环到演出后脱敏复盘的全过程。

## 运行

需要 Node.js 22 或更高版本。运行 `npm ci` 后使用 `npm start` 启动服务，默认监听 8000 端口；
`npm test` 执行本地测试。也可以使用 `docker compose up --build` 启动容器。

- `DATA_FILE`：状态持久化文件，默认 `.runtime/state.json`（首次启动自动播种样例数据）
- `NOTIFY_INTERVAL_MS`：到期通知扫描间隔，默认 15000ms

## 角色与隐私

请求头 `X-Role` 标识调用角色（缺省为客服）：

| 角色 | 可见范围 |
| --- | --- |
| `box_office` 客服 | 服务安排与需求类别；健康自由文本不可见，姓名/联系方式脱敏 |
| `front_of_house` 现场协调 | 全部履约所需信息（含经授权的健康说明、联系方式），可签到/交接/报异常 |
| `device_steward` 设备管理员 | 仅设备借用与助听兼容特征，可做设备交接 |
| `interpreter` 手语译员 | 仅手语相关安排 |
| `auditor` 履约复盘 | 仅脱敏记录（观众以假名出现），演出结束后可查 |

敏感信息的显示还需观众在 `consentScopes` 中授予对应 scope（`need.mobility` / `need.sign` /
`need.hearing` / `health.note` / `contact.notify`）；角色权限与授权缺一不可。

## 主要接口

- `GET /performances`、`GET /performances/:id/accessibility?...` 场次与可行性预检（不锁资源，返回硬约束诊断与替代方案）
- `POST /requests` 购票后提交/补充无障碍申请；`POST /requests/:id/amend` 变更（重新评估并锁定，排除自身旧占用）
- `POST /requests/:id/cancel` 取消（释放席位/设备/班次，取消待发通知）
- `POST /requests/:id/rebook` 转场（释放原场次、按新场次锁定，提醒截止点不重置）
- `POST /requests/:id/accept-rearrangement` 接受故障后的同场次重排（接受时二次评估，防方案过期）
- `POST /requests/:id/fulfillment` 现场闭环：`checkin` / `handover` / `exception` / `resolve-incident` / `close`
- `POST /admin/devices/:id/fault|repair`、`POST /admin/seats/:id/fault`、`POST /admin/shifts/:id/cancel` 资源故障与恢复
- `POST /notifications/deliver`、`GET /notifications` 通知投递与查询
- `GET /fulfillment/records?performanceId=...&ended=true` 脱敏履约记录（仅复盘/现场协调）

## 关键规则

- **硬约束**：陪同人数 ≤ 轮椅位相邻陪同席数；通道最窄净宽 ≥ 轮椅通行包络（默认 900mm，可按
  `chairWidthMm` 个性化）；助听设备必须与助听器兼容特征匹配（telecoil / bluetooth-le-audio /
  infrared / universal），不跨类型自动替代；手语译员每场只服务一席，且席位需在可视区域。
- **并发**：所有写操作走串行事务 + 落锁前重新评估，并发申请不会占用同一席位或设备，
  冲突方得到 409 与可解释原因/替代方案。
- **通知防扰**：确认通知每申请仅一行，按方案指纹去重；方案不变的重复提交不重发。
- **重启续跑**：通知（含截止点）全部持久化，重启后只按原 `dueAt` 扫描补发，过期未发的
  pending 行补发且仅一次。
