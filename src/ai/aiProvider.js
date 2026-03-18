/**
 * aiProvider.js — Shared AI Provider Cascade
 * 
 * Priority: Ollama (local, NO limit) → Cerebras → Sambanova
 * 
 * ❌ Groq REMOVED — constantly rate limited (429)
 * ❌ Gemini REMOVED — API key permanently suspended
 */

'use strict';

const OpenAI = require('openai');
const config = require('../config');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// Initialize providers (only if available)
// ═══════════════════════════════════════════════════════

// Provider 1: Ollama (PRIMARY — self-hosted, $0, NO rate limit!)
let ollama = null;
const OLLAMA_BASE_URL = config.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = config.OLLAMA_MODEL || 'qwen2.5:3b';
try {
    ollama = new OpenAI({
        apiKey: 'ollama',  // Ollama doesn't need a real key
        baseURL: `${OLLAMA_BASE_URL}/v1`,
    });
    console.log(`[AIProvider] ✅ Ollama loaded (primary — ${OLLAMA_MODEL} @ ${OLLAMA_BASE_URL})`);
} catch (e) {
    console.warn('[AIProvider] ⚠️ Ollama not available:', e.message);
}

// Provider 2: Cerebras (FALLBACK — cloud, free 30 RPM)
let cerebras = null;
if (config.CEREBRAS_API_KEY) {
    cerebras = new OpenAI({
        apiKey: config.CEREBRAS_API_KEY,
        baseURL: 'https://api.cerebras.ai/v1',
    });
    console.log('[AIProvider] ✅ Cerebras loaded (fallback — llama3.1-8b)');
}

// Provider 3: Sambanova (FALLBACK 2 — cloud, free 30 RPM)
let sambanova = null;
if (config.SAMBANOVA_API_KEY) {
    sambanova = new OpenAI({
        apiKey: config.SAMBANOVA_API_KEY,
        baseURL: 'https://api.sambanova.ai/v1',
    });
    console.log('[AIProvider] ✅ Sambanova loaded (fallback 2 — Meta-Llama-3.3-70B-Instruct)');
}

// ❌ Groq REMOVED — constantly rate limited (429)
// ❌ Gemini REMOVED — API key permanently suspended by Google

// Provider list for cascade (ordered by priority)
const PROVIDERS = [
    { name: 'Ollama', client: ollama, model: OLLAMA_MODEL, type: 'openai' },
    { name: 'Cerebras', client: cerebras, model: 'llama3.1-8b', type: 'openai' },
    { name: 'Sambanova', client: sambanova, model: 'Meta-Llama-3.3-70B-Instruct', type: 'openai' },
].filter(p => p.client);

console.log(`[AIProvider] 🔄 Provider chain: ${PROVIDERS.map(p => p.name).join(' → ')}`);

/**
 * Check if Ollama is reachable (ping /api/tags)
 */
async function checkOllamaHealth() {
    try {
        const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const data = await res.json();
            const models = (data.models || []).map(m => m.name);
            console.log(`[AIProvider] 🩺 Ollama healthy — models: ${models.join(', ')}`);
            return true;
        }
    } catch { }
    console.warn('[AIProvider] ⚠️ Ollama not reachable — will use cloud fallbacks');
    return false;
}

/**
 * Generate text using provider cascade: Ollama → Cerebras → Sambanova
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
            // Ollama supports json format natively
            if (jsonMode) {
                params.response_format = { type: 'json_object' };
            }
            const response = await prov.client.chat.completions.create(params);
            const text = response.choices[0].message.content;
            if (text) return text;
        } catch (err) {
            const msg = err.message || '';
            const isLimit = msg.includes('429') || msg.includes('rate_limit') || msg.includes('Too Many Requests');
            const isConnErr = msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed');

            if (isConnErr && prov.name === 'Ollama') {
                console.warn(`[AIProvider] ⚠️ Ollama offline → falling back to ${PROVIDERS[i + 1]?.name || 'none'}...`);
                continue;
            }
            if (isLimit && i < PROVIDERS.length - 1) {
                console.warn(`[AIProvider] ⚠️ ${prov.name} rate-limited → trying ${PROVIDERS[i + 1].name}...`);
                continue;
            }
            console.warn(`[AIProvider] ⚠️ ${prov.name} error: ${msg.substring(0, 150)}`);
        }
    }

    console.error('[AIProvider] ❌ All providers failed');
    return null;
}

module.exports = {
    ollama,
    cerebras,
    sambanova,
    PROVIDERS,
    OLLAMA_BASE_URL,
    OLLAMA_MODEL,
    generateText,
    checkOllamaHealth,
    sleep,
};
