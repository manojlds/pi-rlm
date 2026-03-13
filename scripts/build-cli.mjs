#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

const tmpCliPath = resolve(".pi/tmp-cli-build/cli.js");
const outPath = resolve("bin/pi-rlm.mjs");
const shebang = "#!/usr/bin/env node\n";

async function main() {
  const compiled = await fs.readFile(tmpCliPath, "utf8");
  const content = compiled.startsWith(shebang) ? compiled : `${shebang}${compiled}`;

  await fs.mkdir(dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, content, "utf8");
  await fs.chmod(outPath, 0o755);

  await fs.rm(resolve(".pi/tmp-cli-build"), { recursive: true, force: true });
}

await main();
