# 接口说明

所有接口返回 JSON。时间字段为带偏移量的 ISO 8601 字符串。角色通过请求头 `X-Role`
传入：`customer-service`（客服，默认最小视角）、`fulfilment`（现场履约）、`admin`。
缺失时按客服处理。

## 申请与资源

### POST /requests 提交申请（客服/管理员）
```json
{
  "patronId": "patron-001",
  "performanceId": "perf-2026-12-03-02",
  "needs": ["wheelchair-seat", "sign-language", "hearing-device"],
  "companionCount": 1,
  "wheelchairWidthCm": 82,
  "hearingNeed": "t-coil",
  "healthNote": "需平躺搬运",
  "healthNoteSource": "市残联转介",
  "healthNoteReceivedAt": "2026-11-30T10:00:00+08:00",
  "notificationPrefs": ["sms"]
}
```
`ticketRef` 可缺省（购票后再补录）。成功 `201` 返回 `status:"confirmed"` 与锁定的
`allocations`；硬约束不满足时返回 `201 status:"submitted"`，带 `violations`（可解释）
和 `alternatives`（转场/候补/替代服务/减少陪同）。`version` 用于乐观锁。

硬约束：
- 轮椅席 `accessible_route=1` 且 `aisle_width_cm >= wheelchairWidthCm`；
- 陪同席必须与轮椅席相邻，数量 ≥ `companionCount`；
- 每场陪同票独立库存 `companion_quota`，余量不足拒绝；
- 手语志愿者须具备技能且该场班次可用；
- 助听设备 `compatible_needs` 必须包含 `hearingNeed`。

### PATCH /requests/:id 购票后补充/变更（客服/管理员）
白名单字段：`ticketRef`、`needs`、`companionCount`、`hearingNeed`、
`wheelchairWidthCm`、`healthNote(及来源/接收时间)`、`notificationPrefs`。
须带当前 `version`；过期返回 `409 version_conflict`。变更触发资源释放与整体重排。

### GET /requests/:id 查询（任意角色，按角色脱敏）
客服视角 `healthNote=null`、身体参数显示为 `"registered"`，事件/分配细节剥离健康描述；
履约视角在观众授权（`consent_scope` 含 `fulfilment`）时可见健康备注及来源/接收时间。

### POST /requests/:id/cancel 取消（客服/管理员）
释放席位/班次/设备并回补陪同票，作废未决方案，抑制未发送提醒。

## 现场履约（履约/管理员）

- `POST /requests/:id/check-in` 签到。
- `POST /requests/:id/handoff`，body `{ "allocationId": "alloc-..." }`：逐项交接；
  签到后全部 active 分配完成交接，申请才转为 `fulfilled` 并生成脱敏记录。
- `POST /requests/:id/exceptions`，body `{ "detail": { "resourceKind":"device",
  "resourceId":"dev-loop-1","message":"无法开机" } }`：记录异常并自动同场重排，
  排不下则给出替代方案。

## 替代方案（客服/管理员）

- `POST /alternatives/:id/accept`，body `{ "optionIndex": 0, "version": 3 }`：
  接受转场/替代服务/候补/减少陪同；目标资源已被他人占用时返回 `409`。
- `POST /alternatives/:id/reject`。

## 场次与故障（管理员/履约）

- `POST /performances/:id/transfer` `{ "targetPerformanceId": "...", "reason": "..." }`
  整场转场：逐申请在目标场锁定资源；旧场次未发提醒自动作废，新场次按新开场时间重排。
- `POST /resource-failures` `{ "kind":"seat|device|volunteer", "resourceId":"...",
  "performanceId":"..." }`：临时故障，受影响申请同场重排或进入替代方案。
- `POST /performances/:id/close` 关场，生成脱敏履约记录。
- `GET /performances/:id/fulfilment-records` 与
  `GET /fulfilment-records?performanceId=...`：仅含化名（`P-xxxx`）、服务清单、
  签到/完成时间，不含姓名、联系方式与健康信息。

## 通知

通知以 `dedup_key` 唯一索引去重；同一事件重复触发不会重复打扰。
服务提醒的 `scheduled_for` 为开场前 1 小时的绝对时间并持久化，进程重启后未发送项
按原截止点继续发送，已发送项不重发。`POST /admin/notifications/flush`（管理员）可
手动驱动到期发送（测试/运维）。

## 基础数据（管理员）

`POST /admin/performances`（可带 `companionQuota`）、`/admin/seats`、
`/admin/volunteers`（可带 `shiftPerformanceIds`）、`/admin/devices`、`/admin/patrons`
（`consentScope` 控制健康信息可见角色）。批量录入时用数组字段 `seats/volunteers/
devices/patrons`。
