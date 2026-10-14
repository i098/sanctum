const context = await sanctum.context.get({ meeting_id });
const result = await sanctum.context.add({
  meeting_id,
  expected_revision: context.revision,
  kind: "research_observation",
  text: "Option B supports the required retention controls.",
  sources: [{ artifact_id: report.id }],
  idempotency_key: runId,
});
