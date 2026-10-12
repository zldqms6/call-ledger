# CallLedger

A track record for trading calls that the caller can't edit. Calls are posted as the free text people actually write in Telegram signal channels, read by GenLayer validators, and settled from Upbit's public candles.

## Why I built this

I trade Korean stocks and crypto, and Korean crypto Telegram is full of paid "리딩방" (signal rooms). They all sell the same thing: a track record. And the track record is whatever the room says it is.
- Losing calls get deleted from the channel.
- Winners get screenshotted and reposted for months.
- "Targets" get adjusted after the move, and a vague "BTC looks strong" becomes a called long in hindsight.

I can't check any of it, and neither can the people paying the monthly fee. The raw material for checking already exists, though. The call is a message with a timestamp, and the outcome is in the exchange's public price history. What's missing is someone neutral who records the call **when it is posted**, refuses vague ones, and grades it later by fixed rules.

That is a job for GenLayer:
- Reading a message like `솔 숏 15만6천 / 손절 15만9천 / 1차 15만3 2차 15만` takes language understanding. Korean price shorthand (`1억1385만`, `15만3`) breaks regex-based parsers.
- Everything after the parse is plain arithmetic on public data. That part should not involve an LLM at all.

## How it works

```
post_call(message)                       the call exactly as posted, max 600 chars
  ├─ LLM: market, side, entry (or market), stop, targets (≤3), horizon (≤72h, default 72)
  ├─ code: anything missing (no stop, no target, no coin)?   → rejected
  ├─ code: Upbit KRW market exists? (ticker 404 = no)       → rejected
  ├─ code: levels fit the side against the live price?       → rejected
  │        long: stop < entry < target1 < target2 …   short: the mirror
  │        a limit entry must be within 10% of the price now
  └─ stored with the transaction time; it can never be removed

settle(call_id)                          anyone, once the call is decided
  ├─ code: fetch Upbit 10-minute candles from the first whole candle after posting
  │        to the last whole candle before expiry (or now)
  └─ code: walk them: fill → stop or targets → outcome and R multiple
```

**Validators re-do the work, not just check it.**
- `post_call`: each validator parses the message with its own LLM call and fetches its own price. It agrees only if market, side, entry, stop, every target and the horizon are **identical**. The prices it saw may differ by at most 1%. A leader that "reads" a looser stop, or a validator whose model misreads `1억1450` as 11,450,000, causes a disagreement, not a wrong record.
- `settle`: closed candles don't change, and the window end is derived from the transaction time. So every validator computes the same result, and it must match the leader's **exactly**. A leader can't turn a stop-out into a win or keep a losing call "still running".

**Settlement rules** (all in code, `_walk` in the contract):
- **Market entry** fills at the open of the first whole 10-minute candle after posting. A **limit** entry fills when a candle touches it.
- The position is split evenly across the targets. Each slice exits at its target if reached, otherwise at the stop, or at the last close when the call expires.
- If the stop and a new target fall in the same candle, the order is unknown, so **the stop wins**.
  - On a limit-fill candle only the stop is checked, since the favourable move may have come before the fill.
- **Outcomes:**
  - `won`: at least one target was reached.
  - `stopped`: the stop was hit with no target reached. R = −1.
  - `expired`: neither stop nor target before the horizon. R is marked to the last close.
  - `unfilled`: the limit entry was never touched. R = 0.
- Every caller address gets a running record: calls, won / stopped / expired / unfilled, total R.

**Errors are classified** so validators can agree on them:
- `[EXPECTED]` errors must match word for word: a rejected call, an unknown market, a call still running.
- `[TRANSIENT]` errors (Upbit 429 or 5xx) only need to be transient on both sides. Nothing is recorded, so retry later.

**Prompt injection.** The message is written by the caller, so it is data:
- It sits in a `<message>` block, and stray `<message>` tags inside it are stripped.
- The levels check is plain code, so a talked-around parse still has to describe a possible trade.

## Live run on Studionet (2026-10-12)

Contract: `0x91457Bb9E54ACB4baE6f9a098c140fFBe0499747`

I posted five messages built from the live Upbit price at 01:04–01:07 UTC (BTC 113,505,000, XRP 1,906, SOL 151,100), all with a 1-hour horizon so the run could finish the same morning. These are demo calls I wrote, not calls from a real channel. Three were accepted and settled an hour later by a different address. Every transaction below ended with leader execution `SUCCESS` and validator majority `AGREE`.

**Posting**

