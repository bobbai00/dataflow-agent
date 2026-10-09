/** Delete agents that never got past initialization (left behind by runner
 * starts that failed before their first request) and free their computing
 * units. Live agents keep steps; this never touches an agent with any. */
import { login, terminateComputingUnit } from "../../src/api";
const base = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3037";
const listing: any = await (await fetch(`${base}/api/agents/`)).json();
const agents: any[] = Array.isArray(listing) ? listing : (listing.agents ?? []);
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
let deleted = 0, kept = 0;
for (const agent of agents) {
  const steps: any = await (await fetch(`${base}/api/agents/${agent.id}/react-steps`)).json();
  const count = (steps.steps ?? steps ?? []).length;
  const ageMinutes = (Date.now() - new Date(agent.createdAt).getTime()) / 60000;
  if (count <= 1 && agent.state === "AVAILABLE" && ageMinutes > 2) {
    await fetch(`${base}/api/agents/${agent.id}`, { method: "DELETE" });
    const cuid = agent.delegate?.computingUnitId ?? agent.computingUnitId;
    if (cuid) await terminateComputingUnit(token, cuid).catch(() => {});
    deleted++;
  } else kept++;
}
console.log(JSON.stringify({ total: agents.length, deleted, kept }));
