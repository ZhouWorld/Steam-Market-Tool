// ==UserScript==
// @name         Steam武器箱挂单数据查询
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  在 Steam 市场页面自动查询并显示武器箱的挂单数据
// @author       You
// @match        https://steamcommunity.com/market/*
// @match        https://steamcommunity.com/market/listings/*
// @match        https://steamcommunity.com/market/multisell*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_getResourceURL
// @grant        GM_addElement
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        unsafeWindow
// @icon         https://store.steampowered.com/favicon.ico
// @connect      steamcommunity.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/json5@2.2.3/dist/index.min.js
// @resource     chartjs_css https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
// @grant        GM_getResourceText
// @resource     myConfig https://gist.githubusercontent.com/ZhouWorld/3845fc1ac1d95a529f0623202795968f/raw/d0397181650131728c80517e3c4dc023f9d9a2d1/myConfig.json5
// ==/UserScript==

// ---------- orderbook 缓存 ----------
var orderbookCache = {};
var orderbookCacheTime = {};
const ORDERBOOK_CACHE_DURATION = 60000;

// ---------- 挂单数据缓存 ----------
let cachedListingsData = null;
let listingsCacheTime = 0;
const LISTINGS_CACHE_DURATION = 60000;

// 库存数据缓存
let cachedInventoryData = null;
let inventoryCacheTime = 0;
const INVENTORY_CACHE_DURATION = 60000;

let currentNameListPage = 1;
const NAME_LIST_PAGE_SIZE = 10;

// ⭐ 搜索状态
let searchKeyword = '';
let searchFilter = 'all'; // all | tradable | no-tradable | has-stock
let stockStatusFilter = 'all'; // ⭐ 新增：all | red | purple | yellow | blue | green

// ⭐ 新增：抑制 MutationObserver 触发
let suppressMultisellObserver = false;

// ============================================================
// 修复：在脚本开头添加 GM_* 函数的兼容性检查
// ============================================================

// 确保 GM_* 函数可用（Tampermonkey 环境）
if (typeof GM_setValue === 'undefined') {
    console.warn('⚠️ GM_setValue 不可用，请检查脚本授权');
}

// ============================================================
// 修复：在脚本开头添加 GM_* 函数的兼容性检查
// ============================================================

// 确保 GM_* 函数可用（Tampermonkey 环境）
if (typeof GM_setValue === 'undefined') {
    console.warn('⚠️ GM_setValue 不可用，请检查脚本授权');
}

// ============================================================
// 读取远程配置（兼容 JSON 和 JSON5）
// ============================================================
const raw = GM_getResourceText('myConfig');

let config;
try {
    // 优先尝试 JSON5（如果引了 JSON5 库）
    if (typeof JSON5 !== 'undefined') {
        config = JSON5.parse(raw);
    } else {
        config = JSON.parse(raw);
    }
} catch (e) {
    console.error('❌ 解析 myConfig 失败:', e);
    config = { wearLabels: {}, weaponCases: [] };
}

const WEAR_LABELS = config.wearLabels || {};
const WEAR_PARAM_MAP = config.wearParamMap || {};
const QUALITY_LABELS = config.qualityLabels || {};
const QUALITY_PREFIX = config.qualityPrefixMap || {};
const WEAPON_CASES = config.weaponCases || [];

// ============================================================
// 新增：获取 Steam 钱包信息（动态费用）
// ============================================================

let cachedWalletInfo = null;
let walletInfoCacheTime = 0;
const WALLET_INFO_CACHE_DURATION = 300000; // 5分钟缓存

function slimOrderBookData(data) {
    // 只保留必要字段，减少体积
    var parsed = parseOrderBook(data);
    return {
        sellOrders: (parsed.sellOrders || []).slice(0, 200),
        lowestSell: parsed.lowestSell,
        sellCount: parsed.sellCount,
        _slim: true // ⭐ 标记：已经是精简版
    };
}

function cleanOrderbookCache() {
    var prefix = 'weaponCases_orderbook_';
    var toDelete = [];
    var now = Date.now();
    for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(prefix) === 0) {
            try {
                var obj = JSON.parse(localStorage.getItem(k));
                if (now - obj.t > 30 * 60 * 1000) {
                    toDelete.push(k);
                }
            } catch (e) {
                toDelete.push(k);
            }
        }
    }
    toDelete.forEach(k => localStorage.removeItem(k));
}

function fetchOrderBookCached(appid, marketHashName) {
    var key = appid + '|' + marketHashName;
    var now = Date.now();

    // 1. 内存缓存
    if (orderbookCache[key] && now - orderbookCacheTime[key] < ORDERBOOK_CACHE_DURATION) {
        return Promise.resolve(orderbookCache[key]);
    }

    // 2. 持久化缓存
    var lsKey = 'weaponCases_orderbook_' + key;
    try {
        var cached = localStorage.getItem(lsKey);
        if (cached) {
            var obj = JSON.parse(cached);
            if (now - obj.t < 5 * 60 * 1000) {
                // 缓存命中
                orderbookCache[key] = obj.d;
                orderbookCacheTime[key] = obj.t;
                console.log('[cache hit]', marketHashName);
                return Promise.resolve(obj.d);
            }
        }
    } catch (e) {}

    // 3. 网络请求
    return fetchOrderBook(appid, marketHashName).then(function (data) {
        var parsed = parseOrderBook(data);

        // 内存缓存：原始响应
        orderbookCache[key] = data;
        orderbookCacheTime[key] = now;

        // 持久化缓存：精简版
        try {
            localStorage.setItem(
                lsKey,
                JSON.stringify({
                    t: now,
                    d: slimOrderBookData(data)
                })
            );
        } catch (e) {
            // localStorage 满了，忽略
        }

        return data;
    });
}

// ---------- 读取缓存（持久化的精简版需要重新包装成 parseOrderBook 可识别的格式） ----------
function parseOrderBookCached(data) {
    if (data && data._slim) {
        // 已经是精简版，直接返回
        return {
            sellOrders: data.sellOrders || [],
            lowestSell: data.lowestSell || 0,
            sellCount: data.sellCount || 0
        };
    }
    return parseOrderBook(data);
}

function getWalletInfo() {
    try {
        // ① 优先从 unsafeWindow 获取
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.g_rgWalletInfo) {
            const info = unsafeWindow.g_rgWalletInfo;
            if (info && info.wallet_fee_percent !== undefined) {
                return info;
            }
        }

        // ② 从页面内联 <script> 里找（遍历所有 script 标签）
        var scripts = document.querySelectorAll('script');
        for (var si = 0; si < scripts.length; si++) {
            var txt = scripts[si].textContent || '';
            if (txt.indexOf('g_rgWalletInfo') === -1) continue;

            var match = txt.match(/var\s+g_rgWalletInfo\s*=\s*({[\s\S]*?});/);
            if (match) {
                try {
                    return JSON.parse(match[1]);
                } catch (e) {
                    // 继续找下一个
                }
            }
        }

        // ③ 尝试其他可能的全局变量名
        if (typeof unsafeWindow !== 'undefined') {
            const possibleVars = ['g_rgWalletInfo', 'g_oWalletInfo', 'WalletInfo'];
            for (const varName of possibleVars) {
                if (unsafeWindow[varName]) {
                    return unsafeWindow[varName];
                }
            }
        }

        // ④ 兜底：默认费率
        console.warn('⚠️ 无法获取 Steam 钱包信息，使用默认费率');
        return {
            wallet_fee_percent: 0.05,
            wallet_fee_base: 0,
            wallet_fee_minimum: 1,
            wallet_publisher_fee_percent_default: 0.1,
            wallet_currency: 1,
            wallet_country: 'US'
        };
    } catch (e) {
        console.warn('获取钱包信息失败:', e);
        return {
            wallet_fee_percent: 0.05,
            wallet_fee_base: 0,
            wallet_fee_minimum: 1,
            wallet_publisher_fee_percent_default: 0.1,
            wallet_currency: 1,
            wallet_country: 'US'
        };
    }
}
// 获取当前使用的货币代码
function getCurrencyCode() {
    try {
        const walletInfo = getWalletInfo();
        const currencyId = walletInfo.wallet_currency || 1;
        const currencyMap = {
            1: 'USD',
            2: 'GBP',
            3: 'EUR',
            4: 'BRL',
            5: 'RUB',
            6: 'CNY',
            7: 'KRW',
            8: 'TRY',
            9: 'INR',
            10: 'CAD',
            11: 'AUD',
            12: 'CHF',
            13: 'SEK',
            14: 'DKK',
            15: 'NOK',
            16: 'RUB',
            17: 'JPY',
            18: 'SGD',
            19: 'KRW',
            20: 'BRL',
            21: 'TRY',
            22: 'INR',
            23: 'CNY'
        };
        return currencyMap[currencyId] || 'USD';
    } catch (e) {
        return 'USD';
    }
}

function parseWearFromHashName(marketHashName, item) {
    if (!marketHashName) return { en: '', zh: '' };

    var m = marketHashName.match(/\(([^)]+)\)\s*$/);
    if (!m) return { en: '', zh: '' };

    var en = m[1].trim();
    var zh =
        (item && item.wear_labels && item.wear_labels[en]) || // ① 物品级
        WEAR_LABELS[en] || // ② 全局配置
        en; // ③ 英文兜底

    return { en: en, zh: zh };
}

// ---------- 获取物品的缩略图 URL ----------
function getItemIconUrl(item, size) {
    size = size || '64fx64f'; // 默认 64

    function buildUrl(iconUrl) {
        if (!iconUrl) return '';
        if (iconUrl.indexOf('http') === 0) {
            // 已经是完整 URL，尝试替换尺寸
            return iconUrl.replace(/\/(\d+)fx(\d+)f$/, '/' + size);
        }
        return 'https://community.steamstatic.com/economy/image/' + iconUrl + '/' + size;
    }

    if (!item) return '';

    // ⭐ 优先用 item 上直接存的 icon_url
    if (item.icon_url) {
        return buildUrl(item.icon_url);
    }

    // ⭐ 从库存 descriptions 里找
    try {
        var inv = cachedInventoryData;
        if (!inv || !inv.success) return '';

        var candidateMhns = new Set();
        if (item.is_skin) {
            var wears = item.wears || [item.default_wear];
            var qualities = item.qualities || ['normal'];
            for (var wi = 0; wi < wears.length; wi++) {
                for (var qi = 0; qi < qualities.length; qi++) {
                    candidateMhns.add(getMarketHashName(item, wears[wi], qualities[qi]));
                }
            }
        } else {
            candidateMhns.add(item.market_hash_name);
        }

        var zones = [];
        if (inv.normal && inv.normal.success) zones.push(inv.normal);
        if (inv.protected && inv.protected.success) zones.push(inv.protected);

        for (var z = 0; z < zones.length; z++) {
            var descs = zones[z].descriptions || [];
            for (var i = 0; i < descs.length; i++) {
                var d = descs[i];
                if (candidateMhns.has(d.market_hash_name) && d.icon_url) {
                    return buildUrl(d.icon_url);
                }
            }
        }
    } catch (e) {
        console.warn('[getItemIconUrl] 查找失败:', e);
    }

    return '';
}

// ============================================================
// 新增：精确的 Steam 费用计算（基于官方算法）
// ============================================================

/**
 * 计算买家支付价格对应的各项费用
 * 基于 Steam 官方算法：https://steamcommunity.com/groups/community_market/discussions/0/682988196226679356/
 *
 * @param {number} buyerPrice - 买家支付价格（单位：分）
 * @param {object} walletInfo - Steam 钱包信息
 * @param {number} publisherFee - 发行商手续费率（可选）
 * @returns {object} 费用明细
 */
