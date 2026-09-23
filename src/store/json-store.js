import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { seedData } from "../domain/seed.js";

// 单进程 JSON 持久化存储。
// 所有写操作通过串行事务链执行，从机制上保证并发申请不会读到对方的中间状态，
// 同一席位/设备的双重占用在唯一分配校验中被拒绝。
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
    this.ready = this.#load();
  }

  async #load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = seedData();
      await this.#persist();
    }
    return this;
  }

  // 只读快照（深拷贝，避免调用方意外修改内存状态）
  snapshot() {
    return structuredClone(this.state);
  }

  // 串行化写事务：fn 接收可直接修改的状态对象，返回值会透传给调用方。
  // fn 抛出错误时状态不持久化（内存状态也需要恢复，因此先在副本上执行）。
  async mutate(fn) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      this.state = draft;
      await this.#persist();
      return result;
    });
    // 队列即使在单个事务失败后仍可继续接收后续事务
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}

// 纯内存存储：测试与健康检查使用，语义与 JsonStore 相同（串行事务 + 深拷贝）
export class MemoryStore {
  constructor() {
    this.state = seedData();
    this.queue = Promise.resolve();
    this.ready = Promise.resolve(this);
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async mutate(fn) {
    const run = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      this.state = draft;
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
