export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, prompt } = req.body;

  try {
    // ── Claude: concepts or SEO ──────────────────────────
    if (action === 'concepts' || action === 'seo') {
      const systemPrompt = action === 'seo'
        ? 'You are a top Etsy SEO copywriter. Respond only with valid JSON, no markdown, no explanation.'
        : 'You are a creative POD design expert. Respond only with valid JSON, no markdown, no explanation.';

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Claude error' });
      return res.status(200).json({ text: data.content[0].text });
    }

    // ── DALL-E 3: image ──────────────────────────────────
   if (action === 'image') {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: prompt,
      n: 1,
      size: '1024x1024'
    })
  });

  const data = await response.json();
  if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'OpenAI error' });
  const b64 = data.data[0].b64_json;
  return res.status(200).json({ url: `data:image/png;base64,${b64}` });
}

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
