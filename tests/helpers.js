// 测试辅助：内存容器 + 可变时钟。
import { after } from "node:test";
import { createContainer } from "../src/container.js";
import { seed } from "../scripts/seed.js";

export function makeEnv({ seedData = true, dbPath = ":memory:", clock } = {}) {
  const sent = [];
  const container = createContainer({
    dbPath,
    clock,
    sender: async (notification) => sent.push(notification),
  });
  if (seedData) seed(container.store);
  after(() => container.db.close());
  return { ...container, sent };
}

export const PERF = "perf-2026-12-03-02";
export const PERF_ALT = "perf-2026-12-04-02";

export function wheelchairRequest(overrides = {}) {
  return {
    patronId: "patron-001",
    performanceId: PERF,
    needs: ["wheelchair-seat"],
    companionCount: 0,
    wheelchairWidthCm: 80,
    ...overrides,
  };
}