function calculateSteamFees(buyerPrice, walletInfo, publisherFee) {
    if (!walletInfo) {
        walletInfo = getWalletInfo();
    }

    // 默认值
    const steamFeePercent = parseFloat(walletInfo.wallet_fee_percent) || 0.05;
    const steamFeeBase = parseInt(walletInfo.wallet_fee_base) || 0;
    const minFee = parseInt(walletInfo.wallet_fee_minimum) || 1;
    const pubFeeDefault = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;

    // 发行商手续费（如果未指定，使用默认值）
    const pubFee = publisherFee !== undefined ? publisherFee : pubFeeDefault;

    // 根据货币选择四舍五入方式
    const currencyCode = getCurrencyCode();
    const roundCurrencies = ['JPY', 'IDR', 'UAH', 'CLP', 'COP', 'TWD', 'KZT', 'CRC', 'UYU', 'KRW', 'VND'];
    const useRound = roundCurrencies.includes(currencyCode);
    const roundFn = useRound ? Math.round : Math.floor;

    // 计算卖家实收金额（通过迭代精确计算）
    // 公式：买家支付 = 卖家实收 + Steam手续费 + 发行商手续费
    // Steam手续费 = max(round(卖家实收 × steamFeePercent + steamFeeBase), minFee)
    // 发行商手续费 = max(round(卖家实收 × pubFee), minFee) 或 0

    function calculateFeesForAmount(sellerAmount) {
        // 1. 计算 Steam 手续费
        let steamFee = roundFn(sellerAmount * steamFeePercent + steamFeeBase);
        steamFee = Math.max(steamFee, minFee);

        // 2. 计算发行商手续费
        let publisherFeeAmount = 0;
        if (pubFee > 0) {
            publisherFeeAmount = roundFn(sellerAmount * pubFee);
            publisherFeeAmount = Math.max(publisherFeeAmount, minFee);
        }

        const totalFees = steamFee + publisherFeeAmount;
        const totalBuyerPrice = sellerAmount + totalFees;

        return {
            sellerAmount: sellerAmount,
            steamFee: steamFee,
            publisherFee: publisherFeeAmount,
            totalFees: totalFees,
            buyerPrice: totalBuyerPrice
        };
    }

    // 二分查找精确的卖家实收金额
    let low = 0;
    let high = buyerPrice;
    let bestMatch = null;
    let iterations = 0;
    const maxIterations = 100;

    while (low <= high && iterations < maxIterations) {
        iterations++;
        const mid = Math.floor((low + high) / 2);
        const result = calculateFeesForAmount(mid);

        if (result.buyerPrice === buyerPrice) {
            bestMatch = result;
            break;
        } else if (result.buyerPrice < buyerPrice) {
            bestMatch = result;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    // 如果没找到精确匹配，使用最接近的
    if (!bestMatch) {
        // 尝试向上微调
        for (let offset = 0; offset < 10; offset++) {
            const testAmount = high + offset;
            const result = calculateFeesForAmount(testAmount);
            if (result.buyerPrice === buyerPrice) {
                bestMatch = result;
                break;
            }
            if (result.buyerPrice > buyerPrice) {
                // 取前一个
                const prevResult = calculateFeesForAmount(testAmount - 1);
                if (prevResult.buyerPrice <= buyerPrice) {
                    bestMatch = prevResult;
                    break;
                }
                bestMatch = result;
                break;
            }
            bestMatch = result;
        }
    }

    if (!bestMatch) {
        // 保底计算
        const estimatedSeller = Math.floor(buyerPrice / (1 + steamFeePercent + pubFee));
        bestMatch = calculateFeesForAmount(estimatedSeller);
    }

    // 计算手续费占比
    const feePercentage = buyerPrice > 0 ? (bestMatch.totalFees / buyerPrice) * 100 : 0;

    return {
        buyerPrice: buyerPrice,
        sellerAmount: bestMatch.sellerAmount,
        steamFee: bestMatch.steamFee,
        publisherFee: bestMatch.publisherFee,
        totalFees: bestMatch.totalFees,
        feePercentage: feePercentage,
        currencyCode: currencyCode,
        // 额外信息
        walletInfo: {
            steamFeePercent: steamFeePercent * 100,
            publisherFeePercent: pubFee * 100,
            minFee: minFee,
            useRound: useRound
        }
    };
}
/**
 * 计算卖家期望收到金额对应的买家支付价格
 * @param {number} desiredAmount - 卖家期望收到的金额（单位：分）
 * @param {object} walletInfo - Steam 钱包信息
 * @param {number} publisherFee - 发行商手续费率
 * @returns {object} 费用明细
 */
function calculateFromSellerAmount(desiredAmount, walletInfo, publisherFee) {
    if (!walletInfo) {
        walletInfo = getWalletInfo();
    }

    const steamFeePercent = parseFloat(walletInfo.wallet_fee_percent) || 0.05;
    const steamFeeBase = parseInt(walletInfo.wallet_fee_base) || 0;
    const minFee = parseInt(walletInfo.wallet_fee_minimum) || 1;
    const pubFee =
        publisherFee !== undefined ? publisherFee : parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;

    const currencyCode = getCurrencyCode();
    const roundCurrencies = ['JPY', 'IDR', 'UAH', 'CLP', 'COP', 'TWD', 'KZT', 'CRC', 'UYU', 'KRW', 'VND'];
    const useRound = roundCurrencies.includes(currencyCode);
    const roundFn = useRound ? Math.round : Math.floor;

    // 计算手续费
    let steamFee = roundFn(desiredAmount * steamFeePercent + steamFeeBase);
    steamFee = Math.max(steamFee, minFee);

    let publisherFeeAmount = 0;
    if (pubFee > 0) {
        publisherFeeAmount = roundFn(desiredAmount * pubFee);
        publisherFeeAmount = Math.max(publisherFeeAmount, minFee);
    }

    const totalFees = steamFee + publisherFeeAmount;
    const buyerPrice = desiredAmount + totalFees;
    const feePercentage = buyerPrice > 0 ? (totalFees / buyerPrice) * 100 : 0;

    return {
        buyerPrice: buyerPrice,
        sellerAmount: desiredAmount,
        steamFee: steamFee,
        publisherFee: publisherFeeAmount,
        totalFees: totalFees,
        feePercentage: feePercentage,
        currencyCode: currencyCode,
        walletInfo: {
            steamFeePercent: steamFeePercent * 100,
            publisherFeePercent: pubFee * 100,
            minFee: minFee,
            useRound: useRound
        }
    };
}

// ============================================================
// 价格计算器：双向联动买家支付 / 卖家实收
// ============================================================
function showFeeCalculator() {
    var symbol = getCurrencySymbol();
    var walletInfo = getWalletInfo();
    var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;

    // 防止重复打开
    var existing = document.getElementById('fee-calc-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'fee-calc-overlay';
    overlay.style.cssText = `
        position: fixed; top:0; left:0; right:0; bottom:0;
        background: rgba(0,0,0,0.7);
        z-index: 10010;
        display: flex; justify-content:center; align-items:center;
        backdrop-filter: blur(4px);
    `;

    overlay.innerHTML = `
        <div style="
            background: rgba(27, 40, 56, 0.98);
            border: 1px solid #2a3f5e;
            border-radius: 12px;
            padding: 24px 28px;
            max-width: 420px;
            width: 100%;
            margin: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.8);
            font-family: 'Motiva Sans', Arial, sans-serif;
            color: #c6d4df;
        ">
            <div style="text-align:center; font-size:15px; font-weight:bold; color:#66c0f4; margin-bottom:16px;">
                🧮 价格计算器
            </div>

            <div style="margin-bottom:12px;">
                <label style="font-size:12px; color:#8b9aab; display:block; margin-bottom:4px;">
                    买家支付 (${symbol})
                </label>
                <input id="calc-buyer" type="number" step="0.01" min="0"
                    placeholder="0.00"
                    style="width:100%; padding:8px 12px; background:rgba(0,0,0,0.3);
                           color:#ff6b6b; border:1px solid #2a3f5e; border-radius:4px;
                           font-size:14px; font-family:inherit; box-sizing:border-box;">
            </div>

            <div style="text-align:center; color:#4a5a6a; font-size:12px; margin:-4px 0 8px 0;">⇅</div>

            <div style="margin-bottom:12px;">
                <label style="font-size:12px; color:#8b9aab; display:block; margin-bottom:4px;">
                    卖家实收 (${symbol})
                </label>
                <input id="calc-seller" type="number" step="0.01" min="0"
                    placeholder="0.00"
                    style="width:100%; padding:8px 12px; background:rgba(0,0,0,0.3);
                           color:#8bc34a; border:1px solid #2a3f5e; border-radius:4px;
                           font-size:14px; font-family:inherit; box-sizing:border-box;">
            </div>

                        <div style="margin-bottom:12px;">
                <label style="font-size:12px; color:#8b9aab; display:block; margin-bottom:4px;">
                    入库价格 (${symbol}) <span style="color:#4a5a6a; font-size:11px;">（可选）</span>
                </label>
                <input id="calc-cost" type="number" step="0.01" min="0"
                    placeholder="0.00"
                    style="width:100%; padding:8px 12px; background:rgba(0,0,0,0.3);
                           color:#c6d4df; border:1px solid #2a3f5e; border-radius:4px;
                           font-size:14px; font-family:inherit; box-sizing:border-box;">
            </div>

            <div id="calc-detail" style="
                background: rgba(0,0,0,0.2);
                border-radius: 6px;
                padding: 10px 12px;
                margin-bottom: 12px;
                font-size: 12px;
                min-height: 80px;
                line-height: 1.7;
                display: none;
            ">
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#8b9aab;">买家支付</span>
                    <span id="calc-d-buyer" style="color:#ff6b6b;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#8b9aab;">卖家实收</span>
                    <span id="calc-d-seller" style="color:#8bc34a; font-weight:bold;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#8b9aab;">Steam 手续费</span>
                    <span id="calc-d-steam" style="color:#ffd93d;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between;">
                    <span style="color:#8b9aab;">发行商手续费</span>
                    <span id="calc-d-pub" style="color:#ffd93d;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.05); margin-top:4px; padding-top:4px;">
                    <span style="color:#8b9aab;">总手续费</span>
                    <span id="calc-d-total" style="color:#ff6b6b;">--</span>
                </div>
                                <div style="display:flex; justify-content:space-between; font-size:10px; color:#4a6a8a;">
                    <span id="calc-d-percent"></span>
                </div>
                <div id="calc-d-discount-row" style="display:none; justify-content:space-between; border-top:1px solid rgba(255,255,255,0.05); margin-top:4px; padding-top:4px;">
                    <span style="color:#8b9aab;">折扣率</span>
                    <span id="calc-d-discount" style="color:#66c0f4; font-weight:bold;">--</span>
                </div>

            </div>

            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button id="calc-clear-btn" style="
                    background: transparent; color:#8b9aab;
                    border:1px solid #2a3f5e; border-radius:4px;
                    padding:6px 20px; font-size:12px; cursor:pointer;
                    font-family:inherit;">清空</button>
                <button id="calc-close-btn" style="
                    background:#2a5a7a; color:#c6d4df; border:none;
                    border-radius:4px; padding:6px 24px; font-size:12px;
                    cursor:pointer; font-family:inherit;">关闭</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    var buyerInput = overlay.querySelector('#calc-buyer');
    var sellerInput = overlay.querySelector('#calc-seller');
    var costInput = overlay.querySelector('#calc-cost');
    var detailBox = overlay.querySelector('#calc-detail');
    var discountRow = overlay.querySelector('#calc-d-discount-row');
    var discountEl = overlay.querySelector('#calc-d-discount');

    // 同步标志位，防止死循环
    var syncing = false;

    var formatMoney = function (cents) {
        return symbol + ' ' + (cents / 100).toFixed(2);
    };

    function renderDetail(feeInfo) {
        detailBox.style.display = 'block';
        overlay.querySelector('#calc-d-buyer').textContent = formatMoney(feeInfo.buyerPrice);
        overlay.querySelector('#calc-d-seller').textContent = formatMoney(feeInfo.sellerAmount);
        overlay.querySelector('#calc-d-steam').textContent = formatMoney(feeInfo.steamFee);
        overlay.querySelector('#calc-d-pub').textContent = formatMoney(feeInfo.publisherFee);
        overlay.querySelector('#calc-d-total').textContent =
            formatMoney(feeInfo.totalFees) + ' (' + feeInfo.feePercentage.toFixed(2) + '%)';
        overlay.querySelector('#calc-d-percent').textContent = feeInfo.walletInfo.useRound
            ? '货币策略：四舍五入'
            : '货币策略：向下取整';

        // ⭐ 折扣率 = 入库价格 / 卖家实收 × 100%
        updateDiscount(feeInfo.sellerAmount);
    }

    // ⭐ 折扣率计算与渲染
    function updateDiscount(sellerCents) {
        if (!sellerCents || sellerCents <= 0) {
            discountRow.style.display = 'none';
            return;
        }
        var costVal = parseFloat(costInput.value);
        if (isNaN(costVal) || costVal <= 0) {
            discountRow.style.display = 'none';
            return;
        }
        var costCents = Math.round(costVal * 100);
        var rawRate = (costCents / sellerCents) * 100; // 例如 74.62686
        // ⭐ 保留两位小数，向上取整
        var rate = Math.ceil(rawRate * 100) / 100;
        discountEl.textContent = rate.toFixed(2) + '%';
        discountRow.style.display = 'flex';

        // ⭐ 若想"整数部分取整、无小数"用：
        // var rate = Math.ceil(rawRate);
        // discountEl.textContent = rate + '%';
    }

    function clearDetail() {
        detailBox.style.display = 'none';
    }

    // 用户输入买家支付 → 计算卖家实收
    buyerInput.addEventListener('input', function () {
        if (syncing) return;
        var val = parseFloat(this.value);
        if (isNaN(val) || val <= 0) {
            sellerInput.value = '';
            clearDetail();
            return;
        }
        var buyerCents = Math.round(val * 100);
        if (buyerCents < 1) {
            sellerInput.value = '';
            clearDetail();
            return;
        }
        var feeInfo = calculateSteamFees(buyerCents, walletInfo, publisherFee);

        syncing = true;
        sellerInput.value = (feeInfo.sellerAmount / 100).toFixed(2);
        syncing = false;

        renderDetail(feeInfo);
    });

    // ⭐ 入库价格变化 → 重算折扣率
    costInput.addEventListener('input', function () {
        // 从当前买家支付反推 sellerAmount 用于算折扣
        var buyerVal = parseFloat(buyerInput.value);
        if (isNaN(buyerVal) || buyerVal <= 0) {
            discountRow.style.display = 'none';
            return;
        }
        var buyerCents = Math.round(buyerVal * 100);
        if (buyerCents < 1) {
            discountRow.style.display = 'none';
            return;
        }
        var feeInfo = calculateSteamFees(buyerCents, walletInfo, publisherFee);
        updateDiscount(feeInfo.sellerAmount);
    });

    // 用户输入卖家实收 → 反推买家支付
    sellerInput.addEventListener('input', function () {
        if (syncing) return;
        var val = parseFloat(this.value);
        if (isNaN(val) || val <= 0) {
            buyerInput.value = '';
            clearDetail();
            return;
        }
        var sellerCents = Math.round(val * 100);
        if (sellerCents < 1) {
            buyerInput.value = '';
            clearDetail();
            return;
        }
        // 用卖家实收直接正推买家支付（不需要二分）
        var feeInfo = calculateFromSellerAmount(sellerCents, walletInfo, publisherFee);

        syncing = true;
        buyerInput.value = (feeInfo.buyerPrice / 100).toFixed(2);
        syncing = false;

        renderDetail(feeInfo);
    });

    // 清空
    overlay.querySelector('#calc-clear-btn').addEventListener('click', function () {
        buyerInput.value = '';
        sellerInput.value = '';
        costInput.value = '';
        discountRow.style.display = 'none';
        clearDetail();
        buyerInput.focus();
    });

    // 关闭
    function close() {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
    }
    overlay.querySelector('#calc-close-btn').addEventListener('click', close);

    // ESC 关闭
    var escHandler = function (e) {
        if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', escHandler);

    // 自动聚焦
    setTimeout(function () {
        buyerInput.focus();
    }, 100);
}

// ============================================================
// 新增：费用显示弹窗
// ============================================================

function showFeeDetailDialog(feeInfo, itemName) {
    const symbol = getCurrencySymbol();
    const formatMoney = cents => {
        if (cents === undefined || cents === null) return '--';
        return symbol + ' ' + (cents / 100).toFixed(2);
    };

    // 创建弹窗内容
    const dialogContent = document.createElement('div');
    dialogContent.style.cssText = `
        padding: 20px;
        font-family: "Motiva Sans", Arial, sans-serif;
        color: #c6d4df;
        min-width: 380px;
    `;

    dialogContent.innerHTML = `
        <div style="text-align:center; margin-bottom:16px; font-size:16px; font-weight:bold; color:#66c0f4;">
            💰 费用明细
        </div>
        <div style="margin-bottom:12px; font-size:13px; color:#8b9aab; text-align:center;">
            ${itemName || '物品'}
        </div>
        <div style="background:rgba(0,0,0,0.2); border-radius:8px; padding:12px 16px; margin-bottom:12px;">
            <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                <span style="color:#8b9aab;">买家支付</span>
                <span style="color:#ff6b6b; font-weight:bold;">${formatMoney(feeInfo.buyerPrice)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                <span style="color:#8b9aab;">卖家实收</span>
                <span style="color:#8bc34a; font-weight:bold;">${formatMoney(feeInfo.sellerAmount)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                <span style="color:#8b9aab;">Steam 手续费 (${feeInfo.walletInfo.steamFeePercent.toFixed(1)}%)</span>
                <span style="color:#ffd93d;">${formatMoney(feeInfo.steamFee)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
                <span style="color:#8b9aab;">发行商手续费 (${feeInfo.walletInfo.publisherFeePercent.toFixed(1)}%)</span>
                <span style="color:#ffd93d;">${formatMoney(feeInfo.publisherFee)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; padding:4px 0;">
                <span style="color:#8b9aab;">总手续费</span>
                <span style="color:#ff6b6b; font-weight:bold;">${formatMoney(feeInfo.totalFees)}</span>
            </div>
        </div>
        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px; color:#4a6a8a;">
            <span>手续费占比: ${feeInfo.feePercentage.toFixed(2)}%</span>
            <span>货币: ${feeInfo.currencyCode}</span>
            <span>${feeInfo.walletInfo.useRound ? '四舍五入' : '向下取整'}</span>
        </div>
        <div style="text-align:center; margin-top:12px;">
            <button id="fee-detail-close" style="
                background: #2a3f5e;
                color: #c6d4df;
                border: none;
                border-radius: 4px;
                padding: 6px 30px;
                font-size: 12px;
                cursor: pointer;
                font-family: inherit;
            ">关闭</button>
        </div>
    `;

    // 创建并显示弹窗
    const overlay = document.createElement('div');
    overlay.id = 'fee-detail-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.6);
        z-index: 10001;
        display: flex;
        justify-content: center;
        align-items: center;
        backdrop-filter: blur(4px);
    `;

    const container = document.createElement('div');
    container.style.cssText = `
        background: rgba(27, 40, 56, 0.98);
        border: 1px solid #2a3f5e;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.8);
        max-width: 90vw;
    `;
    container.appendChild(dialogContent);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    overlay.querySelector('#fee-detail-close').addEventListener('click', function () {
        overlay.remove();
    });

    overlay.addEventListener('click', function (e) {
        if (e.target === this) {
            this.remove();
        }
    });

    // ESC 关闭
    const escHandler = function (e) {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

// 默认每页显示数量
const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 200;

// ---------- 时间跨度配置 ----------
const TIME_RANGES = {
    today: { label: '本日', hours: 24 },
    week: { label: '本周', hours: 168 },
    twoweeks: { label: '近两周', hours: 336 },
    month: { label: '本月', hours: 720 },
    year: { label: '最近一年', hours: 8760 }
};

let currentTimeRange = 'week';
let chartInstance = null;

// ---------- 判断当前页面类型 ----------
function isMarketHomePage() {
    const path = window.location.pathname;
    const url = window.location.href;
    if (url.includes('/market/multisell')) {
        return true;
    }
    return path === '/market' || path === '/market/' || path.startsWith('/market?');
}

function isListingPage() {
    return window.location.pathname.includes('/market/listings/');
}

function isMultisellPage() {
    return window.location.pathname.includes('/market/multisell');
}

function getMarketHashName(item, wear, quality) {
    if (!item.is_skin) {
        return item.market_hash_name;
    }

    const w = wear || item.default_wear;
    const q = quality || item.default_quality || 'normal';

    // 品质前缀
    const prefix = QUALITY_PREFIX[q] || '';

    return prefix + item.base_name + ' (' + w + ')';
}

function getItemUrl(item, wear) {
    return item.url;
}

function getWearLabel(item, wear) {
    if (!item.is_skin) return '';
    return (item.wear_labels && item.wear_labels[wear]) || WEAR_LABELS[wear] || wear || '';
}

function getQualityLabel(item, quality) {
    if (!item.is_skin) return '';
    return QUALITY_LABELS[quality] || quality || '';
}
// ---------- 获取当前页面的武器箱 ----------
// ---------- 从详情页读取当前磨损 ----------
function readCurrentWearFromPage(item) {
    if (!item.is_skin) return null;

    // 1. 尝试从磨损下拉读取
    const selectors = [
        'select#market_commodity_wear_select',
        'select[name="wear"]',
        '.market_commodity_wear_select select',
        '#market_commodity_order_summary select'
    ];

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.value) {
            for (const w of item.wears) {
                if (el.value === w || el.value.indexOf(w) !== -1) {
                    return w;
                }
            }
        }
    }

    // 2. 从页面标题里找磨损英文名
    const titleEl = document.querySelector('.market_listing_nav .market_listing_page_title');
    if (titleEl) {
        const title = titleEl.textContent;
        for (const w of item.wears) {
            if (title.indexOf(w) !== -1) {
                return w;
            }
        }
    }

    // 3. 兜底
    return item.default_wear;
}

// ---------- 获取当前页面的物品 ----------
function getCurrentCase() {
    const currentUrl = window.location.href;

    // ① 精确 URL 比较
    for (const item of WEAPON_CASES) {
        if (item.url) {
            if (currentUrl === item.url || currentUrl === item.url + '/') {
                return {
                    item: item,
                    wear: item.is_skin ? readCurrentWearFromPage(item) : null,
                    quality: item.is_skin ? item.default_quality || 'normal' : null
                };
            }
        }
    }

    // ② 从 URL 抓 G... id 反查
    // ② 从 URL 抓 G... id 反查
    const urlMatch = currentUrl.match(/\/listings\/\d+\/(G[A-F0-9]+)/i);
    if (urlMatch) {
        const id = urlMatch[1].toUpperCase();
        for (const item of WEAPON_CASES) {
            if (item.url && item.url.toUpperCase().indexOf(id) !== -1) {
                return {
                    item: item,
                    wear: item.is_skin ? readCurrentWearFromPage(item) : null,
                    quality: item.is_skin ? item.default_quality || 'normal' : null
                };
            }
        }
    }

    // ③ 页面标题兜底
    try {
        const titleEl = document.querySelector('.market_listing_nav .market_listing_page_title');
        if (titleEl) {
            const title = titleEl.textContent.trim();
            for (const item of WEAPON_CASES) {
                if (item.is_skin) {
                    if (title.indexOf(item.base_name) !== -1 || title.indexOf(item.name) !== -1) {
                        return { item: item, wear: readCurrentWearFromPage(item) };
                    }
                } else {
                    if (
                        title.indexOf(item.market_hash_name) !== -1 ||
                        item.market_hash_name.indexOf(title) !== -1 ||
                        title.indexOf(item.name) !== -1 ||
                        item.name.indexOf(title) !== -1
                    ) {
                        return { item: item, wear: null };
                    }
                }
            }
        }
    } catch (e) {}

    return null;
}

// ---------- 从 multisell 页面解析批量上架的物品名称 ----------
function getMultisellItems() {
    const items = [];
    try {
        // 方法1: 从 URL 参数解析
        const urlParams = new URLSearchParams(window.location.search);
        const itemsParam = urlParams.get('items[]');
        if (itemsParam) {
            // 可能有多个 items[] 参数
            const allItems = urlParams.getAll('items[]');
            for (const name of allItems) {
                const decoded = decodeURIComponent(name);
                items.push(decoded);
            }
            if (items.length > 0) return items;
        }

        // 方法2: 从页面 DOM 解析 - 查找物品名称输入框或显示元素
        // multisell 页面通常有物品列表
        const nameInputs = document.querySelectorAll('input[name="market_hash_name[]"], input[name="items[]"]');
        for (const input of nameInputs) {
            if (input.value) {
                items.push(input.value);
            }
        }

        // 方法3: 从页面文本内容解析
        if (items.length === 0) {
            const itemElements = document.querySelectorAll(
                '.item_name, .market_listing_item_name, [class*="item-name"]'
            );
            for (const el of itemElements) {
                const text = el.textContent.trim();
                if (text && text.length > 2) {
                    // 检查是否匹配我们的武器箱列表
                    for (const caseItem of WEAPON_CASES) {
                        if (text.includes(caseItem.market_hash_name) || caseItem.market_hash_name.includes(text)) {
                            if (!items.includes(caseItem.market_hash_name)) {
                                items.push(caseItem.market_hash_name);
                            }
                            break;
                        }
                    }
                }
            }
        }

        // 方法4: 从页面中查找包含武器箱名称的任意元素
        if (items.length === 0) {
            const bodyText = document.body.innerText;
            for (const caseItem of WEAPON_CASES) {
                if (bodyText.includes(caseItem.market_hash_name)) {
                    items.push(caseItem.market_hash_name);
                }
            }
        }
    } catch (e) {
        console.warn('解析multisell物品失败:', e);
    }

    return items;
}

// ---------- 注入样式 ----------
GM_addStyle(`
    .weapon-cases-panel {
    position: fixed;
    top: 50px;
    right: 20px;
    width: 420px;
    max-height: calc(100vh - 100px);
    background: rgba(27, 40, 56, 0.95);
    border: 1px solid #2a3f5e;
    border-radius: 8px;
    padding: 12px 16px;
    z-index: 9999;
    font-family: "Motiva Sans", Arial, sans-serif;
    overflow: hidden;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    transition: none;
    color: #c6d4df;
    cursor: default;
    user-select: none;
    display: flex;
    flex-direction: column;
    }

    .weapon-cases-panel.dragging {
        opacity: 0.8;
        cursor: grabbing;
        transition: none;
    }

    .weapon-cases-panel.minimized {
        width: auto;
        max-height: 42px;
        overflow: hidden;
        cursor: default;
    }

    .weapon-cases-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid #2a3f5e;
    cursor: grab;
    min-height: 30px;
    flex-shrink: 0;
    }

    .weapon-cases-header:active {
        cursor: grabbing;
    }

    .weapon-cases-panel.minimized .weapon-cases-header {
        margin-bottom: 0;
        padding-bottom: 0;
        border-bottom: none;
        cursor: grab;
    }

    .weapon-cases-panel.minimized .weapon-cases-header:active {
        cursor: grabbing;
    }

    .weapon-cases-header h3 {
    margin: 0;
    font-size: 14px;
    color: #c6d4df;
    font-weight: bold;
    pointer-events: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1 1 auto;
    padding-right: 8px;
}

    .weapon-cases-controls {
    display: flex;
    gap: 6px;
    align-items: center;
    pointer-events: auto;
    flex-wrap: wrap;
    justify-content: flex-end;
    flex-shrink: 0;
}

    .weapon-cases-controls button {
        background: #2a3f5e;
        color: #c6d4df;
        border: none;
        border-radius: 4px;
        padding: 4px 10px;
        font-size: 11px;
        cursor: pointer;
        transition: background 0.2s;
        white-space: nowrap;
    }

    .weapon-cases-controls button:hover {
        background: #3a5a7a;
    }

    .weapon-cases-controls button.active {
        background: #66c0f4;
        color: #1a2634;
    }

    .weapon-cases-controls .status {
        font-size: 11px;
        color: #8b9aab;
        pointer-events: none;
        white-space: nowrap;
    }

    .weapon-cases-controls .page-size-input {
        background: rgba(0,0,0,0.3);
        color: #c6d4df;
        border: 1px solid #2a3f5e;
        border-radius: 3px;
        padding: 2px 4px;
        width: 40px;
        font-size: 11px;
        text-align: center;
        font-family: inherit;
    }

    .weapon-cases-controls .page-size-input:focus {
        outline: none;
        border-color: #66c0f4;
    }

    .weapon-cases-controls .page-size-label {
        font-size: 11px;
        color: #8b9aab;
        pointer-events: none;
    }

    .weapon-cases-content {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: #2a3f5e transparent;
    pointer-events: auto;
    }

    .weapon-cases-panel.minimized .weapon-cases-content {
        display: none;
    }

    .weapon-cases-content::-webkit-scrollbar {
        width: 6px;
    }

    .weapon-cases-content::-webkit-scrollbar-track {
        background: transparent;
    }

    .weapon-cases-content::-webkit-scrollbar-thumb {
        background: #2a3f5e;
        border-radius: 3px;
    }

    .case-item {
        background: rgba(255,255,255,0.03);
        border: 1px solid #1a2634;
        border-radius: 6px;
        margin-bottom: 8px;
        overflow: hidden;
        transition: border-color 0.2s;
    }

    .case-item:hover {
        border-color: #2a3f5e;
    }

    .case-item-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        background: rgba(255,255,255,0.02);
        cursor: pointer;
        user-select: none;
    }

    .case-item-header:hover {
        background: rgba(255,255,255,0.04);
    }

    .case-name {
        font-size: 13px;
        font-weight: 500;
        color: #c6d4df;
        flex-shrink: 0;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 3px;
        transition: background 0.2s, color 0.2s;
    }

    .case-name:hover {
        background: rgba(42, 63, 94, 0.5);
        color: #66c0f4;
    }

    .case-name::after {
        content: ' 🔗';
        font-size: 10px;
        opacity: 0.5;
        transition: opacity 0.2s;
    }

    .case-name:hover::after {
        opacity: 1;
    }

    .case-header-right {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
    }

    .case-stats {
        display: flex;
        gap: 16px;
        font-size: 12px;
        align-items: center;
    }

    .case-stats .lowest {
        color: #8bc34a;
        font-weight: 500;
    }

    .case-stats .count {
        color: #8b9aab;
    }

    .case-stats .arrow {
        color: #8b9aab;
        font-size: 10px;
        transition: transform 0.3s;
        display: inline-block;
    }

    .case-stats .arrow.expanded {
        transform: rotate(180deg);
    }

    .case-refresh-btn {
        background: transparent;
        color: #8b9aab;
        border: 1px solid #2a3f5e;
        border-radius: 3px;
        padding: 2px 8px;
        font-size: 10px;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
        line-height: 1.4;
    }

    .case-refresh-btn:hover {
        background: #2a3f5e;
        color: #c6d4df;
    }

    .case-refresh-btn.refreshing {
        color: #8b9aab;
        cursor: not-allowed;
        opacity: 0.6;
    }

    .case-refresh-btn.refreshing::after {
        content: '';
        display: inline-block;
        width: 10px;
        height: 10px;
        margin-left: 4px;
        border: 1.5px solid #2a3f5e;
        border-top-color: #c6d4df;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
        vertical-align: middle;
    }

    .case-orders {
        display: none;
        padding: 0 10px 10px 10px;
    }

    .case-orders.expanded {
        display: block;
    }

    .case-orders table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
    }

    .case-orders th {
        text-align: left;
        padding: 4px 6px;
        color: #8b9aab;
        font-weight: normal;
        border-bottom: 1px solid #2a3f5e;
        font-size: 11px;
    }

    .case-orders td {
        padding: 3px 6px;
        border-bottom: 1px solid #1a2634;
        font-family: monospace;
    }

    .case-orders .price {
        color: #ff6b6b;
        text-align: left;
        font-weight: 500;
    }

    .case-orders .qty {
        text-align: right;
        color: #c6d4df;
    }

    .case-orders .no-data {
        text-align: center;
        padding: 16px;
        color: #8b9aab;
        font-style: italic;
    }

    .pagination {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 6px;
        padding: 8px 0 4px 0;
        border-top: 1px solid #1a2634;
        margin-top: 4px;
        flex-wrap: wrap;
    }

    .pagination button {
        background: transparent;
        color: #8b9aab;
        border: 1px solid #2a3f5e;
        border-radius: 3px;
        padding: 2px 10px;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
    }

    .pagination button:hover:not(:disabled) {
        background: #2a3f5e;
        color: #c6d4df;
    }

    .pagination button:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }

    .pagination button.active {
        background: #2a3f5e;
        color: #c6d4df;
        border-color: #3a5a7a;
    }

    .pagination .page-info {
        color: #8b9aab;
        font-size: 11px;
        padding: 0 4px;
    }

    .pagination .page-jump {
        background: rgba(0,0,0,0.3);
        color: #c6d4df;
        border: 1px solid #2a3f5e;
        border-radius: 3px;
        padding: 2px 4px;
        width: 32px;
        font-size: 11px;
        text-align: center;
        font-family: inherit;
    }

    .pagination .page-jump:focus {
        outline: none;
        border-color: #66c0f4;
    }

    .loading-spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid #2a3f5e;
        border-top-color: #c6d4df;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    .drag-handle {
        display: inline-block;
        margin-right: 6px;
        color: #4a5a6a;
        font-size: 12px;
        letter-spacing: 2px;
        pointer-events: none;
    }

    .case-item.refresh-flash {
        animation: flashBorder 0.6s ease 2;
    }

    @keyframes flashBorder {
        0% { border-color: #1a2634; }
        50% { border-color: #8bc34a; }
        100% { border-color: #1a2634; }
    }

    .no-case-match {
        text-align: center;
        padding: 20px;
        color: #8b9aab;
        font-size: 13px;
    }

    .chart-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.85);
        z-index: 10000;
        display: none;
        justify-content: center;
        align-items: center;
        padding: 40px;
        backdrop-filter: blur(8px);
    }

    .chart-overlay.active {
        display: flex;
    }

    .chart-container {
        background: rgba(27, 40, 56, 0.98);
        border: 1px solid #2a3f5e;
        border-radius: 12px;
        padding: 30px 40px 40px 40px;
        width: 90vw;
        max-width: 1400px;
        max-height: 90vh;
        position: relative;
        box-shadow: 0 20px 60px rgba(0,0,0,0.8);
    }

    .chart-close-btn {
        position: absolute;
        top: 12px;
        right: 20px;
        background: transparent;
        color: #8b9aab;
        border: none;
        font-size: 28px;
        cursor: pointer;
        transition: color 0.2s;
        font-family: inherit;
        line-height: 1;
        padding: 4px 12px;
        border-radius: 4px;
    }

    .chart-close-btn:hover {
        color: #c6d4df;
        background: rgba(255,255,255,0.05);
    }

    .chart-title {
        color: #c6d4df;
        font-size: 18px;
        font-weight: bold;
        margin-bottom: 12px;
        padding-right: 50px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
    }

    .chart-title .subtitle {
        font-size: 13px;
        font-weight: normal;
        color: #8b9aab;
    }

    .chart-time-controls {
        display: flex;
        gap: 6px;
        background: rgba(0,0,0,0.3);
        padding: 4px;
        border-radius: 6px;
        border: 1px solid #1a2634;
    }

    .chart-time-controls button {
        background: transparent;
        color: #8b9aab;
        border: none;
        border-radius: 4px;
        padding: 4px 14px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
    }

    .chart-time-controls button:hover {
        color: #c6d4df;
        background: rgba(255,255,255,0.05);
    }

    .chart-time-controls button.active {
        background: #2a3f5e;
        color: #c6d4df;
    }

    .chart-wrapper {
        width: 100%;
        height: 65vh;
        min-height: 400px;
        position: relative;
    }

    .chart-wrapper canvas {
        width: 100% !important;
        height: 100% !important;
    }

    .chart-loading {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        color: #8b9aab;
        font-size: 14px;
        flex-direction: column;
        gap: 16px;
    }

    .chart-loading .loading-spinner {
        width: 30px;
        height: 30px;
        border-width: 3px;
    }

    .chart-no-data {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100%;
        color: #8b9aab;
        font-size: 16px;
    }

    .chart-stats-summary {
        display: flex;
        gap: 30px;
        padding: 10px 0 6px 0;
        border-top: 1px solid #1a2634;
        margin-top: 8px;
        flex-wrap: wrap;
    }

    .chart-stats-summary .stat-item {
        display: flex;
        align-items: baseline;
        gap: 6px;
        font-size: 12px;
        color: #8b9aab;
    }

    .chart-stats-summary .stat-item .value {
        color: #c6d4df;
        font-weight: 500;
        font-size: 14px;
    }

    .chart-stats-summary .stat-item .value.price {
        color: #8bc34a;
    }

    .chart-stats-summary .stat-item .value.volume {
        color: #66c0f4;
    }

    .chart-open-btn {
        background: transparent;
        color: #8b9aab;
        border: 1px solid #2a3f5e;
        border-radius: 3px;
        padding: 2px 10px;
        font-size: 10px;
        cursor: pointer;
        transition: all 0.2s;
        font-family: inherit;
        line-height: 1.4;
        margin-left: 4px;
    }

    .chart-open-btn:hover {
        background: #2a3f5e;
        color: #c6d4df;
    }

    /* 自定义日期选择器样式 */
    .custom-date-range input[type="datetime-local"] {
        background: rgba(0,0,0,0.3);
        color: #c6d4df;
        border: 1px solid #2a3f5e;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 12px;
        font-family: inherit;
        width: 160px;
    }

    .custom-date-range input[type="datetime-local"]:focus {
        outline: none;
        border-color: #66c0f4;
    }

    .custom-date-range input[type="datetime-local"]::-webkit-calendar-picker-indicator {
        filter: invert(0.7);
        cursor: pointer;
    }

    .custom-date-range #apply-date-range:hover {
        background: #3a5a7a;
    }

    .custom-date-range #reset-date-range:hover {
        background: rgba(255,255,255,0.05);
        color: #c6d4df;
    }

    @keyframes fadeInMsg {
        from { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }

    /* ===== 名称容器 - 右上角角标 ===== */
    .case-name-wrapper {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 3px;
        transition: background 0.2s, color 0.2s;
        position: relative;
        flex-shrink: 0;
        max-width: 55%;
        min-width: 0;
    }

    .case-name-wrapper:hover {
        background: rgba(42, 63, 94, 0.5);
    }

    .case-name-wrapper:hover .case-name-text {
        color: #66c0f4;
    }

    .case-name-text {
        font-size: 13px;
        font-weight: 500;
        color: #c6d4df;
        transition: color 0.2s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 1;
        min-width: 0;
    }

    /* ===== 右上角角标样式 ===== */
    .case-name-wrapper .inv-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 14px;
        height: 14px;
        padding: 0 4px;
        font-size: 8px;
        font-weight: 800;
        color: #c6d4df;
        background: rgba(139, 195, 74, 0.2);
        border-radius: 8px;
        border: 1px solid rgba(139, 195, 74, 0.25);
        transition: all 0.2s ease;
        font-family: "Motiva Sans", Arial, sans-serif;
        letter-spacing: 0.2px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: -2px;
        align-self: flex-start;
        box-shadow: 0 0 8px rgba(139, 195, 74, 0.03);
    }

    .case-name-wrapper:hover .inv-badge {
        transform: scale(1.15);
        box-shadow: 0 0 16px rgba(139, 195, 74, 0.08);
    }

    .case-name-wrapper .inv-badge.empty {
        background: rgba(74, 90, 106, 0.15);
        border-color: rgba(74, 90, 106, 0.15);
        color: #4a5a6a;
        box-shadow: none;
    }

    .case-name-wrapper:hover .inv-badge.empty {
        transform: none;
        box-shadow: none;
    }

    .case-name-wrapper .inv-badge.qty-high {
        background: rgba(139, 195, 74, 0.3);
        border-color: rgba(139, 195, 74, 0.4);
        color: #8bc34a;
        box-shadow: 0 0 12px rgba(139, 195, 74, 0.05);
    }

    .case-name-wrapper .inv-badge.qty-medium {
        background: rgba(255, 193, 7, 0.2);
        border-color: rgba(255, 193, 7, 0.25);
        color: #ffd54f;
    }

    .case-name-wrapper .inv-badge.qty-low {
        background: rgba(255, 152, 0, 0.2);
        border-color: rgba(255, 152, 0, 0.25);
        color: #ffb74d;
    }

    .case-name-wrapper .inv-badge.qty-critical {
        background: rgba(244, 67, 54, 0.2);
        border-color: rgba(244, 67, 54, 0.25);
        color: #ef5350;
        animation: pulse-badge 1.5s ease-in-out infinite;
    }

    @keyframes pulse-badge {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
    }

    /* ===== 库存统计行 ===== */
    .inventory-stats {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 10px;
        margin-bottom: 6px;
        background: linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%);
        border-radius: 6px;
        border-left: 3px solid #4a5a6a;
        font-size: 12px;
        transition: all 0.3s ease;
    }

    .inventory-stats.has-stock {
        border-left-color: #8bc34a;
        background: linear-gradient(135deg, rgba(139, 195, 74, 0.08) 0%, rgba(255,255,255,0.01) 100%);
    }

    .inventory-stats .inv-icon {
        font-size: 14px;
        line-height: 1;
        opacity: 0.7;
    }

    .inventory-stats .inv-label {
        color: #8b9aab;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.3px;
        margin-right: 2px;
    }

    .inventory-stats .inv-divider {
        color: #2a3f5e;
        font-size: 14px;
        font-weight: 100;
        margin: 0 2px;
    }

    .inventory-stats .inv-status-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        margin-right: 2px;
        animation: pulse-dot 2s ease-in-out infinite;
        flex-shrink: 0;
    }

    .inventory-stats .inv-status-dot.has-stock {
        background: #8bc34a;
        box-shadow: 0 0 8px rgba(139, 195, 74, 0.3);
    }

    .inventory-stats .inv-status-dot.no-stock {
        background: #4a5a6a;
        box-shadow: none;
        animation: none;
    }

    @keyframes pulse-dot {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(0.85); }
    }

    .inv-count-badge {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 1px 6px;
        border-radius: 10px;
        font-size: 10px;
        font-weight: 500;
    }
.inv-count-badge {
    position: relative;
}
.inv-count-badge[data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translateX(-50%);
    background: rgba(27, 40, 56, 0.98);
    color: #c6d4df;
    border: 1px solid #2a3f5e;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    font-family: "Motiva Sans", Arial, sans-serif;
    line-height: 1.4;
    white-space: nowrap;
    z-index: 10005;
    pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
}

    .inv-count-badge.total {
        background: rgba(255,255,255,0.04);
        color: #c6d4df;
    }

    .inv-count-badge.tradable {
        background: rgba(139, 195, 74, 0.08);
        color: #8bc34a;
    }

    .inv-count-badge .count-num {
        font-weight: 700;
        font-size: 12px;
    }

    .inv-count-badge .count-label {
        font-weight: 400;
        opacity: 0.6;
        font-size: 9px;
    }

/* 出售中徽章可点击 */
.inv-count-badge.listing.clickable {
    cursor: pointer;
    transition: all 0.2s ease;
}
.inv-count-badge.listing.clickable:hover {
    background: rgba(102, 192, 244, 0.25);
    color: #8ed0ff;
    transform: translateY(-0.5px);
    box-shadow: 0 0 12px rgba(102, 192, 244, 0.15);
}

/* ⭐ 冷却中徽章可点击 */
.inv-count-badge.protected.clickable {
    cursor: pointer;
    transition: all 0.2s ease;
}
.inv-count-badge.protected.clickable:hover {
    background: rgba(255, 193, 7, 0.25);
    color: #ffd54f;
    transform: translateY(-0.5px);
    box-shadow: 0 0 12px rgba(255, 193, 7, 0.15);
}

    /* ===== 按钮组：上下布局 ===== */
.inv-btn-group {
    display: flex;
    flex-direction: column;      /* ⭐ 关键：垂直排列 */
    gap: 3px;                    /* 上下间距 */
    margin-left: auto;
    align-items: stretch;        /* ⭐ 按钮宽度一致（撑满容器） */
    flex-shrink: 0;
    justify-content: center;
}

.inv-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 2px 8px;
    border: none;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    letter-spacing: 0.2px;
    line-height: 1.4;
    white-space: nowrap;
    position: relative;
    min-height: 18px;            /* ⭐ 略降高度，两行不显臃肿 */
    min-width: 56px;             /* ⭐ 保证两个按钮等宽 */
    box-sizing: border-box;      /* ⭐ 保证宽度计算一致 */
}

    .inv-btn:active:not(:disabled) {
        transform: scale(0.92);
    }

    .inv-btn-sell {
        background: rgba(46, 160, 67, 0.2);
        color: #8bc34a;
        border: 1px solid rgba(139, 195, 74, 0.15);
    }

    .inv-btn-sell:hover:not(:disabled) {
        background: rgba(46, 160, 67, 0.35);
        border-color: rgba(139, 195, 74, 0.4);
        box-shadow: 0 0 20px rgba(139, 195, 74, 0.05);
        transform: translateY(-0.5px);
    }

    .inv-btn-sell:disabled {
        opacity: 0.3;
        cursor: not-allowed;
        transform: none !important;
    }

    .inv-btn-batch {
        background: rgba(30, 136, 229, 0.15);
        color: #66c0f4;
        border: 1px solid rgba(102, 192, 244, 0.12);
    }

    .inv-btn-batch:hover:not(:disabled) {
        background: rgba(30, 136, 229, 0.28);
        border-color: rgba(102, 192, 244, 0.35);
        box-shadow: 0 0 20px rgba(102, 192, 244, 0.05);
        transform: translateY(-0.5px);
    }

    .inv-btn-batch:disabled {
        opacity: 0.3;
        cursor: not-allowed;
        transform: none !important;
    }

    .inv-btn .btn-icon {
        font-size: 10px;
        line-height: 1;
    }

    .inv-btn .btn-text {
        font-size: 9px;
    }

    .inv-btn[disabled] {
        position: relative;
    }

    .inv-btn[disabled]:hover::after {
    content: attr(data-tip);
    position: absolute;
    left: calc(100% + 6px);          /* ⭐ 改到右侧弹出，避免遮挡下方按钮 */
    top: 50%;
    transform: translateY(-50%);
    background: rgba(27, 40, 56, 0.95);
    color: #8b9aab;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 9px;
    white-space: nowrap;
    border: 1px solid #2a3f5e;
    pointer-events: none;
    z-index: 100;
}

    /* ===== 名称容器 - 右上角角标 ===== */
    .case-name-wrapper {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 3px;
        transition: background 0.2s, color 0.2s;
        position: relative;
        flex-shrink: 1;  /* 允许收缩 */
        min-width: 0;    /* 允许收缩到0 */
        max-width: 55%;  /* 最大宽度限制 */
        overflow: hidden;
    }

    .case-name-wrapper:hover {
        background: rgba(42, 63, 94, 0.5);
    }

    .case-name-wrapper:hover .case-name-text {
        color: #66c0f4;
    }

    .case-name-text {
        font-size: 13px;
        font-weight: 500;
        color: #c6d4df;
        transition: color 0.2s;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 1;
        min-width: 0;
    }

    /* ===== 右上角角标样式 ===== */
    .case-name-wrapper .inv-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 14px;
        height: 14px;
        padding: 0 4px;
        font-size: 8px;
        font-weight: 800;
        color: #c6d4df;
        background: rgba(139, 195, 74, 0.2);
        border-radius: 8px;
        border: 1px solid rgba(139, 195, 74, 0.25);
        transition: all 0.2s ease;
        font-family: "Motiva Sans", Arial, sans-serif;
        letter-spacing: 0.2px;
        line-height: 1;
        flex-shrink: 0;
        margin-top: -2px;
        align-self: flex-start;
        box-shadow: 0 0 8px rgba(139, 195, 74, 0.03);
    }

    .case-name-wrapper:hover .inv-badge {
        transform: scale(1.15);
        box-shadow: 0 0 16px rgba(139, 195, 74, 0.08);
    }

    .case-name-wrapper .inv-badge.empty {
        background: rgba(74, 90, 106, 0.15);
        border-color: rgba(74, 90, 106, 0.15);
        color: #4a5a6a;
        box-shadow: none;
    }

    .case-name-wrapper:hover .inv-badge.empty {
        transform: none;
        box-shadow: none;
    }

    .case-name-wrapper .inv-badge.qty-high {
        background: rgba(139, 195, 74, 0.3);
        border-color: rgba(139, 195, 74, 0.4);
        color: #8bc34a;
        box-shadow: 0 0 12px rgba(139, 195, 74, 0.05);
    }

    .case-name-wrapper .inv-badge.qty-medium {
        background: rgba(255, 193, 7, 0.2);
        border-color: rgba(255, 193, 7, 0.25);
        color: #ffd54f;
    }

    .case-name-wrapper .inv-badge.qty-low {
        background: rgba(255, 152, 0, 0.2);
        border-color: rgba(255, 152, 0, 0.25);
        color: #ffb74d;
    }

    .case-name-wrapper .inv-badge.qty-critical {
        background: rgba(244, 67, 54, 0.2);
        border-color: rgba(244, 67, 54, 0.25);
        color: #ef5350;
        animation: pulse-badge 1.5s ease-in-out infinite;
    }

    @keyframes pulse-badge {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
    }

        /* ===== 费用悬停提示 ===== */
.fee-tooltip {
    position: fixed;
    background: rgba(27, 40, 56, 0.98);
    border: 1px solid #2a3f5e;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 11px;
    color: #c6d4df;
    z-index: 10003;
    pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
    font-family: "Motiva Sans", Arial, sans-serif;
    white-space: nowrap;
    display: none;
    line-height: 1.7;
}

.fee-tooltip .fee-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
}

.fee-tooltip .fee-label {
    color: #8b9aab;
}

.fee-tooltip .fee-buyer {
    color: #ff6b6b;
}

.fee-tooltip .fee-seller {
    color: #8bc34a;
    font-weight: bold;
}

.fee-tooltip .fee-fee {
    color: #ffd93d;
}

.fee-tooltip .fee-divider {
    height: 1px;
    background: rgba(255,255,255,0.08);
    margin: 4px 0;
}

.case-orders td.price {
    cursor: help;
}

.case-orders td.price:hover {
    background: rgba(139, 195, 74, 0.12);
    border-radius: 3px;
}
  .wear-switcher {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    margin-bottom: 6px;
    background: rgba(0,0,0,0.15);
    border-radius: 6px;
    border-left: 3px solid #66c0f4;
    flex-wrap: wrap;
}

.wear-switcher .wear-label {
    font-size: 11px;
    color: #8b9aab;
    margin-right: 2px;
    flex-shrink: 0;
}

.wear-switcher .wear-btn {
    background: transparent;
    color: #8b9aab;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
    white-space: nowrap;
}

.wear-switcher .wear-btn:hover {
    background: #2a3f5e;
    color: #c6d4df;
}

.wear-switcher .wear-btn.active {
    background: #66c0f4;
    color: #1a2634;
    border-color: #66c0f4;
    font-weight: bold;
}

.case-item.wear-loading {
    opacity: 0.6;
    pointer-events: none;
}

.name-list-pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 10px 0 4px 0;
    border-top: 1px solid #1a2634;
    margin-top: 8px;
    flex-wrap: wrap;
}

.quality-switcher {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    margin-bottom: 6px;
    background: rgba(0,0,0,0.15);
    border-radius: 6px;
    border-left: 3px solid #ffd93d;
    flex-wrap: wrap;
}

.quality-switcher .quality-label {
    font-size: 11px;
    color: #8b9aab;
    margin-right: 2px;
    flex-shrink: 0;
}

.quality-switcher .quality-btn {
    background: transparent;
    color: #8b9aab;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
    white-space: nowrap;
}

.quality-switcher .quality-btn:hover {
    background: #2a3f5e;
    color: #c6d4df;
}

.quality-switcher .quality-btn.active {
    background: #ffd93d;
    color: #1a2634;
    border-color: #ffd93d;
    font-weight: bold;
}

.name-list-pagination button {
    background: transparent;
    color: #8b9aab;
    border: 1px solid #2a3f5e;
    border-radius: 3px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
}

.name-list-pagination button:hover:not(:disabled) {
    background: #2a3f5e;
    color: #c6d4df;
}

.name-list-pagination button:disabled {
    opacity: 0.3;
    cursor: not-allowed;
}

.name-list-pagination button.active {
    background: #2a3f5e;
    color: #c6d4df;
    border-color: #3a5a7a;
}

.name-list-pagination .page-info {
    color: #8b9aab;
    font-size: 11px;
    padding: 0 4px;
}
  /* ===== 搜索栏 ===== */
.case-search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 8px 0;
    border-bottom: 1px solid #1a2634;
    margin-bottom: 8px;
    flex-wrap: wrap;
    flex-shrink: 0;
}

.case-search-input {
    flex: 1;
    min-width: 120px;
    background: rgba(0,0,0,0.3);
    color: #c6d4df;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
    transition: border-color 0.2s;
}

.case-search-input:focus {
    outline: none;
    border-color: #66c0f4;
}

.case-search-input::placeholder {
    color: #4a5a6a;
}

.case-search-clear {
    background: transparent;
    color: #8b9aab;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
    line-height: 1.2;
}

.case-search-clear:hover {
    background: #2a3f5e;
    color: #c6d4df;
}

.case-filter-group {
    display: flex;
    gap: 3px;
    background: rgba(0,0,0,0.2);
    padding: 3px;
    border-radius: 5px;
    border: 1px solid #1a2634;
}

.case-filter-btn {
    background: transparent;
    color: #8b9aab;
    border: none;
    border-radius: 3px;
    padding: 3px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
    white-space: nowrap;
}

.case-filter-btn:hover {
    color: #c6d4df;
    background: rgba(255,255,255,0.05);
}

.case-filter-btn.active {
    background: #2a3f5e;
    color: #c6d4df;
}

.case-search-result-info {
    font-size: 11px;
    color: #8b9aab;
    padding: 0 2px 6px 2px;
}

.case-search-result-info .highlight {
    color: #66c0f4;
    font-weight: 500;
}

.inv-count-badge.protected {
    background: rgba(255, 193, 7, 0.1);
    color: #ffd54f;
}

.inv-count-badge.protected.empty {
    background: rgba(74, 90, 106, 0.1);
    color: #4a5a6a;
}
    .inv-count-badge.listing {
    background: rgba(102, 192, 244, 0.1);
    color: #66c0f4;
}

.inv-count-badge.listing.empty {
    background: rgba(74, 90, 106, 0.1);
    color: #4a5a6a;
}

/* ===== 可交易徽章可点击状态 ===== */
.inv-count-badge.tradable.clickable {
    cursor: pointer;
    transition: all 0.2s ease;
}
.inv-count-badge.tradable.clickable:hover {
    background: rgba(139, 195, 74, 0.22);
    color: #a5d16c;
    transform: translateY(-0.5px);
    box-shadow: 0 0 12px rgba(139, 195, 74, 0.15);
}

/* ===== 通用物品列表弹窗 ===== */
.item-list-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 10004;
    display: flex;
    justify-content: center;
    align-items: center;
    backdrop-filter: blur(4px);
}

.item-list-dialog {
    background: rgba(27, 40, 56, 0.98);
    border: 1px solid #2a3f5e;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8);
    display: inline-flex;
    flex-direction: column;
    width: fit-content;
    min-width: 620px;          /* ⭐ 7 列需要更宽 */
    max-width: 92vw;
    max-height: 85vh;
    font-family: "Motiva Sans", Arial, sans-serif;
    color: #c6d4df;
}

.item-list-header {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid #2a3f5e;
    gap: 8px;
}

.item-list-title {
    font-size: 14px;
    font-weight: bold;
    color: #66c0f4;
    flex-shrink: 0;
}

.item-list-icon {
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    cursor: zoom-in;
    z-index: 1;
}

.item-list-icon:hover {
    transform: scale(3);
    transform-origin: left center;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    z-index: 9999;
    position: relative;
    border-radius: 4px;
}
.item-list-title {
    font-size: 14px;
    font-weight: bold;
    color: #66c0f4;
}
.item-list-close {
    background: transparent;
    color: #8b9aab;
    border: none;
    font-size: 18px;
    cursor: pointer;
    padding: 0 8px;
    border-radius: 4px;
    line-height: 1;
    font-family: inherit;
}
.item-list-close:hover {
    color: #c6d4df;
    background: rgba(255, 255, 255, 0.05);
}

.item-list-body {
    overflow-y: auto;
    flex: 1;
    max-height: 60vh;
    scrollbar-width: thin;
    scrollbar-color: #2a3f5e transparent;
}
.item-list-body::-webkit-scrollbar { width: 6px; }
.item-list-body::-webkit-scrollbar-thumb {
    background: #2a3f5e; border-radius: 3px;
}

.item-list-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}
.item-list-table th {
    position: sticky;
    top: 0;
    background: rgba(20, 30, 45, 0.98);
    color: #8b9aab;
    font-weight: normal;
    padding: 8px 12px;
    border-bottom: 1px solid #2a3f5e;
    font-size: 11px;
    z-index: 1;
}
.item-list-table td {
    padding: 6px 12px;
    border-bottom: 1px solid #1a2634;
    vertical-align: middle;
}
.item-list-table tr:hover { background: rgba(255, 255, 255, 0.03); }

.item-list-footer {
    display: flex;
    align-items: center;
    padding: 10px 20px;
    border-top: 1px solid #2a3f5e;
    gap: 8px;
    flex-wrap: wrap;
}

.item-list-page-size {
    background: rgba(0, 0, 0, 0.3);
    color: #c6d4df;
    border: 1px solid #2a3f5e;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
}
.item-list-page-size:focus { outline: none; border-color: #66c0f4; }

.item-list-pagination {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
}
.item-list-page-btn {
    background: transparent;
    color: #8b9aab;
    border: 1px solid #2a3f5e;
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.2s;
}
.item-list-page-btn:hover:not(:disabled) {
    background: #2a3f5e;
    color: #c6d4df;
}
.item-list-page-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.item-list-page-btn.active {
    background: #2a3f5e;
    color: #c6d4df;
    border-color: #3a5a7a;
}
.item-list-pagination .page-info {
    color: #8b9aab;
    font-size: 11px;
    padding: 0 4px;
}

/* 售价输入框 */
.item-list-price-input:focus {
    outline: none;
    border-color: #66c0f4 !important;
    box-shadow: 0 0 8px rgba(102, 192, 244, 0.15);
}

/* 上架按钮 */
.item-list-sell-btn:not(:disabled):hover {
    background: rgba(46, 160, 67, 0.4) !important;
    border-color: rgba(139, 195, 74, 0.5) !important;
    transform: translateY(-0.5px);
}
.item-list-sell-btn:not(:disabled):active {
    transform: scale(0.95);
}

/* ===== 通用列表：走势图按钮 ===== */
.item-list-chart-btn {
    background: transparent;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 3px 6px;
    cursor: pointer;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    vertical-align: middle;
}

.item-list-chart-btn:hover {
    background: rgba(102, 192, 244, 0.12);
    border-color: #66c0f4;
}

.item-list-chart-btn:active {
    transform: scale(0.92);
}

.item-list-chart-btn svg polyline {
    transition: stroke 0.2s;
}

.item-list-chart-btn svg circle {
    transition: fill 0.2s;
}

.item-list-chart-btn:hover svg polyline {
    stroke: #8ed0ff;
}

.item-list-chart-btn:hover svg circle {
    fill: #8ed0ff;
}

/* ===== 可点击徽章：两种视觉风格 ===== */
.inv-count-badge.tradable.clickable {
    cursor: pointer;
    transition: all 0.2s ease;
}

/* 不可堆叠（多 assetid）：绿色 + 列表图标暗示 */
.inv-count-badge.tradable.multi-asset:hover {
    background: rgba(139, 195, 74, 0.22);
    color: #a5d16c;
    transform: translateY(-0.5px);
    box-shadow: 0 0 12px rgba(139, 195, 74, 0.15);
}

/* 可堆叠（单 assetid）：蓝色 + 堆叠图标，暗示直接上架 */
.inv-count-badge.tradable.stackable {
    background: rgba(102, 192, 244, 0.12);
    color: #66c0f4;
}
.inv-count-badge.tradable.stackable:hover {
    background: rgba(102, 192, 244, 0.25);
    color: #8ed0ff;
    transform: translateY(-0.5px);
    box-shadow: 0 0 12px rgba(102, 192, 244, 0.15);
}

.inv-count-badge.tradable .stack-icon {
    font-size: 9px;
    margin-left: 2px;
    opacity: 0.7;
    line-height: 1;
}
    .stock-status-select {
    background: rgba(0,0,0,0.3);
    color: #c6d4df;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    transition: border-color 0.2s;
}
/* ===== 圆点自定义 tooltip：颜色跟随状态色 ===== */
.inv-badge-dot {
    position: relative;
    cursor: help;
}
.inv-badge-dot:hover {
    transform: scale(1.3);
    box-shadow: 0 0 16px var(--badge-color, rgba(255,255,255,0.3)) !important;
}
.inv-badge-dot:hover::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translateX(-50%);
    background: rgba(27, 40, 56, 0.98);
    color: var(--badge-color, #c6d4df);
    border: 1px solid var(--badge-color, #2a3f5e);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    font-family: "Motiva Sans", Arial, sans-serif;
    font-weight: 500;
    line-height: 1.4;
    white-space: nowrap;
    z-index: 10005;
    pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.7), 0 0 12px var(--badge-color, transparent);
}
.inv-badge-dot:hover::before {
    content: '';
    position: absolute;
    left: 50%;
    bottom: calc(100% + 3px);
    transform: translateX(-50%);
    border: 5px solid transparent;
    border-top-color: var(--badge-color, #2a3f5e);
    z-index: 10005;
    pointer-events: none;
}
.stock-status-select:focus {
    border-color: #66c0f4;
}

.stock-status-select option {
    background: #1b2838;
    color: #c6d4df;
}
.stock-status-select {
    font-weight: 500;
    letter-spacing: 0.3px;
}

/* ===== 图表标题内的下拉切换 ===== */
#chart-title-text .chart-title-select {
    background: rgba(0, 0, 0, 0.3);
    color: #66c0f4;
    border: 1px solid #2a3f5e;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 17px;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.2s;
    line-height: 1.4;
    vertical-align: middle;
    outline: none;
    margin: 0 4px;
    min-height: 32px;
    box-sizing: border-box;
}

#chart-title-text .chart-title-select:hover {
    border-color: #66c0f4;
}

#chart-title-text .chart-title-select:focus {
    border-color: #66c0f4;
    box-shadow: 0 0 8px rgba(102, 192, 244, 0.2);
}

#chart-title-text .chart-title-select option {
    background: #1b2838;
    color: #c6d4df;
}

/* ===== 通用列表：价格计算器按钮 ===== */
.item-list-fee-calc-btn {
    background: #2a3f5e;
    color: #c6d4df;
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
    transition: background 0.2s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    height: 24px;
    box-sizing: border-box;
    flex-shrink: 0;
}

.item-list-fee-calc-btn:hover {
    background: #3a5a7a;
}

.item-list-fee-calc-btn:active {
    transform: scale(0.95);
}

.item-list-refresh-btn {
    background: #2a3f5e;
    color: #c6d4df;
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.2s;
    white-space: nowrap;
    font-family: inherit;
    line-height: 1.4;
    margin-right: 6px;
    flex-shrink: 0;
}

.item-list-refresh-btn:hover {
    background: #3a5a7a;
}

.item-list-refresh-btn:active {
    transform: scale(0.95);
}
`);

// ============================================================
// ⭐ 库存状态颜色统一配置（唯一数据源）
// 所有用到库存状态颜色的地方必须从这里取值，禁止硬编码
// ============================================================
const STOCK_STATUS_COLORS = {
    all: '#8b9aab', // 全部（中性灰）
    red: '#831d1d', // 🔴 有可交易
    purple: '#6a3d8f', // 🟣 冷却+出售
    yellow: '#b8860b', // 🟡 仅冷却中
    blue: '#87ceeb', // 🔵 仅出售中
    green: '#4f8b09' // 🟢 无库存
};

// ⭐ 库存状态判定（唯一逻辑源）
// 规则：
//   有可交易:   tradable > 0
//   冷却+出售:  tradable = 0 && protected > 0 && listing > 0
//   仅冷却中:   tradable = 0 && protected > 0 && listing = 0
//   仅出售中:   tradable = 0 && protected = 0 && listing > 0
//   无库存:     三者均为 0
function getStockStatusKey(tradable, protectedCount, listing) {
    tradable = tradable || 0;
    protectedCount = protectedCount || 0;
    listing = listing || 0;

    if (tradable > 0) return 'red';
    if (protectedCount > 0 && listing > 0) return 'purple';
    if (protectedCount > 0) return 'yellow';
    if (listing > 0) return 'blue';
    return 'green';
}

// ---------- 工具函数 ----------
function formatPrice(valueInCents) {
    if (!valueInCents || valueInCents === 0) return '--';
    const symbol = getCurrencySymbol();
    const price = (valueInCents / 100).toFixed(2);
    return symbol + ' ' + price;
}

function formatPriceSimple(value) {
    if (!value || value === 0) return '--';
    const symbol = getCurrencySymbol();
    return symbol + ' ' + value.toFixed(2);
}

function getCurrencySymbol() {
    try {
        const priceEl = document.querySelector('.market_listing_price span');
        if (priceEl) {
            const text = priceEl.textContent.trim();
            const match = text.match(/^([¥$€£₽₩₴₺₡₦₱₪₫₭₮₰₲₵₶₷₸₹₹₺₻₼₽₾₿]+)/);
            if (match) {
                return match[1].trim();
            }
        }

        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.g_rgWalletInfo) {
            const walletInfo = unsafeWindow.g_rgWalletInfo;
            if (walletInfo.wallet_currency) {
                const currencyMap = {
                    1: '$',
                    2: '£',
                    3: '€',
                    4: 'R$',
                    5: '₽',
                    6: '¥',
                    7: '₩',
                    8: '₺',
                    9: '₹',
                    10: '$',
                    11: '$',
                    12: 'CHF',
                    13: 'SEK',
                    14: 'DKK',
                    15: 'NOK',
                    16: '₽',
                    17: '¥',
                    18: 'S$',
                    19: '₩',
                    20: 'R$',
                    21: '₺',
                    22: '₹',
                    23: '¥'
                };
                if (currencyMap[walletInfo.wallet_currency]) {
                    return currencyMap[walletInfo.wallet_currency];
                }
            }
        }

        const lang = document.documentElement.lang || 'zh-cn';
        if (lang.startsWith('zh')) return '¥';
        if (lang.startsWith('en')) return '$';
        if (lang.startsWith('ja')) return '¥';
        if (lang.startsWith('ko')) return '₩';
        if (lang.startsWith('ru')) return '₽';
        if (lang.startsWith('es')) return '€';
        if (lang.startsWith('pt')) return 'R$';
    } catch (e) {}

    return '¥';
}

function formatQty(value) {
    if (!value) return '0';
    return value.toLocaleString();
}

// ---------- 获取当前用户 SteamID ----------
function getMySteamId() {
    try {
        if (typeof unsafeWindow !== 'undefined') {
            if (unsafeWindow.g_rgProfileData && unsafeWindow.g_rgProfileData.steamid) {
                return unsafeWindow.g_rgProfileData.steamid;
            }
            if (unsafeWindow.g_steamID) {
                return unsafeWindow.g_steamID;
            }
        }
        const avatarLink = document.querySelector('.playerAvatar a');
        if (avatarLink) {
            const href = avatarLink.href;
            const match = href.match(/\/profiles\/(\d+)/);
            if (match) return match[1];
        }
        const profileLink = document.querySelector('.user_avatar .playerAvatar a');
        if (profileLink) {
            const href = profileLink.href;
            const match = href.match(/\/profiles\/(\d+)/);
            if (match) return match[1];
        }
        const anyLink = document.querySelector('a[href*="/profiles/"]');
        if (anyLink) {
            const match = anyLink.href.match(/\/profiles\/(\d+)/);
            if (match) return match[1];
        }
    } catch (e) {
        console.warn('获取SteamID失败:', e);
    }
    return null;
}

// ---------- 查询用户库存 ----------
function fetchUserInventory(steamId, appid, contextid) {
    return new Promise((resolve, reject) => {
        // ⭐ 加 _t 时间戳，绕过 CDN 缓存
        const url =
            'https://steamcommunity.com/inventory/' +
            steamId +
            '/' +
            appid +
            '/' +
            contextid +
            '?l=zh_cn&_t=' +
            Date.now();

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Cache-Control': 'no-cache',
                Pragma: 'no-cache'
            },
            onload: function (response) {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('解析响应失败: ' + e.message));
                    }
                } else if (response.status === 429) {
                    reject(new Error('请求过于频繁 (429)，请稍后重试'));
                } else if (response.status === 403) {
                    reject(new Error('库存为私密状态，请公开库存设置'));
                } else {
                    reject(new Error('HTTP ' + response.status + ' - ' + response.statusText));
                }
            },
            onerror: function () {
                reject(new Error('网络请求失败，请检查网络连接'));
            },
            ontimeout: function () {
                reject(new Error('请求超时，请稍后重试'));
            },
            timeout: 20000
        });
    });
}

