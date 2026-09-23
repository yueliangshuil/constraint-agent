import { test } from "node:test";
import assert from "node:assert/strict";
import { bindSystemArgs } from "./agent-helpers";

test("deploy_service：模型不传 env → 系统注入场景环境", () => {
  const r = bindSystemArgs("deploy_service", { service: "pay", version: "v1" }, "prod");
  assert.equal(r.violation, null);
  assert.equal(r.args.env, "prod");
});

test("deploy_service：模型传一致 env → 放行", () => {
  const r = bindSystemArgs("deploy_service", { service: "pay", version: "v1", env: "prod" }, "prod");
  assert.equal(r.violation, null);
  assert.equal(r.args.env, "prod");
});

test("deploy_service：模型试图绕过（staging vs 场景 prod）→ 违规拦截", () => {
  const r = bindSystemArgs("deploy_service", { service: "pay", version: "v1", env: "staging" }, "prod");
  assert.ok(r.violation?.includes("staging"));
  assert.ok(r.violation?.includes("系统绑定"));
});

test("其他工具参数不受 env 绑定影响", () => {
  const r = bindSystemArgs("query_quota", { service: "pay" }, "prod");
  assert.equal(r.violation, null);
  assert.deepEqual(r.args, { service: "pay" });
});
