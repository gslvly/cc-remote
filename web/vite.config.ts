import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { aiBridge } from "./plugins/vite-plugin-ai-bridge";

// 开发时把 /api 转给本机服务端，端口与 ~/.cc-remote/config.json 一致
function serverPort(): number {
  if (process.env.CCR_PORT) return Number(process.env.CCR_PORT);
  const file = join(homedir(), ".cc-remote", "config.json");
  if (existsSync(file))
    return JSON.parse(readFileSync(file, "utf8")).port ?? 8686;
  return 8686;
}

// 构建号（UTC 年月日时分秒）：注入前端做 __BUILD_ID__；写进 dist/build.txt，服务端放到 x-ccr-build 头里；
// 替换进 sw.js，每次 build 都换一个新版本的 Service Worker
const BUILD_ID = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

function buildFiles(): Plugin {
  return {
    name: "ccr-build-files",
    apply: "build",
    generateBundle() {
      const sw = readFileSync(
        join(import.meta.dirname, "sw.js"),
        "utf8",
      ).replace(/__BUILD_ID__/g, BUILD_ID);
      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
      this.emitFile({ type: "asset", fileName: "build.txt", source: BUILD_ID });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid(), tailwindcss(), buildFiles(), aiBridge()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5176,
    host: true,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${serverPort()}` },
  },
});
