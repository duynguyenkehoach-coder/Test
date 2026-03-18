/**
 * aiProvider.js — Shared AI Provider Cascade
 * 
 * Priority: Cerebras → Sambanova → Groq (NO Gemini — key suspended)
 * All AI modules import from here instead of creating their own clients.
 */

'use strict';

const OpenAI = require('openai');
const Groq = require('groq-sdk');
const config = require('../config');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// Initialize providers (only if API key exists)
// ═══════════════════════════════════════════════════════

// Provider 1: Cerebras (PRIMARY — fastest inference, free 30 RPM)
let cerebras = null;
if (config.CEREBRAS_API_KEY) {
    cerebras = new OpenAI({
        apiKey: config.CEREBRAS_API_KEY,
        baseURL: 'https://api.cerebras.ai/v1',
    });
    console.log('[AIProvider] ✅ Cerebras loaded (primary — llama3.1-8b)');
}

// Provider 2: Sambanova (FALLBACK — free 30 RPM, 6000 RPD)
let sambanova = null;
if (config.SAMBANOVA_API_KEY) {
    sambanova = new OpenAI({
        apiKey: config.SAMBANOVA_API_KEY,
        baseURL: 'https://api.sambanova.ai/v1',
    });
    console.log('[AIProvider] ✅ Sambanova loaded (fallback — Meta-Llama-3.3-70B-Instruct)');
}

// Provider 3: Groq (BACKUP)
let groq = null;
if (config.GROQ_API_KEY) {
    groq = new Groq({ apiKey: config.GROQ_API_KEY });
    console.log('[AIProvider] ✅ Groq loaded (backup — llama-3.1-8b-instant)');
}

// ❌ Gemini REMOVED — API key permanently suspended by Google

// Provider list for cascade (ordered by priority)
const PROVIDERS = [
    { name: 'Cerebras', client: cerebras, model: 'llama3.1-8b', type: 'openai' },
    { name: 'Sambanova', client: sambanova, model: 'Meta-Llama-3.3-70B-Instruct', type: 'openai' },
    { name: 'Groq', client: groq, model: 'llama-3.1-8b-instant', type: 'groq' },
].filter(p => p.client); // Only include providers with valid API keys

console.log(`[AIProvider] 🔄 Provider chain: ${PROVIDERS.map(p => p.name).join(' → ')} (NO Gemini)`);

/**
 * Generate text using provider cascade: Cerebras → Sambanova → Groq
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User prompt
 * @param {object} options - { maxTokens, temperature, jsonMode }
 * @returns {string|null} Generated text or null if all providers fail
 */
async function generateText(systemPrompt, userPrompt, options = {}) {
    const { maxTokens = 400, temperature = 0.3, jsonMode = false } = options;

    for (let i = 0; i < PROVIDERS.length; i++) {
        const prov = PROVIDERS[i];
        try {
            const params = {
                model: prov.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature,
                max_tokens: maxTokens,
            };
            if (jsonMode && prov.type === 'groq') {
                params.response_format = { type: 'json_object' };
            }
            const response = await prov.client.chat.completions.create(params);
            const text = response.choices[0].message.content;
            if (text) return text;
        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit') || err.message?.includes('Too Many Requests');
            if (isLimit && i < PROVIDERS.length - 1) {
                console.warn(`[AIProvider] ⚠️ ${prov.name} rate-limited → trying ${PROVIDERS[i + 1].name}...`);
                continue;
            }
            console.warn(`[AIProvider] ⚠️ ${prov.name} error: ${err.message?.substring(0, 120)}`);
        }
    }

    // All providers failed
    console.error('[AIProvider] ❌ All providers failed');
    return null;
}

module.exports = {
    cerebras,
    sambanova,
    groq,
    PROVIDERS,
    generateText,
    sleep,
};