// ---------- 查询我的市场挂单 ----------
function fetchMyListings(start, count) {
    return new Promise((resolve, reject) => {
        const url = `https://steamcommunity.com/market/mylistings?count=${count}&start=${start}`;

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                Referer: 'https://steamcommunity.com/market/'
            },
            onload: function (response) {
                if (response.status === 200) {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        reject(new Error('解析挂单响应失败: ' + e.message));
                    }
                } else if (response.status === 429) {
                    reject(new Error('请求过于频繁 (429)'));
                } else {
                    reject(new Error('HTTP ' + response.status));
                }
            },
            onerror: function () {
                reject(new Error('网络请求失败'));
            },
            ontimeout: function () {
                reject(new Error('请求超时'));
            },
            timeout: 20000
        });
    });
}

// ---------- 按 matcher 统计库存 ----------
function countInventoryItemsByMatcher(inventoryData, matcher) {
    if (!inventoryData || !inventoryData.success || !inventoryData.assets || !inventoryData.descriptions) {
        return { total: 0, tradable: 0, assetIds: [] };
    }

    var totalCount = 0;
    var tradableCount = 0;
    var assetIds = [];

    // 建立 classid+instanceid → description 映射
    var descMap = {};
    for (var i = 0; i < inventoryData.descriptions.length; i++) {
        var desc = inventoryData.descriptions[i];
        var key = desc.classid + '_' + (desc.instanceid || '0');
        descMap[key] = desc;
    }

    for (var j = 0; j < inventoryData.assets.length; j++) {
        var asset = inventoryData.assets[j];
        var key = asset.classid + '_' + (asset.instanceid || '0');
        var desc = descMap[key];

        if (desc && matcher(desc)) {
            var amount = parseInt(asset.amount, 10);
            if (isNaN(amount) || amount < 1) amount = 1;
            totalCount += amount;

            var isTradable = desc.tradable === 1 || desc.tradable === true;
            if (isTradable) {
                tradableCount += amount;
                if (asset.assetid) {
                    assetIds.push(asset.assetid);
                }
            }
        }
    }

    return { total: totalCount, tradable: tradableCount, assetIds: assetIds };
}

// ---------- 按 market_hash_name 精确统计（保留原有语义） ----------
function countInventoryItems(inventoryData, marketHashName) {
    return countInventoryItemsByMatcher(inventoryData, function (desc) {
        return desc.market_hash_name === marketHashName;
    });
}

// ---------- 判断某个 description 是否属于指定皮肤（按 name 合并） ----------
// item: WEAPON_CASES 里的对象（含 is_skin / name / base_name / qualities 等）
// desc: description 对象
function isDescriptionOfItem(desc, item) {
    if (!desc || !item) return false;
    if (!item.is_skin) {
        return desc.market_hash_name === item.market_hash_name;
    }
    var mhn = desc.market_hash_name || '';
    var basePart = mhn.replace(/\s*\([^)]+\)\s*$/, '');
    var prefixes = Object.values(QUALITY_PREFIX).filter(p => p);
    for (var i = 0; i < prefixes.length; i++) {
        if (basePart.indexOf(prefixes[i]) === 0) {
            basePart = basePart.slice(prefixes[i].length);
            break;
        }
    }
    if (item.base_name && basePart === item.base_name) return true;
    return false;
}

// ---------- 判断 desc 是否为"交易保护"（冷却中）状态 ----------
// 与"市场挂售"区分：
//   - 交易保护："⇆ 此物品正受交易保护，在...之前不能被消耗、改造或转让"
//   - 市场挂售："⇆ 该物品已在 Steam 社区市场挂售，挂售期间不可消耗或修改"
function isTradableProtected(desc) {
    if (!desc) return false;

    var ods = desc.owner_descriptions;
    if (ods && Array.isArray(ods)) {
        for (var i = 0; i < ods.length; i++) {
            var text = ods[i].value || '';
            // ⭐ 只认"交易保护"
            if (text.indexOf('交易保护') !== -1) {
                // ⭐ 关键：解析截止时间，已过期就不算冷却中
                // （parseCooldownFromOwnerDescriptions 是函数声明，会提升，可直接调用）
                var deadline = parseCooldownFromOwnerDescriptions(ods);
                if (deadline && deadline.getTime() <= Date.now()) {
                    return false; // 冷却已结束
                }
                return true;
            }
        }
    }

    // 兜底：没有 owner_descriptions 但有 market_tradable_restriction > 0
    // 也视为冷却中（极少见）
    if (!ods || ods.length === 0) {
        var days = parseInt(desc.market_tradable_restriction, 10) || 0;
        if (days > 0) return true;
    }

    return false;
}

// ---------- 统计双分区库存（支持按 name 合并皮肤） ----------
// item: WEAPON_CASES 里的对象
// 注意：protected（冷却中）只统计"交易保护"状态，排除"市场挂售"、"交易中"等
function countInventoryItemsDual(mergedData, item) {
    const result = { total: 0, tradable: 0, protected: 0, assetIds: [] };
    if (!mergedData || !mergedData.success || !item) return result;

    var matcher = function (desc) {
        return isDescriptionOfItem(desc, item);
    };

    // 1. 普通分区（total / tradable / assetIds）
    if (mergedData.normal && mergedData.normal.success) {
        const c = countInventoryItemsByMatcher(mergedData.normal, matcher);
        result.total = c.total;
        result.tradable = c.tradable;
        result.assetIds = c.assetIds;
    }

    // 2. 交易保护分区：⭐ 只统计"交易保护"状态的
    if (mergedData.protected && mergedData.protected.success) {
        const protMatcher = function (desc) {
            return isDescriptionOfItem(desc, item) && isTradableProtected(desc);
        };
        const p = countInventoryItemsByMatcher(mergedData.protected, protMatcher);
        result.protected = p.total;
    }

    return result;
}

// ---------- 精确匹配版（上架用，按 market_hash_name 精确匹配，支持双分区） ----------
function countInventoryItemsDualExact(mergedData, marketHashName) {
    const result = { total: 0, tradable: 0, protected: 0, assetIds: [] };
    if (!mergedData || !mergedData.success) return result;

    var matcher = function (desc) {
        return desc.market_hash_name === marketHashName;
    };

    if (mergedData.normal && mergedData.normal.success) {
        const c = countInventoryItemsByMatcher(mergedData.normal, matcher);
        result.total = c.total;
        result.tradable = c.tradable;
        result.assetIds = c.assetIds;
    }
    if (mergedData.protected && mergedData.protected.success) {
        // ⭐ 只统计"交易保护"的
        const protMatcher = function (desc) {
            return desc.market_hash_name === marketHashName && isTradableProtected(desc);
        };
        const p = countInventoryItemsByMatcher(mergedData.protected, protMatcher);
        result.protected = p.total;
    }
    return result;
}

// ---------- 判断某个 market_hash_name 是否为可堆叠物品 ----------
function isCommodityItem(inventoryData, marketHashName) {
    if (!inventoryData || !inventoryData.success) return false;

    // 检查普通库存
    var data = inventoryData.normal;
    if (data && data.success && data.descriptions) {
        for (var i = 0; i < data.descriptions.length; i++) {
            var desc = data.descriptions[i];
            if (desc.market_hash_name === marketHashName) {
                return desc.commodity === 1;
            }
        }
    }

    // 检查交易保护库存（如果普通库存没找到）
    var prot = inventoryData.protected;
    if (prot && prot.success && prot.descriptions) {
        for (var j = 0; j < prot.descriptions.length; j++) {
            var d = prot.descriptions[j];
            if (d.market_hash_name === marketHashName) {
                return d.commodity === 1;
            }
        }
    }

    return false;
}

function updateCheckAllState(overlay) {
    var checkAllEl = overlay.querySelector('.item-list-check-all');
    if (!checkAllEl) return;

    var allChecks = overlay.querySelectorAll('.item-list-check');
    var checkedCount = 0;
    allChecks.forEach(function (cb) {
        if (cb.checked) checkedCount++;
    });

    if (checkedCount === 0) {
        checkAllEl.checked = false;
        checkAllEl.indeterminate = false;
    } else if (checkedCount === allChecks.length) {
        checkAllEl.checked = true;
        checkAllEl.indeterminate = false;
    } else {
        // ⭐ 部分选中：显示半勾选（横杠）
        checkAllEl.checked = false;
        checkAllEl.indeterminate = true;
    }
}

