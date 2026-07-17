# Waiting List Campaign — Copy Pack (EN / JA)

All strings follow the campaign copy rules: no competitor names, no tech
stack, no banned words, no hedging, no emoji (single ⚔ allowed in the
launch post only). Gold is an accent, never a background.

---

## 1. LP — invited visitor (arriving via `?ref=`)

The LP itself does not change per-ref (static hosting). The invite context
is carried by the sharer's message. If a dynamic banner is added later:

**EN**
> Kicker: `INVITED`
> Headline: Someone saved you a place in line.
> Sub: SHOGUN is the operating system for the AI-native individual. Memory
> that captures your day. Execution that acts on it.
> CTA: `Take the spot`

**JA**
> キッカー: `招待`
> 見出し: あなたの席は、もう確保されている。
> サブ: SHOGUN は AI ネイティブな個人のための OS。一日を記憶し、その記憶から行動する。
> CTA: `席を受け取る`

---

## 2. Post-signup status page

Implemented in `web/src/app/waitlist/[code]/WaitlistStatusClient.tsx`
(single source of truth for these strings).

### Position header

| | EN | JA |
|---|---|---|
| Title | You are in line. | 順番待ちに入りました。 |
| Position | #312 of 4,820 | 4,820人中 312番目 |

### Question flow (one question per screen, count `1/3 → 3/3`)

| | EN | JA |
|---|---|---|
| Frame | Three questions. Each answer moves you up. | 3つの質問。答えるごとに順位が上がる。 |
| Note | Optional — but the line is ordered by who answers. | 回答は任意。ただし列の順番は回答者から先に進む。 |
| Q1 | Where does your time actually go? | 一番時間を溶かしているのは？ |
| Q1 options | Email and chat / Meetings and notes / Context switching / Finding things I already saw / Scheduling and admin / Other | メールとチャット / 会議とメモ / アプリ間の行き来 / 一度見たものを探し直す時間 / 日程調整と雑務 / その他 |
| Q2 | Company or role | 会社名または職種 |
| Q3 | Why SHOGUN? | なぜ SHOGUN を？ |
| Q3 hint | One sentence. What should it take off your plate first? | 一文で。最初に何を任せたいか。 |
| After each answer | Locked in. You moved up. | 記録した。順位が上がった。 |
| All done | All three answered. Your spot is secured. | 3問すべて回答済み。枠を確保した。 |
| GDPR line | Answers set your access priority and shape launch communication. Privacy → | 回答はアクセス優先度の決定とローンチ連絡のために使用します。プライバシー → |

Q3 answers are the launch-copy goldmine — export them before writing any
launch material.

### Referral block

| | EN | JA |
|---|---|---|
| Title | Skip the line. | 列を飛ばす。 |
| Body | Share your link. Each person who joins through it and answers their three questions counts as one invite. | リンクを共有する。あなたのリンクから登録して3問に回答した人が1招待としてカウントされる。 |
| Ladder | 3 invites — 1 month free / 10 invites — 3 months free / 30 invites — 6 months free / Top 10 referrers — 1 year free | 3人招待 — 1ヶ月無料 / 10人招待 — 3ヶ月無料 / 30人招待 — 6ヶ月無料 / リファラル上位10人 — 1年無料 |
| Replacement note | Rewards replace as you climb — the highest tier you reach is the one you get. | 特典は加算ではなく置換。到達した最上位の段階が適用される。 |
| Progress | 7 qualified invites · 3 more to 3 months free | 有効招待 7人 · あと3人で3ヶ月無料 |

### Share templates (prefilled X post)

**EN**
```
Your AI has memory. Now it acts.

I'm in line for SHOGUN — the OS for the AI-native individual.

{link}
```

**JA**
```
記憶するAIから、行動するAIへ。

SHOGUNのwaiting listに並んだ。

{link}
```

No reward is attached to posting itself, so no disclosure hashtag is
required on organic shares. If a future mechanic pays for the post (RT
campaigns etc.), the post MUST carry `#ad` (EN) / `#PR`(JA広告表記) as an
entry condition — see README legal section.

---

## 3. Tier notification emails

Sender: `SHOGUN <no-reply@syogun.com>`. Plain text. One CTA: the status page.

### Tier 1 — 3 invites (1 month free)

**EN — subject:** `3 invites. 1 month earned.`
```
Three people joined through your link and answered their questions.

That locks 1 month of SHOGUN free at launch.

Next rung: 10 invites — 3 months free. Rewards replace as you climb.

Your line: {statusUrl}
```

**JA — 件名:** `有効招待3人。1ヶ月無料を獲得。`
```
あなたのリンクから3人が登録し、質問に回答しました。

ローンチ時のSHOGUN 1ヶ月無料が確定です。

次の段階は10人招待で3ヶ月無料。特典は加算ではなく置換です。

あなたのステータス: {statusUrl}
```

### Tier 2 — 10 invites (3 months free)

**EN — subject:** `10 invites. Your first quarter is free.`
```
Ten qualified invites. Your reward is now 3 months free — it replaces the
1 month you held before.

Next rung: 30 invites — 6 months free. The top 10 referrers at close take
a full year.

Your line: {statusUrl}
```

**JA — 件名:** `有効招待10人。最初の3ヶ月が無料に。`
```
有効招待が10人に到達。特典は3ヶ月無料に置き換わりました。

次は30人で6ヶ月無料。最終的なリファラル上位10人は1年無料です。

あなたのステータス: {statusUrl}
```

### Tier 3 — 30 invites (6 months free)

**EN — subject:** `30 invites. Half a year, on us.`
```
Thirty qualified invites. 6 months of SHOGUN free at launch — the top of
the ladder short of the board.

The top 10 referrers at campaign close take 1 year free. You are currently
#{rank}.

Your line: {statusUrl}
```

**JA — 件名:** `有効招待30人。半年分を無料で。`
```
有効招待が30人に到達。ローンチ時から6ヶ月無料が確定です。

この上は最終順位のみ。リファラル上位10人が1年無料を獲得します。現在あなたは{rank}位。

あなたのステータス: {statusUrl}
```

### Final — top 10 at campaign close (1 year free)

**EN — subject:** `You made the board. 1 year free.`
```
The campaign is closed. You finished #{rank} — top 10.

Your reward: 1 year of SHOGUN free from launch. It replaces every tier
below it.

We activate it on your account the day access opens. Nothing to do.
```

**JA — 件名:** `上位10人入り。1年無料が確定。`
```
キャンペーンが終了しました。最終順位は{rank}位 — 上位10人です。

特典はローンチから1年無料。下位の全段階を置き換えます。

アクセス開始日にアカウントへ自動適用されます。手続きは不要です。
```

---

## 4. Launch announcement post (the one ⚔ exception)

**EN**
```
⚔ SHOGUN

Your AI has memory. Now it acts.

The waiting list is open. Invites go out weekly, in order — and the line
can be skipped: syogun.com
```

**JA**
```
⚔ SHOGUN

記憶するAIから、行動するAIへ。

Waiting list を公開。招待は毎週、順番に。列の飛ばし方はリンク先で。
syogun.com/ja/
```
