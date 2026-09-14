import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, value) => fs.writeFileSync(path.join(root, p), value);

function replaceOnce(file, from, to) {
  const source = read(file);
  if (!source.includes(from)) throw new Error(`Missing anchor in ${file}`);
  write(file, source.replace(from, to));
}

replaceOnce("src/lib/queue.ts", "  | \"domain-verify\";", "  | \"domain-verify\"\n  | \"memory-extract\";");
console.log("feature helper installed");
