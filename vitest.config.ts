import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Separat från vite.config.ts så app-plugins (tailwind m.fl.) inte dras in i testerna.
// Node-miljö räcker: de testade libben är rena (inga DOM-beroenden).
export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
    },
});
