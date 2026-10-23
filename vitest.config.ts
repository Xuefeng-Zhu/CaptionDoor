import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
const sources = fileURLToPath(
  new URL("./packages/integrations/src/", import.meta.url),
);
export default defineConfig({
  resolve: {
    alias: [
      ...["domain", "contracts", "db", "integrations"].map((name) => ({
        find: new RegExp(`^@captiondoor/${name}$`),
        replacement: fileURLToPath(
          new URL(`./packages/${name}/src/index.ts`, import.meta.url),
        ),
      })),
      {
        find: /^@captiondoor\/integrations\/(.*)$/,
        replacement: `${sources}$1.ts`,
      },
    ],
  },
  test: {
    env: {
      CAPTIONDOOR_DB_MODE: "local",
      CAPTIONDOOR_ENV: "local",
      DYNAMODB_ENDPOINT: "http://127.0.0.1:8410",
    },
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
