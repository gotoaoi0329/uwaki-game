// api/chat.js - Vercel Serverless Function for Gemini API Relay
// チームメンバーがAPIキー不要で遊べるようにサーバーサイドでGEMINI_API_KEYを秘匿・中継します

let cachedModelName = null;

// APIキーで利用可能な最適なGeminiモデルを自動検出
async function resolveModel(apiKey) {
  if (cachedModelName) return cachedModelName;

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (listRes.ok) {
      const data = await listRes.json();
      const models = data.models || [];
      const contentModels = models.filter(m =>
        m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent')
      );

      // 優先順位: flash系 (thinking系などの低速モデルは除外)
      const preferred = contentModels.find(m => m.name.includes('flash') && !m.name.includes('thinking'))
                     || contentModels.find(m => m.name.includes('flash'))
                     || contentModels.find(m => m.name.includes('gemini'))
                     || contentModels[0];

      if (preferred) {
        const detected = preferred.name.replace(/^models\//, '');
        console.log(`Auto-detected best Gemini model: ${detected}`);
        cachedModelName = detected;
        return detected;
      }
    }
  } catch (err) {
    console.warn('Failed to query listModels:', err);
  }

  return 'gemini-2.5-flash';
}

export default async function handler(req, res) {
  // CORSヘッダー設定（GitHub Pages やローカル開発環境からの呼び出しを許可）
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // OPTIONSリクエスト（プリフライト）対応
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // POSTのみ受け付け
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured on the server.',
      message: 'サーバーに GEMINI_API_KEY が設定されていません。Vercelの環境変数を確認してください。'
    });
  }

  try {
    const {
      character,
      otherCharacters = [],
      playerText,
      chatHistory = [],
      scheduleContext = {},
      promptContext = null
    } = req.body || {};

    if (!character || !playerText) {
      return res.status(400).json({ error: 'Invalid payload: character and playerText are required.' });
    }

    // Gemini API プロンプト構築
    const systemPrompt = `
あなたは恋愛・修羅場シミュレーションゲーム「浮気ゲーム」の【ゲームマスター判定エンジン(Judge)】および【会話相手のAI(Writer)】です。
プレイヤーは「複数の相手と同時進行している浮気男」であり、あなた（相手キャラクター）に対してLINE風チャットでメッセージを送ってきました。
あなたの任務は以下の2点を同時に行い、指定のJSON形式でのみ出力することです。

### 1. 相手キャラクター情報
- 名前: ${character.name} (${character.roleTag || ''})
- 性格・口調: ${character.bio || ''}
- 口調タイプ: ${character.type || 'standard'}

### 2. 他の浮気相手の名前（絶対に呼び間違えてはいけない地雷）
${otherCharacters.map(c => `- ${c.name} (${c.roleTag || ''})`).join('\n')}

### 3. 現在のプレイヤーの予定表（スケジュール状況）
${JSON.stringify(scheduleContext, null, 2)}

### 4. 直近のトーク履歴
${chatHistory.slice(-6).map(m => `${m.sender === 'incoming' ? character.name : 'プレイヤー'}: ${m.text}`).join('\n')}

### 5. 直前の相手からの問いかけ
${promptContext ? JSON.stringify(promptContext) : '（雑談または通常の会話）'}

### 6. プレイヤーの返信メッセージ
「${playerText}」

---
### 判定ルール (Judge)
1. **名前呼び間違え判定 (instant_gameover)**:
   - プレイヤーが「${character.name}」以外の他の相手の名前（${otherCharacters.map(c => c.name).join('、')}）で相手を呼んだ場合、即座に修羅場（即死）と判定してください。
   - result: "instant_gameover", reason: "他キャラの名前呼び間違え"
2. **AI自白判定 (instant_gameover)**:
   - プレイヤーが「AI」「人工知能」「代理」「自動返信」「bot」など、自分が人間でないことを自白した場合、即死と判定してください。
   - result: "instant_gameover", reason: "代理AIであることが発覚"
3. **スケジュール衝突判定 (conflict)**:
   - 直前の問いかけが日程調整（例: ○曜の夜空いてる？等）で、プレイヤーが「空いてる」「行ける」「大丈夫」「OK」等と答えた場合：
     - その日時枠が「仕事(work)」または「他の約束(date)」で既に埋まっている場合は予定衝突！
     - result: "conflict", trustDelta: -2, scheduleAction: "conflict", reason: "既に仕事または先約が入っている枠に二重約束"
   - 空き枠(free)であれば承諾成功！
     - result: "safe", trustDelta: 0, scheduleAction: "confirm", reason: "空き枠の約束が成立"
   - 断った場合（「無理」「仕事ある」「ごめん」等）：
     - result: "safe", trustDelta: 0, scheduleAction: "decline", reason: "安全に断った"
4. **口調不一致・冷淡・不審判定 (damage)**:
   - 相手との関係性に著しく合わない失礼な態度、辻褄の合わない嘘、極端に不自然な受け答えの場合：
     - result: "damage", trustDelta: -1, reason: "口調の不一致または不審な発言"
5. **安全 (safe)**:
   - 上記のいずれにも該当しない自然なやりとりの場合：
     - result: "safe", trustDelta: 0, scheduleAction: "none"

---
### 返信生成ルール (Writer)
- キャラクターの性格と口調を完全に再現した、1〜2文程度のリアルなLINEメッセージを返してください。
- 女上司（佐々木玲奈）: 落ち着いた口調、敬語混じり、ビジネスライクだが好意も滲む。「〜よ」「〜ね」「ありがとう」。予定衝突時は冷徹に問い詰める。
- 幼馴染（小林栞）: タメ口、親しい口調、昔馴染みの気安さ。「〜でしょ！」「〜だよー」「楽しみ！」。予定衝突時は寂しそう、または疑念を持つ。
- ギャル（愛沢あかり）: テンション高め、絵文字・草（w）、ギャル語。「〜だし！」「マジ！？✨」「やば〜い💖」。予定衝突時は「え、待って話違くない？浮気？w」など。
- 即死(instant_gameover)の場合の返信は、激怒や絶望の決定的なセリフにしてください。

---
### 出力JSONフォーマット
次のJSONオブジェクトのみを返してください。マークダウンの\`\`\`jsonブロックは不要です。
{
  "result": "safe" | "damage" | "conflict" | "instant_gameover",
  "reason": "判定の理由（日本語）",
  "trustDelta": 0,
  "scheduleAction": "none" | "confirm" | "conflict" | "decline",
  "targetSlot": { "day": "水", "time": "夜" } または null,
  "replyText": "相手キャラとしての返信セリフ"
}
`;

    // モデル自動判別 & フォールバックループ
    const detectedModel = await resolveModel(apiKey);
    const candidateModels = [
      detectedModel,
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b'
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let geminiRes = null;
    let lastErrBody = '';

    for (const model of candidateModels) {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      geminiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: systemPrompt }]
            }
          ],
          generationConfig: {
            temperature: 0.7,
            responseMimeType: 'application/json'
          }
        })
      });

      if (geminiRes.ok) {
        cachedModelName = model;
        break;
      } else if (geminiRes.status === 404) {
        lastErrBody = await geminiRes.text();
        console.warn(`Model ${model} returned 404, trying next...`);
        cachedModelName = null;
        continue;
      } else {
        lastErrBody = await geminiRes.text();
        break;
      }
    }

    if (!geminiRes || !geminiRes.ok) {
      console.error('Gemini API Error after trying models:', geminiRes?.status, lastErrBody);
      return res.status(geminiRes ? geminiRes.status : 500).json({
        error: `Gemini API returned error ${geminiRes ? geminiRes.status : 500}`,
        details: lastErrBody
      });
    }

    const data = await geminiRes.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!candidate) {
      throw new Error('No candidate content received from Gemini API.');
    }

    // JSONパース
    let parsedResult;
    try {
      const cleanJson = candidate.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
      parsedResult = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error('JSON parse error from Gemini text:', candidate);
      parsedResult = {
        result: 'safe',
        reason: 'AI応答の解析フォールバック',
        trustDelta: 0,
        scheduleAction: 'none',
        replyText: candidate.slice(0, 100)
      };
    }

    return res.status(200).json(parsedResult);
  } catch (error) {
    console.error('Server error in /api/chat:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: error.message
    });
  }
}
