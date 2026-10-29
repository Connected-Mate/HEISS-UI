// `npm run dev:gpt`: the studio on the GPT Image engine (server/gptimage.js),
// with Vite and the API server sharing one PORT (8799 unless set, since 8787
// is often taken by other local tools).
import { spawn } from "node:child_process";

const env = { ...process.env, HEISS_ENGINE: "gptimage", PORT: process.env.PORT || "8799" };
const child = spawn("npx", ["concurrently", "-k", "vite --host 127.0.0.1 --port 5173", "node server/index.js"], { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
