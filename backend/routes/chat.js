const express = require('express');
const router = express.Router();
const axios = require('axios');
const Destination = require('../models/Destination');

const { resolveDestinationImage, sanitizeLocationName } = require('../services/imageService');

// Smart keyword-based NLP logic with expanded detection
function getKeywords(msg) {
    const text = msg.toLowerCase();
    const categories = ['beach', 'mountain', 'historical', 'cultural', 'adventure', 'religious', 'wildlife'];
    let foundCategory = categories.find(c => text.includes(c));
    // Also detect plural/alternate forms
    if (!foundCategory && text.includes('beaches')) foundCategory = 'beach';
    if (!foundCategory && text.includes('mountains')) foundCategory = 'mountain';
    if (!foundCategory && text.includes('temple')) foundCategory = 'religious';
    if (!foundCategory && text.includes('church')) foundCategory = 'religious';
    if (!foundCategory && text.includes('fort')) foundCategory = 'historical';
    if (!foundCategory && text.includes('palace')) foundCategory = 'historical';
    if (!foundCategory && text.includes('trek')) foundCategory = 'adventure';
    if (!foundCategory && text.includes('safari')) foundCategory = 'wildlife';
    
    let intent = 'unknown';

    if (text.match(/\b(recommend|places|where to go|tourist|explore|visit|show|suggest|best|top|famous|popular|destination)\b/)) {
        intent = 'recommendation';
    } else if (text.match(/\b(book|reserve|booking)\b/)) {
        intent = 'booking';
    } else if (text.match(/\b(hi|hello|hey|greetings)\b/)) {
        intent = 'greeting';
    } else if (text.includes('thank')) {
        intent = 'thanks';
    } else if (text.match(/\b(bye|goodbye|see ya)\b/)) {
        intent = 'bye';
    } else if (text.includes('trips') || text.includes('packages') || text.includes('table')) {
        intent = 'trips';
    } else if (text.match(/\b(day|days|week|itinerary|plan|budget)\b/) && text.match(/\b(trip|tour|travel)\b/)) {
        intent = 'recommendation';
    }

    // If a category was found but no intent was matched, assume recommendation
    if (foundCategory && intent === 'unknown') intent = 'recommendation';

    console.log(`Debug getKeywords -> text: "${text}", intent: "${intent}", category: "${foundCategory || 'none'}"`);
    return { intent, category: foundCategory, text };
}

// Make sure to install: npm install @google/generative-ai
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ============================================================
// IMAGE LANDMARK IDENTIFICATION HELPER
// Calls Gemini Vision to identify the actual place in an image
// BEFORE generating any tourism response.
// ============================================================
async function identifyLandmarkFromImage(genAI, imageBase64, mimeType, userHint = '') {
    // Strip the data URL prefix if present (e.g. "data:image/jpeg;base64,...")
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const resolvedMime = mimeType || 'image/jpeg';

    // Guard: if the image is too large (>4MB base64 = ~3MB raw), skip to avoid API errors
    if (base64Data.length > 5_500_000) {
        console.warn('[Image Recognition] Image too large for inline API call, skipping vision step.');
        return null;
    }

    const identificationPrompt = `You are a precise landmark and location identification AI.
Analyze this image carefully and identify the EXACT place/landmark shown.

Look for:
- Architecture style (temple, palace, fort, church, mosque, etc.)
- Visible signs, text, or inscriptions in the image
- Distinctive structural features (gopuram, dome, minaret, monument, etc.)
- Landscape and surroundings
- Cultural and regional characteristics
- Known world tourist landmarks

${userHint ? `User hint: "${userHint}"` : ''}

IMPORTANT RULES:
- Be SPECIFIC. Do NOT guess a generic city or region if you can identify the specific landmark.
- Example: If the image shows Taj Mahal, say "Taj Mahal" NOT just "Agra".
- Example: If the image shows Chamundeshwari Temple, say "Chamundeshwari Temple" NOT just "Mysore".
- If you truly cannot identify the specific landmark, still return your best guess with a lower confidence.
- Never invent or hallucinate landmark names.

Respond ONLY in this exact JSON format (no markdown backticks):
{
  "identifiedPlace": "Taj Mahal",
  "city": "Agra",
  "state": "Uttar Pradesh",
  "country": "India",
  "confidence": 0.99,
  "category": "Monument",
  "reason": "Iconic white marble mausoleum with central dome and four minarets, unmistakably the Taj Mahal"
}`;

    // Try model names in order of preference — gemini-flash-latest is confirmed working on this key
    const modelCandidates = [
        'gemini-flash-latest',
        'gemini-2.0-flash',
        'gemini-1.5-flash-latest',
        'gemini-1.5-flash'
    ];

    for (const modelName of modelCandidates) {
        try {
            console.log(`[Image Recognition] Trying model: ${modelName}`);
            const visionModel = genAI.getGenerativeModel({ model: modelName });

            const result = await visionModel.generateContent([
                identificationPrompt,
                {
                    inlineData: {
                        data: base64Data,
                        mimeType: resolvedMime
                    }
                }
            ]);

            let rawText = result.response.text().trim();
            // Strip markdown code fences if model adds them
            rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

            const parsed = JSON.parse(rawText);
            console.log(`[Image Recognition] ✅ Model "${modelName}" identified: "${parsed.identifiedPlace}", ${parsed.city}, confidence: ${parsed.confidence}`);
            return parsed;
        } catch (e) {
            console.error(`[Image Recognition] ❌ Model "${modelName}" failed: ${e.message}`);
            // Continue to next candidate
        }
    }

    console.error('[Image Recognition] All model candidates failed. Cannot identify landmark.');
    return null;
}

