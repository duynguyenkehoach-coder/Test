/**
 * THG Lead Qualifier v5 — Agent-Powered Classification
 * 
 * Uses dynamic prompts from Agent:
 * - Knowledge Base: relevant company context per post
 * - Memory Store: past classifications + feedback
 * - Prompt Builder: assembles context-aware prompts
 */

const Groq = require('groq-sdk');
const config = require('../config');
const { buildSystemPrompt, buildUserPrompt, buildBatchPrompt } = require('../agent/promptBuilder');
const { saveClassification } = require('../agent/memoryStore');

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

let geminiModel = null;
try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    if (config.GEMINI_API_KEY) {
        const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
        geminiModel = genAI.getGenerativeModel({ model: config.GEMINI_MODEL || 'gemini-2.0-flash' });
        console.log('[Classifier] ✅ Gemini AI fallback loaded');
    }
} catch (e) { }

const AI_MODELS = [
    config.AI_MODEL || 'llama-3.3-70b-versatile',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.1-8b-instant',
    'qwen-qwq-32b',
];

const PROVIDER_REGEX = /(chúng tôi nhận gửi|quy trình gửi hàng|lợi ích khi gửi hàng với chúng tôi|nhận gửi hàng đi|chuyên tuyến việt|cước phí cạnh tranh|cam kết giao tận tay|hỗ trợ tư vấn, chăm sóc khách hàng 24\/7|we offer fulfillment|shipping services from us|dịch vụ vận chuyển uy tín|không phát sinh chi phí|bao thuế bao luật|nhận pick up|đóng gói miễn phí|hút chân không|lh em ngay|lh em|liên hệ em|ib em ngay|ib em|inbox em|cmt em|chấm em|check ib|check inbox|dạ em nhận|em chuyên nhận|gửi hàng đi mỹ inbox|nhận vận chuyển|zalo: 0)/i;
const IRRELEVANT_REGEX = /(recipe|cooking|football|soccer|gaming|movie|trailer|music video|crypto airdrop|token launch|weight loss|diet pill)/i;

let currentModelIndex = 0;
let consecutiveErrors = 0;

// ═══════════════════════════════════════════════════════
// Parse + enforce scoring rules
// ═══════════════════════════════════════════════════════
function parseResult(result) {
    const role = result.author_role || 'unknown';
    const isProvider = role === 'logistics_agency' || role === 'spammer';
    const isPotential = result.is_potential === true && !isProvider;

    let score = Math.min(100, Math.max(0, result.score || 0));

    if (isPotential && score < 60) {
        console.warn(`[Classifier] ⚠️ Model trả score ${score} cho buyer — tự động bump lên 60`);
        score = 60;
    }
    if (!isPotential) score = 0;

    return {
        isLead: isPotential,
        role: isPotential ? 'buyer' : (isProvider ? 'provider' : 'irrelevant'),
        score,
        category: result.service_match === 'None' ? 'NotRelevant' : (result.service_match || 'General'),
        summary: result.reasoning || '',
        urgency: isPotential ? (result.urgency || 'low') : 'low',
        buyerSignals: isPotential ? (result.reasoning || '') : '',
    };
}

