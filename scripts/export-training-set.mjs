import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const outputPath = path.resolve(process.argv[2] ?? "training/self-practice.jsonl");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await pool.query(`
    select problem_description, diff, validation_output
    from self_practice_examples
    where verified = true
    order by created_at asc
  `);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lines = result.rows.map((row) => JSON.stringify({
    messages: [
      {
        role: "system",
        content: "Repair code in an isolated workspace. Return the smallest correct repair. Correctness is established only by compiler/test/build exit codes.",
      },
      {
        role: "user",
        content: `Verified problem:\n${row.problem_description}\n\nExecution validation:\n${row.validation_output}`,
      },
      {
        role: "assistant",
        content: JSON.stringify({
          summary: "Verified code repair",
          files: [
            {
              path: "<see exported diff>",
              content: row.diff,
            },
          ],
        }),
      },
    ],
  }));

  fs.writeFileSync(outputPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  console.log(`Exported ${lines.length} verified examples to ${outputPath}`);
} finally {
  await pool.end();
}
