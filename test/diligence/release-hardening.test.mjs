import test from "node:test";
import assert from "node:assert/strict";
import { tavilySearch, tavilyExtract } from "../../lib/diligence/tavily.js";
import { tavilySnapshot } from "../../lib/diligence/tavily-budget.js";
import { auditFindings, validAuditOutput, AUDIT_MODEL_DEFAULT } from "../../lib/diligence/audit.js";
import { __test, budgetSnapshot } from "../../lib/diligence/budget.js";
import { sourceBytes, publicIpv4 } from "../../lib/diligence/source-fetch.js";

const env={NEBIUS_API_KEY:"synthetic",DILIGENCE_LIVE_INFERENCE:"1",DILIGENCE_GUEST_INFERENCE:"1",AI_BUDGET_APPROVAL_REFERENCE:"synthetic",AI_APPROVED_BUDGET_USD:"1",DILIGENCE_DAILY_BUDGET_USD:"1"};
const findings=[{statement:"Population grew to 65000.",evidence_ids:["e1"]}];
const packet={evidence:[{id:"e1",value:65000,text:"Population: 65000.",status:"available",scope:"city"}]};
const valid={verdicts:[{finding_id:"f1",verdict:"partially_supported",unsupported_spans:["grew"],reason:"One observation cannot establish growth."}]};

test("Tavily requires separate approval and charges failed attempts before any further request",async()=>{
  let calls=0;
  const transport=async()=>{calls++;return new Response("{}",{status:503});};
  const keyOnly={TAVILY_API_KEY:"synthetic"};
  assert.equal((await tavilySearch({query:"synthetic"},{env:keyOnly,transport})).error,"tavily_not_authorized");
  assert.equal(calls,0);
  const approved={...keyOnly,DILIGENCE_TAVILY_ENABLED:"1",TAVILY_BUDGET_APPROVAL_REFERENCE:"synthetic",TAVILY_APPROVED_CREDITS:"3",TAVILY_DAILY_CREDITS:"3",TAVILY_APPROVAL_EXPIRES_AT:"2030-01-01T00:00:00Z"};
  await tavilySearch({query:"synthetic"},{env:approved,transport});
  await tavilyExtract({urls:["https://example.gov/ordinance"]},{env:approved,transport});
  assert.equal((await tavilySearch({query:"synthetic"},{env:approved,transport})).error,"tavily_budget_refused");
  assert.equal(calls,2);
  const status=await tavilySnapshot({env:approved});
  assert.equal(status.reservedCredits,3);assert.equal(status.dailyReservedCredits,3);assert.equal(status.searchCalls,1);assert.equal(status.extractCalls,1);
});

test("malformed auditor results cannot silently lose a disputed span or claim a complete audit",async()=>{
  assert.equal(validAuditOutput(valid,findings),true);
  for(const mutate of [
    (v)=>{v.verdicts[0].unsupported_spans=[];},
    (v)=>{v.verdicts[0].unsupported_spans=["fabricated span"];},
    (v)=>{v.verdicts.push(v.verdicts[0]);},
    (v)=>{v.verdicts[0].extra="new fact";},
    (v)=>{v.verdicts=[];},
  ]){
    __test.reset(); const bad=structuredClone(valid);mutate(bad);assert.equal(validAuditOutput(bad,findings),false);
    const result=await auditFindings({findings,packet,env},{audit:async()=>({ok:true,output:bad,returnedModel:AUDIT_MODEL_DEFAULT,requestId:"synthetic",usage:{inputTokens:100,outputTokens:30},attempts:1})});
    assert.equal(result.audit.outcome,"audit_unavailable");assert.equal(result.findings[0].audit.verdict,"audit_unavailable");assert.equal(result.removed.length,0);
  }
});

test("auditor transport exceptions settle conservative cost and preserve labeled findings",async()=>{
  __test.reset();
  const result=await auditFindings({findings,packet,env},{audit:async()=>{throw new Error("private synthetic detail");}});
  assert.equal(result.audit.outcome,"audit_unavailable");assert.ok(!JSON.stringify(result).includes("private synthetic detail"));
  const budget=await budgetSnapshot({env});assert.equal(budget.reservedUsd,0);assert.equal(budget.inflight,0);assert.ok(budget.spentUsd>0);
});

test("source PDF connection cannot resolve a reviewed hostname to loopback or metadata addresses",async()=>{
  for(const ip of ["127.0.0.1","169.254.169.254","10.0.0.1","::ffff:127.0.0.1"])assert.equal(publicIpv4(ip),false);
  let connections=0;
  await assert.rejects(sourceBytes("https://www.muncie.in.gov/code.pdf",["www.muncie.in.gov"],100,{lookup:async()=>[{address:"127.0.0.1",family:4}],request:()=>{connections++;}}),/source_address_refused/);
  assert.equal(connections,0);
});