router.post('/', async (req, res) => {
    const { message, history, image, mimeType, imageUrl } = req.body;
    
    // Check if Gemini API is configured
    if (process.env.GEMINI_API_KEY) {
        try {
            console.log("Using Google Generative AI SDK for request...");
            
            let languageContext = "en";
            let communityPlacesContext = "No community places available.";
            let memoryContext = "No memory context.";
            
            const authHeader = req.header('Authorization');
            if (authHeader) {
                const token = authHeader.replace('Bearer ', '');
                if (token && token !== 'null') {
                    try {
                        const jwt = require('jsonwebtoken');
                        const decoded = jwt.verify(token, process.env.JWT_SECRET);
                        let userId = decoded.user.id;
                        const UserPreferences = require('../models/UserPreferences');
                        const prefs = await UserPreferences.findOne({ userId });
                        if (prefs) {
                            languageContext = prefs.preferredLanguage || "en";
                            memoryContext = `USER MEMORY CONTEXT:
- Favorite Destinations: ${(prefs.favoriteDestinations || []).join(', ')}
- Budget Preference: ${prefs.budgetPreference}
- Travel Style: ${(prefs.travelStyle || []).join(', ')}
- Dietary Preference: ${prefs.dietaryPreference}
- Previous Trips: ${(prefs.previousTrips || []).map(t => t.destination).join(', ')}
If the user doesn't specify details, default to these preferences. Acknowledge them if relevant.`;
                        } else {
                            memoryContext = "User is new. Pay attention to preferences to store them.";
                        }
                    } catch(e) { console.log('Invalid token in chat', e.message); }
                }
            }
            
            try {
                const CommunityPlace = require('../models/CommunityPlace');
                const places = await CommunityPlace.find({ isApproved: true }).limit(5);
                if (places.length > 0) {
                    communityPlacesContext = "COMMUNITY HIDDEN GEMS:\n" + places.map(p => `- ${p.placeName} (${p.category}): ${p.description}`).join('\n');
                }
            } catch(e) { console.log('Failed to fetch community places', e.message); }
            
            const systemPrompt = `You are an intelligent, conversational AI travel companion.
You must deeply understand the user's intent and extract specific constraints from their message.

${memoryContext}

CRITICAL RULES FOR DESTINATIONS:
1. Exact Destination Focus: If the user asks for a specific place without asking for nearby places (e.g., "Bangalore", "banglore", "tell me about udupi"), you MUST generate the travel card for THAT exact destination. Do NOT recommend nearby places as the main destination.
2. Local vs Nearby City Intent: If the user explicitly asks for "places near [City]", "tourist attractions in [City]", "best places to visit around [City]", you MUST return local attractions WITHIN or IMMEDIATELY SURROUNDING that city (e.g., for Bangalore: Lalbagh Botanical Garden, Cubbon Park, Bangalore Palace, Nandi Hills, etc.). DO NOT return unrelated destinations from other states (e.g. Kovalam, Goa, Kashmir, Rajasthan) unless explicitly asked.
3. Spelling Auto-Correction: Understand spelling mistakes automatically (e.g., "banglore" -> "Bangalore", "mysor" -> "Mysore", "udpi" -> "Udupi"). Always output the correctly spelled destination.
4. No Hallucinations & Geographic Strictness: Only return real tourist places. Search priority must be: Exact Destination -> Local Attractions -> Nearby Cities -> State Attractions. Never return random fallback results.
5. Contextual Category Clicks: If the user searches for a category (e.g., "🏖 Beaches", "🍽 Seafood", "🏛 Heritage Places"), determine the current destination city from the chat history and return ONLY relevant local places for that category within that specific city. Do NOT return unrelated places (e.g., temples for a beaches query).

DYNAMIC CHIPS:
Whenever you respond with a destination or recommendation, you MUST generate exactly FIVE destination-specific recommendation chips (e.g., "🏛 Heritage Places", "🌳 Parks & Gardens", "🍽 Famous Food"). Include emojis. These must be highly tailored to the current destination and never generic.

MOOD DETECTION:
If the user expresses emotions (e.g., bored, stressed, adventurous), suggest mood-appropriate destinations and set action to "MOOD_SUGGESTION".

ITINERARY GENERATION:
If the user asks for a trip plan or itinerary, generate a structured day-by-day plan with timings, places, and costs. Set action to "GENERATE_ITINERARY".

HIDDEN GEMS:
${communityPlacesContext}
Include these in recommendations if relevant. Set action to "HIDDEN_GEMS" if you are specifically recommending these.

COMPANION MODE:
If the user asks for nearby places (restaurants, hotels, hospitals, ATMs) around a location, set action to "NEARBY_PLACES".

SAFETY INFO:
If the user asks for safety, emergency contacts, or weather warnings, set action to "SAFETY_INFO".

LANGUAGE:
Respond in the language specified by code: "${languageContext}" (en=English, hi=Hindi, kn=Kannada).

IMPORTANT - RELATED PLACES RULE:
For every destination you generate, you MUST provide exactly 5 real, geographically nearby tourist attractions in the 'nearby_places' array.
- Use strict geographic proximity (same district/city/state).
- Never recommend unrelated or random places.

Respond strictly in JSON format ONLY, without markdown backticks. 
Format MUST exactly match this structure:
{
  "reply": "Your conversational reply acknowledging their constraints.",
  "action": "RECOMMENDATION", 
  "dynamic_chips": ["🏛 Heritage Places", "🌳 Parks & Gardens", "🍽 Famous Food", "🛍 Shopping", "🌄 Weekend Trips"],
  "extracted_constraints": {
    "destination": "Bangalore",
    "budget": 15000,
    "days": 5,
    "interests": ["historical", "nature"]
  },
  "travel_cards": [
    {
      "place_name": "Lalbagh Botanical Garden",
      "location": "Bangalore, India",
      "category": "nature",
      "rating": "4.6",
      "reviews": "10k+ reviews",
      "description": "Provide a very detailed, multi-paragraph description here. Give historical context, architectural details, cultural significance, and what makes it special. Do not use just one sentence. Write at least 3-4 sentences resembling a comprehensive travel guide description.",
      "image_url": "", 
      "image_gallery": [],
      "map_url": "https://maps.google.com/?q=Lalbagh+Botanical+Garden+Bangalore",
      "best_time": "Early Morning / Evening",
      "entry_fee": "₹30",
      "distance_from_origin": "5 km from City Center",
      "travel_time": "15 mins",
      "tags": ["Nature", "Garden"],
      "weather": { "temperature": "28°C", "condition": "Sunny" },
      "nearby_places": [
        {
          "name": "Cubbon Park",
          "distance": "3 km",
          "description": "The lung space of Bangalore.",
          "rating": "4.5",
          "best_time": "Year-round",
          "image_url": ""
        }
      ],
      "itinerary": [
        {
          "day": 1,
          "title": "Arrival & City Tour",
          "activities": [
            "Morning: Arrive and settle in.",
            "Afternoon: Visit the Lalbagh Botanical Garden.",
            "Evening: Stroll around Cubbon Park and MG Road."
          ]
        },
        {
          "day": 2,
          "title": "Heritage & Culture",
          "activities": [
            "Morning: Explore Bangalore Palace.",
            "Afternoon: Lunch at a traditional South Indian restaurant.",
            "Evening: Shopping at Commercial Street."
          ]
        }
        }
      ],
      "packing_list": [
        "Comfortable walking shoes",
        "Sunscreen and sunglasses",
        "Light cotton clothes",
        "Water bottle"
      ],
      "budget_breakdown": {
        "transport": 25,
        "hotel": 35,
        "food": 25,
        "activities": 15
      }
    }
  ]
}`;

            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
            const targetModel = "gemini-flash-latest";
            const model = genAI.getGenerativeModel({ model: targetModel });

            // =========================================================
            // STEP 1: IMAGE ANALYSIS — Identify the actual landmark FIRST
            // Only runs when the user uploads an image or passes an image URL.
            // =========================================================
            let imageRecognition = null;
            let imageAnalysisContext = '';

            const hasImage = !!(image && image.length > 100); // base64 image from upload

            if (hasImage) {
                console.log('[Image Recognition] Image detected. Identifying landmark BEFORE generating tourism info...');

                // Extract any user-provided text hint (e.g. "this is Udupi" or "explore this temple")
                const userHint = message && message.trim() ? message.trim() : '';

                imageRecognition = await identifyLandmarkFromImage(genAI, image, mimeType, userHint);

                if (imageRecognition && typeof imageRecognition.confidence === 'number' && imageRecognition.confidence < 0.6) {
                    // Low confidence — do NOT guess. Ask the user to confirm.
                    console.log(`[Image Recognition] Low confidence (${imageRecognition.confidence}). Asking user to confirm.`);
                    return res.json({
                        reply: `🔍 I analyzed the image and this looks like it could be **${imageRecognition.identifiedPlace}** in ${imageRecognition.city || 'an unknown location'}, but I'm not fully certain (confidence: ${Math.round(imageRecognition.confidence * 100)}%).\n\nWould you like me to show tourism details for **${imageRecognition.identifiedPlace}**? Or could you tell me the place name so I can give you accurate information?`,
                        action: 'IMAGE_UNCONFIRMED',
                        image_recognition: imageRecognition,
                        dynamic_chips: [
                            `🗺️ Yes, show ${imageRecognition.identifiedPlace}`,
                            `📍 Tell me the place name`,
                            `🏛️ Search by name instead`,
                            `📸 Upload a clearer image`,
                            `🌏 Browse destinations`
                        ],
                        travel_cards: []
                    });
                }

                if (!imageRecognition || !imageRecognition.identifiedPlace) {
                    // Complete failure — cannot identify.
                    console.log('[Image Recognition] Could not identify place from image.');
                    return res.json({
                        reply: `🔍 I couldn't confidently identify this place from the image. Please upload a clearer image or tell me the place name so I can find the best tourism information for you!`,
                        action: 'IMAGE_UNIDENTIFIED',
                        dynamic_chips: [
                            `📷 Upload a clearer image`,
                            `🔤 Type the place name`,
                            `🏛️ Historical Places`,
                            `🏖️ Beaches`,
                            `🌄 Hill Stations`
                        ],
                        travel_cards: []
                    });
                }

                // ✅ High confidence identification succeeded
                // Build context so the tourism prompt focuses on the IDENTIFIED place
                imageAnalysisContext = `
IMAGE RECOGNITION RESULT (HIGH PRIORITY - DO NOT IGNORE):
The user uploaded an image. The AI Vision system has identified the following landmark:
- Place: ${imageRecognition.identifiedPlace}
- City: ${imageRecognition.city || 'Unknown'}
- State: ${imageRecognition.state || 'Unknown'}
- Country: ${imageRecognition.country || 'India'}
- Category: ${imageRecognition.category || 'tourist place'}
- Confidence: ${Math.round((imageRecognition.confidence || 1) * 100)}%
- Reason: ${imageRecognition.reason || 'Visual identification'}

CRITICAL INSTRUCTION:
You MUST generate tourism information for "${imageRecognition.identifiedPlace}" in ${imageRecognition.city || ''}, ${imageRecognition.state || ''}.
Do NOT use any other destination from the chat history.
Do NOT substitute a different landmark even if the city is familiar.
The extracted_constraints.destination MUST be set to "${imageRecognition.identifiedPlace}".
The travel_card place_name MUST be "${imageRecognition.identifiedPlace}".
All nearby_places and recommendations MUST be genuinely near ${imageRecognition.identifiedPlace} in ${imageRecognition.city || ''}.`;

                console.log(`[Image Recognition] ✅ Identified: ${imageRecognition.identifiedPlace}, ${imageRecognition.city}. Generating tourism info...`);
            }

            // =========================================================
            // STEP 2: GENERATE TOURISM RESPONSE
            // Uses identified place context if image was provided.
            // =========================================================
            const userMessageForAI = imageRecognition
                ? `The user uploaded an image. The identified place is: ${imageRecognition.identifiedPlace}, ${imageRecognition.city}, ${imageRecognition.state}. ${message ? `User also said: "${message}"` : 'Please provide complete tourism information for this identified place.'}`
                : (message || 'Tell me about this place.');

            const fullMessage = `${systemPrompt}\n\n${imageAnalysisContext}\n\nCHAT HISTORY:\n${history || 'No previous history.'}\n\nUSER MESSAGE:\n${userMessageForAI}`;
            const result = await model.generateContent(fullMessage);
            
            let rawText = result.response.text();
            
            if (rawText) {
                rawText = rawText.trim();
                // Strip markdown backticks if Gemini accidentally includes them
                if (rawText.startsWith('```json')) rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
                else if (rawText.startsWith('```')) rawText = rawText.replace(/```/g, '').trim();
                
                let aiResult = { reply: rawText, action: "NONE", destinationName: null };
                try {
                    aiResult = JSON.parse(rawText);
                    
                    if (userId && aiResult.memory_updates) {
                        const UserPreferences = require('../models/UserPreferences');
                        let prefs = await UserPreferences.findOne({ userId });
                        if (!prefs) {
                            prefs = new UserPreferences({ userId });
                        }
                        const updates = aiResult.memory_updates;
                        if (updates.favoriteDestinations && Array.isArray(updates.favoriteDestinations) && updates.favoriteDestinations.length) {
                            prefs.favoriteDestinations = [...new Set([...prefs.favoriteDestinations, ...updates.favoriteDestinations])];
                        }
                        if (updates.budgetPreference) prefs.budgetPreference = updates.budgetPreference;
                        if (updates.travelStyle && Array.isArray(updates.travelStyle) && updates.travelStyle.length) {
                            prefs.travelStyle = [...new Set([...prefs.travelStyle, ...updates.travelStyle])];
                        }
                        if (updates.dietaryPreference) prefs.dietaryPreference = updates.dietaryPreference;
                        if (updates.mood) {
                            prefs.moodHistory.push({ mood: updates.mood, date: new Date() });
                        }
                        
                        await prefs.save();
                    }
                    
                    // FIX IMAGES: ALWAYS use real DB images over AI-generated ones
                    if (aiResult.travel_cards && Array.isArray(aiResult.travel_cards)) {
                        for (let i = 0; i < aiResult.travel_cards.length; i++) {
                            const card = aiResult.travel_cards[i];
                            let placeNameForImage = card.place_name || 'Destination';
                            let cityContext = (aiResult.extracted_constraints && aiResult.extracted_constraints.destination) ? aiResult.extracted_constraints.destination : '';
                            
                            // If the placeName doesn't already contain the city name, append it for better image matching
                            if (cityContext && !placeNameForImage.toLowerCase().includes(cityContext.toLowerCase())) {
                                placeNameForImage = `${placeNameForImage} ${cityContext}`;
                            }
                            
                            // Fix: topAttractions was undefined — use card's own top_attractions array
                            const topAttractions = Array.isArray(card.top_attractions)
                                ? card.top_attractions.map(a => (typeof a === 'string' ? a : a.name || ''))
                                : [];
                            const realImage = await resolveDestinationImage(placeNameForImage, topAttractions);
                            card.image_url = realImage.image_url;
                            card.image_gallery = realImage.image_gallery;

                            if (card.nearby_places && Array.isArray(card.nearby_places)) {
                                for (let j = 0; j < card.nearby_places.length; j++) {
                                    const np = card.nearby_places[j];
                                    let npNameForImage = np.name;
                                    if (cityContext && !npNameForImage.toLowerCase().includes(cityContext.toLowerCase())) {
                                        npNameForImage = `${npNameForImage} ${cityContext}`;
                                    }
                                    const npRealImage = await resolveDestinationImage(npNameForImage, []);
                                    np.image_url = npRealImage.image_url;
                                }
                            }
                        }
                    }

                } catch (parseErr) {
                    console.log("Gemini did not return valid JSON. Falling back to raw text:", parseErr.message);
                }
                
                let destination = null;
                let liveWeatherString = "";

                if (aiResult.action === 'START_BOOKING' && aiResult.destinationName) {
                    // Try to find it in the database first
                    destination = await Destination.findOne({ name: { $regex: new RegExp(`^${aiResult.destinationName}$`, 'i') } });
                    
                    if (!destination) {
                        console.log(`Global AI generated a new location: ${aiResult.destinationName}. Creating database entry...`);
                        destination = new Destination({
                            name: aiResult.destinationName,
                            location: aiResult.destinationLocation || "Global Destination",
                            category: ["beach", "mountain", "historical"].includes(aiResult.destinationCategory) ? aiResult.destinationCategory : "historical",
                            description: aiResult.destinationDescription || "A beautiful location discovered by AI.",
                            price: aiResult.destinationPrice || 500,
                            imageUrl: "https://images.unsplash.com/photo-1488085061387-422e29b40080?q=80&w=1000&auto=format&fit=crop"
                        });
                        await destination.save();
                    }

                    // FETCH LIVE WEATHER DATA DYNAMICALLY WITHOUT API KEYS!
                    try {
                        console.log(`Fetching live weather for ${aiResult.destinationName}...`);
                        const weatherRes = await fetch(`https://wttr.in/${encodeURIComponent(aiResult.destinationName)}?format=j1`);
                        const weatherData = await weatherRes.json();
                        
                        const tempC = weatherData.current_condition[0].temp_C;
                        const condition = weatherData.current_condition[0].weatherDesc[0].value;
                        
                        liveWeatherString = `\n\n🌤️ *Live Real-Time Weather in ${aiResult.destinationName}:* ${tempC}°C and ${condition}!`;
                    } catch(e) {
                        console.log("Could not ping weather API.", e.message);
                    }
                }
                
                const finalAiReply = (aiResult.reply || rawText) + liveWeatherString;

                return res.json({
                    reply: finalAiReply,
                    action: aiResult.action,
                    travel_cards: aiResult.travel_cards || [],
                    dynamic_chips: aiResult.dynamic_chips || [],
                    image_recognition: imageRecognition || null
                });
            }
        } catch (err) {
            if (err.status === 429 || (err.message && err.message.includes('429')) || (err.message && err.message.includes('RetryInfo'))) {
                console.error("[Gemini API] Rate limit exceeded. (429 Too Many Requests)");
                return res.json({ 
                    reply: "I am receiving too many requests right now! Please wait a few seconds and try asking me again. ⏳", 
                    action: "NONE" 
                });
            } else {
                console.error("Gemini failed, falling back to basic...");
                if (err.status) console.error(`[Gemini Error Status]: ${err.status} - ${err.statusText}`);
                if (err.message) console.error(`[Gemini Error Message]: ${err.message}`);
                try {
                    console.error("FULL RAW ERROR:", JSON.stringify(err, null, 2));
                } catch(e) {
                    console.error("FULL RAW ERROR:", err);
                }
            }
        }
    }

    // --- FALLBACK LOGIC IF NO GEMINI KEY ---
    const { intent, category, text } = getKeywords(message);

    try {
        if (intent === 'greeting') {
            const places = await Destination.find().limit(2);
            let replyText = 'Hi there! 👋 I am your friendly AI Tourist Assistant. I can help you plan your perfect trip! ';
            if (places.length > 0) {
                const sugg = places.map(p => p.name).join(' and ');
                replyText += `Did you know we have beautiful places like ${sugg}? You can ask me to book them, or ask for recommendations by category (beach, mountain, historical)!`;
            } else {
                replyText += `You can ask me to recommend beach, mountain, or historical destinations!`;
            }
            return res.json({ reply: replyText });
        }

        if (intent === 'thanks') {
            return res.json({ reply: 'You are very welcome! 😊 Let me know if you need anything else or want to explore another destination.' });
        }

        if (intent === 'trips') {
            return res.json({ 
                reply: 'Sure! Here are some of our popular trip packages you can add to your cart:',
                action: 'SHOW_TRIPS' 
            });
        }

        if (intent === 'bye') {
            return res.json({ reply: 'Goodbye! Safe travels, and I hope to help you plan another trip soon! ✈️' });
        }

        if (intent === 'booking') {
            const places = await Destination.find();
            let matchedPlace = places.find(p => text.includes(p.name.toLowerCase()));

            if (matchedPlace) {
                return res.json({
                    reply: `Great! You want to book ${matchedPlace.name}. Please enter your details (name, email, travel date, number of people) in the booking form.`,
                    action: 'START_BOOKING',
                    destination: matchedPlace
                });
            } else {
                return res.json({ reply: 'Which place would you like to book? Please provide the name of the destination.' });
            }
        }

        // SMART FALLBACK: Try database search before giving up
        const words = text.split(/\s+/).filter(w => w.length > 2);
        let fuzzyResults = [];
        
        // If category is found, prioritize it in search
        if (category) {
            const categoryMatches = await Destination.find({ category: category });
            fuzzyResults.push(...categoryMatches);
        }

        for (const word of words) {
            const found = await Destination.find({ 
                $or: [
                    { name: { $regex: word, $options: 'i' } },
                    { location: { $regex: word, $options: 'i' } }
                ]
            });
            fuzzyResults.push(...found);
        }
        
        // Deduplicate by name and pick the BEST entry (with real images)
        const groupedResults = {};
        for (const p of fuzzyResults) {
            const key = p.name.toLowerCase();
            if (!groupedResults[key]) groupedResults[key] = [];
            groupedResults[key].push(p);
        }
        
        fuzzyResults = [];
        for (const [key, entries] of Object.entries(groupedResults)) {
            // Pick the best match: prefer entries with image_gallery (seeded data)
            const bestMatch = entries.find(d => d.image_gallery && d.image_gallery.length > 0) || entries.find(d => d.imageUrl && !d.imageUrl.includes('placehold.co')) || entries[0];
            fuzzyResults.push(bestMatch);
        }

        if (fuzzyResults.length > 0) {
            // Convert DB results to travel_cards so they render with REAL images
            const travelCards = fuzzyResults.map(p => ({
                place_name: p.name,
                location: p.location,
                category: p.category,
                rating: p.rating ? String(p.rating) : "4.5",
                reviews: "Popular",
                description: p.description,
                image_url: p.imageUrl,
                image_gallery: p.image_gallery && p.image_gallery.length > 0 ? p.image_gallery : [p.imageUrl],
                map_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`,
                best_time: p.best_time || "Year-round",
                entry_fee: "Varies",
                tags: [p.category],
                weather: p.weather || { temperature: "25-30°C", condition: "Pleasant" },
                budgets: p.budgets || {},
                hotels: p.hotels || [],
                foods: p.foods || [],
                nearby_attractions: p.nearby_attractions || [],
                itinerary: p.itinerary_3_day || [],
                transport_options: p.transport_options || [],
                packing_list: [],
                _id: p._id
            }));

            // Double check for any bad images in DB and overwrite them with real images
            for (let i = 0; i < travelCards.length; i++) {
                if (!travelCards[i].image_url || travelCards[i].image_url.includes('placehold.co') || travelCards[i].image_url.includes('loremflickr')) {
                    const topAttractions = travelCards[i].top_attractions || travelCards[i].nearby_attractions || [];
                    const realImage = await resolveDestinationImage(travelCards[i].place_name, topAttractions);
                    travelCards[i].image_url = realImage.image_url;
                    travelCards[i].image_gallery = realImage.image_gallery;
                }
            }

            let replyText = `Here are the destinations matching "${message}":`;
            return res.json({ 
                reply: replyText, 
                action: 'RECOMMENDATION',
                travel_cards: travelCards 
            });
        }

        // For truly unknown locations — return a card WITHOUT saving to DB
        const locName = message.trim();
        const formattedName = locName.charAt(0).toUpperCase() + locName.slice(1);

        // Fetch real image using imageService
        const realImage = await resolveDestinationImage(formattedName);
        let fallbackImageUrl = realImage.image_url;

        const mockCard = {
            place_name: formattedName,
            location: formattedName + ", India",
            category: "cultural",
            rating: "4.5",
            reviews: "New",
            description: `Explore the amazing destination of ${formattedName}. Ask me for more details or try another location!`,
            image_url: fallbackImageUrl,
            image_gallery: [fallbackImageUrl],
            map_url: `https://maps.google.com/?q=${encodeURIComponent(locName)}`,
            best_time: "Year round",
            entry_fee: "Varies",
            tags: ["Explore", "Travel"],
            weather: {
                temperature: "25°C",
                condition: "Pleasant"
            },
            budgets: {
                "5_days": "₹15000"
            }
        };

        return res.json({ 
            reply: `Here's what I found for ${formattedName}! Check out this overview:`,
            action: 'RECOMMENDATION',
            travel_cards: [mockCard]
        });

    } catch (err) {
        res.status(500).json({ reply: 'Oops! Something went wrong on my end.' });
    }
});

// GET /api/chat/history - Retrieve user's persisted chat history
const auth = require('../middleware/auth');
const User = require('../models/User');

router.get('/history', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        res.json({ chatHistory: user.chatHistory || [] });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// POST /api/chat/history - Save user's updated chat history
router.post('/history', auth, async (req, res) => {
    try {
        const { chatHistory } = req.body;
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        
        user.chatHistory = chatHistory || [];
        await user.save();
        res.json({ msg: 'Chat history updated successfully', chatHistory: user.chatHistory });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// Saved Chats endpoints
const Chat = require('../models/Chat');
const Message = require('../models/Message');

router.post('/new', auth, async (req, res) => {
    try {
        const newChat = new Chat({
            userId: req.user.id,
            title: 'New Conversation'
        });
        await newChat.save();
        res.json(newChat);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

router.get('/history/:userId', auth, async (req, res) => {
    try {
        const chats = await Chat.find({ userId: req.params.userId, isDeleted: { $ne: true } }).sort({ updatedAt: -1 });
        res.json(chats);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

router.get('/:chatId', auth, async (req, res) => {
    try {
        const chat = await Chat.findOne({ _id: req.params.chatId, isDeleted: { $ne: true } });
        if (!chat) return res.status(404).json({ msg: 'Chat not found' });
        const messages = await Message.find({ chatId: req.params.chatId }).sort({ timestamp: 1 });
        res.json({ chat, messages });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

router.post('/message', auth, async (req, res) => {
    try {
        const { chatId, sender, message, data, options, step } = req.body;
        
        let chat = await Chat.findById(chatId);
        if (!chat) return res.status(404).json({ msg: 'Chat not found' });

        const newMessage = new Message({
            chatId,
            sender,
            message,
            data: data || [],
            options: options || [],
            step: step || ''
        });
        await newMessage.save();

        if (sender === 'user' && chat.title === 'New Conversation') {
            const words = message.split(' ');
            let title = words.slice(0, 4).join(' ');
            if (words.length > 4) title += '...';
            chat.title = title;
        }

        chat.updatedAt = new Date();
        await chat.save();

        res.json(newMessage);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

router.put('/rename/:chatId', auth, async (req, res) => {
    try {
        const { title } = req.body;
        const chat = await Chat.findById(req.params.chatId);
        if (!chat) return res.status(404).json({ msg: 'Chat not found' });
        
        chat.title = title;
        await chat.save();
        res.json(chat);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

router.delete('/:chatId', auth, async (req, res) => {
    try {
        const chat = await Chat.findById(req.params.chatId);
        if (!chat) return res.status(404).json({ msg: 'Chat not found' });

        chat.isDeleted = true;
        await chat.save();
        res.json({ msg: 'Chat deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