// ═══════════════════════════════════════════════════════
// Batch classification with dynamic prompts
// ═══════════════════════════════════════════════════════
async function classifyBatch(posts) {
    // Build dynamic system prompt using the first post's content for KB context
    const combinedContent = posts.map(p => p.content || '').join(' ');
    const dynamicSystemPrompt = buildSystemPrompt(combinedContent);
    const batchUserPrompt = buildBatchPrompt(posts);

    for (let i = currentModelIndex; i < AI_MODELS.length; i++) {
        try {
            const model = AI_MODELS[i];
            const response = await groq.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: dynamicSystemPrompt },
                    { role: 'user', content: batchUserPrompt },
                ],
                temperature: 0.1,
                max_tokens: 500 * posts.length,
            });

            const text = response.choices[0].message.content;

            let arr;
            try {
                const parsed = JSON.parse(text);
                arr = parsed.results || parsed.items || parsed.data;
                if (!Array.isArray(arr)) {
                    arr = Object.values(parsed).find(v => Array.isArray(v));
                }
            } catch (e) {
                const match = text.match(/\[[\s\S]*\]/);
                if (match) arr = JSON.parse(match[0]);
            }

            if (!Array.isArray(arr) || arr.length === 0) {
                throw new Error('No valid array in response');
            }

            consecutiveErrors = 0;
            if (i !== currentModelIndex) {
                currentModelIndex = i;
                console.log(`[Classifier] 🔄 Switched to model: ${model}`);
            }

            return arr.map(result => parseResult(result));

        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
            if (isLimit && i < AI_MODELS.length - 1) {
                console.warn(`[Classifier] ⚠️ ${AI_MODELS[i]} hết limit → thử ${AI_MODELS[i + 1]}...`);
                continue;
            }
            if (isLimit) {
                consecutiveErrors++;
                const geminiResults = await classifyBatchWithGemini(posts);
                if (geminiResults) return geminiResults;
            }
            console.warn(`[Classifier] ⚠️ Batch failed (${err.message}), falling back to individual`);
            const individual = [];
            for (const post of posts) {
                individual.push(await classifyPost(post));
            }
            return individual;
        }
    }
    return posts.map(() => makeFallback());
}

// ═══════════════════════════════════════════════════════
// Single post classification with dynamic prompts
// ═══════════════════════════════════════════════════════
async function classifyPost(post) {
    if (PROVIDER_REGEX.test(post.content)) {
        return { isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Provider regex match', urgency: 'low', buyerSignals: '' };
    }

    // Dynamic prompt with KB context for this specific post
    const dynamicSystemPrompt = buildSystemPrompt(post.content);
    const userPrompt = buildUserPrompt(post);

    for (let i = currentModelIndex; i < AI_MODELS.length; i++) {
        try {
            const model = AI_MODELS[i];
            const response = await groq.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: dynamicSystemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.1,
                max_tokens: 400,
                response_format: { type: 'json_object' },
            });

            const result = JSON.parse(response.choices[0].message.content);
            consecutiveErrors = 0;
            if (i !== currentModelIndex) {
                currentModelIndex = i;
                console.log(`[Classifier] 🔄 Switched to model: ${model}`);
            }
            return parseResult(result);

        } catch (err) {
            const isLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
            if (isLimit && i < AI_MODELS.length - 1) {
                console.warn(`[Classifier] ⚠️ ${AI_MODELS[i]} hết limit → thử ${AI_MODELS[i + 1]}...`);
                continue;
            }
            if (isLimit) {
                consecutiveErrors++;
                if (consecutiveErrors >= 5) return makeFallback();
                const waitSec = Math.min(30, 5 * consecutiveErrors);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                i = 0;
                continue;
            }
            console.error('[Classifier] ✗ Error:', err.message);
            const geminiResult = await classifyWithGemini(post);
            return geminiResult || makeFallback();
        }
    }
    const geminiResult = await classifyWithGemini(post);
    return geminiResult || makeFallback();
}

// ═══════════════════════════════════════════════════════
// Gemini fallbacks (also use dynamic prompts)
// ═══════════════════════════════════════════════════════
async function classifyBatchWithGemini(posts) {
    if (!geminiModel) return null;
    try {
        const combinedContent = posts.map(p => p.content || '').join(' ');
        const dynamicPrompt = buildSystemPrompt(combinedContent);
        const postsList = posts.map((p, i) =>
            `[POST ${i + 1}] Platform: ${p.platform}\nContent: ${(p.content || '').substring(0, 600)}`
        ).join('\n\n');
        const prompt = dynamicPrompt + `\n\nPhân tích ${posts.length} bài. Trả về {"results": [...]}:\n\n${postsList}`;
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const parsed = JSON.parse(jsonMatch[0]);
        const arr = parsed.results || Object.values(parsed).find(v => Array.isArray(v));
        if (!Array.isArray(arr)) return null;
        return arr.map(r => parseResult(r));
    } catch (err) {
        console.error('[Classifier] ❌ Gemini batch failed:', err.message);
        return null;
    }
}

