/**
 * THG Agent — Knowledge Base with Semantic Search
 * 
 * Loads company knowledge from markdown files and provides
 * relevant context for AI classification via keyword matching.
 * 
 * No external embeddings needed — uses fast keyword/TF-IDF matching.
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

// Knowledge chunks: {id, source, title, content, keywords[]}
let knowledgeChunks = [];

/**
 * Load all knowledge files and split into searchable chunks
 */
function loadKnowledge() {
    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
    knowledgeChunks = [];

    for (const file of files) {
        const filePath = path.join(KNOWLEDGE_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const source = file.replace('.md', '');

        // Split by ## headers into chunks
        const sections = content.split(/^## /m).filter(Boolean);
        for (const section of sections) {
            const lines = section.trim().split('\n');
            const title = lines[0].replace(/^#+\s*/, '').trim();
            const body = lines.slice(1).join('\n').trim();

            if (body.length < 20) continue;

            // Extract keywords from content
            const keywords = extractKeywords(title + ' ' + body);

            knowledgeChunks.push({
                id: `${source}:${title}`.substring(0, 80),
                source,
                title,
                content: body.substring(0, 800), // Limit chunk size
                keywords,
            });
        }
    }

    console.log(`[KnowledgeBase] ✅ Loaded ${knowledgeChunks.length} chunks from ${files.length} files`);
    return knowledgeChunks;
}

/**
 * Extract keywords from text (Vietnamese + English)
 */
function extractKeywords(text) {
    const lower = text.toLowerCase();
    // Important domain terms
    const domainTerms = [
        'pod', 'print on demand', 'fulfillment', 'fulfill', 'express', 'warehouse', '3pl',
        'dropship', 'dropshipping', 'ship', 'shipping', 'vận chuyển', 'kho',
        't-shirt', 'mug', 'tumbler', 'canvas', 'hoodie', 'phone case', 'poster', 'sticker',
        'basecost', 'giá', 'pricing', 'chi phí', 'phí ẩn', 'miễn phí', 'lưu kho',
        'printify', 'printful', 'weshop', 'supership', 'boxme',
        'tiktok', 'etsy', 'amazon', 'shopify', 'ebay', 'fba', 'fbm',
        'us', 'mỹ', 'uk', 'úc', 'uae', 'saudi', 'chile', 'colombia', 'nội địa',
        'buyer', 'seller', 'provider', 'đối thủ', 'cạnh tranh',
        'tìm', 'cần', 'hỏi', 'so sánh', 'recommend', 'review',
        'tracking', 'delay', 'stuck', 'chậm', 'nhanh', 'hủy đơn', 'mất review',
        'e-packet', 'air cargo',
        'xưởng', 'in ấn', 'đóng gói', 'pick up', 'video',
        'kho pa', 'kho tx', 'pennsylvania', 'texas',
        'oms', 'wms', 'tồn kho', 'quản lý', 'real-time',
        'nỗi đau', 'vấn đề', 'thủ công', 'sai sót', 'khó kiểm soát',
    ];

    return domainTerms.filter(term => lower.includes(term));
}

/**
 * Find relevant knowledge chunks for a given post content
 * Returns top N chunks sorted by relevance
 */
function findRelevantContext(postContent, topN = 3) {
    if (knowledgeChunks.length === 0) loadKnowledge();

    const postKeywords = extractKeywords(postContent);
    if (postKeywords.length === 0) return [];

    // Score each chunk by keyword overlap
    const scored = knowledgeChunks.map(chunk => {
        const overlap = chunk.keywords.filter(k => postKeywords.includes(k));
        return {
            ...chunk,
            score: overlap.length,
            matchedKeywords: overlap,
        };
    }).filter(c => c.score > 0);

    // Sort by score desc, take top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN);
}

/**
 * Get formatted context string for prompt injection
 */
function getContextForPrompt(postContent) {
    const relevant = findRelevantContext(postContent, 3);
    if (relevant.length === 0) return '';

    const contextParts = relevant.map(chunk =>
        `[${chunk.source.toUpperCase()}: ${chunk.title}]\n${chunk.content.substring(0, 400)}`
    );

    return `\n📚 KIẾN THỨC THG LIÊN QUAN:\n${contextParts.join('\n\n')}`;
}

// Load on startup
try { loadKnowledge(); } catch (e) { console.warn('[KnowledgeBase] ⚠️ Failed to load:', e.message); }

module.exports = {
    loadKnowledge,
    findRelevantContext,
    getContextForPrompt,
    getChunkCount: () => knowledgeChunks.length,
};
