module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const { action } = body;

  try {

    // ── STEP 1: Claude — design concepts ─────────────────
    if (action === 'concepts' || action === 'seo') {
      const { prompt, imageBase64, imageMimeType } = body;
      const systemPrompt = action === 'seo'
        ? 'You are a top Etsy SEO copywriter. Respond only with valid JSON, no markdown, no explanation.'
        : 'You are a creative POD design expert. Respond only with valid JSON, no markdown, no explanation.';

      const messages = imageBase64
        ? [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: imageMimeType || 'image/jpeg', data: imageBase64.replace(/^data:image\/\w+;base64,/, '') } },
            { type: 'text', text: prompt }
          ]}]
        : [{ role: 'user', content: prompt }];

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: systemPrompt, messages })
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Claude error' });
      return res.status(200).json({ text: data.content[0].text });
    }

    // ── STEP 1: DALL-E 3 — design image generation ───────
    if (action === 'image') {
      const { prompt } = body;
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', quality: 'standard', response_format: 'url' })
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'OpenAI error' });
      return res.status(200).json({ url: data.data[0].url });
    }

    // ── STEP 2a: Printful — upload design file ────────────
    // Uploads the approved design as a Printful file asset.
    // Returns fileId (used to attach design to product variants)
    // and fileUrl (used as product thumbnail + lifestyle mockup source).
    if (action === 'upload-design') {
      const { imageBase64 } = body;
      const contents = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const response = await fetch('https://api.printful.com/files', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ type: 'default', filename: 'pod-studio-design.png', contents })
      });
      const data = await response.json();
      if (!response.ok || data.code !== 200) {
        return res.status(400).json({ error: data.error?.message || data.result || 'Printful file upload failed' });
      }
      return res.status(200).json({ fileId: data.result.id, fileUrl: data.result.url });
    }

    // ── STEP 2b: Printful — create sync product ───────────
    // Creates the actual POD product in your Printful store.
    // Since Printful is connected to Etsy, this auto-creates
    // a draft Etsy listing. Returns the Etsy listing ID via
    // sync_product.external_id so we can update it later.
    if (action === 'create-product') {
      const { fileId, fileUrl, title, productType, price } = body;

      // Printful catalog variant IDs per product type
      // These are white/standard colour variants for most popular sizes
      const VARIANTS = {
        'T-Shirt':    [4011, 4012, 4013, 4014, 4016], // Bella+Canvas 3001 White S/M/L/XL/2XL
        'Hoodie':     [10980, 10981, 10982, 10983],    // Gildan 18500 White S/M/L/XL
        'Sweatshirt': [10964, 10965, 10966, 10967],    // Gildan 18000 White S/M/L/XL
        'Tote Bag':   [1791],                           // AOP Tote Bag one size
        'Mug':        [1320],                           // White Mug 11oz
        'Poster':     [28],                             // Enhanced Matte Paper Poster 12x18
        'Phone Case': [6101],                           // iPhone Case
        'Hat':        [11217],                          // Classic Dad Hat
      };

      const variantIds = VARIANTS[productType] || VARIANTS['T-Shirt'];
      const retailPrice = parseFloat(price || '24.99').toFixed(2);

      const syncVariants = variantIds.map(variantId => ({
        variant_id: variantId,
        retail_price: retailPrice,
        files: [{ id: fileId }]
      }));

      const response = await fetch('https://api.printful.com/store/products', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sync_product: {
            name: title.slice(0, 140),
            thumbnail: fileUrl
          },
          sync_variants: syncVariants
        })
      });

      const data = await response.json();
      if (!response.ok || data.code !== 200) {
        return res.status(400).json({ error: data.error?.message || data.result || 'Printful product creation failed' });
      }

      const product = data.result.sync_product;
      return res.status(200).json({
        printfulProductId: product.id,
        etsyListingId: product.external_id || null,
        thumbnailUrl: product.thumbnail_url
      });
    }

    // ── STEP 2c: GPT Image 1 — AI lifestyle mockup ────────
    // Takes the approved flat design image and transforms it
    // into a realistic lifestyle product photo using GPT Image 1.
    // The stylePrompt lets the seller define the aesthetic
    // (scene, mood, model style) per their brand guidelines.
    if (action === 'lifestyle-mockup') {
      const { imageBase64, stylePrompt, productType } = body;
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const imageBlob = new Blob([imageBuffer], { type: 'image/png' });

      const defaultStyle = 'Natural outdoor lighting, authentic lifestyle feel, person shown from chest up, design clearly visible, suitable for an Etsy product listing.';
      const fullPrompt = `Create a realistic lifestyle product photo of a person wearing/using a ${productType} that has this exact graphic design printed on it. The design must be clearly visible and accurate to the original. ${stylePrompt || defaultStyle}`;

      const formData = new FormData();
      formData.append('image', imageBlob, 'design.png');
      formData.append('prompt', fullPrompt);
      formData.append('model', 'gpt-image-1');
      formData.append('n', '1');
      formData.append('size', '1024x1024');

      const response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: formData
      });

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Lifestyle mockup failed' });

      // gpt-image-1 returns b64_json
      return res.status(200).json({ url: `data:image/png;base64,${data.data[0].b64_json}` });
    }

    // ── Etsy: expose API key to frontend (no secret) ─────
    // The frontend needs the Etsy client_id to build the OAuth URL.
    // We serve it from the backend so it stays out of source code.
    if (action === 'etsy-api-key') {
      return res.status(200).json({ clientId: process.env.ETSY_API_KEY || null });
    }

    // ── STEP 3a: Etsy OAuth — exchange code for token ─────
    if (action === 'etsy-token') {
      const { code, codeVerifier, redirectUri } = body;
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ETSY_API_KEY,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier
      });
      if (process.env.ETSY_CLIENT_SECRET) params.set('client_secret', process.env.ETSY_CLIENT_SECRET);

      const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error_description || data.error || 'Token exchange failed' });
      return res.status(200).json({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        shopId: process.env.ETSY_SHOP_ID
      });
    }

    // ── STEP 3b: Etsy — update listing with SEO copy ──────
    // Printful auto-creates the Etsy listing with just the title.
    // This patches in the full SEO description and 13 tags.
    if (action === 'update-etsy-listing') {
      const { accessToken, shopId, listingId, description, tags } = body;
      const response = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-api-key': process.env.ETSY_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ description, tags: tags.slice(0, 13) })
        }
      );
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error_description || data.error || 'Listing update failed' });
      return res.status(200).json({ ok: true });
    }

    // ── STEP 3c: Etsy — upload AI mockup image ────────────
    // Uploads the GPT Image lifestyle mockup to the Etsy listing.
    // Accepts base64 data URL so the image never needs to be
    // hosted externally — it goes straight from browser to Etsy.
    if (action === 'upload-etsy-image') {
      const { accessToken, shopId, listingId, imageBase64, rank } = body;
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const imageBlob = new Blob([imageBuffer], { type: 'image/png' });

      const formData = new FormData();
      formData.append('image', imageBlob, 'mockup.png');
      formData.append('rank', String(rank || 1));
      formData.append('overwrite', 'true');

      const response = await fetch(
        `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'x-api-key': process.env.ETSY_API_KEY
          },
          body: formData
        }
      );
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error_description || data.error || 'Image upload failed' });
      return res.status(200).json({ imageId: data.listing_image_id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