// ---------- 按 market_hash_name 反查 WEAPON_CASES 条目、磨损、品质 ----------
function normalizeMhn(s) {
    if (!s) return '';
    return String(s)
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findCaseAndWearByMhn(mhn) {
    if (!mhn) return null;
    var target = normalizeMhn(mhn);
    if (!target) return null;

    for (var ci = 0; ci < WEAPON_CASES.length; ci++) {
        var c = WEAPON_CASES[ci];
        if (!c.is_skin) {
            if (normalizeMhn(c.market_hash_name) === target) {
                return { caseIndex: ci, item: c, wear: null, quality: null };
            }
        } else {
            var wears = c.wears || [];
            var qualities = c.qualities || ['normal'];
            for (var wi = 0; wi < wears.length; wi++) {
                for (var qi = 0; qi < qualities.length; qi++) {
                    if (normalizeMhn(getMarketHashName(c, wears[wi], qualities[qi])) === target) {
                        return { caseIndex: ci, item: c, wear: wears[wi], quality: qualities[qi] };
                    }
                }
            }
        }
    }
    return null;
}

// ============================================================
// 通用物品列表弹窗
// config = {
//   title:       string             弹窗标题
//   columns:     [{key,label,width,align}]  列定义（含固定列和自定义列）
//   items:       Array              数据项数组，每项可含 assetid / wear / wearRate / cooldown / ...
//   pageSize:    number             默认每页条数（默认 50）
//   pageSizes:   number[]           可选每页条数（默认 [10,50,100]）
//   rowActions:  (item, api) => {   返回 { priceInput, sellBtn, onSell }
//       priceInput: HTML字符串     '售价'列的输入框 HTML（可为空）
//       sellBtn:    HTML字符串     '操作'列的按钮 HTML（可为空）
//       bind:       (rowEl, item) => void   绑定事件
//   }
// }
// ============================================================
function showItemListDialog(config) {
    var title = config.title || '物品列表';
    var columns = config.columns || [];
    var items = config.items || [];
    var pageSizes = config.pageSizes || [10, 50, 100];
    var pageSize = config.pageSize || 50;
    var rowActions = config.rowActions || null;
    var onRefresh = config.onRefresh || null; // ⭐ 新增

    // ⭐ 批量按钮配置
    var batchModifyLabel = config.batchModifyLabel || '批量修改';
    var batchRemoveLabel = config.batchRemoveLabel || '批量撤销';
    var showBatchRemove = config.showBatchRemove !== false; // 默认 true
    // ⭐ 是否可堆叠（可堆叠时不显示价格计算器按钮）
    var isCommodity = config.isCommodity === true;

    // 计算总列数
    var totalCols = columns.length;

    var overlay = document.createElement('div');
    overlay.className = 'item-list-overlay';

    var currentPage = 1;

    function render() {
        var totalPages = Math.max(1, Math.ceil(items.length / pageSize));
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;

        var start = (currentPage - 1) * pageSize;
        var end = Math.min(start + pageSize, items.length);
        var pageItems = items.slice(start, end);

        // ---- 表头 ----
        var theadHtml =
            '<tr>' +
            columns
                .map(function (col) {
                    var style = '';
                    if (col.width) style += 'width:' + col.width + ';';
                    if (col.align) style += 'text-align:' + col.align + ';';

                    // ⭐ 复选框列：表头显示全选复选框
                    if (col.key === '__check__') {
                        return (
                            '<th style="' +
                            style +
                            '">' +
                            '<input type="checkbox" class="item-list-check-all" ' +
                            'title="全选/全不选当前页" ' +
                            'style="cursor:pointer; width:14px; height:14px; accent-color:#66c0f4;">' +
                            '</th>'
                        );
                    }

                    return '<th style="' + style + '">' + col.label + '</th>';
                })
                .join('') +
            '</tr>';

        // ---- 表体 ----
        var tbodyHtml = '';
        if (pageItems.length === 0) {
            tbodyHtml =
                '<tr><td colspan="' +
                totalCols +
                '" style="text-align:center; padding:24px; color:#8b9aab; font-style:italic;">暂无数据</td></tr>';
        } else {
            for (var i = 0; i < pageItems.length; i++) {
                var item = pageItems[i];
                var globalIdx = start + i + 1;
                var cellsHtml = '';

                for (var c = 0; c < columns.length; c++) {
                    var col = columns[c];
                    var style = '';
                    if (col.width) style += 'width:' + col.width + ';';
                    if (col.align) style += 'text-align:' + col.align + ';';

                    var cellContent = '';

                    if (col.key === '__index__') {
                        // 序号列
                        cellContent = globalIdx;
                        style += 'color:#8b9aab;';
                    } else if (col.key === '__check__') {
                        // ⭐ 复选框列
                        cellContent =
                            '<input type="checkbox" class="item-list-check" ' +
                            'data-row-index="' +
                            (start + i) +
                            '" ' +
                            'style="cursor:pointer; width:14px; height:14px; accent-color:#66c0f4;">';
                    } else if (col.key === '__assetid__') {
                        // ⭐ 物品ID列
                        cellContent =
                            '<span style="font-family:monospace; color:#c6d4df;">' + (item.assetid || '--') + '</span>';
                    } else if (col.key === 'listedAt') {
                        // 上架时间列
                        cellContent =
                            '<span style="color:#8b9aab; font-size:11px;">' + (item.listedAt || '--') + '</span>';
                    } else if (col.key === 'acquiredAt') {
                        // ⭐ 入库时间列
                        cellContent =
                            '<span style="color:#8b9aab; font-size:11px;">' + (item.acquiredAt || '--') + '</span>';
                    } else if (col.key === '__price__') {
                        // 售价输入框列（由 rowActions 决定是否提供）
                        if (rowActions && typeof rowActions.priceInput === 'function') {
                            cellContent = rowActions.priceInput(item);
                        } else if (rowActions && typeof rowActions.priceInput === 'string') {
                            cellContent = rowActions.priceInput;
                        } else {
                            cellContent = '<span style="color:#4a5a6a;">--</span>';
                        }
                    } else if (col.key === '__action__') {
                        // 操作列
                        if (rowActions && typeof rowActions.sellBtn === 'function') {
                            cellContent = rowActions.sellBtn(item);
                        } else if (rowActions && typeof rowActions.sellBtn === 'string') {
                            cellContent = rowActions.sellBtn;
                        } else {
                            cellContent = '<span style="color:#4a5a6a;">--</span>';
                        }
                    } else if (col.key === '__chart__') {
                        // ⭐ 走势图按钮（折线图 SVG）
                        cellContent =
                            '<button class="item-list-chart-btn" data-row-idx="' +
                            (start + i) +
                            '" title="查看价格走势">' +
                            '<svg width="16" height="12" viewBox="0 0 16 12" xmlns="http://www.w3.org/2000/svg">' +
                            '<polyline points="1.5,10 5,6 8.5,8 12,3 15,5" fill="none" stroke="#66c0f4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
                            '<circle cx="15" cy="5" r="1.5" fill="#66c0f4"/>' +
                            '</svg></button>';
                    } else {
                        // 自定义数据列
                        var val = item[col.key];
                        if (val === undefined || val === null || val === '') {
                            cellContent = '<span style="color:#4a5a6a;">--</span>';
                        } else {
                            cellContent = val;
                        }
                    }

                    cellsHtml += '<td style="' + style + '">' + cellContent + '</td>';
                }

                tbodyHtml += '<tr class="item-list-row" data-row-index="' + (start + i) + '">' + cellsHtml + '</tr>';
            }
        }

        // ---- 分页 ----
        var paginationHtml = '';
        if (totalPages > 1) {
            var prevDisabled = currentPage <= 1;
            var nextDisabled = currentPage >= totalPages;
            var pageButtons = '';
            var maxVisible = 7;
            var startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
            var endPage = Math.min(totalPages, startPage + maxVisible - 1);
            if (endPage - startPage < maxVisible - 1) {
                startPage = Math.max(1, endPage - maxVisible + 1);
            }
            for (var k = startPage; k <= endPage; k++) {
                var active = k === currentPage ? 'active' : '';
                pageButtons +=
                    '<button class="item-list-page-btn ' + active + '" data-page="' + k + '">' + k + '</button>';
            }
            paginationHtml = `
                <div class="item-list-pagination">
                    <button class="item-list-page-btn" data-page="${currentPage - 1}" ${prevDisabled ? 'disabled' : ''}>◀</button>
                    ${pageButtons}
                    <button class="item-list-page-btn" data-page="${currentPage + 1}" ${nextDisabled ? 'disabled' : ''}>▶</button>
                    <span class="page-info">${currentPage}/${totalPages}</span>
                </div>`;
        }

        // ---- 每页条数选择 ----
        var pageSizeOptions = pageSizes
            .map(function (n) {
                return '<option value="' + n + '"' + (n === pageSize ? ' selected' : '') + '>' + n + '</option>';
            })
            .join('');

        // ⭐ 标题右侧工具条（仅当有 __check__ 列时显示）
        var hasCheckColumn = columns.some(function (c) {
            return c.key === '__check__';
        });
        var batchToolbarHtml = '';
        var batchToolbarHtml = '';
        if (hasCheckColumn) {
            batchToolbarHtml = `
    <div class="item-list-batch-toolbar" style="display:flex; align-items:center; gap:6px;margin-right:12px;">
        <span class="item-list-batch-count" style="font-size:11px; color:#8b9aab;">已选 0 项</span>
        <button class="item-list-batch-modify-btn"
                disabled
                title="请先勾选物品并填写每行的新价格"
                style="background:rgba(46,160,67,0.15); color:#4a6a4a;
                       border:1px solid rgba(139,195,74,0.15); border-radius:4px;
                       padding:4px 12px; font-size:11px; cursor:not-allowed;
                       font-family:inherit; transition:all 0.2s;
                       min-width:70px;">${batchModifyLabel}</button>
        ${
            showBatchRemove
                ? `<button class="item-list-batch-remove-btn"
                disabled
                title="请先勾选要撤销的物品"
                style="background:rgba(220,53,69,0.15); color:#4a6a4a;
                       border:1px solid rgba(220,53,69,0.15); border-radius:4px;
                       padding:4px 12px; font-size:11px; cursor:not-allowed;
                       font-family:inherit; transition:all 0.2s;
                       min-width:70px;">${batchRemoveLabel}</button>`
                : ''
        }
    </div>`;
        }

        // ⭐ 图标 URL
        var iconUrl = config.iconUrl || '';

        // ⭐ 图标 HTML（无边框）
        var iconHtml = iconUrl
            ? '<img class="item-list-icon" src="' +
              iconUrl +
              '" alt="" ' +
              'style="width:32px; height:32px; margin-right:10px; flex-shrink:0;">'
            : '<div class="item-list-icon" style="width:32px; height:32px; margin-right:10px; flex-shrink:0; ' +
              'display:flex; align-items:center; justify-content:center; color:#4a5a6a; font-size:14px;">?</div>';

        // ⭐ 刷新按钮（仅当 onRefresh 存在时显示）
        var refreshBtnHtml = onRefresh ? '<button class="item-list-refresh-btn" title="刷新数据">🔄 刷新</button>' : '';

        // ⭐ 价格计算器按钮（仅不可堆叠显示）
        var feeCalcBtnHtml = '';
        if (!isCommodity) {
            feeCalcBtnHtml = `
                <button class="item-list-fee-calc-btn" title="打开价格计算器">
                    <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                        <rect x="2" y="1.5" width="12" height="13" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
                        <rect x="4" y="3.5" width="8" height="2.5" rx="0.5" fill="currentColor"/>
                        <circle cx="5" cy="8.5" r="0.8" fill="currentColor"/>
                        <circle cx="8" cy="8.5" r="0.8" fill="currentColor"/>
                        <circle cx="11" cy="8.5" r="0.8" fill="currentColor"/>
                        <circle cx="5" cy="11.5" r="0.8" fill="currentColor"/>
                        <circle cx="8" cy="11.5" r="0.8" fill="currentColor"/>
                        <circle cx="11" cy="11.5" r="0.8" fill="currentColor"/>
                    </svg>
                </button>`;
        }

        overlay.innerHTML = `
          <div class="item-list-dialog">
          <div class="item-list-header">
            ${iconHtml}
            <span class="item-list-title">${title}</span>
            <div style="flex:1;"></div>
            ${batchToolbarHtml}
            ${refreshBtnHtml}
            <button class="item-list-close" title="关闭">✕</button>
        </div>
        <div class="item-list-body">
            <table class="item-list-table">
                <thead>${theadHtml}</thead>
                <tbody>${tbodyHtml}</tbody>
            </table>
        </div>
                <div class="item-list-footer">
            <div style="display:flex; align-items:center; gap:6px;">
                <span style="font-size:11px; color:#8b9aab;">每页</span>
                <select class="item-list-page-size">${pageSizeOptions}</select>
                <span style="font-size:11px; color:#8b9aab;">条 (共 ${items.length} 个)</span>
            </div>
            <div style="flex:1;"></div>
            <div style="display:flex; align-items:center; gap:8px;">
                ${paginationHtml}
                ${feeCalcBtnHtml}
            </div>
        </div>
    </div>`;

        // ⭐ 刷新按钮
        var refreshBtn = overlay.querySelector('.item-list-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                // hideIconPreview();          // 清理图标预览
                overlay.remove(); // 关闭当前弹窗
                if (typeof onRefresh === 'function') {
                    onRefresh(); // 调用回调重新打开
                }
            });
        }

        // ⭐ 图标 hover 时切换到高清
        var iconEl = overlay.querySelector('.item-list-icon');
        if (iconEl && iconEl.tagName === 'IMG') {
            var lowRes = iconEl.src;
            // ⭐ 从 config 里拿高清 URL（需要外面传进来）
            var highRes = config.iconUrlHighRes || lowRes.replace(/64fx64f/, '256fx256f');

            iconEl.addEventListener('mouseenter', function () {
                if (highRes && this.src !== highRes) {
                    this.src = highRes;
                }
            });
            iconEl.addEventListener('mouseleave', function () {
                if (this.src !== lowRes) {
                    this.src = lowRes;
                }
            });
        }

        // ---- 绑定事件 ----
        var closeBtn = overlay.querySelector('.item-list-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                overlay.remove();
            });
        }

        // ⭐ 价格计算器按钮
        var feeCalcBtn = overlay.querySelector('.item-list-fee-calc-btn');
        if (feeCalcBtn) {
            feeCalcBtn.addEventListener('click', function () {
                showFeeCalculator();
            });
        }

        overlay.querySelectorAll('.item-list-page-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var p = parseInt(this.dataset.page);
                if (!isNaN(p)) {
                    currentPage = p;
                    render();
                }
            });
        });

        var pageSizeSelect = overlay.querySelector('.item-list-page-size');
        if (pageSizeSelect) {
            pageSizeSelect.addEventListener('change', function () {
                pageSize = parseInt(this.value) || 50;
                currentPage = 1;
                render();
            });
        }

        // 行内自定义事件绑定
        if (rowActions && typeof rowActions.bind === 'function') {
            var rows = overlay.querySelectorAll('.item-list-row');
            rows.forEach(function (rowEl) {
                var rowIdx = parseInt(rowEl.dataset.rowIndex);
                var item = items[rowIdx];
                if (item)
                    rowActions.bind(rowEl, item, {
                        close: function () {
                            overlay.remove();
                        }
                    });
            });
        }

        // ⭐ 批量工具条事件
        if (hasCheckColumn) {
            var batchCountEl = overlay.querySelector('.item-list-batch-count');
            var batchModifyBtn = overlay.querySelector('.item-list-batch-modify-btn');
            var batchRemoveBtn = overlay.querySelector('.item-list-batch-remove-btn');

            // ⭐ 全选/全不选
            var checkAllEl = overlay.querySelector('.item-list-check-all');
            if (checkAllEl) {
                checkAllEl.addEventListener('change', function () {
                    var checked = this.checked;
                    overlay.querySelectorAll('.item-list-check').forEach(function (cb) {
                        cb.checked = checked;
                    });
                    updateBatchBtnState();
                });

                // ⭐ 初始化状态：根据当前行勾选情况更新表头复选框
                // ⭐ 初始化状态：根据当前行勾选情况更新表头复选框
                updateCheckAllState(overlay);
            }

            if (batchCountEl && batchModifyBtn) {
                // ⭐ 收集"勾选了 + 该行价格改了"的项
                function getSelectedItemsWithPrices() {
                    var result = [];
                    overlay.querySelectorAll('.item-list-check:checked').forEach(function (cb) {
                        var rowIdx = parseInt(cb.dataset.rowIndex);
                        var rowEl = overlay.querySelector('.item-list-row[data-row-index="' + rowIdx + '"]');
                        if (!rowEl) return;

                        var priceInput = rowEl.querySelector('.item-list-price-input');
                        if (!priceInput) return;

                        var newPrice = parseFloat(priceInput.value);
                        if (isNaN(newPrice) || newPrice < 0.01) return;

                        var item = items[rowIdx];
                        if (!item) return;

                        var newCents = Math.round(newPrice * 100);
                        if (newCents === item.price) return; // 价格没变，跳过

                        result.push({
                            item: item,
                            rowIdx: rowIdx,
                            newPriceCents: newCents
                        });
                    });
                    return result;
                }

                // ⭐ 收集"勾选了"的所有项（批量撤销用，不管价格有没有改）
                function getSelectedItems() {
                    var result = [];
                    overlay.querySelectorAll('.item-list-check:checked').forEach(function (cb) {
                        var rowIdx = parseInt(cb.dataset.rowIndex);
                        var item = items[rowIdx];
                        if (item) result.push(item);
                    });
                    return result;
                }

                function updateBatchBtnState() {
                    var checkedCount = overlay.querySelectorAll('.item-list-check:checked').length;
                    batchCountEl.textContent = '已选 ' + checkedCount + ' 项';

                    // ⭐ 批量修改按钮：勾选 + 有改价
                    var validForModify = getSelectedItemsWithPrices();
                    if (validForModify.length > 0) {
                        batchModifyBtn.disabled = false;
                        batchModifyBtn.style.background = 'rgba(46,160,67,0.2)';
                        batchModifyBtn.style.color = '#8bc34a';
                        batchModifyBtn.style.borderColor = 'rgba(139,195,74,0.3)';
                        batchModifyBtn.style.cursor = 'pointer';
                        batchModifyBtn.title = '批量修改 ' + validForModify.length + ' 项';
                    } else {
                        batchModifyBtn.disabled = true;
                        batchModifyBtn.style.background = 'rgba(46,160,67,0.15)';
                        batchModifyBtn.style.color = '#4a6a4a';
                        batchModifyBtn.style.borderColor = 'rgba(139,195,74,0.15)';
                        batchModifyBtn.style.cursor = 'not-allowed';
                        batchModifyBtn.title = checkedCount === 0 ? '请先勾选物品' : '请填写每行的新价格';
                    }

                    if (batchRemoveBtn) {
                        // ⭐ 批量撤销按钮：只要勾选就可点
                        if (checkedCount > 0) {
                            batchRemoveBtn.disabled = false;
                            batchRemoveBtn.style.background = 'rgba(220,53,69,0.2)';
                            batchRemoveBtn.style.color = '#e57373';
                            batchRemoveBtn.style.borderColor = 'rgba(220,53,69,0.35)';
                            batchRemoveBtn.style.cursor = 'pointer';
                            batchRemoveBtn.title = '批量撤销 ' + checkedCount + ' 项';
                        } else {
                            batchRemoveBtn.disabled = true;
                            batchRemoveBtn.style.background = 'rgba(220,53,69,0.15)';
                            batchRemoveBtn.style.color = '#4a6a4a';
                            batchRemoveBtn.style.borderColor = 'rgba(220,53,69,0.15)';
                            batchRemoveBtn.style.cursor = 'not-allowed';
                            batchRemoveBtn.title = '请先勾选要撤销的物品';
                        }
                    }

                    // ⭐ 同步全选框状态
                    if (typeof updateCheckAllState === 'function') {
                        updateCheckAllState(overlay);
                    }
                }

                // 复选框变化
                overlay.querySelectorAll('.item-list-check').forEach(function (cb) {
                    cb.addEventListener('change', function () {
                        updateBatchBtnState();
                        updateCheckAllState(overlay); // ⭐ 新增
                    });
                });

                // 监听所有价格输入框的变化
                overlay.querySelectorAll('.item-list-price-input').forEach(function (inp) {
                    inp.addEventListener('input', updateBatchBtnState);
                });

                // ⭐ 点击"批量修改"
                batchModifyBtn.addEventListener('click', async function () {
                    if (this.disabled) return;
                    var selected = getSelectedItemsWithPrices();
                    if (selected.length === 0) return;

                    if (rowActions && typeof rowActions.onBatchModify === 'function') {
                        rowActions.onBatchModify(selected, {
                            close: function () {
                                overlay.remove();
                            }
                        });
                    } else {
                        console.warn('[showItemListDialog] rowActions.onBatchModify 未定义');
                    }
                });

                // ⭐ 点击"批量撤销"
                if (batchRemoveBtn) {
                    batchRemoveBtn.addEventListener('click', async function () {
                        if (this.disabled) return;
                        var selected = getSelectedItems();
                        if (selected.length === 0) return;

                        if (rowActions && typeof rowActions.onBatchRemove === 'function') {
                            rowActions.onBatchRemove(selected, {
                                close: function () {
                                    overlay.remove();
                                }
                            });
                        } else {
                            console.warn('[showItemListDialog] rowActions.onBatchRemove 未定义');
                        }
                    });
                }

                // 初始化
                updateBatchBtnState();
            }
        }
    }

    render();
    document.body.appendChild(overlay);

    // ⭐ 走势图按钮事件委托
    overlay.addEventListener('click', function (e) {
        var btn = e.target.closest('.item-list-chart-btn');
        if (!btn) return;
        e.stopPropagation();

        var rowIdx = parseInt(btn.dataset.rowIdx);
        var it = items[rowIdx];
        if (!it) return;

        var c = null;
        var w = null;
        var q = null;

        // ⭐ 优先用 caseIndex + wearEn 直接定位（冷却列表走这条）
        if (it.caseIndex !== undefined && it.caseIndex !== null) {
            c = WEAPON_CASES[it.caseIndex] || null;
            if (c) {
                if (c.is_skin) {
                    w = it.wearEn || null;
                    // wearEn 没解析出来时，用中文反查
                    if (!w && it.wear) {
                        for (var wi = 0; wi < (c.wears || []).length; wi++) {
                            if (getWearLabel(c, c.wears[wi]) === it.wear) {
                                w = c.wears[wi];
                                break;
                            }
                        }
                    }
                    if (!w) w = c.default_wear;
                    q = it.quality || c.default_quality || 'normal';
                } else {
                    w = null;
                    q = null;
                }
            }
        }

        // ⭐ 兜底：用 mhn 反查
        if (!c) {
            var mhn = it.mhn || it.market_hash_name;
            var found = findCaseAndWearByMhn(mhn);
            if (!found) {
                showChartMessage('⚠️ 无法匹配该物品的走势数据', 'warning');
                return;
            }
            c = found.item;
            w = found.wear;
            q = found.quality;
        }

        var mhnFinal = getMarketHashName(c, w, q);
        var chartEl = document.getElementById('chart-overlay');
        if (chartEl) chartEl.style.zIndex = '10006';

        openChart({
            appid: c.appid,
            market_hash_name: mhnFinal,
            name: c.name,
            item: c,
            wear: w,
            quality: q
        });
    });

    // 点击遮罩关闭
    overlay.addEventListener('click', function (e) {
        if (e.target === this) this.remove();
    });

    // ESC 关闭
    var escHandler = function (e) {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    return overlay;
}

// ---------- 获取第一个可交易的 assetid ----------
function getFirstTradableAssetId(inventoryData, marketHashName) {
    if (!inventoryData || !inventoryData.success || !inventoryData.assets || !inventoryData.descriptions) {
        return null;
    }

    var descMap = {};
    for (var i = 0; i < inventoryData.descriptions.length; i++) {
        var desc = inventoryData.descriptions[i];
        var key = desc.classid + '_' + (desc.instanceid || '0');
        descMap[key] = desc;
    }

    for (var j = 0; j < inventoryData.assets.length; j++) {
        var asset = inventoryData.assets[j];
        var key = asset.classid + '_' + (asset.instanceid || '0');
        var desc = descMap[key];

        if (desc && desc.market_hash_name === marketHashName) {
            var isTradable =
                desc.tradable === 1 || desc.tradable === true || desc.tradable === '1' || desc.tradable === 'true';
            if (isTradable && asset.assetid) {
                return asset.assetid;
            }
        }
    }

    return null;
}

// ---------- 获取所有挂单（缓存 60 秒） ----------
async function getAllMyListings() {
    const now = Date.now();
    if (cachedListingsData && now - listingsCacheTime < LISTINGS_CACHE_DURATION) {
        return cachedListingsData;
    }

    const result = {};
    let start = 0;
    const count = 100;

    try {
        while (true) {
            const data = await fetchMyListings(start, count);
            if (!data || !data.success) break;

            const html = data.results_html || '';
            if (!html) break;

            const doc = new DOMParser().parseFromString(html, 'text/html');

            const container = doc.querySelector('#tabContentsMyActiveMarketListingsTable');
            const rows = container
                ? container.querySelectorAll('[id^="mylisting_"]')
                : doc.querySelectorAll('[id^="mylisting_"]');

            if (rows.length === 0) break;

            // ⭐ 关键：先声明计数变量
            let validRowCount = 0;

            rows.forEach(function (row) {
                const rowId = row.getAttribute('id') || '';
                if (!/^mylisting_\d+$/.test(rowId)) return; // 排除 _image 等
                validRowCount++; // ⭐ 累加

                const link = row.querySelector('a.market_listing_item_name_link');
                if (!link) return;

                const href = link.getAttribute('href') || '';
                const mhnMatch = href.match(/\/market\/listings\/\d+\/(.+)$/);
                if (!mhnMatch) return;

                const mhn = decodeURIComponent(mhnMatch[1]).replace(/\u00A0/g, ' ');
                result[mhn] = (result[mhn] || 0) + 1;
            });

            // ⭐ 用 validRowCount 判断分页
            if (validRowCount < count) break;
            start += count;
            if (start >= 1000) break;
        }

        cachedListingsData = result;
        listingsCacheTime = now;
        return result;
    } catch (e) {
        console.warn('获取挂单失败:', e.message);
        return cachedListingsData || {};
    }
}

// ---------- 从挂单行解析上架时间 ----------
function parseListedAtFromRow(row) {
    // Steam 的挂单行里，"上架时间"通常在 .market_listing_listed_date 元素里
    // 格式可能是 "10月13日" 或 "今天" 或 "2026年10月13日" 或 "Oct 13"
    var el = row.querySelector('.market_listing_listed_date');
    if (!el) return '--';

    var text = (el.textContent || '').trim();
    if (!text) return '--';

    return text;
}

function parsePriceFromRow(row) {
    var priceEl = row.querySelector('.market_listing_price');
    if (!priceEl) return 0;

    // ⭐ 第一个 span 就是"买家支付"
    var firstSpan = priceEl.querySelector('span');
    var text = firstSpan ? firstSpan.textContent : priceEl.textContent;

    var matches = text.match(/\d[\d,]*\.?\d*/g);
    if (!matches || matches.length === 0) return 0;

    var numStr = matches[0].replace(/,/g, '');
    var val = parseFloat(numStr);
    if (isNaN(val)) return 0;

    return Math.round(val * 100);
}

// ---------- 获取我的挂单详情（含 listingid / assetid / 价格） ----------
async function fetchMyListingsDetailed() {
    var result = [];
    var start = 0;
    var count = 100;

    while (true) {
        var data = await fetchMyListings(start, count);
        if (!data || !data.success) break;

        var html = data.results_html || '';
        if (!html) break;

        var doc = new DOMParser().parseFromString(html, 'text/html');

        var container = doc.querySelector('#tabContentsMyActiveMarketListingsTable');
        var rows = container
            ? container.querySelectorAll('[id^="mylisting_"]')
            : doc.querySelectorAll('[id^="mylisting_"]');

        if (rows.length === 0) break;

        // ⭐ 声明计数变量
        var validRowCount = 0;

        rows.forEach(function (row) {
            var rowId = row.getAttribute('id') || '';
            if (!/^mylisting_\d+$/.test(rowId)) return;
            validRowCount++; // ⭐ 累加

            var listingid = rowId.replace(/^mylisting_/, '');
            var link = row.querySelector('a.market_listing_item_name_link');
            if (!link) return;

            var href = link.getAttribute('href') || '';
            var mhnMatch = href.match(/\/market\/listings\/\d+\/(.+)$/);
            if (!mhnMatch) return;

            var mhn = decodeURIComponent(mhnMatch[1]).replace(/\u00A0/g, ' ');
            var priceCents = parsePriceFromRow(row);

            result.push({
                listingid: listingid,
                market_hash_name: mhn,
                price: priceCents,
                listedAt: parseListedAtFromRow(row) // ⭐ 新增
            });
        });

        // ⭐ 用 validRowCount 判断分页
        if (validRowCount < count) break;
        start += count;
        if (start >= 1000) break;
    }

    return result;
}

// ---------- 从页面直接读取我的挂单（不调接口） ----------
function readListingsFromPage() {
    var result = [];
    var container = document.querySelector('#tabContentsMyActiveMarketListingsTable');
    if (!container) return result;

    // ⭐ 前缀匹配，且用正则严格过滤（排除 _image 等）
    var rows = container.querySelectorAll('[id^="mylisting_"]');
    rows.forEach(function (row) {
        var rowId = row.getAttribute('id') || '';
        // ⭐ 只处理纯 mylisting_数字 的行
        if (!/^mylisting_\d+$/.test(rowId)) return;
        var listingid = rowId.replace(/^mylisting_/, '');

        var link = row.querySelector('a.market_listing_item_name_link');
        if (!link) return;

        var href = link.getAttribute('href') || '';
        var mhnMatch = href.match(/\/market\/listings\/\d+\/(.+)$/);
        if (!mhnMatch) return;

        // ⭐ 统一空格（Steam 有时用 U+00A0）
        var mhn = decodeURIComponent(mhnMatch[1]).replace(/\u00A0/g, ' ');

        // 解析价格
        var priceCents = parsePriceFromRow(row);

        result.push({
            listingid: listingid,
            market_hash_name: mhn,
            price: priceCents,
            listedAt: parseListedAtFromRow(row) // ⭐ 新增
        });
    });

    return result;
}

// ---------- 从页面 DOM 读"出售中"挂单（推荐） ----------
function getActiveListingsFromPage() {
    var result = [];
    var container = document.querySelector('#tabContentsMyActiveMarketListingsTable');
    if (!container) {
        console.warn('[getActiveListingsFromPage] 未找到出售中容器');
        return result;
    }

    var rows = container.querySelectorAll('[id^="mylisting_"]');
    rows.forEach(function (row) {
        var rowId = row.getAttribute('id') || '';
        if (!/^mylisting_\d+$/.test(rowId)) return; // 排除 _image / _name
        var listingid = rowId.replace(/^mylisting_/, '');

        var link = row.querySelector('a.market_listing_item_name_link');
        if (!link) return;

        var href = link.getAttribute('href') || '';
        var mhnMatch = href.match(/\/market\/listings\/\d+\/(.+)$/);
        if (!mhnMatch) return;

        var mhn = decodeURIComponent(mhnMatch[1]).replace(/\u00A0/g, ' ');

        // 价格（第一个 span 是买家支付）
        var priceEl = row.querySelector('.market_listing_price');
        var priceCents = 0;
        if (priceEl) {
            var firstSpan = priceEl.querySelector('span');
            var text = firstSpan ? firstSpan.textContent : priceEl.textContent;
            var m = text.match(/\d[\d,]*\.?\d*/);
            if (m) priceCents = Math.round(parseFloat(m[0].replace(/,/g, '')) * 100);
        }

        result.push({
            listingid: listingid,
            market_hash_name: mhn,
            price: priceCents
        });
    });

    console.log('[getActiveListingsFromPage] 读取到', result.length, '个挂单');
    return result;
}

// ---------- 撤销挂单 ----------
function removeListing(listingid) {
    return new Promise(function (resolve, reject) {
        const sessionid = getSessionId();
        console.log('[removeListing] sessionid:', sessionid);
        console.log('[removeListing] listingid:', listingid);

        if (!sessionid) {
            reject(new Error('无法获取 sessionid'));
            return;
        }

        const cleanId = String(listingid).replace(/\D/g, '');
        const url = 'https://steamcommunity.com/market/removelisting/' + cleanId;
        console.log('[removeListing] url:', url);

        GM_xmlhttpRequest({
            method: 'POST',
            url: url,
            data: 'sessionid=' + encodeURIComponent(sessionid),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                Referer: 'https://steamcommunity.com/market/',
                Origin: 'https://steamcommunity.com'
            },
            onload: function (response) {
                console.log('[removeListing] status:', response.status);
                console.log('[removeListing] statusText:', response.statusText);
                console.log('[removeListing] responseText:', response.responseText);
                console.log('[removeListing] responseHeaders:', response.responseHeaders);

                if (response.status === 200) {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        reject(new Error('解析响应失败'));
                    }
                } else {
                    reject(new Error('HTTP ' + response.status));
                }
            },
            onerror: function () {
                reject(new Error('网络请求失败'));
            },
            ontimeout: function () {
                reject(new Error('请求超时'));
            },
            timeout: 20000
        });
    });
}

// ---------- 修改挂单价格（撤销 + 重新上架） ----------
async function modifyListingPrice(item, listing, newBuyerPriceCents) {
    console.log('[modify] 开始:', { listing, newBuyerPriceCents });

    // 1. 撤销前记录 assetIds
    cachedInventoryData = null;
    inventoryCacheTime = 0;
    const beforeInv = await getInventoryData();
    if (!beforeInv || !beforeInv.success) {
        throw new Error('撤销前无法获取库存数据');
    }

    const beforeCount = countInventoryItemsDualExact(beforeInv, listing.market_hash_name);
    const beforeSet = new Set(beforeCount.assetIds);
    console.log('[modify] 撤销前 assetIds 数量:', beforeSet.size);

    // 2. 撤销
    showChartMessage('⏳ 正在撤销旧挂单...', 'warning');
    let removeResult = null;
    let removeError = null;
    try {
        removeResult = await removeListing(listing.listingid);
        console.log('[modify] 撤销结果:', removeResult);
    } catch (e) {
        removeError = e;
        console.log('[modify] 撤销异常:', e.message);
    }

    // ⭐ 关键修改：接受 [] 和 { success: false } 的情况，只要差异集出现就继续
    const isEmptyArray = Array.isArray(removeResult) && removeResult.length === 0;
    const isSuccess = removeResult && (removeResult.success === true || removeResult.success === 1);
    const shouldContinue = isSuccess || isEmptyArray; // 空数组也继续

    if (!shouldContinue && !removeError) {
        // 有明确失败 message
        const msg = removeResult && removeResult.message ? removeResult.message : '未知错误';
        throw new Error('撤销挂单失败: ' + msg);
    }

    if (removeError && !isEmptyArray) {
        // 网络错误等，尝试走差异集
        console.log('[modify] 撤销异常，尝试用差异集判断');
    }

    // 3. 重试找差异集（撤销成功或 [] 都会走这里）
    let assetid = null;
    for (let attempt = 0; attempt < 8; attempt++) {
        showChartMessage(`⏳ 等待物品回到库存... (${attempt + 1}/8)`, 'warning');
        await new Promise(r => setTimeout(r, 1500));

        cachedInventoryData = null;
        inventoryCacheTime = 0;
        const inventoryData = await getInventoryData();
        if (!inventoryData || !inventoryData.success) continue;

        const afterCount = countInventoryItemsDualExact(inventoryData, listing.market_hash_name);
        const newAssetIds = afterCount.assetIds.filter(id => !beforeSet.has(id));

        console.log(
            `[modify] 第 ${attempt + 1} 次:`,
            `撤销前 ${beforeSet.size},`,
            `现在 ${afterCount.assetIds.length},`,
            `新增 ${newAssetIds.length}`
        );

        if (newAssetIds.length > 0) {
            assetid = newAssetIds[0];
            console.log('[modify] ⭐ 检测到撤销成功（差异集出现）');
            break;
        }
    }

    if (!assetid) {
        throw new Error('未能识别刚撤销的 assetid（等待 12 秒仍无新 assetid），请稍后在「可交易列表」中手动上架');
    }
    console.log('[modify] 找到新 assetid:', assetid);

    // 4. 计算费用并上架
    showChartMessage('⏳ 正在重新上架...', 'warning');
    const walletInfo = getWalletInfo();
    const publisherFee = parseFloat(walletInfo.wallet_publisher_fee_default) || 0.1;
    const feeInfo = calculateSteamFees(newBuyerPriceCents, walletInfo, publisherFee);

    const sessionid = getSessionId();
    if (!sessionid) throw new Error('无法获取 sessionid');

    const requestData = {
        sessionid: sessionid,
        appid: item.appid,
        contextid: '2',
        assetid: assetid,
        amount: 1,
        price: feeInfo.sellerAmount
    };
    console.log('[modify] 上架请求:', requestData);

    const sellResult = await submitSingleSell(requestData);
    console.log('[modify] 上架结果:', sellResult);

    if (!sellResult || !sellResult.success) {
        throw new Error(sellResult && sellResult.message ? sellResult.message : '重新上架失败');
    }

    return feeInfo;
}

async function showActiveListingsDialog(caseIndex) {
    var item = WEAPON_CASES[caseIndex];
    if (!item) return;

    showChartMessage('⏳ 正在获取挂单列表...', 'warning');

    var apiListings = await fetchMyListingsDetailed();
    console.log('[showActiveListingsDialog] 接口返回', apiListings.length, '条');

    // ⭐ 直接用接口全量，不再用页面白名单过滤
    var allListings = apiListings;

    // ⭐ 接口为空才回退到页面 DOM
    if (allListings.length === 0) {
        allListings = getActiveListingsFromPage();
        console.log('[showActiveListingsDialog] 接口为空，回退到页面 DOM:', allListings.length, '条');
    }

    // 筛选出属于当前物品的挂单（按 name 合并）
    var itemListings = [];
    var wears = item.is_skin ? item.wears || [] : [null];
    var qualities = item.is_skin ? item.qualities || ['normal'] : ['normal'];

    for (var wi = 0; wi < wears.length; wi++) {
        for (var qi = 0; qi < qualities.length; qi++) {
            var mhn = getMarketHashName(item, wears[wi], qualities[qi]);
            allListings.forEach(function (l) {
                if (l.market_hash_name === mhn) {
                    var wearZh = item.is_skin ? WEAR_LABELS[wears[wi]] || wears[wi] : '--';
                    itemListings.push({
                        listingid: l.listingid,
                        wear: wearZh,
                        price: l.price,
                        listedAt: l.listedAt || '--', // ⭐ 新增
                        market_hash_name: mhn,
                        mhn: mhn, // ⭐ 补上，图表反查用
                        caseIndex: caseIndex // ⭐ 新增
                    });
                }
            });
        }
    }

    if (itemListings.length === 0) {
        showChartMessage('⚠️ 没有出售中的 ' + item.name, 'warning');
        return;
    }

    var symbol = getCurrencySymbol();
    var displayName = item.name;

    // 列定义：挂单ID / 磨损度 / 出售价格 / 操作
    // ⭐ 判断是否可堆叠（用 default_wear 的 mhn 探测）
    var probeWear = item.is_skin ? item.default_wear : null;
    var probeQuality = item.is_skin ? item.default_quality || 'normal' : 'normal';
    var probeMhn = getMarketHashName(item, probeWear, probeQuality);
    var invForProbe = await getInventoryData();
    var isCommodity = invForProbe && invForProbe.success ? isCommodityItem(invForProbe, probeMhn) : false;

    var columns;
    if (isCommodity) {
        // ⭐ 可堆叠：复选框 / 挂单ID / 上架时间 / 出售价格 / 操作
        columns = [
            { key: '__check__', label: '☑', width: '36px', align: 'center' },
            { key: 'listingid', label: '挂单ID', align: 'left' },
            { key: 'listedAt', label: '上架时间', width: '140px', align: 'center' },
            { key: '__price__', label: '出售价格 (' + symbol + ')', width: '120px', align: 'center' },
            { key: '__action__', label: '操作', width: '140px', align: 'center' }
        ];
    } else {
        // ⭐ 不可堆叠：复选框 / 挂单ID / 磨损度 / 上架时间 / 出售价格 / 操作
        columns = [
            { key: '__check__', label: '☑', width: '36px', align: 'center' },
            { key: 'listingid', label: '挂单ID', align: 'left' },
            { key: 'wear', label: '磨损度', width: '100px', align: 'center' },
            { key: '__chart__', label: '走势', width: '52px', align: 'center' }, // ⭐ 新增
            { key: 'listedAt', label: '上架时间', width: '140px', align: 'center' },
            { key: '__price__', label: '出售价格 (' + symbol + ')', width: '120px', align: 'center' },
            { key: '__action__', label: '操作', width: '140px', align: 'center' }
        ];
    }

    var rowActions = {
        priceInput: function (rowItem) {
            // ⭐ 计算卖家实收
            var walletInfo = getWalletInfo();
            var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;
            var feeInfo = calculateSteamFees(rowItem.price, walletInfo, publisherFee);
            var sellerText = formatPrice(feeInfo.sellerAmount);

            // ⭐ 同时渲染 span 和 input，初始只显示 span
            return `<div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
            <span class="item-list-price-text"
                data-listingid="${rowItem.listingid}"
                style="cursor:pointer; color:#8bc34a; font-weight:500;"
                title="点击修改价格">${formatPrice(rowItem.price)}</span><input type="number" step="0.01" min="0.01"
                class="item-list-price-input"
                data-listingid="${rowItem.listingid}"
                value="${(rowItem.price / 100).toFixed(2)}"
                style="display:none; width:90px; padding:3px 6px; background:rgba(0,0,0,0.3);
                       color:#c6d4df; border:1px solid #2a3f5e; border-radius:3px;
                       font-size:11px; font-family:inherit; text-align:center;
                       box-sizing:border-box;">
            <span class="item-list-seller-text" style="font-size:10px; color:#8b9aab;" title="扣除手续费后实际到账">实收 ${sellerText}</span>
        </div>`;
        },
        sellBtn: function (rowItem) {
            return `
        <button class="item-list-modify-btn"
                data-listingid="${rowItem.listingid}"
                disabled
                title="请先修改价格"
                style="background:rgba(46,160,67,0.15); color:#4a6a4a;
                       border:1px solid rgba(139,195,74,0.15); border-radius:4px;
                       padding:3px 10px; font-size:11px; cursor:not-allowed;
                       font-family:inherit; transition:all 0.2s;
                       min-width:54px;">✔ 修改</button>
        <button class="item-list-remove-btn"
                data-listingid="${rowItem.listingid}"
                title="撤销该挂单"
                style="background:rgba(220,53,69,0.15); color:#e57373;
                       border:1px solid rgba(220,53,69,0.25); border-radius:4px;
                       padding:3px 10px; font-size:11px; cursor:pointer;
                       font-family:inherit; transition:all 0.2s;
                       min-width:54px; margin-left:4px;">✖ 撤销</button>`;
        },
        bind: function (rowEl, rowItem, api) {
            var priceText = rowEl.querySelector('.item-list-price-text');
            var priceInput = rowEl.querySelector('.item-list-price-input');
            var modifyBtn = rowEl.querySelector('.item-list-modify-btn');
            if (!priceText || !priceInput || !modifyBtn) return;

            var currentPriceCents = rowItem.price;

            // ⭐ 点击价格文本 → 隐藏 span，显示 input
            priceText.addEventListener('click', function () {
                priceText.style.display = 'none';
                priceInput.style.display = 'inline-block';
                priceInput.value = (currentPriceCents / 100).toFixed(2);
                priceInput.focus();
                priceInput.select();
            });

            // input 内容变化时，更新按钮状态
            function updateBtnState() {
                var val = parseFloat(priceInput.value);
                var valid = !isNaN(val) && val >= 0.01;
                if (valid && Math.round(val * 100) !== currentPriceCents) {
                    modifyBtn.disabled = false;
                    modifyBtn.style.background = 'rgba(46,160,67,0.2)';
                    modifyBtn.style.color = '#8bc34a';
                    modifyBtn.style.borderColor = 'rgba(139,195,74,0.3)';
                    modifyBtn.style.cursor = 'pointer';
                    modifyBtn.title = '修改价格为 ' + symbol + ' ' + val.toFixed(2);
                } else {
                    modifyBtn.disabled = true;
                    modifyBtn.style.background = 'rgba(46,160,67,0.15)';
                    modifyBtn.style.color = '#4a6a4a';
                    modifyBtn.style.borderColor = 'rgba(139,195,74,0.15)';
                    modifyBtn.style.cursor = 'not-allowed';
                    modifyBtn.title = valid ? '价格未变化' : '请先填写售价';
                }

                // ⭐ 新增：更新"实收"文字
                var sellerEl = rowEl.querySelector('.item-list-seller-text');
                if (sellerEl) {
                    if (valid) {
                        var walletInfo = getWalletInfo();
                        var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;
                        var feeInfo = calculateSteamFees(Math.round(val * 100), walletInfo, publisherFee);
                        sellerEl.textContent = '实收 ' + formatPrice(feeInfo.sellerAmount);
                    } else {
                        sellerEl.textContent = '实收 --';
                    }
                }
            }

            priceInput.addEventListener('input', updateBtnState);

            priceInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !modifyBtn.disabled) {
                    modifyBtn.click();
                }
                e.stopPropagation();
            });

            // ---------- 输入框失焦 → 切回价格文本，但保留 input.value ----------
            priceInput.addEventListener('blur', function () {
                setTimeout(function () {
                    priceInput.style.display = 'none';
                    priceText.style.display = 'inline-block';

                    // ⭐ 用 input 里的实际值，不用 currentPriceCents
                    var val = parseFloat(priceInput.value);
                    if (!isNaN(val) && val >= 0.01) {
                        priceText.textContent = symbol + ' ' + val.toFixed(2);
                    } else {
                        // 无效值才恢复原价
                        priceText.textContent = formatPrice(currentPriceCents);
                        priceInput.value = (currentPriceCents / 100).toFixed(2);
                    }
                }, 150);
            });

            // 修改按钮点击 → 撤销 + 重新上架
            modifyBtn.addEventListener('click', async function () {
                if (this.disabled) return;

                var newBuyerPrice = parseFloat(priceInput.value);
                if (isNaN(newBuyerPrice) || newBuyerPrice < 0.01) return;
                var newBuyerPriceCents = Math.round(newBuyerPrice * 100);

                api.close();

                try {
                    var feeInfo = await modifyListingPrice(item, rowItem, newBuyerPriceCents);
                    showChartMessage(
                        '✅ 修改成功！\n' +
                            '新买家支付: ' +
                            symbol +
                            ' ' +
                            (feeInfo.buyerPrice / 100).toFixed(2) +
                            '\n' +
                            '卖家实收: ' +
                            symbol +
                            ' ' +
                            (feeInfo.sellerAmount / 100).toFixed(2),
                        'warning'
                    );

                    setTimeout(function () {
                        var refreshBtn = document.getElementById('refresh-cases');
                        if (refreshBtn) refreshBtn.click();

                        setTimeout(function () {
                            showActiveListingsDialog(WEAPON_CASES.indexOf(item));
                        }, 1500);
                    }, 500);
                } catch (e) {
                    showChartMessage('❌ 修改失败: ' + e.message, 'error');
                }
            });

            // ⭐ 撤销按钮
            var removeBtn = rowEl.querySelector('.item-list-remove-btn');
            if (removeBtn) {
                removeBtn.addEventListener('click', async function () {
                    var listingid = this.dataset.listingid;
                    if (!listingid) return;

                    // 确认
                    if (!confirm('确定要撤销挂单 ' + listingid + ' 吗？\n撤销后物品会回到库存。')) {
                        return;
                    }

                    // 禁用按钮，防重复点击
                    this.disabled = true;
                    this.style.opacity = '0.5';
                    this.textContent = '撤销中...';

                    try {
                        showChartMessage('⏳ 正在撤销挂单...', 'warning');

                        var result = await removeListing(listingid);
                        console.log('[removeBtn] 撤销结果:', result);

                        // Steam 返回 [] 或 {success:true} 都视为可能成功
                        var isSuccess =
                            (result && result.success === true) || (Array.isArray(result) && result.length === 0);

                        if (isSuccess) {
                            showChartMessage('✅ 撤销成功，物品已回到库存', 'warning');

                            // ⭐ 关闭当前弹窗
                            api.close();

                            // ⭐ 刷新主面板 + 重新打开列表
                            setTimeout(function () {
                                var refreshBtn = document.getElementById('refresh-cases');
                                if (refreshBtn) refreshBtn.click();

                                setTimeout(function () {
                                    showActiveListingsDialog(WEAPON_CASES.indexOf(item));
                                }, 1500);
                            }, 500);
                        } else {
                            var msg = result && result.message ? result.message : '未知错误';
                            showChartMessage('❌ 撤销失败: ' + msg, 'error');

                            // 恢复按钮
                            this.disabled = false;
                            this.style.opacity = '1';
                            this.textContent = '✖ 撤销';
                        }
                    } catch (e) {
                        console.error('[removeBtn] 撤销异常:', e);
                        showChartMessage('❌ 撤销异常: ' + e.message, 'error');

                        // 恢复按钮
                        this.disabled = false;
                        this.style.opacity = '1';
                        this.textContent = '✖ 撤销';
                    }
                });
            }
        },
        // ⭐ 批量修改回调
        onBatchModify: async function (selected, api) {
            // selected: [{ item, rowIdx, newPriceCents }, ...]
            if (!selected || selected.length === 0) return;

            if (
                !confirm(
                    '确定要批量修改选中的 ' + selected.length + ' 项吗？\n\n每个物品都会先撤销，再以各自的新价格上架。'
                )
            ) {
                return;
            }

            api.close();

            var successCount = 0;
            var failCount = 0;

            for (var i = 0; i < selected.length; i++) {
                var entry = selected[i];
                var listing = entry.item;
                var newPriceCents = entry.newPriceCents;
                var newPriceText = symbol + ' ' + (newPriceCents / 100).toFixed(2);

                showChartMessage(
                    '⏳ 批量修改中... (' +
                        (i + 1) +
                        '/' +
                        selected.length +
                        ')\n' +
                        '挂单ID: ' +
                        listing.listingid +
                        '\n' +
                        '新价格: ' +
                        newPriceText,
                    'warning'
                );

                try {
                    await modifyListingPrice(item, listing, newPriceCents);
                    successCount++;
                    console.log('[批量修改] 成功:', listing.listingid, '→', newPriceText);
                } catch (e) {
                    failCount++;
                    console.error('[批量修改] 失败:', listing.listingid, e.message);
                }

                if (i < selected.length - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            showChartMessage(
                '✅ 批量修改完成\n' + '成功: ' + successCount + ' 项\n' + '失败: ' + failCount + ' 项',
                failCount > 0 ? 'error' : 'warning'
            );

            setTimeout(function () {
                var refreshBtn = document.getElementById('refresh-cases');
                if (refreshBtn) refreshBtn.click();

                setTimeout(function () {
                    showActiveListingsDialog(WEAPON_CASES.indexOf(item));
                }, 1500);
            }, 500);
        },

        // ---------- 批量撤销回调 ----------
        onBatchRemove: async function (selectedItems, api) {
            if (!selectedItems || selectedItems.length === 0) return;

            if (!confirm('确定要批量撤销选中的 ' + selectedItems.length + ' 项吗？\n\n撤销后物品会回到库存。')) {
                return;
            }

            api.close();

            var successCount = 0;
            var failCount = 0;

            for (var i = 0; i < selectedItems.length; i++) {
                var listing = selectedItems[i];

                showChartMessage(
                    '⏳ 批量撤销中... (' +
                        (i + 1) +
                        '/' +
                        selectedItems.length +
                        ')\n' +
                        '挂单ID: ' +
                        listing.listingid,
                    'warning'
                );

                try {
                    var result = await removeListing(listing.listingid);
                    console.log('[批量撤销] 结果:', listing.listingid, result);

                    var isSuccess =
                        (result && result.success === true) || (Array.isArray(result) && result.length === 0);

                    if (isSuccess) {
                        successCount++;
                    } else {
                        failCount++;
                        console.error('[批量撤销] 失败:', listing.listingid, result);
                    }
                } catch (e) {
                    failCount++;
                    console.error('[批量撤销] 异常:', listing.listingid, e.message);
                }

                // ⭐ 每项间隔 0.5 秒，避免限流
                if (i < selectedItems.length - 1) {
                    await new Promise(r => setTimeout(r, 800));
                }
            }

            showChartMessage(
                '✅ 批量撤销完成\n' + '成功: ' + successCount + ' 项\n' + '失败: ' + failCount + ' 项',
                failCount > 0 ? 'error' : 'warning'
            );

            // ⭐ 刷新主面板 + 重新打开列表
            setTimeout(function () {
                var refreshBtn = document.getElementById('refresh-cases');
                if (refreshBtn) refreshBtn.click();

                setTimeout(function () {
                    showActiveListingsDialog(WEAPON_CASES.indexOf(item));
                }, 1500);
            }, 500);
        }
    };

    showItemListDialog({
        title: displayName + ' - 出售中',
        iconUrl: getItemIconUrl(item),
        iconUrlHighRes: getItemIconUrl(item, '256fx256f'),
        columns: columns,
        items: itemListings,
        pageSize: 50,
        pageSizes: [10, 50, 100],
        rowActions: rowActions,
        isCommodity: isCommodity, // ⭐ 新增
        onRefresh: function () {
            // ⭐ 清挂单缓存，强制重新请求 /mylistings
            cachedListingsData = null;
            listingsCacheTime = 0;
            // ⭐ 清库存缓存（用于判断可堆叠、图标、资产校验）
            cachedInventoryData = null;
            inventoryCacheTime = 0;
            showActiveListingsDialog(caseIndex);
        }
    });
}

