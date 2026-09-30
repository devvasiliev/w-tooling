#!/usr/bin/env node

import { main } from "./task-verify-lib.mjs";

process.exitCode = await main();
