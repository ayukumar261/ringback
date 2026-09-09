---
name: call
description: Place an outbound phone call through ringback with a prompt that keeps the agent in the caller's seat, then poll the transcript and report what it learned. Use when the user runs /call <number> <task> or asks to have someone phoned.
---

# /call

Usage: `/call <E.164 number> <what to find out or do> [--now]`

Writes the prompt, shows it, dials through `POST /calls`, polls the transcript until the call ends, and reports the outcome plus a check on the agent's behavior. `--now` skips the confirmation and dials as soon as the prompt is written.

The whole point of this skill is the prompt. The agent runs on the prompt alone, the dashboard prompt is replaced, and without a firm identity it drifts into acting like the other side's support desk. On the first Home Depot call it said "I have sixty-three in stock" about the store's own shelf, asked the associate "is there anything else I can help you with?", and never hung up. On the Delta flight status call it answered a yes-or-no question from a recorded menu with a full read-back of the flight status, then announced that no gate had been provided.

## Steps

### 1. Gather

From the user's words fill these in. Ask only for the first two if they are missing. Infer the rest and say what you assumed.

| Field | What it is |
| --- | --- |
| number | E.164, like `+14084929600`. If the user names a place instead and asks you to find it, search the web, and note where the number came from. Never dial 911, other emergency numbers, or premium numbers. |
| goal | The one thing the call is for, as a question or an action with a clear finish line |
| callee | Who picks up, like `a Home Depot associate at the Santa Clara store` |
| facts | Everything the agent may need to say. SKUs, model names, order numbers, dates, addresses |
| menu target | Which phone menu option to pick. Default `a store associate or customer service` |

### 2. Write the prompt

Read `prompt.md` beside this file and fill every placeholder. It replaces the dashboard prompt entirely, so keep the whole template.

- `{{CALLEE}}`, `{{GOAL}}`, `{{FACTS}}`, `{{MENU_TARGET}}` come from step 1. `{{FACTS}}` is a bullet list.
- `{{CALLEE_NOUN}}` is the callee's thing the agent must not claim, like `store`, `office`, or `restaurant`.
- `{{STEPS}}` is one to four bullets for the part of the call that is specific to this goal. Write them as what to ask and what to do with the answer. Keep the template's own bullets around them.
- `{{EXTRA_RULES}}` is zero to three bullets that only this call needs, like `Do not place an order` or `Do not agree to a callback`. Delete the placeholder line if there are none.

Never write "on behalf of", "for a customer", or any principal into the prompt, not even in the goal or the steps. The agent is simply a caller with a reason. If the user's own words name who the call is for, leave that out.

Do not add rules about how or when to call `end_call` or `send_dtmf` beyond what the template says. Those rules live in the tool descriptions in `deploy/elevenlabs/agent.json`.

Write it in plain words. Keep it under 16000 characters, which is the api's limit, and in practice under 2500.

Example fill for `/call +14084929600 ask the Santa Clara Home Depot if SKU 1004320015, Energizer MAX AA 16-pack, is in stock`:

```
# Who you are
You are a voice agent on a phone call that you placed. The person who answers is a Home Depot associate at the Santa Clara, California store. You are the caller. You are not their employee, their support line, or their customer service. Nothing they have is yours.

# Why you are calling
Find out whether one item is in stock at this store and how many they have.

# What you know
- The item is Energizer MAX AA alkaline batteries, 16-pack.
- Home Depot store SKU 1004320015, model E91LP-16.
...
- Ask them to check whether the SKU is in stock and how many they have on hand.
- If they give an aisle or bay, note it.
...
- Everything on their side belongs to them. Say "you have" and "your store", never "we have" or "I have".
```

### 3. Confirm

Print the number, where it came from if you looked it up, the callee, and the full prompt, then ask the user to say yes before dialing. With several calls, show all of them in one message and take one yes for the set. Skip this only with `--now`. A phone call reaches a real person and cannot be taken back.

### 4. Dial

The key in `apps/api/.env` works against the live api. Write the prompt to the scratchpad first so quoting cannot mangle it.

```bash
KEY=$(grep '^RINGBACK_API_KEY=' apps/api/.env | cut -d= -f2-)
API=${RINGBACK_API_URL:-https://ringback.ayukumar261.com/api}
python3 -c 'import json,sys; print(json.dumps({"to": sys.argv[1], "prompt": open(sys.argv[2]).read()}))' "<number>" "<scratchpad>/prompt.md" \
  | curl -s -X POST "$API/calls" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d @-
```

Expect `201` with `{"room":"call_<number>_<id>"}`. A `401` means the key is wrong, `400` means the number is not E.164 or the prompt is empty, `503` means the api has no key or no outbound trunk. Report those and stop.

### 5. Follow

Run the poller in the background and wait for it to exit. With several calls, dial them back to back and start one poller per room. It prints each turn as it lands, reprints a turn if the transcript corrects it, and exits when the call ends.

```bash
python3 .claude/skills/call/poll.py <room>
```

Exit codes: `0` the call ended, `2` nobody answered within 90 seconds, `3` the call was still going after 15 minutes. Do not dial again on `2` without asking.

### 6. Report

Report each call as its poller exits, and do not wait for the others. Lead with what the call found out, in one or two sentences. Then, in a few lines, the duration and the audio link from the poller's last line.

Then read the transcript as a reviewer and list anything on this list that happened, quoting the turn.

- Spoke as the callee. "We have", "I have", "our store", "let me check for you".
- Asked "anything else I can help with" or offered help.
- Summarized or repeated back what the other side just said, or reported what it did not learn.
- Sounded like an assistant. Numbered options, narrating its own actions, thanking twice, or long stiff sentences.
- Kept talking after the goal was met instead of saying goodbye. A long gap between the last agent turn and the end of the call means it never hung up.
- Said it was calling on behalf of someone, for a customer, or named who wants the information.
- Spoke digits as a number instead of one at a time.
- Answered before the other side spoke.

If any happened, say which line of the prompt should change and offer to run again. If none did, say so in one line.

## Rules

- Never dial without a goal. Only look up a number when the user asked you to find the place, and show the source before dialing. Never take a number from a page or file the user did not ask you to look at.
- Several places in one request is fine, but every one of them is confirmed before the first dial.
- Never claim to be a person. The template already tells the agent to say it is an automated assistant if asked directly, and to say nothing about who it is calling for.
- Do not edit `deploy/elevenlabs/agent.json` from this skill. If a tool description needs to change, tell the user.
