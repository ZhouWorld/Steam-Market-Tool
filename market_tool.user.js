
// ==UserScript==
// @name         Steam武器箱挂单数据查询
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  在 Steam 市场页面自动查询并显示武器箱的挂单数据（支持精确费用计算 + 库存统计联动）
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
// @icon         https://store.steampowered.com/favicon.ico
// @connect      steamcommunity.com
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
// @require https://cdn.jsdelivr.net/npm/json5@2.2.3/dist/index.min.js
// @resource     chartjs_css https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
// @grant        GM_getResourceText
// @resource     myConfig https://gist.githubusercontent.com/ZhouWorld/3845fc1ac1d95a529f0623202795968f/raw/ed6a29517f8523df734fae39b0a36bd885040f74/myConfig.json5
// ==/UserScript==


let currentNameListPage = 1;
const NAME_LIST_PAGE_SIZE = 10;

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
// 新增：持久化存储模块
// ============================================================

const STORAGE = {
    KEY: 'steam_inventory_stats_data',
    VERSION: 1,
    EXPIRE_DAYS: 7,

    save: function(data) {
        if (!data) return false;
        try {
            const payload = {
                version: this.VERSION,
                data: data,
                savedAt: Date.now(),
                expiresAt: Date.now() + this.EXPIRE_DAYS * 24 * 60 * 60 * 1000
            };
            GM_setValue(this.KEY, JSON.stringify(payload));
            console.log('💾 库存统计数据已保存 (有效期 ' + this.EXPIRE_DAYS + ' 天)');
            return true;
        } catch(e) {
            console.warn('保存库存统计数据失败:', e);
            return false;
        }
    },

    load: function() {
        try {
            const stored = GM_getValue(this.KEY, null);
            if (!stored) {
                console.log('📭 无持久化数据');
                return null;
            }

            const payload = JSON.parse(stored);

            if (payload.version !== this.VERSION) {
                console.log('📌 数据版本不匹配，忽略旧数据');
                return null;
            }

            if (Date.now() > payload.expiresAt) {
                console.log('⏰ 缓存数据已过期 (超过 ' + this.EXPIRE_DAYS + ' 天)');
                this.clear();
                return null;
            }

            // 验证数据完整性
            if (!payload.data || !payload.data.tableData) {
                console.log('⚠️ 数据格式无效');
                return null;
            }

            console.log('📦 加载持久化库存统计数据 (保存于 ' + new Date(payload.savedAt).toLocaleString() + ')');
            console.log('   📊 物品种类: ' + payload.data.tableData.length + ' 种');
            return payload.data;
        } catch(e) {
            console.warn('加载库存统计数据失败:', e);
            return null;
        }
    },

    clear: function() {
        try {
            GM_deleteValue(this.KEY);
            console.log('🧹 已清除持久化库存统计数据');
            return true;
        } catch(e) {
            console.warn('清除数据失败:', e);
            return false;
        }
    },

    getSaveTime: function() {
        try {
            const stored = GM_getValue(this.KEY, null);
            if (!stored) return null;
            const payload = JSON.parse(stored);
            return payload.savedAt;
        } catch(e) {
            return null;
        }
    },

    hasValidData: function() {
        try {
            const stored = GM_getValue(this.KEY, null);
            if (!stored) return false;
            const payload = JSON.parse(stored);
            return payload.version === this.VERSION && Date.now() < payload.expiresAt;
        } catch(e) {
            return false;
        }
    }
};

// ============================================================
// 联动模块：通过 GM_setValue 与脚本2通信
// ============================================================

// ============================================================
// 修复：INVENTORY_STATS 对象 - 异步加载持久化数据
// ============================================================

const INVENTORY_STATS = {
    data: null,
    loaded: false,
    requestId: null,
    isWaiting: false,

    // 异步加载持久化数据
    loadPersistedData: function() {
        return new Promise((resolve) => {
            const savedData = STORAGE.load();
            if (savedData) {
                this.data = savedData;
                this.loaded = true;
                console.log('✅ 加载持久化库存统计数据成功');
                resolve(true);
            } else {
                console.log('📭 未找到有效的持久化库存统计数据');
                resolve(false);
            }
        });
    },

    requestStats: function(itemNames) {
        return new Promise((resolve) => {
            const STORAGE_KEY = 'steam_inventory_stats';
            this.requestId = Date.now() + '_' + Math.random().toString(36).substr(2, 6);

            console.log('📡 请求库存统计数据 (ID: ' + this.requestId + ')');
            console.log('📦 请求物品列表:', itemNames);

            try {
                localStorage.removeItem(STORAGE_KEY + '_request');
                localStorage.removeItem(STORAGE_KEY + '_response');

                const signal = {
                    type: 'request',
                    requestId: this.requestId,
                    timestamp: Date.now(),
                    items: itemNames || [],
                    requester: 'weapon-cases-script'
                };

                localStorage.setItem(STORAGE_KEY + '_request', JSON.stringify(signal));
                console.log('📡 已发送请求信号 (ID: ' + this.requestId + ')');

            } catch(e) {
                console.error('❌ 发送请求失败:', e);
                resolve(null);
                return;
            }

            let attempts = 0;
            const maxAttempts = 600;

            const checkInterval = setInterval(() => {
                attempts++;

                try {
                    const responseData = localStorage.getItem(STORAGE_KEY + '_response');

                    if (responseData) {
                        try {
                            const response = JSON.parse(responseData);
                            if (response.requestId === this.requestId) {
                                clearInterval(checkInterval);
                                if (response.success && response.data) {
                                    this.data = response.data;
                                    this.loaded = true;
                                    console.log('✅ 收到库存统计数据 (ID: ' + this.requestId + ')');
                                    localStorage.removeItem(STORAGE_KEY + '_response');

                                    // 持久化保存
                                    STORAGE.save(this.data);
                                    updateStatsStatusIndicator();

                                    resolve(this.data);
                                } else {
                                    console.warn('⚠️ 库存统计请求失败:', response.error || '未知错误');
                                    resolve(null);
                                }
                                return;
                            }
                        } catch(e) {}
                    }
                } catch(e) {}

                if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    console.log('⏰ 等待库存统计数据超时');
                    resolve(null);
                }
            }, 500);

            this.launchScript2();
        });
    },

    launchScript2: function() {
        try {
            const running = GM_getValue('steam_inventory_stats_running', false);
            if (running) {
                console.log('📦 脚本2已在运行中');
                return;
            }

            console.log('🚀 启动库存统计脚本 (后台)...');
            const tab = GM_openInTab('https://steamcommunity.com/id/847205020/inventory', {
                active: false,
                insert: true,
                setParent: true
            });

            GM_setValue('steam_inventory_stats_running', true);

            setTimeout(() => {
                try {
                    GM_deleteValue('steam_inventory_stats_running');
                } catch(e) {}
            }, 60000);

            console.log('✅ 已启动后台库存统计脚本');

        } catch(e) {
            console.error('❌ 启动脚本2失败:', e);
        }
    },

    getItemStats: function(itemName) {
        if (!this.loaded || !this.data) {
            return null;
        }

        if (!this.data || !this.data.tableData) {
            return null;
        }

        for (const row of this.data.tableData) {
            if (row['物品名称'] === itemName) {
                return {
                    selling: row['出售中'] || 0,
                    cooling: row['冷却中'] || 0,
                    tradable: row['可交易'] || 0,
                    total: row['总计'] || 0
                };
            }
        }

        return null;
    },

    getAllStats: function() {
        return this.loaded ? this.data : null;
    }
};

// ============================================================
// 修复：重新设计数据加载流程
// ============================================================

// 全局状态
let dataLoadPromise = null;

