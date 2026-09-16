/** Smoke-test the gpt-5.4 tuner structured-output call on the rich fixture. */
import { createOpenAI } from "@ai-sdk/openai";
import { login } from "../../../src/api";
import { getBackendConfig } from "../../../src/api/backend-api";
import { buildDossier } from "../../../src/agent/context/summarize/dossier";
import { LLMContextTuner } from "../../../src/agent/context/tuner/tuner";
import { buildRichScenario } from "../../../src/agent/context/summarize/fixtures";
import { resolveOperatorParams } from "../../../src/agent/context/summarize/params";

async function main() {
  const token = await login("texera", "texera");
  const cfg = getBackendConfig();
  const openai = createOpenAI({ baseURL: `${cfg.modelsEndpoint}/api`, apiKey: token });
  const tuner = new LLMContextTuner(openai.chat("gpt-5.4"), { model: "gpt-5.4" });
  const { steps, storage } = buildRichScenario();
  const dossier = buildDossier(steps, storage);
  const task = "For my files: sales.csv. Compute total revenue per region; which region has the max revenue?";
  console.log("[smoke] calling gpt-5.4 tuner on the rich fixture …");
  const t0 = Date.now();
  const res = await tuner.tune(dossier, task);
  console.log(
    `[smoke] fromTeacher=${res.fromTeacher} (${Math.round((Date.now() - t0) / 1000)}s) usage=${JSON.stringify(res.usage)}`
  );
  console.log(`[smoke] notes: ${res.notes}`);
  for (const op of ["legacy_data", "sales", "orphan_load", "by_region", "report"]) {
    const p = resolveOperatorParams(res.params, op);
    console.log(`   ${op.padEnd(12)} detail=${p.result.latest.detail} includeCode=${p.property.includeCode}`);
  }
  if (!res.fromTeacher) {
    console.log("[smoke] FAIL: fell back to rule selector");
    process.exit(1);
  }
  console.log("[smoke] OK");
}
main().catch(e => {
  console.error("[smoke] fatal:", e);
  process.exit(1);
});
