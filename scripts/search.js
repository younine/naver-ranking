const https = require('https');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const KEYWORD = process.env.SEARCH_KEYWORD || '모니터';
const TARGET_BRAND = process.env.TARGET_BRAND || '';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 환경변수가 필요합니다.');
  process.exit(1);
}

function naverSearch(query, start = 1, display = 100) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'openapi.naver.com',
      path: `/v1/search/shop.json?query=${encodedQuery}&display=${display}&start=${start}&sort=sim`,
      method: 'GET',
      headers: {
        'X-Naver-Client-Id': CLIENT_ID,
        'X-Naver-Client-Secret': CLIENT_SECRET,
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function extractBrand(item) {
  return item.brand || item.mallName || '';
}

function cleanTitle(title) {
  return title.replace(/<[^>]*>/g, '').trim();
}

async function main() {
  console.log(`키워드: ${KEYWORD}`);
  console.log(`찾을 브랜드: ${TARGET_BRAND || '전체'}`);

  try {
    // 300개 수집 (3페이지)
    let allItems = [];
    for (let start = 1; start <= 201; start += 100) {
      const result = await naverSearch(KEYWORD, start, 100);
      if (!result.items || result.items.length === 0) break;
      allItems = allItems.concat(result.items);
      console.log(`${start}~${start + result.items.length - 1}번째 상품 수집 완료`);
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`총 ${allItems.length}개 상품 수집`);

    // 브랜드별 순위 집계 (전체 상품 저장)
    const brandRanks = {};
    allItems.forEach((item, idx) => {
      const brand = extractBrand(item);
      if (!brand) return;

      if (!brandRanks[brand]) {
        brandRanks[brand] = {
          brand,
          firstRank: idx + 1,
          count: 0,
          products: []
        };
      }
      brandRanks[brand].count++;
      brandRanks[brand].products.push({
        rank: idx + 1,
        title: cleanTitle(item.title),
        price: item.lprice,
        link: item.link,
      });
    });

    // 첫 등장 순위 기준으로 정렬
    const brandList = Object.values(brandRanks)
      .sort((a, b) => a.firstRank - b.firstRank)
      .map((b, idx) => ({ ...b, brandRank: idx + 1 }));

    // 타겟 브랜드 찾기
    let targetResult = null;
    if (TARGET_BRAND) {
      targetResult = brandList.find(b =>
        b.brand.toLowerCase().includes(TARGET_BRAND.toLowerCase())
      );
      if (targetResult) {
        console.log(`\n[${TARGET_BRAND}] 브랜드 순위: ${targetResult.brandRank}위`);
        console.log(`첫 노출 상품 순위: ${targetResult.firstRank}위`);
        console.log(`노출 상품 수: ${targetResult.count}개`);
        console.log('상품 목록:');
        targetResult.products.forEach(p => {
          console.log(`  ${p.rank}위: ${p.title} (${parseInt(p.price).toLocaleString()}원)`);
        });
      } else {
        console.log(`[${TARGET_BRAND}] 브랜드가 결과에 없습니다.`);
      }
    }

    // 상위 20개 브랜드 출력
    console.log('\n--- 브랜드 순위 TOP 20 ---');
    brandList.slice(0, 20).forEach(b => {
      console.log(`${b.brandRank}위 ${b.brand} (첫노출: ${b.firstRank}위, ${b.count}개 상품)`);
    });

    // 결과 저장
    const outDir = path.join(__dirname, '../output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const result = {
      keyword: KEYWORD,
      targetBrand: TARGET_BRAND || null,
      targetResult,
      brandRankingTop20: brandList.slice(0, 20),
      allProducts: allItems.map((item, idx) => ({
        rank: idx + 1,
        brand: extractBrand(item),
        title: cleanTitle(item.title),
        price: item.lprice,
        link: item.link,
      })),
      totalProducts: allItems.length,
      collectedAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(outDir, 'ranking.json'),
      JSON.stringify(result, null, 2)
    );
    console.log('\n결과 저장 완료: output/ranking.json');

  } catch (e) {
    console.error('오류:', e.message);
    process.exit(1);
  }
}

main();