// ---------- 统计某个 market_hash_name 的出售中数量 ----------
function countListingsByHashName(listingsMap, marketHashName) {
    if (!listingsMap || !marketHashName) return 0;
    return listingsMap[marketHashName] || 0;
}

// ---------- 按 item 统计出售中数量（皮肤跨磨损/品质累加） ----------
function countListingsByItem(listingsMap, item) {
    if (!listingsMap || !item) return 0;

    // 非皮肤：按 market_hash_name 精确
    if (!item.is_skin) {
        return countListingsByHashName(listingsMap, item.market_hash_name);
    }

    // 皮肤：遍历所有 磨损 × 品质 组合，累加
    var total = 0;
    var wears = item.wears || [];
    var qualities = item.qualities || ['normal'];

    for (var wi = 0; wi < wears.length; wi++) {
        for (var qi = 0; qi < qualities.length; qi++) {
            var mhn = getMarketHashName(item, wears[wi], qualities[qi]);
            total += countListingsByHashName(listingsMap, mhn);
        }
    }
    return total;
}

// ============================================================
// 修改 getInventoryData - 加载完成后更新状态
// ============================================================

async function getInventoryData() {
    const steamId = getMySteamId();
    if (!steamId) {
        console.warn('未获取到SteamID，请确保已登录Steam');
        return null;
    }

    const now = Date.now();
    if (cachedInventoryData && now - inventoryCacheTime < INVENTORY_CACHE_DURATION) {
        return cachedInventoryData;
    }

    try {
        // 同时拉取普通库存和交易保护库存
        const [normalData, protectedData] = await Promise.all([
            fetchUserInventory(steamId, 730, 2).catch(() => null),
            fetchUserInventory(steamId, 730, 16).catch(() => null)
        ]);

        if (!normalData || !normalData.success) {
            console.warn('普通库存拉取失败');
            return null;
        }

        // 合并结果：普通库存为主，交易保护单独存
        const merged = {
            success: true,
            normal: normalData,
            protected: protectedData && protectedData.success ? protectedData : null
        };

        cachedInventoryData = merged;
        inventoryCacheTime = now;

        return merged;
    } catch (e) {
        console.error('获取库存失败:', e.message);
        return null;
    }
}

// ---------- 调试工具：检查特定物品的库存 ----------
function debugInventoryItem(marketHashName) {
    if (!cachedInventoryData) {
        console.log('⚠️ 库存数据尚未加载，请先刷新页面或点击刷新按钮');
        return;
    }

    var data = cachedInventoryData;
    if (!data.success) {
        console.log('❌ 库存数据无效');
        return;
    }

    console.log('🔍 查找物品: ' + marketHashName);

    // 建立映射
    var descMap = {};
    for (var i = 0; i < data.descriptions.length; i++) {
        var desc = data.descriptions[i];
        var key = desc.classid + '_' + (desc.instanceid || '0');
        descMap[key] = desc;
    }

    var totalCount = 0;
    var tradableCount = 0;
    var matchedAssets = [];

    for (var j = 0; j < data.assets.length; j++) {
        var asset = data.assets[j];
        var key = asset.classid + '_' + (asset.instanceid || '0');
        var desc = descMap[key];

        if (desc && desc.market_hash_name === marketHashName) {
            var amount = parseInt(asset.amount, 10) || 1;
            totalCount += amount;
            matchedAssets.push({
                assetid: asset.assetid,
                amount: amount,
                tradable: desc.tradable === 1 || desc.tradable === true
            });
            if (desc.tradable === 1 || desc.tradable === true) {
                tradableCount += amount;
            }
        }
    }

    console.log('📊 匹配结果:');
    console.log('  总库存:', totalCount);
    console.log('  可交易库存:', tradableCount);
    console.log('  匹配的资产:', matchedAssets);

    return { total: totalCount, tradable: tradableCount, assets: matchedAssets };
}

// 暴露到全局
window.__debugInventoryItem = function (marketHashName) {
    if (!cachedInventoryData) {
        console.log('⚠️ 库存数据尚未加载');
        return;
    }
    const c = countInventoryItemsDualExact(cachedInventoryData, marketHashName);
    console.log('🔍 查找物品:', marketHashName);
    console.log('  普通库存总数:', c.total);
    console.log('  可交易:', c.tradable);
    console.log('  冷却中:', c.protected);
    console.log('  可交易 assetid:', c.assetIds);
    return c;
};

// ---------- 格式化日期为 YYYY/M/D HH时 ----------
function formatChartLabel(timeStr) {
    try {
        const date = new Date(timeStr);
        if (!isNaN(date.getTime())) {
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const hours = date.getHours();
            return year + '/' + month + '/' + day + ' ' + hours + '时';
        }

        const match = timeStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
        if (match) {
            return match[1] + '/' + match[2] + '/' + match[3] + ' ' + parseInt(match[4]) + '时';
        }

        if (/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}时$/.test(timeStr)) {
            return timeStr;
        }

        const match2 = timeStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
        if (match2) {
            return match2[1] + '/' + match2[2] + '/' + match2[3] + ' ' + parseInt(match2[4]) + '时';
        }

        return timeStr;
    } catch (e) {
        return timeStr;
    }
}

// ---------- API 请求 ----------
function fetchOrderBook(appid, marketHashName) {
    return new Promise((resolve, reject) => {
        const qp = JSON.stringify([appid, marketHashName]);
        const url =
            'https://steamcommunity.com/market/orderbook' +
            '?q=Load' +
            '&cc=US' +
            '&l=english' +
            '&currency=1' +
            '&qp=' +
            encodeURIComponent(qp);

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                Accept: 'application/json, text/plain, */*',
                'x-valve-request-type': 'queryAction',
                Referer:
                    'https://steamcommunity.com/market/listings/' + appid + '/' + encodeURIComponent(marketHashName)
            },
            onload: function (response) {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('解析响应失败: ' + e.message));
                    }
                } else {
                    reject(new Error('HTTP ' + response.status));
                }
            },
            onerror: function (error) {
                reject(new Error('网络请求失败'));
            },
            ontimeout: function () {
                reject(new Error('请求超时'));
            },
            timeout: 30000
        });
    });
}

// ---------- 获取价格历史数据 ----------
function fetchPriceHistory(appid, marketHashName) {
    return new Promise((resolve, reject) => {
        const url =
            'https://steamcommunity.com/market/pricehistory/?appid=' +
            appid +
            '&market_hash_name=' +
            encodeURIComponent(marketHashName);

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                Accept: 'application/json'
            },
            onload: function (response) {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('解析响应失败: ' + e.message));
                    }
                } else {
                    reject(new Error('HTTP ' + response.status));
                }
            },
            onerror: function (error) {
                reject(new Error('网络请求失败'));
            },
            ontimeout: function () {
                reject(new Error('请求超时'));
            },
            timeout: 30000
        });
    });
}

// ---------- 解析订单数据 ----------
function parseOrderBook(data) {
    // Steam 返回嵌套结构: { data: { success: true, data: { ... } } }
    const inner = data && data.data;
    if (!inner || !inner.success || !inner.data) {
        return { sellOrders: [], lowestSell: 0, sellCount: 0 };
    }

    const orderData = inner.data;
    const sellOrders = [];

    if (orderData.rgCompactSellOrders) {
        for (let i = 0; i < orderData.rgCompactSellOrders.length; i += 2) {
            const price = parseInt(orderData.rgCompactSellOrders[i], 10);
            const qty = parseInt(orderData.rgCompactSellOrders[i + 1], 10);
            if (!isNaN(price) && !isNaN(qty) && price > 0) {
                sellOrders.push([price, qty]);
            }
        }
    }

    sellOrders.sort((a, b) => a[0] - b[0]);

    return {
        sellOrders: sellOrders,
        lowestSell: orderData.amtMinSellOrder || 0,
        sellCount: orderData.cSellOrders || 0
    };
}

// ---------- 分页工具 ----------
function paginateOrders(sellOrders, pageSize, currentPage) {
    const totalPages = Math.ceil(sellOrders.length / pageSize);
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, sellOrders.length);
    const pageData = sellOrders.slice(startIndex, endIndex);
    return {
        pageData: pageData,
        totalPages: totalPages,
        currentPage: currentPage,
        startIndex: startIndex,
        endIndex: endIndex,
        totalCount: sellOrders.length
    };
}

// ---------- 拖拽功能 ----------
function makeDraggable(element) {
    let isDragging = false;
    let startX, startY, initialX, initialY;

    const header = element.querySelector('.weapon-cases-header');
    if (!header) return;

    const rect = element.getBoundingClientRect();
    initialX = rect.left;
    initialY = rect.top;

    function onStart(e) {
        if (e.target.closest('.weapon-cases-controls')) return;
        if (e.target.closest('button')) return;
        if (e.target.closest('input')) return;
        if (e.target.closest('a')) return;

        isDragging = true;
        const touch = e.touches ? e.touches[0] : e;

        startX = touch.clientX;
        startY = touch.clientY;

        const rect = element.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        element.classList.add('dragging');
        document.body.style.userSelect = 'none';

        e.preventDefault();
    }

    function onMove(e) {
        if (!isDragging) return;

        const touch = e.touches ? e.touches[0] : e;
        const deltaX = touch.clientX - startX;
        const deltaY = touch.clientY - startY;

        const newX = Math.max(0, Math.min(window.innerWidth - element.offsetWidth, initialX + deltaX));
        const newY = Math.max(0, Math.min(window.innerHeight - element.offsetHeight, initialY + deltaY));

        element.style.left = newX + 'px';
        element.style.top = newY + 'px';
        element.style.right = 'auto';

        e.preventDefault();
    }

    function onEnd(e) {
        if (!isDragging) return;

        isDragging = false;
        element.classList.remove('dragging');
        document.body.style.userSelect = '';

        try {
            const rect = element.getBoundingClientRect();
            localStorage.setItem('weaponCasesPanelX', rect.left);
            localStorage.setItem('weaponCasesPanelY', rect.top);
        } catch (err) {}
    }

    header.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);

    header.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);

    try {
        const savedX = localStorage.getItem('weaponCasesPanelX');
        const savedY = localStorage.getItem('weaponCasesPanelY');
        if (savedX !== null && savedY !== null) {
            const x = parseFloat(savedX);
            const y = parseFloat(savedY);
            if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
                element.style.left = x + 'px';
                element.style.top = y + 'px';
                element.style.right = 'auto';
            }
        }
    } catch (err) {}

    window.addEventListener('resize', function () {
        const rect = element.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            element.style.left = Math.max(0, window.innerWidth - element.offsetWidth - 20) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            element.style.top = Math.max(0, window.innerHeight - element.offsetHeight - 20) + 'px';
        }
    });
}

// ---------- 调整图表高度 ----------
function adjustChartHeight() {
    try {
        const chartWrappers = document.querySelectorAll('.recharts-wrapper');
        chartWrappers.forEach(function (wrapper) {
            if (wrapper.style) {
                wrapper.style.minHeight = '600px';
            }
        });
        const charts = document.querySelectorAll('[class*="recharts-wrapper"]');
        charts.forEach(function (chart) {
            if (chart.style) {
                chart.style.minHeight = '600px';
            }
        });
        const rechartsContainers = document.querySelectorAll('.recharts-surface, .recharts-responsive-container');
        rechartsContainers.forEach(function (container) {
            const parent = container.closest('div');
            if (parent && parent.style) {
                parent.style.minHeight = '600px';
            }
        });
    } catch (e) {}
}

// ============================================================
// ============ 图表功能 ======================================
// ============================================================

let chartOverlay = null;
let chartCanvas = null;

// ---------- 显示图表提示信息 ----------
function showChartMessage(message, type) {
    var existingMsg = document.getElementById('chart-message');
    if (existingMsg) {
        existingMsg.remove();
    }

    var msgDiv = document.createElement('div');
    msgDiv.id = 'chart-message';
    msgDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(27, 40, 56, 0.98);
        border: 2px solid ${type === 'error' ? '#ff6b6b' : '#ffd93d'};
        border-radius: 12px;
        padding: 30px 40px;
        z-index: 10020;
        color: #c6d4df;
        font-family: "Motiva Sans", Arial, sans-serif;
        font-size: 16px;
        text-align: center;
        max-width: 500px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.9);
        animation: fadeInMsg 0.3s ease;
    `;
    msgDiv.innerHTML = `
        <div style="font-size: 32px; margin-bottom: 12px;">${type === 'error' ? '❌' : '⚠️'}</div>
        <div>${message}</div>
        <button id="close-chart-msg" style="
            margin-top: 20px;
            background: ${type === 'error' ? '#2a3f5e' : '#3a5a7a'};
            color: #c6d4df;
            border: none;
            border-radius: 6px;
            padding: 8px 30px;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
            font-family: inherit;
        ">我知道了</button>
    `;
    document.body.appendChild(msgDiv);

    msgDiv.querySelector('#close-chart-msg').addEventListener('click', function () {
        msgDiv.remove();
    });

    msgDiv.addEventListener('click', function (e) {
        if (e.target === this) {
            this.remove();
        }
    });

    if (type === 'warning') {
        setTimeout(function () {
            var el = document.getElementById('chart-message');
            if (el) el.remove();
        }, 3000);
    }
}

// ---------- 辅助函数：设置默认日期范围 ----------
function setDefaultDateRange() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    document.getElementById('start-date-picker').value = formatDateTimeLocal(weekAgo);
    document.getElementById('end-date-picker').value = formatDateTimeLocal(now);

    if (window._customDateRange) {
        document.getElementById('start-date-picker').value = formatDateTimeLocal(window._customDateRange.start);
        document.getElementById('end-date-picker').value = formatDateTimeLocal(window._customDateRange.end);
        document.getElementById('date-range-info').textContent =
            '📅 ' +
            formatDateDisplay(window._customDateRange.start) +
            ' ~ ' +
            formatDateDisplay(window._customDateRange.end);
    }
}

// ---------- 辅助函数：格式化日期时间为 datetime-local 格式 ----------
function formatDateTimeLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return year + '-' + month + '-' + day + 'T' + hours + ':' + minutes;
}

// ---------- 辅助函数：格式化日期显示 ----------
function formatDateDisplay(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return year + '/' + month + '/' + day + ' ' + hours + ':' + minutes;
}

function createChartOverlay() {
    if (document.getElementById('chart-overlay')) {
        return document.getElementById('chart-overlay');
    }

    const overlay = document.createElement('div');
    overlay.id = 'chart-overlay';
    overlay.className = 'chart-overlay';

    overlay.innerHTML = `
        <div class="chart-container">
            <button class="chart-close-btn" id="chart-close-btn">✕</button>
            <div class="chart-title">
                <span id="chart-title-text">📊 成交量-价格中位数走势</span>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                    <span class="subtitle" id="chart-range-label">本周</span>
                    <div class="chart-time-controls" id="chart-time-controls">
                      <button data-range="today">本日</button>
                      <button data-range="week" class="active">本周</button>
                      <button data-range="twoweeks">近两周</button>
                      <button data-range="month">本月</button>
                      <button data-range="year">最近一年</button>
                      <button data-range="custom" id="custom-range-btn">📅 自定义</button>
                    </div>
                </div>
            </div>
            <div class="chart-wrapper">
                <canvas id="chart-canvas"></canvas>
                <div class="chart-loading" id="chart-loading">
                    <div class="loading-spinner"></div>
                    <span>加载数据中...</span>
                </div>
                <div class="chart-no-data" id="chart-no-data" style="display:none;">
                    ⚠️ 暂无数据
                </div>
            </div>
            <div class="chart-stats-summary" id="chart-stats">
                <div class="stat-item">数据条数: <span class="value" id="stat-count">--</span></div>
                <div class="stat-item">价格中位数: <span class="value price" id="stat-median">--</span></div>
                <div class="stat-item">最高价格: <span class="value price" id="stat-max">--</span></div>
                <div class="stat-item">最低价格: <span class="value price" id="stat-min">--</span></div>
                <div class="stat-item">总成交量: <span class="value volume" id="stat-volume">--</span></div>
            </div>
            <div class="custom-date-range" id="custom-date-range" style="display:none; margin-top:12px; padding-top:12px; border-top:1px solid #1a2634;">
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                    <span style="color:#8b9aab; font-size:12px;">起始日期:</span>
                    <input type="datetime-local" id="start-date-picker" style="background:rgba(0,0,0,0.3); color:#c6d4df; border:1px solid #2a3f5e; border-radius:4px; padding:4px 8px; font-size:12px; font-family:inherit;">
                    <span style="color:#8b9aab; font-size:12px;">结束日期:</span>
                    <input type="datetime-local" id="end-date-picker" style="background:rgba(0,0,0,0.3); color:#c6d4df; border:1px solid #2a3f5e; border-radius:4px; padding:4px 8px; font-size:12px; font-family:inherit;">
                    <button id="apply-date-range" style="background:#2a3f5e; color:#c6d4df; border:none; border-radius:4px; padding:4px 16px; font-size:12px; cursor:pointer; transition:background 0.2s;">应用</button>
                    <button id="reset-date-range" style="background:transparent; color:#8b9aab; border:1px solid #2a3f5e; border-radius:4px; padding:4px 12px; font-size:12px; cursor:pointer; transition:all 0.2s;">重置</button>
                    <span id="date-range-info" style="color:#8bc34a; font-size:11px;"></span>
                </div>
            </div>
        </div>
    `;

    // ⭐ 图表标题下拉切换：切换磨损/品质
    var titleEl = overlay.querySelector('#chart-title-text');
    if (titleEl) {
        titleEl.addEventListener('change', function (e) {
            var sel = e.target.closest('.chart-title-select');
            if (!sel) return;

            var type = sel.dataset.type; // 'wear' | 'quality'
            var value = sel.value;

            var cs = window._currentChartCase;
            if (!cs || !cs.item || !cs.item.is_skin) return;

            if (type === 'wear') {
                if (cs.wear === value) return;
                cs.wear = value;
            } else if (type === 'quality') {
                if (cs.quality === value) return;
                cs.quality = value;
            } else {
                return;
            }

            // 重算 mhn
            cs.market_hash_name = getMarketHashName(cs.item, cs.wear, cs.quality);

            // 重渲染标题（更新下拉选中态）
            renderChartTitle(cs);

            // 重新加载图表
            loadChartData(cs, currentTimeRange);
        });
    }

    // ⭐ 图标 hover 切高清（事件委托，翻页后依然有效）
    overlay.addEventListener('mouseover', function (e) {
        var img = e.target.closest('.item-list-icon');
        if (!img || img.tagName !== 'IMG') return;
        if (!img.dataset.lowRes) {
            img.dataset.lowRes = img.src;
            img.dataset.highRes = config.iconUrlHighRes || img.src.replace(/64fx64f/, '256fx256f');
        }
        if (img.dataset.highRes && img.src !== img.dataset.highRes) {
            img.src = img.dataset.highRes;
        }
    });
    overlay.addEventListener('mouseout', function (e) {
        var img = e.target.closest('.item-list-icon');
        if (!img || img.tagName !== 'IMG') return;
        if (img.dataset.lowRes && img.src !== img.dataset.lowRes) {
            img.src = img.dataset.lowRes;
        }
    });

    document.body.appendChild(overlay);

    overlay.querySelector('#chart-close-btn').addEventListener('click', closeChart);

    overlay.addEventListener('click', function (e) {
        if (e.target === this) {
            closeChart();
        }
    });

    overlay.querySelectorAll('#chart-time-controls button').forEach(function (btn) {
        btn.addEventListener('click', function () {
            overlay.querySelectorAll('#chart-time-controls button').forEach(function (b) {
                b.classList.remove('active');
            });
            this.classList.add('active');
            const range = this.dataset.range;

            if (range === 'custom') {
                document.getElementById('custom-date-range').style.display = 'block';
                setDefaultDateRange();
                return;
            } else {
                document.getElementById('custom-date-range').style.display = 'none';
            }

            document.getElementById('chart-range-label').textContent = this.textContent;
            currentTimeRange = range;
            const caseData = window._currentChartCase;
            if (caseData) {
                loadChartData(caseData, range);
            }
        });
    });

    overlay.querySelector('#apply-date-range').addEventListener('click', function () {
        const startDate = document.getElementById('start-date-picker').value;
        const endDate = document.getElementById('end-date-picker').value;

        if (!startDate || !endDate) {
            showChartMessage('请选择完整的起始和结束时间', 'warning');
            return;
        }

        const start = new Date(startDate);
        const end = new Date(endDate);

        if (start > end) {
            showChartMessage('起始时间不能晚于结束时间', 'warning');
            return;
        }

        const timeDiffMs = end.getTime() - start.getTime();
        const oneHourMs = 60 * 60 * 1000;

        if (timeDiffMs < oneHourMs) {
            showChartMessage('⚠️ 时间跨度不超过1小时，无法查询。请选择至少1小时的时间范围。', 'error');
            return;
        }

        window._customDateRange = {
            start: start,
            end: end
        };

        document.getElementById('date-range-info').textContent =
            '📅 ' + formatDateDisplay(start) + ' ~ ' + formatDateDisplay(end);

        currentTimeRange = 'custom';
        document.getElementById('chart-range-label').textContent = '自定义';

        const caseData = window._currentChartCase;
        if (caseData) {
            loadChartDataWithCustomRange(caseData, start, end);
        }
    });

    overlay.querySelector('#reset-date-range').addEventListener('click', function () {
        document.getElementById('custom-date-range').style.display = 'none';
        document.getElementById('date-range-info').textContent = '';
        window._customDateRange = null;

        overlay.querySelectorAll('#chart-time-controls button').forEach(function (b) {
            b.classList.remove('active');
            if (b.dataset.range === 'week') {
                b.classList.add('active');
            }
        });
        currentTimeRange = 'week';
        document.getElementById('chart-range-label').textContent = '本周';

        const caseData = window._currentChartCase;
        if (caseData) {
            loadChartData(caseData, 'week');
        }
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('active')) {
            closeChart();
        }
    });

    chartCanvas = document.getElementById('chart-canvas');
    chartOverlay = overlay;

    return overlay;
}

// ⭐ 渲染图表标题（带磨损/品质下拉切换）
function renderChartTitle(caseItem) {
    var titleEl = document.getElementById('chart-title-text');
    if (!titleEl) return;

    var item = caseItem.item;
    var wear = caseItem.wear;
    var quality = caseItem.quality;

    // 非皮肤：直接显示名称
    if (!item || !item.is_skin) {
        titleEl.innerHTML = '📊 ' + (caseItem.name || '') + ' - 成交量/价格中位数走势';
        return;
    }

    var wears = item.wears || [];
    var qualities = item.qualities || ['normal'];

    var wearOptions = wears
        .map(function (w) {
            var sel = w === wear ? ' selected' : '';
            return '<option value="' + w + '"' + sel + '>' + getWearLabel(item, w) + '</option>';
        })
        .join('');

    var qualityOptions = qualities
        .map(function (q) {
            var sel = q === quality ? ' selected' : '';
            return '<option value="' + q + '"' + sel + '>' + getQualityLabel(item, q) + '</option>';
        })
        .join('');

    titleEl.innerHTML =
        '📊 ' +
        caseItem.name +
        ' (' +
        '<select class="chart-title-select" data-type="wear">' +
        wearOptions +
        '</select>' +
        ' · ' +
        '<select class="chart-title-select" data-type="quality">' +
        qualityOptions +
        '</select>' +
        ')';
}

function openChart(caseItem) {
    const overlay = createChartOverlay();
    if (!overlay) return;

    window._currentChartCase = caseItem;

    // ⭐ 用新的标题渲染函数
    renderChartTitle(caseItem);

    document.getElementById('chart-loading').style.display = 'flex';
    document.getElementById('chart-no-data').style.display = 'none';

    document.getElementById('stat-count').textContent = '--';
    document.getElementById('stat-median').textContent = '--';
    document.getElementById('stat-max').textContent = '--';
    document.getElementById('stat-min').textContent = '--';
    document.getElementById('stat-volume').textContent = '--';

    overlay.classList.add('active');

    loadChartData(caseItem, currentTimeRange);
}

function closeChart() {
    if (chartOverlay) {
        chartOverlay.classList.remove('active');
    }
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

function getTimeRangeHours(range) {
    var map = {
        today: 24,
        week: 168,
        twoweeks: 336, // ⭐ 14 天
        month: 720,
        year: 8760
    };
    return map[range] || 168;
}

function filterDataByRange(data, range) {
    var hours = getTimeRangeHours(range);
    var now = new Date();
    var cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

    return data.filter(function (item) {
        try {
            var date = new Date(item.time);
            return date >= cutoff;
        } catch (e) {
            return false;
        }
    });
}

// ---------- 聚合数据按天 ----------
function aggregateDataByDay(data) {
    if (!data || data.length === 0) return data;

    // 按天分组
    var dayMap = {};
    data.forEach(function (item) {
        try {
            var date = new Date(item.time);
            var dayKey =
                date.getFullYear() +
                '-' +
                String(date.getMonth() + 1).padStart(2, '0') +
                '-' +
                String(date.getDate()).padStart(2, '0');

            if (!dayMap[dayKey]) {
                dayMap[dayKey] = {
                    day: dayKey,
                    prices: [],
                    volumes: [],
                    totalVolume: 0,
                    date: date
                };
            }
            dayMap[dayKey].prices.push(item.price);
            dayMap[dayKey].volumes.push(item.volume);
            dayMap[dayKey].totalVolume += item.volume;
        } catch (e) {}
    });

    // 计算每天的中位数价格和总成交量
    var result = [];
    var dayKeys = Object.keys(dayMap).sort();
    dayKeys.forEach(function (key) {
        var dayData = dayMap[key];
        var sortedPrices = dayData.prices.slice().sort(function (a, b) {
            return a - b;
        });
        var medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];

        result.push({
            time: key,
            price: medianPrice,
            volume: dayData.totalVolume,
            // 保留原始日期用于显示
            date: dayData.date
        });
    });

    return result;
}

// ---------- 判断是否超过一个月 ----------
function isMoreThanMonth(data) {
    if (!data || data.length === 0) return false;
    try {
        var firstDate = new Date(data[0].time);
        var lastDate = new Date(data[data.length - 1].time);
        var diffDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
        return diffDays > 30;
    } catch (e) {
        return false;
    }
}

// ---------- 格式化日期为 YYYY/MM/DD ----------
function formatDayLabel(timeStr) {
    try {
        var date = new Date(timeStr);
        if (!isNaN(date.getTime())) {
            var year = date.getFullYear();
            var month = date.getMonth() + 1;
            var day = date.getDate();
            return year + '/' + month + '/' + day;
        }
        return timeStr;
    } catch (e) {
        return timeStr;
    }
}

// ---------- 修改 loadChartData ----------
async function loadChartData(caseItem, range) {
    if (range === 'custom') {
        if (window._customDateRange) {
            await loadChartDataWithCustomRange(caseItem, window._customDateRange.start, window._customDateRange.end);
            return;
        } else {
            var now = new Date();
            var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            await loadChartDataWithCustomRange(caseItem, weekAgo, now);
            return;
        }
    }

    var loading = document.getElementById('chart-loading');
    var noData = document.getElementById('chart-no-data');
    var canvas = document.getElementById('chart-canvas');

    if (!canvas) return;

    loading.style.display = 'flex';
    noData.style.display = 'none';

    try {
        var data = await fetchPriceHistory(caseItem.appid, caseItem.market_hash_name);

        if (!data.success || !data.prices || data.prices.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 暂无历史数据';
            return;
        }

        var rawData = data.prices.map(function (item) {
            return {
                time: item[0],
                price: parseFloat(item[1]),
                volume: parseInt(item[2])
            };
        });

        rawData.sort(function (a, b) {
            return new Date(a.time) - new Date(b.time);
        });

        var filteredData = filterDataByRange(rawData, range);

        if (filteredData.length === 0) {
            filteredData = rawData;
        }

        // 判断是否超过一个月，如果是则按天聚合
        var useDayAggregation = isMoreThanMonth(filteredData);
        var displayData = filteredData;

        if (useDayAggregation) {
            displayData = aggregateDataByDay(filteredData);
        }

        var maxPoints = useDayAggregation ? 365 : 300;
        if (displayData.length > maxPoints) {
            var step = Math.ceil(displayData.length / maxPoints);
            displayData = displayData.filter(function (_, i) {
                return i % step === 0;
            });
        }

        if (displayData.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 该时间范围内无数据';
            return;
        }

        var prices = displayData.map(function (d) {
            return d.price;
        });
        var volumes = displayData.map(function (d) {
            return d.volume;
        });
        var sortedPrices = prices.slice().sort(function (a, b) {
            return a - b;
        });
        var medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
        var totalVolume = volumes.reduce(function (a, b) {
            return a + b;
        }, 0);
        var symbol = getCurrencySymbol();

        document.getElementById('stat-count').textContent = displayData.length;
        document.getElementById('stat-median').textContent = symbol + ' ' + medianPrice.toFixed(2);
        document.getElementById('stat-max').textContent = symbol + ' ' + Math.max.apply(null, prices).toFixed(2);
        document.getElementById('stat-min').textContent = symbol + ' ' + Math.min.apply(null, prices).toFixed(2);
        document.getElementById('stat-volume').textContent = totalVolume.toLocaleString();

        renderChart(displayData, caseItem.name, range, useDayAggregation);

        loading.style.display = 'none';
    } catch (e) {
        console.error('加载图表数据失败:', e);
        loading.style.display = 'none';
        noData.style.display = 'flex';
        noData.textContent = '❌ 加载失败: ' + e.message;
    }
}

// ---------- 使用自定义时间范围加载图表数据 ----------
// ---------- 修改 loadChartDataWithCustomRange ----------
async function loadChartDataWithCustomRange(caseItem, startDate, endDate) {
    var loading = document.getElementById('chart-loading');
    var noData = document.getElementById('chart-no-data');
    var canvas = document.getElementById('chart-canvas');

    if (!canvas) return;

    loading.style.display = 'flex';
    noData.style.display = 'none';

    try {
        var data = await fetchPriceHistory(caseItem.appid, caseItem.market_hash_name);

        if (!data.success || !data.prices || data.prices.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 暂无历史数据';
            return;
        }

        var rawData = data.prices.map(function (item) {
            return {
                time: item[0],
                price: parseFloat(item[1]),
                volume: parseInt(item[2])
            };
        });

        rawData.sort(function (a, b) {
            return new Date(a.time) - new Date(b.time);
        });

        var filteredData = rawData.filter(function (item) {
            try {
                var date = new Date(item.time);
                return date >= startDate && date <= endDate;
            } catch (e) {
                return false;
            }
        });

        if (filteredData.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 该时间范围内无数据，请调整时间范围';
            return;
        }

        // 判断是否超过一个月，如果是则按天聚合
        var useDayAggregation = isMoreThanMonth(filteredData);
        var displayData = filteredData;

        if (useDayAggregation) {
            displayData = aggregateDataByDay(filteredData);
        }

        var maxPoints = useDayAggregation ? 365 : 300;
        if (displayData.length > maxPoints) {
            var step = Math.ceil(displayData.length / maxPoints);
            displayData = displayData.filter(function (_, i) {
                return i % step === 0;
            });
        }

        if (displayData.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 该时间范围内无数据，请调整时间范围';
            return;
        }

        var prices = displayData.map(function (d) {
            return d.price;
        });
        var volumes = displayData.map(function (d) {
            return d.volume;
        });
        var sortedPrices = prices.slice().sort(function (a, b) {
            return a - b;
        });
        var medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
        var totalVolume = volumes.reduce(function (a, b) {
            return a + b;
        }, 0);
        var symbol = getCurrencySymbol();

        document.getElementById('stat-count').textContent = displayData.length;
        document.getElementById('stat-median').textContent = symbol + ' ' + medianPrice.toFixed(2);
        document.getElementById('stat-max').textContent = symbol + ' ' + Math.max.apply(null, prices).toFixed(2);
        document.getElementById('stat-min').textContent = symbol + ' ' + Math.min.apply(null, prices).toFixed(2);
        document.getElementById('stat-volume').textContent = totalVolume.toLocaleString();

        renderChart(displayData, caseItem.name, 'custom', useDayAggregation);

        loading.style.display = 'none';
    } catch (e) {
        console.error('加载图表数据失败:', e);
        loading.style.display = 'none';
        noData.style.display = 'flex';
        noData.textContent = '❌ 加载失败: ' + e.message;
    }
}

// ---------- 修改 renderChart ----------
function renderChart(data, title, range, useDayAggregation) {
    var canvas = document.getElementById('chart-canvas');
    if (!canvas) return;

    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }

    var ctx = canvas.getContext('2d');

    // 根据是否按天聚合选择不同的标签格式
    var labels = data.map(function (d) {
        return useDayAggregation ? formatDayLabel(d.time) : formatChartLabel(d.time);
    });
    var prices = data.map(function (d) {
        return d.price;
    });
    var volumes = data.map(function (d) {
        return d.volume;
    });

    var symbol = getCurrencySymbol();

    var priceColor = '#8bc34a';
    var priceColorLight = 'rgba(139, 195, 74, 0.15)';
    var volumeColor = 'rgba(102, 192, 244, 0.6)';
    var volumeColorBorder = 'rgba(102, 192, 244, 0.9)';

    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: useDayAggregation ? '日成交量' : '成交量',
                    data: volumes,
                    type: 'bar',
                    yAxisID: 'y1',
                    backgroundColor: volumeColor,
                    borderColor: volumeColorBorder,
                    borderWidth: 1,
                    order: 2
                },
                {
                    label: useDayAggregation ? '日价格中位数' : '价格中位数',
                    data: prices,
                    type: 'line',
                    yAxisID: 'y',
                    borderColor: priceColor,
                    backgroundColor: priceColorLight,
                    pointBackgroundColor: priceColor,
                    pointBorderColor: '#1a2634',
                    pointBorderWidth: 1,
                    pointRadius: useDayAggregation ? 3 : 2.5,
                    pointHoverRadius: useDayAggregation ? 6 : 5,
                    fill: true,
                    tension: 0.3,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#c6d4df',
                        font: {
                            size: 12,
                            family: '"Motiva Sans", Arial, sans-serif'
                        },
                        boxWidth: 14,
                        padding: 16
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(27, 40, 56, 0.95)',
                    titleColor: '#c6d4df',
                    bodyColor: '#c6d4df',
                    borderColor: '#2a3f5e',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 6,
                    callbacks: {
                        label: function (context) {
                            var label = context.dataset.label || '';
                            var value = context.parsed.y;
                            if (context.dataset.label === '价格中位数' || context.dataset.label === '日价格中位数') {
                                // ⭐ 中位数对应的卖家实收
                                var buyerCents = Math.round(value * 100);
                                var walletInfo = getWalletInfo();
                                var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;
                                var feeInfo = calculateSteamFees(buyerCents, walletInfo, publisherFee);
                                var sellerText = symbol + ' ' + (feeInfo.sellerAmount / 100).toFixed(2);
                                return label + ': ' + symbol + ' ' + value.toFixed(2) + ' (' + sellerText + ')';
                            } else if (context.dataset.label === '成交量' || context.dataset.label === '日成交量') {
                                return label + ': ' + value.toLocaleString();
                            }
                            return label + ': ' + value;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        color: 'rgba(42, 63, 94, 0.3)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#8b9aab',
                        font: {
                            size: useDayAggregation ? 9 : 10,
                            family: '"Motiva Sans", Arial, sans-serif'
                        },
                        maxTicksLimit: useDayAggregation ? 30 : 20,
                        maxRotation: useDayAggregation ? 90 : 45,
                        minRotation: useDayAggregation ? 45 : 0
                    }
                },
                y: {
                    position: 'left',
                    grid: {
                        color: 'rgba(42, 63, 94, 0.3)',
                        drawBorder: false
                    },
                    ticks: {
                        color: '#8bc34a',
                        font: {
                            size: 10,
                            family: '"Motiva Sans", Arial, sans-serif'
                        },
                        callback: function (value) {
                            return symbol + ' ' + value.toFixed(2);
                        }
                    },
                    title: {
                        display: true,
                        text: useDayAggregation ? '日价格中位数' : '价格',
                        color: '#8bc34a',
                        font: {
                            size: 11,
                            family: '"Motiva Sans", Arial, sans-serif'
                        }
                    }
                },
                y1: {
                    position: 'right',
                    grid: {
                        display: false
                    },
                    ticks: {
                        color: '#66c0f4',
                        font: {
                            size: 10,
                            family: '"Motiva Sans", Arial, sans-serif'
                        },
                        callback: function (value) {
                            if (value >= 1000) {
                                return (value / 1000).toFixed(1) + 'k';
                            }
                            return value.toString();
                        }
                    },
                    title: {
                        display: true,
                        text: useDayAggregation ? '日成交量' : '成交量',
                        color: '#66c0f4',
                        font: {
                            size: 11,
                            family: '"Motiva Sans", Arial, sans-serif'
                        }
                    }
                }
            },
            elements: {
                line: {
                    borderWidth: 2
                }
            }
        }
    });

    setTimeout(function () {
        if (chartInstance) {
            chartInstance.resize();
        }
    }, 100);
}

// 在脚本1中，修改 createPanel 函数，在面板右下角添加"库存统计"按钮

function createPanel() {
    var oldPanel = document.getElementById('weapon-cases-panel');
    if (oldPanel) {
        oldPanel.remove();
    }

    var panel = document.createElement('div');
    panel.id = 'weapon-cases-panel';
    panel.className = 'weapon-cases-panel';

    var savedPageSize = parseInt(localStorage.getItem('weaponCasesPageSize')) || DEFAULT_PAGE_SIZE;
    if (savedPageSize < MIN_PAGE_SIZE || savedPageSize > MAX_PAGE_SIZE) {
        savedPageSize = DEFAULT_PAGE_SIZE;
    }

    var titleText = '📦 市场挂单数据';
    if (isMultisellPage()) {
        titleText = '📦 市场挂单数据';
    } else if (isListingPage()) {
        var matched = getCurrentCase();
        if (matched && matched.item) {
            var caseItem = matched.item;
            // ⭐ 详情页标题只显示基础名，不带磨损
            titleText = '📦 ' + caseItem.name;
        }
    } else if (isMarketHomePage()) {
        titleText = '📦 我关注的物品';
    }

    // ⭐ 关键：详情页不显示搜索栏
    var searchBarHtml = '';
    if (!isListingPage()) {
        searchBarHtml = `
    <div class="case-search-bar">
        <input type="text" id="case-search-input" class="case-search-input"
               placeholder="🔍 搜索物品名称（中英文均可）">
        <button class="case-search-clear" id="case-search-clear" title="清空">✕</button>
        <div class="case-filter-group">
            <button class="case-filter-btn active" data-filter="all">全部</button>
            <button class="case-filter-btn" data-filter="tradable">有可交易</button>
            <button class="case-filter-btn" data-filter="has-stock">有库存</button>
            <button class="case-filter-btn" data-filter="stackable">可堆叠</button>
        </div>
        <select id="stock-status-filter" class="stock-status-select" title="按库存状态筛选">
            <option value="all"    style="color:${STOCK_STATUS_COLORS.all};">● 库存状态: 全部</option>
            <option value="red"    style="color:${STOCK_STATUS_COLORS.red};">● 有可交易</option>
            <option value="purple" style="color:${STOCK_STATUS_COLORS.purple};">● 冷却+出售</option>
            <option value="yellow" style="color:${STOCK_STATUS_COLORS.yellow};">● 仅冷却中</option>
            <option value="blue"   style="color:${STOCK_STATUS_COLORS.blue};">● 仅出售中</option>
            <option value="green"  style="color:${STOCK_STATUS_COLORS.green};">● 无库存</option>
        </select>
    </div>