// 初始化数据（异步加载持久化数据）
async function initializeData() {
    if (dataLoadPromise) {
        return dataLoadPromise;
    }

    dataLoadPromise = (async function() {
        console.log('🔄 初始化数据...');

        // 1. 尝试加载持久化数据
        const hasSavedData = await INVENTORY_STATS.loadPersistedData();

        if (hasSavedData) {
            console.log('✅ 持久化数据加载完成');
            // 更新状态指示器
            updateStatsStatusIndicator();
            // 如果有内容，渲染数据
            const allData = document.getElementById('case-content')?._allData;
            if (allData && allData.length > 0) {
                renderAllData(allData);
            }
        } else {
            console.log('📭 无持久化数据，等待加载');
        }

        return hasSavedData;
    })();

    return dataLoadPromise;
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

const WEAR_LABELS     = config.wearLabels     || {};
const WEAR_PARAM_MAP  = config.wearParamMap   || {};
const QUALITY_LABELS  = config.qualityLabels  || {};
const QUALITY_PREFIX  = config.qualityPrefixMap || {};
const WEAPON_CASES    = config.weaponCases    || [];
/***
// ---------- 配置 ----------
const WEAR_LABELS = {
    'Factory New': '崭新出厂',
    'Minimal Wear': '略有磨损',
    'Field-Tested': '久经沙场',
    'Well-Worn': '破损不堪',
    'Battle-Scarred': '战痕累累'
};

// ---------- 配置 ----------
const WEAPON_CASES = [
    {
        name: '千瓦武器箱',
        appid: 730,
        market_hash_name: 'Kilowatt Case',
        url: 'https://steamcommunity.com/market/listings/730/G18A8263004',
        is_skin: false
    },
    {
        name: '变革武器箱',
        appid: 730,
        market_hash_name: 'Revolution Case',
        url: 'https://steamcommunity.com/market/listings/730/G1890263004',
        is_skin: false
    },
    {
        name: '反冲武器箱',
        appid: 730,
        market_hash_name: 'Recoil Case',
        url: 'https://steamcommunity.com/market/listings/730/G18EE253004',
        is_skin: false
    },
    {
        name: '裂空武器箱',
        appid: 730,
        market_hash_name: 'Fracture Case',
        url: 'https://steamcommunity.com/market/listings/730/G18DA243004',
        is_skin: false
    },
    {
        name: '封装的创世终端机',
        appid: 730,
        market_hash_name: 'Sealed Genesis Terminal',
        url: 'https://steamcommunity.com/market/listings/730/G18B8283004',
        is_skin: false
    },
    {
        name: '封装的毁灭之手终端机',
        appid: 730,
        market_hash_name: 'Sealed Dead Hand Terminal',
        url: 'https://steamcommunity.com/market/listings/730/G18BD283004',
        is_skin: false
    },
    {
        name: '梦魇武器箱',
        appid: 730,
        market_hash_name: 'Dreams & Nightmares Case',
        url: 'https://steamcommunity.com/market/listings/730/G18D2253004',
        is_skin: false
    },
    {
        name: '热潮武器箱',
        appid: 730,
        market_hash_name: 'Fever Case',
        url: 'https://steamcommunity.com/market/listings/730/G18DF363004',
        is_skin: false
    },
    {
        name: '2023年巴黎锦标赛竞争组印花胶囊',
        appid: 730,
        market_hash_name: 'Paris 2023 Contenders Sticker Capsule',
        url: 'https://steamcommunity.com/market/listings/730/G189C263004',
        is_skin: false
    },

    {
        name: '印花 | HObbit | 2021年斯德哥尔摩锦标赛',
        appid: 730,
        market_hash_name: 'Sticker | HObbit | Stockholm 2021',
        url: 'https://steamcommunity.com/market/listings/730/G18B90930046205080010C228',
        is_skin: false
    },
    {
        name: '印花 | FlyQuest（闪耀）| 2024年上海锦标赛',
        appid: 730,
        market_hash_name: 'Sticker | FlyQuest (Glitter) | Shanghai 2024',
        url: 'https://steamcommunity.com/market/listings/730/G18B90930046205080010C53E',
        is_skin: false
    },
    // ========== 皮肤：Tec-9 | 苏丹 ==========
    // 皮肤只有一个 G... id，磨损在详情页内切换，不体现在 URL 上
    {
        name: 'Tec-9 | 苏丹',
        appid: 730,
        base_name: 'Tec-9 | Sultan',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Battle-Scarred',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G181E20B60B3004'
    },

  {
        name: '截短霰弹枪 | 弄臣之颅',
        appid: 730,
        base_name: 'Sawed-Off | Yorick',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Field-Tested',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G181D2085043004'
    },

  {
        name: 'R8左轮手枪 | 稳',
        appid: 730,
        base_name: 'R8 Revolver | Grip',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Minimal Wear',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G184020BD053004'
    },
    {
        name: '新星 | Exo',
        appid: 730,
        base_name: 'Nova | Exo',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Minimal Wear',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G182320CE043004'
    },
    {
        name: 'P90（StatTrak™） | 牵引力',
        appid: 730,
        base_name: 'StatTrak™ P90 | Traction',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Well-Worn',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G181320CD053004'
    },
    {
        name: 'SG 553 | 危险距离',
        appid: 730,
        base_name: 'SG 553 | Danger Close',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Field-Tested',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G182720AF063004'
    },
    {
        name: 'R8左轮手枪 | 生存主义者',
        appid: 730,
        base_name: 'R8 Revolver | Survivalist',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Field-Tested',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G184020D1053004'
    },
    {
        name: '格洛克18型 | 一目了然',
        appid: 730,
        base_name: 'Glock-18 | Clear Polymer',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Battle-Scarred',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G1804208F083004'
    },
    {
        name: 'USP消音版 | 27',
        appid: 730,
        base_name: 'USP-S | 27',
        wears: ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'],
        default_wear: 'Field-Tested',
        wear_labels: WEAR_LABELS,
        is_skin: true,
        url: 'https://steamcommunity.com/market/listings/730/G183D20733004'
    }
];
***/
// ============================================================
// 新增：获取 Steam 钱包信息（动态费用）
// ============================================================

let cachedWalletInfo = null;
let walletInfoCacheTime = 0;
const WALLET_INFO_CACHE_DURATION = 300000; // 5分钟缓存

function getWalletInfo() {
    try {
        // 从 unsafeWindow 获取 Steam 的全局钱包信息
        if (typeof unsafeWindow !== 'undefined' && unsafeWindow.g_rgWalletInfo) {
            const info = unsafeWindow.g_rgWalletInfo;
            if (info && info.wallet_fee_percent !== undefined) {
                return info;
            }
        }

        // 尝试从页面 DOM 中查找
        const walletScript = document.querySelector('script:contains("g_rgWalletInfo")');
        if (walletScript) {
            const match = walletScript.textContent.match(/var\s+g_rgWalletInfo\s*=\s*({[^;]+});/);
            if (match) {
                try {
                    return JSON.parse(match[1]);
                } catch(e) {}
            }
        }

        // 尝试从 steam 的 JavaScript 变量中获取
        if (typeof unsafeWindow !== 'undefined') {
            // 尝试其他可能的变量名
            const possibleVars = ['g_rgWalletInfo', 'g_oWalletInfo', 'WalletInfo'];
            for (const varName of possibleVars) {
                if (unsafeWindow[varName]) {
                    return unsafeWindow[varName];
                }
            }
        }

        // 如果都获取不到，返回默认值（基于常见 Steam 费率）
        console.warn('⚠️ 无法获取 Steam 钱包信息，使用默认费率');
        return {
            wallet_fee_percent: 0.05,
            wallet_fee_base: 0,
            wallet_fee_minimum: 1,
            wallet_publisher_fee_percent_default: 0.10,
            wallet_currency: 1,
            wallet_country: 'US'
        };
    } catch(e) {
        console.warn('获取钱包信息失败:', e);
        return {
            wallet_fee_percent: 0.05,
            wallet_fee_base: 0,
            wallet_fee_minimum: 1,
            wallet_publisher_fee_percent_default: 0.10,
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
            1: 'USD', 2: 'GBP', 3: 'EUR', 4: 'BRL', 5: 'RUB',
            6: 'CNY', 7: 'KRW', 8: 'TRY', 9: 'INR', 10: 'CAD',
            11: 'AUD', 12: 'CHF', 13: 'SEK', 14: 'DKK', 15: 'NOK',
            16: 'RUB', 17: 'JPY', 18: 'SGD', 19: 'KRW', 20: 'BRL',
            21: 'TRY', 22: 'INR', 23: 'CNY'
        };
        return currencyMap[currencyId] || 'USD';
    } catch(e) {
        return 'USD';
    }
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
    const pubFeeDefault = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.10;

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
    const pubFee = publisherFee !== undefined ? publisherFee : (parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.10);

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
// 新增：费用显示弹窗
// ============================================================

function showFeeDetailDialog(feeInfo, itemName) {
    const symbol = getCurrencySymbol();
    const formatMoney = (cents) => {
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

    overlay.querySelector('#fee-detail-close').addEventListener('click', function() {
        overlay.remove();
    });

    overlay.addEventListener('click', function(e) {
        if (e.target === this) {
            this.remove();
        }
    });

    // ESC 关闭
    const escHandler = function(e) {
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
    'today': { label: '本日', hours: 24 },
    'week': { label: '本周', hours: 168 },
    'month': { label: '本月', hours: 720 },
    'year': { label: '最近一年', hours: 8760 }
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
    quality: item.is_skin ? (item.default_quality || 'normal') : null
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
                    quality: item.is_skin ? (item.default_quality || 'normal') : null
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
                    if (title.indexOf(item.market_hash_name) !== -1 ||
                        item.market_hash_name.indexOf(title) !== -1 ||
                        title.indexOf(item.name) !== -1 ||
                        item.name.indexOf(title) !== -1) {
                        return { item: item, wear: null };
                    }
                }
            }
        }
    } catch(e) {}

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
            const itemElements = document.querySelectorAll('.item_name, .market_listing_item_name, [class*="item-name"]');
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

    } catch(e) {
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
    }

    .weapon-cases-controls {
        display: flex;
        gap: 6px;
        align-items: center;
        pointer-events: auto;
        flex-wrap: wrap;
        justify-content: flex-end;
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
        max-height: calc(100vh - 200px);
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

    /* ===== 按钮组 ===== */
    .inv-btn-group {
        display: flex;
        gap: 4px;
        margin-left: auto;
        align-items: center;
        flex-shrink: 0;
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
        min-height: 20px;
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
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
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
`);

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
                    1: '$', 2: '£', 3: '€', 4: 'R$', 5: '₽',
                    6: '¥', 7: '₩', 8: '₺', 9: '₹', 10: '$',
                    11: '$', 12: 'CHF', 13: 'SEK', 14: 'DKK', 15: 'NOK',
                    16: '₽', 17: '¥', 18: 'S$', 19: '₩', 20: 'R$',
                    21: '₺', 22: '₹', 23: '¥'
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

    } catch(e) {}

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
    } catch(e) {
        console.warn('获取SteamID失败:', e);
    }
    return null;
}

// ---------- 查询用户库存 ----------
function fetchUserInventory(steamId, appid, contextid) {
    return new Promise((resolve, reject) => {
        const url = 'https://steamcommunity.com/inventory/' + steamId + '/' + appid + '/' + contextid + '?l=zh_cn';

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            },
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch(e) {
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
            onerror: function() {
                reject(new Error('网络请求失败，请检查网络连接'));
            },
            ontimeout: function() {
                reject(new Error('请求超时，请稍后重试'));
            },
            timeout: 20000
        });
    });
}

// ---------- 统计库存中匹配 market_hash_name 的物品 ----------
function countInventoryItems(inventoryData, marketHashName) {
    if (!inventoryData || !inventoryData.success || !inventoryData.assets || !inventoryData.descriptions) {
        return { total: 0, tradable: 0, assetIds: [] };
    }

    var totalCount = 0;
    var tradableCount = 0;
    var assetIds = [];

    // 建立 classid+instanceid -> description 的映射
    var descMap = {};
    for (var i = 0; i < inventoryData.descriptions.length; i++) {
        var desc = inventoryData.descriptions[i];
        var key = desc.classid + '_' + (desc.instanceid || '0');
        descMap[key] = desc;
    }

    // 遍历 assets，匹配 market_hash_name 并累加 amount（堆叠数量）
    for (var j = 0; j < inventoryData.assets.length; j++) {
        var asset = inventoryData.assets[j];
        var key = asset.classid + '_' + (asset.instanceid || '0');
        var desc = descMap[key];

        if (desc && desc.market_hash_name === marketHashName) {
            // amount 是字符串，需要转为数字，可能为 "1" 或 "5" 等
            var amount = parseInt(asset.amount, 10);
            if (isNaN(amount) || amount < 1) {
                amount = 1;
            }
            totalCount += amount;

            // 检查是否可交易
            var isTradable = (desc.tradable === 1 || desc.tradable === true);
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
            var isTradable = (desc.tradable === 1 || desc.tradable === true || desc.tradable === '1' || desc.tradable === 'true');
            if (isTradable && asset.assetid) {
                return asset.assetid;
            }
        }
    }

    return null;
}

// ---------- 缓存库存数据 ----------
let cachedInventoryData = null;
let inventoryCacheTime = 0;
const INVENTORY_CACHE_DURATION = 60000;

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
    if (cachedInventoryData && (now - inventoryCacheTime) < INVENTORY_CACHE_DURATION) {
        return cachedInventoryData;
    }

    try {
        const data = await fetchUserInventory(steamId, 730, 2);
        cachedInventoryData = data;
        inventoryCacheTime = now;

        // ⭐ 数据加载完成后更新状态指示器
        updateStatsStatusIndicator();

        return data;
    } catch(e) {
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
window.__debugInventoryItem = debugInventoryItem;

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
    } catch(e) {
        return timeStr;
    }
}

// ---------- API 请求 ----------
function fetchOrderBook(appid, marketHashName) {
    return new Promise((resolve, reject) => {
        const qp = JSON.stringify([appid, marketHashName]);
        const url = 'https://steamcommunity.com/market/orderbook'
                  + '?q=Load'
                  + '&cc=US'
                  + '&l=english'
                  + '&currency=1'
                  + '&qp=' + encodeURIComponent(qp);

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'x-valve-request-type': 'queryAction',
                'Referer': 'https://steamcommunity.com/market/listings/' + appid + '/' + encodeURIComponent(marketHashName)
            },
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch(e) {
                        reject(new Error('解析响应失败: ' + e.message));
                    }
                } else {
                    reject(new Error('HTTP ' + response.status));
                }
            },
            onerror: function(error) {
                reject(new Error('网络请求失败'));
            },
            ontimeout: function() {
                reject(new Error('请求超时'));
            },
            timeout: 30000
        });
    });
}

// ---------- 获取价格历史数据 ----------
function fetchPriceHistory(appid, marketHashName) {
    return new Promise((resolve, reject) => {
        const url = 'https://steamcommunity.com/market/pricehistory/?appid=' + appid + '&market_hash_name=' + encodeURIComponent(marketHashName);

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: {
                'Accept': 'application/json'
            },
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch(e) {
                        reject(new Error('解析响应失败: ' + e.message));
                    }
                } else {
                    reject(new Error('HTTP ' + response.status));
                }
            },
            onerror: function(error) {
                reject(new Error('网络请求失败'));
            },
            ontimeout: function() {
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
        } catch(err) {}
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
    } catch(err) {}

    window.addEventListener('resize', function() {
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
        chartWrappers.forEach(function(wrapper) {
            if (wrapper.style) {
                wrapper.style.minHeight = '600px';
            }
        });
        const charts = document.querySelectorAll('[class*="recharts-wrapper"]');
        charts.forEach(function(chart) {
            if (chart.style) {
                chart.style.minHeight = '600px';
            }
        });
        const rechartsContainers = document.querySelectorAll('.recharts-surface, .recharts-responsive-container');
        rechartsContainers.forEach(function(container) {
            const parent = container.closest('div');
            if (parent && parent.style) {
                parent.style.minHeight = '600px';
            }
        });
    } catch(e) {}
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
        z-index: 10001;
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

    msgDiv.querySelector('#close-chart-msg').addEventListener('click', function() {
        msgDiv.remove();
    });

    msgDiv.addEventListener('click', function(e) {
        if (e.target === this) {
            this.remove();
        }
    });

    if (type === 'warning') {
        setTimeout(function() {
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
            '📅 ' + formatDateDisplay(window._customDateRange.start) + ' ~ ' + formatDateDisplay(window._customDateRange.end);
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

    document.body.appendChild(overlay);

    overlay.querySelector('#chart-close-btn').addEventListener('click', closeChart);

    overlay.addEventListener('click', function(e) {
        if (e.target === this) {
            closeChart();
        }
    });

    overlay.querySelectorAll('#chart-time-controls button').forEach(function(btn) {
        btn.addEventListener('click', function() {
            overlay.querySelectorAll('#chart-time-controls button').forEach(function(b) {
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

    overlay.querySelector('#apply-date-range').addEventListener('click', function() {
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

    overlay.querySelector('#reset-date-range').addEventListener('click', function() {
        document.getElementById('custom-date-range').style.display = 'none';
        document.getElementById('date-range-info').textContent = '';
        window._customDateRange = null;

        overlay.querySelectorAll('#chart-time-controls button').forEach(function(b) {
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

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && overlay.classList.contains('active')) {
            closeChart();
        }
    });

    chartCanvas = document.getElementById('chart-canvas');
    chartOverlay = overlay;

    return overlay;
}

function openChart(caseItem) {
    const overlay = createChartOverlay();
    if (!overlay) return;

    window._currentChartCase = caseItem;

    document.getElementById('chart-title-text').textContent = '📊 ' + caseItem.name + ' - 成交量/价格中位数走势';

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
        'today': 24,
        'week': 168,
        'month': 720,
        'year': 8760
    };
    return map[range] || 168;
}

function filterDataByRange(data, range) {
    var hours = getTimeRangeHours(range);
    var now = new Date();
    var cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

    return data.filter(function(item) {
        try {
            var date = new Date(item.time);
            return date >= cutoff;
        } catch(e) {
            return false;
        }
    });
}

// ---------- 聚合数据按天 ----------
function aggregateDataByDay(data) {
    if (!data || data.length === 0) return data;

    // 按天分组
    var dayMap = {};
    data.forEach(function(item) {
        try {
            var date = new Date(item.time);
            var dayKey = date.getFullYear() + '-' +
                        String(date.getMonth() + 1).padStart(2, '0') + '-' +
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
        } catch(e) {}
    });

    // 计算每天的中位数价格和总成交量
    var result = [];
    var dayKeys = Object.keys(dayMap).sort();
    dayKeys.forEach(function(key) {
        var dayData = dayMap[key];
        var sortedPrices = dayData.prices.slice().sort(function(a, b) { return a - b; });
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
    } catch(e) {
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
    } catch(e) {
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

        var rawData = data.prices.map(function(item) {
            return {
                time: item[0],
                price: parseFloat(item[1]),
                volume: parseInt(item[2])
            };
        });

        rawData.sort(function(a, b) {
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
            displayData = displayData.filter(function(_, i) {
                return i % step === 0;
            });
        }

        if (displayData.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 该时间范围内无数据';
            return;
        }

        var prices = displayData.map(function(d) { return d.price; });
        var volumes = displayData.map(function(d) { return d.volume; });
        var sortedPrices = prices.slice().sort(function(a, b) { return a - b; });
        var medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
        var totalVolume = volumes.reduce(function(a, b) { return a + b; }, 0);
        var symbol = getCurrencySymbol();

        document.getElementById('stat-count').textContent = displayData.length;
        document.getElementById('stat-median').textContent = symbol + ' ' + medianPrice.toFixed(2);
        document.getElementById('stat-max').textContent = symbol + ' ' + Math.max.apply(null, prices).toFixed(2);
        document.getElementById('stat-min').textContent = symbol + ' ' + Math.min.apply(null, prices).toFixed(2);
        document.getElementById('stat-volume').textContent = totalVolume.toLocaleString();

        renderChart(displayData, caseItem.name, range, useDayAggregation);

        loading.style.display = 'none';

    } catch(e) {
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

        var rawData = data.prices.map(function(item) {
            return {
                time: item[0],
                price: parseFloat(item[1]),
                volume: parseInt(item[2])
            };
        });

        rawData.sort(function(a, b) {
            return new Date(a.time) - new Date(b.time);
        });

        var filteredData = rawData.filter(function(item) {
            try {
                var date = new Date(item.time);
                return date >= startDate && date <= endDate;
            } catch(e) {
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
            displayData = displayData.filter(function(_, i) {
                return i % step === 0;
            });
        }

        if (displayData.length === 0) {
            loading.style.display = 'none';
            noData.style.display = 'flex';
            noData.textContent = '⚠️ 该时间范围内无数据，请调整时间范围';
            return;
        }

        var prices = displayData.map(function(d) { return d.price; });
        var volumes = displayData.map(function(d) { return d.volume; });
        var sortedPrices = prices.slice().sort(function(a, b) { return a - b; });
        var medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];
        var totalVolume = volumes.reduce(function(a, b) { return a + b; }, 0);
        var symbol = getCurrencySymbol();

        document.getElementById('stat-count').textContent = displayData.length;
        document.getElementById('stat-median').textContent = symbol + ' ' + medianPrice.toFixed(2);
        document.getElementById('stat-max').textContent = symbol + ' ' + Math.max.apply(null, prices).toFixed(2);
        document.getElementById('stat-min').textContent = symbol + ' ' + Math.min.apply(null, prices).toFixed(2);
        document.getElementById('stat-volume').textContent = totalVolume.toLocaleString();

        renderChart(displayData, caseItem.name, 'custom', useDayAggregation);

        loading.style.display = 'none';

    } catch(e) {
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
    var labels = data.map(function(d) {
        return useDayAggregation ? formatDayLabel(d.time) : formatChartLabel(d.time);
    });
    var prices = data.map(function(d) { return d.price; });
    var volumes = data.map(function(d) { return d.volume; });

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
                        label: function(context) {
                            var label = context.dataset.label || '';
                            var value = context.parsed.y;
                            if (context.dataset.label === '价格中位数' || context.dataset.label === '日价格中位数') {
                                return label + ': ' + symbol + ' ' + value.toFixed(2);
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
                        callback: function(value) {
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
                        callback: function(value) {
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

    setTimeout(function() {
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
        var wear = matched.wear || (caseItem.is_skin ? caseItem.default_wear : null);
        if (caseItem.is_skin) {
            titleText = '📦 ' + caseItem.name + ' (' + getWearLabel(caseItem, wear) + ')';
        } else {
            titleText = '📦 ' + caseItem.name;
        }
    }
} else if (isMarketHomePage()) {
    titleText = '📦 我关注的物品';
}

    panel.innerHTML = `
        <div class="weapon-cases-header">
            <h3><span class="drag-handle">⠿</span> ${titleText}</h3>
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
        <div class="weapon-cases-content" id="case-content">
            <div style="text-align:center; padding:20px; color:#8b9aab;">
                <div class="loading-spinner"></div>
                <div style="margin-top:8px;">正在获取数据...</div>
            </div>
        </div>
       <!-- ⭐ 面板底部：左下角主页键，右下角库存统计按钮（已隐藏） -->
    <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0 2px 0; border-top:1px solid #1a2634; margin-top:0px;">
    <button id="goto-market-home-btn" style="
        background: rgba(139,195,74,0.15);
        color: #8bc34a;
        border: 1px solid rgba(139,195,74,0.2);
        border-radius: 4px;
        padding: 4px 14px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        gap: 4px;
    " onmouseover="this.style.background='rgba(139,195,74,0.25)'" onmouseout="this.style.background='rgba(139,195,74,0.15)'">
        <span>🏠</span> 主页
    </button>

    <div style="display:none;">
        <button id="global-inventory-stats-btn" style="
            background: rgba(102,192,244,0.15);
            color: #66c0f4;
            border: 1px solid rgba(102,192,244,0.2);
            border-radius: 4px;
            padding: 4px 14px;
            font-size: 11px;
            cursor: pointer;
            font-family: inherit;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 4px;
        ">
            <span>📊</span> 库存统计
            <span id="stats-status-dot" style="
                display: inline-block;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #4a5a6a;
                margin-left: 2px;
            "></span>
            <span id="stats-time-label" style="font-size:9px; color:#4a6a8a; margin-left:2px;"></span>
        </button>
    </div>
</div>
    `;

    document.body.appendChild(panel);

    makeDraggable(panel);

    // 页面大小输入框事件
    var pageSizeInput = document.getElementById('page-size-input');
    pageSizeInput.addEventListener('change', function() {
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

    pageSizeInput.addEventListener('focus', function() {
        this.select();
    });

    // 刷新按钮
    document.getElementById('refresh-cases').addEventListener('click', function() {
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
    document.getElementById('toggle-cases').addEventListener('click', function() {
        isMinimized = !isMinimized;
        panel.classList.toggle('minimized');
        this.textContent = isMinimized ? '+' : '−';
    });

    // ⭐ 新增：主页键事件
    var homeBtn = document.getElementById('goto-market-home-btn');
    if (homeBtn) {
    homeBtn.addEventListener('click', function() {
        window.location.href = 'https://steamcommunity.com/market/';
        });
    }

    // ⭐ 新增：全局"库存统计"按钮事件
    document.getElementById('global-inventory-stats-btn').addEventListener('click', function() {
        handleGlobalInventoryStats();
    });

    return panel;
}

// ============================================================
// 修复：handleGlobalInventoryStats - 完成后更新状态
// ============================================================

async function handleGlobalInventoryStats() {
    const btn = document.getElementById('global-inventory-stats-btn');
    const statusDot = document.getElementById('stats-status-dot');
    const timeLabel = document.getElementById('stats-time-label');

    if (!btn) return;

    btn.style.opacity = '0.7';
    btn.style.pointerEvents = 'none';
    btn.innerHTML = '<span>⏳</span> 统计中... <span style="font-size:9px;color:#ffd93d;">请稍候</span>';

    if (statusDot) {
        statusDot.style.background = '#ffd93d';
        statusDot.style.animation = 'pulse-dot 0.5s ease-in-out infinite';
    }

    try {
        var allItems = [];
        var allData = document.getElementById('case-content')?._allData || [];
        for (var i = 0; i < allData.length; i++) {
            var data = allData[i];
            var caseItem = WEAPON_CASES[data.index];
            if (caseItem) {
                allItems.push(caseItem.name);
            }
        }

        if (allItems.length === 0) {
            for (var j = 0; j < WEAPON_CASES.length; j++) {
                allItems.push(WEAPON_CASES[j].name);
            }
        }

        console.log('📊 全局库存统计，请求物品:', allItems);

        var result = await INVENTORY_STATS.requestStats(allItems);

        if (result && result.tableData) {
            // ⭐ 数据已由 INVENTORY_STATS.requestStats 自动保存
            if (statusDot) {
                statusDot.style.background = '#8bc34a';
                statusDot.style.animation = 'none';
            }

            if (timeLabel) {
                var now = new Date();
                var timeStr = now.getHours().toString().padStart(2, '0') + ':' +
                              now.getMinutes().toString().padStart(2, '0');
                timeLabel.textContent = '🕐 ' + timeStr;
                timeLabel.style.color = '#8bc34a';
                timeLabel.title = '数据保存于 ' + now.toLocaleString();
            }

            console.log('✅ 库存统计完成，数据已持久化保存');

            if (allData.length > 0) {
                renderAllData(allData);
            } else {
                loadDataByPageType();
            }

        } else {
            console.warn('⚠️ 库存统计失败');
            if (statusDot) {
                statusDot.style.background = '#ff6b6b';
                statusDot.style.animation = 'none';
            }
        }

    } catch(err) {
        console.error('❌ 全局库存统计失败:', err);
        if (statusDot) {
            statusDot.style.background = '#ff6b6b';
            statusDot.style.animation = 'none';
        }
    } finally {
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
        btn.innerHTML = '<span>📊</span> 库存统计 <span id="stats-status-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4a5a6a;margin-left:2px;"></span><span id="stats-time-label" style="font-size:9px;color:#4a6a8a;margin-left:2px;"></span>';

        const newStatusDot = document.getElementById('stats-status-dot');
        const newTimeLabel = document.getElementById('stats-time-label');
        if (newStatusDot && statusDot) {
            newStatusDot.style.background = statusDot.style.background || '#4a5a6a';
            newStatusDot.style.animation = statusDot.style.animation || 'none';
        }
        if (newTimeLabel && timeLabel) {
            newTimeLabel.textContent = timeLabel.textContent || '';
            newTimeLabel.style.color = timeLabel.style.color || '#4a6a8a';
            if (timeLabel.title) {
                newTimeLabel.title = timeLabel.title;
            }
        }
    }
}



// ============================================================
// 修复：renderAllData - 渲染时优先使用持久化数据
// ============================================================

async function renderAllData(allData, expandIndex) {
    var content = document.getElementById('case-content');
    var status = document.getElementById('case-status');

    if (!content) return;

    content._allData = allData;

    // ⭐ 名称列表分页：每页最多 10 个
    var totalNamePages = Math.max(1, Math.ceil(allData.length / NAME_LIST_PAGE_SIZE));
    if (currentNameListPage > totalNamePages) currentNameListPage = totalNamePages;
    if (currentNameListPage < 1) currentNameListPage = 1;

    var pageStart = (currentNameListPage - 1) * NAME_LIST_PAGE_SIZE;
    var pageEnd = Math.min(pageStart + NAME_LIST_PAGE_SIZE, allData.length);
    var pageData = allData.slice(pageStart, pageEnd);

    var pageSize = parseInt(document.getElementById('page-size-input').value) || DEFAULT_PAGE_SIZE;

    // ⭐ 确保库存统计数据已加载
    if (!INVENTORY_STATS.loaded) {
        await INVENTORY_STATS.loadPersistedData();
        updateStatsStatusIndicator();
    }

    // 获取库存数据
    var inventoryData = await getInventoryData();
    var inventoryMap = {};
    if (inventoryData && inventoryData.success) {
        for (var i = 0; i < WEAPON_CASES.length; i++) {
            var item = WEAPON_CASES[i];

            var entry = null;
            for (var k = 0; k < allData.length; k++) {
                if (allData[k].index === i) { entry = allData[k]; break; }
            }
            var wear = entry && entry.currentWear
    ? entry.currentWear
    : (item.is_skin ? item.default_wear : null);
var quality = entry && entry.currentQuality
    ? entry.currentQuality
    : (item.is_skin ? item.default_quality : null);
var mhn = getMarketHashName(item, wear, quality);

            var count = countInventoryItems(inventoryData, mhn);
            inventoryMap[i] = {
                total: count.total || 0,
                tradable: count.tradable || 0,
                assetIds: count.assetIds || []
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
        html += buildCaseHTMLWithPagination_Enhanced(caseItem, result, index, paginated, invCount, currentWear, currentQuality);
    }

    if (!html) {
        html = '<div class="no-case-match">⚠️ 未找到匹配的武器箱</div>';
    }

    // ⭐ 名称列表分页导航
    var nameListPaginationHtml = '';
    if (allData.length > NAME_LIST_PAGE_SIZE) {
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
                <span class="page-info">(共 ${allData.length} 个)</span>
            </div>
        `;
    }

    content.innerHTML = html + nameListPaginationHtml;
    bindEvents();

    if (expandIndex !== undefined) {
        requestAnimationFrame(function() {
            setTimeout(function() {
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
        var filterTag = isMultisellPage ? ' 🔍已过滤' : '';
        var statsLoaded = INVENTORY_STATS.loaded ? ' 📊' : '';
        status.textContent = '✅ ' + successCount + '/' + totalCount + ' ' + invLoaded + filterTag + statsLoaded;
    }
}


// ============================================================
// 修改 init - 加载API数据后更新状态
// ============================================================

function init() {
    console.log('🚀 初始化武器箱挂单数据查询...');

    var panel = createPanel();

    createChartOverlay();

    // 初始化联动
    initInventoryStatsLink();

    // 异步加载持久化数据
    initializeData().then(function(hasSavedData) {
        console.log('📦 数据初始化完成, 有缓存数据:', hasSavedData);
        updateStatsStatusIndicator();

        setTimeout(function() {
            loadDataByPageType();
        }, 500);
    });

        // 如果是 multisell 页面，监听DOM变化
    if (isMultisellPage()) {
        const observer = new MutationObserver(function(mutations) {
            // ⭐ 如果正在加载数据，忽略本次变化
            if (suppressMultisellObserver) return;

            // ⭐ 只关心 Steam 页面自身内容的变化，忽略面板内的变化
            const panel = document.getElementById('weapon-cases-panel');
            let onlyPanelChanged = true;
            for (const m of mutations) {
                const target = m.target;
                if (!panel || !panel.contains(target)) {
                    // 检查新增节点是否都在面板内
                    if (m.type === 'childList' && m.addedNodes.length > 0) {
                        for (const node of m.addedNodes) {
                            if (!panel || !panel.contains(node)) {
                                onlyPanelChanged = false;
                                break;
                            }
                        }
                    } else if (m.type === 'childList') {
                        onlyPanelChanged = false;
                    }
                }
                if (!onlyPanelChanged) break;
            }
            if (onlyPanelChanged) return;

            clearTimeout(window._multisellObserverTimer);
            window._multisellObserverTimer = setTimeout(function() {
                if (suppressMultisellObserver) return;
                console.log('🔄 multisell页面变化，重新加载数据...');
                loadAllData();
            }, 800);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // ⭐ 定期更新API数据状态（每30秒检查一次）
    setInterval(function() {
        if (cachedInventoryData) {
            updateStatsStatusIndicator();
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

        setTimeout(function() {
            itemElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
    } else {
        // 如果元素还没渲染出来，重试
        setTimeout(function() {
            expandItem(caseIndex, retries + 1);
        }, 100);
    }
}

// ============================================================
// 修复3：独立处理统计请求的函数
// ============================================================

async function handleStatsRequest(itemName, itemIndex, btn, loadingEl) {
    try {
        // 检查缓存数据
        var stats = INVENTORY_STATS.getItemStats(itemName);
        if (stats) {
            console.log('📦 使用缓存数据:', itemName, stats);
            updateItemStatsDisplay(itemIndex, itemName, stats);
            if (loadingEl) loadingEl.style.display = 'none';
            if (btn) {
                btn.style.display = 'inline';
                btn.disabled = false;
            }
            return;
        }

        // 获取所有需要查询的物品名称
        var allItems = [];
        var allData = document.getElementById('case-content')?._allData || [];
        for (var i = 0; i < allData.length; i++) {
            var data = allData[i];
            var caseItem = WEAPON_CASES[data.index];
            if (caseItem) {
                allItems.push(caseItem.name);
            }
        }

        console.log('🔍 请求库存统计，物品列表:', allItems);

        var result = await INVENTORY_STATS.requestStats(allItems);

        if (result && result.tableData) {
            var found = result.tableData.find(function(row) {
                return row['物品名称'] === itemName;
            });
            if (found) {
                stats = {
                    selling: found['出售中'] || 0,
                    cooling: found['冷却中'] || 0,
                    tradable: found['可交易'] || 0,
                    total: found['总计'] || 0
                };
                updateItemStatsDisplay(itemIndex, itemName, stats);
                console.log('✅ 已更新统计:', itemName, stats);
            } else {
                console.warn('⚠️ 未找到物品:', itemName);
            }
        } else {
            console.warn('⚠️ 未获取到统计数据');
        }

    } catch(err) {
        console.error('❌ 获取统计失败:', err);
    } finally {
        if (loadingEl) loadingEl.style.display = 'none';
        if (btn) {
            btn.style.display = 'inline';
            btn.disabled = false;
        }
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
    const publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.10;
    const feeInfo = calculateSteamFees(buyerPriceCents, walletInfo, publisherFee);
    const symbol = getCurrencySymbol();

    const formatMoney = (cents) => {
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
        if (allData[i].index === caseIndex) { entry = allData[i]; break; }
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
        if (allData[i].index === caseIndex) { entry = allData[i]; break; }
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
        content._eventListeners.forEach(function(item) {
            content.removeEventListener(item.type, item.listener, item.capture || false);
        });
    }

    var listeners = [];

    // 1. 点击 header 切换展开/收起
    var headerListener = function(e) {
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

    // 2. 名称点击跳转
    var nameListener = function(e) {
    var wrapper = e.target.closest('.case-name-wrapper');
    if (!wrapper) return;
    e.stopPropagation();
    e.preventDefault();

    var caseIndex = parseInt(wrapper.dataset.index);
    var caseItem = WEAPON_CASES[caseIndex];
    if (!caseItem) return;

    var url = getItemUrl(caseItem, null);
    if (url) {
        window.location.href = url;
    }
};
content.addEventListener('click', nameListener);
listeners.push({ type: 'click', listener: nameListener });

    // 3. 刷新按钮
    var refreshListener = function(e) {
        var btn = e.target.closest('.case-refresh-btn');
        if (!btn) return;
        e.stopPropagation();
        var caseIndex = parseInt(btn.dataset.index);
        refreshSingleItem(caseIndex);
    };
    content.addEventListener('click', refreshListener);
    listeners.push({ type: 'click', listener: refreshListener });

    // 4. 图表按钮
    var chartListener = function(e) {
    var btn = e.target.closest('.chart-open-btn');
    if (!btn) return;
    e.stopPropagation();
    var caseIndex = parseInt(btn.dataset.index);
    var caseItem = WEAPON_CASES[caseIndex];
    if (!caseItem) return;

    var allData = document.getElementById('case-content')._allData || [];
    var entry = null;
    for (var i = 0; i < allData.length; i++) {
        if (allData[i].index === caseIndex) { entry = allData[i]; break; }
    }
    var wear = entry && entry.currentWear
    ? entry.currentWear
    : (caseItem.is_skin ? caseItem.default_wear : null);
var quality = entry && entry.currentQuality
    ? entry.currentQuality
    : (caseItem.is_skin ? caseItem.default_quality : null);
var mhn = getMarketHashName(caseItem, wear, quality);

openChart({
    appid: caseItem.appid,
    market_hash_name: mhn,
    name: caseItem.name + (caseItem.is_skin ? ' (' + getWearLabel(caseItem, wear) + ' · ' + getQualityLabel(caseItem, quality) + ')' : '')
});
};

    content.addEventListener('click', chartListener);
    listeners.push({ type: 'click', listener: chartListener });

    // 5. 分页按钮
    var paginationListener = function(e) {
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
    var jumpListener = function(e) {
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
    var sellListener = function(e) {
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
    var batchListener = function(e) {
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
    var middleListener = function(e) {
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
    // ⭐ 10. 关键修复："统计"按钮事件（使用事件委托）
    var statsListener = function(e) {
        var btn = e.target.closest('[id^="trigger-inventory-stats-"]');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();

        var itemName = btn.dataset.itemName;
        var itemIndex = parseInt(btn.dataset.itemIndex);
        var loadingEl = document.getElementById('stats-loading-' + itemIndex);

        if (!itemName) return;

        console.log('🔍 "统计"按钮被点击:', itemName, itemIndex);

        // 显示加载状态
        btn.style.display = 'none';
        if (loadingEl) loadingEl.style.display = 'inline';
        btn.disabled = true;

        // 执行统计请求
        handleStatsRequest(itemName, itemIndex, btn, loadingEl);
    };
    content.addEventListener('click', statsListener);
    listeners.push({ type: 'click', listener: statsListener });

    // 11. 价格悬停显示卖家实收
var priceHoverListener = function(e) {
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

var priceMoveListener = function(e) {
    if (currentHoverPriceTd) {
        positionFeeTooltip(e);
    }
};
content.addEventListener('mousemove', priceMoveListener);
listeners.push({ type: 'mousemove', listener: priceMoveListener });

  // 12. 磨损切换按钮
var wearListener = function(e) {
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
var nameListPageListener = function(e) {
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
    var qualityListener = function(e) {
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

function buildCaseHTMLWithPagination_Enhanced(item, result, index, paginated, inventoryCount, currentWear, currentQuality) {
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
            pageButtons += '<button class="pagination-btn ' + active + '" data-index="' + index + '" data-page="' + k + '">' + k + '</button>';
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

    var invStats = INVENTORY_STATS.getItemStats(item.name);
    var sellingCount = invStats ? invStats.selling : '?';
    var coolingCount = invStats ? invStats.cooling : '?';
    var tradableCount = invStats ? invStats.tradable : '?';
    var hasInvStats = invStats !== null;

    var maxNameLength = 10;
    var displayName = item.name;
    var isTruncated = false;
    var displayWidth = 0;
    var truncateIndex = item.name.length;
    for (var ch = 0; ch < item.name.length; ch++) {
        var code = item.name.charCodeAt(ch);
        if ((code >= 0x4E00 && code <= 0x9FFF) || code >= 0xFF00) {
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
        item.wears.forEach(function(w) {
    var isActive = (w === activeWear);
    var label = getWearLabel(item, w);                    // ⭐ 统一走 getWearLabel
    var fullName = getMarketHashName(item, w, currentQuality || item.default_quality || 'normal');
    wearButtons +=
        '<button class="wear-btn' + (isActive ? ' active' : '') + '"' +
        ' data-index="' + index + '"' +
        ' data-wear="' + w + '"' +
        ' title="' + fullName + '">' +                     // ⭐ tooltip 显示完整英文名，便于核对
        label +
        '</button>';
});

        wearSwitcherHtml =
            '<div class="wear-switcher" data-index="' + index + '">' +
                '<span class="wear-label">磨损:</span>' +
                wearButtons +
            '</div>';
    }

    // ---- 品质切换器 ----
    var qualitySwitcherHtml = '';
    if (item.is_skin && item.qualities && item.qualities.length > 1) {
        var qualityButtons = '';
        var activeQuality = currentQuality || item.default_quality || 'normal';

        item.qualities.forEach(function(q) {
            var isActive = (q === activeQuality);
            var label = getQualityLabel(item, q);
            var fullName = getMarketHashName(item, currentWear || item.default_wear, q);
            qualityButtons +=
                '<button class="quality-btn' + (isActive ? ' active' : '') + '"' +
                ' data-index="' + index + '"' +
                ' data-quality="' + q + '"' +
                ' title="' + fullName + '">' +
                label +
                '</button>';
        });

        qualitySwitcherHtml =
            '<div class="quality-switcher" data-index="' + index + '">' +
                '<span class="quality-label">品质:</span>' +
                qualityButtons +
            '</div>';
    }

    var apiTradableQty = inventoryCount ? inventoryCount.tradable : 0;
    var badgeColor = '';
    var badgeTitle = '';
    if (apiTradableQty > 0) {
        badgeColor = '#831d1d';
        badgeTitle = '🔴 可交易: ' + apiTradableQty + ' 件';
        if (hasInvStats) {
            badgeTitle += ' | ⏳ 冷却中: ' + coolingCount + ' | 🔶 出售中: ' + sellingCount;
        }
    } else {
        badgeColor = '#4f8b09';
        badgeTitle = '🟢 无可交易物品';
        if (hasInvStats) {
            badgeTitle += ' | ⏳ 冷却中: ' + coolingCount + ' | 🔶 出售中: ' + sellingCount;
        }
    }

    var displayFullName = item.is_skin
        ? item.name + ' (' + getWearLabel(item, activeWear) + ')'
        : item.name;

    var nameHtml = '<span class="case-name-wrapper" data-index="' + index + '" data-url="' + getItemUrl(item, activeWear) + '" title="' + displayFullName + '\n' + badgeTitle + '">' +
               '<span class="case-name-text">' + displayName + '</span>' +
               '<span class="inv-badge-dot" style="' +
                   'display:inline-block;' +
                   'width:10px;' +
                   'height:10px;' +
                   'border-radius:50%;' +
                   'background:' + badgeColor + ';' +
                   'margin-left:4px;' +
                   'flex-shrink:0;' +
                   'border:1px solid rgba(255,255,255,0.1);' +
                   'box-shadow: 0 0 8px ' + badgeColor + '60;' +
                   'transition: all 0.3s ease;' +
               '" title="' + badgeTitle + '"></span>' +
               '</span>';

    var invStatsHtml = '';
    if (hasInvStats) {
        invStatsHtml = `
            <div style="display:flex; gap:12px; padding:2px 0 4px 0; font-size:11px; color:#8b9aab; border-bottom:1px solid rgba(255,255,255,0.05); margin-bottom:4px;">
                <span>📊 <span style="color:#ffd93d;">出售中: ${sellingCount}</span></span>
                <span>⏳ <span style="color:#66c0f4;">冷却中: ${coolingCount}</span></span>
                <span>✅ <span style="color:#8bc34a;">可交易: ${tradableCount}</span></span>
                <span style="color:#4a6a8a; font-size:10px;">(库存统计)</span>
            </div>
        `;
    } else {
        invStatsHtml = `
            <div style="display:flex; gap:12px; padding:2px 0 4px 0; font-size:10px; color:#4a6a8a; border-bottom:1px solid rgba(255,255,255,0.05); margin-bottom:4px;">
                <span>📊 <span style="color:#4a6a8a;">点击面板底部"库存统计"更新</span></span>
            </div>
        `;
    }

    var inventoryRowHtml = `
        <div class="inventory-stats ${hasStock ? 'has-stock' : ''}">
            <span class="inv-icon">${hasStock ? '📦' : '📭'}</span>
            <span class="inv-label">我的库存</span>
            <span class="inv-status-dot ${hasStock ? 'has-stock' : 'no-stock'}"></span>

            <span class="inv-count-badge tradable">
                <span class="count-label">可交易</span>
                <span class="count-num">${tradableInv}</span>
            </span>

            <div class="inv-btn-group">
                <button class="inv-btn inv-btn-sell"
                        data-index="${index}"
                        ${hasTradable ? '' : 'disabled'}
                        data-tip="${hasTradable ? '' : '无可交易物品'}">
                    <span class="btn-icon">⬆</span>
                    <span class="btn-text">上架</span>
                </button>
                <button class="inv-btn inv-btn-batch"
                        data-index="${index}"
                        ${hasTradable ? '' : 'disabled'}
                        data-tip="${hasTradable ? '' : '无可交易物品'}">
                    <span class="btn-icon">⬆⬆</span>
                    <span class="btn-text">批量</span>
                </button>
            </div>
        </div>
        ${invStatsHtml}
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
// 修改 updateStatsStatusIndicator - 显示 API 数据状态
// ============================================================

function updateStatsStatusIndicator() {
    var statusDot = document.getElementById('stats-status-dot');
    var timeLabel = document.getElementById('stats-time-label');

    if (!statusDot) return;

    // 检查 API 库存数据是否已加载
    var apiDataLoaded = cachedInventoryData !== null && cachedInventoryData.success;

    // 检查脚本2统计数据
    var stats = INVENTORY_STATS.getAllStats();
    var saveTime = STORAGE.getSaveTime();

    if (apiDataLoaded || (stats && stats.tableData && stats.tableData.length > 0)) {
        statusDot.style.background = '#8bc34a';
        statusDot.style.animation = 'none';

        if (timeLabel) {
            if (saveTime) {
                var date = new Date(saveTime);
                var timeStr = date.getHours().toString().padStart(2, '0') + ':' +
                              date.getMinutes().toString().padStart(2, '0');
                var dateStr = (date.getMonth() + 1) + '/' + date.getDate();
                timeLabel.textContent = '🕐 ' + dateStr + ' ' + timeStr;
                timeLabel.style.color = '#8bc34a';
                timeLabel.title = '数据保存于 ' + date.toLocaleString();
            } else if (apiDataLoaded) {
                var now = new Date();
                var nowStr = now.getHours().toString().padStart(2, '0') + ':' +
                             now.getMinutes().toString().padStart(2, '0');
                timeLabel.textContent = '🕐 ' + nowStr;
                timeLabel.style.color = '#8bc34a';
                timeLabel.title = 'API数据已加载';
            } else {
                timeLabel.textContent = '';
            }
        }
    } else {
        statusDot.style.background = '#4a5a6a';
        statusDot.style.animation = 'none';
        if (timeLabel) {
            timeLabel.textContent = '';
        }
    }
}

// ---------- 绑定"统计"按钮事件 ----------
function bindStatsButtonEvents() {
    document.addEventListener('click', async function(e) {
        const btn = e.target.closest('#trigger-inventory-stats-\\d+');
        if (!btn) return;

        const itemName = btn.dataset.itemName;
        const itemIndex = parseInt(btn.dataset.itemIndex);
        const loadingEl = document.getElementById('stats-loading-' + itemIndex);

        if (!itemName) return;

        // 显示加载状态
        btn.style.display = 'none';
        if (loadingEl) loadingEl.style.display = 'inline';

        // 禁用按钮防止重复点击
        btn.disabled = true;

        try {
            // 检查缓存数据
            let stats = INVENTORY_STATS.getItemStats(itemName);
            if (stats) {
                console.log('📦 使用缓存数据:', itemName, stats);
                // 更新显示
                updateItemStatsDisplay(itemIndex, itemName, stats);
                if (loadingEl) loadingEl.style.display = 'none';
                btn.style.display = 'inline';
                btn.disabled = false;
                return;
            }

            // 请求数据
            console.log('🔍 请求库存统计:', itemName);

            // 获取所有需要查询的物品名称
            const allItems = [];
            const allData = document.getElementById('case-content')?._allData || [];
            for (const data of allData) {
                const caseItem = WEAPON_CASES[data.index];
                if (caseItem) {
                    allItems.push(caseItem.name);
                }
            }

            const result = await INVENTORY_STATS.requestStats(allItems);

            if (result && result.tableData) {
                // 查找当前物品的数据
                const found = result.tableData.find(row => row['物品名称'] === itemName);
                if (found) {
                    stats = {
                        selling: found['出售中'] || 0,
                        cooling: found['冷却中'] || 0,
                        tradable: found['可交易'] || 0,
                        total: found['总计'] || 0
                    };
                    updateItemStatsDisplay(itemIndex, itemName, stats);
                    console.log('✅ 已更新统计:', itemName, stats);
                } else {
                    console.warn('⚠️ 未找到物品:', itemName);
                }
            } else {
                console.warn('⚠️ 未获取到统计数据');
            }

        } catch(err) {
            console.error('❌ 获取统计失败:', err);
        } finally {
            if (loadingEl) loadingEl.style.display = 'none';
            btn.style.display = 'inline';
            btn.disabled = false;
        }
    });
}

// 更新单个物品的统计显示
function updateItemStatsDisplay(index, itemName, stats) {
    // 查找对应的DOM元素
    const itemElement = document.querySelector(`.case-item[data-case-index="${index}"]`);
    if (!itemElement) return;

    // 查找库存统计信息区域
    const statsDiv = itemElement.querySelector('.case-orders > div:last-child');
    if (!statsDiv) return;

    // 检查是否已经显示了统计数据
    const existingStats = statsDiv.querySelector('.inventory-stats-extra');
    if (existingStats) {
        // 更新现有数据
        const sellingEl = existingStats.querySelector('.stats-selling');
        const coolingEl = existingStats.querySelector('.stats-cooling');
        const tradableEl = existingStats.querySelector('.stats-tradable');
        if (sellingEl) sellingEl.textContent = stats.selling;
        if (coolingEl) coolingEl.textContent = stats.cooling;
        if (tradableEl) tradableEl.textContent = stats.tradable;
        return;
    }

    // 创建新的统计显示
    const extraDiv = document.createElement('div');
    extraDiv.className = 'inventory-stats-extra';
    extraDiv.style.cssText = `
        display: flex;
        gap: 16px;
        padding: 4px 10px 6px 10px;
        font-size: 12px;
        color: #8b9aab;
        background: rgba(0,0,0,0.15);
        border-radius: 4px;
        margin-bottom: 4px;
    `;
    extraDiv.innerHTML = `
        <span>📊 <span style="color:#ffd93d;">出售中: <span class="stats-selling">${stats.selling}</span></span></span>
        <span>⏳ <span style="color:#66c0f4;">冷却中: <span class="stats-cooling">${stats.cooling}</span></span></span>
        <span>✅ <span style="color:#8bc34a;">可交易: <span class="stats-tradable">${stats.tradable}</span></span></span>
        <span style="color:#4a6a8a; font-size:10px;">(已加载)</span>
    `;

    // 插入到库存统计行后面
    const inventoryStats = statsDiv.querySelector('.inventory-stats');
    if (inventoryStats) {
        inventoryStats.after(extraDiv);
    } else {
        statsDiv.prepend(extraDiv);
    }
}

// ============================================================
// 修复：添加 GM_addValueChangeListener 的兼容处理
// ============================================================

function initInventoryStatsLink() {
    console.log('🔗 正在建立与库存统计脚本的联动 (GM_setValue)...');

    // 检查是否有缓存的统计数据
    try {
        const cachedData = GM_getValue('steam_inventory_stats_cached', null);
        if (cachedData) {
            const parsed = JSON.parse(cachedData);
            if (parsed.timestamp && (Date.now() - parsed.timestamp) < 300000) {
                INVENTORY_STATS.data = parsed.data;
                INVENTORY_STATS.loaded = true;
                console.log('📦 加载缓存的库存统计数据');
                const allData = document.getElementById('case-content')?._allData;
                if (allData) {
                    renderAllData(allData);
                }
            }
        }
    } catch(e) {
        console.warn('加载缓存数据失败:', e);
    }

    // 使用 GM_addValueChangeListener 监听响应
    try {
        if (typeof GM_addValueChangeListener === 'function') {
            GM_addValueChangeListener('steam_inventory_stats_response', function(name, oldValue, newValue) {
                if (newValue) {
                    try {
                        const response = JSON.parse(newValue);
                        if (response.success && response.data) {
                            INVENTORY_STATS.data = response.data;
                            INVENTORY_STATS.loaded = true;
                            console.log('📦 收到库存统计数据更新');

                            try {
                                GM_setValue('steam_inventory_stats_cached', JSON.stringify({
                                    data: response.data,
                                    timestamp: Date.now()
                                }));
                            } catch(e) {}

                            const allData = document.getElementById('case-content')?._allData;
                            if (allData) {
                                renderAllData(allData);
                            }
                        }
                    } catch(e) {
                        console.warn('解析响应数据失败:', e);
                    }
                }
            });
            console.log('✅ GM_addValueChangeListener 已注册');
        } else {
            console.warn('⚠️ GM_addValueChangeListener 不可用，使用轮询方式');
            // 备用方案：轮询检查
            let lastResponse = null;
            setInterval(() => {
                try {
                    const responseData = GM_getValue('steam_inventory_stats_response', null);
                    if (responseData && responseData !== lastResponse) {
                        lastResponse = responseData;
                        const response = JSON.parse(responseData);
                        if (response.success && response.data) {
                            INVENTORY_STATS.data = response.data;
                            INVENTORY_STATS.loaded = true;
                            console.log('📦 轮询到库存统计数据更新');
                            const allData = document.getElementById('case-content')?._allData;
                            if (allData) {
                                renderAllData(allData);
                            }
                        }
                    }
                } catch(e) {}
            }, 2000);
        }
    } catch(e) {
        console.warn('GM_addValueChangeListener 失败:', e);
    }

    console.log('✅ 联动模块初始化完成');
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
                    return multisellItems.some(name =>
                        name === item.base_name ||
                        name.indexOf(item.base_name + ' (') === 0
                    );
                }
                return multisellItems.some(name =>
                    item.market_hash_name === name ||
                    name.includes(item.market_hash_name) ||
                    item.market_hash_name.includes(name)
                );
            });
            console.log('📦 匹配到的物品:', filtered.map(f => f.name));
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
                    ${WEAPON_CASES.map(function(c) { return c.name; }).join('、')}
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

    var allData = [];
    var successCount = 0;
    var totalCount = casesToLoad.length;

    for (var i = 0; i < casesToLoad.length; i++) {
        var item = casesToLoad[i];
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
        status.textContent = '正在获取: ' + item.name + ' (' + (i + 1) + '/' + totalCount + ')';

        try {
            var data = await fetchOrderBook(item.appid, marketHashName);
            var result = parseOrderBook(data);
            successCount++;
            allData.push({
    index: originalIndex,
    result: result,
    currentPage: 1,
    currentWear: initialWear,
    currentQuality: item.default_quality || 'normal'   // ⭐ 新增
});
        } catch (e) {
            allData.push({
        index: originalIndex,
        result: { sellOrders: [], lowestSell: 0, sellCount: 0 },
        error: e.message,
        currentPage: 1,
        currentWear: initialWear,
        currentQuality: item.default_quality || 'normal'
    });
        }
    }

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
                ⚠️ 当前页面不是支持的物品页面<br>
                <span style="font-size:12px;color:#5a6a7a;margin-top:8px;display:block;">
                    支持的物品: ${WEAPON_CASES.map(function(c) { return c.name; }).join('、')}
                </span>
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


        var allData = [{
        index: index,
        result: result,
        currentPage: 1,
        currentWear: currentWear,
        currentQuality: currentQuality
    }];

        content._allData = allData;
        renderAllData(allData);

        setTimeout(function() { expandItem(index); }, 100);

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
    if (allDataRef[ri].index === index) { entryRef = allDataRef[ri]; break; }
}
var wear = entryRef && entryRef.currentWear
    ? entryRef.currentWear
    : (item.is_skin ? item.default_wear : null);
var quality = entryRef && entryRef.currentQuality
    ? entryRef.currentQuality
    : (item.is_skin ? item.default_quality : null);
var marketHashName = getMarketHashName(item, wear, quality);

var data = await fetchOrderBook(item.appid, marketHashName);

        var result = parseOrderBook(data);

        var allData = document.getElementById('case-content')._allData;
        if (allData) {
            for (var i = 0; i < allData.length; i++) {
                if (allData[i].index === index) {
                    allData[i].result = result;
                    allData[i].currentPage = 1;
                    allData[i].currentWear = wear;   // 保持不变
                    allData[i].error = null;
                    break;
                }
            }
            // 重新渲染
            await renderAllData(allData);
        }

        // ---- 修复：刷新后自动展开 ----
        setTimeout(function() {
            expandItem(index);
        }, 200);

        if (statusEl) {
            var totalItems = document.getElementById('case-content')._allData ? document.getElementById('case-content')._allData.length : 0;
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
    } catch(e) {
        console.warn('获取 sessionid 失败:', e);
    }
    return null;
}

// ---------- 上架单品 (使用 sellitem 接口) ----------
function submitSingleSell(requestData) {
    return new Promise(function(resolve, reject) {
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
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': window.location.href // 必须带上当前页面作为来源
            },
            onload: function(response) {
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
                    } catch(e) {
                        reject(new Error('JSON解析失败 (接口返回结构异常): ' + e.message));
                    }
                } else {
                    reject(new Error('网络请求失败 (HTTP ' + response.status + ')'));
                }
            },
            onerror: function() {
                reject(new Error('网络连接异常，请检查网络'));
            },
            ontimeout: function() {
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
async function handleSell(index, isBatch) {
    var item = WEAPON_CASES[index];
    if (!item) {
        console.error('未找到物品: index=' + index);
        return;
    }

    var content = document.getElementById('case-content');
    var allData = content._allData || [];
    var entry = null;
    for (var i = 0; i < allData.length; i++) {
        if (allData[i].index === index) { entry = allData[i]; break; }
    }
    var wear = entry && entry.currentWear
    ? entry.currentWear
    : (item.is_skin ? item.default_wear : null);
var quality = entry && entry.currentQuality
    ? entry.currentQuality
    : (item.is_skin ? item.default_quality : null);
var marketHashName = getMarketHashName(item, wear, quality);

    var inventoryData = await getInventoryData();
    if (!inventoryData || !inventoryData.success) {
        showChartMessage('❌ 无法获取库存数据，请确认库存已公开', 'error');
        return;
    }

    var count = countInventoryItems(inventoryData, marketHashName);
    if (count.tradable === 0) {
        showChartMessage('⚠️ 没有可交易的 ' + item.name +
            (item.is_skin ? ' (' + getWearLabel(item, wear) + ')' : '') + '，无法上架', 'warning');
        return;
    }

    if (isBatch) {
        var batchUrl = 'https://steamcommunity.com/market/multisell?appid=' + item.appid +
                       '&contextid=2&items[]=' + encodeURIComponent(marketHashName) +
                       '&qty[]=100';
        window.open(batchUrl, '_blank');
        return;
    }


    // 获取钱包信息用于费用计算
    const walletInfo = getWalletInfo();
    const publisherFee = parseFloat(walletInfo.wallet_publisher_fee_percent_default) || 0.10;

    // 显示费用信息弹窗，让用户输入买家支付价格
    const feeDialog = document.createElement('div');
    feeDialog.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.7);
        z-index: 10002;
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
        const formatMoney = (cents) => {
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
    priceInput.addEventListener('focus', function() { this.select(); });

    // 取消按钮
    cancelBtn.addEventListener('click', function() {
        feeDialog.remove();
    });

    // ESC 关闭
    const escHandler = function(e) {
        if (e.key === 'Escape') {
            feeDialog.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // 点击外部关闭
    feeDialog.addEventListener('click', function(e) {
        if (e.target === this) {
            this.remove();
            document.removeEventListener('keydown', escHandler);
        }
    });

    // 确认上架 - 传入卖家实收价格给 Steam API
    confirmBtn.addEventListener('click', async function() {
        const feeInfo = feeDialog._feeInfo;
        if (!feeInfo) {
            errorDiv.textContent = '⚠️ 请先输入有效的价格';
            errorDiv.style.display = 'block';
            return;
        }

        // 关闭费用对话框
        feeDialog.remove();
        document.removeEventListener('keydown', escHandler);

        // 显示费用明细
        showFeeDetailDialog(feeInfo, item.name);

        // 执行上架 - 传入卖家实收价格 (feeInfo.sellerAmount)
        await performSingleSell(item, inventoryData, feeInfo, marketHashName);
    });

    // 自动聚焦
    setTimeout(() => priceInput.focus(), 100);
}

// ---------- 执行单个上架逻辑 ----------
async function performSingleSell(item, inventoryData, feeInfo, marketHashName) {
    showChartMessage('⏳ 正在上架 ' + item.name + '...', 'warning');

    try {
        const sessionid = getSessionId();
        if (!sessionid || sessionid.length < 10) {
            showChartMessage('❌ 无法获取有效的 sessionid，请重新刷新页面', 'error');
            return;
        }

        const count = countInventoryItems(
    inventoryData,
    marketHashName || getMarketHashName(item, item.default_wear)
);
        if (count.assetIds.length === 0) {
            showChartMessage('❌ 未找到可交易的 ' + item.name + '，无法上架', 'error');
            return;
        }

        const assetid = count.assetIds[0];

        // ⭐ 关键修正：提交卖家实收价格 (sellerAmount)，而不是买家支付价格
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
            price: sellerPriceCents  // ✅ 正确：卖家实收价格
        };

        const result = await submitSingleSell(requestData);

        if (result && result.success) {
            const symbol = getCurrencySymbol();
            showChartMessage(
                '✅ 上架成功！\n' +
                item.name + ' 已上架\n\n' +
                '💰 买家支付: ' + symbol + ' ' + (feeInfo.buyerPrice / 100).toFixed(2) + '\n' +
                '📥 卖家实收: ' + symbol + ' ' + (feeInfo.sellerAmount / 100).toFixed(2) + '\n' +
                '📊 手续费: ' + symbol + ' ' + (feeInfo.totalFees / 100).toFixed(2) + ' (' + feeInfo.feePercentage.toFixed(1) + '%)',
                'warning'
            );

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

// ---------- 根据页面类型加载数据 ----------
function loadDataByPageType() {
  currentNameListPage = 1;

    if (isMultisellPage()) {
        // multisell 页面：只加载匹配的物品
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
document.addEventListener('keydown', function(e) {
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
