// One approved, budgeted live request. Receipts contain metadata only.
// Exported for offline tests; importing this module never calls the provider.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nebiusComplete, nebiusStatus, estimateRequestCost, estimateCompletionCost } from "../lib/diligence/nebius.js";
import { liveInferenceStatus, reserveRun, settleRun } from "../lib/diligence/budget.js";

export async function runSmoke({ env = process.env, complete = nebiusComplete, connect } = {}) {
  const status = nebiusStatus(env);
  const gate = liveInferenceStatus(env, status);
  if (!gate.live) return { ok: false, error: "live_inference_not_authorized", reasons: gate.reasons };
  const schema = { type: "object", additionalProperties: false, required: ["ready", "model_family"], properties: { ready: { type: "boolean" }, model_family: { type: "string", maxLength: 40 } } };
  const system = "Answer only with the requested JSON object. Do not add prose. Schema: " + JSON.stringify(schema);
  const user = JSON.stringify({ task: 'Return {"ready": true, "model_family": "Nemotron"}.' });
  const request = { system, user, schemaName: "smoke", schema, maxTokens: 64, temperature: 0 };
  const estimated = estimateRequestCost(status.model, request);
  if (estimated.usd == null) return { ok: false, error: "no_price_for_model" };
  const reservation = await reserveRun({ estimateUsd: estimated.usd, env, connect });
  if (!reservation.ok) return { ok: false, error: reservation.error, reasons: reservation.reasons };
  const t0 = Date.now();
  let result, cost = estimated, settled = false;
  try {
    result = await complete(request, { env, deadlineMs: 20000 });
    cost = estimateCompletionCost(status.model, result, estimated);
  } catch {
    // Exception messages can contain transport secrets. Never log them.
    result = { ok: false, error: "provider_unavailable" };
  } finally {
    settled = await settleRun(reservation.reservationId, cost.usd ?? estimated.usd, { env, connect });
  }
  const output = result.output;
  const valid = result.ok && output && !Array.isArray(output) && Object.keys(output).length === 2 && output.ready === true && output.model_family === "Nemotron";
  const metadataComplete = result.returnedModel === status.model && typeof result.requestId === "string" && !!result.requestId && Number.isFinite(result.usage?.inputTokens) && Number.isFinite(result.usage?.outputTokens);
  return {
    ok: !!valid && metadataComplete && settled,
    provider: "nebius", endpoint: status.endpoint, requestedModel: status.model,
    returnedModel: result.returnedModel ?? null, requestId: result.requestId ?? null,
    latencyMs: result.latencyMs ?? null, wallMs: Date.now() - t0,
    attempts: result.attempts ?? null, finishReason: result.finishReason ?? null,
    usage: result.usage ?? null, validator: valid ? "PASS" : "FAIL",
    error: !result.ok ? result.error : !valid ? "smoke_output_rejected" : !metadataComplete ? "receipt_metadata_missing" : !settled ? "budget_settlement_failed" : null,
    budgetStore: reservation.store, budgetSettled: settled,
    costEstimateUsd: cost.usd ?? estimated.usd, pricingAsOf: estimated.pricing.asOf,
    pricingVerified: estimated.pricing.verified === true, at: new Date().toISOString(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await runSmoke();
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(receipt.ok ? 0 : 1);
}
