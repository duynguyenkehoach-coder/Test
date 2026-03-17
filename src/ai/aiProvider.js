/**
 * aiProvider.js — Shared AI Provider Cascade
 * 
 * Priority: Cerebras → Sambanova → Groq → Gemini
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
    console.log('[AIProvider] ✅ Cerebras loaded (primary)');
}

// Provider 2: Sambanova (FALLBACK — free 30 RPM, 6000 RPD)
let sambanova = null;
if (config.SAMBANOVA_API_KEY) {
    sambanova = new OpenAI({
        apiKey: config.SAMBANOVA_API_KEY,
        baseURL: 'https://api.sambanova.ai/v1',
    });
    console.log('[AIProvider] ✅ Sambanova loaded (fallback)');
}

// Provider 3: Groq (BACKUP)
let groq = null;
if (config.GROQ_API_KEY) {
    groq = new Groq({ apiKey: config.GROQ_API_KEY });
    console.log('[AIProvider] ✅ Groq loaded (backup)');
}

// Provider 4: Gemini (LAST RESORT)
let geminiModel = null;
try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (config.GEMINI_API_KEY) {
        const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL || 'gemini-2.0-flash' });
        console.log('[AIProvider] ✅ Gemini loaded (last resort)');
    }
} catch (e) { }

// Rate limiter for Gemini (free tier: 15 RPM)
let lastGeminiCall = 0;
const GEMINI_MIN_INTERVAL_MS = 4200;
async function geminiThrottle() {
    const elapsed = Date.now() - lastGeminiCall;
    if (elapsed < GEMINI_MIN_INTERVAL_MS) await sleep(GEMINI_MIN_INTERVAL_MS - elapsed);
    lastGeminiCall = Date.now();
}

// Provider list for cascade (ordered by priority)
const PROVIDERS = [
    { name: 'Cerebras', client: cerebras, model: 'llama-3.3-70b', type: 'openai' },
    { name: 'Sambanova', client: sambanova, model: 'Meta-Llama-3.3-70B-Instruct', type: 'openai' },
    { name: 'Groq', client: groq, model: 'llama-3.1-8b-instant', type: 'groq' },
].filter(p => p.client); // Only include providers with valid API keys

console.log(`[AIProvider] 🔄 Provider chain: ${PROVIDERS.map(p => p.name).join(' → ')}${geminiModel ? ' → Gemini' : ''}`);

// ═══════════════════════════════════════════════════════
// Core: Call any OpenAI-compatible provider
// ═══════════════════════════════════════════════════════
async function callProvider(provider, systemPrompt, userPrompt, maxTokens = 400, temperature = 0.1) {
    const params = {
        model: provider.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
    };
    if (provider.type === 'groq') {
        params.response_format = { type: 'json_object' };
    }
    const response = await provider.client.chat.completions.create(params);
    return response.choices[0].message.content;
}

/**
 * Generate text using provider cascade: Cerebras → Sambanova → Groq → Gemini
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User prompt
 * @param {object} options - { maxTokens, temperature, jsonMode }
 * @returns {string} Generated text
 */
async function generateText(systemPrompt, userPrompt, options = {}) {
    const { maxTokens = 400, temperature = 0.3, jsonMode = false } = options;

    // Try OpenAI-compatible providers first
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

    // Gemini last resort
    if (geminiModel) {
        try {
            await geminiThrottle();
            console.log('[AIProvider] 🔄 All providers failed → Gemini');
            const prompt = systemPrompt + '\n\n' + userPrompt;
            const result = await geminiModel.generateContent(prompt);
            const text = result.response.text();
            if (text) return text;
        } catch (e) {
            console.error('[AIProvider] ❌ Gemini failed:', e.message?.substring(0, 120));
        }
    }

    return null;
}

module.exports = {
    // Individual provider clients (for modules that need direct access)
    cerebras,
    sambanova,
    groq,
    geminiModel,
    // Provider list
    PROVIDERS,
    // Helper functions
    callProvider,
    generateText,
    geminiThrottle,
    sleep,
};