`;
    }

    panel.innerHTML = `
        <div class="weapon-cases-header">
            <h3 title="${String(titleText).replace(/"/g, '&quot;')}"><span class="drag-handle">⠿</span> ${titleText}</h3>
            <div class="weapon-cases-controls">
                <span class="status" id="case-status">加载中...</span>
                <span class="page-size-label">每页</span>
                <input class="page-size-input" id="page-size-input" type="number"
                       value="${savedPageSize}" min="${MIN_PAGE_SIZE}" max="${MAX_PAGE_SIZE}"
                       title="设置每页显示数量 (${MIN_PAGE_SIZE}-${MAX_PAGE_SIZE})">
                <span class="page-size-label">条</span>
                <button id="refresh-cases">🔄 刷新</button>
                <button id="toggle-cases">−</button>
            </div>
        </div>

        ${searchBarHtml}

        <div class="weapon-cases-content" id="case-content">
            <div style="text-align:center; padding:20px; color:#8b9aab;">
                <div class="loading-spinner"></div>
                <div style="margin-top:8px;">正在获取数据...</div>
            </div>
        </div>

                <!-- 底部按钮区 -->
        <div style="display:flex; align-items:center; gap:6px; padding:6px 0 2px 0; border-top:1px solid #1a2634; margin-top:0px;flex-shrink:0;">
            <button id="goto-market-home-btn" style="background:#2a3f5e; color:#c6d4df; border:none; border-radius:4px; padding:4px 10px; font-size:11px; cursor:pointer; font-family:inherit;">🏠 主页</button>
            <button id="open-fee-calc-btn" style="background:#2a3f5e; color:#c6d4df; border:none; border-radius:4px; padding:4px 10px; font-size:11px; cursor:pointer; font-family:inherit;">🧮 计算价格</button>
        </div>
    `;

    document.body.appendChild(panel);
    makeDraggable(panel);

    // 页面大小输入框事件
    var pageSizeInput = document.getElementById('page-size-input');
    pageSizeInput.addEventListener('change', function () {
        var val = parseInt(this.value);
        if (isNaN(val) || val < MIN_PAGE_SIZE) {
            val = MIN_PAGE_SIZE;
        } else if (val > MAX_PAGE_SIZE) {
            val = MAX_PAGE_SIZE;
        }
        this.value = val;
        localStorage.setItem('weaponCasesPageSize', val);
        var content = document.getElementById('case-content');
        if (content && content._allData) {
            renderAllData(content._allData);
        }
    });

    pageSizeInput.addEventListener('focus', function () {
        this.select();
    });

    // 刷新按钮
    document.getElementById('refresh-cases').addEventListener('click', function () {
        if (isMarketHomePage()) {
            loadAllData();
        } else if (isListingPage()) {
            loadDataForCurrentCase();
        } else {
            loadAllData();
        }
    });

    // 最小化按钮
    var isMinimized = false;
    document.getElementById('toggle-cases').addEventListener('click', function () {
        isMinimized = !isMinimized;
        panel.classList.toggle('minimized');
        this.textContent = isMinimized ? '+' : '−';
    });

    // ⭐ 新增：主页键事件
    var homeBtn = document.getElementById('goto-market-home-btn');
    if (homeBtn) {
        homeBtn.addEventListener('click', function () {
            window.location.href = 'https://steamcommunity.com/market/';
        });
    }

    // ⭐ 新增：计算价格按钮
    var feeCalcBtn = document.getElementById('open-fee-calc-btn');
    if (feeCalcBtn) {
        feeCalcBtn.addEventListener('click', function () {
            showFeeCalculator();
        });
    }

    // ⭐ 搜索输入（带 200ms 防抖）
    var searchInput = document.getElementById('case-search-input');
    var searchClear = document.getElementById('case-search-clear');
    var searchTimer = null;

    if (searchInput) {
        searchInput.value = searchKeyword || '';

        searchInput.addEventListener('input', function () {
            clearTimeout(searchTimer);
            var val = this.value;
            searchTimer = setTimeout(function () {
                searchKeyword = val.trim().toLowerCase();
                currentNameListPage = 1;
                var allData = document.getElementById('case-content')?._allData || [];
                if (allData.length > 0) {
                    renderAllData(allData);
                }
            }, 200);
        });

        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') e.stopPropagation();
        });
    }

    if (searchClear) {
        searchClear.addEventListener('click', function () {
            if (searchInput) searchInput.value = '';
            searchKeyword = '';
            currentNameListPage = 1;
            var allData = document.getElementById('case-content')?._allData || [];
            if (allData.length > 0) {
                renderAllData(allData);
            }
            if (searchInput) searchInput.focus();
        });
    }

    var stockStatusSelect = document.getElementById('stock-status-filter');
    if (stockStatusSelect) {
        stockStatusSelect.value = stockStatusFilter || 'all';

        function syncStockStatusSelectColor() {
            var key = stockStatusSelect.value || 'all';
            stockStatusSelect.style.color = STOCK_STATUS_COLORS[key] || '#c6d4df';
        }

        stockStatusSelect._syncColor = syncStockStatusSelectColor;
        syncStockStatusSelectColor();

        stockStatusSelect.addEventListener('change', function () {
            stockStatusFilter = this.value;
            currentNameListPage = 1;
            syncStockStatusSelectColor();
            var allData = document.getElementById('case-content')?._allData || [];
            if (allData.length > 0) {
                renderAllData(allData);
            }
        });
    }

    // ⭐ 筛选按钮（详情页没有这些按钮，forEach 自然为空，不会报错）
    document.querySelectorAll('.case-filter-btn').forEach(function (btn) {
        if (btn.dataset.filter === (searchFilter || 'all')) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }

        btn.addEventListener('click', function () {
            document.querySelectorAll('.case-filter-btn').forEach(function (b) {
                b.classList.remove('active');
            });
            this.classList.add('active');
            searchFilter = this.dataset.filter;
            currentNameListPage = 1;
            var allData = document.getElementById('case-content')?._allData || [];
            if (allData.length > 0) {
                renderAllData(allData);
            }
        });
    });

    return panel;
}

// ============================================================
// 修复：renderAllData - 渲染时优先使用持久化数据
// ============================================================

async function renderAllData(allData, expandIndex) {
    var content = document.getElementById('case-content');
    var status = document.getElementById('case-status');

    if (!content) return;

    content._allData = allData;

    // ⭐ 获取 API 库存数据（过滤可交易要用到）
    var inventoryData = await getInventoryData();

    // ⭐ 获取市场挂单数据（出售中数量）
    var listingsData = await getAllMyListings();

    // ⭐ 计算每个物品的"可交易数量"和"库存总数"，用于过滤
    function getItemInvInfo(dataItem) {
        var caseItem = WEAPON_CASES[dataItem.index];
        if (!caseItem) return { total: 0, tradable: 0, protected: 0, listing: 0, allTotal: 0 };

        var result = { total: 0, tradable: 0, protected: 0, listing: 0, allTotal: 0 };

        if (inventoryData && inventoryData.success) {
            // ⭐ 皮肤：按 name 合并统计；非皮肤：按 market_hash_name 精确
            var c = countInventoryItemsDual(inventoryData, caseItem);
            result.total = c.total || 0;
            result.tradable = c.tradable || 0;
            result.protected = c.protected || 0;
            result.allTotal = (c.total || 0) + (c.protected || 0);
        }

        // ⭐ 关键修复：补上"出售中"数量统计（按 name 合并皮肤）
        result.listing = countListingsByItem(listingsData, caseItem);

        return result;
    }

    // ⭐ 应用搜索 + 筛选
    var filteredData = allData;
    var hasSearch = searchKeyword && searchKeyword.length > 0;
    var hasFilter = searchFilter && searchFilter !== 'all';
    var hasStockFilter = stockStatusFilter && stockStatusFilter !== 'all'; // ⭐ 新增

    if (hasSearch || hasFilter || hasStockFilter) {
        filteredData = allData.filter(function (dataItem) {
            var caseItem = WEAPON_CASES[dataItem.index];
            if (!caseItem) return false;

            // 名称匹配
            if (hasSearch) {
                var haystack = [caseItem.name || '', caseItem.base_name || '', caseItem.market_hash_name || '']
                    .join(' ')
                    .toLowerCase();
                if (haystack.indexOf(searchKeyword) === -1) return false;
            }

            // 原有筛选（有可交易 / 有库存 / 可堆叠）
            if (hasFilter) {
                var caseItemForFilter = WEAPON_CASES[dataItem.index];
                if (!caseItemForFilter) return false;

                var wearF = dataItem.currentWear || (caseItemForFilter.is_skin ? caseItemForFilter.default_wear : null);
                var qualityF =
                    dataItem.currentQuality || (caseItemForFilter.is_skin ? caseItemForFilter.default_quality : null);
                var mhnF = getMarketHashName(caseItemForFilter, wearF, qualityF);

                var inv = getItemInvInfo(dataItem);
                if (searchFilter === 'tradable' && inv.tradable <= 0) return false;
                if (searchFilter === 'has-stock' && inv.allTotal <= 0) return false;
                if (searchFilter === 'stackable' && !isCommodityItem(inventoryData, mhnF)) return false;
            }

            // ⭐ 库存状态筛选（走统一判定函数）
            if (hasStockFilter) {
                var invForStatus = getItemInvInfo(dataItem);
                var color = getStockStatusKey(invForStatus.tradable, invForStatus.protected, invForStatus.listing);
                if (color !== stockStatusFilter) return false;
            }

            return true;
        });
    }

    // ⭐ 名称列表分页：每页最多 10 个（基于过滤后的数据）
    var totalNamePages = Math.max(1, Math.ceil(filteredData.length / NAME_LIST_PAGE_SIZE));
    if (currentNameListPage > totalNamePages) currentNameListPage = totalNamePages;
    if (currentNameListPage < 1) currentNameListPage = 1;

    var pageStart = (currentNameListPage - 1) * NAME_LIST_PAGE_SIZE;
    var pageEnd = Math.min(pageStart + NAME_LIST_PAGE_SIZE, filteredData.length);
    var pageData = filteredData.slice(pageStart, pageEnd);

    var pageSize = parseInt(document.getElementById('page-size-input').value) || DEFAULT_PAGE_SIZE;

    // ⭐ 构建库存映射（用于每个物品的角标、上架按钮）
    var inventoryMap = {};
    if (inventoryData && inventoryData.success) {
        for (var i = 0; i < WEAPON_CASES.length; i++) {
            var item = WEAPON_CASES[i];

            var entry = null;
            for (var k = 0; k < allData.length; k++) {
                if (allData[k].index === i) {
                    entry = allData[k];
                    break;
                }
            }
            var wear = entry && entry.currentWear ? entry.currentWear : item.is_skin ? item.default_wear : null;
            var quality =
                entry && entry.currentQuality ? entry.currentQuality : item.is_skin ? item.default_quality : null;
            var mhn = getMarketHashName(item, wear, quality);

            var count = countInventoryItemsDual(inventoryData, item); // ⭐ 传 item 对象
            inventoryMap[i] = {
                total: count.total || 0,
                tradable: count.tradable || 0,
                protected: count.protected || 0,
                listing: countListingsByItem(listingsData, item), // ⭐ 按 name 合并
                assetIds: count.assetIds || [],
                isCommodity: isCommodityItem(inventoryData, mhn)
            };
        }
    }

    var html = '';
    // ⭐ 只渲染当前页的数据
    for (var i = 0; i < pageData.length; i++) {
        var dataItem = pageData[i];
        var result = dataItem.result;
        var index = dataItem.index;
        var caseItem = WEAPON_CASES[index];

        if (!caseItem) continue;

        var currentPage = dataItem.currentPage || 1;
        var paginated = paginateOrders(result.sellOrders, pageSize, currentPage);
        var invCount = inventoryMap[index] || null;

        var currentWear = dataItem.currentWear || null;
        var currentQuality = dataItem.currentQuality || null;
        html += buildCaseHTMLWithPagination_Enhanced(
            caseItem,
            result,
            index,
            paginated,
            invCount,
            currentWear,
            currentQuality
        );
    }

    if (!html) {
        if (hasSearch || hasFilter) {
            html = '<div class="no-case-match">🔍 没有匹配的物品，请调整搜索或筛选条件</div>';
        } else {
            html = '<div class="no-case-match">⚠️ 未找到匹配的武器箱</div>';
        }
    }

    // ⭐ 搜索时显示结果统计
    var searchInfoHtml = '';
    if (hasSearch || hasFilter || hasStockFilter) {
        var filterLabelMap = {
            tradable: '有可交易',
            'has-stock': '有库存',
            stackable: '可堆叠'
        };
        var stockStatusLabelMap = {
            red: '有可交易',
            purple: '冷却+出售',
            yellow: '仅冷却中',
            blue: '仅出售中',
            green: '无库存'
        };
        var parts = [];
        if (hasSearch) parts.push('关键词 "' + searchKeyword + '"');
        if (hasFilter) parts.push('筛选: ' + (filterLabelMap[searchFilter] || searchFilter));
        if (hasStockFilter) {
            var sColor = STOCK_STATUS_COLORS[stockStatusFilter] || '#c6d4df';
            var sLabel = stockStatusLabelMap[stockStatusFilter] || stockStatusFilter;
            parts.push('库存状态: <span style="color:' + sColor + ';font-weight:600;">● ' + sLabel + '</span>');
        }

        searchInfoHtml =
            '<div class="case-search-result-info">🔍 ' +
            parts.join(' · ') +
            '，匹配 <span class="highlight">' +
            filteredData.length +
            '</span> / ' +
            allData.length +
            ' 个物品' +
            (filteredData.length === 0 ? '（无结果）' : '') +
            '</div>';
    }

    // ⭐ 名称列表分页导航（基于过滤后的数据）
    var nameListPaginationHtml = '';
    if (filteredData.length > NAME_LIST_PAGE_SIZE) {
        var prevDisabled = currentNameListPage <= 1;
        var nextDisabled = currentNameListPage >= totalNamePages;

        var pageButtons = '';
        var maxVisible = 7;
        var startPage = Math.max(1, currentNameListPage - Math.floor(maxVisible / 2));
        var endPage = Math.min(totalNamePages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        for (var k = startPage; k <= endPage; k++) {
            var active = k === currentNameListPage ? 'active' : '';
            pageButtons += '<button class="name-list-page-btn ' + active + '" data-page="' + k + '">' + k + '</button>';
        }

        nameListPaginationHtml = `
            <div class="name-list-pagination">
                <button class="name-list-page-btn" data-page="${currentNameListPage - 1}" ${prevDisabled ? 'disabled' : ''}>◀</button>
                ${pageButtons}
                <button class="name-list-page-btn" data-page="${currentNameListPage + 1}" ${nextDisabled ? 'disabled' : ''}>▶</button>
                <span class="page-info">${currentNameListPage}/${totalNamePages}</span>
                <span class="page-info">(共 ${filteredData.length} 个)</span>
            </div>
        `;
    }

    content.innerHTML = searchInfoHtml + html + nameListPaginationHtml;
    bindEvents();

    if (expandIndex !== undefined) {
        requestAnimationFrame(function () {
            setTimeout(function () {
                expandItem(expandIndex);
            }, 50);
        });
    }

    if (status) {
        var successCount = 0;
        for (var j = 0; j < allData.length; j++) {
            if (allData[j].result && allData[j].result.sellCount > 0) successCount++;
        }
        var totalCount = allData.length;
        var invLoaded = inventoryData ? '📦' : '⚠️';
        var filterTag = hasSearch || hasFilter ? ' 🔍' : '';
        status.textContent = '✅ ' + successCount + '/' + totalCount + ' ' + invLoaded + filterTag;
    }
}

// ============================================================
// 修改 init - 加载API数据后更新状态
// ============================================================

function init() {
    console.log('🚀 初始化武器箱挂单数据查询...');

    var panel = createPanel();
    createChartOverlay();

    // ⭐ 清理过期的 orderbook 持久化缓存
    cleanOrderbookCache();

    // ⭐ 直接加载数据
    setTimeout(function () {
        loadDataByPageType();
    }, 500);

    // 如果是 multisell 页面，监听DOM变化
    if (isMultisellPage()) {
        const observer = new MutationObserver(function (mutations) {
            if (suppressMultisellObserver) return;
            // ... 原有逻辑保持不变
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ⭐ 定期更新API数据状态（每30秒检查一次）
    setInterval(function () {
        if (cachedInventoryData) {
            // ⭐ 原来调用 updateStatsStatusIndicator()，现在改为空或删除
            // updateStatsStatusIndicator();
        }
    }, 30000);
}

// ---------- 展开物品（带重试机制） ----------
function expandItem(caseIndex, retries) {
    retries = retries || 0;
    if (retries > 10) return; // 最多重试10次

    var itemElement = document.querySelector('.case-item[data-case-index="' + caseIndex + '"]');
    if (itemElement) {
        var orders = itemElement.querySelector('.case-orders');
        if (orders) {
            // 确保展开
            orders.classList.add('expanded');
            var arrow = itemElement.querySelector('.arrow');
            if (arrow) {
                arrow.classList.add('expanded');
            }
        }
        // 添加高亮闪烁效果
        itemElement.classList.remove('refresh-flash');
        void itemElement.offsetWidth;
        itemElement.classList.add('refresh-flash');

        setTimeout(function () {
            itemElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
    } else {
        // 如果元素还没渲染出来，重试
        setTimeout(function () {
            expandItem(caseIndex, retries + 1);
        }, 100);
    }
}

// ============================================================
// 新增：价格悬停显示卖家实收
// ============================================================

let feeTooltipEl = null;
let currentHoverPriceTd = null;

function getFeeTooltip() {
    if (!feeTooltipEl) {
        feeTooltipEl = document.createElement('div');
        feeTooltipEl.className = 'fee-tooltip';
        document.body.appendChild(feeTooltipEl);
    }
    return feeTooltipEl;
}

function showFeeTooltip(e, buyerPriceCents) {
    const walletInfo = getWalletInfo();
    const publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;
    const feeInfo = calculateSteamFees(buyerPriceCents, walletInfo, publisherFee);
    const symbol = getCurrencySymbol();

    const formatMoney = cents => {
        if (cents === undefined || cents === null) return '--';
        return symbol + ' ' + (cents / 100).toFixed(2);
    };

    const tooltip = getFeeTooltip();
    tooltip.innerHTML = `
        <div class="fee-row">
            <span class="fee-label">买家支付</span>
            <span class="fee-buyer">${formatMoney(feeInfo.buyerPrice)}</span>
        </div>
        <div class="fee-divider"></div>
        <div class="fee-row">
            <span class="fee-label">卖家实收</span>
            <span class="fee-seller">${formatMoney(feeInfo.sellerAmount)}</span>
        </div>
        <div class="fee-row">
            <span class="fee-label">Steam 手续费</span>
            <span class="fee-fee">${formatMoney(feeInfo.steamFee)}</span>
        </div>
        <div class="fee-row">
            <span class="fee-label">发行商手续费</span>
            <span class="fee-fee">${formatMoney(feeInfo.publisherFee)}</span>
        </div>
        <div class="fee-row">
            <span class="fee-label">总手续费</span>
            <span class="fee-fee">${formatMoney(feeInfo.totalFees)} (${feeInfo.feePercentage.toFixed(2)}%)</span>
        </div>
    `;
    tooltip.style.display = 'block';
    positionFeeTooltip(e);
}

function hideFeeTooltip() {
    if (feeTooltipEl) {
        feeTooltipEl.style.display = 'none';
    }
}

function positionFeeTooltip(e) {
    if (!feeTooltipEl || feeTooltipEl.style.display === 'none') return;

    const offset = 16;
    let x = e.clientX + offset;
    let y = e.clientY + offset;

    const rect = feeTooltipEl.getBoundingClientRect();

    // 右边界溢出处理
    if (x + rect.width > window.innerWidth) {
        x = e.clientX - rect.width - offset;
    }
    // 下边界溢出处理
    if (y + rect.height > window.innerHeight) {
        y = e.clientY - rect.height - offset;
    }

    feeTooltipEl.style.left = x + 'px';
    feeTooltipEl.style.top = y + 'px';
}

async function switchWear(caseIndex, newWear) {
    var item = WEAPON_CASES[caseIndex];
    if (!item || !item.is_skin) return;

    var content = document.getElementById('case-content');
    var allData = content._allData;
    if (!allData) return;

    var entry = null;
    for (var i = 0; i < allData.length; i++) {
        if (allData[i].index === caseIndex) {
            entry = allData[i];
            break;
        }
    }
    if (!entry) return;

    var currentQuality = entry.currentQuality || item.default_quality || 'normal';

    if (entry.currentWear === newWear) return;

    var itemEl = document.querySelector('.case-item[data-case-index="' + caseIndex + '"]');
    if (itemEl) itemEl.classList.add('wear-loading');

    var marketHashName = getMarketHashName(item, newWear, currentQuality);

    try {
        var data = await fetchOrderBook(item.appid, marketHashName);
        var result = parseOrderBook(data);

        entry.currentWear = newWear;
        // currentQuality 保持不变
        entry.result = result;
        entry.currentPage = 1;
        entry.error = null;

        await renderAllData(allData, caseIndex);
    } catch (e) {
        console.error('切换磨损失败:', e);
        showChartMessage('❌ 切换磨损失败: ' + e.message, 'error');
    } finally {
        if (itemEl) itemEl.classList.remove('wear-loading');
    }
}

async function switchQuality(caseIndex, newQuality) {
    var item = WEAPON_CASES[caseIndex];
    if (!item || !item.is_skin) return;

    var content = document.getElementById('case-content');
    var allData = content._allData;
    if (!allData) return;

    var entry = null;
    for (var i = 0; i < allData.length; i++) {
        if (allData[i].index === caseIndex) {
            entry = allData[i];
            break;
        }
    }
    if (!entry) return;

    var currentWear = entry.currentWear || item.default_wear;

    if (entry.currentQuality === newQuality) return;

    var itemEl = document.querySelector('.case-item[data-case-index="' + caseIndex + '"]');
    if (itemEl) itemEl.classList.add('wear-loading');

    var marketHashName = getMarketHashName(item, currentWear, newQuality);

    try {
        var data = await fetchOrderBook(item.appid, marketHashName);
        var result = parseOrderBook(data);

        entry.currentQuality = newQuality;
        entry.result = result;
        entry.currentPage = 1;
        entry.error = null;

        await renderAllData(allData, caseIndex);
    } catch (e) {
        console.error('切换品质失败:', e);
        showChartMessage('❌ 切换品质失败: ' + e.message, 'error');
    } finally {
        if (itemEl) itemEl.classList.remove('wear-loading');
    }
}

// ---------- 绑定事件 ----------
// 修复2：增强 bindEvents 处理"统计"按钮
// ============================================================

function bindEvents() {
    var content = document.getElementById('case-content');
    if (!content) return;

    // 移除之前绑定的事件监听器
    if (content._eventListeners) {
        content._eventListeners.forEach(function (item) {
            content.removeEventListener(item.type, item.listener, item.capture || false);
        });
    }

    var listeners = [];

    // 1. 点击 header 切换展开/收起
    var headerListener = function (e) {
        var target = e.target;
        var header = target.closest('.case-item-header');
        if (!header) return;

        var orders = header.nextElementSibling;
        if (orders && orders.classList.contains('case-orders') && orders.contains(target)) {
            return;
        }

        if (target.closest('button')) return;
        if (target.closest('input')) return;
        if (target.closest('a')) return;
        if (target.closest('.chart-open-btn')) return;
        if (target.closest('.case-refresh-btn')) return;
        if (target.closest('.case-name-wrapper')) return;
        if (target.closest('.pagination')) return;

        if (orders && orders.classList.contains('case-orders')) {
            orders.classList.toggle('expanded');
            var arrow = header.querySelector('.arrow');
            if (arrow) {
                arrow.classList.toggle('expanded');
            }
        }
    };
    content.addEventListener('click', headerListener);
    listeners.push({ type: 'click', listener: headerListener });

    // 2. 名称点击跳转（新标签页）
    var nameListener = function (e) {
        var wrapper = e.target.closest('.case-name-wrapper');
        if (!wrapper) return;
        e.stopPropagation();
        e.preventDefault();

        var caseIndex = parseInt(wrapper.dataset.index);
        var caseItem = WEAPON_CASES[caseIndex];
        if (!caseItem) return;

        var url = getItemUrl(caseItem, null);
        if (url) {
            window.open(url, '_blank'); // ⭐ 新标签页打开
        }
    };
    content.addEventListener('click', nameListener);
    listeners.push({ type: 'click', listener: nameListener });

    // 3. 刷新按钮
    var refreshListener = function (e) {
        var btn = e.target.closest('.case-refresh-btn');
        if (!btn) return;
        e.stopPropagation();
        var caseIndex = parseInt(btn.dataset.index);
        refreshSingleItem(caseIndex);
    };
    content.addEventListener('click', refreshListener);
    listeners.push({ type: 'click', listener: refreshListener });

    // 4. 图表按钮
    var chartListener = function (e) {
        var btn = e.target.closest('.chart-open-btn');
        if (!btn) return;
        e.stopPropagation();
        var caseIndex = parseInt(btn.dataset.index);
        var caseItem = WEAPON_CASES[caseIndex];
        if (!caseItem) return;

        var allData = document.getElementById('case-content')._allData || [];
        var entry = null;
        for (var i = 0; i < allData.length; i++) {
            if (allData[i].index === caseIndex) {
                entry = allData[i];
                break;
            }
        }
        var wear = entry && entry.currentWear ? entry.currentWear : caseItem.is_skin ? caseItem.default_wear : null;
        var quality =
            entry && entry.currentQuality ? entry.currentQuality : caseItem.is_skin ? caseItem.default_quality : null;
        var mhn = getMarketHashName(caseItem, wear, quality);

        openChart({
            appid: caseItem.appid,
            market_hash_name: mhn,
            name: caseItem.name,
            item: caseItem, // ⭐ 传 item 对象
            wear: wear, // ⭐ 传当前磨损
            quality: quality // ⭐ 传当前品质
        });
    };

    content.addEventListener('click', chartListener);
    listeners.push({ type: 'click', listener: chartListener });

    // 5. 分页按钮
    var paginationListener = function (e) {
        var btn = e.target.closest('.pagination-btn');
        if (!btn) return;
        e.stopPropagation();
        var caseIndex = parseInt(btn.dataset.index);
        var page = parseInt(btn.dataset.page);
        changePage(caseIndex, page);
    };
    content.addEventListener('click', paginationListener);
    listeners.push({ type: 'click', listener: paginationListener });

    // 6. 页码跳转输入框
    var jumpListener = function (e) {
        var input = e.target.closest('.page-jump');
        if (!input) return;
        if (e.key === 'Enter') {
            e.stopPropagation();
            var caseIndex = parseInt(input.dataset.index);
            var totalPages = parseInt(input.dataset.totalPages);
            var page = parseInt(input.value);
            if (isNaN(page) || page < 1) page = 1;
            if (page > totalPages) page = totalPages;
            input.value = page;
            changePage(caseIndex, page);
        }
    };
    content.addEventListener('keydown', jumpListener);
    listeners.push({ type: 'keydown', listener: jumpListener });

    // 7. 上架按钮（单个）
    var sellListener = function (e) {
        var btn = e.target.closest('.inv-btn-sell');
        if (!btn) return;
        e.stopPropagation();
        if (btn.disabled) return;
        var caseIndex = parseInt(btn.dataset.index);
        handleSell(caseIndex, false);
    };
    content.addEventListener('click', sellListener);
    listeners.push({ type: 'click', listener: sellListener });

    // 8. 批量上架按钮
    var batchListener = function (e) {
        var btn = e.target.closest('.inv-btn-batch');
        if (!btn) return;
        e.stopPropagation();
        if (btn.disabled) return;
        var caseIndex = parseInt(btn.dataset.index);
        handleSell(caseIndex, true);
    };
    content.addEventListener('click', batchListener);
    listeners.push({ type: 'click', listener: batchListener });

    // 9. 鼠标中键点击名称
    var middleListener = function (e) {
        var wrapper = e.target.closest('.case-name-wrapper');
        if (!wrapper) return;
        if (e.button === 1) {
            e.preventDefault();

            var caseIndex = parseInt(wrapper.dataset.index);
            var caseItem = WEAPON_CASES[caseIndex];
            if (!caseItem) return;

            var url = getItemUrl(caseItem, null);
            if (url) {
                window.open(url, '_blank');
            }
        }
    };
    content.addEventListener('mousedown', middleListener);
    listeners.push({ type: 'mousedown', listener: middleListener });

    // 11. 价格悬停显示卖家实收
    var priceHoverListener = function (e) {
        var td = e.target.closest('td.price');
        if (td === currentHoverPriceTd) return;
        currentHoverPriceTd = td;

        if (td) {
            var priceVal = parseInt(td.dataset.price);
            if (!isNaN(priceVal)) {
                showFeeTooltip(e, priceVal);
                return;
            }
        }
        hideFeeTooltip();
    };
    content.addEventListener('mouseover', priceHoverListener);
    listeners.push({ type: 'mouseover', listener: priceHoverListener });

    var priceMoveListener = function (e) {
        if (currentHoverPriceTd) {
            positionFeeTooltip(e);
        }
    };
    content.addEventListener('mousemove', priceMoveListener);
    listeners.push({ type: 'mousemove', listener: priceMoveListener });

    // 12. 磨损切换按钮
    var wearListener = function (e) {
        var btn = e.target.closest('.wear-btn');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();

        var caseIndex = parseInt(btn.dataset.index);
        var newWear = btn.dataset.wear;
        switchWear(caseIndex, newWear);
    };
    content.addEventListener('click', wearListener);
    listeners.push({ type: 'click', listener: wearListener });

    // 13. 名称列表分页按钮
    var nameListPageListener = function (e) {
        var btn = e.target.closest('.name-list-page-btn');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();

        var page = parseInt(btn.dataset.page);
        if (isNaN(page) || page < 1) return;

        currentNameListPage = page;

        var allData = document.getElementById('case-content')._allData || [];
        renderAllData(allData);
    };
    content.addEventListener('click', nameListPageListener);
    listeners.push({ type: 'click', listener: nameListPageListener });

    // 14. 品质切换按钮
    var qualityListener = function (e) {
        var btn = e.target.closest('.quality-btn');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();

        var caseIndex = parseInt(btn.dataset.index);
        var newQuality = btn.dataset.quality;
        switchQuality(caseIndex, newQuality);
    };
    content.addEventListener('click', qualityListener);
    listeners.push({ type: 'click', listener: qualityListener });

    // 16. ⭐ 「可交易」徽章点击 → 可堆叠直接上架 / 不可堆叠弹窗
    var tradeableBadgeListener = async function (e) {
        var badge = e.target.closest('.inv-count-badge.tradable.clickable');
        if (!badge) return;
        e.stopPropagation();
        e.preventDefault();

        var caseIndex = parseInt(badge.dataset.index);
        if (isNaN(caseIndex)) return;

        var item = WEAPON_CASES[caseIndex];
        if (!item) return;

        // 计算当前 market_hash_name（要带磨损/品质）
        var content = document.getElementById('case-content');
        var allData = content._allData || [];
        var entry = null;
        for (var i = 0; i < allData.length; i++) {
            if (allData[i].index === caseIndex) {
                entry = allData[i];
                break;
            }
        }
        var wear = entry && entry.currentWear ? entry.currentWear : item.is_skin ? item.default_wear : null;
        var quality = entry && entry.currentQuality ? entry.currentQuality : item.is_skin ? item.default_quality : null;
        var mhn = getMarketHashName(item, wear, quality);

        // 获取库存数据（走缓存）
        var inventoryData = await getInventoryData();
        if (!inventoryData || !inventoryData.success) {
            showChartMessage('❌ 无法获取库存数据', 'error');
            return;
        }

        // ⭐ 关键分支
        if (isCommodityItem(inventoryData, mhn)) {
            // 可堆叠：直接走原上架流程，不弹窗
            handleSell(caseIndex, false);
        } else {
            // 不可堆叠：弹出 assetid 列表弹窗
            showTradeableItemsDialog(caseIndex);
        }
    };
    content.addEventListener('click', tradeableBadgeListener);
    listeners.push({ type: 'click', listener: tradeableBadgeListener });

    // ⭐ 「出售中」徽章点击 → 出售中列表弹窗
    var listingBadgeListener = async function (e) {
        var badge = e.target.closest('.inv-count-badge.listing.clickable');
        if (!badge) return;
        e.stopPropagation();
        e.preventDefault();
        var caseIndex = parseInt(badge.dataset.index);
        if (isNaN(caseIndex)) return;

        try {
            await showActiveListingsDialog(caseIndex);
        } catch (err) {
            console.error('[listingBadge] 弹窗失败:', err);
            showChartMessage('❌ 打开出售中列表失败: ' + err.message, 'error');
        }
    };

    content.addEventListener('click', listingBadgeListener);
    listeners.push({ type: 'click', listener: listingBadgeListener });

    // ⭐ 「冷却中」徽章点击 → 冷却中列表弹窗
    var protectedBadgeListener = function (e) {
        var badge = e.target.closest('.inv-count-badge.protected.clickable');
        if (!badge) return;
        e.stopPropagation();
        e.preventDefault();
        var caseIndex = parseInt(badge.dataset.index);
        if (isNaN(caseIndex)) return;
        showCooldownItemsDialog(caseIndex);
    };
    content.addEventListener('click', protectedBadgeListener);
    listeners.push({ type: 'click', listener: protectedBadgeListener });

    // 存储监听器引用以便移除
    content._eventListeners = listeners;
}

// ---------- 切换页码 ----------
function changePage(caseIndex, page) {
    var allData = document.getElementById('case-content')._allData;
    if (!allData) return;

    for (var i = 0; i < allData.length; i++) {
        if (allData[i].index === caseIndex) {
            allData[i].currentPage = page;
            break;
        }
    }

    // 先记录要展开的索引
    var expandIndex = caseIndex;

    renderAllData(allData, expandIndex);
}

// ============================================================
// 修改 buildCaseHTMLWithPagination_Enhanced 函数中的角标部分
// 使用 API 获取的可交易数量来决定颜色状态
// ============================================================

function buildCaseHTMLWithPagination_Enhanced(
    item,
    result,
    index,
    paginated,
    inventoryCount,
    currentWear,
    currentQuality
) {
    var pageData = paginated.pageData;
    var totalPages = paginated.totalPages;
    var currentPage = paginated.currentPage;
    var totalCount = paginated.totalCount;
    var lowestSell = result.lowestSell;
    var sellCount = result.sellCount;

    var allSellOrders = result.sellOrders || [];
    var lowerCumulativeMap = {};
    var cumulativeQty = 0;
    for (var i = 0; i < allSellOrders.length; i++) {
        var price = allSellOrders[i][0];
        var qty = allSellOrders[i][1];
        lowerCumulativeMap[price] = cumulativeQty;
        cumulativeQty += qty;
    }

    var ordersHtml = '';
    if (pageData.length > 0) {
        var rowsHtml = '';
        for (var j = 0; j < pageData.length; j++) {
            var priceVal = pageData[j][0];
            var qtyVal = pageData[j][1];
            var lowerQty = lowerCumulativeMap[priceVal] || 0;
            rowsHtml += `
    <tr>
        <td class="price" data-price="${priceVal}">${formatPrice(priceVal)}</td>
        <td style="text-align:right; color:#66c0f4; font-family:monospace;">${formatQty(lowerQty)}</td>
        <td class="qty">${formatQty(qtyVal)}</td>
    </tr>
