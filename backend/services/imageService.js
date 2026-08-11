/**
 * Destination Image Service
 * Uses verified Unsplash CDN URLs. No Wikimedia API calls (browser hotlinking blocked).
 * Guarantees image_url is ALWAYS non-null.
 */

const imageCache = new Map();
const imageDatabase = require('./imageDatabase');

function sanitizeLocationName(name) {
    if (!name) return 'india';
    let s = name.split('(')[0];
    s = s.split(',')[0].trim().toLowerCase();
    return s;
}

function getCategoryFallback(name, category) {
    const n = (name || '').toLowerCase();
    const c = (category || '').toLowerCase();
    if (n.includes('beach') || n.includes('island') || c.includes('beach') || c.includes('coastal'))
        return imageDatabase['default_beach'];
    if (n.includes('hill') || n.includes('peak') || n.includes('mountain') || n.includes('falls') || n.includes('waterfall') || c.includes('hill') || c.includes('nature') || c.includes('trek'))
        return imageDatabase['default_mountain'];
    if (n.includes('temple') || n.includes('matha') || n.includes('mandir') || n.includes('mosque') || n.includes('church') || n.includes('shrine') || c.includes('temple') || c.includes('religious') || c.includes('spiritual'))
        return imageDatabase['default_temple'];
    if (n.includes('fort') || n.includes('palace') || n.includes('museum') || n.includes('ruins') || c.includes('historical') || c.includes('heritage') || c.includes('monument'))
        return imageDatabase['default_historical'];
    if (n.includes('zoo') || n.includes('wildlife') || n.includes('national park') || n.includes('sanctuary') || c.includes('wildlife'))
        return imageDatabase['default_wildlife'] || imageDatabase['default'];
    if (n.includes('garden') || n.includes('park') || n.includes('lake') || n.includes('dam'))
        return imageDatabase['default_mountain'];
    return imageDatabase['default'];
}

async function resolveDestinationImage(placeName, attractions, category) {
    attractions = attractions || [];
    category = category || '';
    const safeName = sanitizeLocationName(placeName);

    const cacheKey = 'v3_' + safeName;
    if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);

    let heroImage = null;
    const galleryImages = new Set();

    // 1. Exact DB match
    if (imageDatabase[safeName]) {
        heroImage = imageDatabase[safeName];
        galleryImages.add(heroImage);
    }

    // 2. Partial match: place name contains a DB key, or vice-versa
    if (!heroImage) {
        const keys = Object.keys(imageDatabase).filter(k => !k.startsWith('default') && k !== 'default');
        for (const key of keys) {
            if (safeName.includes(key) || key.includes(safeName)) {
                heroImage = imageDatabase[key];
                galleryImages.add(heroImage);
                console.log('[ImageService] Partial match: "' + safeName + '" matched key "' + key + '"');
                break;
            }
        }
    }

    // 3. Attraction-based gallery
    for (const attr of attractions) {
        const safeAttr = sanitizeLocationName(attr);
        if (imageDatabase[safeAttr]) {
            if (!heroImage) heroImage = imageDatabase[safeAttr];
            galleryImages.add(imageDatabase[safeAttr]);
        }
    }

    // 4. Category keyword fallback
    if (!heroImage) {
        heroImage = getCategoryFallback(safeName, category);
        galleryImages.add(heroImage);
        console.log('[ImageService] Category fallback for "' + safeName + '": ' + heroImage);
    }

    // 5. Absolute last resort
    if (!heroImage) {
        heroImage = imageDatabase['default'];
        galleryImages.add(heroImage);
    }

    if (galleryImages.size === 0) galleryImages.add(heroImage);

    console.log('[ImageService] Resolved "' + placeName + '" -> ' + heroImage);

    const result = {
        image_url: heroImage,
        image_gallery: Array.from(galleryImages).slice(0, 6)
    };

    imageCache.set(cacheKey, result);
    return result;
}

module.exports = { resolveDestinationImage, sanitizeLocationName };
