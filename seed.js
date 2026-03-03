// Seed script - add sample leads for testing
const db = require('./src/database');

const samples = [
    {
        platform: 'facebook',
        post_url: 'https://facebook.com/groups/podseller/posts/001',
        author_name: 'Nguyen Van A',
        author_url: 'https://facebook.com/nguyenvana',
        content: 'Mình đang tìm đơn vị print on demand để in áo thun bán trên TikTok Shop US. Ai có kinh nghiệm chia sẻ giúp mình với! Mình đã thử vài chỗ nhưng tracking không cập nhật, bị TikTok phạt hoài.',
        score: 85,
        category: 'POD',
        summary: 'Seller cần tìm dịch vụ POD để in áo thun bán trên TikTok Shop US, gặp vấn đề tracking',
        urgency: 'high',
        suggested_response: 'Chào bạn! Mình thấy bạn đang tìm dịch vụ POD cho TikTok Shop US. THG có xưởng in riêng tại VN, CN và Mỹ, chuyên phục vụ seller TikTok/Amazon. Tracking đáp ứng policy TikTok. Inbox mình để trao đổi thêm nhé!',
        scraped_at: new Date().toISOString(),
    },
    {
        platform: 'instagram',
        post_url: 'https://instagram.com/p/sample002',
        author_name: 'seller_jane',
        author_url: 'https://instagram.com/seller_jane',
        content: 'Looking for a reliable fulfillment partner to ship products from China to the US. Currently spending too much on DHL. Any recommendations?',
        score: 78,
        category: 'Express',
        summary: 'Seller đang tìm giải pháp vận chuyển CN-Mỹ thay DHL vì chi phí cao',
        urgency: 'medium',
        suggested_response: 'Hi! We are THG - we have our own shipping routes from CN to US at rates much lower than DHL/FedEx. Full tracking included (TikTok/Amazon compliant). DM us for a quote!',
        scraped_at: new Date().toISOString(),
    },
    {
        platform: 'facebook',
        post_url: 'https://facebook.com/groups/dropship/posts/003',
        author_name: 'Dropship VN',
        author_url: '',
        content: 'Có bạn nào biết dịch vụ mua hộ từ Taobao rồi ship sang Mỹ không? Mình muốn dropship mà không biết bắt đầu từ đâu. Cần tư vấn từ A-Z luôn.',
        score: 92,
        category: 'Dropship',
        summary: 'Seller mới muốn dropship từ Taobao sang Mỹ, cần dịch vụ mua hộ và vận chuyển, cần tư vấn toàn diện',
        urgency: 'high',
        suggested_response: 'Chào bạn! THG có dịch vụ dropship từ Taobao/1688 sang Mỹ - bạn chỉ cần gửi link sản phẩm, mình lo từ mua hàng, đóng gói đến ship. Có kho tại CN xử lý nhanh. Inbox mình để biết thêm chi tiết nhé!',
        scraped_at: new Date().toISOString(),
    },
    {
        platform: 'facebook',
        post_url: 'https://facebook.com/groups/amazonseller/posts/004',
        author_name: 'Mike Tran',
        author_url: 'https://facebook.com/miketran',
        content: 'I need a warehouse in the US to store my products. Currently shipping from Vietnam and it takes 10-15 days. My Amazon listings are suffering because of slow delivery. Looking for alternatives to FBA.',
        score: 88,
        category: 'Warehouse',
        summary: 'Amazon seller cần kho ở Mỹ để cạnh tranh tốc độ giao hàng, đang ship từ VN mất 10-15 ngày',
        urgency: 'high',
        suggested_response: 'Hi Mike! THG has fulfillment warehouses in Pennsylvania and North Carolina. You can pre-stock your products and we ship domestically in 2-5 days. Great alternative to FBA with lower costs. DM us for details!',
        scraped_at: new Date().toISOString(),
    },
    {
        platform: 'instagram',
        post_url: 'https://instagram.com/p/sample005',
        author_name: 'ecom_master_vn',
        author_url: 'https://instagram.com/ecom_master_vn',
        content: 'Ai có kinh nghiệm fulfillment cho TikTok Shop US không? Mình cần đơn vị xử lý từ sản xuất đến giao hàng tận nơi cho khách Mỹ. Budget không quá cao nhưng cần tracking rõ ràng.',
        score: 72,
        category: 'Fulfillment',
        summary: 'Seller TikTok Shop cần dịch vụ fulfillment end-to-end với tracking, budget hạn chế',
        urgency: 'medium',
        suggested_response: 'Chào bạn! THG chuyên fulfillment cho seller TikTok Shop US. Mình có hệ thống tracking real-time đáp ứng policy TikTok, giá cạnh tranh. Từ in ấn/mua hàng đến ship tận tay khách. Inbox mình nhé!',
        scraped_at: new Date().toISOString(),
    },
];

for (const lead of samples) {
    try {
        db.insertLead.run(lead);
        console.log(`✅ Inserted: ${lead.author_name} (${lead.category}, score: ${lead.score})`);
    } catch (e) {
        console.log(`⚠️ Skipped (duplicate): ${lead.author_name}`);
    }
}

const stats = db.getStats();
console.log('\n📊 Stats:', JSON.stringify(stats, null, 2));
console.log('\nDone!');
process.exit(0);
