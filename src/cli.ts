#!/usr/bin/env bun
import { main } from "./index.ts";

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