| Message (as posted) | Parsed by validators | Result |
|---|---|---|
| `비트 숏 지금 진입 / 손절 1억1385만 / 목표 1억1328만 / 1시간 단타` | KRW-BTC short, market entry, stop 113,850,000, target 113,280,000, 1h | call #0 |
| `리플 시장가 롱 🚀 / 손절 1899 / 1차 1911 2차 1917 / 1시간 봅니다` | KRW-XRP long, market entry, stop 1,899, targets 1,911 / 1,917, 1h | call #1 |
| `솔 14만6600 눌림 롱 대기 / 손절 14만5100 / 목표 15만2600 (1시간)` | KRW-SOL long, limit 146,600, stop 145,100, target 152,600, 1h | call #2 |
| `도지 오늘 밤 큰 거 옵니다 🚀 다들 홀딩하세요` | | rejected: `not a complete call: needs a coin, a side, a stop and a target` |
| `리플 롱 지금 진입 / 손절 1946 / 목표 1996` | | rejected: `levels don't fit a long: need stop < entry < targets (price now 1908)` |

**Settlement** (about an hour later)

| Call | Fill | What the candles show | Outcome | R |
|---|---|---|---|---|
| #0 BTC short | 113,450,000 (01:10 open) | 01:20 candle low 113,031,000 hit the target, high 113,354,000 stayed under the stop | **won**, 1/1 targets | **0.42** |
| #1 XRP long | 1,906 (01:10 open) | 01:20 candle low 1,896 went through the 1,899 stop before any target | **stopped** | **−1** |
| #2 SOL limit long | not filled | lowest low in the window was 149,800, never near 146,600 | **unfilled** | 0 |

The caller's record after settlement: `{"calls":[0,1,2], "won":1, "stopped":1, "unfilled":1, "expired":0, "total_r":"-0.58"}`. The winner and the loser stay side by side.

I checked the three results by hand against Upbit's 10-minute candles for 01:00–02:00 UTC, and they match. Korean shorthand like `1억1385만` → 113,850,000 and `14만6600` → 146,600 came out right on every validator.

Full transaction hashes and votes are in `demo_result.json`. Reproduce with `node scripts/live_demo.mjs <contract> post`, then `settle` an hour later.

## API

| Method | Who | |
|---|---|---|
| `post_call(message)` | caller | parses and checks the call, records it with the transaction time; returns the parsed fields and `id` |
| `settle(call_id)` | anyone | works once the stop or the last target is hit, or the horizon has passed; returns the result |
| `get_call(call_id)`, `get_call_count()` | anyone | the original message, its sha256, parsed levels, price at posting, status, result |
| `get_record(caller)` | anyone | `{calls, settled, won, stopped, expired, unfilled, total_r}` |

A signal room would post from one address and put that address in the channel description. Subscribers then read `get_record` instead of the screenshots.

## Tests

```bash
py -3.12 -m venv .venv && .venv/Scripts/pip install genlayer-test
.venv/Scripts/python -X utf8 -m pytest tests -v
```

(`-X utf8` is for Windows: the contract has Korean text and gltest opens it with the system codepage. `tests/conftest.py` carries a small shim for another Windows-only file-locking issue.)

11 direct-mode tests run on **real Upbit 10-minute candles** for BTC, SOL and XRP from 2026-10-06 to 2026-10-10 (`tests/fixtures/`, trimmed to the fields used). The messages are written the way Korean channels write them. The tests cover:
- parsing and recording a call, with the validator agreeing
- a SOL short taking both targets during the 10/8 drop: fill 156,800, R **2.41**
- a BTC long stopped out on 10/7: R −1
- an XRP limit entry that fills, survives a dip to 1,821, and expires: "still running" at 24h, marked to the last close at 48h
- a BTC limit bid that is never filled
- a record that keeps the loser next to the winner (total R 1.41)
- rejection of:
  - a vague "🚀" post
  - a stop on the wrong side
  - targets out of order
  - an entry more than 10% away
  - a 1-week horizon
  - a non-KRW market
  - a coin Upbit doesn't list (real 404 payload)
- validators rejecting a looser stop, a false reference price, and a misread Korean number
- validators rejecting a stop-out reported as a win, or kept artificially open
- settling before the first closed candle; an Upbit 429 leaving the call untouched; anyone can settle
- a message trying to close its `<message>` block

## Limits

- **Upbit KRW spot only.** Futures calls, other exchanges and USDT pairs are out of scope. The candle walk would work for any exchange with public OHLC; the fetch layer is Upbit-specific.
- **10-minute resolution.** Up to 10 minutes after posting are not evaluated (the first, partial candle is skipped). Inside a candle the order of high and low is unknown, which is why a stop and a target in the same candle count as a stop. That is conservative, and it can mark a real winner as a loss.
- **72-hour horizon.** That covers 432 candles in 3 requests. Swing calls of a week or more don't fit yet.
- **R is a model, not a P&L.** It assumes equal slices per target and ignores fees, slippage and leverage. It is meant for comparing callers on the same rules, not for computing anyone's returns.
- **The ledger proves what was posted, not who the caller is.** A room can still run a second, unlisted address. What it can't do is delete a loss from the address it advertises.
- **LLM parsing can fail on odd messages.** When validators parse a message differently, the call is not recorded. The caller can repost it more clearly, and that costs them the original timestamp, which is the point.
