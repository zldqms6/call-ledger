// Live run on Studionet against real Upbit prices. Two phases, because a call needs time to play out:
//   node scripts/live_demo.mjs <contractAddress> post     posts calls built from the current Upbit price
//   node scripts/live_demo.mjs <contractAddress> settle   (after the 1h horizon) settles them
// Results go to demo_result.json.
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import fs from "node:fs";

const [address, phase] = process.argv.slice(2);
const GEN = 10n ** 18n;
const OUT = "demo_result.json";

function key(name) {
  const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  const m = env.match(new RegExp(`^${name}=(0x[0-9a-f]+)`, "m"));
  if (m) return m[1];
  const pk = generatePrivateKey();
  fs.appendFileSync(".env", `${name}=${pk}\n`);
  return pk;
}
async function fund(addr) {
  await fetch(studionet.rpcUrls.default.http[0], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sim_fundAccount", params: [addr, Number(1000n * GEN)] }),
  });
}

const caller = createAccount(key("DEMO_CALLER_PK"));
const stranger = createAccount(key("DEMO_SETTLER_PK"));   // settling is open to anyone
const gl = createClient({ chain: studionet });

const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x)));
const read = async (functionName, args) =>
  plain(await gl.readContract({ address, functionName, args, transactionHashVariant: "latest-nonfinal" }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Studionet's shared LLM provider rate-limits bursts; a rate-limited call still shows ACCEPTED
// (validators agree it errored) but changes nothing, so check the leader result and retry.
async function write(account, functionName, args) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const hash = await gl.writeContract({ account, address, functionName, args, value: 0n });
    const r = await gl.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 200, interval: 5000 });
    const leader = r?.consensus_data?.leader_receipt?.[0];
    const exec = leader?.execution_result;
    const err = leader?.genvm_result?.error_code;
    const votes = r?.consensus_data?.votes ? Object.values(r.consensus_data.votes) : r?.last_round?.validator_votes_name;
    const msg = typeof leader?.result?.payload === "string" ? leader.result.payload : "";
    console.log(`${functionName} -> ${hash} ${r?.status_name ?? ""} ${exec ?? ""} ${err ?? ""}`);
    if (exec !== "ERROR" || err !== "LLM_RATE_LIMITED") {
      return { hash, status: r?.status_name, exec, error: err, votes, message: String(msg).slice(0, 300) };
    }
    await sleep(90_000 * attempt);
  }
  throw new Error(`${functionName} kept hitting the LLM rate limit`);
}

async function upbit(markets) {
  const r = await fetch(`https://api.upbit.com/v1/ticker?markets=${markets.join(",")}`);
  return Object.fromEntries((await r.json()).map((t) => [t.market, t.trade_price]));
}

// how Korean channels write prices: 1억1386만, 14만6600
function krw(n) {
  n = Math.round(n);
  if (n >= 1e8) {
    const eok = Math.floor(n / 1e8), man = Math.round((n % 1e8) / 1e4);
    return `${eok}억${man ? man + "만" : ""}`;
  }
  if (n >= 1e4) {
    const man = Math.floor(n / 1e4), rest = n % 1e4;
    return `${man}만${rest ? rest : ""}`;
  }
  return `${n}`;
}
const tick = (n, step) => Math.round(n / step) * step;

if (phase === "post") {
  await fund(caller.address);
  await fund(stranger.address);
  const p = await upbit(["KRW-BTC", "KRW-XRP", "KRW-SOL"]);
  const messages = [
    `비트 숏 지금 진입\n손절 ${krw(tick(p["KRW-BTC"] * 1.003, 1e4))}\n목표 ${krw(tick(p["KRW-BTC"] * 0.998, 1e4))}\n1시간 단타`,
    `리플 시장가 롱 🚀\n손절 ${p["KRW-XRP"] - 7}\n1차 ${p["KRW-XRP"] + 5} 2차 ${p["KRW-XRP"] + 11}\n1시간 봅니다`,
    `솔 ${krw(tick(p["KRW-SOL"] * 0.97, 100))} 눌림 롱 대기\n손절 ${krw(tick(p["KRW-SOL"] * 0.96, 100))}\n목표 ${krw(tick(p["KRW-SOL"] * 1.01, 100))} (1시간)`,
    `도지 오늘 밤 큰 거 옵니다 🚀 다들 홀딩하세요`,
    `리플 롱 지금 진입\n손절 ${p["KRW-XRP"] + 40}\n목표 ${p["KRW-XRP"] + 90}`,
  ];
  const out = { contract: address, network: "studionet", caller: caller.address, prices_at_post: p, posts: [], settles: [] };
  for (const message of messages) {
    const before = Number(await read("get_call_count", []));
    const tx = await write(caller, "post_call", [message]);
    const after = Number(await read("get_call_count", []));
    const call = after > before ? await read("get_call", [before]) : null;
    console.log(`  ${JSON.stringify(message)} ->`, call ? `call #${before} ${call.side} ${call.market}` : `rejected: ${tx.message}`);
    out.posts.push({ message, tx: tx.hash, exec: tx.exec, votes: tx.votes, rejection: call ? null : tx.message, call_id: call ? before : null, call });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    await sleep(20_000);
  }
} else if (phase === "settle") {
  const out = JSON.parse(fs.readFileSync(OUT, "utf8"));
  for (const post of out.posts.filter((x) => x.call_id !== null)) {
    const tx = await write(stranger, "settle", [post.call_id]);
    const call = await read("get_call", [post.call_id]);
    console.log(`  call #${post.call_id}: ${call.status}`, JSON.stringify(call.result));
    out.settles.push({ call_id: post.call_id, tx: tx.hash, exec: tx.exec, votes: tx.votes, message: tx.message, status: call.status, result: call.result });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    await sleep(10_000);
  }
  out.record = await read("get_record", [out.caller]);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("record", JSON.stringify(out.record));
}
