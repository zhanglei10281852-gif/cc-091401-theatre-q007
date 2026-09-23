import { createApp } from "./app.js";
import { JsonStore } from "./store/json-store.js";
import { deliverDue } from "./services/notify.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const dataFile = process.env.DATA_FILE ?? ".runtime/state.json";
const notifyIntervalMs = Number.parseInt(process.env.NOTIFY_INTERVAL_MS ?? "15000", 10);

const store = new JsonStore(dataFile);

// 通知落盘投递通道（演示环境）。生产替换为短信/邮件/IM 适配器即可。
function sink(notification) {
  console.log(
    `[notify:${notification.audience}] request=${notification.requestId} type=${notification.type} :: ${notification.summary}`,
  );
}

async function pumpDueNotifications() {
  try {
    const due = await store.mutate((state) => deliverDue(state, sink));
    if (due.length > 0) console.log(`已投递 ${due.length} 条到期通知`);
  } catch (error) {
    console.error("通知投递失败：", error.message);
  }
}

await store.ready;

// 重启后未完成的提醒按原 dueAt 继续：扫描器只认持久化的截止点，
// 已过期的 pending 行会在重启后的首次扫描立即补发且只发一次。
await pumpDueNotifications();
const timer = setInterval(pumpDueNotifications, notifyIntervalMs);
timer.unref();

const server = createApp(store);
server.listen(port, host, () => console.log("剧院无障碍服务已启动"));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
