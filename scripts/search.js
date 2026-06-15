const https = require('https');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const KEYWORD = process.env.SEARCH_KEYWORD || '모니터';
const CATEGORY = process.env.SEARCH_CATEGORY || 'monitor';

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
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function cleanTitle(title) {
  return title
    .replace(/<[^>]*>/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/[^\uAC00-\uD7A3\u0020-\u007E\u3040-\u30FF\u4E00-\u9FFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCSV(val) {
  const str = String(val === null || val === undefined ? '' : val);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? '"' + str.replace(/"/g, '""') + '"'
    : str;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = {};
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    const key = cols[0] + '|' + cols[1];
    rows[key] = cols;
  }
  return { headers, rows };
}

async function main() {
  console.log(`키워드: ${KEYWORD} / 카테고리: ${CATEGORY}`);

  try {
    // 300개 수집
    let allItems = [];
    for (let start = 1; start <= 201; start += 100) {
      const result = await naverSearch(KEYWORD, start, 100);
      if (!result.items || result.items.length === 0) break;
      allItems = allItems.concat(result.items);
      console.log(`${start}~${start + result.items.length - 1}번째 수집 완료`);
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`총 ${allItems.length}개 상품 수집`);

    // 날짜 생성 (KST)
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const dateStr = kst.toISOString().slice(0, 10);

    // 오늘 수집 데이터 맵 (순수 값만 저장, escape는 출력 시에만 적용)
    const todayMap = {};
    allItems.forEach((item, idx) => {
      const title = cleanTitle(item.title);
      const brand = cleanTitle(item.brand || item.mallName || '');
      const key = title + '|' + brand;
      todayMap[key] = {
        rank: idx + 1,
        title: title,
        brand: brand,
        price: item.lprice,
        link: item.link
      };
    });

    // 저장 경로
    const historyDir = path.join(__dirname, '../data/history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    const csvFile = path.join(historyDir, `nrank_${CATEGORY}.csv`);

    // 고정 컬럼: title, brand, price, link (4개)
    const FIXED_COLS = 4;
    let headers = ['title', 'brand', 'price', 'link'];
    let rows = {};

    // 기존 CSV 읽기
    if (fs.existsSync(csvFile)) {
      const parsed = parseCSV(fs.readFileSync(csvFile, 'utf-8'));
      headers = parsed.headers;
      rows = parsed.rows;
      console.log(`기존 데이터 로드: ${Object.keys(rows).length}개 상품`);
    }

    // 날짜 컬럼을 고정 컬럼 바로 뒤(index 4)에 삽입 (최신이 앞)
    if (!headers.includes(dateStr)) {
      headers.splice(FIXED_COLS, 0, dateStr);
      Object.keys(rows).forEach(key => {
        rows[key].splice(FIXED_COLS, 0, '');
      });
      console.log(`날짜 컬럼 추가: ${dateStr}`);
    }

    const dateColIdx = headers.indexOf(dateStr);

    // 기존 행 업데이트
    Object.keys(rows).forEach(key => {
      while (rows[key].length < headers.length) rows[key].push('');
      if (todayMap[key]) {
        rows[key][2] = todayMap[key].price;
        rows[key][3] = todayMap[key].link;
        rows[key][dateColIdx] = todayMap[key].rank;
      } else {
        rows[key][dateColIdx] = '';
      }
    });

    // 새 상품 추가
    Object.keys(todayMap).forEach(key => {
      if (!rows[key]) {
        const { title, brand, price, link, rank } = todayMap[key];
        const newRow = new Array(headers.length).fill('');
        newRow[0] = title;
        newRow[1] = brand;
        newRow[2] = price;
        newRow[3] = link;
        newRow[dateColIdx] = rank;
        rows[key] = newRow;
      }
    });

    // CSV 저장 (BOM 추가로 엑셀 한글 깨짐 방지, escape는 출력 시에만 적용)
    const csvContent = [
      headers.map(h => escapeCSV(h)).join(','),
      ...Object.values(rows).map(r => r.map(v => escapeCSV(v)).join(','))
    ].join('\n');

    fs.writeFileSync(csvFile, '\uFEFF' + csvContent);
    console.log(`저장 완료: data/history/nrank_${CATEGORY}.csv`);
    console.log(`총 ${Object.keys(rows).length}개 상품 누적`);

  } catch (e) {
    console.error('오류:', e.message);
    process.exit(1);
  }
}

main();
