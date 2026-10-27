// ==UserScript==
// @name         HostLens: итоги, IP и трафик в кабинетах хостингов
// @namespace    https://github.com/dykomenko/hostlens
// @version      2.4.0
// @description  Дополняет кабинеты хостингов: суммарная стоимость, сколько доплатить, чтобы всё работало ещё месяц (BILLmanager: Senko, WAIcore, H2 Nexus; WHMCS: Avoro), в списке услуг Avoro ещё IP, трафик и срок оплаты, а у подсетей Cherry Servers кнопка копирования IP для netplan.
// @author       dykomenko
// @license      MIT
// @match        https://my.senko.digital/billmgr*
// @match        https://my.waicore.com/billmgr*
// @match        https://my.h2.nexus/billmgr*
// @match        https://avoro.eu/cp/clientarea.php*
// @match        https://portal.cherryservers.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      avoro.eu
// @homepageURL  https://github.com/dykomenko/hostlens
// @supportURL   https://github.com/dykomenko/hostlens/issues
// @updateURL    https://raw.githubusercontent.com/dykomenko/hostlens/main/hostlens.user.js
// @downloadURL  https://raw.githubusercontent.com/dykomenko/hostlens/main/hostlens.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Parsing and calculation. Pure functions, no DOM access.
   * ------------------------------------------------------------------ */

  const SPACES = /[\s\u00a0\u202f]+/g;
  const DAY_MS = 864e5;
  const MAX_RENEWALS = 10000;

  const CURRENCY_ALIASES = [
    [/€|eur/i, '€'],
    [/\$|usd/i, '$'],
    [/£|gbp/i, '£'],
    [/₽|руб|rub|р\./i, '₽'],
    [/₴|грн|uah/i, '₴'],
    [/₸|тенге|kzt/i, '₸'],
  ];

  function normalizeCurrency(raw) {
    const text = String(raw || '').replace(/[\s\u00a0\u202f,:/]+/g, ' ').trim();
    for (const [re, sign] of CURRENCY_ALIASES) if (re.test(text)) return sign;
    return text.length <= 5 ? text : '';
  }

  // "1 234.50", "1,234.50", "1.234,50" and "4,5" all come out right.
  function toNumber(raw) {
    let s = raw.replace(SPACES, '').replace('−', '-');
    const dot = s.lastIndexOf('.');
    const comma = s.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
      const decimal = dot > comma ? '.' : ',';
      const group = decimal === '.' ? ',' : '.';
      s = s.split(group).join('').replace(decimal, '.');
    } else {
      s = s.replace(',', '.');
    }
    return parseFloat(s);
  }

  const MONEY_RE = /[-−]?\d(?:[\d\s\u00a0\u202f.,]*\d)?/;

  function parseMoney(text) {
    const source = String(text || '');
    const match = MONEY_RE.exec(source);
    if (!match) return null;
    const value = toNumber(match[0]);
    if (!Number.isFinite(value)) return null;
    const rest = source.slice(0, match.index) + ' ' + source.slice(match.index + match[0].length);
    return { cents: Math.round(value * 100), currency: normalizeCurrency(rest) };
  }

  const PERIOD_UNITS = [
    [/^(one|once|free|единовр)/, { once: true }],
    [/^час/, { days: 1 / 24 }],
    [/^(сут|ден|дн|dai|day)/, { days: 1 }],
    [/^(недел|week)/, { days: 7 }],
    [/^(мес|month)/, { months: 1 }],
    [/^(квартал|quarter)/, { months: 3 }],
    [/^(полугод|semi)/, { months: 6 }],
    [/^(год|лет|annual|year)/, { months: 12 }],
    [/^bienn/, { months: 24 }],
    [/^trienn/, { months: 36 }],
  ];

  const MONTH = { months: 1, days: 0 };

  // "Месяц", "3 месяца", "Год", "Неделя", "Monthly", "Semi-Annually", "One Time" ...
  function parsePeriod(text) {
    const match = /^\s*(\d+)?\s*(\S+)/.exec(String(text || '').toLowerCase());
    if (!match) return null;
    const n = match[1] ? parseInt(match[1], 10) : 1;
    for (const [re, unit] of PERIOD_UNITS) {
      if (!re.test(match[2])) continue;
      if (unit.once) return { months: 0, days: 0, once: true };
      return { months: (unit.months || 0) * n, days: (unit.days || 0) * n };
    }
    return null;
  }

  const periodInMonths = (p) => p.months + p.days / 30;

  // "4.49 € / Месяц" -> price of one billing period.
  function parseCost(text) {
    const [price, periodText = ''] = String(text || '').split('/');
    const money = parseMoney(price);
    if (!money) return null;
    const period = parsePeriod(periodText);
    return {
      cents: money.cents,
      currency: money.currency,
      period: period || MONTH,
      periodGuessed: !period && periodText.trim() !== '',
    };
  }

  function parseDate(text) {
    const s = String(text || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    return null;
  }

  // Jan 31 + 1 month = Feb 28/29, not Mar 3.
  function addMonths(date, n) {
    const result = new Date(date.getFullYear(), date.getMonth() + n, 1);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(date.getDate(), lastDay));
    return result;
  }

  function addPeriod(date, period) {
    const d = period.months ? addMonths(date, period.months) : date;
    return period.days ? new Date(d.getTime() + period.days * DAY_MS) : d;
  }

  // How many paid periods are needed for a service to stay alive until `horizon`.
  // A service that has already expired starts over from today, not from its old date.
  function renewalsNeeded(expire, period, today, horizon) {
    let end = expire < today ? today : expire;
    let n = 0;
    while (end < horizon && n < MAX_RENEWALS) {
      end = addPeriod(end, period);
      n++;
    }
    return n;
  }

  const RUNWAY_MONTHS = 36;

  /**
   * How long the balance lasts: walks through every future charge (each service is billed on its
   * expiry date and then once per period), most recent last, and finds the first day on which the
   * charges due that day exceed what is left. Returns null without a usable balance, otherwise
   * { outage: Date | null, short, names }; `outage` is null when everything is covered for 36 months.
   */
  function runway(items, { today, balance }) {
    if (!balance) return null;
    const limit = addMonths(today, RUNWAY_MONTHS);
    const events = [];

    for (const { name, expire, cost } of items) {
      if (!expire || cost.period.once || !cost.cents) continue;
      if (balance.currency && cost.currency && balance.currency !== cost.currency) continue;
      let when = expire < today ? today : expire; // an expired service is paid for today, not from its old date
      for (let n = 0; when < limit && n < MAX_RENEWALS; n++) {
        events.push({ when, name, cents: cost.cents });
        when = addPeriod(when, cost.period);
      }
    }
    if (!events.length) return null;

    events.sort((a, b) => a.when - b.when);
    let left = balance.cents;
    for (let i = 0; i < events.length;) {
      let j = i;
      let total = 0;
      while (j < events.length && events[j].when.getTime() === events[i].when.getTime()) total += events[j++].cents;
      if (total > left) {
        const names = events.slice(i, j).sort((a, b) => b.cents - a.cents).map((e) => e.name);
        return { outage: events[i].when, short: total - left, names };
      }
      left -= total;
      i = j;
    }
    return { outage: null, short: 0, names: [] };
  }

  const sumInto = (map, key, value) => {
    map[key] = (map[key] || 0) + value;
  };

  const roundMap = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Math.round(v)]));

  // Services that are gone (BILLmanager "Удалён", WHMCS "Terminated"/"Cancelled") cost nothing.
  const EXCLUDED_STATUS = /удал|terminated|cancel+ed|deleted|fraud/i;

  /**
   * rows: [{ name, note, status, expire, cost }] with raw cell texts.
   * Returns totals per currency (in cents) and a per-service breakdown.
   */
  function analyze(rows, { today, months, balance }) {
    const horizon = addMonths(today, months);
    const monthly = {};
    const due = {};
    const items = [];
    const issues = { noPrice: 0, guessedPeriod: 0 };
    let nextExpiry = null;

    for (const row of rows) {
      if (EXCLUDED_STATUS.test(row.status || '')) continue;
      const cost = parseCost(row.cost);
      if (!cost) {
        issues.noPrice++;
        continue;
      }
      if (cost.periodGuessed) issues.guessedPeriod++;

      const recurring = !cost.period.once;
      const expire = parseDate(row.expire);
      const renewals = recurring && expire ? renewalsNeeded(expire, cost.period, today, horizon) : 0;
      const dueCents = renewals * cost.cents;

      if (recurring) sumInto(monthly, cost.currency, cost.cents / periodInMonths(cost.period));
      if (dueCents) sumInto(due, cost.currency, dueCents);
      if (recurring && expire && (!nextExpiry || expire < nextExpiry)) nextExpiry = expire;
      items.push({ name: row.name, note: row.note, expire, cost, renewals, dueCents });
    }

    const topUp = {};
    for (const [currency, cents] of Object.entries(due)) {
      const covers = balance && (!balance.currency || !currency || balance.currency === currency);
      topUp[currency] = cents - (covers ? balance.cents : 0);
    }

    return {
      horizon,
      months,
      items,
      monthly: roundMap(monthly),
      due,
      topUp,
      runway: runway(items, { today, balance }),
      dueCount: items.filter((i) => i.renewals > 0).length,
      nextExpiry,
      issues,
    };
  }

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const pad2 = (n) => String(n).padStart(2, '0');
  const formatDate = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;

  function formatMoney(cents, currency) {
    const sign = cents < 0 ? '−' : '';
    const number = (Math.abs(cents) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .replace(/,/g, '\u00a0');
    return `${sign}${number}${currency ? '\u00a0' + currency : ''}`;
  }

  function formatMoneyMap(map, fallbackCurrency) {
    const parts = Object.entries(map).map(([currency, cents]) => formatMoney(cents, currency));
    return parts.length ? parts.join(' + ') : formatMoney(0, fallbackCurrency);
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    return b === 1 ? one : many;
  }

  const daysBetween = (date, today) => Math.round((date - today) / DAY_MS);

  function daysUntil(date, today) {
    const n = daysBetween(date, today);
    if (n === 0) return 'сегодня';
    return n > 0 ? `через ${n} дн.` : `просрочено на ${-n} дн.`;
  }

  /* ---- IP addresses and traffic: pure string helpers ---- */

  const cleanupText = (value) => String(value || '').replace(SPACES, ' ').trim();

  function isIpv4(token) {
    const match = token.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
    if (!match) return false;
    if (match.slice(1, 5).some((octet) => Number(octet) > 255)) return false;
    return match[5] === undefined || Number(match[5]) <= 32;
  }

  function isIpv6(token) {
    const match = token.match(/^([0-9a-f:.]+)(?:\/(\d{1,3}))?$/i);
    if (!match) return false;
    const address = match[1];
    if ((address.match(/:/g) || []).length < 2) return false;
    if (!/[0-9a-f]/i.test(address)) return false;
    if (match[2] !== undefined && Number(match[2]) > 128) return false;
    try {
      new URL('http://[' + address + ']/');
      return true;
    } catch (e) {
      return false;
    }
  }

  function extractIps(text) {
    const found = [];
    for (const rawToken of String(text || '').split(/[\s,;|()[\]<>"']+/)) {
      const token = rawToken.replace(/^[^0-9a-f:]+|[^0-9a-f:/]+$/gi, '');
      if (token && (isIpv4(token) || isIpv6(token)) && !found.includes(token)) found.push(token);
    }
    return found;
  }

  function parseFlexibleNumber(value) {
    const compact = String(value || '').replace(/\s+/g, '');
    if (!compact) return NaN;

    const commaCount = (compact.match(/,/g) || []).length;
    const dotCount = (compact.match(/\./g) || []).length;

    if (commaCount && dotCount) {
      const decimalSeparator = compact.lastIndexOf(',') > compact.lastIndexOf('.') ? ',' : '.';
      const thousandsPattern = decimalSeparator === ',' ? /\./g : /,/g;
      return parseFloat(compact.replace(thousandsPattern, '').replace(decimalSeparator, '.'));
    }
    if (commaCount > 1) return parseFloat(compact.replace(/,/g, ''));
    if (dotCount > 1) return parseFloat(compact.replace(/\./g, ''));
    if (commaCount === 1) {
      const parts = compact.split(',');
      if (parts[1] && parts[1].length <= 2) return parseFloat(parts[0] + '.' + parts[1]);
      return parseFloat(compact.replace(',', ''));
    }
    if (dotCount === 1) {
      const parts = compact.split('.');
      if (parts[1] && parts[1].length > 2) return parseFloat(compact.replace('.', ''));
    }
    return parseFloat(compact);
  }

  function toMb(value, unit) {
    switch (unit) {
      case 'KB': return value / 1024;
      case 'GB': return value * 1024;
      case 'TB': return value * 1024 * 1024;
      default: return value;
    }
  }

  // "2048MB / 1048576MB" -> used / total with a percentage.
  function parseTrafficValue(raw) {
    if (!raw) return null;
    const match = cleanupText(raw).match(/([\d.,]+)\s*(KB|MB|GB|TB)?\s*\/\s*([\d.,]+)\s*(KB|MB|GB|TB)?/i);
    if (!match) return null;

    const usedValue = parseFlexibleNumber(match[1]);
    const usedUnit = (match[2] || 'MB').toUpperCase();
    const totalValue = parseFlexibleNumber(match[3]);
    const totalUnit = (match[4] || usedUnit).toUpperCase();
    if (!isFinite(usedValue) || !isFinite(totalValue) || totalValue <= 0) return null;

    const usedMb = toMb(usedValue, usedUnit);
    const totalMb = toMb(totalValue, totalUnit);
    if (!isFinite(usedMb) || !isFinite(totalMb) || totalMb <= 0) return null;

    const percent = Math.max(0, Math.min(100, (usedMb / totalMb) * 100));
    return {
      usedText: `${cleanupText(match[1])} ${usedUnit}`,
      totalText: `${cleanupText(match[3])} ${totalUnit}`,
      percent,
      percentText: `${Math.round(percent)}%`,
    };
  }

  /* ---- subnets (Cherry Servers): which addresses are usable and how netplan wants them ---- */

  const ipToInt = (ip) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  const intToIp = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');

  // Every address of the subnet except the network, the broadcast and the gateway
  // (203.0.113.8/29 with gateway .9 -> .10 ... .14). Without a known gateway, network + 1 is assumed.
  function subnetHosts(cidr, gateway) {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
    if (!match || !isIpv4(match[1])) return null;
    const prefix = Number(match[2]);
    if (prefix < 16 || prefix > 32) return null;

    const size = 2 ** (32 - prefix);
    const base = Math.floor(ipToInt(match[1]) / size) * size;
    const skip = new Set([base, base + size - 1, gateway && isIpv4(gateway) ? ipToInt(gateway) : base + 1]);

    const hosts = [];
    for (let n = base; n < base + size; n++) if (!skip.has(n)) hosts.push(intToIp(n));
    return { hosts, prefix };
  }

  // The "addresses:" list items of a netplan file: plain with 8 spaces by default, or the Ubuntu style
  // with 6 spaces and quoted addresses.
  const formatNetplan = ({ hosts, prefix }, { indent = 8, quote = false } = {}) =>
    hosts.map((ip) => `${' '.repeat(indent)}- ${quote ? '"' : ''}${ip}/${prefix}${quote ? '"' : ''}`).join('\n');

  if (typeof module !== 'undefined' && typeof document === 'undefined') {
    // Loaded by the unit tests in Node, not by Tampermonkey.
    module.exports = {
      parseMoney, parsePeriod, parseCost, parseDate, addMonths, renewalsNeeded, runway, analyze,
      formatMoney, formatMoneyMap, formatDate, plural, daysUntil,
      extractIps, parseTrafficValue, subnetHosts, formatNetplan,
    };
    return;
  }

  if (window.__hostlens) return;
  window.__hostlens = true;

  /* ------------------------------------------------------------------ *
   * Shared page helpers
   * ------------------------------------------------------------------ */

  const PANEL_CLASS = 'hl-panel';
  const HORIZONS = [1, 2, 3, 6, 12];

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('hl:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('hl:' + key, JSON.stringify(value));
      } catch (e) { /* storage is optional */ }
    },
  };

  const savedMonths = store.get('months', 1);
  const state = {
    months: HORIZONS.includes(savedMonths) ? savedMonths : 1,
    open: store.get('open', false) === true,
  };

  const STYLE = `
    .${PANEL_CLASS} {
      flex: none; box-sizing: border-box; padding: 10px 16px 12px;
      border-top: 1px solid var(--isp-border-default, rgba(127, 127, 127, .35));
      background: var(--isp-background-additional, transparent);
      color: var(--isp-text-main, inherit); font-size: 13px; line-height: 1.4;
    }
    .${PANEL_CLASS}.hl-block { margin: 16px 0; border: 1px solid rgba(127, 127, 127, .35); border-radius: 8px; }
    .${PANEL_CLASS} .hl-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px 36px; }
    .${PANEL_CLASS} .hl-label { color: var(--isp-text-additional, #707070); font-size: 12px; white-space: nowrap; }
    .${PANEL_CLASS} .hl-value { font-size: 20px; font-weight: 600; line-height: 1.3; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .${PANEL_CLASS} .hl-sub { color: var(--isp-text-additional, #707070); font-size: 12px; }
    .${PANEL_CLASS} .hl-value--ok { color: var(--isp-text-success, #1a8f43); }
    .${PANEL_CLASS} .hl-value--due { color: var(--isp-text-danger, #c62828); }
    .${PANEL_CLASS} .hl-spacer { flex: 1 1 auto; }
    .${PANEL_CLASS} .hl-toggle {
      align-self: center; padding: 2px 0; border: 0; background: none; cursor: pointer;
      color: var(--isp-text-interactive, #2563eb); font: inherit;
    }
    .${PANEL_CLASS} .hl-select {
      margin-left: 4px; padding: 0 2px; font: inherit; color: inherit; cursor: pointer;
      background: transparent; border: 1px solid rgba(127, 127, 127, .45); border-radius: 4px;
    }
    .${PANEL_CLASS} .hl-warn { margin-top: 8px; color: var(--isp-text-warning, #b26a00); font-size: 12px; }
    .${PANEL_CLASS} .hl-details { display: none; margin-top: 10px; max-height: 40vh; overflow: auto; }
    .${PANEL_CLASS}.hl-open .hl-details { display: block; }
    .${PANEL_CLASS} .hl-table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
    .${PANEL_CLASS} .hl-table th, .${PANEL_CLASS} .hl-table td {
      padding: 4px 16px 4px 0; text-align: left; white-space: nowrap;
      border-bottom: 1px solid rgba(127, 127, 127, .25);
    }
    .${PANEL_CLASS} .hl-table th { color: var(--isp-text-additional, #707070); font-weight: 400; font-size: 12px; }
    .${PANEL_CLASS} .hl-table .hl-num { text-align: right; }
    .${PANEL_CLASS} .hl-table .hl-muted { color: var(--isp-text-additional, #707070); }
    .${PANEL_CLASS} .hl-table tfoot td { font-weight: 600; border-bottom: 0; }

    .hl-box {
      position: relative; box-sizing: border-box; width: 100%; min-width: 230px; max-width: 460px; margin-top: 6px;
      padding: 7px 34px 7px 10px; display: grid; gap: 3px;
      border: 1px solid rgba(127, 127, 127, .22); border-radius: 8px; background: rgba(127, 127, 127, .05);
      font-size: 12px; font-weight: 400; line-height: 1.45; color: inherit; text-align: left; cursor: copy;
      transition: border-color .12s, background-color .12s;
    }
    .hl-box:hover { border-color: rgba(59, 130, 246, .55); background: rgba(59, 130, 246, .06); }
    .hl-box.hl-flash { border-color: rgba(22, 163, 74, .7); background: rgba(22, 163, 74, .08); }
    .hl-box-row { display: grid; grid-template-columns: 54px minmax(0, 1fr); align-items: center; column-gap: 8px; min-height: 20px; }
    .hl-box-k { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; opacity: .55; white-space: nowrap; }
    .hl-box-v { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 6px; min-width: 0; }
    .hl-muted { opacity: .6; }
    .hl-ip {
      margin: 0; padding: 0 6px; border: 0; border-radius: 4px; background: rgba(127, 127, 127, .14); color: inherit;
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; cursor: copy; white-space: nowrap;
    }
    .hl-ip:hover { background: rgba(59, 130, 246, .2); }
    .hl-ip.hl-ok { background: rgba(22, 163, 74, .25); }
    .hl-bar { position: relative; width: 72px; height: 6px; border-radius: 3px; background: rgba(127, 127, 127, .2); overflow: hidden; }
    .hl-bar > i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 3px; }
    .hl-pct { font-weight: 700; font-variant-numeric: tabular-nums; }
    .hl-pill { padding: 0 7px; border-radius: 9px; font-size: 11px; font-weight: 600; white-space: nowrap; background: rgba(127, 127, 127, .14); }
    .hl-pill.hl-warn-pill { background: rgba(234, 179, 8, .22); color: #a16207; }
    .hl-pill.hl-bad-pill { background: rgba(220, 38, 38, .16); color: #b91c1c; }
    .hl-refresh {
      position: absolute; top: 5px; right: 5px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
      background: transparent; color: inherit; font-size: 15px; line-height: 24px; text-align: center; opacity: .45; cursor: pointer;
    }
    .hl-refresh:hover { opacity: 1; background: rgba(127, 127, 127, .16); }
    .hl-refresh.hl-spin { animation: hl-spin .8s linear infinite; opacity: .8; }
    @keyframes hl-spin { to { transform: rotate(360deg); } }
    .hl-copy {
      margin: 0 0 0 8px; padding: 0 8px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; color: #374151;
      font: 500 12px/22px system-ui, -apple-system, Segoe UI, sans-serif; cursor: pointer; white-space: nowrap;
    }
    .hl-copy:hover { border-color: #9ca3af; background: #f3f4f6; }
    .hl-copy.hl-ok { border-color: rgba(22, 163, 74, .7); background: rgba(22, 163, 74, .12); color: #166534; }
    .n-modal-container code.select-none { user-select: text !important; -webkit-user-select: text !important; cursor: copy; }
    html.hl-hide-fip-meta .hl-fip-meta { display: none !important; }
    .hl-fip {
      position: sticky; top: 56px; z-index: 20;
      box-sizing: border-box; margin: 0; padding: 10px 14px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fff;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; color: #111827;
    }
    .hl-fip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .hl-fip-count { min-width: 110px; color: #6b7280; }
    .hl-fip-label { color: #6b7280; }
    .hl-fip-sep { flex: 0 0 1px; align-self: stretch; background: #e5e7eb; margin: 0 4px; }
    .hl-fip-qty { width: 52px; padding: 2px 6px; border: 1px solid #d1d5db; border-radius: 4px; font: inherit; }
    .hl-fip-status { color: #6b7280; }
    .hl-fip-btn {
      padding: 2px 10px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; color: #374151;
      font: 500 12px/22px system-ui, -apple-system, Segoe UI, sans-serif; cursor: pointer; white-space: nowrap;
    }
    .hl-fip-btn:hover:not(:disabled) { border-color: #9ca3af; background: #f3f4f6; }
    .hl-fip-btn:disabled { opacity: .45; cursor: default; }
    .hl-fip-danger { border-color: #fca5a5; color: #b91c1c; }
    .hl-fip-danger:hover:not(:disabled) { border-color: #ef4444; background: #fef2f2; }
    .hl-fip-progress { height: 4px; margin-top: 8px; border-radius: 2px; background: #e5e7eb; overflow: hidden; }
    .hl-fip-progress > i { display: block; height: 100%; width: 0; background: #2563eb; transition: width .3s; }
    .hl-fip-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; padding: 8px 10px; border-radius: 4px; background: #fffbeb; border: 1px solid #fcd34d; }
    .hl-month { margin-left: 6px; color: #6b7280; font-size: 11px; white-space: nowrap; }
    .hl-fip-check { width: 16px; height: 16px; margin: 0 4px 0 0; cursor: pointer; accent-color: #2563eb; }
    .hl-toast {
      position: fixed; left: 50%; bottom: 24px; z-index: 2147483647; transform: translate(-50%, 8px);
      max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 8px; background: #111827; color: #fff;
      font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
      white-space: pre-line; pointer-events: none; opacity: 0; transition: opacity .15s, transform .15s;
    }
    .hl-toast.hl-show { opacity: 1; transform: translate(-50%, 0); }
  `;

  function injectStyles() {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(STYLE);
      return;
    }
    document.head.append(h('style', { id: 'hl-style' }, STYLE));
  }

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  const textOf = (node) => (node ? node.textContent.replace(SPACES, ' ').trim() : '');

  const insideOurs = (node) => {
    const element = node.nodeType === 1 ? node : node.parentElement;
    return !!element && !!element.closest('.' + PANEL_CLASS + ', .hl-box, .hl-copy, .hl-fip, .hl-fip-check, .hl-month');
  };

  // Calls `run` at most once per `delay` while the page keeps changing, ignoring our own DOM edits.
  function watchPage(run, delay) {
    let timer = 0;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = 0;
        try {
          run();
        } catch (e) {
          console.error('[hostlens]', e);
        }
      }, delay);
    };
    new MutationObserver((mutations) => {
      if (!mutations.every((m) => insideOurs(m.target))) schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
    return schedule;
  }

  /* ---- small DOM helpers: element factory, toast, clipboard ---- */

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  let toastNode = null;
  let toastTimer = null;

  function showToast(text) {
    if (!toastNode) {
      toastNode = el('div', 'hl-toast');
      document.body.appendChild(toastNode);
    }
    toastNode.textContent = text;
    void toastNode.offsetWidth; // restart the transition on repeated toasts
    toastNode.classList.add('hl-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastNode.classList.remove('hl-show'), 1600);
  }

  async function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }
    await navigator.clipboard.writeText(text);
  }

  async function copyWithFeedback(text, flashNode, flashClass) {
    try {
      await copyText(text);
      showToast('Скопировано:\n' + text);
      flashNode.classList.add(flashClass);
      setTimeout(() => flashNode.classList.remove(flashClass), 700);
    } catch (err) {
      console.error(err);
      showToast('Не удалось скопировать');
    }
  }

  /* ---- the totals panel, shared by every site ---- */

  // "How long until the first service switches off at the current balance".
  function runwayTile(runway, today) {
    if (!runway) return null;
    const label = h('div', { class: 'hl-label' }, 'Баланса хватит до');
    if (!runway.outage) {
      return h('div', { class: 'hl-tile' }, label,
        h('div', { class: 'hl-value hl-value--ok' }, `✓ ${RUNWAY_MONTHS / 12}+ года`),
        h('div', { class: 'hl-sub' }, 'все продления покрыты'));
    }
    const days = daysBetween(runway.outage, today);
    const extra = runway.names.length - 2;
    const names = runway.names.slice(0, 2).join(', ') + (extra > 0 ? ` и ещё ${extra}` : '');
    return h('div', { class: 'hl-tile' }, label,
      h('div', { class: 'hl-value' + (days <= 7 ? ' hl-value--due' : '') }, formatDate(runway.outage)),
      h('div', { class: 'hl-sub' }, `${daysUntil(runway.outage, today)} · первое отключение`),
      h('div', { class: 'hl-sub' }, `не хватит на: ${names}`));
  }

  // view: { model, balance, today, notes: [string] }
  function renderPanel(panel, view) {
    const { model, balance, today, notes } = view;
    const fallbackCurrency = Object.keys(model.monthly)[0] || (balance && balance.currency) || '';
    const positiveTopUp = Object.fromEntries(Object.entries(model.topUp).filter(([, cents]) => cents > 0));
    const covered = Object.keys(positiveTopUp).length === 0;

    const leftover = balance && Object.keys(model.due).length
      ? formatMoney(balance.cents - (Object.values(model.due)[0] || 0), balance.currency)
      : null;

    const select = h(
      'select',
      {
        class: 'hl-select',
        'aria-label': 'На сколько месяцев вперёд считать',
        onchange: (e) => {
          state.months = Number(e.target.value);
          store.set('months', state.months);
          refreshPanels();
        },
      },
      HORIZONS.map((n) => {
        const option = h('option', { value: n }, `ещё ${n} мес`);
        option.selected = n === state.months;
        return option;
      }),
    );

    const tiles = [
      h('div', { class: 'hl-tile' },
        h('div', { class: 'hl-label' }, 'Стоимость в месяц'),
        h('div', { class: 'hl-value' }, formatMoneyMap(model.monthly, fallbackCurrency)),
        h('div', { class: 'hl-sub' }, `${model.items.length} ${plural(model.items.length, 'услуга', 'услуги', 'услуг')}`)),
      h('div', { class: 'hl-tile' },
        h('div', { class: 'hl-label' }, 'Чтобы всё работало', select),
        h('div', { class: 'hl-value' }, formatMoneyMap(model.due, fallbackCurrency)),
        h('div', { class: 'hl-sub' }, `до ${formatDate(model.horizon)} · продлить ${model.dueCount} из ${model.items.length}`),
        model.nextExpiry && h('div', { class: 'hl-sub' },
          `ближайшее: ${formatDate(model.nextExpiry)} (${daysUntil(model.nextExpiry, today)})`)),
      h('div', { class: 'hl-tile' },
        h('div', { class: 'hl-label' }, 'Баланс'),
        h('div', { class: 'hl-value' }, balance ? formatMoney(balance.cents, balance.currency) : '—'),
        !balance && h('div', { class: 'hl-sub' }, 'не найден на странице')),
      runwayTile(model.runway, today),
      h('div', { class: 'hl-tile' },
        h('div', { class: 'hl-label' }, 'Пополнить на'),
        covered
          ? h('div', { class: 'hl-value hl-value--ok' }, '✓ хватает')
          : h('div', { class: 'hl-value hl-value--due' }, formatMoneyMap(positiveTopUp, fallbackCurrency)),
        covered && leftover && h('div', { class: 'hl-sub' }, `останется ${leftover}`)),
    ];

    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'hl-toggle',
        'aria-expanded': String(state.open),
        onclick: () => {
          state.open = !state.open;
          store.set('open', state.open);
          refreshPanels();
        },
      },
      state.open ? 'Скрыть ▴' : 'Подробнее ▾',
    );

    const warnings = [...notes];
    if (model.issues.noPrice) warnings.push(`Не удалось разобрать цену у услуг: ${model.issues.noPrice}.`);
    if (model.issues.guessedPeriod) warnings.push(`Период оплаты не распознан у услуг: ${model.issues.guessedPeriod}, считаю его месяцем.`);

    const sorted = model.items.slice().sort((a, b) => (a.expire || Infinity) - (b.expire || Infinity));
    const details = h('div', { class: 'hl-details' },
      h('table', { class: 'hl-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Услуга'),
          h('th', {}, 'Действует до'),
          h('th', { class: 'hl-num' }, 'Цена'),
          h('th', { class: 'hl-num' }, 'Продлений'),
          h('th', { class: 'hl-num' }, 'К оплате'))),
        h('tbody', {}, sorted.map((item) => h('tr', {},
          h('td', {}, item.name, item.note && h('span', { class: 'hl-muted' }, `  ${item.note}`)),
          h('td', {}, item.expire ? formatDate(item.expire) : '—'),
          h('td', { class: 'hl-num' }, formatMoney(item.cost.cents, item.cost.currency)),
          h('td', { class: 'hl-num' }, String(item.renewals)),
          h('td', { class: 'hl-num' }, item.dueCents ? formatMoney(item.dueCents, item.cost.currency) : '—')))),
        h('tfoot', {}, h('tr', {},
          h('td', { colspan: 4 }, 'Итого к оплате'),
          h('td', { class: 'hl-num' }, formatMoneyMap(model.due, fallbackCurrency))))));

    panel.classList.toggle('hl-open', state.open);
    panel.replaceChildren(
      h('div', { class: 'hl-row' }, tiles, h('div', { class: 'hl-spacer' }), toggle),
      ...warnings.map((w) => h('div', { class: 'hl-warn' }, `⚠ ${w}`)),
      details,
    );
  }

  // Puts (or updates) the panel right after `anchor`; skips the redraw when nothing changed.
  function mountPanel(anchor, view, { block = false } = {}) {
    const next = anchor.nextElementSibling;
    let panel = next && next.classList.contains(PANEL_CLASS) ? next : null;
    if (!panel) {
      panel = h('div', { class: PANEL_CLASS + (block ? ' hl-block' : ''), role: 'region', 'aria-label': 'Итоги по услугам' });
      anchor.after(panel);
    }
    const signature = JSON.stringify([view, state.open]);
    if (panel.dataset.signature !== signature) {
      panel.dataset.signature = signature;
      renderPanel(panel, view);
    }
  }

  function removePanelAfter(anchor) {
    const next = anchor.nextElementSibling;
    if (next && next.classList.contains(PANEL_CLASS)) next.remove();
  }

  // The active adapter installs its own refresh here, so widgets in the panel can trigger a redraw.
  let refreshPanels = () => {};

  /* ------------------------------------------------------------------ *
   * Adapter: BILLmanager (Senko, WAIcore, H2 Nexus)
   * ------------------------------------------------------------------ */

  function runBillmanager() {
    const cellOf = (tr, name) => textOf(tr.querySelector(`td[data-table-column-name="${name}"]`));

    // Lists of services have both a cost and an expiry column (VDS, dedicated, domains...).
    // The script relies on BILLmanager's `data-table-column-name` attributes (cost, expiredate,
    // item_status, domain, pricelist) and on <isp-table>/<isp-balance>; if the panel disappears
    // after a BILLmanager update, these selectors are the first thing to check.
    function readRows(table) {
      if (!table.querySelector('td[data-table-column-name="expiredate"]')) return [];
      const rows = [];
      for (const tr of table.querySelectorAll('tbody tr')) {
        if (!tr.querySelector('td[data-table-column-name="cost"]')) continue;
        rows.push({
          name: cellOf(tr, 'domain') || cellOf(tr, 'name') || cellOf(tr, 'id'),
          note: cellOf(tr, 'pricelist'),
          status: cellOf(tr, 'item_status'),
          expire: cellOf(tr, 'expiredate'),
          cost: cellOf(tr, 'cost'),
        });
      }
      return rows;
    }

    function readTotalCount(table) {
      const match = /\d+/.exec(textOf(table.querySelector('.table-header__total')));
      return match ? parseInt(match[0], 10) : null;
    }

    // <isp-balance> renders the amount in one of two elements: the plain one, or, for accounts
    // with a credit limit, the "with-credit" variant that also carries credit/late-payment text.
    function readBalance() {
      const root = document.querySelector('isp-balance');
      if (!root) return null;
      const amount = root.querySelector('.isp-balance-without-credit__amount, .isp-balance-with-credit__balance');
      return parseMoney(textOf(amount || root));
    }

    function update() {
      const balance = readBalance();
      const today = startOfDay(new Date());

      for (const table of document.querySelectorAll('isp-table')) {
        const rows = readRows(table);
        if (!rows.length) {
          removePanelAfter(table);
          continue;
        }
        const total = readTotalCount(table);
        const notes = [];
        if (total != null && rows.length < total) {
          notes.push(`Загружено ${rows.length} из ${total} строк — прокрутите список или откройте остальные страницы, итог пока неполный.`);
        }
        mountPanel(table, { model: analyze(rows, { today, months: state.months, balance }), balance, today, notes });
      }
    }

    injectStyles();
    refreshPanels = watchPage(update, 250);
  }

  /* ------------------------------------------------------------------ *
   * Adapter: Avoro (WHMCS): totals panel + IP / traffic / due date per service
   * ------------------------------------------------------------------ */

  function runAvoro() {
    const LIST = '#tableServicesList';
    const CACHE_KEY = 'avoro_service_data_cache_v6';
    const OLD_CACHE_KEYS = ['avoro_service_data_cache_v4', 'avoro_service_data_cache_v5'];
    const TTL_IP_MS = 7 * 24 * 60 * 60 * 1000;
    const TTL_TRAFFIC_MS = 60 * 60 * 1000;
    const LIST_TTL_MS = 5 * 60 * 1000;
    const MAX_PARALLEL_REQUESTS = 3;
    const GONE = /terminated|cancel+ed|fraud/i;

    const absoluteUrl = (path) => new URL(path, location.href).href;
    const normalizeText = (value) =>
      cleanupText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[:|]+/g, ' ').toLowerCase();
    const labelContainsAny = (label, hints) => hints.some((hint) => label.includes(normalizeText(hint)));
    const uniqueElements = (list) => [...new Set(list.filter(Boolean))];

    /* ---- the services list ---- */

    // Reads the list from either the live page or a fetched copy of it. The columns are found by
    // what they contain, so a reordered or translated table keeps working.
    function readRow(tr) {
      const link = tr.querySelector('a[href*="action=productdetails"]');
      const serviceCell = tr.querySelector('td[data-type="service"]');
      if (!link || !serviceCell) return null;

      const priceNode = tr.querySelector('span.gap-5');
      let price = '';
      let cycle = '';
      if (priceNode) {
        const copy = priceNode.cloneNode(true);
        const small = copy.querySelector('small');
        cycle = textOf(small);
        if (small) small.remove();
        price = textOf(copy);
      }

      const statusNode = tr.querySelector('.label.status');
      const dueNode = [...tr.querySelectorAll('span.w-hidden')].find((n) => parseDate(textOf(n)));
      const domain = serviceCell.getAttribute('data-domain') || '';

      return {
        tr,
        href: link.getAttribute('href'),
        hostname: domain,
        name: domain || serviceCell.getAttribute('data-element-id') || '',
        note: textOf(serviceCell.querySelector('b')),
        status: textOf(statusNode),
        expire: textOf(dueNode),
        cost: cycle ? `${price} / ${cycle}` : price,
      };
    }

    const readRows = (root) => [...root.querySelectorAll(`${LIST} tbody tr`)].map(readRow).filter(Boolean);

    // WHMCS shows the account credit in the header as a link to the "add funds" page.
    function readBalance() {
      const node = document.querySelector('a.compteur[href*="addfunds"]');
      return node ? parseMoney(textOf(node)) : null;
    }

    // DataTables only keeps the current page and filter in the DOM, so the totals come from a fresh
    // copy of the page, which still has every row.
    const remote = { rows: null, at: 0, loading: false, failed: false };

    async function refreshRemote(force) {
      if (remote.loading) return;
      if (!force && remote.rows && Date.now() - remote.at < LIST_TTL_MS) return;
      remote.loading = true;
      try {
        const html = await requestText(location.href);
        const rows = readRows(new DOMParser().parseFromString(html, 'text/html'));
        remote.rows = rows.length ? rows : null;
        remote.failed = !rows.length;
      } catch (err) {
        console.warn('[hostlens] could not load the full services list', err);
        remote.failed = true;
      } finally {
        remote.loading = false;
        remote.at = Date.now();
        updatePanel();
      }
    }

    function updatePanel() {
      const table = document.querySelector(LIST);
      const anchor = table && (table.closest('.table-container') || table);
      if (!anchor) return;
      if (!remote.rows && !remote.failed) return; // wait for the full list instead of flashing partial totals

      const rows = remote.rows || readRows(document);
      if (!rows.length) {
        removePanelAfter(anchor);
        return;
      }
      const notes = remote.rows
        ? []
        : ['Не удалось загрузить полный список услуг: учтены только строки, видимые сейчас (фильтр и страницы таблицы влияют на итог).'];
      const today = startOfDay(new Date());
      const balance = readBalance();
      mountPanel(anchor, { model: analyze(rows, { today, months: state.months, balance }), balance, today, notes }, { block: true });
    }

    /* ---- cache for IP and traffic ---- */

    const memoryCache = new Map();
    const isFresh = (ts, ttl) => typeof ts === 'number' && Date.now() - ts <= ttl;

    function loadStorageCache() {
      try {
        const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    function saveStorageCache(cache) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch (e) {
        console.warn('[hostlens] cannot save cache', e);
      }
    }

    function cleanupExpiredCache() {
      try {
        OLD_CACHE_KEYS.forEach((key) => localStorage.removeItem(key));
      } catch (e) { /* ignore */ }

      const cache = loadStorageCache();
      let changed = false;
      for (const [key, item] of Object.entries(cache)) {
        const keep = item && typeof item === 'object' &&
          ((item.ips && isFresh(item.ipTs, TTL_IP_MS)) || (item.traffic && isFresh(item.trafficTs, TTL_TRAFFIC_MS)));
        if (!keep) {
          delete cache[key];
          changed = true;
        }
      }
      if (changed) saveStorageCache(cache);
    }

    const cacheKeys = (url, hostname) => [url && 'link:' + url, hostname && 'host:' + normalizeText(hostname)].filter(Boolean);

    function readEntry(key) {
      if (memoryCache.has(key)) return memoryCache.get(key);
      const entry = loadStorageCache()[key] || null;
      if (entry) memoryCache.set(key, entry);
      return entry;
    }

    function getCachedData(url, hostname) {
      const result = { ips: null, traffic: null, fetchedAt: null };
      for (const key of cacheKeys(url, hostname)) {
        const entry = readEntry(key);
        if (!entry) continue;
        if (!result.ips && Array.isArray(entry.ips) && entry.ips.length && isFresh(entry.ipTs, TTL_IP_MS)) result.ips = entry.ips;
        if (!result.traffic && entry.traffic && isFresh(entry.trafficTs, TTL_TRAFFIC_MS)) result.traffic = entry.traffic;
        const ts = Math.min(...[entry.ipTs, entry.trafficTs].filter((v) => typeof v === 'number'));
        if (isFinite(ts)) result.fetchedAt = result.fetchedAt ? Math.min(result.fetchedAt, ts) : ts;
      }
      return result;
    }

    function setCachedData(url, hostname, data) {
      const patch = {};
      const now = Date.now();
      if (Array.isArray(data.ips) && data.ips.length) Object.assign(patch, { ips: data.ips, ipTs: now });
      if (data.traffic && data.traffic.percentText) Object.assign(patch, { traffic: data.traffic, trafficTs: now });
      if (!Object.keys(patch).length) return;

      const cache = loadStorageCache();
      for (const key of cacheKeys(url, hostname)) {
        cache[key] = { ...(cache[key] || {}), ...patch };
        memoryCache.set(key, cache[key]);
      }
      saveStorageCache(cache);
    }

    function clearCachedData(url, hostname) {
      const cache = loadStorageCache();
      for (const key of cacheKeys(url, hostname)) {
        delete cache[key];
        memoryCache.delete(key);
      }
      saveStorageCache(cache);
    }

    function clearAllCache() {
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch (e) { /* ignore */ }
      memoryCache.clear();
    }

    /* ---- network ---- */

    const requestQueue = [];
    let activeRequests = 0;

    function pumpQueue() {
      while (activeRequests < MAX_PARALLEL_REQUESTS && requestQueue.length) {
        const job = requestQueue.shift();
        activeRequests += 1;
        job.run().then(job.resolve, job.reject).finally(() => {
          activeRequests -= 1;
          pumpQueue();
        });
      }
    }

    const enqueue = (run) => new Promise((resolve, reject) => {
      requestQueue.push({ run, resolve, reject });
      pumpQueue();
    });

    function gmRequestText(url) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          onload: (response) => (response.status >= 200 && response.status < 300
            ? resolve(response.responseText)
            : reject(new Error('HTTP ' + response.status))),
          onerror: () => reject(new Error('Request failed')),
        });
      });
    }

    async function fetchText(url) {
      // Same origin, so a plain fetch carries the same cookies (including Cloudflare's) as the tab.
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.text();
      } catch (err) {
        if (typeof GM_xmlhttpRequest !== 'function') throw err;
        return gmRequestText(url);
      }
    }

    async function requestText(url) {
      const html = await enqueue(() => fetchText(url));
      if (/cf-chl-|challenge-platform|<title>\s*Just a moment/i.test(html)) throw new Error('Cloudflare challenge');
      return html;
    }

    /* ---- parsing a service page ---- */

    const PRIMARY_IP_LABEL_HINTS = ['primary ip', 'main ip', 'ip principal', 'ip principale', 'haupt-ip', 'основной ip', 'основной ip-адрес', 'primary address'];
    const IP_LABEL_TOKENS = ['ip', 'ips', 'ipv4', 'ipv6', 'ip-adresse', 'ip-adressen'];
    const TRAFFIC_TITLE_HINTS = ['bandwidth', 'traffic', 'trafic', 'datenverkehr', 'bande passante', 'трафик'];
    const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TR', 'TD', 'TH', 'TABLE', 'TBODY', 'THEAD', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'LABEL']);

    // textContent glues lines separated by <br> together, so the text is collected by hand.
    function nodeText(root) {
      let out = '';
      (function walk(node) {
        if (node.nodeType === 3) {
          out += node.nodeValue;
          return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
        if (tag === 'BR') {
          out += '\n';
          return;
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          out += '\n' + (node.value || node.getAttribute('value') || '') + '\n';
          return;
        }
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) out += '\n';
        for (const child of node.childNodes) walk(child);
        if (isBlock) out += '\n';
      })(root);
      return out;
    }

    function matchesPrimaryIpLabel(label) {
      if (!label) return false;
      if (labelContainsAny(label, PRIMARY_IP_LABEL_HINTS)) return true;
      return label.includes('ip') && ['primary', 'main', 'основ', 'haupt', 'princip'].some((word) => label.includes(word));
    }

    function matchesAnyIpLabel(label) {
      if (!label || label.length > 40) return false;
      if (matchesPrimaryIpLabel(label)) return true;
      if (label.includes('ip-адрес') || label.includes('ip адрес') || label.includes('ip address')) return true;
      return label.split(/[^a-z0-9а-я-]+/i).filter(Boolean).some((token) => IP_LABEL_TOKENS.includes(token));
    }

    function getLabelValueCandidates(labelNode) {
      const candidates = [];
      if (labelNode.tagName === 'DT' || labelNode.tagName === 'TH') {
        const sibling = labelNode.nextElementSibling;
        if (sibling && (sibling.tagName === 'DD' || sibling.tagName === 'TD')) candidates.push(sibling);
      }
      candidates.push(labelNode.nextElementSibling);
      const row = labelNode.closest('.row, tr, li, .form-group, .list-group-item');
      if (row) candidates.push(row);
      candidates.push(labelNode.parentElement);
      return uniqueElements(candidates);
    }

    function parseIpsFromDoc(doc) {
      const primary = [];
      const secondary = [];
      for (const labelNode of doc.querySelectorAll('strong, b, dt, th, label, .text-muted')) {
        const label = normalizeText(labelNode.textContent);
        if (!matchesAnyIpLabel(label)) continue;
        const target = matchesPrimaryIpLabel(label) ? primary : secondary;
        for (const candidate of getLabelValueCandidates(labelNode)) {
          const ips = extractIps(nodeText(candidate));
          if (ips.length) {
            target.push(...ips);
            break;
          }
        }
      }

      const combined = [...new Set([...primary, ...secondary])];
      if (combined.length) return combined;

      const domainBlock = doc.querySelector('#domain');
      if (domainBlock) {
        const ips = extractIps(nodeText(domainBlock));
        if (ips.length) return ips;
      }
      const bodyIps = extractIps(nodeText(doc.body)).filter(isIpv4);
      return bodyIps.length ? [bodyIps[0]] : [];
    }

    function parseTrafficFromContainer(container) {
      if (!container) return null;
      for (const node of [container, ...container.querySelectorAll('p, div, span, li')]) {
        const parsed = parseTrafficValue(node.textContent);
        if (parsed) return parsed;
      }
      return null;
    }

    function parseTrafficFromDoc(doc) {
      for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6, strong')) {
        const title = normalizeText(heading.textContent);
        if (!title || !labelContainsAny(title, TRAFFIC_TITLE_HINTS)) continue;
        const containers = uniqueElements([
          heading.closest('.col-sm-6'), heading.closest('.col-md-6'), heading.closest('.col-lg-6'),
          heading.parentElement, heading.closest('.well'),
        ]);
        for (const container of containers) {
          const parsed = parseTrafficFromContainer(container);
          if (parsed) return parsed;
        }
      }
      for (const container of doc.querySelectorAll('.well, .row, .col-sm-6, .col-md-6')) {
        if (!labelContainsAny(normalizeText(container.textContent), TRAFFIC_TITLE_HINTS)) continue;
        const parsed = parseTrafficFromContainer(container);
        if (parsed) return parsed;
      }
      return null;
    }

    async function fetchServiceData(detailsPath, hostname, forceRefresh) {
      const url = absoluteUrl(detailsPath);

      if (forceRefresh) {
        clearCachedData(url, hostname);
      } else {
        const cached = getCachedData(url, hostname);
        if (cached.ips && cached.traffic) return cached;
      }

      const doc = new DOMParser().parseFromString(await requestText(url), 'text/html');
      const parsed = { ips: parseIpsFromDoc(doc), traffic: parseTrafficFromDoc(doc) || null };
      setCachedData(url, hostname, parsed);
      const cached = getCachedData(url, hostname);
      return {
        ips: parsed.ips.length ? parsed.ips : (cached.ips || []),
        traffic: parsed.traffic || cached.traffic || null,
        fetchedAt: Date.now(),
      };
    }

    /* ---- the per-service box ---- */

    const trafficColor = (percent) => (!isFinite(percent) ? '#9ca3af' : percent < 60 ? '#16a34a' : percent < 85 ? '#d97706' : '#dc2626');

    function formatAge(ts) {
      if (!ts) return '';
      const minutes = Math.round((Date.now() - ts) / 60000);
      if (minutes < 1) return 'только что';
      if (minutes < 60) return `${minutes} мин назад`;
      const hours = Math.round(minutes / 60);
      return hours < 48 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
    }

    function makeRow(label) {
      const row = el('div', 'hl-box-row');
      const value = el('div', 'hl-box-v');
      row.append(el('span', 'hl-box-k', label), value);
      return { row, value };
    }

    function renderIps(container, ips) {
      if (!ips || !ips.length) {
        container.append(el('span', 'hl-muted', 'не найден'));
        return;
      }
      for (const ip of ips) {
        const chip = el('button', 'hl-ip', ip);
        chip.type = 'button';
        chip.title = 'Скопировать ' + ip;
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          copyWithFeedback(ip, chip, 'hl-ok');
        });
        container.append(chip);
      }
    }

    function renderTraffic(container, traffic) {
      if (!traffic || !traffic.percentText) {
        container.append(el('span', 'hl-muted', 'не найден'));
        return;
      }
      const color = trafficColor(traffic.percent);
      const bar = el('span', 'hl-bar');
      const fill = el('i');
      fill.style.width = `${Math.max(2, traffic.percent)}%`;
      fill.style.background = color;
      bar.append(fill);
      const pct = el('span', 'hl-pct', traffic.percentText);
      pct.style.color = color;
      container.append(bar, pct, el('span', 'hl-muted', `${traffic.usedText} / ${traffic.totalText}`));
    }

    // Price and due date are already in the list, so this row needs no request.
    function renderBilling(container, row) {
      const parsed = parseCost(row.cost);
      const due = parseDate(row.expire);
      if (!parsed && !due) {
        container.append(el('span', 'hl-muted', '—'));
        return;
      }
      if (row.cost) container.append(el('span', null, row.cost));
      if (due) container.append(el('span', 'hl-muted', `до ${formatDate(due)}`));
      if (due && parsed && !parsed.period.once) {
        const days = daysBetween(due, startOfDay(new Date()));
        const pill = el('span', 'hl-pill', days < 0 ? 'просрочено' : days === 0 ? 'сегодня' : `${days} дн.`);
        if (days <= 3) pill.classList.add('hl-bad-pill');
        else if (days <= 10) pill.classList.add('hl-warn-pill');
        container.append(pill);
      }
    }

    function createInfoBox(row) {
      const box = el('div', 'hl-box');
      let currentIps = [];
      let loading = false;

      const refreshBtn = el('button', 'hl-refresh', '↻');
      refreshBtn.type = 'button';

      function render(view) {
        box.replaceChildren();
        const ipRow = makeRow('IP');
        const trafficRow = makeRow('Трафик');
        const billingRow = makeRow('Оплата');
        renderBilling(billingRow.value, row);

        if (view.status === 'loading') {
          [ipRow, trafficRow].forEach((r) => r.value.append(el('span', 'hl-muted', 'загрузка…')));
        } else if (view.status === 'error') {
          ipRow.value.append(el('span', 'hl-muted', 'ошибка: ' + view.message));
          trafficRow.value.append(el('span', 'hl-muted', '—'));
        } else {
          renderIps(ipRow.value, view.data.ips);
          renderTraffic(trafficRow.value, view.data.traffic);
        }

        currentIps = view.status === 'ok' ? (view.data.ips || []) : [];
        box.title = currentIps.length ? (currentIps.length > 1 ? 'Клик — скопировать все IP' : 'Клик — скопировать IP') : '';
        refreshBtn.classList.toggle('hl-spin', view.status === 'loading');
        refreshBtn.title = view.status === 'ok' && view.data.fetchedAt ? `Обновить (данные ${formatAge(view.data.fetchedAt)})` : 'Обновить';
        box.append(ipRow.row, trafficRow.row, billingRow.row, refreshBtn);
      }

      async function load(force) {
        if (loading) return;
        loading = true;
        render({ status: 'loading' });
        try {
          render({ status: 'ok', data: await fetchServiceData(row.href, row.hostname, force) });
        } catch (err) {
          console.error('[hostlens] failed to fetch service data for', row.href, err);
          render({ status: 'error', message: err && err.message ? err.message : 'неизвестно' });
        } finally {
          loading = false;
        }
      }

      refreshBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        load(true);
      });

      // A click on the box must not open the service (the whole table row is a link); copy the IPs instead.
      box.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!currentIps.length) return;
        if (window.getSelection && String(window.getSelection()).trim()) return; // the user is selecting text
        copyWithFeedback(currentIps.join('\n'), box, 'hl-flash');
      });
      ['auxclick', 'dblclick'].forEach((type) => box.addEventListener(type, (e) => e.stopPropagation()));

      box.load = load;
      return box;
    }

    const processed = new WeakSet();

    function scanRows() {
      for (const row of readRows(document)) {
        if (processed.has(row.tr)) continue;
        processed.add(row.tr);
        if (GONE.test(row.status)) continue;

        const cell = row.tr.querySelector('td[data-type="service"]');
        if (cell.querySelector('.hl-box')) continue;
        const box = createInfoBox(row);
        (cell.querySelector('.table__collapse__mobile__wrapper__informations') || cell).append(box);
        box.load(false);
      }
    }

    function scan() {
      if (!document.querySelector(LIST)) return;
      refreshRemote(false);
      scanRows();
      updatePanel();
    }

    injectStyles();
    cleanupExpiredCache();

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Обновить все услуги', () => {
        clearAllCache();
        document.querySelectorAll('.hl-box').forEach((box) => box.load && box.load(true));
        refreshRemote(true);
      });
      GM_registerMenuCommand('Очистить кэш', () => {
        clearAllCache();
        showToast('Кэш очищен');
      });
    }

    refreshPanels = watchPage(scan, 150);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshRemote(false);
    });
  }

  /* ------------------------------------------------------------------ *
   * Adapter: Cherry Servers portal (Vue SPA): "copy for netplan" on every public IPv4 subnet
   * ------------------------------------------------------------------ */

  // The portal lists floating IPs ten per page (GET /v1/servers/<id>/ips?limit=10&offset=0) and the Vue list
  // simply renders whatever comes back. So the first page's request is changed to ask for 100; the pager is
  // hidden when that covers the whole list. Only the page size of the portal's own request changes.
  const FIP_PAGE_LIMIT = 100;
  const listing = { total: null };

  function patchFloatingListing() {
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const proto = page.XMLHttpRequest && page.XMLHttpRequest.prototype;
    if (!proto || proto.__hlPatched) return;
    const open = proto.open;
    proto.open = function (method, url, ...rest) {
      try {
        const u = new URL(url, location.href);
        if (/\/v1\/servers\/\d+\/ips$/.test(u.pathname)) {
          listing.total = null;
          if (u.searchParams.get('limit') === '10' && u.searchParams.get('offset') === '0') {
            u.searchParams.set('limit', String(FIP_PAGE_LIMIT));
            url = u.toString();
            this.addEventListener('load', () => {
              const total = Number(this.getResponseHeader('x-total-count'));
              listing.total = Number.isFinite(total) ? total : null;
            });
          }
        }
      } catch (e) { /* never break the portal's own request */ }
      return open.call(this, method, url, ...rest);
    };
    proto.__hlPatched = true;
  }

  function runCherry() {
    const SUBNET_LINK = /\/network\/subnets\/\d+/;
    const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

    // A subnet card is a link to /network/subnets/<id>; the CIDR is the only element whose whole text is a
    // network in CIDR notation, and the gateway follows a "Gateway:" label.
    function readSubnet(card) {
      const node = [...card.querySelectorAll('div, span')].find((n) => !n.children.length && CIDR.test(textOf(n)));
      if (!node) return null;
      const gateway = /Gateway:?\s*((?:\d{1,3}\.){3}\d{1,3})/i.exec(textOf(card));
      const subnet = subnetHosts(textOf(node), gateway && gateway[1]);
      return subnet && { node, subnet };
    }

    // Two list styles: plain (8 spaces) and the quoted Ubuntu one (6 spaces).
    const VARIANTS = [
      { label: 'netplan', options: { indent: 8, quote: false }, hint: 'пункты списка с отступом 8 пробелов' },
      { label: 'ubuntu', options: { indent: 6, quote: true }, hint: 'адреса в кавычках, отступ 6 пробелов' },
    ];

    function makeButton(card, variant, count) {
      const button = el('button', 'hl-copy', variant.label);
      button.type = 'button';
      button.title = `Скопировать ${count} IP: ${variant.hint}`;
      button.addEventListener('click', (e) => {
        // The whole card is a link; keep the click away from it.
        e.preventDefault();
        e.stopPropagation();
        const current = readSubnet(card); // read again: the card may have been reused for another subnet
        if (!current) return;
        copyText(formatNetplan(current.subnet, variant.options)).then(
          () => {
            showToast(`Скопировано ${current.subnet.hosts.length} IP (${variant.label})`);
            button.classList.add('hl-ok');
            setTimeout(() => button.classList.remove('hl-ok'), 700);
          },
          () => showToast('Не удалось скопировать'),
        );
      });
      return button;
    }

    function scan() {
      scanFloatingIps();
      scanDialogs();
      scanPrices();
      for (const card of document.querySelectorAll('a[href]')) {
        if (!SUBNET_LINK.test(card.getAttribute('href'))) continue;
        const found = readSubnet(card);
        const existing = card.querySelectorAll('.hl-copy');
        if (!found) {
          existing.forEach((button) => button.remove()); // Vue reuses nodes, e.g. when switching from IPv4 to IPv6
          continue;
        }
        if (existing.length) continue;

        let anchor = found.node;
        for (const variant of VARIANTS) {
          const button = makeButton(card, variant, found.subnet.hosts.length);
          anchor.after(button);
          anchor = button;
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Floating IPs: select several cards and attach / detach / terminate them in one go,
     * order N at once, copy addresses for netplan, and make the termination phrase usable.
     * The portal's own buttons do the work (it reloads the whole list after every action), so
     * the script only drives them: nothing here talks to the API or touches the session token.
     * ------------------------------------------------------------------ */

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function waitFor(check, timeout = 5000) {
      const started = Date.now();
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() - started > timeout) return null;
        await sleep(60);
      }
    }

    const FIP_ORDER = 'button[data-context="order_floating_ip"]';
    const fipCards = () => [...document.querySelectorAll('[data-context="floating-ip"]')];
    const fipAddress = (card) => textOf(card.querySelector('.text-black.font-semibold'));
    const fipAttachButton = (card) => card.querySelector('[data-context="floating-ip_attachment"]'); // only while the IP is free
    const fipCard = (ip) => fipCards().find((card) => fipAddress(card) === ip) || null;
    const isFree = (ip) => {
      const card = fipCard(ip);
      return !!card && !!fipAttachButton(card);
    };
    const isAttached = (ip) => {
      const card = fipCard(ip);
      return !!card && !fipAttachButton(card);
    };
    const menuOption = (menu, label) => [...menu.querySelectorAll('.n-dropdown-option-body__label')].find((n) => textOf(n) === label) || null;
    const modalWith = (title) => [...document.querySelectorAll('.n-modal-container')].find((m) => textOf(m).includes(title)) || null;
    const buttonIn = (root, label) => [...root.querySelectorAll('button')].find((b) => textOf(b) === label) || null;

    // Naive UI listens to the input event, so a plain `.value =` would not reach its state.
    function setInputValue(input, value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // One address at a time: click, wait until the portal shows that very address as done, then the next.
    // It is slower than sending everything at once but every step is checked and visible in the progress bar.
    // `progress(text, done, total)` feeds the status line and the bar. Failures get one more pass at the end.
    const PAUSE_BETWEEN = 800;

    async function attachAll(ips, progress) {
      let pending = ips.filter(isFree);
      const total = pending.length;
      let done = 0;
      for (let round = 0; round < 2 && pending.length; round++) {
        for (const ip of pending) {
          progress(`Attach ${done + 1}/${total}: ${ip}`, done, total);
          const card = fipCard(ip);
          const button = card && fipAttachButton(card);
          if (!button) continue;
          button.click();
          // Once attached, the portal's list for this server often stops returning the address, so a card that
          // disappears counts as done just like one that switches to "attached".
          if (await waitFor(() => !isFree(ip), 30000)) done++;
          await sleep(PAUSE_BETWEEN);
        }
        pending = pending.filter(isFree);
      }
      progress(`Attach ${done}/${total}`, done, total);
      return { done, total, failed: pending };
    }

    // The portal sometimes leaves a closed card's menu in the DOM, so an option is only taken from a menu
    // that did not exist before this click.
    async function openActionMenu(ip, label) {
      const card = fipCard(ip);
      if (!card) return null;
      const before = new Set(document.querySelectorAll('.n-dropdown-menu'));
      card.querySelector('[data-context="floating-ip_actions"]').click();
      const menu = await waitFor(() => [...document.querySelectorAll('.n-dropdown-menu')].find((m) => !before.has(m)), 3000);
      return menu ? menuOption(menu, label) : null;
    }

    // Same approach as attach: one at a time, each result checked before moving on.
    async function detachAll(ips, progress) {
      let pending = ips.filter(isAttached);
      const total = pending.length;
      let done = 0;
      for (let round = 0; round < 2 && pending.length; round++) {
        for (const ip of pending) {
          progress(`Detach ${done + 1}/${total}: ${ip}`, done, total);
          const option = await openActionMenu(ip, 'Detach');
          if (!option) continue;
          option.click();
          if (await waitFor(() => isFree(ip), 30000)) done++;
          await sleep(PAUSE_BETWEEN);
        }
        pending = pending.filter(isAttached);
      }
      progress(`Detach ${done}/${total}`, done, total);
      return { done, total, failed: pending };
    }

    async function terminateOne(ip) {
      if (!isFree(ip)) return false; // never touch an address that is still attached
      const option = await openActionMenu(ip, 'Terminate');
      if (!option) return false;
      option.click();
      const modal = await waitFor(() => modalWith('IP address termination'), 5000);
      if (!modal) return false;
      const discard = () => {
        const button = buttonIn(modal, 'Discard');
        if (button) button.click();
        return false;
      };
      if (!textOf(modal).includes(ip)) return discard(); // the dialog must be about this very address
      const phrase = [...modal.querySelectorAll('code')].map(textOf).find((t) => /^[\w.-]+\/[\w.-]+$/.test(t));
      const input = modal.querySelector('input');
      if (!phrase || !input) return discard();
      setInputValue(input, phrase);
      await sleep(200);
      const confirm = buttonIn(modal, 'Terminate');
      if (!confirm || confirm.disabled) return discard();
      confirm.click();
      return !!(await waitFor(() => !modalWith('IP address termination'), 15000));
    }

    async function terminateAll(ips, progress) {
      const failed = [];
      let n = 0;
      for (const ip of ips) {
        progress(`Terminate ${++n}/${ips.length}: ${ip}`, n - 1, ips.length);
        if (!(await terminateOne(ip))) failed.push(ip);
        await sleep(PAUSE_BETWEEN);
      }
      progress(`Terminate ${n - failed.length}/${ips.length}`, n - failed.length, ips.length);
      return { done: ips.length - failed.length, total: ips.length, failed };
    }

    const HOURLY = /^([\d.,]+)\s*([A-Z]{3})\s*\/\s*hr$/i;
    const HOURS_PER_MONTH = 720;

    // The dialog loads its region and price a moment after it opens ("Select region" first).
    const priceLeaf = (root) => [...root.querySelectorAll('div, span')].find((n) => !n.children.length && HOURLY.test(textOf(n))) || null;

    function offerIn(modal) {
      const leaf = priceLeaf(modal);
      if (!leaf) return null;
      const match = HOURLY.exec(textOf(leaf));
      const first = leaf.parentElement && leaf.parentElement.firstElementChild;
      // the region is several elements ("Stockholm, SE" and "SE-Stockholm"); textContent would glue them together
      const parts = first && first !== leaf ? [...first.querySelectorAll('*')].filter((n) => !n.children.length).map(textOf).filter(Boolean) : [];
      return {
        price: parseFloat(match[1].replace(',', '.')),
        currency: match[2].toUpperCase(),
        region: parts.join(' '),
      };
    }

    // Opens the order dialog only to read what it offers, then closes it.
    async function readOrderOffer() {
      document.querySelector(FIP_ORDER).click();
      const modal = await waitFor(() => modalWith('Floating IP Order'), 5000);
      if (!modal) return null;
      const offer = await waitFor(() => offerIn(modal), 8000);
      const discard = buttonIn(modal, 'Discard');
      if (discard) discard.click();
      await waitFor(() => !modalWith('Floating IP Order'), 5000);
      return offer;
    }

    // Hourly prices are everywhere in the portal; show the monthly figure next to them.
    function scanPrices() {
      for (const node of document.querySelectorAll('div, span')) {
        if (node.children.length || node.dataset.hlMonth || node.textContent.length > 30) continue;
        const match = HOURLY.exec(textOf(node));
        if (!match) continue;
        node.dataset.hlMonth = '1';
        const monthly = parseFloat(match[1].replace(',', '.')) * HOURS_PER_MONTH;
        node.after(el('span', 'hl-month', `≈ ${monthly.toFixed(2)} ${match[2].toUpperCase()}/мес`));
      }
    }

    async function orderMany(count, progress) {
      let done = 0;
      for (let i = 1; i <= count; i++) {
        progress(`Заказ ${i}/${count}`, done, count);
        document.querySelector(FIP_ORDER).click();
        const modal = await waitFor(() => modalWith('Floating IP Order'), 5000);
        if (!modal || !(await waitFor(() => offerIn(modal), 8000))) break; // wait until the region and price have loaded
        const order = buttonIn(modal, 'Order');
        if (!order || order.disabled) break;
        order.click();
        if (!(await waitFor(() => !modalWith('Floating IP Order'), 15000))) break; // the dialog stayed: an error, stop
        done++;
        await sleep(400);
      }
      return { done, total: count, failed: count - done };
    }

    const fip = { selected: new Set(), busy: false, status: '', progress: null, confirm: null, ui: null };

    function fipLines(ips, options) {
      return formatNetplan({ hosts: ips, prefix: 32 }, options);
    }

    async function copyLines(ips, variant) {
      if (!ips.length) {
        showToast('Нет адресов для копирования');
        return;
      }
      try {
        await copyText(fipLines(ips, variant.options));
        showToast(`Скопировано ${ips.length} IP (${variant.label})`);
      } catch (err) {
        showToast('Не удалось скопировать');
      }
    }

    async function runBatch(title, job) {
      if (fip.busy) return;
      fip.busy = true;
      fip.confirm = null;
      const progress = (text, done, total) => {
        fip.status = text;
        fip.progress = total ? { done, total } : null;
        refreshFipBar();
      };
      refreshFipBar();
      try {
        const result = await job(progress);
        const failed = result.failed && result.failed.length ? `, не удалось: ${Array.isArray(result.failed) ? result.failed.join(', ') : result.failed}` : '';
        const of = result.total != null ? ` из ${result.total}` : '';
        fip.status = `${title}: готово ${result.done}${of}${failed}`;
        showToast(fip.status);
      } catch (err) {
        console.error('[hostlens]', err);
        fip.status = `${title}: ошибка, ${err && err.message ? err.message : err}`;
        showToast(fip.status);
      } finally {
        fip.busy = false;
        fip.progress = null;
        refreshFipBar();
      }
    }

    const selectedIps = () => [...fip.selected].filter((ip) => fipCard(ip));

    function askConfirm(text, run) {
      fip.confirm = { text, run };
      refreshFipBar();
    }

    async function startOrder() {
      const input = fip.ui.qty;
      const count = Math.max(1, Math.min(20, parseInt(input.value, 10) || 1));
      input.value = String(count);
      fip.busy = true;
      fip.status = 'Читаю цену в диалоге заказа…';
      refreshFipBar();
      let offer = null;
      try {
        offer = await readOrderOffer();
      } finally {
        fip.busy = false;
        fip.status = '';
      }
      if (!offer) {
        fip.status = 'Не удалось прочитать цену в диалоге заказа';
        refreshFipBar();
        return;
      }
      const hourly = offer.price * count;
      askConfirm(
        `Купить ${count} × floating IP${offer.region ? ` (${offer.region})` : ''}: ${offer.price} ${offer.currency}/ч каждый. ` +
        `Итого ≈ ${hourly.toFixed(3)} ${offer.currency}/ч, ≈ ${(hourly * HOURS_PER_MONTH).toFixed(2)} ${offer.currency} в месяц.`,
        () => runBatch('Заказ', (progress) => orderMany(count, progress)),
      );
    }

    const VARIANT_BUTTONS = () => VARIANTS.map((variant) => {
      const button = el('button', 'hl-fip-btn', variant.label);
      button.type = 'button';
      button.title = `Скопировать выбранные IP (или все на странице): ${variant.hint}`;
      button.addEventListener('click', () => copyLines(selectedIps().length ? selectedIps() : fipCards().map(fipAddress), variant));
      return button;
    });

    function buildFipBar() {
      const button = (label, onclick, extra = '') => {
        const node = el('button', 'hl-fip-btn' + extra, label);
        node.type = 'button';
        node.addEventListener('click', onclick);
        return node;
      };
      const all = el('input');
      all.type = 'checkbox';
      all.title = 'Выбрать все на странице';
      all.addEventListener('change', () => {
        fipCards().forEach((card) => (all.checked ? fip.selected.add(fipAddress(card)) : fip.selected.delete(fipAddress(card))));
        syncFipCards();
        refreshFipBar();
      });

      const ui = {
        all,
        count: el('span', 'hl-fip-count'),
        attach: button('Attach', () => runBatch('Attach', (progress) => attachAll(selectedIps(), progress))),
        detach: button('Detach', () => runBatch('Detach', (progress) => detachAll(selectedIps(), progress))),
        terminate: button('Terminate…', () => {
          const ips = selectedIps().filter(isFree);
          askConfirm(
            `Безвозвратно удалить ${ips.length} IP: ${ips.join(', ')}. Биллинг по ним остановится, вернуть адреса нельзя. ` +
            'Фраза подтверждения будет введена автоматически.',
            () => runBatch('Terminate', (progress) => terminateAll(ips, progress)),
          );
        }, ' hl-fip-danger'),
        qty: el('input', 'hl-fip-qty'),
        order: button('Купить…', startOrder),
        status: el('span', 'hl-fip-status'),
        bar: el('div', 'hl-fip-progress'),
        confirm: el('div', 'hl-fip-confirm'),
      };
      ui.qty.type = 'number';
      ui.qty.min = '1';
      ui.qty.max = '20';
      ui.qty.value = '1';
      ui.qty.title = 'Сколько IP заказать';

      const bar = el('div', 'hl-fip');
      const row = el('div', 'hl-fip-row');
      row.append(all, ui.count, ui.attach, ui.detach, ...VARIANT_BUTTONS(), ui.terminate,
        el('span', 'hl-fip-sep'), el('span', 'hl-fip-label', 'Заказать:'), ui.qty, ui.order, ui.status);
      ui.bar.append(el('i'));
      bar.append(row, ui.bar, ui.confirm);
      fip.ui = ui;
      return bar;
    }

    function refreshFipBar() {
      const ui = fip.ui;
      if (!ui) return;
      const cards = fipCards();
      const ips = selectedIps();
      const free = ips.filter(isFree).length;
      const attached = ips.filter(isAttached).length;
      ui.count.textContent = ips.length ? `Выбрано: ${ips.length}` : 'Ничего не выбрано';
      ui.all.checked = cards.length > 0 && cards.every((card) => fip.selected.has(fipAddress(card)));
      ui.attach.textContent = `Attach (${free})`;
      ui.detach.textContent = `Detach (${attached})`;
      ui.terminate.textContent = `Terminate… (${free})`;
      ui.attach.disabled = fip.busy || !free;
      ui.detach.disabled = fip.busy || !attached;
      ui.terminate.disabled = fip.busy || !free;
      ui.order.disabled = fip.busy;
      ui.qty.disabled = fip.busy;
      ui.status.textContent = fip.status;
      ui.bar.style.display = fip.busy && fip.progress ? '' : 'none';
      if (fip.progress) ui.bar.firstChild.style.width = `${Math.round((100 * fip.progress.done) / fip.progress.total)}%`;

      ui.confirm.replaceChildren();
      ui.confirm.style.display = fip.confirm ? '' : 'none';
      if (fip.confirm) {
        const run = fip.confirm.run;
        const yes = el('button', 'hl-fip-btn hl-fip-danger', 'Подтвердить');
        yes.type = 'button';
        yes.addEventListener('click', run);
        const no = el('button', 'hl-fip-btn', 'Отмена');
        no.type = 'button';
        no.addEventListener('click', () => {
          fip.confirm = null;
          refreshFipBar();
        });
        ui.confirm.append(el('span', null, fip.confirm.text), yes, no);
      }
    }

    // A checkbox and two copy buttons on every card.
    function syncFipCards() {
      for (const card of fipCards()) {
        const ip = fipAddress(card);
        const nameNode = card.querySelector('.text-black.font-semibold');
        const row = nameNode && nameNode.parentElement && nameNode.parentElement.parentElement;
        if (!row) continue;

        let check = card.querySelector('.hl-fip-check');
        if (!check) {
          check = el('input', 'hl-fip-check');
          check.type = 'checkbox';
          check.addEventListener('change', () => {
            const current = fipAddress(card);
            if (check.checked) fip.selected.add(current);
            else fip.selected.delete(current);
            refreshFipBar();
          });
          row.prepend(check);
          for (const variant of VARIANTS) {
            const copy = el('button', 'hl-copy', variant.label);
            copy.type = 'button';
            copy.title = `Скопировать ${ip}: ${variant.hint}`;
            copy.addEventListener('click', () => copyLines([fipAddress(card)], variant));
            row.append(copy);
          }
        }
        check.checked = fip.selected.has(ip);

        // PTR, DNS, DDoS Scrubbing and Tags rarely change; the rows are only marked here and hidden by a class on <html>.
        for (const line of card.querySelectorAll('.divide-y > div')) {
          if (!line.classList.contains('hl-fip-meta') && FIP_META_LABELS.test(textOf(line.firstElementChild))) line.classList.add('hl-fip-meta');
        }
      }
    }

    const FIP_META_LABELS = /^(PTR|DNS|DDoS Scrubbing|Tags)$/i;

    function applyFipMeta() {
      document.documentElement.classList.toggle('hl-hide-fip-meta', store.get('cherryHideFipMeta', true));
    }

    // With everything on one page the pager only gets in the way.
    function applyPagerVisibility() {
      const first = [...document.querySelectorAll('button')].find((b) => textOf(b) === 'First');
      const pager = first && first.closest('.grid.justify-center');
      if (pager) pager.style.display = listing.total !== null && listing.total <= FIP_PAGE_LIMIT ? 'none' : '';
    }

    function scanFloatingIps() {
      const order = document.querySelector(FIP_ORDER);
      const existing = document.querySelector('.hl-fip');
      if (!order) {
        if (existing) existing.remove();
        fip.ui = null;
        return;
      }
      if (!existing || !fip.ui) {
        if (existing) existing.remove();
        order.parentElement.after(buildFipBar());
      }
      for (const ip of [...fip.selected]) if (!fipCard(ip) && !fip.busy) fip.selected.delete(ip); // left this page or was removed
      syncFipCards();
      applyPagerVisibility();
      refreshFipBar();
    }

    // The termination dialog asks to type a phrase that the portal renders unselectable.
    function scanDialogs() {
      for (const code of document.querySelectorAll('.n-modal-container code')) {
        if (code.dataset.hlPhrase || !/^[\w.-]+\/[\w.-]+$/.test(textOf(code))) continue;
        code.dataset.hlPhrase = '1';
        code.title = 'Клик — скопировать';
        code.addEventListener('click', () => copyText(textOf(code)).then(() => showToast('Фраза скопирована'), () => {}));
        const fill = el('button', 'hl-copy', 'вставить');
        fill.type = 'button';
        fill.title = 'Вписать фразу в поле подтверждения';
        fill.addEventListener('click', (e) => {
          e.preventDefault();
          const input = code.closest('.n-modal-container').querySelector('input');
          if (input) setInputValue(input, textOf(code));
        });
        code.after(fill);
      }
    }

    /* ---- a faint casino pattern behind the page ---- */

    const SYMBOLS = `
      <path id="h" d="M0 11C-8 4-11 0-11-3.5-11-7-8.2-9-5.5-9-3-9-1-7.5 0-5.5 1-7.5 3-9 5.5-9 8.2-9 11-7 11-3.5 11 0 8 4 0 11Z"/>
      <path id="d" d="M0-11L9 0 0 11-9 0Z"/>
      <g id="s"><path d="M0-11C-8-4-11 0-11 3.5-11 7-8.2 9-5.5 9-3 9-1 7.5 0 5.5 1 7.5 3 9 5.5 9 8.2 9 11 7 11 3.5 11 0 8-4 0-11Z"/><path d="M0 4L-3.5 12H3.5Z"/></g>
      <g id="c"><circle cy="-5.5" r="5"/><circle cx="-5.5" cy="3" r="5"/><circle cx="5.5" cy="3" r="5"/><path d="M0 3L-3.5 12H3.5Z"/></g>
      <g id="k" fill="none"><circle r="11" stroke-width="3" stroke-dasharray="6 5.6"/><circle r="6" stroke-width="1.5"/></g>
      <g id="x"><rect x="-10" y="-10" width="20" height="20" rx="4" fill="none" stroke-width="2"/><circle cx="-5" cy="-5" r="1.8"/><circle cx="5" cy="-5" r="1.8"/><circle r="1.8"/><circle cx="-5" cy="5" r="1.8"/><circle cx="5" cy="5" r="1.8"/></g>
      <text id="n" font-family="Georgia,serif" font-weight="700" font-size="26" text-anchor="middle" dominant-baseline="central">7</text>
      <text id="f" font-family="Georgia,serif" font-weight="700" font-size="26" text-anchor="middle" dominant-baseline="central">4</text>`;

    // [symbol, x, y, rotation, scale, color]; outlined symbols need a stroke as well as a fill.
    const RED = '#e11d48';
    const INK = '#111827';
    const SCATTER = [
      ['h', 40, 42, -15, 1.4, RED], ['s', 122, 46, 10, 1.3, INK], ['x', 196, 34, 18, 1.1, INK],
      ['d', 28, 124, 8, 1.2, RED], ['k', 100, 124, 0, 1.3, RED], ['n', 176, 128, 9, 1.1, INK],
      ['c', 44, 206, -8, 1.3, INK], ['f', 120, 208, -12, 1, RED], ['h', 196, 204, 14, 1.2, INK],
      ['n', 84, 172, 6, 0.9, RED],
    ];

    function casinoBackground() {
      const outlined = new Set(['k', 'x']);
      const uses = SCATTER.map(([id, x, y, rotation, scale, color]) =>
        `<use href="#${id}" transform="translate(${x} ${y}) rotate(${rotation}) scale(${scale})" fill="${color}"` +
        `${outlined.has(id) ? ` stroke="${color}"` : ''}/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">` +
        `<defs>${SYMBOLS}</defs><g opacity=".055">${uses}</g></svg>`;
      return `body { background-image: url("data:image/svg+xml,${encodeURIComponent(svg)}") !important; background-size: 240px 240px !important; }`;
    }

    function applyBackground() {
      let style = document.getElementById('hl-bg');
      if (!store.get('cherryBackground', true)) {
        if (style) style.remove();
        return;
      }
      if (!style) {
        style = h('style', { id: 'hl-bg' });
        document.head.append(style);
      }
      style.textContent = casinoBackground();
    }

    injectStyles();
    applyBackground();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Фон Cherry: показать/скрыть', () => {
        store.set('cherryBackground', !store.get('cherryBackground', true));
        applyBackground();
      });
      GM_registerMenuCommand('Floating IP: показать/скрыть PTR, DNS, DDoS, Tags', () => {
        store.set('cherryHideFipMeta', !store.get('cherryHideFipMeta', true));
        applyFipMeta();
      });
    }
    applyFipMeta();
    watchPage(scan, 200);
  }

  /* ------------------------------------------------------------------ */

  const start = () => {
    if (location.hostname === 'avoro.eu') runAvoro();
    else if (location.hostname === 'portal.cherryservers.com') runCherry();
    else runBillmanager();
  };

  // document-start lets the Cherry listing patch be in place before the portal's first request;
  // everything else needs the page's DOM.
  if (location.hostname === 'portal.cherryservers.com') patchFloatingListing();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
