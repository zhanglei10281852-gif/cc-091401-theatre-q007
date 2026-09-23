export const SCHEMA_SQL = `
-- 演出场次
CREATE TABLE IF NOT EXISTS performances (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,          -- ISO 8601 带偏移量
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | transferred | closed
  transferred_to TEXT,
  created_at TEXT NOT NULL
);

-- 席位布局（按场次实例化；aisle_width_cm 为该席到出口路径的最小过道净宽）
-- 席位是否被占用以 allocations 台账为准（带并发唯一索引）
CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  performance_id TEXT NOT NULL REFERENCES performances(id),
  zone TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,               -- wheelchair | companion | standard
  accessible_route INTEGER NOT NULL DEFAULT 0,
  aisle_width_cm INTEGER NOT NULL DEFAULT 0,
  adjacent_to TEXT,                 -- 相邻轮椅席 id（陪同席绑定使用）
  unavailable INTEGER NOT NULL DEFAULT 0, -- 临时故障/封闭
  UNIQUE(performance_id, zone, label)
);

-- 每场陪同票余量（独立于席位布局的库存表）
CREATE TABLE IF NOT EXISTS companion_quota (
  performance_id TEXT PRIMARY KEY REFERENCES performances(id),
  total INTEGER NOT NULL,
  CHECK (total >= 0)
);

-- 志愿者（手语翻译等）
CREATE TABLE IF NOT EXISTS volunteers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]'  -- ["sign-language", ...]
);

-- 志愿者班次：每个志愿者每场最多一个排班；released 表示临时不可用
CREATE TABLE IF NOT EXISTS volunteer_shifts (
  volunteer_id TEXT NOT NULL REFERENCES volunteers(id),
  performance_id TEXT NOT NULL REFERENCES performances(id),
  status TEXT NOT NULL DEFAULT 'available', -- available | released
  PRIMARY KEY (volunteer_id, performance_id)
);

-- 助听设备
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,               -- hearing-loop | fm-system | captioned-receiver
  model TEXT NOT NULL,
  compatible_needs TEXT NOT NULL DEFAULT '[]', -- ["t-coil","bluetooth","none"]
  status TEXT NOT NULL DEFAULT 'available'     -- available | faulty | retired
);

-- 观众（隐私授权；敏感健康信息与申请主表分离存放）
CREATE TABLE IF NOT EXISTS patrons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  consent_version TEXT NOT NULL DEFAULT 'sample-v1',
  consent_scope TEXT NOT NULL DEFAULT '["fulfilment"]', -- 健康信息可见角色
  consent_at TEXT NOT NULL
);

-- 无障碍申请
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  patron_id TEXT NOT NULL REFERENCES patrons(id),
  performance_id TEXT NOT NULL REFERENCES performances(id),
  ticket_ref TEXT,                  -- 购票凭证；允许先申请后补录
  status TEXT NOT NULL DEFAULT 'submitted',
    -- submitted | confirmed | replanning | fulfilled | cancelled
  companion_count INTEGER NOT NULL DEFAULT 0,
  needs TEXT NOT NULL DEFAULT '[]', -- ["wheelchair-seat","sign-language","hearing-device"]
  -- 敏感健康信息，仅 consent_scope 授权的履约角色可见（客服接口脱敏）
  health_note TEXT,
  health_note_source TEXT,            -- 外部记录来源（如医院/转介机构）
  health_note_received_at TEXT,       -- 外部记录接收时间（ISO 8601）
  hearing_need TEXT,                -- t-coil | bluetooth | none，用于设备兼容硬约束
  wheelchair_width_cm INTEGER,      -- 轮椅宽度，用于过道净宽硬约束
  notification_prefs TEXT NOT NULL DEFAULT '["sms"]',
  version INTEGER NOT NULL DEFAULT 1, -- 乐观锁：购票后补充/变更
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 资源分配统一台账（席位/陪同票/志愿者/设备）
CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES access_requests(id),
  performance_id TEXT NOT NULL REFERENCES performances(id),
  resource_kind TEXT NOT NULL,      -- seat | companion-ticket | volunteer | device
  resource_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active', -- active | released
  created_at TEXT NOT NULL
);

-- 并发硬保证：同一资源在同一场次至多一条 active 分配
CREATE UNIQUE INDEX IF NOT EXISTS idx_allocation_unique
  ON allocations(resource_kind, resource_id, performance_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_allocation_request ON allocations(request_id, status);

-- 现场履约事件：签到 / 交接 / 异常
CREATE TABLE IF NOT EXISTS fulfilment_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES access_requests(id),
  performance_id TEXT NOT NULL REFERENCES performances(id),
  type TEXT NOT NULL,              -- check-in | handoff | exception
  actor_role TEXT NOT NULL,
  actor_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fulfilment_request ON fulfilment_events(request_id);

-- 替代方案（取消、转场、设备故障时生成，可解释）
CREATE TABLE IF NOT EXISTS alternatives (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES access_requests(id),
  trigger TEXT NOT NULL,           -- cancellation | transfer | resource-failure | planning
  reason TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed | accepted | rejected | expired
  chosen_option TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alternatives_request ON alternatives(request_id, status);

-- 通知（dedup_key 唯一保证幂等；scheduled_for 持久化，重启后按原截止点继续）
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES access_requests(id),
  template TEXT NOT NULL,
  channel TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | suppressed | failed
  scheduled_for TEXT NOT NULL,
  sent_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_due
  ON notifications(status, scheduled_for);

-- 脱敏履约记录快照（演出结束后查询，不可逆化名）
CREATE TABLE IF NOT EXISTS fulfilment_records (
  request_id TEXT PRIMARY KEY,
  performance_id TEXT NOT NULL,
  patron_ref TEXT NOT NULL,
  services TEXT NOT NULL,
  summary TEXT NOT NULL,
  checked_in_at TEXT,
  fulfilled_at TEXT,
  created_at TEXT NOT NULL
);
`;
