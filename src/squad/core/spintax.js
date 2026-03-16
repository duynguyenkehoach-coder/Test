/**
 * Spintax Engine — Random text variation for anti-spam
 * Resolves {opt1|opt2|opt3} patterns recursively.
 * 
 * @module squad/core/spintax
 */

/**
 * Resolve spintax: {opt1|opt2|opt3} → random pick
 * Supports nested spintax: {hello|{hi|hey}} 
 */
function spinText(template) {
    if (!template) return '';

    let result = template;
    let maxIter = 10; // prevent infinite loops on malformed input

    while (result.includes('{') && maxIter-- > 0) {
        result = result.replace(/\{([^{}]+)\}/g, (_, options) => {
            const choices = options.split('|');
            return choices[Math.floor(Math.random() * choices.length)];
        });
    }

    return result;
}

/**
 * Load a named template from JSON file and spin it
 * @param {string} templateName - Key in the JSON template file
 * @param {object} templates - Pre-loaded template object
 */
function spinTemplate(templateName, templates) {
    const tpl = templates[templateName];
    if (!tpl) {
        console.warn(`[Spintax] ⚠️ Template "${templateName}" not found`);
        return '';
    }

    // If template is an array, pick random one then spin
    if (Array.isArray(tpl)) {
        const picked = tpl[Math.floor(Math.random() * tpl.length)];
        return spinText(picked);
    }

    return spinText(tpl);
}

/**
 * Generate multiple unique spun variations
 * @param {string} template - Spintax template
 * @param {number} count - How many unique variations
 */
function generateVariations(template, count = 5) {
    const variations = new Set();
    let attempts = 0;
    const maxAttempts = count * 10;

    while (variations.size < count && attempts < maxAttempts) {
        variations.add(spinText(template));
        attempts++;
    }

    return [...variations];
}

module.exports = { spinText, spinTemplate, generateVariations };
