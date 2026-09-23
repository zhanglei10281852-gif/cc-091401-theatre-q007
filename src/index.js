import { createApp } from "./app.js";
import { createContainer } from "./container.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const container = createContainer({});
const server = createApp(container);

// 启动通知分发：重启后未发送的提醒按原 scheduled_for 继续。
container.dispatcher.start();

server.listen(port, host, () => console.log("剧院无障碍服务已启动"));

function shutdown() {
  container.dispatcher.stop();
  server.close(() => {
    container.db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
