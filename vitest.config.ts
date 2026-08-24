import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration test butuh env var tiruan; loadConfig dipanggil dengan env eksplisit di test,
    // tapi .env lokal operator tidak boleh mengganggu hasil test.
    testTimeout: 30000,
  },
});