async function classifyWithGemini(post) {
    if (!geminiModel) return null;
    try {
        const dynamicPrompt = buildSystemPrompt(post.content);
        const userPrompt = buildUserPrompt(post);
        const prompt = dynamicPrompt + '\n\n' + userPrompt;
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        return parseResult(JSON.parse(jsonMatch[0]));
    } catch (err) {
        console.error('[Classifier] ❌ Gemini failed:', err.message);
        return null;
    }
}

function makeFallback() {
    return { isLead: false, score: 0, category: 'NotRelevant', summary: 'Lỗi phân tích', urgency: 'low' };
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// Main classify pipeline with memory integration
// ═══════════════════════════════════════════════════════
async function classifyPosts(posts) {
    console.log(`[Classifier] 🧠 Classifying ${posts.length} posts (Agent-powered)...`);
    console.log(`[Classifier] 🔄 Models: ${AI_MODELS.join(' → ')}`);

    const toClassify = [];
    const preFiltered = [];

    for (const post of posts) {
        const content = post.content || '';
        if (content.length < 10) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Nội dung quá ngắn' });
            continue;
        }
        if (PROVIDER_REGEX.test(content)) {
            preFiltered.push({ ...post, isLead: false, role: 'provider', score: 0, category: 'NotRelevant', summary: 'Provider regex', urgency: 'low', buyerSignals: '' });
            continue;
        }
        if (IRRELEVANT_REGEX.test(content)) {
            preFiltered.push({ ...post, ...makeFallback(), summary: 'Không liên quan' });
            continue;
        }
        toClassify.push(post);
    }

    console.log(`[Classifier] 🔍 Pre-filter: ${preFiltered.length} posts skipped locally, ${toClassify.length} posts → AI`);

    const BATCH_SIZE = 5;
    const results = [...preFiltered];
    currentModelIndex = 0;
    consecutiveErrors = 0;
    let stopEarly = false;

    for (let i = 0; i < toClassify.length && !stopEarly; i += BATCH_SIZE) {
        const batch = toClassify.slice(i, i + BATCH_SIZE);
        try {
            const batchResults = await classifyBatch(batch);
            if (consecutiveErrors >= 5) stopEarly = true;
            for (let j = 0; j < batch.length; j++) {
                const merged = { ...batch[j], ...(batchResults[j] || makeFallback()) };
                results.push(merged);

                // Save to Agent Memory
                try { saveClassification(batch[j], batchResults[j] || makeFallback()); } catch (e) { }
            }
        } catch (err) {
            for (const post of batch) results.push({ ...post, ...makeFallback() });
        }

        const done = Math.min(i + BATCH_SIZE, toClassify.length);
        console.log(`[Classifier]   → ${done}/${toClassify.length} classified (batch ${Math.ceil(done / BATCH_SIZE)}/${Math.ceil(toClassify.length / BATCH_SIZE)}, model: ${AI_MODELS[currentModelIndex]})`);

        if (i + BATCH_SIZE < toClassify.length && !stopEarly) await delay(1000);
    }

    if (stopEarly) {
        const classifiedCount = results.length - preFiltered.length;
        for (const post of toClassify.slice(classifiedCount)) {
            results.push({ ...post, ...makeFallback() });
        }
    }

    const leads = results.filter(r => r.isLead && r.score >= config.LEAD_SCORE_THRESHOLD);
    console.log(`[Classifier] ✅ Done! ${leads.length} qualified leads (score ≥ ${config.LEAD_SCORE_THRESHOLD}) out of ${posts.length} total posts`);
    console.log(`[Classifier]    📊 Breakdown: ${preFiltered.length} pre-filtered, ${toClassify.length} sent to AI`);

    const buyerPosts = results.filter(r => r.role === 'buyer');
    if (buyerPosts.length > 0) {
        console.log(`[Classifier] 🎯 Buyer posts found: ${buyerPosts.length}`);
        buyerPosts.forEach(p => {
            const tag = p.score >= config.LEAD_SCORE_THRESHOLD ? '✅' : '⚠️';
            console.log(`[Classifier]   ${tag} Score ${p.score} | ${(p.content || '').substring(0, 80)}`);
        });
    }

    return results;
}

module.exports = { classifyPost, classifyPosts };
