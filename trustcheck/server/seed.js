// DEMO ONLY: posts synthetic reports so you can see the UI. Never run against a real deployment.
// usage: node server/seed.js http://localhost:8787 localhost
const [base = "http://localhost:8787", domain = "localhost"] = process.argv.slice(2);
const plan = [["never", ["fake_tracking"], 14], ["problem", ["counterfeit", "not_as_described"], 6], ["problem", ["delayed"], 4], ["ok", [], 2]];
let i = 0;
for (const [outcome, tags, n] of plan) for (let k = 0; k < n; k++) {
  const credential = await (await fetch(base + "/v1/register", { method: "POST" })).json();
  await fetch(base + "/v1/report", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential.token}` },
    body: JSON.stringify({ installId: credential.installId, domain, outcome, tags }) });
}
console.log("seeded", i, "DEMO reports for", domain);
