require('dotenv').config();

const sv = require('./src/pipelines/sociaVault');

console.log('=== THG Deep Scout — Full Test Suite ===\n');

let pass = 0, fail = 0;
function check(label, result, expected) {
    const ok = result === expected;
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${label}: ${result} (expected: ${expected})`);
}

// ═══ 1. PERSONA CLASSIFIER ═══
console.log('--- 1. PersonaClassifier ---');
check('Provider ad', sv.isRealCustomer('Bên em chuyên vận chuyển hàng đi Mỹ, giá rẻ nhất. Zalo em 099'), false);
check('Buyer post', sv.isRealCustomer('Cần tìm bên nào ship hàng TQ đi Mỹ giá tốt?'), true);
check('Emoji spam', sv.isRealCustomer('🚀🔥💰✅🌟🎉 Dịch vụ ship hàng siêu nhanh'), false);

// ═══ 2. COMMENT SCOUT ═══
console.log('\n--- 2. Comment Scout ---');
check('Sale comment', sv.isRealCustomerComment('Check inbox mình nhé bạn!'), false);
check('Buyer comment', sv.isRealCustomerComment('Giá đi Mỹ bao nhiêu bạn?'), true);
check('Phone comment', sv.isRealCustomerComment('Bên mình nhận, gọi 0909123456'), false);

// ═══ 3. SENTIMENT ANALYSIS ═══
console.log('\n--- 3. Sentiment Analysis ---');
const s1 = sv.analyzeSentiment('Giao hàng chậm quá, tắc biên 3 tuần rồi, bực ghê');
check('Frustrated (3 signals)', s1.sentiment, 'FRUSTRATED');
check('Frustration count', s1.frustrationCount, 3);

const s2 = sv.analyzeSentiment('Mình cần gửi 50kg hàng đi Mỹ, báo giá giúp');
check('Normal inquiry', s2.sentiment, 'INQUIRY');

const s3 = sv.analyzeSentiment('Cần gấp dịch vụ ship hàng, deadline ngày mai');
check('Urgent', s3.sentiment, 'URGENT');
check('Urgent flag', s3.urgent, true);

const s4 = sv.analyzeSentiment('Đơn vị cũ giao chậm lắm, hàng bị hư hỏng');
check('Frustrated (old vendor)', s4.sentiment, 'FRUSTRATED');

// ═══ 4. SERVICE CLASSIFICATION ═══
console.log('\n--- 4. Service Classification ---');
const svc1 = sv.parseServiceType('Cần tìm kho fulfillment ở Mỹ');
check('Service = FULFILLMENT', svc1.service, 'FULFILLMENT');
check('Destination = USA', svc1.destination, 'USA');

const svc2 = sv.parseServiceType('Cần ship to amazon FBA prep');
check('Service = FBA_PREP', svc2.service, 'FBA_PREP');

const svc3 = sv.parseServiceType('Có ai nhận hàng đường biển LCL đi châu Âu?');
check('Service = SEA_FREIGHT', svc3.service, 'SEA_FREIGHT');
check('Destination = EU', svc3.destination, 'EU');

const svc4 = sv.parseServiceType('Order taobao về VN giá rẻ');
check('Wrong-route = null', svc4, null);

// ═══ 5. DEEP SCOUT ENRICHMENT ═══
console.log('\n--- 5. Deep Scout Enrichment ---');

const item1 = sv.deepScoutEnrich({
    content: 'Đơn vị cũ giao chậm, mất hàng luôn. Cần gấp kho fulfillment ở Mỹ. Ai tư vấn giúp?',
    platform: 'facebook',
});
console.log('  Golden Lead:');
check('  Persona = buyer', item1.persona, 'buyer');
check('  Sentiment = FRUSTRATED', item1.sentiment, 'FRUSTRATED');
check('  Service = FULFILLMENT', item1.service_needed, 'FULFILLMENT');
check('  Destination = USA', item1.destination, 'USA');
check('  Urgency = critical', item1.urgency, 'critical');
console.log(`  \x1b[33m📊 Urgency Score: ${item1.urgency_score}/10\x1b[0m`);
console.log(`  \x1b[31m🔥 Pain Point: "${item1.pain_point.substring(0, 80)}..."\x1b[0m`);

const item2 = sv.deepScoutEnrich({
    content: 'Mình cần gửi 50kg hàng đi Mỹ, ai báo giá giúp?',
    platform: 'facebook',
});
console.log('\n  Normal Inquiry:');
check('  Persona = buyer', item2.persona, 'buyer');
check('  Sentiment = INQUIRY', item2.sentiment, 'INQUIRY');
check('  Urgency = medium or high', ['medium', 'high'].includes(item2.urgency), true);
console.log(`  📊 Urgency Score: ${item2.urgency_score}/10`);

const item3 = sv.deepScoutEnrich({
    content: 'Bên em chuyên vận chuyển hàng đi Mỹ, cam kết giá rẻ nhất. Liên hệ zalo em!',
    platform: 'facebook',
});
console.log('\n  Provider Ad:');
check('  Persona = provider', item3.persona, 'provider');
console.log(`  📊 Urgency Score: ${item3.urgency_score}/10`);

// ═══ SUMMARY ═══
console.log(`\n${'═'.repeat(50)}`);
console.log(`✅ Pass: ${pass} | ❌ Fail: ${fail} | Total: ${pass + fail}`);
console.log(`Accuracy: ${((pass / (pass + fail)) * 100).toFixed(1)}%`);
console.log(`${'═'.repeat(50)}`);

process.exit(fail > 0 ? 1 : 0);