`;
        }
        ordersHtml = `
            <table>
                <thead>
                    <tr>
                        <th>价格</th>
                        <th style="text-align:right;">低位挂单量</th>
                        <th style="text-align:right;">数量</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        `;
    } else {
        ordersHtml = '<div class="no-data">暂无挂单数据</div>';
    }

    var paginationHtml = '';
    if (totalPages > 1) {
        var prevDisabled = currentPage <= 1;
        var nextDisabled = currentPage >= totalPages;

        var pageButtons = '';
        var maxVisible = 7;
        var startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        var endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        for (var k = startPage; k <= endPage; k++) {
            var active = k === currentPage ? 'active' : '';
            pageButtons +=
                '<button class="pagination-btn ' +
                active +
                '" data-index="' +
                index +
                '" data-page="' +
                k +
                '">' +
                k +
                '</button>';
        }

        paginationHtml = `
            <div class="pagination">
                <button class="pagination-btn" data-index="${index}" data-page="${currentPage - 1}" ${prevDisabled ? 'disabled' : ''}>◀</button>
                ${pageButtons}
                <button class="pagination-btn" data-index="${index}" data-page="${currentPage + 1}" ${nextDisabled ? 'disabled' : ''}>▶</button>
                <span class="page-info">${currentPage}/${totalPages}</span>
                <span class="page-info">(${totalCount})</span>
                <input class="page-jump" data-index="${index}" data-total-pages="${totalPages}" type="number" min="1" max="${totalPages}" placeholder="页" title="输入页码后按回车跳转">
            </div>
        `;
    }

    var lowestDisplay = lowestSell > 0 ? formatPrice(lowestSell) : '--';
    var countDisplay = sellCount > 0 ? formatQty(sellCount) : '0';

    var hasStock = inventoryCount && inventoryCount.total > 0;
    var hasTradable = inventoryCount && inventoryCount.tradable > 0;
    var totalInv = inventoryCount ? inventoryCount.total : '--';
    var tradableInv = inventoryCount ? inventoryCount.tradable : '--';
    var protectedInv = inventoryCount ? inventoryCount.protected || 0 : '--';
    var hasProtected = inventoryCount && inventoryCount.protected > 0;
    var listingInv = inventoryCount ? inventoryCount.listing || 0 : '--';
    var hasListing = inventoryCount && inventoryCount.listing > 0;

    var maxNameLength = 10;
    var displayName = item.name;
    var isTruncated = false;
    var displayWidth = 0;
    var truncateIndex = item.name.length;
    for (var ch = 0; ch < item.name.length; ch++) {
        var code = item.name.charCodeAt(ch);
        if ((code >= 0x4e00 && code <= 0x9fff) || code >= 0xff00) {
            displayWidth += 2;
        } else {
            displayWidth += 1;
        }
        if (displayWidth > maxNameLength * 1.5) {
            truncateIndex = ch;
            isTruncated = true;
            break;
        }
    }
    if (isTruncated) {
        displayName = item.name.substring(0, truncateIndex) + '…';
    }

    // ---- 磨损切换器 ----
    var wearSwitcherHtml = '';
    if (item.is_skin && item.wears && item.wears.length > 1) {
        var wearButtons = '';
        var activeWear = currentWear || item.default_wear;
        item.wears.forEach(function (w) {
            var isActive = w === activeWear;
            var label = getWearLabel(item, w); // ⭐ 统一走 getWearLabel
            var fullName = getMarketHashName(item, w, currentQuality || item.default_quality || 'normal');
            wearButtons +=
                '<button class="wear-btn' +
                (isActive ? ' active' : '') +
                '"' +
                ' data-index="' +
                index +
                '"' +
                ' data-wear="' +
                w +
                '"' +
                ' title="' +
                fullName +
                '">' + // ⭐ tooltip 显示完整英文名，便于核对
                label +
                '</button>';
        });

        wearSwitcherHtml =
            '<div class="wear-switcher" data-index="' +
            index +
            '">' +
            '<span class="wear-label"></span>' +
            wearButtons +
            '</div>';
    }

    // ---- 品质切换器 ----
    var qualitySwitcherHtml = '';
    if (item.is_skin && item.qualities && item.qualities.length > 1) {
        var qualityButtons = '';
        var activeQuality = currentQuality || item.default_quality || 'normal';

        item.qualities.forEach(function (q) {
            var isActive = q === activeQuality;
            var label = getQualityLabel(item, q);
            var fullName = getMarketHashName(item, currentWear || item.default_wear, q);
            qualityButtons +=
                '<button class="quality-btn' +
                (isActive ? ' active' : '') +
                '"' +
                ' data-index="' +
                index +
                '"' +
                ' data-quality="' +
                q +
                '"' +
                ' title="' +
                fullName +
                '">' +
                label +
                '</button>';
        });

        qualitySwitcherHtml =
            '<div class="quality-switcher" data-index="' +
            index +
            '">' +
            '<span class="quality-label"></span>' +
            qualityButtons +
            '</div>';
    }

    var apiTradableQty = inventoryCount ? inventoryCount.tradable : 0;
    var hasTradable = apiTradableQty > 0;
    var hasProt = inventoryCount && inventoryCount.protected > 0;
    var hasList = inventoryCount && inventoryCount.listing > 0;

    // ⭐ 走统一状态判定 + 统一颜色表
    var statusKey = getStockStatusKey(apiTradableQty, protectedInv, listingInv);
    var badgeColor = STOCK_STATUS_COLORS[statusKey];

    var badgeTitle;
    if (statusKey === 'red') {
        badgeTitle = '可交易: ' + apiTradableQty + ' 件';
    } else if (statusKey === 'purple') {
        badgeTitle = '无可交易（冷却中 ' + protectedInv + ' + 出售中 ' + listingInv + '）';
    } else if (statusKey === 'yellow') {
        badgeTitle = '无可交易（冷却中 ' + protectedInv + '）';
    } else if (statusKey === 'blue') {
        badgeTitle = '无可交易（出售中 ' + listingInv + '）';
    } else {
        badgeTitle = '无可交易物品';
    }

    // ⭐ 皮肤只显示基础名（磨损状态通过 active 的磨损按钮体现）
    var displayFullName = item.name;

    var nameHtml =
        '<span class="case-name-wrapper" data-index="' +
        index +
        '" data-url="' +
        getItemUrl(item, activeWear) +
        '" title="' +
        displayFullName +
        '\n' +
        badgeTitle +
        '">' +
        '<span class="case-name-text">' +
        displayName +
        '</span>' +
        '<span class="inv-badge-dot" style="' +
        'display:inline-block;' +
        'width:10px;' +
        'height:10px;' +
        'border-radius:50%;' +
        'background:' +
        badgeColor +
        ';' +
        'margin-left:4px;' +
        'flex-shrink:0;' +
        'border:1px solid rgba(255,255,255,0.1);' +
        'box-shadow: 0 0 8px ' +
        badgeColor +
        '60;' +
        'transition: all 0.3s ease;' +
        '--badge-color:' +
        badgeColor +
        ';' +
        '" data-tip="' +
        String(badgeTitle).replace(/"/g, '&quot;') +
        '"></span>' +
        '</span>';

    var invStatsHtml = '';

    var isCommodity = inventoryCount ? inventoryCount.isCommodity : false;

    // 徽章的 hover 提示 + 数据属性
    var badgeTip = !hasTradable
        ? '无可交易物品'
        : isCommodity
          ? '点击直接上架（可堆叠物品）'
          : '点击查看 ' + tradableInv + ' 个可交易物品的 assetid 列表';

    var badgeDataAttr = isCommodity ? 'data-commodity="1"' : 'data-commodity="0"';

    var inventoryRowHtml = `
    <div class="inventory-stats ${hasStock ? 'has-stock' : ''}">
        <span class="inv-icon">${hasStock ? '📦' : '📭'}</span>
        <span class="inv-label">我的库存</span>
        <span class="inv-status-dot ${hasStock ? 'has-stock' : 'no-stock'}"></span>

        <span class="inv-count-badge tradable ${hasTradable ? 'clickable' : ''} ${isCommodity ? 'stackable' : 'multi-asset'}"
              data-index="${index}"
              ${badgeDataAttr}
              data-tip="${badgeTip}">
            <span class="count-label">可交易</span>
            <span class="count-num">${tradableInv}</span>
            ${isCommodity ? '<span class="stack-icon" title="可堆叠">≣</span>' : ''}
        </span>

        <span class="inv-count-badge protected ${hasProtected ? 'clickable' : 'empty'}"
      data-index="${index}"
      data-tip="${hasProtected ? '点击查看冷却中的物品（共 ' + protectedInv + ' 个）' : '无冷却中物品'}">
    <span class="count-label">冷却中</span>
    <span class="count-num">${protectedInv}</span>
</span>
        <span class="inv-count-badge listing ${hasListing ? 'clickable' : ''}"
      data-index="${index}"
      data-tip="${hasListing ? '点击查看出售中的物品（共 ' + listingInv + ' 个）' : '无出售中物品'}">
    <span class="count-label">出售中</span>
    <span class="count-num">${listingInv}</span>
</span>

            <div class="inv-btn-group">
    <button class="inv-btn inv-btn-sell"
            data-index="${index}"
            ${hasTradable ? '' : 'disabled'}
            data-tip="${hasTradable ? '' : '无可交易物品'}">
        <span class="btn-icon">⬆</span>
        <span class="btn-text">上架</span>
    </button>
    ${
        item.is_skin
            ? ''
            : `
    <button class="inv-btn inv-btn-batch"
            data-index="${index}"
            ${hasTradable ? '' : 'disabled'}
            data-tip="${hasTradable ? '' : '无可交易物品'}">
        <span class="btn-icon">⬆⬆</span>
        <span class="btn-text">批量</span>
    </button>`
    }
</div>
        </div>
    `;

    return `
        <div class="case-item" data-case-index="${index}">
            <div class="case-item-header">
                ${nameHtml}
                <div class="case-header-right">
                    <div class="case-stats">
                        <span class="lowest">${lowestDisplay}</span>
                        <span class="count">${countDisplay}</span>
                        <span class="arrow">▼</span>
                    </div>
                    <button class="chart-open-btn" data-index="${index}">📊 图表</button>
                    <button class="case-refresh-btn" data-index="${index}">↻</button>
                </div>
            </div>
            <div class="case-orders">
                ${inventoryRowHtml}
                ${wearSwitcherHtml}
                ${qualitySwitcherHtml}
                ${ordersHtml}
                ${paginationHtml}
            </div>
        </div>
    `;
}

// ============================================================
// 修复7：添加调试命令
// ============================================================

console.log('💡 调试命令:');
console.log('  __debugInventory.getStats() - 查看当前统计数据');
console.log('  __debugInventory.requestStats() - 请求统计数据');
console.log('  __debugInventory.forceUpdate() - 强制刷新显示');

console.log('📦 武器箱挂单数据加载中...');

// ============================================================
// 修改 init 函数，检查缓存数据并更新状态点
// ============================================================

// ---------- 获取当前页面的武器箱 ----------
function getFilteredCaseList() {
    if (isMultisellPage()) {
        const multisellItems = getMultisellItems();
        console.log('📦 multisell页面检测到物品:', multisellItems);

        if (multisellItems.length > 0) {
            const filtered = WEAPON_CASES.filter(item => {
                if (item.is_skin) {
                    return multisellItems.some(
                        name => name === item.base_name || name.indexOf(item.base_name + ' (') === 0
                    );
                }
                return multisellItems.some(
                    name =>
                        item.market_hash_name === name ||
                        name.includes(item.market_hash_name) ||
                        item.market_hash_name.includes(name)
                );
            });
            console.log(
                '📦 匹配到的物品:',
                filtered.map(f => f.name)
            );
            return filtered;
        }

        const urlMatch = window.location.href.match(/market\/multisell.*?([A-F0-9]{10,})/);
        if (urlMatch) {
            const id = urlMatch[1];
            for (const item of WEAPON_CASES) {
                if (item.url && item.url.includes(id)) {
                    console.log('📦 从URL匹配到:', item.name);
                    return [item];
                }
            }
        }

        console.warn('⚠️ 无法解析multisell页面的物品列表，将不显示数据');
        return [];
    }

    return WEAPON_CASES;
}

// ---------- 修改加载所有数据 ----------
async function loadAllData() {
    var content = document.getElementById('case-content');
    var status = document.getElementById('case-status');

    if (!content) return;

    // ⭐ 开始加载，抑制 observer
    suppressMultisellObserver = true;

    const casesToLoad = getFilteredCaseList();

    if (casesToLoad.length === 0) {
        content.innerHTML = `
            <div class="no-case-match">
                ⚠️ 当前批量上架页面未检测到支持的物品<br>
                <span style="font-size:12px;color:#5a6a7a;margin-top:8px;display:block;">
                    请确保批量上架列表中包含以下物品之一:<br>
                    ${WEAPON_CASES.map(function (c) {
                        return c.name;
                    }).join('、')}
                </span>
            </div>
        `;
        if (status) status.textContent = '⚠️ 无匹配';
        return;
    }

    content.innerHTML = `
        <div style="text-align:center; padding:20px; color:#8b9aab;">
            <div class="loading-spinner"></div>
            <div style="margin-top:8px;">正在获取 ${casesToLoad.length} 个物品数据...</div>
        </div>
    `;
    if (status) status.textContent = '加载中...';

    var totalCount = casesToLoad.length;
    var successCount = 0;

    // ⭐ 预处理任务
    var tasks = casesToLoad.map(function (item) {
        var originalIndex = WEAPON_CASES.indexOf(item);

        var initialWear = item.is_skin ? item.default_wear : null;
        if (item.is_skin && isMultisellPage()) {
            var msItems = getMultisellItems();
            for (var wi = 0; wi < item.wears.length; wi++) {
                var w = item.wears[wi];
                if (msItems.indexOf(item.base_name + ' (' + w + ')') !== -1) {
                    initialWear = w;
                    break;
                }
            }
        }

        var initialQuality = item.default_quality || 'normal';
        var marketHashName = getMarketHashName(item, initialWear, initialQuality);

        return {
            item: item,
            originalIndex: originalIndex,
            initialWear: initialWear,
            initialQuality: initialQuality,
            marketHashName: marketHashName
        };
    });

    // ⭐ 并发加载（每次 6 个）
    var CONCURRENCY = 6;
    var results = new Array(tasks.length);
    var completedCount = 0;

    async function runTask(task, idx) {
        try {
            var data = await fetchOrderBookCached(task.item.appid, task.marketHashName);
            var result = parseOrderBookCached(data);
            successCount++;
            results[idx] = {
                index: task.originalIndex,
                result: result,
                currentPage: 1,
                currentWear: task.initialWear,
                currentQuality: task.initialQuality
            };
        } catch (e) {
            results[idx] = {
                index: task.originalIndex,
                result: { sellOrders: [], lowestSell: 0, sellCount: 0 },
                error: e.message,
                currentPage: 1,
                currentWear: task.initialWear,
                currentQuality: task.initialQuality
            };
        } finally {
            completedCount++;
            status.textContent = '加载中 ' + completedCount + '/' + totalCount;
        }
    }

    for (var b = 0; b < tasks.length; b += CONCURRENCY) {
        var batch = tasks.slice(b, b + CONCURRENCY);
        await Promise.all(
            batch.map(function (task, i) {
                return runTask(task, b + i);
            })
        );
    }

    var allData = results;

    content._allData = allData;
    renderAllData(allData);
    status.textContent = '✅ ' + successCount + '/' + totalCount + (isMultisellPage() ? ' (已过滤)' : '');

    setTimeout(adjustChartHeight, 500);
}

// ---------- 加载当前页面的武器箱数据（详情页用） ----------
async function loadDataForCurrentCase() {
    var content = document.getElementById('case-content');
    var status = document.getElementById('case-status');

    if (!content) return;

    var matched = getCurrentCase();

    if (!matched) {
        content.innerHTML = `
            <div class="no-case-match">
                ⚠️ 当前页面不是支持的物品页面
            </div>
        `;
        if (status) status.textContent = '⚠️ 未匹配';
        return;
    }

    var currentCase = matched.item;
    var currentWear = matched.wear || (currentCase.is_skin ? currentCase.default_wear : null);
    var marketHashName = getMarketHashName(currentCase, currentWear);

    content.innerHTML = `
        <div style="text-align:center; padding:20px; color:#8b9aab;">
            <div class="loading-spinner"></div>
            <div style="margin-top:8px;">正在获取 ${currentCase.name} 数据...</div>
        </div>
    `;
    if (status) status.textContent = '加载中...';

    try {
        var data = await fetchOrderBook(currentCase.appid, marketHashName);
        var result = parseOrderBook(data);

        var index = WEAPON_CASES.indexOf(currentCase);
        if (index === -1) {
            throw new Error('未找到匹配的物品');
        }

        var currentQuality = matched.quality || (currentCase.is_skin ? currentCase.default_quality : null);
        var marketHashName = getMarketHashName(currentCase, currentWear, currentQuality);

        var allData = [
            {
                index: index,
                result: result,
                currentPage: 1,
                currentWear: currentWear,
                currentQuality: currentQuality
            }
        ];

        content._allData = allData;
        renderAllData(allData);

        setTimeout(function () {
            expandItem(index);
        }, 100);

        if (status) {
            status.textContent = '✅ ' + (result.sellCount > 0 ? formatQty(result.sellCount) : '0');
        }

        setTimeout(adjustChartHeight, 500);
    } catch (e) {
        console.error('加载物品数据失败:', e);
        content.innerHTML = `
            <div class="case-item" style="border-color:#8A4243;">
                <div class="case-item-header">
                    <span class="case-name" style="color:#ff6b6b;">❌ ${currentCase.name}</span>
                    <div class="case-header-right">
                        <div class="case-stats">
                            <span class="count" style="color:#ff6b6b;">请求失败</span>
                            <span class="arrow">▼</span>
                        </div>
                    </div>
                </div>
                <div class="case-orders expanded">
                    <div class="no-data" style="color:#ff6b6b;">${e.message || '加载失败，请重试'}</div>
                </div>
            </div>
        `;
        if (status) status.textContent = '❌ 失败';
    }
}

// ---------- 刷新单个武器箱 ----------
async function refreshSingleItem(index) {
    var item = WEAPON_CASES[index];
    if (!item) return;

    var btn = document.querySelector('.case-refresh-btn[data-index="' + index + '"]');
    var statusEl = document.getElementById('case-status');

    if (!btn) return;

    btn.disabled = true;
    btn.classList.add('refreshing');
    btn.textContent = '⟳';

    try {
        var allDataRef = document.getElementById('case-content')._allData || [];
        var entryRef = null;
        for (var ri = 0; ri < allDataRef.length; ri++) {
            if (allDataRef[ri].index === index) {
                entryRef = allDataRef[ri];
                break;
            }
        }
        var wear = entryRef && entryRef.currentWear ? entryRef.currentWear : item.is_skin ? item.default_wear : null;
        var quality =
            entryRef && entryRef.currentQuality ? entryRef.currentQuality : item.is_skin ? item.default_quality : null;
        var marketHashName = getMarketHashName(item, wear, quality);

        var data = await fetchOrderBook(item.appid, marketHashName);

        var result = parseOrderBook(data);

        var allData = document.getElementById('case-content')._allData;
        if (allData) {
            for (var i = 0; i < allData.length; i++) {
                if (allData[i].index === index) {
                    allData[i].result = result;
                    allData[i].currentPage = 1;
                    allData[i].currentWear = wear; // 保持不变
                    allData[i].error = null;
                    break;
                }
            }
            // 重新渲染
            await renderAllData(allData);
        }

        // ---- 修复：刷新后自动展开 ----
        setTimeout(function () {
            expandItem(index);
        }, 200);

        if (statusEl) {
            var totalItems = document.getElementById('case-content')._allData
                ? document.getElementById('case-content')._allData.length
                : 0;
            if (totalItems > 1) {
                var successCount = 0;
                var allData2 = document.getElementById('case-content')._allData;
                for (var j = 0; j < allData2.length; j++) {
                    if (allData2[j].result && allData2[j].result.sellCount > 0) successCount++;
                }
                statusEl.textContent = '✅ ' + successCount + '/' + totalItems;
            } else {
                statusEl.textContent = '✅ ' + (result.sellCount > 0 ? formatQty(result.sellCount) : '0');
            }
        }

        setTimeout(adjustChartHeight, 300);
    } catch (e) {
        console.error('刷新 ' + item.name + ' 失败:', e);
        btn.disabled = false;
        btn.classList.remove('refreshing');
        btn.textContent = '↻';

        if (statusEl) {
            statusEl.textContent = '❌ ' + item.name + ' 失败';
        }
    }
}

// ---------- 获取 sessionid ----------
// ---------- 获取 sessionid ----------
function getSessionId() {
    try {
        // 1. 从 Cookie 中获取 (最常见)
        let cookies = document.cookie.split('; ');
        for (let cookie of cookies) {
            if (cookie.startsWith('sessionid=')) {
                return cookie.substring('sessionid='.length);
            }
        }

        // 2. 尝试从 HTML 中的隐藏 input 获取 (有些 Steam 页面会注入)
        let sessionInput = document.querySelector('input[name="sessionid"]');
        if (sessionInput) {
            return sessionInput.value;
        }

        // 3. 尝试从 unsafeWindow (Tampermonkey 全局对象) 获取
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.g_sessionID) {
            return unsafeWindow.g_sessionID;
        }
    } catch (e) {
        console.warn('获取 sessionid 失败:', e);
    }
    return null;
}

// ---------- 上架单品 (使用 sellitem 接口) ----------
function submitSingleSell(requestData) {
    return new Promise(function (resolve, reject) {
        // 将参数转为 x-www-form-urlencoded 格式 (Steam 原生 POST 参数)
        const formBody = [];
        for (let key in requestData) {
            const encodedKey = encodeURIComponent(key);
            const encodedValue = encodeURIComponent(requestData[key]);
            formBody.push(encodedKey + '=' + encodedValue);
        }
        const bodyString = formBody.join('&');

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://steamcommunity.com/market/sellitem/',
            data: bodyString,
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                Referer: window.location.href // 必须带上当前页面作为来源
            },
            onload: function (response) {
                // 校验返回
                if (response.status === 200) {
                    // 如果返回的是 HTML 登录页，会解析失败
                    if (!response.responseText || response.responseText.trim().startsWith('<!DOCTYPE')) {
                        reject(new Error('Steam 返回了登录页，请确认你已登录并刷新页面'));
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('JSON解析失败 (接口返回结构异常): ' + e.message));
                    }
                } else {
                    reject(new Error('网络请求失败 (HTTP ' + response.status + ')'));
                }
            },
            onerror: function () {
                reject(new Error('网络连接异常，请检查网络'));
            },
            ontimeout: function () {
                reject(new Error('请求超时，请稍后重试'));
            },
            timeout: 20000
        });
    });
}

// ============================================================
// 修改：上架按钮处理函数
// ============================================================

// ---------- 上架按钮处理函数 ----------
async function handleSell(index, isBatch, specificAssetId) {
    var item = WEAPON_CASES[index];
    if (!item) {
        console.error('未找到物品: index=' + index);
        return;
    }

    var content = document.getElementById('case-content');
    var allData = content._allData || [];
    var entry = null;
    for (var i = 0; i < allData.length; i++) {
        if (allData[i].index === index) {
            entry = allData[i];
            break;
        }
    }
    var wear = entry && entry.currentWear ? entry.currentWear : item.is_skin ? item.default_wear : null;
    var quality = entry && entry.currentQuality ? entry.currentQuality : item.is_skin ? item.default_quality : null;
    var marketHashName = getMarketHashName(item, wear, quality);

    var inventoryData = await getInventoryData();
    if (!inventoryData || !inventoryData.success) {
        showChartMessage('❌ 无法获取库存数据，请确认库存已公开', 'error');
        return;
    }

    var count = countInventoryItemsDualExact(inventoryData, marketHashName);

    if (isBatch) {
        var batchUrl =
            'https://steamcommunity.com/market/multisell?appid=' +
            item.appid +
            '&contextid=2&items[]=' +
            encodeURIComponent(marketHashName) +
            '&qty[]=100';
        window.open(batchUrl, '_blank');
        return;
    }

    // 获取钱包信息用于费用计算
    const walletInfo = getWalletInfo();
    const publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;

    // 显示费用信息弹窗，让用户输入买家支付价格
    const feeDialog = document.createElement('div');
    feeDialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 10010;;
        display: flex;
        justify-content: center;
        align-items: center;
        backdrop-filter: blur(4px);
    `;

    const symbol = getCurrencySymbol();

    feeDialog.innerHTML = `
        <div style="
            background: rgba(27, 40, 56, 0.98);
            border: 1px solid #2a3f5e;
            border-radius: 12px;
            padding: 24px 28px;
            max-width: 420px;
            width: 100%;
            margin: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.8);
            font-family: "Motiva Sans", Arial, sans-serif;
            color: #c6d4df;
        ">
            <div style="text-align:center; font-size:15px; font-weight:bold; color:#66c0f4; margin-bottom:8px;">
                📦 ${item.name}
            </div>
            <div style="font-size:12px; color:#8b9aab; text-align:center; margin-bottom:16px;">
                可交易: ${count.tradable} 个
            </div>
            <div style="margin-bottom:12px;">
                <label style="font-size:12px; color:#8b9aab; display:block; margin-bottom:4px;">
                    输入买家支付价格 (${symbol})
                </label>
                <input id="fee-input-price" type="number" step="0.01" min="0.01"
                    style="
                        width: 100%;
                        padding: 8px 12px;
                        background: rgba(0,0,0,0.3);
                        color: #c6d4df;
                        border: 1px solid #2a3f5e;
                        border-radius: 4px;
                        font-size: 14px;
                        font-family: inherit;
                        box-sizing: border-box;
                    "
                    placeholder="0.00"
                >
            </div>
            <div id="fee-preview" style="
                background: rgba(0,0,0,0.2);
                border-radius: 6px;
                padding: 10px 12px;
                margin-bottom: 12px;
                font-size: 12px;
                min-height: 60px;
                display: none;
            ">
                <div style="display:flex; justify-content:space-between; padding:2px 0;">
                    <span style="color:#8b9aab;">买家支付</span>
                    <span id="preview-buyer" style="color:#ff6b6b;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:2px 0;">
                    <span style="color:#8b9aab;">卖家实收 (提交价格)</span>
                    <span id="preview-seller" style="color:#8bc34a; font-weight:bold;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:2px 0;">
                    <span style="color:#8b9aab;">Steam 手续费</span>
                    <span id="preview-steam-fee" style="color:#ffd93d;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:2px 0;">
                    <span style="color:#8b9aab;">发行商手续费</span>
                    <span id="preview-publisher-fee" style="color:#ffd93d;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:2px 0; border-top:1px solid rgba(255,255,255,0.05); margin-top:2px; padding-top:4px;">
                    <span style="color:#8b9aab;">总手续费</span>
                    <span id="preview-total-fees" style="color:#ff6b6b;">--</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding:2px 0; font-size:10px; color:#4a6a8a;">
                    <span id="preview-fee-percent">手续费占比: --</span>
                </div>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button id="fee-cancel-btn" style="
                    background: transparent;
                    color: #8b9aab;
                    border: 1px solid #2a3f5e;
                    border-radius: 4px;
                    padding: 6px 20px;
                    font-size: 12px;
                    cursor: pointer;
                    font-family: inherit;
                ">取消</button>
                <button id="fee-confirm-btn" style="
                    background: #2a5a7a;
                    color: #c6d4df;
                    border: none;
                    border-radius: 4px;
                    padding: 6px 24px;
                    font-size: 12px;
                    cursor: pointer;
                    font-family: inherit;
                " disabled>上架</button>
            </div>
            <div id="fee-error" style="color:#ff6b6b; font-size:11px; margin-top:8px; text-align:center; display:none;"></div>
        </div>
    `;

    document.body.appendChild(feeDialog);

    const priceInput = feeDialog.querySelector('#fee-input-price');
    const previewDiv = feeDialog.querySelector('#fee-preview');
    const confirmBtn = feeDialog.querySelector('#fee-confirm-btn');
    const cancelBtn = feeDialog.querySelector('#fee-cancel-btn');
    const errorDiv = feeDialog.querySelector('#fee-error');

    // 实时预览费用 - 从买家支付价格计算各项费用
    function updateFeePreview() {
        const inputVal = parseFloat(priceInput.value);
        if (isNaN(inputVal) || inputVal <= 0) {
            previewDiv.style.display = 'none';
            confirmBtn.disabled = true;
            errorDiv.style.display = 'none';
            return;
        }

        const buyerPriceCents = Math.round(inputVal * 100);
        if (buyerPriceCents < 1) {
            previewDiv.style.display = 'none';
            confirmBtn.disabled = true;
            errorDiv.textContent = '⚠️ 价格不能低于 0.01';
            errorDiv.style.display = 'block';
            return;
        }

        // 计算费用：从买家支付价格推导卖家实收
        const feeInfo = calculateSteamFees(buyerPriceCents, walletInfo, publisherFee);

        // 更新预览
        const formatMoney = cents => {
            if (cents === undefined || cents === null) return '--';
            return symbol + ' ' + (cents / 100).toFixed(2);
        };

        document.getElementById('preview-buyer').textContent = formatMoney(feeInfo.buyerPrice);
        document.getElementById('preview-seller').textContent = formatMoney(feeInfo.sellerAmount);
        document.getElementById('preview-steam-fee').textContent = formatMoney(feeInfo.steamFee);
        document.getElementById('preview-publisher-fee').textContent = formatMoney(feeInfo.publisherFee);
        document.getElementById('preview-total-fees').textContent = formatMoney(feeInfo.totalFees);
        document.getElementById('preview-fee-percent').textContent = `手续费占比: ${feeInfo.feePercentage.toFixed(2)}%`;

        previewDiv.style.display = 'block';
        errorDiv.style.display = 'none';
        confirmBtn.disabled = false;

        // 存储费用信息供确认时使用
        feeDialog._feeInfo = feeInfo;
    }

    priceInput.addEventListener('input', updateFeePreview);
    priceInput.addEventListener('focus', function () {
        this.select();
    });

    // 取消按钮
    cancelBtn.addEventListener('click', function () {
        feeDialog.remove();
    });

    // ESC 关闭
    const escHandler = function (e) {
        if (e.key === 'Escape') {
            feeDialog.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // 点击外部关闭
    feeDialog.addEventListener('click', function (e) {
        if (e.target === this) {
            this.remove();
            document.removeEventListener('keydown', escHandler);
        }
    });

    // 确认上架 - 传入卖家实收价格给 Steam API
    confirmBtn.addEventListener('click', async function () {
        const feeInfo = feeDialog._feeInfo;
        if (!feeInfo) {
            errorDiv.textContent = '⚠️ 请先输入有效的价格';
            errorDiv.style.display = 'block';
            return;
        }

        feeDialog.remove();
        document.removeEventListener('keydown', escHandler);

        showFeeDetailDialog(feeInfo, item.name);

        // ⭐ 透传 specificAssetId
        await performSingleSell(item, inventoryData, feeInfo, marketHashName, specificAssetId);
    });

    // 自动聚焦
    setTimeout(() => priceInput.focus(), 100);
}

async function performSingleSell(item, inventoryData, feeInfo, marketHashName, specificAssetId) {
    showChartMessage('⏳ 正在上架 ' + item.name + '...', 'warning');

    try {
        const sessionid = getSessionId();
        if (!sessionid || sessionid.length < 10) {
            showChartMessage('❌ 无法获取有效的 sessionid，请重新刷新页面', 'error');
            return;
        }

        const count = countInventoryItemsDualExact(
            inventoryData,
            marketHashName || getMarketHashName(item, item.default_wear)
        );

        const assetid = specificAssetId || count.assetIds[0];

        // ⭐ 校验指定 assetid 是否还在可交易列表
        if (specificAssetId && count.assetIds.indexOf(specificAssetId) === -1) {
            showChartMessage('⚠️ 该物品已不在可交易状态，请刷新库存', 'warning');
            return;
        }

        const sellerPriceCents = feeInfo.sellerAmount;
        if (sellerPriceCents < 1) {
            showChartMessage('⚠️ 卖家实收价格不能低于 0.01 元', 'warning');
            return;
        }

        const requestData = {
            sessionid: sessionid,
            appid: item.appid,
            contextid: '2',
            assetid: assetid,
            amount: 1,
            price: sellerPriceCents
        };

        const result = await submitSingleSell(requestData);

        // ⭐ 成功 / 失败处理
        if (result && result.success) {
            const symbol = getCurrencySymbol();
            showChartMessage(
                '✅ 上架成功！\n' +
                    item.name +
                    ' 已上架\n\n' +
                    '💰 买家支付: ' +
                    symbol +
                    ' ' +
                    (feeInfo.buyerPrice / 100).toFixed(2) +
                    '\n' +
                    '📥 卖家实收: ' +
                    symbol +
                    ' ' +
                    (feeInfo.sellerAmount / 100).toFixed(2) +
                    '\n' +
                    '📊 手续费: ' +
                    symbol +
                    ' ' +
                    (feeInfo.totalFees / 100).toFixed(2) +
                    ' (' +
                    feeInfo.feePercentage.toFixed(1) +
                    '%)',
                'warning'
            );

            // ⭐ 清除库存缓存，下次刷新能拿到最新数据
            cachedInventoryData = null;
            inventoryCacheTime = 0;

            // ⭐ 关掉可能还开着的列表面板（重新打开时会拿到最新库存）
            var listOverlay = document.querySelector('.item-list-overlay');
            if (listOverlay) listOverlay.remove();

            setTimeout(() => {
                const refreshBtn = document.getElementById('refresh-cases');
                if (refreshBtn) refreshBtn.click();
            }, 1500);
        } else {
            const errorMsg = result && result.message ? result.message : '未知错误';
            showChartMessage('❌ 上架失败: ' + errorMsg, 'error');
        }
    } catch (e) {
        console.error('上架失败详细:', e);
        showChartMessage('❌ 上架异常: ' + e.message, 'error');
    }
}

// ---------- 从冷却截止时间和冷却期倒推入库时间 ----------
// deadline: Date 对象（冷却截止时间）
// restrictionDays: 冷却期总长（天）
// 返回: Date 对象（入库时间），或 null
function calcAcquiredTime(deadline, restrictionDays) {
    if (!deadline) return null;
    if (!restrictionDays || restrictionDays <= 0) return null;

    var acquired = new Date(deadline.getTime() - restrictionDays * 24 * 60 * 60 * 1000);
    return acquired;
}

// ---------- 格式化为 YYYY/M/D HH:mm ----------
function formatAcquiredTime(date) {
    if (!date) return '--';
    var y = date.getFullYear();
    var m = date.getMonth() + 1;
    var d = date.getDate();
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    return y + '/' + m + '/' + d + ' ' + hh + ':' + mm;
}

// ---------- 从 owner_descriptions 解析冷却截止时间 ----------
function parseCooldownFromOwnerDescriptions(ownerDescs) {
    if (!ownerDescs || !Array.isArray(ownerDescs)) return null;

    for (var i = 0; i < ownerDescs.length; i++) {
        var text = ownerDescs[i].value || '';

        // 中文格式：在10 月 14 日 下午 11:00之前
        var m = text.match(/在\s*(\d+)\s*月\s*(\d+)\s*日\s*(上午|下午)\s*(\d+):(\d+)之前/);
        if (m) {
            var month = parseInt(m[1], 10);
            var day = parseInt(m[2], 10);
            var ampm = m[3];
            var hour = parseInt(m[4], 10);
            var minute = parseInt(m[5], 10);

            if (ampm === '下午' && hour < 12) hour += 12;
            if (ampm === '上午' && hour === 12) hour = 0;

            return buildCooldownDeadline(month, day, hour, minute);
        }

        // 英文格式：Tradable After Oct 14, 2026 11:00 PM
        var m2 = text.match(/Tradable After\s+(\w+)\s+(\d+),?\s*(\d{4})?\s*(\d+):(\d+)\s*(AM|PM)/i);
        if (m2) {
            var monthNames = {
                jan: 1,
                feb: 2,
                mar: 3,
                apr: 4,
                may: 5,
                jun: 6,
                jul: 7,
                aug: 8,
                sep: 9,
                oct: 10,
                nov: 11,
                dec: 12
            };
            var monthEn = monthNames[m2[1].toLowerCase().slice(0, 3)];
            if (!monthEn) continue;
            var dayEn = parseInt(m2[2], 10);
            var hourEn = parseInt(m2[4], 10);
            var minuteEn = parseInt(m2[5], 10);
            var ampmEn = m2[6].toUpperCase();

            if (ampmEn === 'PM' && hourEn < 12) hourEn += 12;
            if (ampmEn === 'AM' && hourEn === 12) hourEn = 0;

            return buildCooldownDeadline(monthEn, dayEn, hourEn, minuteEn);
        }
    }
    return null;
}

// ---------- 根据月/日/时/分构造 deadline（自动处理跨年） ----------
function buildCooldownDeadline(month, day, hour, minute) {
    var now = new Date();
    var year = now.getFullYear();
    // ⭐ 直接用今年，不加一年
    return new Date(year, month - 1, day, hour, minute);
}

// ---------- 计算剩余时间文本 ----------
function formatRemainingTime(deadline) {
    if (!deadline) return '--';

    var now = new Date();
    var diffMs = deadline.getTime() - now.getTime();
    if (diffMs <= 0) return '已结束';

    var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    var diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    var diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffDays > 0) {
        return diffDays + ' 天 ' + diffHours + ' 小时';
    }
    if (diffHours > 0) {
        return diffHours + ' 小时 ' + diffMinutes + ' 分钟';
    }
    return diffMinutes + ' 分钟';
}

