import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  // pm 脚本运行时的宿主侧依赖几个 Node 内置模块：`uvm` 的 UniversalVM 继承
  // `events.EventEmitter`，`postman-collection` 经 iconv-lite 用到 `buffer` 与
  // `string_decoder`。浏览器里没有这些模块，Vite 默认会把它们 externalize 成空对象，
  // 产物在运行时以 `Class extends value #<Object> is not a constructor` 直接崩掉
  // （构建只会给一条警告，不会失败）。这里显式指向浏览器实现。
  resolve: {
    alias: {
      events: "events",
      buffer: "buffer",
      string_decoder: "string_decoder",
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //    `openspec/` 同样不参与前端构建；更要紧的是：Windows 下 Vite 对项目
      //    目录的文件监视会持有句柄，`openspec archive` 移动变更目录时会直接
      //    报 EPERM（rename 被拒），只有在 dev server 没跑时才成功。忽略掉它，
      //    归档就不必先关掉应用。
      ignored: ["**/src-tauri/**", "**/openspec/**"],
    },
  },
}));