// ============================================================
// ============================================================
// 冷却中物品列表弹窗
// ============================================================
async function showCooldownItemsDialog(caseIndex) {
    var item = WEAPON_CASES[caseIndex];
    if (!item) return;

    var inventoryData = await getInventoryData();
    if (!inventoryData || !inventoryData.success) {
        showChartMessage('❌ 无法获取库存数据，请确认库存已公开', 'error');
        return;
    }

    // ⭐ 判断可堆叠性（用默认档位探测）
    var probeWear = item.is_skin ? item.default_wear : null;
    var probeQuality = item.is_skin ? item.default_quality || 'normal' : 'normal';
    var probeMhn = getMarketHashName(item, probeWear, probeQuality);
    var isCommodity = isCommodityItem(inventoryData, probeMhn);

    // ⭐ 从 protected 分区收集物品
    var prot = inventoryData.protected;
    if (!prot || !prot.success) {
        showChartMessage('⚠️ 没有冷却中的 ' + item.name, 'warning');
        return;
    }

    // 建立 classid+instanceid → description 映射
    var descMap = {};
    (prot.descriptions || []).forEach(function (d) {
        descMap[d.classid + '_' + (d.instanceid || '0')] = d;
    });

    // ⭐ 第一步：收集所有属于该 item 的原始 asset（不受 wears/qualities 配置限制）
    var rawAssets = [];
    (prot.assets || []).forEach(function (asset) {
        var key = asset.classid + '_' + (asset.instanceid || '0');
        var desc = descMap[key];
        if (!desc) return;

        // ⭐ 用 isDescriptionOfItem 判断（兼容所有档位，不依赖配置）
        if (!isDescriptionOfItem(desc, item)) return;

        // ⭐ 走统一判断（含过期校验）
        if (!isTradableProtected(desc)) {
            return; // 不是冷却中（可能是挂售中、交易中、或已冷却结束）
        }

        var mhn = desc.market_hash_name;
        if (!mhn) return;

        // ⭐ 从 mhn 解析磨损度（中文/英文）
        var wearInfo = parseWearFromHashName(mhn, item);
        var wearZh = wearInfo.zh || '--';

        // ⭐ 从 owner_descriptions 解析冷却截止时间
        var deadline = parseCooldownFromOwnerDescriptions(desc.owner_descriptions);
        var cooldownText;
        var cooldownDeadline;
        if (deadline) {
            console.log(
                '[冷却中] 成功解析 deadline:',
                deadline,
                '| assetid:',
                asset.assetid,
                '| mhn:',
                desc.market_hash_name
            );
            cooldownText = formatRemainingTime(deadline);
            cooldownDeadline = deadline.getTime();
        } else {
            // 兜底
            console.log('[冷却中] deadline 为空！assetid:', asset.assetid, '| mhn:', desc.market_hash_name);
            console.log('[冷却中] desc.owner_descriptions:', JSON.stringify(desc.owner_descriptions, null, 2));
            console.log('[冷却中] desc.owner_descriptions 类型:', typeof desc.owner_descriptions);
            console.log('[冷却中] 是否数组:', Array.isArray(desc.owner_descriptions));
            var cooldownDays = parseInt(desc.market_tradable_restriction, 10) || 0;
            cooldownText = cooldownDays > 0 ? '冷却期 ' + cooldownDays + ' 天' : '--';
            cooldownDeadline = 0;
        }

        // ⭐ 用「截止时间 - 冷却期总长」倒推入库时间
        var restrictionDays = parseInt(desc.market_tradable_restriction, 10) || 0;
        var acquiredDate = calcAcquiredTime(deadline, restrictionDays);
        var acquiredAt = formatAcquiredTime(acquiredDate); // "2026/10/13 11:00" 或 "--"

        rawAssets.push({
            assetid: asset.assetid,
            amount: parseInt(asset.amount, 10) || 1,
            wear: wearZh,
            wearEn: wearInfo.en, // ⭐ 新增：英文磨损度
            cooldown: cooldownText,
            cooldownDeadline: cooldownDeadline,
            acquiredAt: acquiredAt,
            mhn: mhn
        });
    });

    if (rawAssets.length === 0) {
        showChartMessage('⚠️ 没有冷却中的 ' + item.name, 'warning');
        return;
    }

    // ⭐ 第二步：按类型分组
    var items = [];
    if (isCommodity) {
        // 可堆叠：按「截止时间」分组，累加数量
        var groupMap = {};
        rawAssets.forEach(function (a) {
            var key = a.cooldownDeadline + '|' + a.wear;
            if (!groupMap[key]) {
                groupMap[key] = {
                    cooldownDeadline: a.cooldownDeadline,
                    wear: a.wear,
                    cooldown: a.cooldown,
                    acquiredAt: a.acquiredAt, // ⭐ 新增
                    count: 0,
                    firstAssetId: a.assetid,
                    mhn: a.mhn
                };
            }
            groupMap[key].count += a.amount;
        });

        var groups = Object.values(groupMap).sort(function (a, b) {
            return a.cooldownDeadline - b.cooldownDeadline;
        });

        groups.forEach(function (g) {
            items.push({
                assetid: g.firstAssetId,
                assetidDisplay: g.firstAssetId + ' 等 ' + g.count + ' 个',
                cooldown: g.cooldown,
                acquiredAt: g.acquiredAt, // ⭐ 新增
                count: g.count
            });
        });
    } else {
        // 不可堆叠：每个 assetid 一行
        rawAssets.forEach(function (a) {
            items.push({
                assetid: a.assetid,
                wear: a.wear,
                wearEn: a.wearEn, // ⭐ 新增
                cooldown: a.cooldown,
                acquiredAt: a.acquiredAt,
                mhn: a.mhn, // ⭐ 确保有
                caseIndex: caseIndex // ⭐ 新增：直接定位用
            });
        });
    }

    var displayName = item.name;

    // ⭐ 列定义
    var columns;
    if (isCommodity) {
        columns = [
            { key: 'assetidDisplay', label: '物品ID', align: 'left' },
            { key: 'acquiredAt', label: '入库时间', width: '150px', align: 'center' }, // ⭐ 新增
            { key: 'cooldown', label: '剩余冷却时间', width: '160px', align: 'center' },
            { key: 'count', label: '数量', width: '80px', align: 'center' }
        ];
    } else {
        columns = [
            { key: '__assetid__', label: '物品ID', align: 'left' },
            { key: 'wear', label: '磨损度', width: '100px', align: 'center' },
            { key: '__chart__', label: '走势', width: '52px', align: 'center' }, // ⭐ 新增
            { key: 'acquiredAt', label: '入库时间', width: '150px', align: 'center' }, // ⭐ 新增
            { key: 'cooldown', label: '剩余冷却时间', width: '160px', align: 'center' }
        ];
    }

    showItemListDialog({
        title: displayName + ' - 冷却中',
        iconUrl: getItemIconUrl(item),
        iconUrlHighRes: getItemIconUrl(item, '256fx256f'),
        columns: columns,
        items: items,
        pageSize: 50,
        pageSizes: [10, 50, 100],
        rowActions: null,
        isCommodity: isCommodity, // ⭐ 新增
        onRefresh: function () {
            // ⭐ 清库存缓存，强制重新请求 context 16
            cachedInventoryData = null;
            inventoryCacheTime = 0;
            showCooldownItemsDialog(caseIndex);
        }
    });
}

// ============================================================
// 可交易物品列表弹窗
// ============================================================
async function showTradeableItemsDialog(caseIndex) {
    var item = WEAPON_CASES[caseIndex];
    if (!item) return;

    var inventoryData = await getInventoryData();
    if (!inventoryData || !inventoryData.success) {
        showChartMessage('❌ 无法获取库存数据，请确认库存已公开', 'error');
        return;
    }

    // ⭐ 判断可堆叠性
    var probeWear = item.is_skin ? item.default_wear : null;
    var probeQuality = item.is_skin ? item.default_quality || 'normal' : 'normal';
    var probeMhn = getMarketHashName(item, probeWear, probeQuality);
    var isCommodity = isCommodityItem(inventoryData, probeMhn);

    var items = [];
    var wears = item.is_skin ? item.wears || [] : [null];
    var qualities = item.is_skin ? item.qualities || ['normal'] : ['normal'];
    var displayName = item.name;
    var seenAssetIds = new Set();

    for (var wi = 0; wi < wears.length; wi++) {
        for (var qi = 0; qi < qualities.length; qi++) {
            var wear = wears[wi];
            var quality = qualities[qi];
            var mhn = getMarketHashName(item, wear, quality);

            var count = countInventoryItemsDualExact(inventoryData, mhn);
            if (!count.assetIds || count.assetIds.length === 0) continue;

            var wearZh = item.is_skin ? WEAR_LABELS[wear] || wear || '--' : '--';

            count.assetIds.forEach(function (aid) {
                if (seenAssetIds.has(aid)) return;
                seenAssetIds.add(aid);
                items.push({
                    assetid: aid,
                    wear: wearZh, // ⭐ 该条 asset 的磨损（不可堆叠时用）
                    mhn: mhn, // ⭐ 该条 asset 对应的 market_hash_name
                    caseIndex: caseIndex, // ⭐ 新增
                    cooldown: ''
                });
            });
        }
    }

    if (items.length === 0) {
        showChartMessage('⚠️ 无可交易的 ' + item.name, 'warning');
        return;
    }

    var symbol = getCurrencySymbol();

    // ⭐ 动态列定义
    var columns;
    if (isCommodity) {
        columns = [
            { key: '__check__', label: '☑', width: '36px', align: 'center' },
            { key: '__index__', label: '序号', width: '60px', align: 'center' },
            { key: '__price__', label: '售价 (' + symbol + ')', width: '120px', align: 'center' },
            { key: '__action__', label: '操作', width: '100px', align: 'center' }
        ];
    } else {
        columns = [
            { key: '__check__', label: '☑', width: '36px', align: 'center' },
            { key: '__assetid__', label: '物品ID', align: 'left' },
            { key: 'wear', label: '磨损度', width: '100px', align: 'center' },
            { key: '__chart__', label: '走势', width: '52px', align: 'center' }, // ⭐ 新增
            { key: '__price__', label: '出售价格 (' + symbol + ')', width: '120px', align: 'center' },
            { key: '__action__', label: '操作', width: '140px', align: 'center' }
        ];
    }

    var rowActions = {
        priceInput: function (rowItem) {
            return `<div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
            <input type="number" step="0.01" min="0.01"
                   class="item-list-price-input"
                   data-assetid="${rowItem.assetid}"
                   placeholder="0.00"
                   style="width:90px; padding:3px 6px; background:rgba(0,0,0,0.3);
                          color:#c6d4df; border:1px solid #2a3f5e; border-radius:3px;
                          font-size:11px; font-family:inherit; text-align:center;
                          box-sizing:border-box;">
            <span class="item-list-seller-text" style="font-size:10px; color:#8b9aab;" title="扣除手续费后实际到账">实收 --</span>
        </div>`;
        },
        sellBtn: function (rowItem) {
            return `<button class="item-list-sell-btn"
                        data-assetid="${rowItem.assetid}"
                        disabled
                        title="请先填写售价"
                        style="background:rgba(46,160,67,0.15); color:#4a6a4a;
                               border:1px solid rgba(139,195,74,0.15); border-radius:4px;
                               padding:3px 12px; font-size:11px; cursor:not-allowed;
                               font-family:inherit; transition:all 0.2s;
                               min-width:60px;">⬆ 上架</button>`;
        },
        bind: function (rowEl, rowItem, api) {
            var input = rowEl.querySelector('.item-list-price-input');
            var btn = rowEl.querySelector('.item-list-sell-btn');
            if (!input || !btn) return;

            function updateBtnState() {
                var val = parseFloat(input.value);
                var valid = !isNaN(val) && val >= 0.01;
                if (valid) {
                    btn.disabled = false;
                    btn.style.background = 'rgba(46,160,67,0.2)';
                    btn.style.color = '#8bc34a';
                    btn.style.borderColor = 'rgba(139,195,74,0.3)';
                    btn.style.cursor = 'pointer';
                    btn.title = '上架该物品（买家支付 ' + symbol + ' ' + val.toFixed(2) + '）';
                } else {
                    btn.disabled = true;
                    btn.style.background = 'rgba(46,160,67,0.15)';
                    btn.style.color = '#4a6a4a';
                    btn.style.borderColor = 'rgba(139,195,74,0.15)';
                    btn.style.cursor = 'not-allowed';
                    btn.title = '请先填写售价';
                }
                // ⭐ 新增：更新"实收"文字
                var sellerEl = rowEl.querySelector('.item-list-seller-text');
                if (sellerEl) {
                    if (valid) {
                        var walletInfo = getWalletInfo();
                        var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;
                        var feeInfo = calculateSteamFees(Math.round(val * 100), walletInfo, publisherFee);
                        sellerEl.textContent = '实收 ' + formatPrice(feeInfo.sellerAmount);
                    } else {
                        sellerEl.textContent = '实收 --';
                    }
                }
            }

            input.addEventListener('input', updateBtnState);
            input.addEventListener('focus', function () {
                this.select();
            });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !btn.disabled) btn.click();
                e.stopPropagation();
            });

            btn.addEventListener('click', function () {
                if (this.disabled) return;
                var buyerPrice = parseFloat(input.value);
                if (isNaN(buyerPrice) || buyerPrice < 0.01) return;

                var buyerPriceCents = Math.round(buyerPrice * 100);
                var walletInfo = getWalletInfo();
                var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_default) || 0.1;
                var feeInfo = calculateSteamFees(buyerPriceCents, walletInfo, publisherFee);

                showFeeDetailDialog(feeInfo, displayName);
                // ⭐ 用 rowItem.mhn
                performSingleSell(item, inventoryData, feeInfo, rowItem.mhn, rowItem.assetid);
            });
        },

        bind: function (rowEl, rowItem, api) {
            // ... 原有代码不变 ...
        },

        // ⭐ 批量上架回调（复用 showItemListDialog 的批量工具条）
        onBatchModify: async function (selected, api) {
            // selected: [{ item, rowIdx, newPriceCents }, ...]
            if (!selected || selected.length === 0) return;

            if (!confirm('确定要批量上架选中的 ' + selected.length + ' 项吗？\n\n每个物品会以各自填写的价格上架。')) {
                return;
            }

            api.close();

            var sessionid = getSessionId();
            if (!sessionid) {
                showChartMessage('❌ 无法获取 sessionid，请刷新页面', 'error');
                return;
            }

            var walletInfo = getWalletInfo();
            var publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.1;

            var successCount = 0;
            var failCount = 0;
            var failDetails = [];

            for (var i = 0; i < selected.length; i++) {
                var entry = selected[i];
                var rowItem = entry.item;
                var buyerPriceCents = entry.newPriceCents;

                showChartMessage(
                    '⏳ 批量上架中... (' +
                        (i + 1) +
                        '/' +
                        selected.length +
                        ')\n' +
                        '物品ID: ' +
                        rowItem.assetid +
                        '\n' +
                        '价格: ' +
                        symbol +
                        ' ' +
                        (buyerPriceCents / 100).toFixed(2),
                    'warning'
                );

                try {
                    var feeInfo = calculateSteamFees(buyerPriceCents, walletInfo, publisherFee);
                    var requestData = {
                        sessionid: sessionid,
                        appid: item.appid,
                        contextid: '2',
                        assetid: rowItem.assetid,
                        amount: 1,
                        price: feeInfo.sellerAmount
                    };
                    var result = await submitSingleSell(requestData);

                    if (result && result.success) {
                        successCount++;
                    } else {
                        failCount++;
                        failDetails.push(rowItem.assetid + ': ' + ((result && result.message) || '未知错误'));
                    }
                } catch (e) {
                    failCount++;
                    failDetails.push(rowItem.assetid + ': ' + e.message);
                }

                // 每项间隔 1 秒，避免限流
                if (i < selected.length - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            showChartMessage(
                '✅ 批量上架完成\n' +
                    '成功: ' +
                    successCount +
                    ' 项\n' +
                    '失败: ' +
                    failCount +
                    ' 项' +
                    (failDetails.length > 0 ? '\n\n失败详情（前 5 条）:\n' + failDetails.slice(0, 5).join('\n') : ''),
                failCount > 0 ? 'error' : 'warning'
            );

            // ⭐ 清库存缓存，让主面板刷新后拿到最新数据
            cachedInventoryData = null;
            inventoryCacheTime = 0;
            cachedListingsData = null;
            listingsCacheTime = 0;

            setTimeout(function () {
                var refreshBtn = document.getElementById('refresh-cases');
                if (refreshBtn) refreshBtn.click();
            }, 1500);
        }
    };

    showItemListDialog({
        title: displayName + ' - 可交易',
        iconUrl: getItemIconUrl(item),
        iconUrlHighRes: getItemIconUrl(item, '256fx256f'),
        columns: columns,
        items: items,
        pageSize: 50,
        pageSizes: [10, 50, 100],
        rowActions: rowActions,
        batchModifyLabel: '批量上架',
        showBatchRemove: false,
        isCommodity: isCommodity, // ⭐ 新增
        onRefresh: function () {
            cachedInventoryData = null;
            inventoryCacheTime = 0;
            showTradeableItemsDialog(caseIndex);
        }
    });
}

// ---------- 根据页面类型加载数据 ----------
function loadDataByPageType() {
    // ⭐ 兜底：如果 searchFilter 是已废弃的值，重置为 all
    if (searchFilter === 'no-tradable') {
        searchFilter = 'all';
    }

    if (isListingPage()) {
        searchKeyword = '';
        searchFilter = 'all';
        stockStatusFilter = 'all'; // ⭐ 新增
    }

    var stockStatusSelect = document.getElementById('stock-status-filter');
    if (stockStatusSelect) {
        stockStatusSelect.value = 'all';
        if (typeof stockStatusSelect._syncColor === 'function') {
            stockStatusSelect._syncColor();
        }
    }
    currentNameListPage = 1;

    var si = document.getElementById('case-search-input');
    if (si) si.value = '';
    document.querySelectorAll('.case-filter-btn').forEach(function (b) {
        b.classList.toggle('active', b.dataset.filter === 'all');
    });

    if (isMultisellPage()) {
        loadAllData();
    } else if (isMarketHomePage()) {
        loadAllData();
    } else if (isListingPage()) {
        loadDataForCurrentCase();
    } else {
        loadAllData();
    }
}

// ---------- 启动 ----------
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// 键盘快捷键
document.addEventListener('keydown', function (e) {
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
        var refreshBtn = document.getElementById('refresh-cases');
        if (refreshBtn) {
            e.preventDefault();
            refreshBtn.click();
        }
    }
    if (e.key === 'Escape') {
        closeChart();
    }
});

console.log('📦 武器箱挂单数据加载中...');
console.log('📌 首页模式: 加载全部武器箱数据');
console.log('📌 详情页模式: 只加载当前武器箱数据');
console.log('📊 点击 "📊 图表" 按钮查看成交量-价格中位数走势图');
console.log('💡 提示: 可切换 本日/本周/本月/最近一年 时间跨度');
console.log('💡 提示: 点击 "📅 自定义" 可选择任意时间范围（至少1小时）');
console.log('💡 提示: 图表日期格式为 YYYY/M/D HH时');
console.log('💡 提示: 拖拽面板标题栏可移动面板位置');
console.log('💡 提示: 点击武器箱名称可跳转到详情页');
console.log('💡 提示: Ctrl+R 快速刷新数据');

// ⭐ 暴露到页面的 window，控制台才能访问
var __invExports = {
    // 库存
    getInventoryData: getInventoryData,
    countInventoryItemsDual: countInventoryItemsDual,
    countInventoryItemsDualExact: countInventoryItemsDualExact,
    countInventoryItemsByMatcher: countInventoryItemsByMatcher,
    countInventoryItems: countInventoryItems,
    isDescriptionOfItem: isDescriptionOfItem,
    isCommodityItem: isCommodityItem,
    STOCK_STATUS_COLORS: STOCK_STATUS_COLORS,
    getStockStatusKey: getStockStatusKey,

    // 挂单
    fetchMyListings: fetchMyListings,
    fetchMyListingsDetailed: fetchMyListingsDetailed,
    getAllMyListings: getAllMyListings,
    readListingsFromPage: readListingsFromPage,
    getActiveListingsFromPage: getActiveListingsFromPage,
    removeListing: removeListing,
    modifyListingPrice: modifyListingPrice,
    showActiveListingsDialog: showActiveListingsDialog,
    showCooldownItemsDialog: showCooldownItemsDialog,
    countListingsByItem: countListingsByItem,
    countListingsByHashName: countListingsByHashName,

    // 工具
    getWalletInfo: getWalletInfo, // ⭐ 加这一行
    getCurrencyCode: getCurrencyCode, // ⭐ 也建议加上
    calculateSteamFees: calculateSteamFees,
    getMarketHashName: getMarketHashName,
    parseWearFromHashName: parseWearFromHashName,
    getCurrentCase: getCurrentCase,
    getItemUrl: getItemUrl,
    getWearLabel: getWearLabel,
    getQualityLabel: getQualityLabel,
    getSessionId: getSessionId,
    submitSingleSell: submitSingleSell,
    parseCooldownFromOwnerDescriptions: parseCooldownFromOwnerDescriptions,
    formatRemainingTime: formatRemainingTime,
    getItemIconUrl: getItemIconUrl,
    buildCooldownDeadline: buildCooldownDeadline,
    sTradableProtected: isTradableProtected,

    // 常量
    WEAPON_CASES: WEAPON_CASES,
    WEAR_LABELS: WEAR_LABELS,
    QUALITY_PREFIX: QUALITY_PREFIX,
    QUALITY_LABELS: QUALITY_LABELS
};

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.__inv = __invExports;
    console.log('✅ __inv 已暴露到 unsafeWindow');
} else {
    window.__inv = __invExports;
    console.log('✅ __inv 已暴露到 window');
}
